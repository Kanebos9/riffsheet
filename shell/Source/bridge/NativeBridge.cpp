#include "NativeBridge.h"
#include "ScoreImageImporter.h"
#include "PluginProcessor.h"
#include "EngineLock.h"
#include "ModelCatalog.h"
#include "SystemProbe.h"
#include "engines/EngineCatalog.h"
#include "engines/EngineInstaller.h"    // one-click installs, verified (wave 5)
#include "engines/EnginePreprocess.h"   // A440 + -12 dBFS before the engines that ask (wave 6)
#include "engines/EngineRegistry.h"

#if RIFFSHEET_HAS_ONNX
 #include "engines/beats/BeatTracker.h"   // preciseBeats, no venv required (wave 4)
#endif

namespace
{
    constexpr juce::int64 maxPickedByteFileBytes = 64 * 1024 * 1024;

    /* ==== which audio files this user has actually chosen ====================

       THE THREAT, precisely. `loadAudioPath` hands a path straight to a native
       decoder. One caller in the page is session restore, and the session blob
       it restores from is written into getStateInformation() - so it travels
       inside a .rpp/.als that one person can send another. A path in that blob
       is attacker-controlled text, and opening it silently on load is the bug
       that put a gate here in the first place.

       WHAT THE GATE GOT WRONG. It only trusted an in-memory set of paths picked
       during THIS editor's lifetime. A DAW destroys and rebuilds the editor
       constantly, so the set is empty on essentially every click, and the app's
       own Recent list - a list only Riffsheet writes, only after an import the
       user performed, and which lives in this machine's WebView storage rather
       than in any shareable project file - became unopenable. That is not the
       attack; that is the user.

       WHAT IT IS NOW. Authorization is durable and machine-local: the set of
       files this person has opened in Riffsheet ON THIS MACHINE, kept in
       <appSupport>/opened-files.json, plus anything under the takes folder the
       app owns outright. A hostile path arriving in a shared project was never
       chosen here, so it is still refused - which is exactly the property the
       gate was added for, and the only one it needs to keep. */

    constexpr int maxRememberedAudioPaths = 64;

    juce::File rememberedAudioPathsFile()
    {
        return SystemProbe::appSupportDirectory().getChildFile ("opened-files.json");
    }

    juce::StringArray loadRememberedAudioPaths()
    {
        juce::StringArray paths;
        const auto file = rememberedAudioPathsFile();

        if (! file.existsAsFile())
            return paths;

        // The parsed var MUST be named. getArray() hands back a pointer into the
        // var's ref-counted payload, and a temporary var is destroyed at the end
        // of the condition's full-expression - before the loop body runs - so
        // `if (auto* a = JSON::parse(...).getArray())` reads freed memory. It
        // even looks like it works: the first write here lands, the second one
        // silently loses it. Same pattern as ServerRegistry::readEntries().
        const auto parsed = juce::JSON::parse (file.loadFileAsString());

        if (const auto* array = parsed.getArray())
            for (const auto& item : *array)
            {
                const auto path = item.toString();

                if (path.isNotEmpty() && ! paths.contains (path))
                    paths.add (path);

                if (paths.size() >= maxRememberedAudioPaths)
                    break;
            }

        return paths;
    }

    /** Newest first, capped. Best effort: a store that cannot be written costs
        this user a re-pick after a restart, and is never a reason to fail the
        open that is happening right now. */
    void rememberAudioPathOnDisk (const juce::File& file)
    {
        const auto full = file.getFullPathName();
        auto paths = loadRememberedAudioPaths();

        if (paths[0] == full)
            return;

        paths.removeString (full);
        paths.insert (0, full);
        paths.removeRange (maxRememberedAudioPaths, paths.size());

        juce::Array<juce::var> items;

        for (const auto& path : paths)
            items.add (path);

        rememberedAudioPathsFile().replaceWithText (juce::JSON::toString (juce::var (items), true) + "\n");
    }

    juce::var makeObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
    {
        auto* obj = new juce::DynamicObject();

        for (const auto& property : properties)
            obj->setProperty (property.first, property.second);

        return juce::var (obj);
    }

    juce::var argAt (const juce::Array<juce::var>& args, int index)
    {
        return juce::isPositiveAndBelow (index, args.size()) ? args[index] : juce::var();
    }

    juce::String stringArg (const juce::Array<juce::var>& args, int index)
    {
        return argAt (args, index).toString();
    }

    /** Pulls a named property out of an options object passed as arg[index]. */
    juce::var optionProperty (const juce::Array<juce::var>& args, int index, const juce::Identifier& name)
    {
        if (auto* obj = argAt (args, index).getDynamicObject())
            return obj->getProperty (name);

        return {};
    }

    const juce::StringArray& byteInputExtensions()
    {
        static const juce::StringArray extensions {
            ".mid", ".midi", ".musicxml", ".mxl", ".xml",
            ".gp", ".gp3", ".gp4", ".gp5", ".gpx", ".gp7",
            ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff",
            ".bmp", ".omr", ".riffsheet"
        };
        return extensions;
    }

    bool isByteInputFile (const juce::File& file)
    {
        return byteInputExtensions().contains (file.getFileExtension().toLowerCase());
    }

    bool matchesWildcards (const juce::File& file, const juce::String& wildcards)
    {
        juce::StringArray patterns;
        patterns.addTokens (wildcards, ";,", "\"");

        for (const auto& pattern : patterns)
            if (file.getFileName().matchesWildcard (pattern.trim(), true))
                return true;

        return false;
    }

    bool readBoundedByteFile (const juce::File& file, juce::MemoryBlock& bytes,
                              juce::String& error)
    {
        const auto size = file.getSize();

        if (size <= 0)
        {
            error = file.getFileName() + " is empty.";
            return false;
        }

        if (size > maxPickedByteFileBytes)
        {
            error = file.getFileName() + " is larger than the 64 MB import limit.";
            return false;
        }

        juce::FileInputStream stream (file);

        if (! stream.openedOk())
        {
            error = "could not open " + file.getFileName();
            return false;
        }

        try
        {
            bytes.setSize ((size_t) size, false);
        }
        catch (const std::bad_alloc&)
        {
            error = "not enough memory to read " + file.getFileName();
            return false;
        }

        const auto read = stream.read (bytes.getData(), (int) size);

        // Read only the size that passed the bound, then reject a file that was
        // replaced or changed underneath us. loadFileAsData() would otherwise
        // reopen and allocate an unbounded, raceable new length after the check.
        if (read != (int) size || file.getSize() != size)
        {
            bytes.reset();
            error = "could not read " + file.getFileName() + " consistently; try opening it again.";
            return false;
        }

        return true;
    }
}

//==============================================================================
NativeBridge::NativeBridge (RiffsheetAudioProcessor& processor)
    : proc (processor),
      resources (processor.getPcmStore())
{
    // Materialise the weak-reference control block on the message thread. emit()
    // can then safely copy it from workers without racing its first creation.
    juce::ignoreUnused (juce::WeakReference<NativeBridge> (this));
    startTimerHz (20);   // playback position + host tempo push rate
}

NativeBridge::~NativeBridge()
{
    shutdown();
}

void NativeBridge::shutdown()
{
    // This is also the completion/event gate. Raise it before touching the
    // chooser or worker pool, while PluginEditor still owns a live WebView.
    if (shuttingDown->exchange (true, std::memory_order_acq_rel))
        return;

    stopTimer();
    chooserActive = false;
    chooser.reset();

    // Tell every job to stop BEFORE waiting on the pool. A job waiting its turn
    // in the machine-wide queue could otherwise sit there for minutes.

    {
        const juce::ScopedLock sl (jobLock);

        for (auto& entry : jobCancels)
            entry.second->store (true);
    }

    // Same for an install: it can be in the middle of a 57 MB download or a pip
    // resolve that takes minutes, and both poll this flag. Its worker also holds
    // the machine-wide lock during its probe, so it must be told to stop before
    // anything waits on the pool.
    {
        const juce::ScopedLock sl (installLock);

        for (auto& entry : installCancels)
            entry.second->store (true);
    }

    // A timeout is unsafe here: the lambdas capture this bridge, and JUCE will
    // otherwise force-stop the pool thread after member destruction. Every
    // long-running child-process path polls shuttingDown, so wait until RAII
    // cleanup (notably EngineLock::release) has really completed. Drain the
    // long pool first so its process/queue RAII completes before ordinary jobs.
    longWorkers.removeAllJobs (true, -1);
    installWorkers.removeAllJobs (true, -1);
    workers.removeAllJobs (true, -1);

    // No worker can now enqueue another bridge event or invoke a guarded native
    // completion. The WebView is still alive at this point when called from the
    // editor destructor body.
    detachWebView();

    // Staged drag files are ours; nothing else will ever clean them up.
    dragScratchDirectory().deleteRecursively();
}

void NativeBridge::attachWebView (juce::WebBrowserComponent* view)
{
    const juce::ScopedLock sl (webLock);
    web = view;
}

void NativeBridge::detachWebView()
{
    const juce::ScopedLock sl (webLock);
    web = nullptr;
}

void NativeBridge::emit (const juce::Identifier& eventId, const juce::var& payload)
{
    if (shuttingDown->load (std::memory_order_acquire))
        return;

    // Events must be dispatched on the message thread; workers call this too.
    if (! juce::MessageManager::getInstance()->isThisTheMessageThread())
    {
        const juce::WeakReference<NativeBridge> safeThis (this);
        const auto shutdown = shuttingDown;

        juce::MessageManager::callAsync ([safeThis, shutdown, eventId, payload]
        {
            if (shutdown->load (std::memory_order_acquire))
                return;

            if (auto* bridge = safeThis.get())
                bridge->emit (eventId, payload);
        });
        return;
    }

    const juce::ScopedLock sl (webLock);

    if (web != nullptr)
        web->emitEventIfBrowserIsVisible (eventId, payload);
}

juce::var NativeBridge::makeError (const juce::String& message)
{
    return makeObject ({ { "ok", false }, { "error", message } });
}

double NativeBridge::optionalRate (const juce::Array<juce::var>& args, int index)
{
    const auto requested = optionProperty (args, index, "sampleRate");

    // 44.1k keeps the A/B playback of the original sounding right. Transcription
    // is unaffected either way - it uploads the source file, not this buffer -
    // so webcore can ask for 22050 when it just wants a smaller array to draw.
    if (requested.isVoid() || (double) requested <= 0.0)
        return 44100.0;

    return (double) requested;
}

bool NativeBridge::installChooser (std::unique_ptr<juce::FileChooser> next,
                                   Completion& completion)
{
    // Replacing a live JUCE FileChooser cancels its callback, leaving the first
    // JavaScript promise pending forever. Keep the active chooser and settle a
    // duplicate request explicitly instead.
    if (chooserActive)
    {
        completion (makeError ("A file chooser is already open"));
        return false;
    }

    chooser = std::move (next); // any previous chooser has already completed
    chooserActive = true;
    return true;
}

void NativeBridge::authorizeAudioPath (const juce::File& file)
{
    if (! file.existsAsFile())
        return;

    authorizedAudioPaths.insert (file.getFullPathName());
    rememberAudioPathOnDisk (file);
}

bool NativeBridge::isAuthorizedAudioPath (const juce::File& file) const
{
    if (! file.existsAsFile())
        return false;

    if (authorizedAudioPaths.count (file.getFullPathName()) != 0)
        return true;

    // Not picked in this editor - ask the durable record. Re-read rather than
    // trust a cache: the standalone app and every plugin instance keep their own
    // set, and a file opened in one of them is still a file this user opened.
    // One small read, only on a miss, only on a path the page asked for by name.
    for (const auto& remembered : loadRememberedAudioPaths())
        authorizedAudioPaths.insert (remembered);

    if (authorizedAudioPaths.count (file.getFullPathName()) != 0)
        return true;

    const auto takes = SystemProbe::takesDirectory();

    if (! file.isAChildOf (takes))
        return false;

    // A project-state path must not escape the owned directory through a
    // symlink placed below it. User-picked paths are separately authorized.
    for (auto cursor = file; cursor != takes && cursor.isAChildOf (takes);
         cursor = cursor.getParentDirectory())
        if (cursor.isSymbolicLink())
            return false;

    return true;
}

//==============================================================================
juce::WebBrowserComponent::Options NativeBridge::configure (juce::WebBrowserComponent::Options options)
{
    const juce::WeakReference<NativeBridge> safeThis (this);
    const auto shutdown = shuttingDown;

    const auto bind = [safeThis, shutdown]
        (void (NativeBridge::*method) (const juce::Array<juce::var>&, Completion))
    {
        return [safeThis, shutdown, method]
            (const juce::Array<juce::var>& args, Completion completion) mutable
        {
            if (shutdown->load (std::memory_order_acquire))
                return;

            // JUCE's completion closes over the WebView's NativeFunctionsProvider.
            // Drop late answers after shutdown instead of entering that provider.
            Completion guardedCompletion = [shutdown, providerReply = std::move (completion)]
                                           (juce::var result) mutable
            {
                if (! shutdown->load (std::memory_order_acquire))
                    providerReply (std::move (result));
            };

            if (auto* bridge = safeThis.get())
                (bridge->*method) (args, std::move (guardedCompletion));
        };
    };

    return options
        .withNativeIntegrationEnabled()
        .withResourceProvider ([safeThis, shutdown] (const auto& url)
            -> std::optional<juce::WebBrowserComponent::Resource>
        {
            if (shutdown->load (std::memory_order_acquire))
                return {};

            if (auto* bridge = safeThis.get())
                return bridge->resources.lookup (url);

            return {};
        })
        .withNativeFunction ("getShellInfo",      bind (&NativeBridge::fnGetShellInfo))
        .withNativeFunction ("getHostInfo",       bind (&NativeBridge::fnGetHostInfo))
        .withNativeFunction ("pickAudioFile",     bind (&NativeBridge::fnPickAudioFile))
        .withNativeFunction ("pickInputFile",     bind (&NativeBridge::fnPickInputFile))
        .withNativeFunction ("loadAudioPath",     bind (&NativeBridge::fnLoadAudioPath))
        .withNativeFunction ("authorizeRecentPaths", bind (&NativeBridge::fnAuthorizeRecentPaths))
        .withNativeFunction ("transcribe",        bind (&NativeBridge::fnTranscribe))
        // The beat tracker on its own, for the engine that runs in the page and
        // therefore never starts a native transcription to get a grid out of it.
        // Registration is the capability test here too: an older shell answers
        // hasNativeFunction('trackBeats') with false and the page keeps its
        // notes without beats rather than hanging on a call nobody will answer.
        .withNativeFunction ("trackBeats",        bind (&NativeBridge::fnTrackBeats))
        .withNativeFunction ("exportFile",        bind (&NativeBridge::fnExportFile))
        .withNativeFunction ("exportFiles",       bind (&NativeBridge::fnExportFiles))
        .withNativeFunction ("beginMidiDrag",     bind (&NativeBridge::fnBeginMidiDrag))
        .withNativeFunction ("playbackLoad",      bind (&NativeBridge::fnPlaybackLoad))
        .withNativeFunction ("playbackTransport", bind (&NativeBridge::fnPlaybackTransport))
        .withNativeFunction ("playbackSetGain",   bind (&NativeBridge::fnPlaybackSetGain))
        .withNativeFunction ("playbackDiagnostics", bind (&NativeBridge::fnPlaybackDiagnostics))
        .withNativeFunction ("pcmRetain",         bind (&NativeBridge::fnPcmRetain))
        .withNativeFunction ("pcmRelease",        bind (&NativeBridge::fnPcmRelease))
        .withNativeFunction ("pcmDiagnostics",    bind (&NativeBridge::fnPcmDiagnostics))
        .withNativeFunction ("captureStart",      bind (&NativeBridge::fnCaptureStart))
        .withNativeFunction ("captureStop",       bind (&NativeBridge::fnCaptureStop))
        .withNativeFunction ("captureStatus",     bind (&NativeBridge::fnCaptureStatus))
        .withNativeFunction ("importDroppedFile", bind (&NativeBridge::fnImportDroppedFile))
        .withNativeFunction ("omrStatus",         bind (&NativeBridge::fnOmrStatus))
        .withNativeFunction ("recognizeScoreImage", bind (&NativeBridge::fnRecognizeScoreImage))
        .withNativeFunction ("log",               bind (&NativeBridge::fnLog))
        .withNativeFunction ("getPersistedState", bind (&NativeBridge::fnGetPersistedState))
        .withNativeFunction ("setPersistedState", bind (&NativeBridge::fnSetPersistedState))
        .withNativeFunction ("engineStatus",      bind (&NativeBridge::fnEngineStatus))
        .withNativeFunction ("recheckEngine",     bind (&NativeBridge::fnRecheckEngine))
        // Registered here rather than emitted as events for a reason: an older
        // shell answers hasNativeFunction('listEngines') with false, which is
        // how webcore tells "this build has no engine picker" from "the call is
        // taking a while". An unregistered native call hangs forever instead of
        // rejecting, so registration IS the capability test.
        .withNativeFunction ("listEngines",       bind (&NativeBridge::fnListEngines))
        .withNativeFunction ("selectEngine",      bind (&NativeBridge::fnSelectEngine))
        .withNativeFunction ("installEngine",     bind (&NativeBridge::fnInstallEngine))
        .withNativeFunction ("cancelInstall",     bind (&NativeBridge::fnCancelInstall))
        .withNativeFunction ("uninstallEngine",   bind (&NativeBridge::fnUninstallEngine))
        // Same rule again: the "I already have this one" box on a card is drawn
        // only when this call is registered, so a shell without it shows no box
        // instead of a box that hangs.
        .withNativeFunction ("validateExistingEngineInstall",
                                                  bind (&NativeBridge::fnValidateExistingEngineInstall))
        .withNativeFunction ("openEngineSetup",   bind (&NativeBridge::fnOpenEngineSetup))
        .withNativeFunction ("setEngineModel",    bind (&NativeBridge::fnSetEngineModel))
        .withNativeFunction ("stopEngine",        bind (&NativeBridge::fnStopEngine))
        // Registration is the capability test, exactly as it is for
        // listEngines: an older shell answers hasNativeFunction with false, and
        // the page hides the "stop it anyway" button rather than hanging on a
        // call that will never be answered.
        .withNativeFunction ("stopExternalEngine", bind (&NativeBridge::fnStopExternalEngine))
        .withNativeFunction ("transcribeCancel",  bind (&NativeBridge::fnTranscribeCancel))
        .withNativeFunction ("hostTimelineProbe", bind (&NativeBridge::fnHostTimelineProbe));
}

//==============================================================================
void NativeBridge::timerCallback()
{
    // Only push when something actually changed - a 20 Hz firehose of identical
    // payloads would keep the WebView's JS thread busy for nothing.
    const auto playback = makePlaybackVar();
    const auto playbackSignature = juce::JSON::toString (playback, true);

    if (playbackSignature != lastPlaybackSignature)
    {
        lastPlaybackSignature = playbackSignature;
        emit ("playbackPosition", playback);
    }

    const auto captureState = makeCaptureVar();
    const auto captureSignature = juce::JSON::toString (captureState, true);

    if (captureSignature != lastCaptureSignature)
    {
        lastCaptureSignature = captureSignature;
        emit ("captureState", captureState);
    }

    const auto host = makeHostInfoVar();
    const auto hostSignature = juce::JSON::toString (host, true);

    if (hostSignature != lastHostSignature)
    {
        lastHostSignature = hostSignature;
        emit ("hostInfo", host);
    }
}

juce::var NativeBridge::makePlaybackVar() const
{
    const auto status = proc.getPlaybackStatus();

    return makeObject ({ { "loaded",      status.loaded },
                         { "isPlaying",   status.isPlaying },
                         { "positionSec", status.positionSec },
                         { "lengthSec",   status.lengthSec },
                         { "gain",        (double) status.gain },
                         { "token",       status.token } });
}

juce::var NativeBridge::makeHostInfoVar() const
{
    const auto info = proc.getHostInfo();
    const auto wrapper = juce::PluginHostType::getPluginLoadedAs();
    const auto isPlugin = wrapper != juce::AudioProcessor::wrapperType_Standalone
                       && wrapper != juce::AudioProcessor::wrapperType_Undefined;

    return makeObject ({
        { "isPlugin",   isPlugin },
        { "format",     juce::AudioProcessor::getWrapperTypeDescription (wrapper) },
        { "hostName",   juce::PluginHostType().getHostDescription() },
        // Nulls, not zeros, when the host has nothing to say - standalone has no
        // tempo at all and the UI must be able to tell that apart from 0 bpm.
        { "hostBpm",    isPlugin && info.hasTempo ? juce::var (info.bpm) : juce::var() },
        { "hostTimeSigNumerator",   isPlugin && info.hasTimeSig ? juce::var (info.timeSigNumerator)   : juce::var() },
        { "hostTimeSigDenominator", isPlugin && info.hasTimeSig ? juce::var (info.timeSigDenominator) : juce::var() },
        { "isPlaying",   isPlugin && info.isPlaying },
        // These two used to report 0 rather than null when the host had said
        // nothing, which reads as "bar 1, exactly" - a number nobody reported.
        { "ppqPosition", isPlugin && info.hasPpq ? juce::var (info.ppqPosition) : juce::var() },
        { "timeSec",     isPlugin && info.hasTimeInSeconds ? juce::var (info.timeInSeconds) : juce::var() },

        // NEW, and the point of them: a dropped wav can now use the DAW's grid
        // too. Until this existed, "synced to DAW grid" could only ever work for
        // audio captured inside the plugin, because that was the only path that
        // carried a timeline. See BRIDGE.md section 2.
        { "hasHostTimeline", isPlugin && info.hasUsableTimeline() },
        { "ppqPositionOfLastBarStart",
              isPlugin && info.hasPpqOfLastBarStart ? juce::var (info.ppqOfLastBarStart) : juce::var() } });
}

//==============================================================================
void NativeBridge::fnGetShellInfo (const juce::Array<juce::var>&, Completion completion)
{
    const auto devDir = resources.getDevDirectory();

    completion (makeObject ({
        { "ok", true },
        { "version",   RIFFSHEET_VERSION },
        { "juce",      juce::SystemStats::getJUCEVersion() },
        { "platform",  juce::SystemStats::getOperatingSystemName() },
        { "webcoreSource", devDir.isDirectory() ? "disk:" + devDir.getFullPathName() : juce::String ("bundled") },
        // True when the shell was asked for the engine test panel rather than
        // the normal UI (RIFFSHEET_DEBUG=1; also appended to the URL as ?debug=1).
        { "debug", juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_DEBUG", {}).getIntValue() != 0 },
        { "muscriptorBaseUrl", proc.getMuScriptor().getBaseUrl() },
        { "pcmUrlPrefix", "/native/pcm/" } }));
}

void NativeBridge::fnGetHostInfo (const juce::Array<juce::var>&, Completion completion)
{
    completion (makeHostInfoVar());
}

//==============================================================================
juce::var NativeBridge::describeEntry (const std::shared_ptr<const PcmStore::Entry>& entry)
{
    // THE HANDOVER. Everything below this line is a token - a string the page
    // can hold but C++ cannot follow. The PcmStore keeps only a weak reference,
    // so without this one line the take would be destroyed the instant this
    // reply finished and the page's own `playbackLoad(token)` would come back
    // "unknown pcm token".
    //
    // It is here, in the one function every AudioRef goes through, rather than
    // at the four call sites, so a fifth call site cannot forget.
    proc.noteHandedOut (entry);

    return makeObject ({
        { "ok", true },
        { "token",            entry->token },
        { "path",             entry->sourceFile.getFullPathName() },
        { "name",             entry->displayName },
        { "sampleRate",       entry->sampleRate },
        { "numFrames",        entry->mono.getNumSamples() },
        { "durationSec",      entry->durationSec },
        { "sourceSampleRate", entry->sourceSampleRate },
        { "sourceChannels",   entry->sourceChannels },
        { "channels",         1 },
        // Fetch this for the samples themselves - see BRIDGE.md. Passing a few
        // million floats through the JSON bridge would be far slower.
        { "pcmUrl",           "/native/pcm/" + entry->token + ".f32" } });
}

void NativeBridge::decodeAndReply (const juce::File& file, double targetRate, Completion completion,
                                   bool fileIsOurTemp, juce::String displayNameOverride,
                                   bool forceOwnedCopy)
{
    workers.addJob ([this, file, targetRate, fileIsOurTemp,
                     displayName = std::move (displayNameOverride), forceOwnedCopy,
                     reply = std::move (completion)]
                    {
                        juce::String error;
                        const auto entry = proc.getPcmStore().decodeAndStore (file, targetRate, error,
                                                                             fileIsOurTemp,
                                                                             displayName);

                        if (entry == nullptr)
                        {
                            reply (makeError (error));
                            return;
                        }

                        // Browser file APIs provide bytes rather than a stable native path.
                        // Promote our staged copy before exposing AudioRef.path: Recent/project
                        // restore may persist that path, so it must be durable user data rather
                        // than an entry-owned file in the system temp directory.
                        if ((fileIsOurTemp || forceOwnedCopy)
                            && ! proc.getPcmStore().persistTake (entry->token, error, 24,
                                                                forceOwnedCopy).existsAsFile())
                        {
                            reply (makeError (error.isNotEmpty()
                                                  ? error
                                                  : "could not preserve the imported audio"));
                            return;
                        }

                        reply (describeEntry (entry));
                    });
}

void NativeBridge::fnPickAudioFile (const juce::Array<juce::var>& args, Completion completion)
{
    const auto targetRate = optionalRate (args, 0);

    if (! installChooser (std::make_unique<juce::FileChooser> (
                              "Choose a recording to transcribe",
                              juce::File::getSpecialLocation (juce::File::userMusicDirectory),
                              proc.getPcmStore().getReadableWildcards()),
                          completion))
        return;

    const juce::WeakReference<NativeBridge> safeThis (this);
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                          [safeThis, targetRate, completion] (const juce::FileChooser& fc) mutable
                          {
                              auto* bridge = safeThis.get();
                              if (bridge == nullptr)
                                  return;

                              const juce::ScopeGuard finished { [bridge] { bridge->finishChooser(); } };
                              const auto file = fc.getResult();

                              if (file == juce::File())
                              {
                                  completion (makeObject ({ { "ok", false }, { "cancelled", true } }));
                                  return;
                              }

                              bridge->authorizeAudioPath (file);
                              bridge->decodeAndReply (file, targetRate, std::move (completion),
                                                      false, {}, true);
                          });
}

void NativeBridge::fnPickInputFile (const juce::Array<juce::var>& args, Completion completion)
{
    const auto targetRate = optionalRate (args, 0);
    const auto symbolicAndPrinted = juce::String (
        "*.mid;*.midi;*.musicxml;*.mxl;*.xml;*.gp;*.gp3;*.gp4;*.gp5;*.gpx;*.gp7;"
        "*.pdf;*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.bmp;*.omr;*.riffsheet");
    const auto wildcards = proc.getPcmStore().getReadableWildcards() + ";" + symbolicAndPrinted;

    if (! installChooser (std::make_unique<juce::FileChooser> (
                              "Open in Riffsheet",
                              juce::File::getSpecialLocation (juce::File::userMusicDirectory),
                              wildcards),
                          completion))
        return;

    const juce::WeakReference<NativeBridge> safeThis (this);
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                          [safeThis, targetRate, completion] (const juce::FileChooser& fc) mutable
                          {
                              auto* bridge = safeThis.get();
                              if (bridge == nullptr)
                                  return;

                              const juce::ScopeGuard finished { [bridge] { bridge->finishChooser(); } };
                              const auto file = fc.getResult();
                              if (file == juce::File())
                              {
                                  completion (makeObject ({ { "ok", false }, { "cancelled", true } }));
                                  return;
                              }

                              if (! isByteInputFile (file))
                              {
                                  bridge->authorizeAudioPath (file);
                                  bridge->decodeAndReply (file, targetRate, std::move (completion),
                                                          false, {}, true);
                                  return;
                              }

                              juce::MemoryBlock bytes;
                              juce::String error;
                              if (! readBoundedByteFile (file, bytes, error))
                              {
                                  completion (makeError (error));
                                  return;
                              }

                              completion (makeObject ({
                                  { "ok", true },
                                  { "kind", "bytes" },
                                  { "path", file.getFullPathName() },
                                  { "name", file.getFileName() },
                                  { "contents", juce::Base64::toBase64 (bytes.getData(), bytes.getSize()) }
                              }));
                          });
}

void NativeBridge::fnLoadAudioPath (const juce::Array<juce::var>& args, Completion completion)
{
    const juce::File file (stringArg (args, 0));

    if (! file.existsAsFile())
    {
        completion (makeError ("no such file: " + file.getFullPathName()));
        return;
    }

    if (! isAuthorizedAudioPath (file))
    {
        completion (makeError ("For safety, restored audio must be a Riffsheet take or a file "
                               "you selected in this window. Use Open to import it first."));
        return;
    }

    const auto forceOwnedCopy = ! file.isAChildOf (SystemProbe::takesDirectory());
    decodeAndReply (file, optionalRate (args, 1), std::move (completion),
                    false, {}, forceOwnedCopy);
}

/**
    Adopts the page's own Recent list into the durable record.

    WHY THIS EXISTS. The durable record was introduced after the Recent list
    was, so on the first launch that has it the record is empty while the user's
    Recent list is not. Without this, every entry they accumulated before today
    would answer "use Open to import it first" - technically a safe answer and a
    completely useless one, because those entries are precisely the files they
    did import by hand.

    WHY IT IS NOT A HOLE. The page may only pass what is in
    localStorage['riffsheet.recent'], which is WebView storage belonging to this
    machine and this host - it is not the session blob, so it does not travel
    inside a shared project file, which is the whole of the original threat. On
    top of that this refuses anything that is not currently a real, readable
    AUDIO file, and takes at most a Recent list's worth per call, so the worst a
    confused caller achieves is re-blessing files the user could have re-picked
    from the Open dialog in ten seconds.
*/
void NativeBridge::fnAuthorizeRecentPaths (const juce::Array<juce::var>& args, Completion completion)
{
    constexpr int maxPathsPerCall = 16;

    // Named for the same reason loadRememberedAudioPaths() names its parse: keep
    // the var that owns the array alive for as long as the pointer is used.
    const auto argument = argAt (args, 0);
    const auto* requested = argument.getArray();

    if (requested == nullptr)
    {
        completion (makeError ("authorizeRecentPaths needs an array of paths"));
        return;
    }

    const auto wildcards = proc.getPcmStore().getReadableWildcards();
    int authorized = 0, skipped = 0;

    for (int i = 0; i < juce::jmin (requested->size(), maxPathsPerCall); ++i)
    {
        const juce::File file ((*requested)[i].toString());

        if (! file.existsAsFile() || ! matchesWildcards (file, wildcards))
        {
            ++skipped;
            continue;
        }

        authorizeAudioPath (file);
        ++authorized;
    }

    completion (makeObject ({ { "ok", true },
                              { "authorized", authorized },
                              { "skipped", skipped } }));
}

//==============================================================================
void NativeBridge::fnTranscribe (const juce::Array<juce::var>& args, Completion completion)
{
    // Accepts either { token } for something already decoded, or { path }.
    const auto token = optionProperty (args, 0, "token").toString();
    const auto path  = optionProperty (args, 0, "path").toString();

    juce::File audioFile;

    // A TRANSCRIPTION IN FLIGHT IS A GENUINE USER OF THE AUDIO, so it holds its
    // own strong reference for the whole job - captured into the worker lambda
    // below. Two things depend on it: the take cannot be released while the
    // engine is working on it, and the temp WAV that ensureSourceFile() renders
    // for a capture belongs to the entry and is deleted with it, so the file
    // MuScriptor is uploading cannot disappear mid-upload.
    std::shared_ptr<const PcmStore::Entry> entryHold;

    if (token.isNotEmpty())
    {
        entryHold = proc.getPcmStore().get (token);

        if (entryHold == nullptr)
        {
            completion (makeError ("unknown pcm token: " + token));
            return;
        }

        // Captures have no file behind them, so this renders a temp WAV.
        juce::String error;
        audioFile = proc.getPcmStore().ensureSourceFile (token, error);

        if (audioFile == juce::File())
        {
            completion (makeError (error));
            return;
        }
    }
    else if (path.isNotEmpty())
    {
        audioFile = juce::File (path);

        if (! isAuthorizedAudioPath (audioFile))
        {
            completion (makeError ("For safety, transcription paths must be Riffsheet takes or "
                                   "files selected in this window."));
            return;
        }
    }

    if (! audioFile.existsAsFile())
    {
        completion (makeError ("transcribe needs { token } or { path } pointing at a real file"));
        return;
    }

    EngineAdapter::Request request;

    if (const auto* instruments = optionProperty (args, 0, "instruments").getArray())
        for (const auto& item : *instruments)
            request.instruments.add (item.toString());

    if (const auto detectTempo = optionProperty (args, 0, "detectTempo"); ! detectTempo.isVoid())
        request.detectTempo = detectTempo.isBool() ? (static_cast<bool> (detectTempo) ? "true" : "false")
                                                   : detectTempo.toString();

    const auto wantsTrueBeats = static_cast<bool> (optionProperty (args, 0, "preciseBeats"));

    // What may happen to the audio before an engine hears it. BOTH DEFAULT ON
    // when the page does not say - they are on in the settings and an older page
    // that has never heard of them should get the documented behaviour, not a
    // silently different one. What they actually gate is per engine: an engine
    // whose manifest wants neither is handed the file untouched whatever these
    // say (see below).
    const auto optionalFlag = [&args] (const char* name, bool fallback)
    {
        const auto value = optionProperty (args, 0, name);
        return value.isVoid() ? fallback : static_cast<bool> (value);
    };

    const auto allowNormalize = optionalFlag ("normalizeBeforeTranscribe", true);
    const auto allowTuning    = optionalFlag ("correctTuningBeforeTranscribe", true);

    // One stable id per plugin instance: a resubmit from this window preempts
    // our own previous job instead of colliding with it.
    request.clientId = "riffsheet-" + juce::String::toHexString ((juce::pointer_sized_int) this);

    // ---- which engine does this job ----------------------------------------
    //
    // Normally the stored choice, resolved now, in the order EngineCatalog sets.
    // `engineId` in the options overrides it for this one transcription - which
    // is how the page hands a take on after its own engine refuses a chord, and
    // how a future "listen again with Basic Pitch" button will work.
    //
    // `resolve (true)` and not `resolve()`: this is about to drive an engine IN
    // THIS PROCESS, and `auto` now heads at an engine that runs in the web view.
    // The page runs that one itself and never asks us to, so the truthful answer
    // to "which engine would the SHELL use" skips it and lands on the next row
    // that can actually be driven. Getting this wrong would not misbehave subtly
    // - every native transcribe would fail with a category error.
    const auto requestedEngine = optionProperty (args, 0, "engineId").toString().trim();
    auto& registry = proc.getEngines();
    const auto resolution = requestedEngine.isNotEmpty() ? registry.resolveExplicit (requestedEngine)
                                                         : registry.resolve (true);

    if (resolution.adapter == nullptr)
    {
        completion (makeError (resolution.reason));
        return;
    }

    // Engines that hold a gigabyte and answer a second client with 503 queue
    // machine-wide; an in-process engine takes a process-local turn instead. See
    // engine-architecture.md §1.3b for why that is not a shortcut.
    const auto exclusiveMachineWide =
        resolution.adapter->manifest().concurrency == EngineConcurrency::exclusiveMachineWide;

    const auto jobId = nextJobId++;

    auto cancelFlag = std::make_shared<std::atomic<bool>> (false);

    {
        const juce::ScopedLock sl (jobLock);
        jobCancels[jobId] = cancelFlag;
    }

    completion (makeObject ({ { "ok", true }, { "jobId", jobId }, { "pending", true } }));

    const auto label = "Riffsheet - " + audioFile.getFileName();

    longWorkers.addJob ([this, audioFile, request, jobId, wantsTrueBeats, cancelFlag, label,
                         adapterPtr = resolution.adapter, exclusiveMachineWide,
                         allowNormalize, allowTuning,
                         shutdown = shuttingDown, heldEntry = std::move (entryHold)]
                    {
                        // The hold IS the point: it keeps the take (and its temp
                        // WAV) alive for the length of the job and is released
                        // when the job object is destroyed, however the job ends
                        // - success, failure or cancel. It is also handed to the
                        // adapter, because an in-process engine wants the
                        // samples rather than the path.
                        auto& adapter = *adapterPtr;

                        const auto abandon = [cancelFlag, shutdown]
                        {
                            return cancelFlag->load() || shutdown->load();
                        };

                        const auto finish = [this, jobId] (const juce::var& payload)
                        {
                            {
                                const juce::ScopedLock sl (jobLock);
                                jobCancels.erase (jobId);
                            }

                            queuePosition = 0;
                            emit ("transcribeResult", payload);
                        };

                        const auto fail = [&finish, jobId] (const juce::String& message)
                        {
                            finish (makeObject ({ { "jobId", jobId }, { "ok", false },
                                                  { "error", message } }));
                        };

                        // ---- wait our turn --------------------------------------------
                        //
                        // MuScriptor holds ~1.5 GB while it works and does one job at a
                        // time. Several plugin instances - or the standalone app and the
                        // plugin together - used to race, and the loser saw a bare "busy
                        // with another job" from the server's own 503. Now they queue in
                        // arrival order, across processes, and the UI can say so. The
                        // wait happens HERE, on the worker pool, exactly where the
                        // transcription already ran: never the message thread and never
                        // the audio thread.
                        //
                        // WHICH TURN depends on the engine's manifest. An in-process
                        // engine holds tens of megabytes and has no server to answer 503,
                        // so making it queue behind a four-minute MuScriptor job - across
                        // processes, behind a window the user cannot see - would turn the
                        // always-available fallback into the slowest path in the app. It
                        // takes a process-local turn instead, which is the real risk in
                        // that class: eight plugin instances in one REAPER building eight
                        // sessions at once.
                        std::unique_ptr<EngineRegistry::LocalJob> localJob;
                        auto holdsMachineLock = false;

                        if (exclusiveMachineWide)
                        {
                            const auto onWaiting = [this, jobId] (int position, const juce::String& holder)
                            {
                                queuePosition = position;

                                emit ("transcribeProgress",
                                      makeObject ({ { "jobId", jobId },
                                                    { "stage", "queued" },
                                                    { "queuePosition", position },
                                                    { "holder", holder },
                                                    { "message", holder.isNotEmpty()
                                                                     ? "Waiting for " + holder + " to finish..."
                                                                     : juce::String ("Waiting for another "
                                                                                     "transcription to finish...") } }));
                            };

                            if (! EngineLock::getInstance().acquire (label, abandon, onWaiting))
                            {
                                fail ("cancelled");
                                return;
                            }

                            holdsMachineLock = true;
                        }
                        else
                        {
                            // No file lock and no queue ticket, deliberately: see
                            // engine-architecture.md §1.3b. EngineLock::lastJobFinishedMs()
                            // is therefore not stamped by this job, which is correct by
                            // construction - do not "helpfully" add a stamp.
                            localJob = std::make_unique<EngineRegistry::LocalJob> (proc.getEngines());
                        }

                        // Everything from here to the end of the job holds the
                        // engine - and giving it back is also what ends the
                        // engine's life, however this job turns out.
                        //
                        // ORDER IS THE WHOLE QUEUE RULE. The lock goes back
                        // FIRST, because a job queued behind this one is
                        // blocked on exactly that lock and takes it within
                        // 200 ms. Only then is the shutdown offered, and it
                        // refuses while anybody on this machine holds the
                        // engine or holds a queue ticket - so a queued job
                        // keeps the server alive and the LAST finisher is the
                        // one that actually stops it.
                        //
                        // A destructor, not a line at the bottom: every exit
                        // from here - success, server error, cancel, an
                        // exception - is a job that has finished, and the
                        // user asked for the engine to die after every one of
                        // them. EngineJob's destructor is the universal form of
                        // that: it gives back whatever prepare() took, for every
                        // engine, and it is a class rather than a line here so
                        // the promise can be unit-tested (this file needs a
                        // plugin host to link; that one does not).
                        //
                        // THE TWO DECLARATIONS BELOW ARE IN THIS ORDER ON
                        // PURPOSE. Destruction runs in reverse, so: the lock
                        // goes back, THEN the engine is stopped, THEN this
                        // process stops counting itself busy.
                        EngineJob job { adapter };

                        struct ReleaseLock
                        {
                            bool holdsMachineLock;

                            ~ReleaseLock()
                            {
                                if (holdsMachineLock)
                                    EngineLock::getInstance().release();
                            }
                        } releaseLock { holdsMachineLock };

                        queuePosition = 0;

                        const auto progress = [this, jobId] (const juce::String& stage)
                        {
                            emit ("transcribeProgress", makeObject ({ { "jobId", jobId },
                                                                      { "stage", "server" },
                                                                      { "message", stage } }));
                        };

                        if (abandon())
                        {
                            fail ("cancelled");
                            return;
                        }

                        // Starts / adopts / warms whatever this engine needs. For
                        // MuScriptor that is ensureRunning() with the identical
                        // progress and cancel callbacks it had before there was
                        // an adapter in front of it.
                        if (! job.prepare (progress, abandon))
                        {
                            fail (abandon() ? juce::String ("cancelled")
                                            : adapter.status().error);
                            return;
                        }

                        // ---- what the engine actually hears ---------------------------
                        //
                        // Two real transformations of the player's recording - A440
                        // correction and a -12 dBFS peak - applied ONLY to the engines
                        // whose manifest asks for them and only when the user has left
                        // them on. Basic Pitch normalises internally and is
                        // gain-invariant, so it is handed the file untouched; MuScriptor
                        // does neither and wants both.
                        //
                        // The flags come off the MANIFEST rather than capabilities(),
                        // deliberately: capabilities() may ask a live server for its
                        // instrument list, and this decision must not depend on a
                        // network round trip. The interface lets an adapter widen
                        // `instruments` at runtime but never narrow these two flags, so
                        // the compiled row is the same answer for free.
                        const auto& row = adapter.manifest();

                        EnginePreprocess::Request pre;
                        pre.wantGainNorm   = row.needsGainNorm   && allowNormalize;
                        pre.wantTuningNorm = row.needsTuningNorm && allowTuning;
                        pre.engineId       = row.id;

                        // Drums have no tuning to correct, and a kit's spectrum would
                        // give the estimator nothing but noise to be confident about.
                        pre.drumsOnly = request.instruments.size() == 1
                                     && request.instruments[0] == "drums";

                        // outputRate stays 0 - "leave the source rate alone". Every
                        // engine in the catalog already resamples its own input, so
                        // converting here as well would be a second, lossier pass, and
                        // it would cost the fast path for an engine that asked for no
                        // preprocessing at all.

                        const auto wantsPreprocess = pre.wantGainNorm || pre.wantTuningNorm;

                        if (wantsPreprocess)
                            emit ("transcribeProgress",
                                  makeObject ({ { "jobId", jobId },
                                                { "stage", "preparing" },
                                                { "message", "Getting the recording ready..." } }));

                        const auto prepared = EnginePreprocess::run (audioFile, pre, abandon);

                        // THE PREPARED COPY BELONGS TO THIS JOB, for the same reason the
                        // take's temp WAV belongs to its PcmStore entry: whoever made it
                        // is the only one who knows when the last reader is done with it.
                        // A destructor, not a line at the bottom, so a server error, a
                        // cancel or an exception cannot leave a WAV in /tmp for the rest
                        // of the machine's life - and it is declared BEFORE the cancel
                        // check below so that path is covered too. `audioFile` - the
                        // user's own file - is never in here and is never touched.
                        struct PreparedFile
                        {
                            juce::File file;
                            ~PreparedFile() { if (file != juce::File()) file.deleteFile(); }
                        } preparedFile { prepared.wroteFile ? prepared.file : juce::File() };

                        if (prepared.error == "cancelled")
                        {
                            fail ("cancelled");
                            return;
                        }

                        EngineAdapter::Callbacks callbacks;
                        callbacks.onProgress = [this, jobId] (int completed, int total)
                        {
                            emit ("transcribeProgress",
                                  makeObject ({ { "jobId", jobId },
                                                { "stage", "transcribing" },
                                                { "completed", completed },
                                                { "total", total },
                                                { "fraction", total > 0 ? (double) completed / (double) total : 0.0 } }));
                        };
                        callbacks.shouldCancel = abandon;

                        EngineAdapter::AudioInput input;
                        // The prepared copy when there is one, and the caller's own
                        // juce::File object when there is not - which is the common case
                        // and costs nothing.
                        input.file = prepared.file;
                        input.tuningRatio = prepared.pitchRatio;

                        // The entry's samples are the ORIGINAL recording - that buffer is
                        // what the page draws and the transport plays, and PcmStore
                        // declares it immutable once stored. So when a prepared copy
                        // exists the entry is deliberately NOT offered: an in-process
                        // engine that reached for the samples instead of the file would
                        // silently bypass the correction it asked for. The take is still
                        // held alive for the whole job by `heldEntry` in this lambda.
                        if (! prepared.wroteFile)
                            input.entry = heldEntry;   // null anyway for a { path } transcribe

                        juce::String error;
                        const auto startMs = juce::Time::getMillisecondCounter();
                        auto result = job.transcribe (input, request, callbacks, error);

                        if (result.isVoid())
                        {
                            fail (error);
                            return;
                        }

                        // A bundled ONNX model, in this process, for EVERY engine.
                        // It used to be a Python script run with MuScriptor's own
                        // interpreter, so a user on the built-in engine could not
                        // have precise beats at all; BeatTracker needs no venv, no
                        // Python and no MuScriptor. The payload and the event are
                        // unchanged on purpose - webcore reads `preciseBeats` and
                        // `preciseBeatsError` exactly as before (juce.ts:454).
                        if (wantsTrueBeats && ! abandon())
                        {
                            emit ("transcribeProgress", makeObject ({ { "jobId", jobId },
                                                                      { "stage", "beats" },
                                                                      { "message", "Tracking the beat..." } }));

                            juce::String beatsError;

                           #if RIFFSHEET_HAS_ONNX
                            // The SAME audio the engine heard, so the notes and the beats
                            // share one timebase all the way to applyTimebase() below.
                            // Tracking the original instead would put beats in one
                            // timebase and notes in another and hide the difference
                            // inside a fraction of a percent.
                            const auto beats = BeatTracker::analyse (prepared.file, beatsError, abandon);
                           #else
                            // -DRIFFSHEET_WITHOUT_BASIC_PITCH=ON, which means no
                            // inference runtime at all. Say so rather than
                            // returning an empty grid that reads as "no beats".
                            const juce::var beats;
                            beatsError = "This build was configured without an inference runtime, "
                                         "so it cannot track the beat.";
                           #endif

                            if (auto* obj = result.getDynamicObject())
                            {
                                obj->setProperty ("preciseBeats", beats);

                                if (beats.isVoid())
                                    obj->setProperty ("preciseBeatsError", beatsError);
                            }
                        }

                        // ---- back into the recording's own timebase --------------------
                        //
                        // THE EASIEST THING IN THIS DESIGN TO FORGET, and it fails
                        // silently: correcting pitch by resampling also changes time, so
                        // every note, beat and downbeat above is in the prepared copy's
                        // timebase. At 20 cents that is 1.16% - two seconds over a
                        // three-minute take, which reads as a transcription that slowly
                        // falls apart rather than as a bug here. A no-op at ratio 1,
                        // which is every job that was not tuning-corrected.
                        EnginePreprocess::applyTimebase (result, prepared.pitchRatio);

                        if (auto* obj = result.getDynamicObject())
                        {
                            obj->setProperty ("jobId", jobId);
                            obj->setProperty ("ok", true);
                            obj->setProperty ("elapsedMs", (int) (juce::Time::getMillisecondCounter() - startMs));
                            // THE USER'S OWN FILE, never the prepared copy: the page uses
                            // this to address the audio again, and the copy is deleted
                            // the moment this job ends.
                            obj->setProperty ("sourcePath", audioFile.getFullPathName());

                            // Only when something was actually asked for. A job where the
                            // engine wanted no preprocessing, or the user turned it off,
                            // reports exactly the payload it reported before this existed.
                            if (wantsPreprocess)
                            {
                                auto* summary = new juce::DynamicObject();
                                summary->setProperty ("applied", prepared.wroteFile);
                                summary->setProperty ("note", prepared.note);
                                summary->setProperty ("cents", prepared.cents);
                                summary->setProperty ("concentration", prepared.concentration);
                                summary->setProperty ("peaks", prepared.peaks);
                                summary->setProperty ("pitchRatio", prepared.pitchRatio);
                                summary->setProperty ("gainDb", prepared.gainDb);
                                summary->setProperty ("peakDbfs", prepared.sourcePeakDbfs);
                                obj->setProperty ("preprocess", juce::var (summary));
                            }
                        }

                        finish (result);
                    });
}

void NativeBridge::fnTranscribeCancel (const juce::Array<juce::var>& args, Completion completion)
{
    // With no argument, cancels everything this window started. With a jobId,
    // just that one. A QUEUED job is cancellable too - that is the whole point:
    // waiting behind somebody else's transcription must never be a trap.
    const auto requested = argAt (args, 0);
    const auto jobId = requested.isVoid() ? 0 : (int) requested;

    auto cancelled = 0;

    {
        const juce::ScopedLock sl (jobLock);

        for (auto& entry : jobCancels)
        {
            if (jobId == 0 || entry.first == jobId)
            {
                entry.second->store (true);
                ++cancelled;
            }
        }
    }

    completion (makeObject ({ { "ok", true }, { "cancelled", cancelled } }));
}

//==============================================================================
/**
    Save-panel results are a THREE-way answer, not two.

      { ok:true,  path, bytes }        the bytes are on disk
      { ok:false, cancelled:true }     the user dismissed the panel - not an error
      { ok:false, error }              something actually went wrong

    Conflating the middle case with success is what made the web app show an
    "Exported" toast after the user pressed Cancel. Every export path below
    returns one of exactly these three shapes.
*/
void NativeBridge::fnExportFile (const juce::Array<juce::var>& args, Completion completion)
{
    const auto suggestedName = stringArg (args, 0);
    const auto base64 = stringArg (args, 1);

    if (suggestedName.isEmpty())
    {
        completion (makeError ("exportFile needs a file name"));
        return;
    }

    juce::MemoryOutputStream decoded;

    if (! juce::Base64::convertFromBase64 (decoded, base64))
    {
        completion (makeError ("the file contents were not valid base64"));
        return;
    }

    auto bytes = std::make_shared<juce::MemoryBlock> (decoded.getData(), decoded.getDataSize());
    const auto extension = suggestedName.fromLastOccurrenceOf (".", true, false);

    if (! installChooser (std::make_unique<juce::FileChooser> (
                              "Save " + suggestedName,
                              juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                                  .getChildFile (suggestedName),
                              extension.isNotEmpty() ? "*" + extension : juce::String ("*")),
                          completion))
        return;

    const juce::WeakReference<NativeBridge> safeThis (this);
    chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::warnAboutOverwriting,
                          [safeThis, bytes, completion] (const juce::FileChooser& fc) mutable
                          {
                              auto* bridge = safeThis.get();
                              if (bridge == nullptr)
                                  return;

                              const juce::ScopeGuard finished { [bridge] { bridge->finishChooser(); } };
                              const auto file = fc.getResult();

                              if (file == juce::File())
                              {
                                  completion (makeObject ({ { "ok", false }, { "cancelled", true } }));
                                  return;
                              }

                              if (! file.replaceWithData (bytes->getData(), bytes->getSize()))
                              {
                                  completion (makeError ("could not write " + file.getFullPathName()));
                                  return;
                              }

                              completion (makeObject ({ { "ok", true },
                                                        { "path", file.getFullPathName() },
                                                        { "bytes", (int) bytes->getSize() } }));
                          });
}

/**
    Several related files, ONE save panel.

    Exists because "export both MIDI variants" was two dialogs back to back,
    which reads as a bug rather than a feature.

        exportFiles([{ name:"riff.mid",           contents:<base64> },
                     { name:"riff-as-played.mid", contents:<base64> }])

    The first entry names the panel. Whatever the user types there becomes the
    stem for ALL of them, with each entry's own suffix - the part of its name
    that the first entry does not have - kept:

        user types "take3.mid"  ->  take3.mid, take3-as-played.mid

    Cancelling reports { ok:false, cancelled:true } and writes nothing at all,
    not even the entries that would have succeeded. Everything is base64-decoded
    BEFORE the panel opens for the same reason: a bad payload must not be
    discovered halfway through writing the set.
*/
void NativeBridge::fnExportFiles (const juce::Array<juce::var>& args, Completion completion)
{
    const auto* parts = argAt (args, 0).getArray();

    if (parts == nullptr || parts->isEmpty())
    {
        completion (makeError ("exportFiles needs [{ name, contents }, ...]"));
        return;
    }

    struct Part { juce::String suffix; std::shared_ptr<juce::MemoryBlock> bytes; };
    auto decodedParts = std::make_shared<std::vector<Part>>();

    juce::String suggestedName;
    juce::String firstStem;

    for (const auto& part : *parts)
    {
        auto* obj = part.getDynamicObject();

        if (obj == nullptr)
        {
            completion (makeError ("each entry must be an object with { name, contents }"));
            return;
        }

        const auto partName = obj->getProperty ("name").toString();

        if (partName.isEmpty())
        {
            completion (makeError ("every entry needs a name"));
            return;
        }

        juce::MemoryOutputStream decoded;

        if (! juce::Base64::convertFromBase64 (decoded, obj->getProperty ("contents").toString()))
        {
            completion (makeError ("\"" + partName + "\" was not valid base64"));
            return;
        }

        const auto stem = partName.upToLastOccurrenceOf (".", false, false);

        if (suggestedName.isEmpty())
        {
            suggestedName = partName;
            firstStem = stem;
        }

        // "riff-as-played" minus "riff" -> "-as-played". A name that shares no
        // stem with the first keeps its own, so nothing can silently collide.
        const auto suffix = stem.startsWith (firstStem) ? stem.substring (firstStem.length())
                                                        : "-" + stem;

        decodedParts->push_back ({ suffix,
                                   std::make_shared<juce::MemoryBlock> (decoded.getData(), decoded.getDataSize()) });
    }

    const auto extension = suggestedName.fromLastOccurrenceOf (".", true, false);

    if (! installChooser (std::make_unique<juce::FileChooser> (
                              "Save " + suggestedName,
                              juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                                  .getChildFile (suggestedName),
                              extension.isNotEmpty() ? "*" + extension : juce::String ("*")),
                          completion))
        return;

    const juce::WeakReference<NativeBridge> safeThis (this);
    chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::warnAboutOverwriting,
                          [safeThis, decodedParts, completion] (const juce::FileChooser& fc) mutable
                          {
                              auto* bridge = safeThis.get();
                              if (bridge == nullptr)
                                  return;

                              const juce::ScopeGuard finished { [bridge] { bridge->finishChooser(); } };
                              const auto chosen = fc.getResult();

                              if (chosen == juce::File())
                              {
                                  completion (makeObject ({ { "ok", false }, { "cancelled", true } }));
                                  return;
                              }

                              const auto stem = chosen.getFileNameWithoutExtension();
                              const auto ext  = chosen.getFileExtension();
                              const auto dir  = chosen.getParentDirectory();

                              juce::Array<juce::var> written;
                              juce::int64 totalBytes = 0;

                              for (const auto& part : *decodedParts)
                              {
                                  const auto target = dir.getChildFile (
                                      juce::File::createLegalFileName (stem + part.suffix) + ext);

                                  if (! target.replaceWithData (part.bytes->getData(), part.bytes->getSize()))
                                  {
                                      completion (makeError ("could not write " + target.getFullPathName()));
                                      return;
                                  }

                                  written.add (target.getFullPathName());
                                  totalBytes += (juce::int64) part.bytes->getSize();
                              }

                              completion (makeObject ({ { "ok", true },
                                                        { "paths", written },
                                                        { "path",  written[0] },
                                                        { "bytes", (int) totalBytes } }));
                          });
}

//==============================================================================
juce::File NativeBridge::dragScratchDirectory() const
{
    // One folder per plugin instance, so two open editors never fight over the
    // same file name mid-drag.
    return juce::File::getSpecialLocation (juce::File::tempDirectory)
               .getChildFile ("riffsheet-drag-" + juce::String::toHexString ((juce::pointer_sized_int) this));
}

/**
    Drag a file straight out of the web UI and onto a DAW track.

    The web app cannot do this itself: an HTML5 drag can only offer bytes to
    another page, never a real file to another application. So the page hands us
    the bytes on mouse-down-drag, we stage them as a temp file, and JUCE starts a
    genuine OS drag whose payload is that file's PATH - which is what REAPER,
    Logic and the Finder all understand.

    TIMING IS THE WHOLE TRICK. macOS will only begin a dragging session from
    inside a live mouse-drag: JUCE reaches for the window's currentEvent, and if
    that is not a mouse event there is nothing to attach the session to. So the
    page must call this while the button is still held and the pointer has
    already moved a few pixels - NOT from an HTML5 `dragstart` (which fires
    asynchronously, by which time the event has gone) and NOT from a plain
    click. See BRIDGE.md section 4b for the exact wiring.

    When the OS refuses, we say so rather than pretending: the page can fall back
    to the normal save dialog.
*/
void NativeBridge::fnBeginMidiDrag (const juce::Array<juce::var>& args, Completion completion)
{
    const auto name = stringArg (args, 0);
    const auto base64 = stringArg (args, 1);

    if (name.isEmpty() || base64.isEmpty())
    {
        completion (makeError ("beginMidiDrag needs (fileName, base64Contents)"));
        return;
    }

    juce::MemoryOutputStream decoded;

    if (! juce::Base64::convertFromBase64 (decoded, base64))
    {
        completion (makeError ("the MIDI contents were not valid base64"));
        return;
    }

    const auto scratch = dragScratchDirectory();

    // Last drag's file is dead the moment a new one starts - the DAW copied what
    // it wanted at drop time.
    scratch.deleteRecursively();

    if (! scratch.createDirectory())
    {
        completion (makeError ("could not create the drag staging folder at " + scratch.getFullPathName()));
        return;
    }

    const auto staged = scratch.getChildFile (juce::File::createLegalFileName (name));

    if (! staged.replaceWithData (decoded.getData(), decoded.getDataSize()))
    {
        completion (makeError ("could not stage the MIDI file at " + staged.getFullPathName()));
        return;
    }

    juce::Component* source = nullptr;

    {
        const juce::ScopedLock sl (webLock);
        source = web;
    }

    if (source == nullptr)
    {
        completion (makeError ("no editor window to drag from"));
        return;
    }

    // canMoveFiles=false: the DAW copies it. If we let the target MOVE our temp
    // file, the next drag would find its own staging folder gutted.
    const auto started = juce::DragAndDropContainer::performExternalDragDropOfFiles (
        { staged.getFullPathName() }, false, source,
        [] { juce::Logger::writeToLog ("Riffsheet: external MIDI drag finished"); });

    if (! started)
    {
        completion (makeObject ({ { "ok", false },
                                  { "started", false },
                                  { "path", staged.getFullPathName() },
                                  { "error", "the system would not start a drag from here - "
                                             "call beginMidiDrag while the mouse button is still down" } }));
        return;
    }

    completion (makeObject ({ { "ok", true },
                              { "started", true },
                              { "path", staged.getFullPathName() },
                              { "bytes", (int) decoded.getDataSize() } }));
}

//==============================================================================
void NativeBridge::fnPlaybackLoad (const juce::Array<juce::var>& args, Completion completion)
{
    juce::String error;

    // An absent / null / empty token UNLOADS. The transport is one of the things
    // that keeps a take in memory now, so replacing a wav with a MIDI file has
    // to be able to say "nothing" - otherwise the wav's ~100 MB stays held by a
    // transport nobody is listening to, for the life of the instance.
    const auto arg = argAt (args, 0);
    const auto token = (arg.isVoid() || arg.isUndefined()) ? juce::String() : arg.toString();

    if (! proc.loadPlaybackToken (token, error))
    {
        completion (makeError (error));
        return;
    }

    completion (makePlaybackVar());
}

//==============================================================================
/**
    "This session is using these takes."

    Decoded audio lives in the PcmStore under a token, and the store holds only
    WEAK references - a take is alive exactly as long as something is genuinely
    using it and is released the moment nothing is (PcmStore.h, LIFETIME). Every
    C++ user holds a shared_ptr and is therefore self-describing. The page is
    not: it addresses audio by TOKEN, a string, via `/native/pcm/<token>.f32` and
    `playbackLoad(token)`, and a string is not a reference.

    So the page says what it is using, and these two calls are how.

      pcmRetain(tokens)   the COMPLETE set this session is using, replacing
                          whatever it declared before
      pcmRelease(tokens?) drop those, or everything when called with nothing

    Declarative rather than paired retain/release on purpose. A page that is
    interrupted halfway through swapping takes cannot leak, because the next
    declaration sweeps up; and re-declaring the same set repeatedly is free.

    You do NOT have to retain the take you just opened. The shell keeps the most
    recently handed-out token alive provisionally (describeEntry ->
    noteHandedOut), so a page that never calls these still works. A successful
    pcmRetain call supersedes that provisional hold; its declared set (including
    an empty set) is then authoritative.

    Both holds live on the PROCESSOR, so a plugin whose editor has been destroyed
    keeps its take. That is deliberate: losing it is the amnesia bug from
    design notes §5.5, which must not come back.
*/
namespace
{
    /** Accepts a token, an array of tokens, or nothing. */
    juce::StringArray tokenListArg (const juce::var& arg)
    {
        juce::StringArray tokens;

        if (arg.isVoid() || arg.isUndefined())
            return tokens;

        if (const auto* array = arg.getArray())
        {
            for (const auto& item : *array)
            {
                const auto token = item.toString();

                if (token.isNotEmpty())
                    tokens.addIfNotAlreadyThere (token);
            }

            return tokens;
        }

        const auto single = arg.toString();

        if (single.isNotEmpty())
            tokens.add (single);

        return tokens;
    }

    juce::var toVarArray (const juce::StringArray& strings)
    {
        juce::Array<juce::var> items;

        for (const auto& s : strings)
            items.add (s);

        return items;
    }
}

void NativeBridge::fnPcmRetain (const juce::Array<juce::var>& args, Completion completion)
{
    const auto result = proc.setSessionPcmTokens (tokenListArg (argAt (args, 0)));

    completion (makeObject ({ { "ok", true },
                              { "held",    toVarArray (result.held) },
                              { "dropped", toVarArray (result.dropped) },
                              // Not an error: a token from a previous run of the
                              // plugin, or one that was already released, is a
                              // fact the page needs rather than a failure.
                              { "unknown", toVarArray (result.unknown) },
                              { "store",   makePcmStoreVar() } }));
}

void NativeBridge::fnPcmRelease (const juce::Array<juce::var>& args, Completion completion)
{
    const auto result = proc.releaseSessionPcmTokens (tokenListArg (argAt (args, 0)));

    completion (makeObject ({ { "ok", true },
                              { "held",    toVarArray (result.held) },
                              { "dropped", toVarArray (result.dropped) },
                              { "store",   makePcmStoreVar() } }));
}

juce::var NativeBridge::makePcmStoreVar() const
{
    const auto stats = proc.getPcmStore().getStats();
    const auto rows = proc.getPcmStore().describeEntries();

    juce::Array<juce::var> list;

    for (const auto& row : rows)
        list.add (makeObject ({
            { "token",            row.token },
            { "name",             row.displayName },
            { "sampleRate",       row.sampleRate },
            { "durationSec",      row.durationSec },
            // double, not int: a ten-minute take at 44.1k is 26 million frames
            // and 106 million bytes, both well inside a double and both past
            // what a JS int32 in juce::var would carry safely.
            { "frames",           (double) row.frames },
            { "bytes",            (double) row.bytes },
            { "megabytes",        (double) row.bytes / (1024.0 * 1024.0) },
            { "holders",          row.holders },
            { "hasSourceFile",    row.hasSourceFile },
            { "sourceFileIsTemp", row.sourceFileIsTemp } }));

    return makeObject ({
        { "entries",       stats.liveEntries },
        { "trackedTokens", stats.trackedTokens },
        { "frames",        (double) stats.totalFrames },
        { "bytes",         (double) stats.totalBytes },
        { "megabytes",     (double) stats.totalBytes / (1024.0 * 1024.0) },
        { "holds", makeObject ({
              // The three named holders, so "why is this still resident?" has an
              // answer rather than a guess.
              { "handedOut", proc.getHandedOutToken() },
              { "playback",  proc.getPlaybackToken() },
              { "session",   toVarArray (proc.getSessionPcmTokens()) } }) },
        { "list", list } });
}

/**
    Numbers for "is the audio store growing?" - the anti-regression hook.

    The store used to be an unbounded map with no eviction anywhere, so every
    recording opened in a session stayed resident forever (plan notes §1.1). The fix
    is a lifetime rather than a limit, and a lifetime is only trustworthy if it
    can be watched from outside. Open several takes in a row and `entries` must
    come back DOWN; if it climbs with every open, something is holding on.

    Pull-only, like playbackDiagnostics(): nothing pushes it, so an idle plugin
    stays silent.

    Reading the answer:
      entries climbing with every take        -> a holder is not letting go.
                                                 `list[].holders` says how many
                                                 references each take still has
                                                 and `holds` names the three the
                                                 shell knows about.
      entries small, megabytes large          -> normal. One ten-minute take is
                                                 ~106 MB all by itself.
      trackedTokens >> entries                -> harmless. Dead map slots are
                                                 swept on the next lookup; the
                                                 audio is already gone.
*/
void NativeBridge::fnPcmDiagnostics (const juce::Array<juce::var>&, Completion completion)
{
    auto payload = makePcmStoreVar();

    if (auto* obj = payload.getDynamicObject())
        obj->setProperty ("ok", true);

    completion (payload);
}

void NativeBridge::fnPlaybackTransport (const juce::Array<juce::var>& args, Completion completion)
{
    const auto action = stringArg (args, 0);

    if (action == "play")       proc.playbackPlay();
    else if (action == "pause") proc.playbackPause();
    else if (action == "stop")  proc.playbackStop();
    else if (action == "seek")  proc.playbackSeek ((double) argAt (args, 1));
    else
    {
        completion (makeError ("unknown transport action: " + action));
        return;
    }

    completion (makePlaybackVar());
}

void NativeBridge::fnPlaybackSetGain (const juce::Array<juce::var>& args, Completion completion)
{
    proc.setPlaybackGain ((float) (double) argAt (args, 0));
    completion (makePlaybackVar());
}

/**
    Numbers for "playback stalled".

    Pull-only, never pushed: these move every audio block, and the pushed
    playbackPosition event is change-gated precisely so an idle plugin is silent.

    How to read the answer when the user says playback stopped:
      blocksRendered stopped climbing      -> the audio thread is not running at
                                              all (host stopped calling us)
      blocksSkippedLocked climbing         -> the message thread is holding the
                                              playback lock; a load or seek is
                                              starving the audio thread
      blocksSkippedEmpty climbing          -> we were told to play with nothing
                                              loaded
      all three flat but the web playhead  -> the fault is on the web side, not
      is frozen                               here; check __RIFFSHEET_CLOCK__
*/
void NativeBridge::fnPlaybackDiagnostics (const juce::Array<juce::var>&, Completion completion)
{
    const auto d = proc.getPlaybackDiagnostics();
    const auto status = proc.getPlaybackStatus();

    completion (makeObject ({
        { "ok", true },
        { "blocksRendered",      (double) d.blocksRendered },
        { "blocksSkippedLocked", (double) d.blocksSkippedLocked },
        { "blocksSkippedEmpty",  (double) d.blocksSkippedEmpty },
        { "sampleRate",          d.sampleRate },
        { "loaded",              status.loaded },
        { "isPlaying",           status.isPlaying },
        { "positionSec",         status.positionSec },
        { "lengthSec",           status.lengthSec } }));
}

void NativeBridge::fnLog (const juce::Array<juce::var>& args, Completion completion)
{
    // Gives the web app a way to get diagnostics into the same log stream as the
    // native side, which is the only place a plugin's output is visible in a DAW.
    const auto level = stringArg (args, 0);
    const auto message = stringArg (args, 1);
    juce::Logger::writeToLog ("Riffsheet/webcore [" + (level.isEmpty() ? "info" : level) + "] " + message);
    completion (makeObject ({ { "ok", true } }));
}

//==============================================================================
// The web app's own state, parked on the processor so it survives the editor.
//
// In REAPER, selecting another track destroys the plugin editor - WebView, page,
// every JS object. The processor does not go with it, so the page saves here on
// every meaningful change and asks for it back on boot. The same blob rides
// along in getStateInformation(), which is what makes a reopened project come
// back with the sheet on screen.
//
// The shell never parses the string. webcore owns the schema and versions it.

void NativeBridge::fnGetPersistedState (const juce::Array<juce::var>&, Completion completion)
{
    const auto json = proc.getPersistedWebState();

    // `null`, not "", when nothing has ever been stored: a fresh instance and an
    // instance whose page deliberately cleared itself must be distinguishable.
    completion (makeObject ({ { "ok",    true },
                              { "state", json.isEmpty() ? juce::var() : juce::var (json) },
                              { "bytes", (int) json.getNumBytesAsUTF8() } }));
}

void NativeBridge::fnSetPersistedState (const juce::Array<juce::var>& args, Completion completion)
{
    const auto arg = argAt (args, 0);
    // undefined / null clears the slot. Anything else is stored verbatim.
    const auto json = (arg.isVoid() || arg.isUndefined()) ? juce::String() : arg.toString();

    if (! proc.setPersistedWebState (json))
    {
        completion (makeError ("state blob is larger than "
                               + juce::String (RiffsheetAudioProcessor::maxPersistedWebStateBytes / (1024 * 1024))
                               + " MB and was not stored"));
        return;
    }

    completion (makeObject ({ { "ok", true }, { "bytes", (int) json.getNumBytesAsUTF8() } }));
}

//==============================================================================
// The engine: which weights, who is using it, and where we are in the queue.
//
// Pull-only and cheap. Everything expensive (health probes, reading another
// process's command line) happens on the worker pool and is cached, because this
// is a message-thread call and the message thread is what draws the UI.

void NativeBridge::fnOpenEngineSetup (const juce::Array<juce::var>&, Completion completion)
{
    const auto directory = MuScriptorServer::recommendedSetupDirectory();

    if (! directory.isDirectory() && directory.createDirectory().failed())
    {
        completion (makeError ("Could not create the engine setup folder at "
                               + directory.getFullPathName()));
        return;
    }

    // Say where this machine was actually looked at, not only where an install
    // is recommended. The two differ on every machine that already has an
    // engine somewhere else, and that difference is the whole support question.
    const auto searched = proc.getMuScriptor().getVenvSearchPaths();
    const auto instructions =
        MuScriptorServer::setupInstructions()
        + "\n\nWHERE RIFFSHEET LOOKED ON THIS MACHINE, in order:\n  "
        + searched.joinIntoString ("\n  ")
        + "\n\nCurrently resolved to:\n  "
        + proc.getMuScriptor().getEngineExecutable().getFullPathName()
        + (proc.getMuScriptor().getEngineExecutable().existsAsFile() ? "  (present)" : "  (MISSING)");

    const auto readme = directory.getChildFile ("README.txt");

    if (! readme.replaceWithText (instructions + "\n"))
    {
        completion (makeError ("Could not write setup instructions at "
                               + readme.getFullPathName()));
        return;
    }

    directory.revealToUser();
    completion (makeObject ({ { "ok", true },
                              { "path", directory.getFullPathName() },
                              { "venv", directory.getChildFile ("venv").getFullPathName() },
                              { "searched", searched.joinIntoString ("\n") },
                              { "instructions", instructions } }));
}

void NativeBridge::fnEngineStatus (const juce::Array<juce::var>& args, Completion completion)
{
    // engineStatus() with no argument answers for the resolved engine, exactly
    // as it always has; engineStatus(id) answers for that one.
    const auto id = stringArg (args, 0).trim();

    // Kick a background refresh so "is there already a server on 8222?" is
    // answered without anybody ever having transcribed. Rate limited, and never
    // more than one in flight.
    const auto now = SystemProbe::nowMs();

    if (now - lastEngineProbeMs.load() > 3000.0 && ! engineProbeRunning.exchange (true))
    {
        lastEngineProbeMs = now;

        workers.addJob ([this, shutdown = shuttingDown]
                        {
                            if (! shutdown->load())
                            {
                                proc.getMuScriptor().reapOrphanServers();
                                proc.getMuScriptor().refreshStatus();
                            }

                            engineProbeRunning = false;
                        });
    }

    completion (makeEngineStatusVar (id));
}

/**
    "Look again, now."

    The setup screen's Check again button. Discovery runs once at construction,
    which is the right default and useless to somebody who has just finished
    installing the engine with the plugin window open: the answer they need is
    "look at the disk as it is this second", not "restart your DAW". So this
    re-runs the whole search - environment override, engine.json, recommended
    folder, portable layouts, known hand-built locations, PATH - and then
    re-probes the ports, before answering with the ordinary status payload so the
    screen has one shape of data to render either way.

    On the worker pool: it stats a dozen paths and can health-probe two ports.
*/
/**
    Beats, and nothing else - for the engine that runs in the page.

    WHY THIS EXISTS AT ALL, because a second entry point into the beat tracker
    needs a reason. Beat tracking has never been an engine's job here: it is a
    bundled ONNX model this process runs for EVERY engine, as a sub-phase of
    `transcribe` gated on `preciseBeats`. That worked while every engine ran in
    the shell. Riffsheet's own engine does not - it listens in the web view - so
    the page has notes and no beats, and the only way to reach the tracker was to
    start a whole transcription it does not want and throw the notes away.

    So: the same tracker, the same wire shape, no engine involved.

        trackBeats({ token } | { path }) -> { ok, beats, downbeats, bpm, beatsPerBar }

    It takes NO turn in the engine queue and holds no lock. That is deliberate
    and it is safe for the same reason an in-process transcription is (see
    engine-architecture.md §1.3b): the model is small, it runs here, and making a
    beat grid wait behind somebody else's four-minute MuScriptor job would be the
    fallback path queueing behind the slow path for no reason.

    THE AUDIO IS THE USER'S OWN, untouched. `transcribe` runs the tracker over
    the PREPARED copy so notes and beats share one timebase; here there is no
    prepared copy, because the engine that produced the notes heard the original
    samples in the page. Both halves are therefore already in the recording's own
    timebase and there is nothing to map back.
*/
void NativeBridge::fnTrackBeats (const juce::Array<juce::var>& args, Completion completion)
{
    const auto token = optionProperty (args, 0, "token").toString();
    const auto path  = optionProperty (args, 0, "path").toString();

    juce::File audioFile;
    // Same reason as fnTranscribe: a job in flight is a genuine user of the
    // take, so it holds the entry until it is finished with it.
    std::shared_ptr<const PcmStore::Entry> entryHold;

    if (token.isNotEmpty())
    {
        entryHold = proc.getPcmStore().get (token);

        if (entryHold == nullptr)
        {
            completion (makeError ("unknown pcm token: " + token));
            return;
        }

        juce::String error;
        audioFile = proc.getPcmStore().ensureSourceFile (token, error);

        if (audioFile == juce::File())
        {
            completion (makeError (error));
            return;
        }
    }
    else if (path.isNotEmpty())
    {
        audioFile = juce::File (path);

        if (! isAuthorizedAudioPath (audioFile))
        {
            completion (makeError ("For safety, beat tracking paths must be Riffsheet takes or "
                                   "files selected in this window."));
            return;
        }
    }

    if (! audioFile.existsAsFile())
    {
        completion (makeError ("trackBeats needs { token } or { path } pointing at a real file"));
        return;
    }

    // `entryHold` is captured and never read on purpose: holding the PcmStore
    // entry for the life of the job is what stops the take - and the temp WAV a
    // capture renders into - being swept while the tracker is reading it.
    longWorkers.addJob ([audioFile, entryHold, shutdown = shuttingDown,
                         reply = std::move (completion)]
                        {
                            if (shutdown->load())
                            {
                                reply (makeError ("Riffsheet is closing."));
                                return;
                            }

                            juce::String error;

                           #if RIFFSHEET_HAS_ONNX
                            const auto beats = BeatTracker::analyse (audioFile, error);
                           #else
                            const juce::var beats;
                            error = "This build was configured without an inference runtime, "
                                    "so it cannot track the beat.";
                           #endif

                            if (beats.isVoid())
                            {
                                reply (makeError (error));
                                return;
                            }

                            // The tracker's object plus ok:true, so the page reads one
                            // shape whether the beats came from here or from a
                            // transcription's `preciseBeats`.
                            auto out = beats;

                            if (auto* obj = out.getDynamicObject())
                                obj->setProperty ("ok", true);

                            reply (out);
                        });
}

/**
    "I already have this engine - it is over there."

    The other door beside a one-click install, and the shape webcore has been
    built against since wave 2 (webcore/src/bridge/types.ts). One call, two jobs:

      - path == ""  -> SNIFF. Look where this engine normally lives and say what
                       was found. `searched` comes back either way, because the
                       useful half of a failed check is knowing what was looked
                       for.
      - path != ""  -> VALIDATE THAT ONE PLACE, and if it is not a working copy,
                       say what was missing.

    WHAT "WORKING" MEANS IS PER ENGINE, and it is deliberately a FILE check, not
    an execution:

      - transkun is a pip console script. A copy is working when the `transkun`
        executable is there and runnable - in a venv's bin/, or on PATH.
      - bass-v2 is a repository you point at. A copy is working when `infer.py`
        and a checkpoints folder with something in it are both present.

    Nothing is run to find out. Executing a stranger's script to see whether it
    is installed is a bigger promise than this call makes, it is slow, and on a
    broken venv it hangs. Stat is enough to tell a real install from a folder
    somebody hoped was one.

    Refuses engines that cannot be installed anywhere else: a bundled engine has
    no "other copy", and an in-page engine has no copy at all.
*/
void NativeBridge::fnValidateExistingEngineInstall (const juce::Array<juce::var>& args,
                                                    Completion completion)
{
    const auto id = argAt (args, 0).toString().trim();
    const auto requested = argAt (args, 1).toString().trim();

    const auto* manifest = EngineCatalog::find (id);

    if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
    {
        completion (makeObject ({ { "ok", false },
                                  { "detail", "\"" + id + "\" is not an engine this build knows about." } }));
        return;
    }

    if (manifest->install == InstallKind::bundled)
    {
        completion (makeObject ({ { "ok", false },
                                  { "detail", manifestText (manifest->name)
                                              + " ships inside Riffsheet, so there is no other copy "
                                                "to point at." } }));
        return;
    }

    workers.addJob ([this, id, requested, manifest, shutdown = shuttingDown,
                     reply = std::move (completion)]
                    {
                        if (shutdown->load())
                        {
                            reply (makeError ("Riffsheet is closing."));
                            return;
                        }

                        juce::StringArray searched;
                        juce::String detail;
                        const auto found = EngineInstaller::findExistingInstall (*manifest, requested,
                                                                                 searched, detail);

                        juce::Array<juce::var> searchedVar;

                        for (const auto& one : searched)
                            searchedVar.add (one);

                        if (found == juce::File())
                        {
                            reply (makeObject ({ { "ok", false },
                                                 { "detail", detail },
                                                 { "searched", searchedVar } }));
                            return;
                        }

                        // Recorded exactly as an install records itself, so the card
                        // behaves from here on as it does after a download.
                        EngineInstaller::rememberInstallLocation (id, found);

                        if (auto* adapter = proc.getEngines().find (id))
                            adapter->rediscover();

                        reply (makeObject ({ { "ok", true },
                                             { "detail", detail },
                                             { "path", found.getFullPathName() },
                                             { "searched", searchedVar } }));
                    });
}

void NativeBridge::fnRecheckEngine (const juce::Array<juce::var>&, Completion completion)
{
    workers.addJob ([this, shutdown = shuttingDown, reply = std::move (completion)]
                    {
                        if (shutdown->load())
                        {
                            reply (makeError ("Riffsheet is closing."));
                            return;
                        }

                        // EVERY adapter, not only MuScriptor's: "look again,
                        // now" is a statement about this machine, and an engine
                        // the user installed by hand while the window was open
                        // must be found whichever engine it was. Cheap for a
                        // bundled engine and a folder stat for a sidecar; for
                        // MuScriptor it is the same rediscover/reap/refresh trio
                        // this function has always run.
                        for (auto* adapter : proc.getEngines().all())
                            adapter->rediscover();

                        lastEngineProbeMs = SystemProbe::nowMs();

                        reply (makeEngineStatusVar());
                    });
}

juce::var NativeBridge::makeEngineStatusVar (const juce::String& id)
{
    auto& registry = proc.getEngines();

    // WITH NO ID THIS ANSWERS FOR THE ENGINE **THIS PROCESS** WOULD RUN, which
    // is `resolve (true)` and not `resolve()`. It was the same thing until the
    // catalogue gained an engine that runs in the web view, and the difference
    // is not a detail: every field in this payload is about a LISTENER PROCESS -
    // a port, an adopted server, the weights in memory, whether it can be
    // stopped. Riffsheet's own engine has none of them, so answering for it
    // would mean the "left running, 1.5 GB" notice about somebody else's
    // MuScriptor silently stopped appearing the moment `auto` preferred
    // Riffsheet - which is precisely the notice that exists because a player
    // could not tell what was eating their machine. The USER-facing resolution
    // is unaffected and is still reported below and by listEngines().
    const auto resolution = registry.resolve();
    const auto nativeResolution = registry.resolve (true);

    const EngineManifest* manifest = nullptr;
    EngineAdapter* adapter = nullptr;

    if (id.isEmpty())
    {
        adapter = nativeResolution.adapter;
        manifest = adapter != nullptr ? &adapter->manifest()
                                      : EngineCatalog::find (nativeResolution.resolved);
    }
    else
    {
        manifest = EngineCatalog::find (id);

        if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
            return makeError ("unknown engine \"" + id + "\"");

        adapter = registry.find (id);
    }

    if (manifest == nullptr)
        return makeError ("this build has no transcription engine compiled in");

    EngineAdapter::Status status;

    if (adapter != nullptr)
    {
        status = adapter->status();
    }
    else
    {
        // A row in the table with no adapter in this build. Say so plainly
        // rather than reporting a state it does not have.
        status.availability = EngineAdapter::Availability::notInstalled;
        status.stateName = "stopped";
        status.detail = manifestText (manifest->name) + " is not part of this build yet.";
    }

    const auto engine = EngineLock::getInstance().snapshot();
    const auto localBusy = registry.isLocalBusy();
    const auto busy = engine.busy || localBusy;

    juce::Array<juce::var> searchedList;

    // Every place discovery looked, in order, so the setup screen can show it.
    // "Not found at <one canonical path nobody has>" was the whole of the
    // reported bug; a list somebody can read against their own disk is the
    // difference between a dead end and a fix. Engines that search nothing
    // answer with an empty list rather than dropping the field.
    for (const auto& path : status.searchedPaths)
        searchedList.add (path);

    // The guide, from the compiled-in manifest so there is one copy of it.
    // Objects, not strings: the setup screen draws `what` in a <strong> and
    // `detail` in a <div class="dim">, and a flat list would lose half of every
    // step. `guideStepsText` is the same steps as one line each, for anything
    // that only wants to print them.
    juce::Array<juce::var> guideSteps, guideStepsText;

    for (int i = 0; i < manifest->guideStepCount; ++i)
    {
        const auto& step = manifest->guideSteps[i];
        guideSteps.add (makeObject ({ { "what",   manifestText (step.what) },
                                      { "detail", manifestText (step.detail) } }));
        guideStepsText.add (manifestText (step.what) + " - " + manifestText (step.detail));
    }

    auto payload = makeObject ({
        { "ok", true },

        // --- which engine this payload is about (new in the multi-engine wave) -
        { "id", manifestText (manifest->id) },
        { "configuredEngine", resolution.configured },
        { "resolvedEngine", resolution.resolved },
        { "engineReason", resolution.reason },
        { "install", EngineCatalog::installName (manifest->install) },
        { "guideSteps", guideSteps },
        { "guideStepsText", guideStepsText },

        { "state", status.stateName.isNotEmpty() ? status.stateName : juce::String ("stopped") },
        { "port", status.port },
        { "adopted", status.adopted },

        // --- the MuScriptor-shaped half ----------------------------------------
        // Present for every engine, with honest values rather than missing keys:
        // webcore's toEngineStatus() defaults a missing field to "unknown", and
        // "irrelevant to this engine" is not unknown. MuScriptor's adapter
        // overwrites all of these through Status::extra below.
        { "model", "" },
        { "modelSource", "not applicable to this engine" },
        { "configuredModel", "" },
        { "resolvedModel", "" },
        { "modelReason", "" },
        { "installedModels", juce::Array<juce::var>() },
        { "models", juce::Array<juce::var>() },
        { "venv", "" },
        { "setupDirectory", "" },
        { "idleSeconds", 0.0 },
        { "canStop", false },
        // No other engine runs a server anybody else could have started, so
        // "somebody else's engine is up" is false for them rather than absent.
        { "externalServer", false },
        { "canStopExternal", false },
        { "memoryMb", juce::var() },

        // "this engine is on this machine", which for MuScriptor is exactly what
        // it always was - its executable exists - and for a bundled engine is
        // simply true.
        { "executable", status.location },
        { "engineInstalled", EngineRegistry::isPresent (status.availability) },
        { "searchedPaths", searchedList },

        // The one setting that works inside a DAW: a Finder-launched host never
        // sees RIFFSHEET_MUSCRIPTOR_VENV, and this file it always sees. It is
        // also where the engine choice now lives, so it stays the same path for
        // every engine. The setup screen shows it whether or not the file exists
        // yet, because creating it is the instruction.
        { "engineConfigPath", MuScriptorServer::engineConfigFile().getFullPathName() },
        { "engineConfigExists", MuScriptorServer::engineConfigFile().existsAsFile() },

        // `busy` is the machine-wide lock OR an in-process job here. An
        // in-process engine takes no file lock (engine-architecture.md §1.3b),
        // so without the second term the UI would say idle while it worked.
        { "busy", busy },
        { "busyOwner", busy ? juce::var ((localBusy || engine.heldByThisProcess) ? "self" : "other")
                            : juce::var() },
        { "busyLabel", engine.holderLabel },
        { "busySeconds", engine.heldForSec },
        { "queueLength", engine.queueLength },
        { "queuePosition", queuePosition.load() },

        { "ramTotalMb", SystemProbe::physicalRamMb() },
        { "ramFreeMb", SystemProbe::availableRamMb() },

        // --- the engine only lives for one job ---------------------------------
        // The user's objection was that a gigabyte of model sits resident for
        // something that is idle almost all the time, and his decision was that
        // it should die the moment a transcription ends rather than after any
        // timeout at all. `stopsAfterEachJob` is what lets the UI say "stopped"
        // is the resting state rather than drawing a countdown; `idleSeconds` is
        // reported because it is a true number, not because anything waits on it.
        // It is universal now: endOfJob() gives back whatever prepare() took,
        // for every engine.
        { "stopsAfterEachJob", true },

        { "error", status.error.isNotEmpty() ? juce::var (status.error) : juce::var() } });

    // The engine-specific half, merged over the shared shape. For MuScriptor
    // that is every field this payload has ever had - model, modelSource, the
    // configured/resolved pair, installedModels, venv, setupDirectory, the idle
    // numbers - so its status is byte for byte what it was before there was a
    // second engine.
    if (auto* object = payload.getDynamicObject())
        if (auto* extra = status.extra.getDynamicObject())
            for (const auto& property : extra->getProperties())
                object->setProperty (property.name, property.value);

    return payload;
}

/**
    The engine picker's data: the compiled-in table plus each adapter's cached
    status. Cheap and pull-only, so the settings panel's existing 2 s poll can
    ask for it alongside engineStatus() without a second timer.

    An engine whose manifest is one-click but not redistributable is not in the
    array at all - a card offering an Install that must refuse is worse than no
    card. An engine that is in the table but has no adapter compiled into this
    build (Basic Pitch, until wave 3) IS listed, as `not-installed` with a
    sentence saying so, because hiding it would make the picker disagree with
    the product.
*/
juce::var NativeBridge::makeEngineListVar()
{
    auto& registry = proc.getEngines();
    const auto resolution = registry.resolve();

    juce::Array<juce::var> engines;

    for (const auto* manifest : EngineCatalog::offered())
    {
        auto* adapter = registry.find (manifest->id);

        EngineAdapter::Status status;

        if (adapter != nullptr)
        {
            status = adapter->status();
        }
        else
        {
            status.availability = EngineAdapter::Availability::notInstalled;
            status.stateName = "stopped";
            status.detail = manifestText (manifest->name) + " is not part of this build yet.";
        }

        juce::Array<juce::var> strengths;

        for (int i = 0; i < manifest->instrumentStrengthCount; ++i)
            strengths.add (manifestText (manifest->instrumentStrengths[i]));

        engines.add (makeObject ({
            { "id", manifestText (manifest->id) },
            { "name", manifestText (manifest->name) },
            { "tier", manifestText (manifest->tierLabel) },
            { "summary", manifestText (manifest->summary) },
            { "sourceUrl", manifestText (manifest->sourceUrl) },
            { "install", EngineCatalog::installName (manifest->install) },
            { "state", EngineRegistry::stateName (status.availability) },
            { "selected", resolution.resolved == manifest->id },
            { "instrumentStrengths", strengths },

            // A clean boolean beside `state`, so a card can hide an install
            // guide without re-deriving "installed" from a four-valued string
            // (and getting `broken` wrong, which is installed-but-failing).
            { "installed", EngineRegistry::isPresent (status.availability) },
            { "acceptsInstrumentConstraint", manifest->acceptsInstrumentConstraint },
            { "producesBeatGrid", manifest->producesBeatGrid },
            { "producesConfidence", manifest->producesConfidence },
            { "producesVelocity", manifest->producesVelocity },
            { "approxDiskBytes", (double) manifest->approxDiskBytes },
            { "approxPeakRssMb", manifest->approxPeakRssMb },
            { "installing", isInstalling (manifest->id) },
            { "detail", status.detail },
            { "error", status.error.isNotEmpty() ? juce::var (status.error) : juce::var() } }));
    }

    // WHAT THIS PROCESS WOULD USE IF THE PAGE'S OWN ENGINE BOWED OUT.
    //
    // Riffsheet's engine runs in the web view and can refuse a take it hears as
    // chordal. When it does, the page hands the take straight on - and it needs
    // two things to do that honestly: an id to pass as `engineId`, and a name to
    // put in the sentence it shows ("Sounded like chords - handed to X"). Both
    // come from here rather than from a copy of the order in TypeScript, because
    // two copies of "which engine is next" is exactly the kind of thing that
    // drifts and then lies to somebody.
    const auto nativeFallback = registry.resolve (true);

    return makeObject ({ { "ok", true },
                         { "configuredEngine", resolution.configured },
                         { "resolvedEngine", resolution.resolved },
                         { "engineReason", resolution.reason },
                         { "nativeFallbackEngine", nativeFallback.resolved },
                         { "engines", engines } });
}

void NativeBridge::fnListEngines (const juce::Array<juce::var>&, Completion completion)
{
    completion (makeEngineListVar());
}

/**
    "Use this engine from now on."

    Modelled on setEngineModel(), including its refusal while anything on this
    machine is transcribing: swapping the engine under a running job is the same
    class of bug as swapping the weights underneath it.

    It deliberately does NOT refuse an engine that is not installed yet. That is
    how the card's "Select" affordance works alongside "Install" - the choice is
    stored, resolution falls back to something that can actually run, and
    `reason` says why in a sentence.
*/
void NativeBridge::fnSelectEngine (const juce::Array<juce::var>& args, Completion completion)
{
    const auto requested = stringArg (args, 0).trim();

    if (requested.isEmpty())
    {
        completion (makeError ("selectEngine needs an engine id, or \"auto\""));
        return;
    }

    auto& registry = proc.getEngines();
    const auto engine = EngineLock::getInstance().snapshot();

    if (engine.busy || registry.isLocalBusy())
    {
        completion (makeError ((engine.heldByThisProcess || registry.isLocalBusy())
                                   ? juce::String ("A transcription is running right now. Try again when "
                                                   "it has finished.")
                                   : "Something else on this machine is transcribing right now ("
                                     + engine.holderLabel + "). Try again when it has finished."));
        return;
    }

    const auto outcome = registry.select (requested);

    if (! outcome.ok)
    {
        completion (makeError (outcome.error));
        return;
    }

    completion (makeObject ({ { "ok", true },
                              { "configuredEngine", outcome.resolution.configured },
                              { "resolvedEngine", outcome.resolution.resolved },
                              { "reason", outcome.resolution.reason } }));
}

//==============================================================================
// One-click installs.
//
// Modelled beat for beat on transcribe/transcribeProgress/transcribeResult/
// transcribeCancel, because that shape is already implemented, already
// documented, already cancellable while queued, and already understood by the
// page. The differences are all in what the worker does.
//
// NO BYTES EVER CROSS THE BRIDGE. The download streams to disk in C++ and every
// event carries integers and short strings, so the WebView payload ceiling is
// irrelevant to installs by construction rather than by a length check. Nobody
// should ever add a `previewBytes` field here.

bool NativeBridge::isInstalling (const juce::String& id) const
{
    const juce::ScopedLock sl (installLock);
    return installingEngines.find (id) != installingEngines.end();
}

/**
    "Install this engine."

    Answers immediately with a job id and then works on the installer pool. The
    refusals that can be decided without touching the network or spawning a
    process are decided here, synchronously, so the card never shows a progress
    bar for something that was never going to start:

      - an engine that is not in the table, or is filtered out of it;
      - an engine that is not one-click - the AGPL red line for MuScriptor is a
        missing download in its manifest, and this is where that missing field
        turns into a refusal;
      - a second Install on a card that is already installing;
      - no verified package list for this platform;
      - less than three times the download free on the volume.

    Finding a Python takes several subprocess launches, so that one happens on
    the worker and comes back as an `engineInstallResult` carrying `guideSteps` -
    the same fields, and the card degrades into a guide either way.
*/
void NativeBridge::fnInstallEngine (const juce::Array<juce::var>& args, Completion completion)
{
    const auto id = stringArg (args, 0).trim();
    const auto* manifest = EngineCatalog::find (id);

    if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
    {
        completion (makeError ("unknown engine \"" + id + "\""));
        return;
    }

    if (manifest->install != InstallKind::oneClick)
    {
        completion (makeError (manifestText (manifest->name)
                               + " cannot be installed by Riffsheet. "
                               + (manifest->install == InstallKind::bundled
                                    ? juce::String ("It is already built in.")
                                    : juce::String ("Its setup steps are on its card."))));
        return;
    }

    {
        const juce::ScopedLock sl (installLock);

        if (installingEngines.find (id) != installingEngines.end())
        {
            completion (makeError (manifestText (manifest->name) + " is already installing."));
            return;
        }
    }

    juce::String planError;
    const auto plan = EngineInstall::planFor (*manifest, planError);

    if (planError.isNotEmpty())
    {
        juce::Array<juce::var> steps;

        for (int i = 0; i < manifest->guideStepCount; ++i)
            steps.add (manifestText (manifest->guideSteps[i].what) + " - "
                       + manifestText (manifest->guideSteps[i].detail));

        completion (makeObject ({ { "ok", false }, { "error", planError }, { "guideSteps", steps } }));
        return;
    }

    if (const auto complaint = EngineInstaller::checkDiskSpace (EngineInstaller::enginesRoot(),
                                                                EngineInstaller::requiredFreeBytes (plan));
        complaint.isNotEmpty())
    {
        completion (makeError (complaint));
        return;
    }

    const auto jobId = nextJobId++;
    auto cancelFlag = std::make_shared<std::atomic<bool>> (false);

    {
        const juce::ScopedLock sl (installLock);
        installCancels[jobId] = cancelFlag;
        installingEngines[id] = jobId;
    }

    completion (makeObject ({ { "ok", true }, { "jobId", jobId }, { "pending", true } }));

    installWorkers.addJob ([this, jobId, id, manifest, cancelFlag, shutdown = shuttingDown]
    {
        const auto abandon = [cancelFlag, shutdown]
        {
            return cancelFlag->load() || shutdown->load();
        };

        // Change-gated at 5 Hz, exactly like the transcribe events: an identical
        // payload is never re-sent, and a download that moves a megabyte a
        // second does not push 3000 events a second through a WebView.
        auto lastEmitMs = 0.0;
        juce::String lastSignature;

        EngineInstaller::Callbacks callbacks;

        callbacks.shouldCancel = abandon;

        callbacks.onProgress = [this, jobId, id, &lastEmitMs, &lastSignature]
                               (const EngineInstall::Progress& progress)
        {
            const auto stage = juce::String (EngineInstall::stageName (progress.stage));

            const auto signature = stage + "|" + progress.message + "|"
                                 + juce::String (progress.receivedBytes) + "|"
                                 + juce::String (progress.totalBytes);

            const auto nowMs = juce::Time::getMillisecondCounterHiRes();

            if (signature == lastSignature || nowMs - lastEmitMs < 200.0)
                return;

            lastEmitMs = nowMs;
            lastSignature = signature;

            emit ("engineInstallProgress",
                  makeObject ({ { "jobId", jobId },
                                { "id", id },
                                { "stage", stage },
                                { "message", progress.message },
                                { "receivedBytes", (double) progress.receivedBytes },
                                { "totalBytes", (double) progress.totalBytes },
                                { "fraction", progress.fraction },
                                { "bytesPerSec", progress.bytesPerSec },
                                { "etaSec", progress.etaSec >= 0.0 ? juce::var (progress.etaSec)
                                                                   : juce::var() } }));
        };

        // The install ends by really transcribing a test clip with a model that
        // holds a gigabyte or two. On an 8 GB machine that must not happen
        // underneath somebody else's transcription, so it queues for the
        // machine-wide turn like any other job - and gives it back immediately
        // after, without stamping "a transcription just finished".
        const auto label = "Riffsheet - installing " + manifestText (manifest->name);

        callbacks.acquireMachineTurn = [label, abandon]
        {
            return EngineLock::getInstance().acquire (label, abandon, nullptr);
        };

        callbacks.releaseMachineTurn = []
        {
            EngineLock::getInstance().release (false);
        };

        const auto outcome = EngineInstaller::install (*manifest, callbacks);

        // Whatever happened, the adapter must look at the disk again before the
        // page asks: the card is repainted off the very next listEngines() poll.
        if (auto* adapter = proc.getEngines().find (id))
            adapter->rediscover();

        {
            const juce::ScopedLock sl (installLock);
            installCancels.erase (jobId);
            installingEngines.erase (id);
        }

        if (outcome.ok)
        {
            emit ("engineInstallResult",
                  makeObject ({ { "jobId", jobId }, { "id", id }, { "ok", true },
                                { "bytesOnDisk", (double) outcome.bytesOnDisk },
                                { "elapsedMs", outcome.elapsedMs },
                                { "location", outcome.location } }));
            return;
        }

        juce::Array<juce::var> steps;

        for (const auto& step : outcome.guideSteps)
            steps.add (step);

        emit ("engineInstallResult",
              makeObject ({ { "jobId", jobId }, { "id", id }, { "ok", false },
                            { "error", outcome.error },
                            { "cancelled", outcome.cancelled ? juce::var (true) : juce::var() },
                            { "elapsedMs", outcome.elapsedMs },
                            { "guideSteps", steps } }));
    });
}

/**
    "Stop installing." With no argument, stops every install this window started.

    The flag is checked between every 64 KiB of download and every 100 ms of a
    child process, so it lands in well under a second even in the middle of pip.
    A cancelled install leaves nothing behind but its verified partial downloads,
    which are exactly what makes pressing Install again cheap.
*/
void NativeBridge::fnCancelInstall (const juce::Array<juce::var>& args, Completion completion)
{
    const auto requested = argAt (args, 0);
    const auto jobId = requested.isVoid() || requested.isUndefined() ? 0 : (int) requested;

    int cancelled = 0;

    {
        const juce::ScopedLock sl (installLock);

        for (auto& [id, flag] : installCancels)
        {
            if (jobId != 0 && id != jobId)
                continue;

            flag->store (true);
            ++cancelled;
        }
    }

    completion (makeObject ({ { "ok", true }, { "cancelled", cancelled } }));
}

/**
    "Take it off my disk", and say what that was worth.

    Refuses for anything Riffsheet did not install - the bundled engine and
    MuScriptor's own venv - which is the same principle as never killing a server
    it did not start. Refuses while the engine being removed is the one currently
    transcribing, because deleting a venv out from under a running interpreter
    produces an error message about a missing module rather than about what
    actually happened.
*/
void NativeBridge::fnUninstallEngine (const juce::Array<juce::var>& args, Completion completion)
{
    const auto id = stringArg (args, 0).trim();
    const auto* manifest = EngineCatalog::find (id);

    if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
    {
        completion (makeError ("unknown engine \"" + id + "\""));
        return;
    }

    if (manifest->install != InstallKind::oneClick)
    {
        completion (makeError (manifestText (manifest->name) + " was not installed by Riffsheet, "
                                                               "so Riffsheet will not remove it."));
        return;
    }

    if (isInstalling (id))
    {
        completion (makeError (manifestText (manifest->name)
                               + " is installing right now. Cancel that first."));
        return;
    }

    auto& registry = proc.getEngines();
    const auto engine = EngineLock::getInstance().snapshot();

    if ((engine.busy || registry.isLocalBusy()) && registry.resolve().resolved == id)
    {
        completion (makeError (manifestText (manifest->name) + " is transcribing right now. Try "
                                                               "again when it has finished."));
        return;
    }

    // A gigabyte of small files takes real time to delete, and the message
    // thread is what draws the UI.
    workers.addJob ([this, id, manifest, reply = std::move (completion)]
    {
        const auto outcome = EngineInstaller::uninstall (*manifest);

        if (auto* adapter = proc.getEngines().find (id))
            adapter->rediscover();

        if (! outcome.ok)
        {
            reply (makeError (outcome.error));
            return;
        }

        reply (makeObject ({ { "ok", true },
                             { "id", id },
                             { "freedBytes", (double) outcome.bytesOnDisk } }));
    });
}

/**
    Give the memory back now, because the user asked.

    Mostly redundant now that the engine dies at the end of every job - what is
    left for this button is a server left up by a job that was queued behind
    somebody else's, or one started by a Riffsheet window that has since gone.
    Same rules as the automatic path: it will not touch a server Riffsheet did
    not start, and it will not interrupt a transcription - including one
    belonging to another Riffsheet on this machine. Both refusals come back as
    `stopped: false` with a sentence saying whose the server is or what it is
    doing, never as an error, because neither is a fault.
*/
void NativeBridge::fnStopEngine (const juce::Array<juce::var>&, Completion completion)
{
    // The refusals are all cheap and can be answered from here. Only the actual
    // stop is slow (it ends a process and waits for it), so only that goes to
    // the pool.
    const auto idle = proc.getMuScriptor().getIdleState();

    if (! idle.canStop)
    {
        completion (makeObject ({ { "ok", true }, { "stopped", false }, { "reason", idle.reason } }));
        return;
    }

    workers.addJob ([this, reply = std::move (completion)]
                    {
                        // Ownership and "never mid-job" still apply, and are
                        // re-checked in there against fresh facts.
                        const auto outcome = proc.getMuScriptor().stopIfAllowed ("you asked for the "
                                                                                "memory back");

                        reply (makeObject ({ { "ok", true },
                                             { "stopped", outcome.stopped },
                                             { "reason", outcome.reason } }));
                    });
}

/**
    "Stop it anyway" - the escape hatch from the Left running notice.

    stopEngine() refuses a server Riffsheet did not start, and that refusal is
    correct as a default and useless as an ending: somebody who force-quit the
    DAW that started it, or closed the Terminal window it came from, was being
    told to close a window that is not there any more. This is the same button
    with the user's explicit consent behind it, and it is the ONLY path in the
    shell that may end a process Riffsheet did not spawn.

    IT TAKES NO ARGUMENTS, ON PURPOSE. A port parameter would let the page aim a
    kill, and the page is the least trustworthy thing in the system - a bug or a
    stray string there would become somebody's ended process. The target is only
    ever the server the SHELL discovered on its own reuse ports and is already
    reporting through engineStatus(); MuScriptorServer::stopExternalServer()
    re-derives the pid from that port and re-proves its identity four ways at
    the moment of the kill.

    Refusals come back as `stopped: false` with a sentence, never as an error -
    "it is busy" and "that process is not a MuScriptor" are answers, not faults.
    `ok:false` is reserved for "this build has no MuScriptor to talk about".
*/
void NativeBridge::fnStopExternalEngine (const juce::Array<juce::var>&, Completion completion)
{
    // Cheap refusal from the cached photograph, so the button does not spin for
    // a second to say something that was knowable immediately. The real
    // decision is re-taken from fresh facts on the worker.
    const auto idle = proc.getMuScriptor().getIdleState();

    if (! idle.external)
    {
        completion (makeObject ({ { "ok", true },
                                  { "stopped", false },
                                  { "reason", idle.running
                                                  ? juce::String ("Riffsheet started the "
                                                                  "transcription server itself, so "
                                                                  "the ordinary Stop is what ends "
                                                                  "it.")
                                                  : idle.reason },
                                  { "port", idle.port },
                                  { "pid", 0 },
                                  { "freedMb", juce::var() } }));
        return;
    }

    workers.addJob ([this, reply = std::move (completion)]
                    {
                        const auto outcome = proc.getMuScriptor()
                                                 .stopExternalServer ("you asked to stop a server "
                                                                      "Riffsheet did not start");

                        reply (makeObject ({
                            { "ok", true },
                            { "stopped", outcome.stopped },
                            { "reason", outcome.reason },
                            { "port", outcome.port },
                            { "pid", outcome.pid },
                            // Null rather than 0 when the platform will not
                            // say: "unknown" and "freed nothing" must not look
                            // the same, the same rule memoryMb already follows.
                            { "freedMb", outcome.freedMb > 0 ? juce::var (outcome.freedMb)
                                                             : juce::var() } }));
                    });
}

void NativeBridge::fnSetEngineModel (const juce::Array<juce::var>& args, Completion completion)
{
    const auto requested = stringArg (args, 0).trim().toLowerCase();

    if (requested != "auto" && ! ModelCatalog::isKnownModelName (requested))
    {
        completion (makeError ("Unknown model \"" + requested + "\". Use auto, small, medium or large."));
        return;
    }

    auto& server = proc.getMuScriptor();

    if (server.isAdopted())
    {
        // Somebody else's server. Our setting is irrelevant to it and pretending
        // otherwise would be the worst kind of lie: the UI would say "large" and
        // the transcription would still come from their medium.
        completion (makeError ("The transcription server on port " + juce::String (server.getActivePort())
                               + " was started outside Riffsheet, so it belongs to whoever started it "
                                 "and Riffsheet cannot change its model. Close that server - the "
                                 "START-MEDIUM.command window, usually - and Riffsheet will start its "
                                 "own with the model you picked."));
        return;
    }

    const auto engine = EngineLock::getInstance().snapshot();

    if (engine.busy)
    {
        completion (makeError (engine.heldByThisProcess
                                   ? juce::String ("A transcription is running right now. Try again when "
                                                   "it has finished.")
                                   : "Something else on this machine is transcribing right now ("
                                     + engine.holderLabel + "). Try again when it has finished."));
        return;
    }

    const auto before = server.getResolvedModel();
    const auto wasRunning = server.getState() == MuScriptorServer::State::ready;

    server.setConfiguredModel (requested);

    const auto after = server.getResolvedModel();
    const auto needsRestart = wasRunning && after != before;

    if (! needsRestart)
    {
        completion (makeObject ({ { "ok", true },
                                  { "model", after },
                                  { "restarted", false },
                                  { "reason", server.getModelReason() } }));
        return;
    }

    // stop() kills a child and waits up to five seconds, which is far too long
    // to hold the message thread. The new weights load on the next transcription
    // rather than now, so nobody sits watching a spinner for four minutes.
    workers.addJob ([this, after, reason = server.getModelReason(), reply = std::move (completion)]
                    {
                        proc.getMuScriptor().stop();

                        reply (makeObject ({ { "ok", true },
                                             { "model", after },
                                             { "restarted", true },
                                             { "reason", reason },
                                             { "message", "The old transcription server has been closed. "
                                                          "The " + after + " model loads the next time you "
                                                          "transcribe something." } }));
                    });
}

//==============================================================================
/**
    "What did the host actually say?" - in one call, uninterpreted.

    This exists because of punch-list item 5: a DAW at 222 BPM and 3/6 drew as
    102 BPM and 4/4, and answering that took a lot of guessing about which of
    four layers had defaulted. Every field below is paired with whether the host
    reported it at all, and nothing here is derived, rounded or filled in.
*/
void NativeBridge::fnHostTimelineProbe (const juce::Array<juce::var>&, Completion completion)
{
    const auto info = proc.getHostInfo();
    const auto wrapper = juce::PluginHostType::getPluginLoadedAs();
    const auto isPlugin = wrapper != juce::AudioProcessor::wrapperType_Standalone
                       && wrapper != juce::AudioProcessor::wrapperType_Undefined;

    const auto optional = [] (bool has, const juce::var& value)
    {
        return has ? value : juce::var();
    };

    const auto playHead = makeObject ({
        { "hasPosition",        info.hasPosition },
        { "isPlaying",          info.isPlaying },
        { "isRecording",        info.isRecording },
        { "isLooping",          info.isLooping },

        { "hasBpm",             info.hasTempo },
        { "bpm",                optional (info.hasTempo, info.bpm) },

        { "hasTimeSignature",   info.hasTimeSig },
        { "timeSigNumerator",   optional (info.hasTimeSig, info.timeSigNumerator) },
        { "timeSigDenominator", optional (info.hasTimeSig, info.timeSigDenominator) },

        { "hasPpqPosition",     info.hasPpq },
        { "ppqPosition",        optional (info.hasPpq, info.ppqPosition) },

        { "hasPpqPositionOfLastBarStart", info.hasPpqOfLastBarStart },
        { "ppqPositionOfLastBarStart",    optional (info.hasPpqOfLastBarStart, info.ppqOfLastBarStart) },

        { "hasTimeInSeconds",   info.hasTimeInSeconds },
        { "timeInSeconds",      optional (info.hasTimeInSeconds, info.timeInSeconds) },

        { "hasTimeInSamples",   info.hasTimeInSamples },
        { "timeInSamples",      optional (info.hasTimeInSamples, (double) info.timeInSamples) },

        { "hasBarCount",        info.hasBarCount },
        { "barCount",           optional (info.hasBarCount, (double) info.barCount) },

        { "hasEditOriginTime",  info.hasEditOrigin },
        { "editOriginTime",     optional (info.hasEditOrigin, info.editOriginTime) },

        { "hasLoopPoints",      info.hasLoopPoints },
        { "loopStartPpq",       optional (info.hasLoopPoints, info.loopStartPpq) },
        { "loopEndPpq",         optional (info.hasLoopPoints, info.loopEndPpq) },

        { "hasFrameRate",       info.hasFrameRate },
        { "frameRate",          optional (info.hasFrameRate, info.frameRate) } });

    juce::Array<juce::var> notes;

    if (! isPlugin)
        notes.add ("Running standalone, so there is no host transport and no playhead at all.");
    else if (! info.hasPosition)
        notes.add ("This host has not given the plugin a playhead position yet. In most DAWs one "
                   "arrives on the first audio block, so if this stays false the plugin is probably "
                   "not being processed.");

    if (info.hasPosition && ! info.hasTempo)
        notes.add ("The host reported a playhead but no tempo, so anything showing a BPM is showing "
                   "its own default, not the DAW's.");

    if (info.hasPosition && ! info.hasTimeSig)
        notes.add ("The host reported a playhead but no time signature. Every 4/4 you can see is a "
                   "default somewhere downstream - JUCE itself passes the host's numbers through "
                   "untouched and reports nothing when the host says nothing.");

    if (info.hasTimeSig && info.timeSigDenominator > 0
        && (info.timeSigDenominator & (info.timeSigDenominator - 1)) != 0)
        notes.add ("The host reported " + juce::String (info.timeSigNumerator) + "/"
                   + juce::String (info.timeSigDenominator) + ", whose lower number is not a power "
                   "of two. It is passed on exactly as given; note that Riffsheet's own time "
                   "signature menu only lists 4/4, 3/4, 6/8, 5/4, 7/8 and 12/8, so an unusual meter "
                   "will not appear selected there even when the score really is using it.");

    if (info.hasPosition && info.hasPpq && ! info.hasPpqOfLastBarStart)
        notes.add ("The host gave a musical position but no bar position, so bar lines have to be "
                   "worked out from the meter rather than read off the DAW.");

    if (isPlugin && juce::String (juce::AudioProcessor::getWrapperTypeDescription (wrapper)) == "AudioUnit")
        notes.add ("This is the AudioUnit build. Apple's musical-time callback reports \"beats\", "
                   "which JUCE hands straight to ppqPosition as if they were quarter notes. In any "
                   "meter whose lower number is not 4 those two are not the same unit, and nothing "
                   "in JUCE reconciles them. Compare the VST3 build before trusting the bar lines.");

    completion (makeObject ({
        { "ok", true },
        { "isPlugin", isPlugin },
        { "format", juce::AudioProcessor::getWrapperTypeDescription (wrapper) },
        { "hostName", juce::PluginHostType().getHostDescription() },
        { "playHead", playHead },
        // What the capture recorded, and what the capture context would say
        // about it - so a suspect grid can be compared with its own raw input.
        { "captureMarks", proc.getCapture().describeMarks() },
        { "captureContext", proc.getCapture().buildContext() },
        { "notes", notes } }));
}

//==============================================================================
juce::var NativeBridge::makeCaptureVar() const
{
    const auto& capture = proc.getCapture();

    const auto modeName = [&capture]
    {
        switch (capture.getMode())
        {
            case TrackCapture::Mode::off:       return "off";
            case TrackCapture::Mode::armed:     return "armed";
            case TrackCapture::Mode::recording: return "recording";
            case TrackCapture::Mode::finished:  return "finished";
        }

        return "off";
    }();

    return makeObject ({ { "mode", modeName },
                         { "armedToTransport", capture.isArmedToTransport() },
                         { "secondsCaptured", capture.getCapturedSeconds() },
                         { "maxSeconds", capture.getMaxSeconds() },
                         { "sampleRate", capture.getSampleRate() },
                         { "hitLimit", capture.didHitLimit() } });
}

void NativeBridge::fnCaptureStart (const juce::Array<juce::var>& args, Completion completion)
{
    const auto armProperty = optionProperty (args, 0, "armToTransport");
    const auto armToTransport = ! armProperty.isVoid() && static_cast<bool> (armProperty);

    const auto maxProperty = optionProperty (args, 0, "maxSeconds");
    const auto maxSeconds = maxProperty.isVoid() ? 0.0 : (double) maxProperty;

    const auto wrapper = juce::PluginHostType::getPluginLoadedAs();
    const auto isPlugin = wrapper != juce::AudioProcessor::wrapperType_Standalone
                       && wrapper != juce::AudioProcessor::wrapperType_Undefined;

    if (armToTransport && ! isPlugin)
    {
        // Nothing to arm to: the standalone has no host transport.
        completion (makeError ("armToTransport only works in a DAW. In the standalone, "
                               "call captureStart() with no options to record straight away."));
        return;
    }

    juce::String error;

    if (! proc.captureStart (armToTransport, maxSeconds, error))
    {
        completion (makeError (error));
        return;
    }

    completion (makeCaptureVar());
}

void NativeBridge::fnCaptureStop (const juce::Array<juce::var>&, Completion completion)
{
    auto captureResult = proc.captureStop();

    if (! captureResult.ok)
    {
        completion (makeError (captureResult.error));
        return;
    }

    // A five-minute mono take is tens of megabytes. Persist it away from the
    // message thread, then reply only after its final, reopenable path exists.
    workers.addJob ([this, result = std::move (captureResult), reply = std::move (completion)] () mutable
                    {
                        if (! proc.persistCapturedTake (result))
                        {
                            reply (makeError (result.error));
                            return;
                        }

                        auto described = describeEntry (result.entry);

                        if (auto* obj = described.getDynamicObject())
                        {
                            // Explicitly use CaptureResult's durable path. The
                            // entry carries it too, but this keeps the DTO seam
                            // obvious and impossible to regress accidentally.
                            obj->setProperty ("path", result.path.getFullPathName());
                            obj->setProperty ("captureContext", result.context);
                            obj->setProperty ("hitLimit", result.hitLimit);
                            obj->setProperty ("isCapture", true);
                        }

                        reply (described);
                    });
}

void NativeBridge::fnCaptureStatus (const juce::Array<juce::var>&, Completion completion)
{
    completion (makeCaptureVar());
}

//==============================================================================
void NativeBridge::fnImportDroppedFile (const juce::Array<juce::var>& args, Completion completion)
{
    // The HTML5 drop path: the page has the bytes but not a usable path, so it
    // hands the bytes over and we treat them like any other opened file.
    const auto name = stringArg (args, 0);
    const auto base64 = stringArg (args, 1);

    if (name.isEmpty() || base64.isEmpty())
    {
        completion (makeError ("importDroppedFile needs (name, base64Contents)"));
        return;
    }

    juce::MemoryOutputStream decoded;

    if (! juce::Base64::convertFromBase64 (decoded, base64))
    {
        completion (makeError ("the dropped file's contents were not valid base64"));
        return;
    }

    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("riffsheet-drop-"
                                         + juce::String::toHexString (juce::Random::getSystemRandom().nextInt64())
                                         + "-" + juce::File::createLegalFileName (name));

    if (! temp.replaceWithData (decoded.getData(), decoded.getDataSize()))
    {
        completion (makeError ("could not stage the dropped file at " + temp.getFullPathName()));
        return;
    }

    // The original name is carried separately from the random staging name.
    // decodeAndReply promotes the decoded audio to durable app-support storage
    // before returning, while the entry cleans up this temporary input file.
    decodeAndReply (temp, optionalRate (args, 2), std::move (completion), true, name);
}

void NativeBridge::fnOmrStatus (const juce::Array<juce::var>&, Completion completion)
{
    longWorkers.addJob ([reply = std::move (completion)] () mutable
                        {
                            const auto status = ScoreImageImporter::probe();
                            reply (makeObject ({ { "ok", true },
                                                 { "available", status.available },
                                                 { "executable", status.executable.getFullPathName() },
                                                 { "version", status.version },
                                                 { "message", status.message } }));
                        });
}

void NativeBridge::fnRecognizeScoreImage (const juce::Array<juce::var>& args, Completion completion)
{
    const auto name = juce::File::createLegalFileName (stringArg (args, 0));
    const auto base64 = stringArg (args, 1);

    if (name.isEmpty() || base64.isEmpty())
    {
        completion (makeError ("recognizeScoreImage needs (fileName, base64Contents)"));
        return;
    }

    juce::MemoryOutputStream decoded;
    if (! juce::Base64::convertFromBase64 (decoded, base64))
    {
        completion (makeError ("the score image contents were not valid base64"));
        return;
    }
    if (decoded.getDataSize() > 64 * 1024 * 1024)
    {
        completion (makeError ("That score image/PDF is larger than 64 MB. Split the PDF first."));
        return;
    }

    juce::MemoryBlock bytes (decoded.getData(), decoded.getDataSize());
    longWorkers.addJob ([name, scoreBytes = std::move (bytes), shutdown = shuttingDown,
                         reply = std::move (completion)] () mutable
                        {
                        const auto staged = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                                .getNonexistentChildFile ("riffsheet-score-", "-" + name, false);
                        if (! staged.replaceWithData (scoreBytes.getData(), scoreBytes.getSize()))
                        {
                            reply (makeError ("Could not stage the score image for recognition."));
                            return;
                        }

                        const auto result = ScoreImageImporter::run (
                            staged,
                            [shutdown] { return shutdown->load(); });
                        staged.deleteFile();

                        if (! result.ok)
                        {
                            reply (makeError (result.error));
                            return;
                        }

                        reply (makeObject ({
                            { "ok", true },
                            { "sourceName", name },
                            { "name", result.outputName },
                            { "contents", juce::Base64::toBase64 (result.musicXml.getData(), result.musicXml.getSize()) },
                            { "convertedBy", "audiveris" },
                            { "elapsedMs", result.elapsedMs },
                            { "log", result.log }
                        }));
                    });
}

void NativeBridge::notifyFilesDropped (const juce::StringArray& paths)
{
    // Match the browser's HTML drop contract: one drop opens the first
    // supported file. The result event has the exact same audio-or-bytes shape
    // as pickInputFile(), so webcore can feed it into one universal import path.
    for (const auto& path : paths)
    {
        const juce::File file (path);

        if (isByteInputFile (file))
        {
            workers.addJob ([this, file]
                            {
                                juce::MemoryBlock bytes;
                                juce::String error;

                                if (! readBoundedByteFile (file, bytes, error))
                                {
                                    emit ("inputFileDropped", makeObject ({
                                        { "ok", false }, { "name", file.getFileName() },
                                        { "error", error } }));
                                    return;
                                }

                                emit ("inputFileDropped", makeObject ({
                                    { "ok", true },
                                    { "kind", "bytes" },
                                    { "path", file.getFullPathName() },
                                    { "name", file.getFileName() },
                                    { "contents", juce::Base64::toBase64 (bytes.getData(), bytes.getSize()) }
                                }));
                            });
            return;
        }

        if (matchesWildcards (file, proc.getPcmStore().getReadableWildcards()))
        {
            authorizeAudioPath (file);
            decodeAndReply (file, 44100.0,
                            [this, name = file.getFileName()] (juce::var result)
                            {
                                if (auto* object = result.getDynamicObject(); object != nullptr)
                                    object->setProperty ("name", name);

                                emit ("inputFileDropped", result);
                            },
                            false, {}, true);
            return;
        }
    }
}
