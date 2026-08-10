#pragma once
#include <JuceHeader.h>
#include <cstdint>
#include <memory>
#include <vector>

/**
    One ONNX Runtime session, and the whole of Riffsheet's inference surface.

    WHY THIS CLASS EXISTS AT ALL, AND WHY IT IS THIS THIN. Basic Pitch (wave 3)
    and beat_this (wave 4) are two completely different models with two
    completely different front ends, and the only thing they share is "load a
    graph, push float tensors through it". That is what lives here. Nothing
    model-specific may ever be added to this file - the moment it knows what a
    posteriorgram is, the second engine has to fork it.

    WHY PIMPL. `juce_recommended_warning_flags` is PUBLIC on the Riffsheet
    target (shell/CMakeLists.txt), so every header a translation unit pulls in is
    compiled under -Wall -Wextra -Wpedantic and friends. ONNX Runtime's C++ API
    header does not survive that, and the cure - SYSTEM include directories - is
    a property of the target, not of a header. Keeping every ORT symbol inside
    OrtSession.cpp means exactly one translation unit needs the SYSTEM include
    and no other file in the tree can accidentally acquire an ORT dependency.
    It also keeps `Ort::Exception` from escaping: this class reports failures the
    way the rest of the shell does, with a bool and a juce::String& error.

    THE ENVIRONMENT IS PROCESS-WIDE. Building two `Ort::Env`s in one process is
    documented ORT misuse; a juce::SharedResourcePointer inside the .cpp owns the
    single one, so eight plugin instances in one REAPER share it and the last one
    out destroys it.

    THREADING. The constructor and run() block. Worker threads only - never the
    audio thread, never the message thread.
*/
class OrtSession
{
public:
    /** A borrowed, contiguous float input. The caller owns the memory and must
        keep it alive across the whole run() call. */
    struct TensorView
    {
        const float* data = nullptr;
        std::vector<int64_t> shape;

        /** Product of the shape - what ORT will read. */
        size_t elementCount() const noexcept;
    };

    /** An owned float output, copied out of ORT's arena so the caller can hold
        it after the session is gone. */
    struct Tensor
    {
        std::vector<float> data;
        std::vector<int64_t> shape;

        int64_t dim (size_t index) const noexcept
        {
            return index < shape.size() ? shape[index] : 0;
        }
    };

    /** Builds a session directly over model bytes - typically the BinaryData
        blob, consumed zero-copy exactly as WebResources reads webcore.zip. The
        bytes must outlive this object; a BinaryData pointer trivially does.

        On failure `isValid()` is false and `error` says why in one sentence. */
    OrtSession (const void* modelData, size_t modelBytes, const char* logId, juce::String& error);
    ~OrtSession();

    bool isValid() const noexcept;

    /** Runs one inference. `inputs` and `inputNames` must be the same length, as
        must `outputs` and `outputNames`; `outputs` is resized to match.
        Returns false with `error` set rather than throwing. */
    bool run (const std::vector<const char*>& inputNames,
              const std::vector<TensorView>& inputs,
              const std::vector<const char*>& outputNames,
              std::vector<Tensor>& outputs,
              juce::String& error);

    /** "CPU", or "CoreML" when the Apple execution provider was compiled in and
        accepted the graph. Shown in BUILDING.md's timing table and in the
        adapter's status detail, so a slow machine can be diagnosed without a
        debugger. */
    juce::String executionProvider() const;

    /** The ORT version this build links, e.g. "1.28.0". */
    static juce::String runtimeVersion();

private:
    struct Impl;
    std::unique_ptr<Impl> impl;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (OrtSession)
};
