#pragma once
#include <JuceHeader.h>
#include <functional>
#include <vector>
#include "EngineManifest.h"

/**
    One-click installs: verified downloads, a virtual environment, and nothing
    that has to be trusted.

    THE RULE THIS FILE EXISTS TO ENFORCE. Riffsheet fetches bytes over the
    network and then runs them. Every one of those bytes is pinned by sha256 in
    the compiled-in table, comes from a host on a compiled-in allowlist over
    https, and is checked again after every redirect - because a redirect to
    somewhere else is exactly how a pinned URL stops being a pinned URL. There is
    no trust-on-first-use, no user override, and no way to reach any of it from
    the bridge with a relaxed policy: HostPolicy::shipped() is what install()
    uses and it is not a parameter of the bridge API.

    WHAT IS PINNED AND WHAT IS NOT. Files fetched over https are pinned by
    sha256. Python packages are pinned by version AND by hash in a committed
    requirements file (Resources/engines/<id>-requirements-<platform>.txt), which
    pip verifies with --require-hashes; a bare `pip install transkun` would be an
    unverified network install sitting next to all of this, so it is not what
    happens. A platform with no committed lock file cannot one-click install at
    all, and says so with the guide steps instead of guessing.

    THREADING. Everything here blocks - downloads, pip, a real inference for the
    probe. Worker threads only, never the message thread, never the audio thread.
*/

namespace EngineInstall
{
    //== progress ==============================================================

    /** The stages the bridge reports, in the order they happen. `checking` looks
        for Python and free space; `probing` is a real run against a generated
        one-second clip, because "the files are on disk" is not the same claim as
        "this engine works on this machine". */
    enum class Stage { checking, downloading, verifying, extracting, installing, probing };

    /** The wire spelling: 'checking' | 'downloading' | ... Used by the bridge
        event and by the tests, so there is one spelling of each. */
    const char* stageName (Stage stage) noexcept;

    struct Progress
    {
        Stage stage = Stage::checking;
        juce::String message;          // a sentence for a human; may be empty while downloading
        juce::int64 receivedBytes = 0;
        juce::int64 totalBytes = 0;    // 0 when the server would not say
        double fraction = 0.0;         // 0..1, 0 when totalBytes is 0
        double bytesPerSec = 0.0;
        double etaSec = -1.0;          // negative = unknown
    };

    //== where bytes may come from =============================================

    /**  An allowlist of hosts, checked on the first URL and after every redirect.

         An entry is either an exact host ("pypi.org") or a suffix beginning with
         a dot (".hf.co"), which matches any host ending in it. The suffix form
         exists because Hugging Face resolves a file URL to a regional CDN whose
         hostname is not knowable in advance (us.aws.cdn.hf.co today); pinning
         one region would break the install for everybody else. The security
         property being defended is not "which machine served the bytes" - the
         sha256 is what decides that - it is "a redirect cannot walk the
         downloader to an arbitrary host", and a suffix owned by the same
         organisation keeps that property.

         `requireHttps` is separate from the list because a test needs a loopback
         server without also needing a certificate, and the ONE place that
         relaxation is allowed to exist is a test that passes its own policy. */
    struct HostPolicy
    {
        bool requireHttps = true;
        juce::StringArray hosts;

        /** The compiled-in policy. The only one install() ever uses. */
        static HostPolicy shipped();

        bool allowsHost (const juce::String& host) const;

        /** Checks scheme and host together, and says which rule refused. */
        bool allows (const juce::String& url, juce::String& error) const;
    };

    //== the plan ==============================================================

    /** One file to fetch, verify and put somewhere. */
    struct Asset
    {
        juce::String url;
        juce::String sha256;
        juce::int64 bytes = 0;
        ArchiveKind archive = ArchiveKind::singleFile;

        /** Relative to the engine directory. For singleFile it is the file's
            path ("checkpoints/best_model.pth"); for zip it is the directory the
            archive is unpacked into ("repo"). */
        juce::String destination;
    };

    /**  Everything an engine needs, in one value.

         WHY THIS IS NOT IN EngineManifest. A manifest row carries ONE
         EngineDownload, and the AMT engine needs three files - its source
         archive and two checkpoints - plus a pip lock file. Widening the
         manifest struct would push installer detail into the table every other
         part of the shell reads. The row still carries the primary asset, so the
         compile-time licensing/pinning audit in EngineCatalog.cpp still guards
         it; the rest of the plan is audited by planIsSane() in EngineInstaller.cpp
         with the same predicate applied to every asset. */
    struct Plan
    {
        juce::String engineId;
        std::vector<Asset> assets;

        /** BinaryData symbol of the committed pip lock, "" when the engine needs
            no Python packages. */
        juce::String requirementsResource;
        juce::String requirementsName;      // the filename it is written as

        /** BinaryData symbol of the sidecar script, "" for a console-script
            engine like Transkun. */
        juce::String scriptResource;
        juce::String scriptName;            // "run.py"

        juce::String pythonRequirement;     // ">=3.10,<3.13"
        juce::int64 approxDiskBytes = 0;    // the installed size, measured

        /** The console script the venv must end up with, "" when there is none.
            Checked after pip and used as {bin} by the adapter. */
        juce::String consoleScript;

        juce::int64 totalDownloadBytes() const noexcept;
        bool needsPython() const noexcept { return requirementsResource.isNotEmpty(); }
    };

    /** The plan for a manifest row, or an empty plan (`assets` empty and no
        requirements) when this build has none - which is the honest answer for a
        platform with no committed pip lock. */
    Plan planFor (const EngineManifest& engine, juce::String& error);
}

//==============================================================================
class EngineInstaller
{
public:
    struct Callbacks
    {
        std::function<void (const EngineInstall::Progress&)> onProgress;
        std::function<bool()> shouldCancel;

        /** A real inference runs at the end of an install and holds a gigabyte
            or two. On an 8 GB machine that must not happen underneath somebody
            else's transcription, so the probe takes the machine-wide turn like
            any other job. The bridge passes EngineLock's acquire/release here;
            the tests pass nothing and the probe simply runs. */
        std::function<bool()> acquireMachineTurn;
        std::function<void()> releaseMachineTurn;
    };

    struct Result
    {
        bool ok = false;
        bool cancelled = false;
        juce::String error;
        juce::int64 bytesOnDisk = 0;    // installed size, or freed size for uninstall()
        juce::String location;          // the venv / interpreter this engine now runs from
        juce::StringArray guideSteps;   // set when the failure has a manual way out
        double elapsedMs = 0.0;
    };

    //== layout ================================================================
    // <appSupport>/engines/<id>/            the installed engine
    // <appSupport>/engines/<id>.incoming/   a half-built one; never resolvable
    // <appSupport>/engines/.downloads/<id>/ partials, which survive a reboot

    static juce::File enginesRoot();
    static juce::File engineDirectory (const juce::String& id);
    static juce::File incomingDirectory (const juce::String& id);
    static juce::File downloadsDirectory (const juce::String& id);

    /** Bytes under a directory, following nothing. 0 when it does not exist. */
    static juce::int64 bytesOnDisk (const juce::File& directory);

    //== python ================================================================

    struct PythonFind
    {
        juce::File interpreter;         // invalid when nothing suitable was found
        juce::String version;           // "3.10.11"
        juce::StringArray searched;     // every path tried, in order
        juce::String error;             // one sentence, set when interpreter is invalid
    };

    /**  Finds a python3 that satisfies `requirement` (">=3.10,<3.13").

         Riffsheet never installs Python. It looks in the places a Python ends up
         on this platform, reports what it found and what it refused and why, and
         if none fits it says so with the version numbers in the sentence - the
         same discipline as MuScriptor's venv search, which exists because "not
         found" without a list of where you looked is not a bug report. */
    static PythonFind findPython (const juce::String& requirement);

    //== the download primitive ================================================

    /**  Fetches one URL to one file, resuming a previous attempt when it can.

         Refuses: a non-https url (unless the policy says otherwise), a host off
         the policy's list before OR after any redirect, more than five redirects,
         a Content-Length that disagrees with `expectedBytes`, a finished file
         whose size or sha256 is not the pinned one. On any refusal the partial
         file is left only when it is still a valid prefix to resume from;
         a digest mismatch deletes it, because a wrong file is not a prefix.

         `destination` is the final file. The partial lives beside it as
         `<name>.part` with `<name>.meta.json` recording what it is a prefix OF -
         url, expected size and expected digest - so a partial from a different
         asset is discarded rather than appended to.

         NOTE ON HASHING. juce::SHA256 has no incremental update in JUCE 8, so
         the digest is taken over the finished file in one pass rather than over
         the socket reads. That is also what makes resume verifiable at all: a
         resumed file's digest must cover bytes this process never saw. */
    static bool fetch (const juce::String& url,
                       const juce::File& destination,
                       juce::int64 expectedBytes,
                       const juce::String& expectedSha256,
                       const EngineInstall::HostPolicy& policy,
                       std::function<void (const EngineInstall::Progress&)> onProgress,
                       std::function<bool()> shouldCancel,
                       juce::String& error);

    /** Lowercase hex, or "" when the file cannot be read. */
    static juce::String sha256Of (const juce::File& file);

    /** Free space against 3x the bytes about to be moved: the download itself,
        the unpacked copy, and slack for pip's own cache. Returns "" when there
        is room and a sentence with both numbers in it when there is not. */
    static juce::String checkDiskSpace (const juce::File& volumeAnchor, juce::int64 needBytes);

    /** 3 x whatever this plan will move, which is the download plus the
        installed tree - the two live at the same time during the commit. */
    static juce::int64 requiredFreeBytes (const EngineInstall::Plan& plan) noexcept;

    //== the whole thing =======================================================

    /**  Downloads, verifies, unpacks, builds the venv, moves it into place, and
         only then runs it for real.

         The order of those last two matters and was got wrong once. pip writes
         the venv's own absolute path into every console script it generates, so
         probing in the staging directory tests a path nothing will ever use -
         it passed, and the installed engine then did not run. The previous
         install is therefore stepped aside rather than deleted, the new tree is
         moved into its real home, its scripts are retargeted, and the probe runs
         from there; a failure rolls the old one back.

         Either way a crash leaves the previous install or nothing - never a
         half-built engine that status() would call installed. */
    static Result install (const EngineManifest& engine, Callbacks callbacks);

    /** Deletes what install() created and reports what that was worth. Refuses
        for bundled and guided engines: Riffsheet did not put those there and
        does not get to remove them. */
    static Result uninstall (const EngineManifest& engine);

    /** Writes a one-second 110 Hz tone at 44.1 kHz. The probe needs real audio
        and generating it costs nothing, where bundling a clip would put bytes in
        three products for one use. */
    static bool writeProbeClip (const juce::File& destination);

    /**  Rewrites the venv's own absolute path inside the scripts pip generated.

         pip bakes the interpreter's full path into every console script it
         installs - as a `#!` line, or, when that path is too long or contains a
         space (both true of `~/Library/Application Support/...`), as a two-line
         `/bin/sh` shim that `exec`s it. A virtual environment built in one
         directory and then moved is therefore broken until those lines are
         rewritten, and the failure is a `No such file or directory` naming a
         directory that no longer exists.

         It is public and it has a unit test because it was wrong once: the
         install probe caught it, and a probe is not a substitute for a test.

         `from` and `to` are absolute directory paths this process chose itself
         moments ago, which is what makes a textual replace safe. Symbolic links
         are skipped - `venv/bin/python` points at the SYSTEM interpreter, which
         has not moved. Returns the number of files it rewrote, or -1 with
         `error` set. */
    static int retargetVenvScripts (const juce::File& venv,
                                    const juce::String& from,
                                    const juce::String& to,
                                    juce::String& error);
};
