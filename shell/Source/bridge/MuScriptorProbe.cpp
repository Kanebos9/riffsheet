#include "MuScriptorProbe.h"

#include <map>

namespace MuScriptorProbe
{
namespace
{
    /*  MuScriptor's own instrument-group contract, as documented in BRIDGE.md
        ("Valid `instruments` values (35)") and enforced by the server itself -
        a name that is not in this list is a 400 from /transcribe.

        Only a handful of them are needed to recognise the list, and these are the
        ones picked because they are compound, unusual, and not words a random
        localhost service would list: nothing else on this machine is going to
        answer a GET with "distorted_electric_guitar" by coincidence. */
    const char* const kSignatureGroups[] = {
        "electric_bass",
        "acoustic_bass",
        "clean_electric_guitar",
        "distorted_electric_guitar",
        "chromatic_percussion",
        "soprano_and_alto_sax",
        "string_ensemble",
        "orchestra_hit",
        "french_horn",
        "english_horn",
        "synth_strings",
        "synth_lead",
        "synth_pad",
        "acoustic_piano",
        "electric_piano",
    };

    /** Three names, not one. One would let a page listing "voice" or "organ"
        pass; three of these together is the server's own list and nothing else. */
    constexpr int kNamesNeeded = 3;

    juce::var getJson (const juce::String& host, int port, const juce::String& path, int timeoutMs)
    {
        const juce::URL url ("http://" + host + ":" + juce::String (port) + path);

        int statusCode = 0;
        auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                           .withConnectionTimeoutMs (timeoutMs)
                           .withStatusCode (&statusCode);

        std::unique_ptr<juce::InputStream> stream (url.createInputStream (options));

        if (stream == nullptr || statusCode >= 400)
            return {};

        // Bounded on purpose. This talks to a process we have not identified yet,
        // so it reads a health payload's worth and no more - whatever is on that
        // port is not going to be handed an unbounded read of this process's
        // memory by being verbose.
        const auto body = stream->readEntireStreamAsString().substring (0, 64 * 1024);
        return juce::JSON::parse (body);
    }

    juce::StringArray instrumentsFrom (const juce::var& payload)
    {
        juce::StringArray result;

        if (auto* object = payload.getDynamicObject())
            if (const auto* array = object->getProperty ("instruments").getArray())
                for (const auto& item : *array)
                    result.add (item.toString());

        return result;
    }

    struct CacheEntry
    {
        double stampMs = 0.0;
        bool identified = false;
    };

    juce::CriticalSection& cacheLock()
    {
        static juce::CriticalSection lock;
        return lock;
    }

    std::map<juce::String, CacheEntry>& cache()
    {
        static std::map<juce::String, CacheEntry> entries;
        return entries;
    }
}

//==============================================================================
bool instrumentsLookLikeMuScriptor (const juce::StringArray& instruments)
{
    if (instruments.isEmpty())
        return false;

    int found = 0;

    for (const auto* name : kSignatureGroups)
        if (instruments.contains (name, true) && ++found >= kNamesNeeded)
            return true;

    return false;
}

Answer handshake (const juce::String& host, int port, int timeoutMs)
{
    Answer answer;

    if (port <= 0 || host.isEmpty())
        return answer;

    const auto health = getJson (host, port, "/health", timeoutMs);

    if (auto* object = health.getDynamicObject())
        answer.reachable = object->getProperty ("status").toString() == "ok";

    // No second request when the first one already said no: the port is either
    // empty or holding something that is not a MuScriptor, and either way there
    // is nothing to ask it.
    if (! answer.reachable)
        return answer;

    answer.instruments = instrumentsFrom (getJson (host, port, "/instruments", timeoutMs));
    answer.identified = instrumentsLookLikeMuScriptor (answer.instruments);
    return answer;
}

bool answersLikeMuScriptor (const juce::String& host, int port, int timeoutMs, int ttlMs)
{
    if (port <= 0 || host.isEmpty())
        return false;

    const auto key = host + ":" + juce::String (port);
    const auto now = juce::Time::getMillisecondCounterHiRes();

    {
        const juce::ScopedLock sl (cacheLock());
        const auto entry = cache().find (key);

        if (entry != cache().end() && now - entry->second.stampMs < (double) ttlMs)
            return entry->second.identified;
    }

    // Deliberately OUTSIDE the lock: this is two HTTP requests with a timeout on
    // them, and holding a lock across them would turn a cheap cached read on
    // another thread into a two-second wait.
    const auto identified = handshake (host, port, timeoutMs).identified;

    {
        const juce::ScopedLock sl (cacheLock());
        cache()[key] = { juce::Time::getMillisecondCounterHiRes(), identified };
    }

    return identified;
}

void forgetCachedAnswers()
{
    const juce::ScopedLock sl (cacheLock());
    cache().clear();
}
}
