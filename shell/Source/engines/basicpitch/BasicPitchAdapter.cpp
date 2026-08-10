#include "BasicPitchAdapter.h"
#include "BasicPitchFrontend.h"
#include "BasicPitchNotes.h"
#include "EngineCatalog.h"
#include "onnx/ModelLocator.h"
#include "onnx/OrtSession.h"

namespace
{
    const EngineManifest& basicPitchRow()
    {
        // Guaranteed by EngineCatalog.cpp's static_assert: "basic-pitch" is the
        // id `auto` falls back to, and that id is proved to be in the table at
        // compile time.
        const auto* found = EngineCatalog::find ("basic-pitch");
        jassert (found != nullptr);
        return *found;
    }

    juce::var makeObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
    {
        auto* object = new juce::DynamicObject();

        for (const auto& property : properties)
            object->setProperty (property.first, property.second);

        return juce::var (object);
    }

    /*  The model's own name for itself, in both spellings. `nmp_onnx` is what
        juce_add_binary_data derives from the file name it is given in
        shell/CMakeLists.txt; changing one without the other is caught by
        ModelLocator's error, which lists every path it tried. */
    constexpr const char* kBinaryName = "nmp_onnx";
    constexpr const char* kFileName   = "nmp.onnx";
}

//==============================================================================
BasicPitchAdapter::BasicPitchAdapter() : row (basicPitchRow()) {}
BasicPitchAdapter::~BasicPitchAdapter() = default;

const EngineManifest& BasicPitchAdapter::manifest() const noexcept
{
    return row;
}

EngineAdapter::Capabilities BasicPitchAdapter::capabilities() const
{
    Capabilities caps;

    // Empty means "anything it hears", which is the literal truth: Basic Pitch
    // is instrument-agnostic and has no notion of a named instrument at all.
    // The transcribe() hint is used as a frequency bound on the OUTPUT, not as a
    // constraint the model is given, which is why acceptsInstrumentConstraint
    // stays false - promising a hard constraint this engine cannot enforce would
    // be a lie the UI would repeat.
    caps.instruments = {};
    caps.producesBeatGrid = row.producesBeatGrid;
    caps.producesTrueBeats = false;             // wave 4's BeatTracker serves every engine
    caps.producesConfidence = row.producesConfidence;
    caps.producesVelocity = row.producesVelocity;
    caps.acceptsInstrumentConstraint = row.acceptsInstrumentConstraint;
    caps.needsGainNorm = row.needsGainNorm;     // false: the model normalises internally
    caps.needsTuningNorm = row.needsTuningNorm;
    caps.preferredInputRate = row.preferredInputRate;
    return caps;
}

EngineAdapter::Status BasicPitchAdapter::status() const
{
    const std::lock_guard<std::mutex> guard (stateLock);

    Status out;
    out.availability = Availability::ready;
    out.stateName = session != nullptr ? "ready" : "stopped";
    out.location = "built in";
    out.error = lastError;
    out.port = 0;
    out.adopted = false;
    out.detail = lastError.isNotEmpty()
                   ? "The built-in engine failed to start, which is a bug in this build."
                   : "Built in and ready. Nothing to install.";

    out.extra = makeObject ({
        { "onnxRuntime", OrtSession::runtimeVersion() },
        { "executionProvider", provider },
        { "modelFile", kFileName },
        { "lastWindows", lastRun.windows },
        { "lastInferenceMs", lastRun.inferenceMs > 0.0 ? juce::var (lastRun.inferenceMs) : juce::var() },
        { "lastTotalMs", lastRun.totalMs > 0.0 ? juce::var (lastRun.totalMs) : juce::var() },
        { "lastNotes", lastRun.notes } });

    return out;
}

void BasicPitchAdapter::rediscover()
{
    // There is nothing to discover: the engine is in the binary. Saying so out
    // loud is cheaper than a reader wondering whether something was forgotten.
}

bool BasicPitchAdapter::prepare (std::function<void (const juce::String&)> onProgress,
                                 std::function<bool()> shouldCancel)
{
    if (shouldCancel != nullptr && shouldCancel())
        return false;

    const std::lock_guard<std::mutex> guard (stateLock);

    if (session != nullptr && session->isValid())
        return true;

    if (onProgress != nullptr)
        onProgress ("Starting the built-in engine");

    ModelLocator::Model model;
    juce::String error;

    if (! ModelLocator::find (kBinaryName, kFileName, model, error))
    {
        lastError = error;
        session.reset();
        return false;
    }

    auto made = std::make_unique<OrtSession> (model.data, model.size, "Basic Pitch", error);

    if (! made->isValid())
    {
        lastError = error;
        session.reset();
        return false;
    }

    provider = made->executionProvider();
    session = std::move (made);
    lastError = {};
    return true;
}

void BasicPitchAdapter::endOfJob()
{
    const std::lock_guard<std::mutex> guard (stateLock);
    session.reset();
}

//==============================================================================
juce::var BasicPitchAdapter::transcribe (const AudioInput& input,
                                         const Request& request,
                                         Callbacks callbacks,
                                         juce::String& error)
{
    const auto startedAt = juce::Time::getMillisecondCounterHiRes();

    const auto cancelled = [&callbacks]
    {
        return callbacks.shouldCancel != nullptr && callbacks.shouldCancel();
    };

    OrtSession* liveSession = nullptr;

    {
        const std::lock_guard<std::mutex> guard (stateLock);
        liveSession = session.get();
    }

    if (liveSession == nullptr || ! liveSession->isValid())
    {
        error = "The built-in engine was asked to transcribe before it was started.";
        return {};
    }

    //== audio ================================================================

    std::vector<float> mono;

    if (! BasicPitchFrontend::readMonoAt22050 (input.file, mono, error))
        return {};

    if (mono.empty())
    {
        error = "There is no audio to transcribe.";
        return {};
    }

    if (cancelled())
    {
        error = "cancelled";
        return {};
    }

    //== inference ============================================================

    BasicPitchFrontend::Result analysis;

    if (! BasicPitchFrontend::analyse (*liveSession, mono,
                                       callbacks.onProgress, callbacks.shouldCancel,
                                       analysis, error))
        return {};

    mono.clear();
    mono.shrink_to_fit();

    //== notes ================================================================

    const auto params = BasicPitchNotes::boundsFor (request.instruments);
    const auto events = BasicPitchNotes::convert (analysis.notes, analysis.onsets, params);

    juce::Array<juce::var> noteList;
    int index = 0;

    for (const auto& event : events)
    {
        auto* noteObj = new juce::DynamicObject();
        noteObj->setProperty ("pitch", event.pitch);
        noteObj->setProperty ("start", juce::jmax (0.0, event.startTime));
        noteObj->setProperty ("end", juce::jmax (0.0, event.endTime));
        // Single-instrument engine: webcore treats this as a label only, and an
        // invented instrument name would be a claim this engine cannot make.
        noteObj->setProperty ("instrument", "");
        noteObj->setProperty ("index", index++);
        // The first engine that can say how sure it is. DetectedNoteDTO already
        // has the optional field; emitting it costs nothing.
        noteObj->setProperty ("confidence", juce::jlimit (0.0, 1.0, event.amplitude));
        noteList.add (juce::var (noteObj));
    }

    auto* result = new juce::DynamicObject();
    result->setProperty ("notes", noteList);
    // No beat grid: this engine hears pitch, not tempo. A null here is what
    // makes the page ask the beat tracker instead of trusting a made-up bpm.
    result->setProperty ("beatGrid", juce::var());
    result->setProperty ("onsetDelay", 0.0);
    // No MIDI file: the page already rebuilds MIDI from the notes.
    result->setProperty ("midiBase64", "");
    result->setProperty ("truncated", false);

    {
        const std::lock_guard<std::mutex> guard (stateLock);
        lastRun.windows = analysis.windowsRun;
        lastRun.inferenceMs = analysis.inferenceMs;
        lastRun.totalMs = juce::Time::getMillisecondCounterHiRes() - startedAt;
        lastRun.notes = (int) events.size();
    }

    return juce::var (result);
}
