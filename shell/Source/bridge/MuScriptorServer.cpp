#include "MuScriptorServer.h"
#include "WebResources.h"
#include "ModelCatalog.h"
#include "MuScriptorProbe.h"
#include "ServerRegistry.h"
#include "SystemProbe.h"
#include "EngineLock.h"

namespace
{
    juce::File serverExecutableIn (const juce::File& venv)
    {
       #if JUCE_WINDOWS
        return venv.getChildFile ("Scripts").getChildFile ("muscriptor.exe");
       #else
        return venv.getChildFile ("bin").getChildFile ("muscriptor");
       #endif
    }

    void addCandidate (juce::Array<juce::File>& candidates, const juce::File& candidate)
    {
        if (candidate != juce::File() && ! candidates.contains (candidate))
            candidates.add (candidate);
    }

    juce::File venvFromPath()
    {
        juce::StringArray pathParts;

       #if JUCE_WINDOWS
        pathParts.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}), ";", "\"");
        const juce::StringArray names { "muscriptor.exe" };
       #else
        pathParts.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}), ":", "\"");
        const juce::StringArray names { "muscriptor" };
       #endif

        for (const auto& part : pathParts)
            for (const auto& name : names)
            {
                const auto executable = juce::File (part.unquoted().trim()).getChildFile (name);

                if (executable.existsAsFile())
                    return executable.getParentDirectory().getParentDirectory();
            }

        return {};
    }

    /** <appSupportDirectory>/engine.json - the ONLY writable record of where the
        engine lives.

        WHY A FILE AND NOT AN ENVIRONMENT VARIABLE. A plugin is loaded by a DAW
        that was started from the Finder, and a Finder-launched process inherits
        launchd's environment, not the user's shell. So RIFFSHEET_MUSCRIPTOR_VENV
        is unreachable advice for the audience that actually hits this error: it
        works when you launch the host from a terminal and never otherwise. A
        small JSON file in a folder the app can open for you does work, and it is
        also what the app writes for itself the first time discovery succeeds
        somewhere other than the recommended folder. */
    juce::File persistedVenvFile()
    {
        return MuScriptorServer::engineConfigFile();
    }

    juce::File readPersistedVenv()
    {
        const auto file = persistedVenvFile();

        if (! file.existsAsFile())
            return {};

        // Named, not a temporary: getDynamicObject() points into the var's
        // ref-counted payload, and a temporary dies at the end of the condition.
        const auto parsed = juce::JSON::parse (file.loadFileAsString());

        if (auto* object = parsed.getDynamicObject())
        {
            const auto path = object->getProperty ("venv").toString().unquoted().trim();

            if (path.isNotEmpty())
                return juce::File (path);
        }

        return {};
    }

    void writePersistedVenv (const juce::File& venv)
    {
        // Read-modify-write, never write-over. This file is engine.json, and it is
        // not ours alone: EngineSettings keeps `selectedEngine` in it, which is the
        // machine-wide record of which engine the user chose. Replacing the whole
        // document to store a venv path silently threw that away, so discovering a
        // MuScriptor install could reset somebody's engine choice back to Auto -
        // and EngineSettings::write() has done it the careful way all along, so
        // this was the only writer that could lose a key.
        const auto file = persistedVenvFile();
        const auto parsed = juce::JSON::parse (file.loadFileAsString());

        auto* next = new juce::DynamicObject();
        const juce::var payload (next);   // owns `next` from here on

        if (auto* object = parsed.getDynamicObject())
            for (const auto& property : object->getProperties())
                next->setProperty (property.name, property.value);

        next->setProperty ("venv", venv.getFullPathName());
        next->setProperty ("savedAtMs", (double) juce::Time::currentTimeMillis());

        file.getParentDirectory().createDirectory();
        file.replaceWithText (juce::JSON::toString (payload, true) + "\n");
    }

    /** Every place a MuScriptor venv has been known to live, in the order they
        are tried. `searched` comes back filled in so the failure message can
        name them - "not found at <one canonical path nobody has>" was the whole
        of the reported bug, and a list the user can read against their own disk
        is the difference between a dead end and a fix. */
    juce::File resolveDefaultVenv (juce::StringArray& searched, bool& fromOverride)
    {
        fromOverride = false;
        searched.clear();

        if (const auto fromEnv = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_MUSCRIPTOR_VENV", {});
            fromEnv.isNotEmpty())
        {
            fromOverride = true;
            const juce::File venv (fromEnv.unquoted().trim());
            searched.add (venv.getFullPathName() + "  (RIFFSHEET_MUSCRIPTOR_VENV)");
            return venv;
        }

        juce::Array<juce::File> candidates;
        const auto setupRoot = MuScriptorServer::recommendedSetupDirectory();
        const auto appSupport = SystemProbe::appSupportDirectory();
        const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory);
        const auto executable = juce::File::getSpecialLocation (juce::File::currentExecutableFile);
        const auto executableDir = executable.getParentDirectory();

        // 1. Whatever worked last time, remembered by this app.
        addCandidate (candidates, readPersistedVenv());

        // 2. Primary per-user contract, plus the pre-contract spelling accepted
        //    for early adopters who already created app-support/muscriptor/venv.
        addCandidate (candidates, setupRoot.getChildFile ("venv"));
        addCandidate (candidates, appSupport.getChildFile ("muscriptor/venv"));

        // 3. Portable/bundled layouts. On macOS the executable is under
        //    Contents/MacOS and resources are under Contents/Resources.
       #if JUCE_MAC
        addCandidate (candidates,
                      executableDir.getParentDirectory().getChildFile ("Resources/Riffsheet/engine/venv"));
        addCandidate (candidates,
                      executableDir.getParentDirectory().getChildFile ("Resources/engine/venv"));
       #endif
        addCandidate (candidates, executableDir.getChildFile ("engine/venv"));
        addCandidate (candidates, executableDir.getParentDirectory().getChildFile ("engine/venv"));

        // 4. Hand-built venvs from before there was a contract at all. These are
        //    legacy spellings that working installs still sit in; dropping them
        //    from the search is what broke transcription on a machine that had a
        //    perfectly good engine on disk. They cost a stat() each and nothing
        //    else, so they stay.
        addCandidate (candidates, home.getChildFile (".riffsheet/muscriptor/venv"));
        addCandidate (candidates, home.getChildFile ("Desktop/bakeoff/muscriptor/venv"));
        addCandidate (candidates, home.getChildFile ("Desktop/muscriptor/venv"));
        addCandidate (candidates, home.getChildFile ("Documents/muscriptor/venv"));
        addCandidate (candidates, home.getChildFile ("muscriptor/venv"));
        addCandidate (candidates, juce::File ("/opt/muscriptor/venv"));
        addCandidate (candidates, juce::File ("/usr/local/muscriptor/venv"));

        // 5. Last resort: an already activated or system-installed muscriptor,
        //    found without launching a shell. Rarely hits inside a DAW, for the
        //    same PATH reason the environment variable rarely hits.
        addCandidate (candidates, venvFromPath());

        for (const auto& candidate : candidates)
            searched.add (candidate.getFullPathName());

        for (const auto& candidate : candidates)
            if (serverExecutableIn (candidate).existsAsFile())
                return candidate;

        // Nothing installed anywhere. Returning the recommended path makes the
        // engine error, setup panel and README all point at the same place.
        return setupRoot.getChildFile ("venv");
    }

    juce::DynamicObject* asObject (const juce::var& v) { return v.getDynamicObject(); }

    bool isRecognisableMuScriptorOnPort (int port)
    {
        const auto pid = SystemProbe::listeningProcessId (port);
        return pid > 0
            && SystemProbe::looksLikeMuScriptorServer (SystemProbe::processCommandLine (pid));
    }
}

MuScriptorServer::MuScriptorServer()
{
    rediscoverEngine();

    if (const auto portEnv = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_MUSCRIPTOR_PORT", {});
        portEnv.isNotEmpty())
    {
        config.port = portEnv.getIntValue();
        config.reusePorts.insert (0, config.port);
    }

    // The environment variable is a hard override: it names a size (or a path,
    // or an hf:// url) and nothing auto-selects around it.
    if (const auto modelEnv = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_MUSCRIPTOR_MODEL", {});
        modelEnv.isNotEmpty())
    {
        config.model = modelEnv;
        configuredModel = modelEnv;
        resolvedModel = modelEnv;
        modelReason = "RIFFSHEET_MUSCRIPTOR_MODEL is set to \"" + modelEnv + "\", so that is what is used.";
    }
    else
    {
        refreshResolvedModel();
    }
}

MuScriptorServer::~MuScriptorServer()
{
    // Nothing to join first: the engine's lifecycle belongs to the transcription
    // job that started it, and that job is drained by NativeBridge::shutdown()
    // before any of this can run. stop() is here for the one case the job path
    // cannot cover - a server still up because the last job was queued behind
    // somebody else's, or because this process is going away between jobs.
    stop();
}

void MuScriptorServer::setConfig (Config newConfig)
{
    const juce::ScopedLock sl (configLock);
    config = std::move (newConfig);
}

MuScriptorServer::Config MuScriptorServer::getConfig() const
{
    const juce::ScopedLock sl (configLock);
    return config;
}

juce::File MuScriptorServer::recommendedSetupDirectory()
{
    return SystemProbe::appSupportDirectory().getChildFile ("engine");
}

juce::File MuScriptorServer::engineConfigFile()
{
    return SystemProbe::appSupportDirectory().getChildFile ("engine.json");
}

void MuScriptorServer::rediscoverEngine()
{
    juce::StringArray searched;
    bool venvFromOverride = false;
    const auto found = resolveDefaultVenv (searched, venvFromOverride);

    {
        const juce::ScopedLock sl (configLock);
        config.venv = found;
        venvSearchPaths = searched;
    }

    // Remember a working engine found somewhere other than the recommended
    // folder, so the next launch answers from engine.json on its first try and
    // the user has one readable place to correct it. Never for the environment
    // override: that is a deliberately temporary instruction, not a setting.
    if (! venvFromOverride
        && serverExecutableIn (found).existsAsFile()
        && found != recommendedSetupDirectory().getChildFile ("venv")
        && found != readPersistedVenv())
    {
        writePersistedVenv (found);
    }
}

juce::String MuScriptorServer::setupInstructions()
{
    const auto root = recommendedSetupDirectory();
    const auto venv = root.getChildFile ("venv");

    return "Riffsheet needs a local MuScriptor Python environment.\n\n"
           "Recommended venv folder:\n" + venv.getFullPathName() + "\n\n"
           "Install MuScriptor into that virtual environment according to its upstream "
           "instructions and licence, then restart your DAW. Riffsheet expects the "
          #if JUCE_WINDOWS
           "server at venv\\Scripts\\muscriptor.exe and Python at venv\\Scripts\\python.exe.\n\n"
          #else
           "server at venv/bin/muscriptor and Python at venv/bin/python (or python3).\n\n"
          #endif
           "ALREADY HAVE A MUSCRIPTOR VENV SOMEWHERE ELSE? Point Riffsheet at it by writing "
           "its path into\n" + persistedVenvFile().getFullPathName() + "\nas\n"
           "  {\"venv\": \"/path/to/your/muscriptor/venv\"}\n"
           "then reopen the plugin window. Riffsheet also writes that file for you the first "
           "time it finds a working engine outside the recommended folder.\n\n"
           "RIFFSHEET_MUSCRIPTOR_VENV still overrides everything, but only when the DAW itself "
           "was launched from a shell that had it set - a Finder-launched host does not inherit "
           "it. No model or weights are downloaded by this setup window.";
}

juce::StringArray MuScriptorServer::getVenvSearchPaths() const
{
    const juce::ScopedLock sl (configLock);
    return venvSearchPaths;
}

juce::File MuScriptorServer::getEngineExecutable() const
{
    return getServerExecutable();
}

juce::String MuScriptorServer::getLastError() const
{
    const juce::ScopedLock sl (errorLock);
    return lastError;
}

void MuScriptorServer::setError (const juce::String& message)
{
    const juce::ScopedLock sl (errorLock);
    lastError = message;
    juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + message);
}

juce::String MuScriptorServer::getBaseUrl() const
{
    const auto c = getConfig();
    const auto port = activePort.load() > 0 ? activePort.load() : c.port;
    return "http://" + c.host + ":" + juce::String (port);
}

//==============================================================================
// Which weights are in use, and saying so honestly.

juce::String MuScriptorServer::getConfiguredModel() const
{
    const juce::ScopedLock sl (modelLock);
    return configuredModel;
}

juce::String MuScriptorServer::getResolvedModel() const
{
    const juce::ScopedLock sl (modelLock);
    return resolvedModel;
}

juce::String MuScriptorServer::getModelReason() const
{
    const juce::ScopedLock sl (modelLock);
    return modelReason;
}

juce::String MuScriptorServer::getRunningModelDescription() const
{
    const juce::ScopedLock sl (modelLock);
    return runningModelDescription.isNotEmpty() ? runningModelDescription : resolvedModel;
}

juce::String MuScriptorServer::getRunningModelSource() const
{
    const juce::ScopedLock sl (modelLock);
    return runningModelSource;
}

juce::String MuScriptorServer::getRunningModelSize() const
{
    const juce::ScopedLock sl (modelLock);
    return runningModelSize;
}

void MuScriptorServer::refreshResolvedModel()
{
    juce::String wanted;

    {
        const juce::ScopedLock sl (modelLock);
        wanted = configuredModel;
    }

    const auto choice = ModelCatalog::resolve (wanted,
                                               SystemProbe::physicalRamMb(),
                                               SystemProbe::availableRamMb());

    {
        const juce::ScopedLock sl (modelLock);
        resolvedModel = choice.model;
        modelReason = choice.reason;
    }

    const juce::ScopedLock sl (configLock);
    config.model = choice.model;
}

void MuScriptorServer::identifyServerOnPort (int port, bool startedByUs)
{
    // MuScriptor's /health answers {"status":"ok"} and nothing else, and there
    // is no other endpoint that names the model (checked against the installed
    // server.py: /health, /instruments, /soundfonts/..., /transcribe,
    // /transcribe/midi, /auralize). So the only honest way to find out what a
    // server somebody ELSE started is running is to read its own command line.
    const auto pid = SystemProbe::listeningProcessId (port);
    const auto commandLine = pid > 0 ? SystemProbe::processCommandLine (pid) : juce::String();
    const auto fromCommandLine = ModelCatalog::modelFromCommandLine (commandLine);

    // ---- who is it, and did WE start it? ------------------------------------
    //
    // Ownership never comes from the port, the model, or the fact that it
    // answers /health: the user's own START-MEDIUM.command server has all three
    // of those too. It comes from the pid we wrote down when we spawned
    // something, AND the process still saying it is a muscriptor server - both,
    // because records go stale and pids get recycled. Anything else is not ours
    // and nothing in this class may ever stop it.
    std::optional<ServerRegistry::Entry> recorded;

    if (pid > 0)
        recorded = ServerRegistry::findByPid (pid);

    const auto previousPid = serverPid.exchange (pid);
    const auto looksRight = pid > 0 && SystemProbe::looksLikeMuScriptorServer (commandLine);
    const auto ours = looksRight && (recorded.has_value() || pid == ownedServerPid.load());

    // Cached separately from `ours`: this half is true of the user's own server
    // too, and it is what lets getIdleState() offer "stop it anyway" for one
    // without shelling out on the message thread.
    serverLooksLikeMuScriptor = looksRight;
    registryOwned = ours;
    serverMemoryMb = pid > 0 ? SystemProbe::processResidentMemoryMb (pid) : -1;

    if (! ours)
    {
        ourServerSinceMs = 0.0;
    }
    else
    {
        // The idle clock starts when Riffsheet started the server, not when this
        // window happened to notice it - otherwise a server that has been
        // sitting unused since another window opened would get five fresh
        // minutes every time somebody polled.
        auto since = recorded.has_value() ? recorded->startedMs : 0.0;

        if (since <= 0.0 && pid == previousPid)
            since = ourServerSinceMs.load();

        ourServerSinceMs = since > 0.0 ? since : SystemProbe::nowMs();
    }

    const juce::ScopedLock sl (modelLock);

    // THE SIZE, kept separate from the prose, and only ever when it is proved.
    // `resolvedModel` is what we passed to --model ourselves, so for our own
    // server it IS the size - unless RIFFSHEET_MUSCRIPTOR_MODEL named a path or
    // an hf:// URL, which is a model but not a size, and is left blank rather
    // than mapped onto one of the three words. Same test for a command line we
    // read off somebody else's server.
    const auto sizeOrNothing = [] (const juce::String& candidate)
    {
        return ModelCatalog::isKnownModelName (candidate) ? candidate : juce::String();
    };

    if (startedByUs)
    {
        runningModelDescription = resolvedModel;
        runningModelSource = "started by Riffsheet";
        runningModelSize = sizeOrNothing (resolvedModel);
        return;
    }

    if (fromCommandLine.isNotEmpty())
    {
        runningModelDescription = fromCommandLine;
        runningModelSource = "read from the command line of the server on port " + juce::String (port);
        runningModelSize = sizeOrNothing (fromCommandLine);
        return;
    }

    // No guessing. Our own setting says nothing about somebody else's server,
    // and that includes its size: the chip says "unknown size" rather than ours.
    runningModelDescription = "unknown - this server was already running";
    runningModelSource = "unknown";
    runningModelSize = {};
}

bool MuScriptorServer::haveLiveChild() const
{
    const juce::ScopedLock sl (startLock);
    return child != nullptr && child->isRunning();
}

void MuScriptorServer::refreshStatus()
{
    // Blocks on two ports' worth of HTTP and shells out to lsof/ps. The header
    // says worker threads only; this is that promise, checked.
    jassert (! juce::MessageManager::existsAndIsCurrentThread());

    const auto c = getConfig();

    for (const auto port : c.reusePorts)
    {
        if (! probeHealth (port))
            continue;

        const auto ours = haveLiveChild() && port == c.port;

        // /health alone is not identity: any localhost process can return
        // {status:"ok"}. Never upload a user's recording unless this is our
        // live child or the listening command line is recognisably MuScriptor.
        auto recognised = ours || isRecognisableMuScriptorOnPort (port);
        auto byHandshake = false;

        if (! recognised)
        {
            // THE SERVER THE OPERATING SYSTEM WOULD NOT TELL US ABOUT.
            //
            // isRecognisableMuScriptorOnPort() reads the listening pid out of
            // lsof and its command line out of ps, and there are ordinary
            // machines where both come back empty for a server that is plainly
            // there: a sandboxed plugin host cannot spawn either tool, lsof
            // hides other users' processes, and the Windows implementation of
            // listeningProcessId() returns 0 by definition. A user who starts
            // MuScriptor themselves on those machines got "stopped" from a
            // Riffsheet that was, at that moment, three lines away from the
            // running server - which is the bug this branch closes.
            //
            // So ask the SERVER. A /health that says ok plus an /instruments
            // that lists MuScriptor's own group names is identity enough to
            // REPORT a server with, and it is deliberately not enough to do
            // anything to one: `handshakeIdentifiedOnly` below is what keeps
            // the kill path and the upload path on the old, stricter proof.
            byHandshake = MuScriptorProbe::answersLikeMuScriptor (c.host, port);
            recognised = byHandshake;
        }

        if (! recognised)
            continue;

        // Before state goes to ready, never after: transcribe() reads the two
        // together to decide whether it may send audio straight to this port.
        handshakeIdentifiedOnly = byHandshake;

        activePort = port;
        adopted = ! ours;
        state = State::ready;
        identifyServerOnPort (port, ours);
        return;
    }

    if (! haveLiveChild())
    {
        if (state.load() == State::ready)
            state = State::stopped;

        activePort = 0;
        adopted = false;
        clearServerFacts();

        const juce::ScopedLock sl (modelLock);
        runningModelDescription = {};
        runningModelSource = "nothing is running yet";
        runningModelSize = {};
    }
}

void MuScriptorServer::clearServerFacts()
{
    serverPid = 0;
    serverMemoryMb = -1;
    registryOwned = false;
    serverLooksLikeMuScriptor = false;
    handshakeIdentifiedOnly = false;
    ourServerSinceMs = 0.0;
}

bool MuScriptorServer::weStartedTheServer() const noexcept
{
    if (registryOwned.load())
        return true;

    // The orphan we took over from a force-quit, before any probe has had a
    // chance to confirm it against the registry.
    const auto pid = serverPid.load();
    return pid > 0 && pid == ownedServerPid.load();
}

double MuScriptorServer::idleSinceMs() const
{
    // The later of the two, and both matter. "Last job finished" is what the
    // five minutes are really about; "when our server started" covers a server
    // that has been loaded and never used, which would otherwise sit there
    // forever with an idle clock of zero.
    return juce::jmax (EngineLock::getInstance().lastJobFinishedMs(), ourServerSinceMs.load());
}

void MuScriptorServer::reapOrphanServers()
{
    // Once per process. Every plugin instance has its own MuScriptorServer, and
    // the registry is machine-wide, so doing this per instance would be pure
    // duplicated work.
    if (reapDone.exchange (true))
        return;

    const auto report = ServerRegistry::reapOrphans ([this] (int port) { return probeHealth (port); });

    if (report.adoptedPid > 0)
    {
        // We are now the process responsible for it, so our own stop() must be
        // what finally kills it - even though there is no ChildProcess handle.
        ownedServerPid = report.adoptedPid;
    }
}

/*  GONE IN WAVE 4: getPythonExecutable().

    Its only caller was analyseBeats(), which ran a Python beat sidecar with this
    interpreter. The server itself is launched through the `muscriptor` console
    script (getServerExecutable below), never through `python`, so with the
    sidecar deleted nothing in this class needs to know where the interpreter is.
    Leaving a "find MuScriptor's Python" accessor lying about is how the next
    feature quietly acquires a venv dependency again. */

juce::File MuScriptorServer::getServerExecutable() const
{
    return serverExecutableIn (getConfig().venv);
}

juce::var MuScriptorServer::httpGetJson (int port, const juce::String& path, int timeoutMs, juce::String& error) const
{
    const auto c = getConfig();
    const juce::URL url ("http://" + c.host + ":" + juce::String (port) + path);

    int statusCode = 0;
    auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                       .withConnectionTimeoutMs (timeoutMs)
                       .withStatusCode (&statusCode);

    std::unique_ptr<juce::InputStream> stream (url.createInputStream (options));

    if (stream == nullptr)
    {
        error = "no response from " + url.toString (false);
        return {};
    }

    const auto body = stream->readEntireStreamAsString();

    if (statusCode >= 400)
    {
        error = "HTTP " + juce::String (statusCode) + " from " + path + ": " + body.substring (0, 500);
        return {};
    }

    const auto parsed = juce::JSON::parse (body);

    if (parsed.isVoid())
    {
        error = "unparseable JSON from " + path + ": " + body.substring (0, 200);
        return {};
    }

    return parsed;
}

bool MuScriptorServer::probeHealth (int port) const
{
    juce::String error;
    const auto response = httpGetJson (port, "/health", 1500, error);

    if (auto* obj = asObject (response))
        return obj->getProperty ("status").toString() == "ok";

    return false;
}

bool MuScriptorServer::spawn (juce::String& error)
{
    const auto exe = getServerExecutable();

    if (! exe.existsAsFile())
    {
        // Name every place that was looked in. A bare "not found at <path>" for
        // a path that exists on no machine is unactionable, and the environment
        // variable it used to suggest is unreachable from a Finder-launched DAW.
        error = "MuScriptor not found at " + exe.getFullPathName()
              + ". Riffsheet looked for a venv in, in order: "
              + getVenvSearchPaths().joinIntoString ("; ")
              + ". Open Engine setup to install it in the recommended folder, or put "
                "{\"venv\": \"/path/to/your/muscriptor/venv\"} in "
              + SystemProbe::appSupportDirectory().getChildFile ("engine.json").getFullPathName()
              + " and reopen this window.";
        return false;
    }

    const auto c = getConfig();

    juce::StringArray args { exe.getFullPathName(),
                             "serve",
                             "--model", c.model,
                             "--host", c.host,
                             "--port", juce::String (c.port) };

    // The supervisor attaches both pipes AND starts reading them on its own
    // thread before this function returns. See ChildProcessSupervisor.h: the
    // server prints enough during a model load to fill the kernel's pipe buffer,
    // and a full pipe stops the writer dead rather than dropping the line.
    child = std::make_unique<ChildProcessSupervisor> ("muscriptor-io");

    if (! child->start (args))
    {
        child.reset();
        error = "could not launch: " + args.joinIntoString (" ");
        return false;
    }

    activePort = c.port;
    juce::Logger::writeToLog ("Riffsheet/MuScriptor: launched " + args.joinIntoString (" "));
    return true;
}

bool MuScriptorServer::ensureRunning (std::function<void (const juce::String&)> onProgress,
                                      std::function<bool()> shouldCancel)
{
    const auto report = [&onProgress] (const juce::String& message)
    {
        if (onProgress != nullptr)
            onProgress (message);
    };

    // Before anything else: clear up after a force-quit. This is here rather
    // than in the constructor because it shells out to `ps` and `lsof`, and the
    // constructor runs on the message thread while the host instantiates the
    // plugin. Runs once per process.
    reapOrphanServers();

    if (shouldCancel && shouldCancel())
        return false;

    const juce::ScopedLock sl (startLock);

    // Re-resolve 'auto' now, against however much memory is free at this moment
    // rather than at plugin-load time.
    refreshResolvedModel();

    const auto c = getConfig();

    // Adopt an existing server before starting one of our own. Loading a second
    // copy of the model would cost another ~1 GB of RAM on an 8 GB machine.
    for (const auto port : c.reusePorts)
    {
        if (shouldCancel && shouldCancel())
            return false;

        if (probeHealth (port))
        {
            const auto listener = SystemProbe::listeningProcessId (port);
            const auto ours = (child != nullptr && child->isRunning() && port == c.port)
                           || (listener > 0 && listener == ownedServerPid.load());

            if (! ours
                && (listener <= 0
                    || ! SystemProbe::looksLikeMuScriptorServer (
                           SystemProbe::processCommandLine (listener))))
                continue;

            // Adopted the strict way - lsof and ps agreed - so this server is a
            // full citizen: audio may go to it and stopIfAllowed() may end it.
            handshakeIdentifiedOnly = false;
            activePort = port;
            adopted = ! ours;
            state = State::ready;
            identifyServerOnPort (port, ours);

            report (ours
                    ? juce::String ("Transcription server ready")
                    : "Using the transcription server already running on port " + juce::String (port));
            return true;
        }
    }

    adopted = false;
    state = State::starting;
    report ("Starting the transcription server...");

    if (child == nullptr || ! child->isRunning())
    {
        juce::String error;

        if (! spawn (error))
        {
            setError (error);
            state = State::failed;
            report ("Could not start the transcription server");
            return false;
        }
    }

    /*  THE THING THAT WAS MISSING FROM EVERY EXIT BELOW.

        A startup that is cancelled or times out used to just `return false`,
        leaving a Python process loading a ~1 GB model with no handle anywhere
        that would ever end it. It was not even reachable: `stopAfterJob()`
        refuses unless the server got to `ready`, and this one by definition did
        not, so the only thing that eventually cleaned it up was the user
        noticing their machine was slow.

        Nothing here is optional or conditional. If we spawned it and it is not
        going to become our server, it dies now. */
    const auto abandonChild = [this]
    {
        // `startLock` is already held by this function, and juce::CriticalSection
        // is recursive, so there is deliberately no second lock here.
        if (child != nullptr)
        {
            // Whatever it managed to say before we gave up on it. Harvested
            // BEFORE the kill, because the kill takes the supervisor - and its
            // captured output - with it.
            startupLog = child->getOutput();
            child->kill();          // kills, joins the drain thread, reaps
            child.reset();
        }
    };

    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) c.startupTimeoutMs;
    int ticks = 0;

    while (juce::Time::getMillisecondCounter() < deadline)
    {
        if (shouldCancel && shouldCancel())
        {
            abandonChild();
            // `starting` was the other half of the leak: a state nothing cleans
            // up after. Say what actually happened.
            state = State::stopped;
            report ("Cancelled starting the transcription server");
            return false;
        }

        if (child != nullptr && ! child->isRunning())
        {
            // The drain thread has been reading this all along, so the output is
            // already here - there is no read-it-now, which is what the old
            // `readAllProcessOutput()` was, and which could only ever return the
            // last pipe-buffer's worth of a child that died with a full pipe.
            startupLog = child->getOutput();
            setError ("the server exited while starting. Output:\n" + startupLog.substring (0, 2000));
            child.reset();          // reaped by the supervisor's destructor
            state = State::failed;
            report ("The transcription server quit unexpectedly");
            return false;
        }

        if (probeHealth (c.port))
        {
            handshakeIdentifiedOnly = false;   // we started it; nothing to identify
            activePort = c.port;
            adopted = false;
            state = State::ready;

            // Write the pid down NOW, while we are certain it is ours. This is
            // the whole orphan fix: if this process is force-quit, the next run
            // finds this record and can either take the server over or, if it
            // has wedged, close it. juce::ChildProcess does not expose its own
            // pid, so ask the OS who is listening - and every consumer of the
            // registry re-checks the command line before touching anything.
            if (const auto pid = SystemProbe::listeningProcessId (c.port); pid > 0)
            {
                ownedServerPid = pid;
                ServerRegistry::record (pid, c.port, c.model);
            }

            identifyServerOnPort (c.port, true);
            report ("Transcription server ready");
            return true;
        }

        juce::Thread::sleep (500);

        if (++ticks % 8 == 0)
            report ("Loading the " + c.model + " model... (" + juce::String (ticks / 2) + "s)");
    }

    // Timed out. The child is still in there loading, and it is not going to
    // become our server - so it goes, for the same reason the cancel path above
    // kills it. Leaving it was how a failed start cost a gigabyte until reboot.
    const auto tail = child != nullptr ? child->getOutput() : startupLog;
    abandonChild();

    setError ("timed out after " + juce::String (c.startupTimeoutMs / 1000) + "s waiting for port "
              + juce::String (c.port)
              + (tail.isNotEmpty() ? ". The server's last output was:\n" + tail.substring (juce::jmax (0, tail.length() - 2000))
                                   : juce::String()));
    state = State::failed;
    report ("The transcription server took too long to start");
    return false;
}

juce::StringArray MuScriptorServer::getInstruments()
{
    {
        const juce::ScopedLock sl (instrumentsLock);

        if (! cachedInstruments.isEmpty())
            return cachedInstruments;
    }

    juce::String error;
    const auto response = httpGetJson (activePort.load() > 0 ? activePort.load() : getConfig().port,
                                       "/instruments", 3000, error);

    juce::StringArray result;

    if (auto* obj = asObject (response))
        if (const auto* array = obj->getProperty ("instruments").getArray())
            for (const auto& item : *array)
                result.add (item.toString());

    const juce::ScopedLock sl (instrumentsLock);
    cachedInstruments = result;
    return result;
}

//==============================================================================
juce::var MuScriptorServer::transcribe (const juce::File& audioFile,
                                        const TranscribeOptions& options,
                                        TranscribeCallbacks callbacks,
                                        juce::String& error)
{
    if (! audioFile.existsAsFile())
    {
        error = "audio file not found: " + audioFile.getFullPathName();
        return {};
    }

    // THE UPLOAD RULE IS UNCHANGED BY THE HANDSHAKE PROBE. `ready` on its own no
    // longer means "identified well enough to be sent a user's recording": since
    // refreshStatus() can also reach ready on the strength of an HTTP handshake,
    // a server that got there that way is pushed through ensureRunning(), whose
    // test is still the pid and its command line. It will either adopt the
    // server on the old, stricter evidence or start one of its own - which is
    // exactly what happened before this state existed.
    if ((state.load() != State::ready || handshakeIdentifiedOnly.load()) && ! ensureRunning())
    {
        error = getLastError();
        return {};
    }

    juce::URL url (getBaseUrl() + "/transcribe");
    url = url.withFileToUpload ("file", audioFile, WebResources::mimeForPath (audioFile.getFileName()));

    // Repeated form field, one per instrument - what FastAPI expects for a
    // List[str] parameter.
    for (const auto& instrument : options.instruments)
        url = url.withParameter ("instruments", instrument);

    url = url.withParameter ("detect_tempo", options.detectTempo);

    juce::String headers = "Accept: text/event-stream";

    if (options.clientId.isNotEmpty())
        headers += "\r\nX-Client-Id: " + options.clientId;

    int statusCode = 0;
    auto streamOptions = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                             .withConnectionTimeoutMs (120000)
                             .withExtraHeaders (headers)
                             .withStatusCode (&statusCode);

    std::unique_ptr<juce::InputStream> stream (url.createInputStream (streamOptions));

    if (stream == nullptr)
    {
        error = "no response from " + url.toString (false);
        return {};
    }

    if (statusCode == 503)
    {
        // The last line of defence. Riffsheet queues its own jobs machine-wide
        // (see EngineLock), so reaching this means something OUTSIDE Riffsheet
        // is using the server - the user's own START-MEDIUM.command window, or
        // MuScriptor's own web page. That is allowed, and saying so is more use
        // than "busy".
        error = adopted.load()
              ? "The transcription server on port " + juce::String (activePort.load())
                + " is busy with a job that did not come from Riffsheet. It can only do one at a "
                  "time - try again in a moment."
              : juce::String ("The transcription server is busy with another job. "
                              "It can only do one at a time - try again in a moment.");
        return {};
    }

    if (statusCode >= 400)
    {
        error = "HTTP " + juce::String (statusCode) + ": "
              + stream->readEntireStreamAsString().substring (0, 800);
        return {};
    }

    // ---- SSE assembly -------------------------------------------------------
    // `start` frames mint a note and carry pitch/instrument; `end` frames carry
    // only a back-reference index, so keep the open notes by index.
    struct OpenNote { int pitch; double start; juce::String instrument; int index; double end; bool closed; };
    std::map<int, OpenNote> notesByIndex;
    std::vector<int> orderedIndices;

    juce::var beatGrid;
    juce::String midiBase64;
    double onsetDelay = 0.0;
    bool sawComplete = false;
    bool cancelled = false;

    while (! stream->isExhausted())
    {
        if (callbacks.shouldCancel != nullptr && callbacks.shouldCancel())
        {
            cancelled = true;
            break;
        }

        const auto line = stream->readNextLine();

        if (! line.startsWith ("data:"))
            continue;

        const auto frame = juce::JSON::parse (line.fromFirstOccurrenceOf ("data:", false, false).trim());
        auto* obj = asObject (frame);

        if (obj == nullptr)
            continue;

        const auto type = obj->getProperty ("type").toString();

        if (type == "progress")
        {
            if (callbacks.onProgress != nullptr)
                callbacks.onProgress ((int) obj->getProperty ("completed"),
                                      (int) obj->getProperty ("total"));
        }
        else if (type == "start")
        {
            const auto index = (int) obj->getProperty ("index");
            notesByIndex[index] = OpenNote { (int) obj->getProperty ("pitch"),
                                             (double) obj->getProperty ("start_time"),
                                             obj->getProperty ("instrument").toString(),
                                             index,
                                             0.0,
                                             false };
            orderedIndices.push_back (index);
        }
        else if (type == "end")
        {
            const auto index = (int) obj->getProperty ("start_event_index");
            const auto it = notesByIndex.find (index);

            if (it != notesByIndex.end())
            {
                it->second.end = (double) obj->getProperty ("end_time");
                it->second.closed = true;
            }
        }
        else if (type == "transcription_complete")
        {
            midiBase64 = obj->getProperty ("data").toString();
            beatGrid = obj->getProperty ("beat_grid");
            sawComplete = true;

            if (auto* gridObj = asObject (beatGrid))
                onsetDelay = (double) gridObj->getProperty ("onset_delay");
        }
        else if (type == "error")
        {
            error = obj->getProperty ("message").toString();

            if (error.isEmpty())
                error = "the server reported an error during transcription";

            return {};
        }
    }

    if (cancelled)
    {
        error = "cancelled";
        return {};
    }

    if (! sawComplete && notesByIndex.empty())
    {
        error = "the server closed the stream without producing anything";
        return {};
    }

    // ---- build the result ---------------------------------------------------
    juce::Array<juce::var> notes;

    for (const auto index : orderedIndices)
    {
        const auto it = notesByIndex.find (index);

        if (it == notesByIndex.end())
            continue;

        const auto& note = it->second;

        auto* noteObj = new juce::DynamicObject();
        noteObj->setProperty ("pitch", note.pitch);
        // The raw stream runs `onset_delay` seconds late against the beat grid.
        noteObj->setProperty ("start", juce::jmax (0.0, note.start - onsetDelay));
        noteObj->setProperty ("end", juce::jmax (0.0, (note.closed ? note.end : note.start) - onsetDelay));
        noteObj->setProperty ("instrument", note.instrument);
        noteObj->setProperty ("index", note.index);
        notes.add (juce::var (noteObj));
    }

    auto* result = new juce::DynamicObject();
    result->setProperty ("notes", notes);
    result->setProperty ("onsetDelay", onsetDelay);
    result->setProperty ("midiBase64", midiBase64);
    result->setProperty ("truncated", ! sawComplete);

    if (auto* gridObj = asObject (beatGrid))
    {
        auto* grid = new juce::DynamicObject();
        grid->setProperty ("bpm", gridObj->getProperty ("bpm"));
        grid->setProperty ("beatsPerBar", gridObj->getProperty ("beats_per_bar"));
        grid->setProperty ("firstDownbeat", gridObj->getProperty ("first_downbeat"));
        grid->setProperty ("onsetDelay", gridObj->getProperty ("onset_delay"));
        result->setProperty ("beatGrid", juce::var (grid));
    }
    else
    {
        // Explicit null: the server could not find a stable tempo, and the UI
        // must not silently pretend it did.
        result->setProperty ("beatGrid", juce::var());
    }

    return juce::var (result);
}

void MuScriptorServer::stop()
{
    const juce::ScopedLock sl (startLock);

    if (child != nullptr)
    {
        // One call, and it is unconditional. The `isRunning()` guard that used
        // to wrap this was the reason a child in any state but "running right
        // now" - one exiting, one that had just been killed, one that never got
        // past its imports - could be dropped without ever being reaped, and the
        // supervisor's drain thread would then be joined by its destructor
        // against a pipe nobody was going to close.
        child->kill();
        child.reset();
    }

    // A server we took over from a force-quit has no ChildProcess handle - we
    // only know its pid. Kill it the long way round, but only after re-checking
    // that the pid still belongs to a MuScriptor server, because pids get
    // recycled and killing a stranger is unforgivable.
    if (const auto pid = ownedServerPid.exchange (0); pid > 0)
    {
        if (SystemProbe::isProcessAlive (pid)
            && SystemProbe::looksLikeMuScriptorServer (SystemProbe::processCommandLine (pid)))
            SystemProbe::terminateProcess (pid);

        ServerRegistry::forget (pid);
    }

    activePort = 0;
    adopted = false;
    state = State::stopped;
    clearServerFacts();

    const juce::ScopedLock ml (modelLock);
    runningModelDescription = {};
    runningModelSource = "nothing is running yet";
    runningModelSize = {};
}

//==============================================================================
// The post-job shutdown. See the block comment in the header for the two rules
// this is not allowed to break.

MuScriptorServer::IdleState MuScriptorServer::getIdleState() const
{
    IdleState result;
    result.port = activePort.load();
    result.memoryMb = serverMemoryMb.load();
    result.running = result.port > 0 && state.load() == State::ready;

    const auto engine = EngineLock::getInstance().snapshot();

    // A waiter counts as busy. Somebody queued is a transcription that has not
    // started yet, and closing the server in front of it would turn their wait
    // into a model load.
    result.busy = engine.busy || engine.queueLength > 0;

    if (! result.busy)
    {
        const auto since = idleSinceMs();

        if (since > 0.0)
            result.idleSeconds = juce::jmax (0.0, (SystemProbe::nowMs() - since) / 1000.0);
    }

    if (! result.running)
    {
        result.reason = "There is no transcription server running, so there is nothing to stop.";
        return result;
    }

    result.ours = weStartedTheServer();

    if (! result.ours)
    {
        result.external = true;

        // The ordinary stop still refuses it, and that is still the right
        // default. What changed is that the refusal is no longer a dead end:
        // when the two cheap halves of the identity test hold and nothing on
        // this machine is using it, a human may ask for it anyway.
        result.canStopExternal = ! result.busy
                              && serverPid.load() > 0
                              && serverLooksLikeMuScriptor.load();

        result.reason = "The transcription server on port " + juce::String (result.port)
                      + " was started outside Riffsheet, so it belongs to whoever launched it - "
                        "usually the START-MEDIUM.command window. Riffsheet will not stop it on "
                        "its own."
                      + (result.canStopExternal
                             ? juce::String (" Close that window, or ask Riffsheet to stop it anyway.")
                             : juce::String (" Close that window yourself if you want the memory "
                                             "back."));
        return result;
    }

    if (result.busy)
    {
        result.reason = engine.busy
            ? (engine.heldByThisProcess
                   ? juce::String ("A transcription is running right now, so the server stays up until "
                                   "it has finished.")
                   : "Something else on this machine is transcribing right now (" + engine.holderLabel
                     + "), so the server stays up until it has finished.")
            : juce::String ("Another transcription is waiting to start, so the server stays up until "
                            "the last one has finished with it.");

        return result;
    }

    result.canStop = true;
    return result;
}

bool MuScriptorServer::killIdentifiedServer (int pid)
{
    if (pid <= 0 || ! SystemProbe::isProcessAlive (pid))
        return false;

    // Two independent proofs, both required. Either alone can be wrong - a
    // record can be stale, a pid can have been recycled - and the price of
    // being wrong here is ending somebody else's program.
    if (! ServerRegistry::findByPid (pid).has_value())
        return false;

    if (! SystemProbe::looksLikeMuScriptorServer (SystemProbe::processCommandLine (pid)))
        return false;

    const auto gone = SystemProbe::terminateProcess (pid);
    ServerRegistry::forget (pid);
    return gone;
}

MuScriptorServer::StopOutcome MuScriptorServer::stopIfAllowed (const juce::String& trigger)
{
    StopOutcome outcome;

    // Fresh facts rather than the cache. This is one of the two calls in the
    // shell that end a process - stopExternalServer() below is the other - so it
    // re-probes instead of trusting a reading that could be three seconds old.
    refreshStatus();

    const auto idle = getIdleState();

    if (! idle.running || ! idle.ours || idle.busy)
    {
        outcome.reason = idle.reason;
        return outcome;
    }

    // Everything above was a photograph. THIS is what makes the decision safe:
    // holding the machine-wide engine means no transcription anywhere can start
    // underneath the kill. If it cannot be had this instant somebody just took
    // it, and the answer to that is to leave the server alone - they will stop
    // it themselves when they are done with it.
    auto& engine = EngineLock::getInstance();

    if (! engine.tryAcquireNow ("Riffsheet - closing the transcription server"))
    {
        outcome.reason = "Something on this machine started using the transcription server just now, "
                         "so it has been left alone.";
        return outcome;
    }

    // release(false): housekeeping is not a job, and must not push the
    // machine-wide "last transcription finished" stamp forward.
    struct ReleaseOnExit
    {
        ~ReleaseOnExit() { EngineLock::getInstance().release (false); }
    } releaseGuard;

    const auto port = idle.port;
    const auto pid = serverPid.load();
    const auto freedMb = idle.memoryMb;

    // Ours in this object: a child we spawned, or an orphan we took over.
    stop();

    // Ours as an application, but started by another Riffsheet window: stop()
    // has never heard of it, so end it by pid - re-proving ownership first.
    killIdentifiedServer (pid);

    outcome.stopped = true;
    outcome.port = port;
    outcome.pid = pid;
    outcome.freedMb = freedMb;
    outcome.reason = freedMb > 0
        ? "Closed the transcription server on port " + juce::String (port) + " and gave back "
          + juce::String (freedMb) + " MB."
        : "Closed the transcription server on port " + juce::String (port)
          + " and gave the memory back.";

    juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + outcome.reason + " (" + trigger + ")");
    return outcome;
}

MuScriptorServer::StopOutcome MuScriptorServer::stopAfterJob()
{
    StopOutcome outcome;

    // ---- THE CHILD THAT NEVER GOT TO `ready` -------------------------------
    //
    // Checked before anything else, because the guard below used to send it
    // straight out of the door. `weStartedTheServer()` is a statement about a
    // PID, and the pid is only written down once /health has answered; a child
    // that is still importing torch, or that has wedged, or whose startup was
    // cancelled a moment ago, has no pid recorded and is not in state `ready`.
    // It therefore failed both halves of the test and cleanup replied "Riffsheet
    // did not start the transcription server" about a process Riffsheet had, at
    // that moment, running - which is how a gigabyte of half-loaded model
    // survived every shutdown path in the application.
    //
    // We hold the handle. That is the only ownership proof needed, and it is a
    // better one than the pid: there is no possibility of a recycled pid or a
    // stranger's process at the other end of a ChildProcess we spawned.
    if (haveLiveChild() && state.load() != State::ready)
    {
        // No EngineLock dance and no idle test: an unfinished startup is not
        // serving anybody, so there is nobody to be polite to. stop() kills,
        // joins the drain thread, reaps, and clears the bookkeeping.
        stop();

        outcome.stopped = true;
        outcome.reason = "Closed the transcription server that was still starting up when the job ended.";
        juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + outcome.reason);
        return outcome;
    }

    // Cheap first, and this is the path most windows take: one that adopted the
    // user's own server, or never had one, must not pay for two health probes on
    // the way out of every job - and an adopted server is not ours to end, only
    // to stop talking to.
    if (! weStartedTheServer() || state.load() != State::ready)
    {
        outcome.reason = "Riffsheet did not start the transcription server, so there is nothing to stop.";
        return outcome;
    }

    outcome = stopIfAllowed ("immediately after the transcription finished");

    // One line either way, so Console.app tells the whole story: the server went
    // down the instant the job ended, or it stayed up and this says who for.
    if (! outcome.stopped)
        juce::Logger::writeToLog ("Riffsheet/MuScriptor: transcription finished; engine left running - "
                                  + outcome.reason);

    return outcome;
}

//==============================================================================
// "Stop it anyway." See the header for the four proofs and why this is the only
// function in the shell allowed to end a process Riffsheet did not start.

MuScriptorServer::StopOutcome MuScriptorServer::stopExternalServer (const juce::String& trigger)
{
    StopOutcome outcome;

    // Fresh facts. Same reason stopIfAllowed() re-probes: a reading three
    // seconds old is fine for drawing a chip and not fine for ending a process.
    refreshStatus();

    const auto idle = getIdleState();
    outcome.port = idle.port;

    if (! idle.running)
    {
        outcome.reason = idle.reason;
        return outcome;
    }

    if (idle.ours)
    {
        // Not this function's business, and saying so beats quietly doing the
        // other thing: the ordinary path releases our own bookkeeping too.
        outcome.reason = "Riffsheet started the transcription server on port "
                       + juce::String (idle.port)
                       + " itself, so the ordinary Stop is what ends it.";
        return outcome;
    }

    if (idle.busy)
    {
        // The one refusal a human cannot override. An external server is
        // precisely the kind another Riffsheet window borrowed and is mid-job
        // against, and their transcription is not ours to throw away either.
        const auto holder = EngineLock::getInstance().snapshot().holderLabel;

        outcome.reason = "Something on this machine is transcribing through that server right now"
                       + (holder.isNotEmpty() ? " (" + holder + ")" : juce::String())
                       + ", so it has been left alone. Try again when it has finished.";
        return outcome;
    }

    // Take the machine-wide turn BEFORE proving anything. Everything below is a
    // fact about a moment, and holding the engine is what stops that moment
    // from ending between the proof and the kill.
    auto& engine = EngineLock::getInstance();

    if (! engine.tryAcquireNow ("Riffsheet - stopping an external transcription server"))
    {
        outcome.reason = "Something on this machine started using the transcription server just now, "
                         "so it has been left alone.";
        return outcome;
    }

    // release(false): this is housekeeping, not a job, and must not push the
    // machine-wide "last transcription finished" stamp forward.
    struct ReleaseOnExit
    {
        ~ReleaseOnExit() { EngineLock::getInstance().release (false); }
    } releaseGuard;

    const auto port = idle.port;

    //-- proof 1: who is actually listening there, right now -------------------
    const auto pid = SystemProbe::listeningProcessId (port);

    if (pid <= 0)
    {
        outcome.reason = "Riffsheet could not work out which process is listening on port "
                       + juce::String (port) + ", so it has not touched anything. (On Windows it "
                                               "cannot, and this button does nothing there by "
                                               "design.)";
        return outcome;
    }

    //-- proof 2: it is not one of ours after all ------------------------------
    if (ServerRegistry::findByPid (pid).has_value())
    {
        outcome.reason = "The server on port " + juce::String (port) + " turns out to be one "
                         "Riffsheet started after all, so the ordinary Stop is what ends it.";
        return outcome;
    }

    //-- proof 3: the process's own command line says what it is ---------------
    if (! SystemProbe::looksLikeMuScriptorServer (SystemProbe::processCommandLine (pid)))
    {
        outcome.reason = "The process listening on port " + juce::String (port) + " does not say "
                         "it is a MuScriptor server, so Riffsheet has left it completely alone.";
        return outcome;
    }

    //-- proof 4: and it is answering as one ----------------------------------
    if (! probeHealth (port))
    {
        outcome.reason = "Nothing is answering on port " + juce::String (port) + " any more, so "
                         "there was nothing left to stop.";
        return outcome;
    }

    //-- all four hold. SIGTERM, wait, SIGKILL ---------------------------------
    // A longer grace than the reaper's 2 s: that one is for a server already
    // established to be wedged, this one is for a healthy process somebody else
    // owns, and a clean exit is worth waiting for.
    // Read the resident size BEFORE the kill - it is unreadable a moment later -
    // but only report it if the kill actually worked. `pid` and `freedMb` mean
    // "what was ended and what that gave back", so a process that is still
    // running must not be described as having freed anything.
    const auto residentMb = SystemProbe::processResidentMemoryMb (pid);

    // THE PORT, NOT ONLY THE PID, DECIDES WHETHER THIS WORKED.
    //
    // terminateProcess() answers "does a process with this id still exist",
    // and a process can exist while being unambiguously stopped: a killed child
    // whose parent has not reaped it yet is a zombie, and `kill(pid, 0)`
    // succeeds on a zombie for as long as the entry is around. It holds no
    // memory, answers nothing and has released its socket, so reporting "it
    // would not stop, it may belong to another user" about one would be a plain
    // lie - and that message is what a user would act on.
    //
    // The port is the honest test, and it is also the strictly stronger one for
    // the case the message is really about: a process we genuinely may not
    // signal (EPERM, another user's) is still listening afterwards, so this
    // still reports the failure it exists to report.
    const auto ended = SystemProbe::terminateProcess (pid, 5000)
                    || SystemProbe::listeningProcessId (port) <= 0;

    if (! ended)
    {
        outcome.reason = "The server on port " + juce::String (port) + " did not stop, even after "
                         "being asked and then forced. It may belong to another user.";
        juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + outcome.reason + " (" + trigger + ")");
        return outcome;
    }

    outcome.pid = pid;
    outcome.freedMb = residentMb;

    // We were only ever borrowing it, so there is no ownership to release -
    // just this object's cached belief that there is a server on the wire.
    activePort = 0;
    adopted = false;
    state = State::stopped;
    clearServerFacts();

    {
        const juce::ScopedLock ml (modelLock);
        runningModelDescription = {};
        runningModelSource = "nothing is running yet";
        runningModelSize = {};
    }

    outcome.stopped = true;
    outcome.reason = outcome.freedMb > 0
        ? "Stopped the transcription server on port " + juce::String (port)
          + " that Riffsheet did not start, and gave back " + juce::String (outcome.freedMb) + " MB."
        : "Stopped the transcription server on port " + juce::String (port)
          + " that Riffsheet did not start.";

    juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + outcome.reason + " (" + trigger + ")");
    return outcome;
}
