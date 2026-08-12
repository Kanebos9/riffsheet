#include "WebResources.h"
#include "PcmStore.h"
#include <BinaryData.h>

namespace
{
    std::vector<std::byte> streamToVector (juce::InputStream& stream)
    {
        std::vector<std::byte> result ((size_t) stream.getTotalLength());
        stream.setPosition (0);
        [[maybe_unused]] const auto read = stream.read (result.data(), (int) result.size());
        jassert (read == (ssize_t) result.size());
        return result;
    }

    std::vector<std::byte> stringToVector (const juce::String& s)
    {
        const auto utf8 = s.toRawUTF8();
        const auto len = std::strlen (utf8);
        std::vector<std::byte> result (len);
        std::memcpy (result.data(), utf8, len);
        return result;
    }

    /** Normalises an incoming request into a clean relative path.
        Strips the query/fragment, leading slashes and "./", and rejects any
        attempt to climb out of the bundle. */
    juce::String normalisePath (const juce::String& url)
    {
        auto path = url.upToFirstOccurrenceOf ("?", false, false)
                       .upToFirstOccurrenceOf ("#", false, false);

        path = juce::URL::removeEscapeChars (path);

        while (path.startsWith ("/") || path.startsWith ("./"))
            path = path.startsWith ("/") ? path.substring (1) : path.substring (2);

        if (path.isEmpty())
            path = "index.html";

        if (path.contains (".."))
            return {};

        return path;
    }
}

juce::String WebResources::mimeForPath (const juce::String& path)
{
    static const std::map<juce::String, juce::String> mimeMap
    {
        { "html", "text/html"                },
        { "htm",  "text/html"                },
        { "js",   "text/javascript"          },
        { "mjs",  "text/javascript"          },
        { "css",  "text/css"                 },
        { "json", "application/json"         },
        { "map",  "application/json"         },
        { "svg",  "image/svg+xml"            },
        { "png",  "image/png"                },
        { "jpg",  "image/jpeg"               },
        { "jpeg", "image/jpeg"               },
        { "gif",  "image/gif"                },
        { "webp", "image/webp"               },
        { "ico",  "image/vnd.microsoft.icon" },
        { "woff", "font/woff"                },
        { "woff2","font/woff2"               },
        { "ttf",  "font/ttf"                 },
        { "otf",  "font/otf"                 },
        { "wasm", "application/wasm"         },
        { "wav",  "audio/wav"                },
        { "mp3",  "audio/mpeg"               },
        { "ogg",  "audio/ogg"                },
        { "mid",  "audio/midi"               },
        { "midi", "audio/midi"               },
        { "txt",  "text/plain"               },
        { "xml",  "application/xml"          },
        { "musicxml", "application/vnd.recordare.musicxml+xml" },
        { "mxl",  "application/vnd.recordare.musicxml"         },
        { "f32",  "application/octet-stream" },
    };

    const auto ext = path.fromLastOccurrenceOf (".", false, false).toLowerCase();
    const auto it = mimeMap.find (ext);
    return it != mimeMap.end() ? it->second : juce::String ("application/octet-stream");
}

WebResources::WebResources (PcmStore& pcmStore)
    : pcm (pcmStore)
{
    // Dev override: serve straight off disk so Team B can hot-reload.
    if (const auto envDir = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_WEBCORE_DIR", {});
        envDir.isNotEmpty())
    {
        const juce::File candidate (envDir);

        if (candidate.isDirectory())
        {
            devDir = candidate;
            DBG ("Riffsheet: serving webcore from disk: " << devDir.getFullPathName());
        }
        else
        {
            juce::Logger::writeToLog ("Riffsheet: RIFFSHEET_WEBCORE_DIR is not a directory: " + envDir);
        }
    }

    auto stream = std::make_unique<juce::MemoryInputStream> (BinaryData::webcore_zip,
                                                             (size_t) BinaryData::webcore_zipSize,
                                                             false);
    zip = std::make_unique<juce::ZipFile> (std::move (stream));
}

std::optional<juce::WebBrowserComponent::Resource> WebResources::lookup (const juce::String& url)
{
    const auto path = normalisePath (url);

    if (path.isEmpty())
        return std::nullopt;

    // ---- native data routes -------------------------------------------------
    if (path.startsWith ("native/pcm/"))
    {
        const auto token = path.fromFirstOccurrenceOf ("native/pcm/", false, false)
                               .upToLastOccurrenceOf (".f32", false, false);

        if (auto bytes = pcm.getRawFloatBytes (token))
            return juce::WebBrowserComponent::Resource { std::move (*bytes),
                                                         juce::String ("application/octet-stream") };

        return std::nullopt;
    }

    // The ORIGINAL recording's own bytes - the file the user opened, not the
    // downmixed, resampled analysis buffer the route above serves. The page
    // fetches this only when it is actually writing a document, which is why it
    // is a resource route and not part of the AudioRef reply: a hundred-megabyte
    // take that nobody saves is never read at all, and nothing on this path is
    // ever base64'd. See PcmStore::getOriginalFileBytes().
    if (path.startsWith ("native/source/"))
    {
        const auto token = path.fromFirstOccurrenceOf ("native/source/", false, false)
                               .upToLastOccurrenceOf (".bin", false, false);

        if (auto bytes = pcm.getOriginalFileBytes (token))
            return juce::WebBrowserComponent::Resource { std::move (*bytes),
                                                         juce::String ("application/octet-stream") };

        return std::nullopt;
    }

    // ---- the bundle ---------------------------------------------------------
    if (devDir.isDirectory())
        if (auto fromDevDir = fromDisk (path))
            return fromDevDir;

    if (auto packed = fromZip (path))
        return packed;

    // A single-page app asks for routes that are not files. Anything without a
    // file extension falls back to index.html so client-side routing works.
    if (! path.fromLastOccurrenceOf ("/", false, false).contains ("."))
    {
        if (devDir.isDirectory())
            if (auto indexFromDisk = fromDisk ("index.html"))
                return indexFromDisk;

        if (auto indexPacked = fromZip ("index.html"))
            return indexPacked;
    }

    return notFoundPage (path);
}

std::optional<juce::WebBrowserComponent::Resource> WebResources::fromDisk (const juce::String& path)
{
    const auto file = devDir.getChildFile (path);

    // Belt and braces on top of the ".." check: the resolved file must still be
    // inside the served directory.
    if (! file.isAChildOf (devDir) || ! file.existsAsFile())
        return std::nullopt;

    juce::FileInputStream stream (file);

    if (! stream.openedOk())
        return std::nullopt;

    return juce::WebBrowserComponent::Resource { streamToVector (stream), mimeForPath (path) };
}

std::optional<juce::WebBrowserComponent::Resource> WebResources::fromZip (const juce::String& path)
{
    const juce::ScopedLock sl (zipLock);

    if (zip == nullptr)
        return std::nullopt;

    // cmake -E tar may write entries as "index.html" or "./index.html".
    const juce::ZipFile::ZipEntry* entry = zip->getEntry (path, false);

    if (entry == nullptr)
        entry = zip->getEntry ("./" + path, false);

    if (entry == nullptr)
        return std::nullopt;

    std::unique_ptr<juce::InputStream> stream (zip->createStreamForEntry (*entry));

    if (stream == nullptr)
        return std::nullopt;

    return juce::WebBrowserComponent::Resource { streamToVector (*stream), mimeForPath (path) };
}

std::optional<juce::WebBrowserComponent::Resource> WebResources::notFoundPage (const juce::String& path)
{
    // Only dress up navigations; a missing script should be a plain 404-ish miss
    // so the console shows the real error.
    if (! path.endsWithIgnoreCase (".html") && path != "index.html")
        return std::nullopt;

    const auto html = juce::String (R"(<!doctype html><meta charset="utf-8">
<title>Riffsheet</title>
<body style="font:14px -apple-system,system-ui,sans-serif;background:#14161a;color:#e6e6e6;padding:32px">
<h2 style="font-weight:600">Riffsheet shell is running</h2>
<p>The webcore bundle has no <code>PATH</code>.</p>
<p style="color:#8a8f98">Build the web app into <code>webcore/dist</code> and rebuild, or set
<code>RIFFSHEET_WEBCORE_DIR</code> to a directory containing <code>index.html</code>.</p>
</body>)").replace ("PATH", path.replace ("<", "&lt;"));

    return juce::WebBrowserComponent::Resource { stringToVector (html), juce::String ("text/html") };
}
