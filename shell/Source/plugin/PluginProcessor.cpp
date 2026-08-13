#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "PlaybackResampler.h"
#include "engines/ClientEngineAdapter.h"
#include "engines/EngineCatalog.h"
#include "engines/MuScriptorAdapter.h"
#include "engines/sidecar/SidecarAdapter.h"

#if RIFFSHEET_HAS_ONNX
 #include "engines/basicpitch/BasicPitchAdapter.h"
#endif

RiffsheetAudioProcessor::RiffsheetAudioProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    // Engine #0, and the one `auto` reaches first: Riffsheet's own transcriber.
    // It does not run in this process - it is TypeScript in the web view, where
    // the samples already are - so all the shell holds is a row and an adapter
    // that reports "always ready" and refuses to be driven. Registered from the
    // table rather than by name, exactly as the sidecars below are, so a second
    // in-page engine would need no line here either.
    for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
        if (EngineCatalog::runsInPage (*row))
            engines.add (std::make_unique<ClientEngineAdapter> (*row));

    // Engine #1: the MuScriptor server behind the common adapter door. It wraps
    // `muScriptor` by reference and owns nothing, so registering it costs one
    // allocation and changes no behaviour.
    engines.add (std::make_unique<MuScriptorAdapter> (muScriptor));

   #if RIFFSHEET_HAS_ONNX
    // Engine #2: Basic Pitch, compiled in. Registering it is what makes a
    // machine with no Python, no venv and no MuScriptor able to transcribe, so
    // it is registered unconditionally - it has nothing to discover and no way
    // to be absent. A build configured -DRIFFSHEET_WITHOUT_BASIC_PITCH=ON has no
    // inference runtime at all and says so loudly at configure time; there,
    // `auto` falls back to a fallback that is not present, and EngineRegistry
    // reports that honestly rather than pretending.
    engines.add (std::make_unique<BasicPitchAdapter>());
   #endif

    // Engines #3 and #4: the one-click subprocess engines, from the table rather
    // than by name. SidecarAdapter is manifest-driven, so adding a one-click
    // engine is a row in EngineCatalog and a script in Resources/engines - never
    // a line here. They register whether or not they are installed: an adapter
    // that reports `not-installed` is what makes the card say so and what makes
    // installEngine() have something to rediscover afterwards.
    for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
        if (row->adapter == AdapterKind::sidecarVenv || row->adapter == AdapterKind::sidecarPipCli)
            engines.add (std::make_unique<SidecarAdapter> (*row));
}

RiffsheetAudioProcessor::~RiffsheetAudioProcessor()
{
    cancelPendingUpdate();
}

void RiffsheetAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused (samplesPerBlock);
    currentSampleRate = sampleRate;
    smoothedGain.reset (sampleRate, 0.02);
    smoothedGain.setCurrentAndTargetValue (playbackGain.load());
    capture.prepare (sampleRate);
}

void RiffsheetAudioProcessor::releaseResources()
{
}

bool RiffsheetAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();

    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;

    // Allow a disabled input bus (some hosts instantiate effects with none).
    const auto& in = layouts.getMainInputChannelSet();
    return in == out || in.isDisabled();
}

void RiffsheetAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const auto numSamples = buffer.getNumSamples();
    const auto numOutChannels = getTotalNumOutputChannels();

    for (int ch = getTotalNumInputChannels(); ch < numOutChannels; ++ch)
        buffer.clear (ch, 0, numSamples);

    // ---- host playhead snapshot (this is the free DAW tempo sync) -----------
    juce::Optional<juce::AudioPlayHead::PositionInfo> position;

    if (auto* playHead = getPlayHead())
    {
        position = playHead->getPosition();

        if (position.hasValue())
        {
            // Copied field for field, with a flag per field. NOTHING is
            // defaulted here - see the HostInfo comment. Plain scalar stores, no
            // allocation, no branching worth counting.
            HostInfo info;
            info.hasPosition = true;
            info.isPlaying   = position->getIsPlaying();
            info.isRecording = position->getIsRecording();
            info.isLooping   = position->getIsLooping();

            if (const auto bpm = position->getBpm())
            {
                info.hasTempo = true;
                info.bpm = *bpm;
            }

            if (const auto sig = position->getTimeSignature())
            {
                info.hasTimeSig = true;
                info.timeSigNumerator = sig->numerator;
                info.timeSigDenominator = sig->denominator;
            }

            if (const auto ppq = position->getPpqPosition())
            {
                info.hasPpq = true;
                info.ppqPosition = *ppq;
            }

            if (const auto barStart = position->getPpqPositionOfLastBarStart())
            {
                info.hasPpqOfLastBarStart = true;
                info.ppqOfLastBarStart = *barStart;
            }

            if (const auto seconds = position->getTimeInSeconds())
            {
                info.hasTimeInSeconds = true;
                info.timeInSeconds = *seconds;
            }

            if (const auto samples = position->getTimeInSamples())
            {
                info.hasTimeInSamples = true;
                info.timeInSamples = *samples;
            }

            if (const auto bars = position->getBarCount())
            {
                info.hasBarCount = true;
                info.barCount = *bars;
            }

            if (const auto origin = position->getEditOriginTime())
            {
                info.hasEditOrigin = true;
                info.editOriginTime = *origin;
            }

            if (const auto loop = position->getLoopPoints())
            {
                info.hasLoopPoints = true;
                info.loopStartPpq = loop->ppqStart;
                info.loopEndPpq = loop->ppqEnd;
            }

            if (const auto frame = position->getFrameRate())
            {
                info.hasFrameRate = true;
                info.frameRate = frame->getBaseRate();
            }

            // tryEnter: never block the audio thread waiting on the UI.
            if (hostInfoLock.tryEnter())
            {
                lastHostInfo = info;
                hostInfoLock.exit();
            }
        }
    }

    // ---- track capture ------------------------------------------------------
    // Fed the INPUT audio, before anything this plugin adds, and before the
    // gain smoothing below can touch it.
    capture.processBlock (buffer, numSamples, position);

    // ---- original-file playback, mixed on top of the passthrough ------------
    if (! playing.load())
    {
        smoothedGain.setCurrentAndTargetValue (playbackGain.load());
        return;
    }

    const juce::ScopedTryLock stl (playbackLock);

    // Counted, not silent. A run of these is exactly what "playback stalls after
    // a couple of seconds" looks like from the audio thread, and without a
    // counter there is no way to tell it apart from a web-side clock fault.
    // Read them back with playbackDiagnostics() - see BRIDGE.md section 2.
    if (! stl.isLocked())
    {
        blocksSkippedLocked.fetch_add (1, std::memory_order_relaxed);
        return;
    }

    if (playbackSamples == nullptr || playbackNumSamples == 0)
    {
        blocksSkippedEmpty.fetch_add (1, std::memory_order_relaxed);
        return;
    }

    blocksRendered.fetch_add (1, std::memory_order_relaxed);
    smoothedGain.setTargetValue (playbackGain.load());

    // The shared, immutable PcmStore entry - not a copy of it. `loadedEntry`
    // holds it alive and is only ever swapped under this same lock, so these two
    // plain reads are valid for the whole block. No refcount is touched here.
    const auto total = playbackNumSamples;
    const auto* src = playbackSamples;

    // The file's rate rarely matches the host's, so step through it with a
    // fractional read index and interpolate linearly. THE PHASE IS FRACTIONAL
    // AND STAYS FRACTIONAL: it used to be rounded down to a whole source frame
    // at the end of every block, which threw away up to one frame per block and
    // made playback speed depend on the host's buffer size (1.36% slow at 64
    // frames, 0.085% at 512). See PlaybackResampler.h for the arithmetic and
    // PlaybackResamplerTests for minutes of it at every common rate.
    const auto step = riffsheet::playback::stepFor (playbackBufferRate, currentSampleRate);

    const auto rendered = riffsheet::playback::render (
        src, total, playbackPositionFrames, step, numSamples,
        [this, &buffer, numOutChannels] (int i, float sample)
        {
            const auto g = smoothedGain.getNextValue();

            for (int ch = 0; ch < numOutChannels; ++ch)
                buffer.addSample (ch, i, sample * g);
        });

    playbackPositionFrames = rendered.position;

    if (rendered.hitEnd)
    {
        // Reached the end of the file.
        playing = false;
        playbackPositionFrames = (double) total;
    }
}

//==============================================================================
void RiffsheetAudioProcessor::updateTransportSourceFor (std::shared_ptr<const PcmStore::Entry> entry)
{
    // NOTHING IS COPIED. This used to makeCopyOf() the entry's whole buffer into
    // a second AudioBuffer that only the transport could see, so a ten-minute
    // take cost ~212 MB natively instead of ~106. The entry is already const and
    // already shared; the transport now just holds it and plays it.
    //
    // (The copy was originally staged outside the lock because doing it inside
    // starved the audio thread for the length of the memcpy. That reasoning has
    // not gone away - it has moved to the RELEASE below.)
    //
    // Whatever we displace is destroyed AFTER the lock is dropped. Releasing the
    // last reference to a take is a ~100 MB free plus, for a capture, deleting
    // its temp WAV; doing that under playbackLock would fail every
    // processBlock's try-lock for the duration, which is the same audible
    // dropout in a different disguise.
    std::shared_ptr<const PcmStore::Entry> displaced;

    {
        const juce::ScopedLock sl (playbackLock);

        displaced = std::move (loadedEntry);
        loadedEntry = std::move (entry);

        const auto hasAudio = loadedEntry != nullptr && loadedEntry->mono.getNumSamples() > 0;

        playbackSamples         = hasAudio ? loadedEntry->mono.getReadPointer (0) : nullptr;
        playbackNumSamples      = hasAudio ? (int64_t) loadedEntry->mono.getNumSamples() : 0;
        playbackBufferRate      = hasAudio ? loadedEntry->sampleRate : 0.0;
        playbackPositionFrames  = 0.0;
    }

    // `displaced` dies here, on the caller's thread, outside the lock.
}

RiffsheetAudioProcessor::PlaybackDiagnostics RiffsheetAudioProcessor::getPlaybackDiagnostics() const
{
    PlaybackDiagnostics d;
    d.blocksRendered      = blocksRendered.load (std::memory_order_relaxed);
    d.blocksSkippedLocked = blocksSkippedLocked.load (std::memory_order_relaxed);
    d.blocksSkippedEmpty  = blocksSkippedEmpty.load (std::memory_order_relaxed);
    d.sampleRate          = currentSampleRate;
    return d;
}

bool RiffsheetAudioProcessor::loadPlaybackToken (const juce::String& token, juce::String& error)
{
    // No token means "nothing is loaded any more" - not an error. Opening a MIDI
    // file over a wav has no new audio to load, and without this the transport
    // would sit there holding the old take's ~100 MB for the life of the
    // instance.
    if (token.isEmpty())
    {
        unloadPlayback();
        return true;
    }

    auto entry = pcmStore.get (token);

    if (entry == nullptr)
    {
        error = "unknown pcm token: " + token;
        return false;
    }

    playing = false;
    updateTransportSourceFor (std::move (entry));
    return true;
}

void RiffsheetAudioProcessor::unloadPlayback()
{
    playing = false;
    updateTransportSourceFor (nullptr);
}

juce::String RiffsheetAudioProcessor::getPlaybackToken() const
{
    const juce::ScopedLock sl (playbackLock);
    return loadedEntry != nullptr ? loadedEntry->token : juce::String();
}

void RiffsheetAudioProcessor::playbackPlay()
{
    const juce::ScopedLock sl (playbackLock);

    if (playbackNumSamples == 0)
        return;

    if (playbackPositionFrames >= (double) playbackNumSamples)
        playbackPositionFrames = 0.0;

    playing = true;
}

void RiffsheetAudioProcessor::playbackPause()
{
    playing = false;
}

void RiffsheetAudioProcessor::playbackStop()
{
    playing = false;
    const juce::ScopedLock sl (playbackLock);
    playbackPositionFrames = 0.0;
}

void RiffsheetAudioProcessor::playbackSeek (double seconds)
{
    const juce::ScopedLock sl (playbackLock);

    if (playbackBufferRate <= 0.0)
        return;

    // Kept fractional: a seek to 1.5 s in a 44.1 kHz file is 66150 frames on the
    // nose, but a seek in a file whose rate is not a whole number of frames per
    // millisecond is not, and rounding it here would put a (tiny, one-off) error
    // back into the one place the phase is now exact.
    const auto target = juce::jmax (0.0, seconds) * playbackBufferRate;
    playbackPositionFrames = juce::jlimit (0.0, (double) playbackNumSamples, target);
}

void RiffsheetAudioProcessor::setPlaybackGain (float linearGain)
{
    playbackGain = juce::jlimit (0.0f, 4.0f, linearGain);
}

RiffsheetAudioProcessor::PlaybackStatus RiffsheetAudioProcessor::getPlaybackStatus() const
{
    PlaybackStatus status;
    status.isPlaying = playing.load();
    status.gain = playbackGain.load();

    const juce::ScopedLock sl (playbackLock);

    if (playbackBufferRate > 0.0 && playbackNumSamples > 0)
    {
        status.loaded = true;
        status.positionSec = playbackPositionFrames / playbackBufferRate;
        status.lengthSec = (double) playbackNumSamples / playbackBufferRate;
    }

    if (loadedEntry != nullptr)
        status.token = loadedEntry->token;

    return status;
}

//==============================================================================
// Who is using which take. See the long comment on PcmHoldResult in the header;
// the short version is that PcmStore holds weak references, a token is a string
// rather than a reference, and these two holds are what turns "the page said
// this token" into "something is genuinely using this take".
//
// Every one of them releases OUTSIDE the lock: dropping the last reference to a
// take frees ~100 MB and may delete a temp WAV, and there is no reason to do
// that while holding a lock.

void RiffsheetAudioProcessor::noteHandedOut (std::shared_ptr<const PcmStore::Entry> entry)
{
    std::shared_ptr<const PcmStore::Entry> displaced;

    {
        const juce::ScopedLock sl (pcmHoldLock);
        displaced = std::move (handedOutEntry);
        handedOutEntry = std::move (entry);
    }
}

RiffsheetAudioProcessor::PcmHoldResult
RiffsheetAudioProcessor::setSessionPcmTokens (const juce::StringArray& tokens)
{
    PcmHoldResult result;

    // Resolved before the lock so an unknown token costs nothing and a lookup
    // never nests the store's lock inside ours.
    std::map<juce::String, std::shared_ptr<const PcmStore::Entry>> wanted;

    for (const auto& token : tokens)
    {
        if (token.isEmpty())
            continue;

        if (auto entry = pcmStore.get (token))
            wanted[token] = std::move (entry);
        else
            result.unknown.addIfNotAlreadyThere (token);
    }

    std::map<juce::String, std::shared_ptr<const PcmStore::Entry>> displaced;
    std::shared_ptr<const PcmStore::Entry> displacedHandoff;

    {
        const juce::ScopedLock sl (pcmHoldLock);

        for (const auto& previous : sessionHolds)
            if (wanted.find (previous.first) == wanted.end())
                result.dropped.addIfNotAlreadyThere (previous.first);

        displaced = std::move (sessionHolds);
        sessionHolds = std::move (wanted);

        // The automatic handoff is only a bridge across the string-only API.
        // Once the page has declared its complete set, that set is authoritative.
        // Install it first so retaining the handed-out token has no lifetime gap;
        // playback/transcription owners are independent and remain untouched.
        displacedHandoff = std::move (handedOutEntry);

        for (const auto& held : sessionHolds)
            result.held.add (held.first);
    }

    // Both displaced owners die here, outside the lock.
    return result;
}

RiffsheetAudioProcessor::PcmHoldResult
RiffsheetAudioProcessor::releaseSessionPcmTokens (const juce::StringArray& tokens)
{
    PcmHoldResult result;
    std::map<juce::String, std::shared_ptr<const PcmStore::Entry>> displaced;

    {
        const juce::ScopedLock sl (pcmHoldLock);

        if (tokens.isEmpty())
        {
            for (const auto& held : sessionHolds)
                result.dropped.add (held.first);

            displaced = std::move (sessionHolds);
            sessionHolds.clear();
        }
        else
        {
            for (const auto& token : tokens)
            {
                const auto it = sessionHolds.find (token);

                if (it == sessionHolds.end())
                    continue;

                result.dropped.addIfNotAlreadyThere (token);
                displaced[token] = std::move (it->second);
                sessionHolds.erase (it);
            }
        }

        for (const auto& held : sessionHolds)
            result.held.add (held.first);
    }

    return result;
}

juce::StringArray RiffsheetAudioProcessor::getSessionPcmTokens() const
{
    juce::StringArray tokens;
    const juce::ScopedLock sl (pcmHoldLock);

    for (const auto& held : sessionHolds)
        tokens.add (held.first);

    return tokens;
}

juce::String RiffsheetAudioProcessor::getHandedOutToken() const
{
    const juce::ScopedLock sl (pcmHoldLock);
    return handedOutEntry != nullptr ? handedOutEntry->token : juce::String();
}

//==============================================================================
bool RiffsheetAudioProcessor::captureStart (bool armToTransport, double maxSeconds, juce::String& error)
{
    if (maxSeconds > 0.0)
        capture.setMaxSeconds (maxSeconds);

    return capture.begin (armToTransport, error);
}

RiffsheetAudioProcessor::CaptureResult RiffsheetAudioProcessor::captureStop()
{
    CaptureResult result;

    capture.end();

    // Snapshot the timeline before takeAudio() so both describe the same take.
    result.context = capture.buildContext();
    result.hitLimit = capture.didHitLimit();

    auto audio = capture.takeAudio();

    if (audio.getNumSamples() <= 0)
    {
        result.error = "nothing was captured - was the transport rolling, "
                       "and does the track actually feed this plugin?";
        capture.reset();
        return result;
    }

    const auto rate = capture.getSampleRate();
    const auto name = "Track capture " + juce::Time::getCurrentTime().toString (false, true, false, true);

    // Raw, untrimmed: webcore and the pipeline need the true offsets to line up
    // with the host timeline, so the shell must not helpfully cut silence off.
    result.entry = pcmStore.storeMono (std::move (audio), rate, name);
    result.ok = result.entry != nullptr;

    if (! result.ok)
        result.error = "could not store the captured audio";

    capture.reset();
    return result;
}

/* persistCapturedTake() USED TO LIVE HERE. It wrote the take to a durable WAV in
   <Application Support>/Riffsheet/takes before the bridge would answer
   captureStop(), which is what turned every recorded take - including the ones
   the player listened to once and threw away - into a file kept for ever. The
   samples now stay in the PcmStore entry captureStop() returns; see
   NativeBridge::fnCaptureStop for what the page is told about that, and
   PcmStore::getOriginalFileBytes for how a capture is still embedded, at full
   depth, when a document is actually saved. */

RiffsheetAudioProcessor::HostInfo RiffsheetAudioProcessor::getHostInfo() const
{
    const juce::ScopedLock sl (hostInfoLock);
    return lastHostInfo;
}

juce::Point<int> RiffsheetAudioProcessor::getEditorSize() const
{
    const juce::ScopedLock sl (editorSizeLock);
    return editorSize;
}

void RiffsheetAudioProcessor::setEditorSize (juce::Point<int> size)
{
    const juce::ScopedLock sl (editorSizeLock);
    editorSize = size;
}

juce::String RiffsheetAudioProcessor::getPersistedWebState() const
{
    const juce::ScopedLock sl (webStateLock);
    return persistedWebState;
}

bool RiffsheetAudioProcessor::setPersistedWebState (const juce::String& json)
{
    // Measured in bytes, not characters: the blob is UTF-8 by the time it reaches
    // the project file, and a length() in characters would under-count.
    if (json.getNumBytesAsUTF8() > (size_t) maxPersistedWebStateBytes)
        return false;

    const juce::ScopedLock sl (webStateLock);
    persistedWebState = json;
    return true;
}

//==============================================================================
juce::AudioProcessorEditor* RiffsheetAudioProcessor::createEditor()
{
    // Counted, and deliberately NOT a reset of hostStateLoadedSinceEditor: a host
    // that loads a project and then opens the window does both in that order, and
    // clearing the fact here would turn the one case that must ask into the case
    // that restores in silence.
    ++editorGeneration;
    return new RiffsheetAudioProcessorEditor (*this);
}

RiffsheetAudioProcessor::RestoreMode RiffsheetAudioProcessor::consumeRestoreMode()
{
    // Consumed unconditionally, including when there is nothing to restore: a
    // host that loaded an EMPTY state has still "loaded state", and leaving that
    // fact set would make the next editor recreation - which is the silent case -
    // ask a question about work the user never lost.
    const auto hostLoaded = hostStateLoadedSinceEditor.exchange (false);

    if (getPersistedWebState().isEmpty())
        return RestoreMode::none;

    return hostLoaded ? RestoreMode::ask : RestoreMode::silent;
}

void RiffsheetAudioProcessor::handleAsyncUpdate()
{
    if (auto* editor = dynamic_cast<RiffsheetAudioProcessorEditor*> (getActiveEditor()))
        editor->processorStateRestored();
}

void RiffsheetAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ValueTree state ("RiffsheetState");
    state.setProperty ("version", RIFFSHEET_VERSION, nullptr);
    state.setProperty ("playbackGain", (double) playbackGain.load(), nullptr);

    const auto size = getEditorSize();
    state.setProperty ("editorWidth", size.x, nullptr);
    state.setProperty ("editorHeight", size.y, nullptr);

    // The web app's own state, opaque to us - the take, the score, the edits and
    // the view settings. Writing it here is what makes a saved project reopen
    // with the sheet still on screen. See setPersistedWebState().
    const auto webState = getPersistedWebState();

    if (webState.isNotEmpty())
        state.setProperty ("webState", webState, nullptr);

    juce::MemoryOutputStream stream (destData, false);
    state.writeToStream (stream);
}

void RiffsheetAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    const auto state = juce::ValueTree::readFromData (data, (size_t) sizeInBytes);

    if (! state.isValid() || ! state.hasType ("RiffsheetState"))
        return;

    setPlaybackGain ((float) (double) state.getProperty ("playbackGain", 1.0));

    const auto width  = (int) state.getProperty ("editorWidth", 0);
    const auto height = (int) state.getProperty ("editorHeight", 0);

    if (width > 0 && height > 0)
        setEditorSize ({ width, height });

    // Absent in a project saved by an older build; the page then simply boots to
    // its drop zone, which is the pre-existing behaviour and not an error.
    const auto restoredWebState = state.getProperty ("webState", juce::String()).toString();

    // An oversized/corrupt host blob must not leave the PREVIOUS page state in
    // this slot; that stale state would be exactly what the refresh saves back.
    if (! setPersistedWebState (restoredWebState))
        setPersistedWebState ({});

    // THE FACT THAT MAKES SILENT RESTORE SAFE. Everything else about this state
    // is indistinguishable from state the page itself parked here a moment ago;
    // this says it arrived from outside - a project, a preset, a duplicated
    // instance, a host undo - and is therefore the one case that asks. Set before
    // the refresh below, so the page that reboots reads it. See RestoreMode.
    hostStateLoadedSinceEditor = true;

    // A host may load a project/preset while the editor remains open. The page
    // currently on screen still contains the previous instance state and would
    // otherwise save it back over the just-restored blob. Reboot that page from
    // the processor's new state on the message thread.
    triggerAsyncUpdate();
}

//==============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new RiffsheetAudioProcessor();
}
