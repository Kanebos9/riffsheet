#pragma once
#include <JuceHeader.h>
#include <memory>
#include "EngineManifest.h"
#include "PcmStore.h"

/**  One transcription engine, behind one door.

     MuScriptorServer is adapter #1 and keeps every line of its behaviour: this
     interface was shaped around what it already does, not the other way round.
     A new engine is a new subclass plus a row in EngineCatalog - never a change
     here and never a change in NativeBridge.

     THREADING. Everything except manifest(), capabilities() and isAvailable()
     blocks and belongs on NativeBridge::longWorkers. Nothing here is safe on
     the audio thread; nothing here may be called on the message thread.  */
class EngineAdapter
{
public:
    virtual ~EngineAdapter() = default;

    //== identity & capability =================================================

    /** The compiled-in row for this engine. Never null, never changes. */
    virtual const EngineManifest& manifest() const noexcept = 0;

    /** Cheap; safe on the message thread. Derived from the manifest plus, for
        engines that can report it, the live engine (MuScriptor's 35 instrument
        groups come from GET /instruments and are cached). */
    struct Capabilities
    {
        juce::StringArray instruments;   // empty = "anything it hears"
        bool producesBeatGrid   = false; // a constant-tempo grid in the result
        bool producesTrueBeats  = false; // per-beat times (see BeatTracker, wave 4)
        bool producesConfidence = false;
        bool producesVelocity   = false;
        bool acceptsInstrumentConstraint = false;
        bool needsGainNorm      = false; // -12 dBFS peak before inference
        bool needsTuningNorm    = false; // A440 correction before inference
        double preferredInputRate = 0.0; // 0 = "whatever the source is"
    };
    virtual Capabilities capabilities() const = 0;

    //== discovery & status ====================================================

    enum class Availability { ready, installed, notInstalled, broken };

    struct Status
    {
        Availability availability = Availability::notInstalled;
        juce::String stateName;          // "stopped"|"starting"|"ready"|"failed"
        juce::String location;           // executable / venv / "built in"
        juce::String detail;             // one sentence for a human, may be empty
        juce::String error;              // "" when fine
        juce::StringArray searchedPaths; // in the order they were tried; may be empty
        int  port = 0;                   // 0 for everything that is not a server
        bool adopted = false;
        juce::var extra;                 // engine-specific object merged into engineStatus(id)
    };

    /** Cached facts only. Cheap enough for the message thread, exactly like
        MuScriptorServer::getIdleState() is today. */
    virtual Status status() const = 0;

    /** Re-runs discovery from scratch. Stats files, may probe ports. Worker
        threads only. This is what recheckEngine() calls. */
    virtual void rediscover() = 0;

    //== lifecycle =============================================================
    //
    // THE ONE-JOB RULE IS UNIVERSAL AND IT IS ENFORCED HERE.
    //
    //   prepare() -> transcribe() -> endOfJob()
    //
    // and endOfJob() gives back whatever prepare() took, every time, however
    // the job ended. For MuScriptor that is a ~1.5 GB Python server; for
    // Basic Pitch it is an Ort::Session; for a venv sidecar it is nothing at
    // all because the process already exited. Same shape, no exceptions to
    // reason about. NativeBridge's EndOfJob destructor calls it.

    /** Starts / adopts / warms whatever this engine needs. Returns false and
        leaves status().error set on failure. */
    virtual bool prepare (std::function<void (const juce::String&)> onProgress,
                          std::function<bool()> shouldCancel) = 0;

    /** Gives back everything prepare() took. Must be safe to call when
        prepare() was never called or failed. Must never throw. */
    virtual void endOfJob() = 0;

    //== the work ==============================================================

    /** Both forms are offered because in-process engines want samples and
        subprocess engines want a path. An adapter uses whichever it needs; the
        caller guarantees BOTH are valid for the whole call and that `file`
        survives it (NativeBridge holds the PcmStore entry - PcmStore.h:52). */
    struct AudioInput
    {
        juce::File file;                                // always present
        std::shared_ptr<const PcmStore::Entry> entry;   // may be null (a { path } transcribe)
        double tuningRatio = 1.0;   // multiply returned times by this (wave 6)
    };

    struct Request
    {
        juce::StringArray instruments;   // ignored unless acceptsInstrumentConstraint
        juce::String detectTempo = "best-effort";
        juce::String clientId;
    };

    struct Callbacks
    {
        std::function<void (int completed, int total)> onProgress;
        std::function<bool()> shouldCancel;
    };

    /** THE WIRE SHAPE IS FIXED AND IS TODAY'S SHAPE. Returns exactly what
        MuScriptorServer::transcribe() returns now, so NativeBridge and every
        line of webcore stay unchanged:

            { notes: [ { pitch, start, end, instrument, index } ],
              beatGrid: { bpm, beatsPerBar, firstDownbeat, onsetDelay } | null,
              onsetDelay, midiBase64, truncated }

        `midiBase64` may be "" for engines that do not emit a MIDI file - the
        page already rebuilds MIDI from the notes. `instrument` may be "" when
        the engine is single-instrument; webcore treats it as a label only.
        Void var + `error` filled on failure. "cancelled" is the reserved
        error string, exactly as today. */
    virtual juce::var transcribe (const AudioInput& input,
                                  const Request& request,
                                  Callbacks callbacks,
                                  juce::String& error) = 0;
};
