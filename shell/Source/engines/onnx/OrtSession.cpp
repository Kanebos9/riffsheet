#include "OrtSession.h"

#include <onnxruntime_cxx_api.h>

#if JUCE_MAC && RIFFSHEET_ORT_HAS_COREML
 #include <coreml_provider_factory.h>
#endif

#include <numeric>

namespace
{
    /*  THE ONE Ort::Env IN THE PROCESS.

        ORT's own documentation is explicit that a second environment in one
        process is undefined behaviour, and a plugin is precisely where that
        happens by accident: eight Riffsheet instances in one REAPER project are
        eight copies of this code in one address space. juce::SharedResourcePointer
        is the shape this codebase already uses for exactly this problem, and it
        destroys the environment when the last holder goes - which matters
        because ORT's env owns the thread pool. */
    struct OrtEnvHolder
    {
        OrtEnvHolder() : env (ORT_LOGGING_LEVEL_WARNING, "Riffsheet") {}
        Ort::Env env;
    };

    juce::String describe (const std::exception& e)
    {
        const juce::String what (e.what());
        return what.isNotEmpty() ? what : juce::String ("ONNX Runtime reported no reason.");
    }
}

//==============================================================================
size_t OrtSession::TensorView::elementCount() const noexcept
{
    if (shape.empty())
        return 0;

    int64_t total = 1;

    for (const auto d : shape)
    {
        if (d <= 0)
            return 0;

        total *= d;
    }

    return (size_t) total;
}

//==============================================================================
struct OrtSession::Impl
{
    juce::SharedResourcePointer<OrtEnvHolder> environment;
    std::unique_ptr<Ort::Session> session;
    Ort::MemoryInfo memory { Ort::MemoryInfo::CreateCpu (OrtArenaAllocator, OrtMemTypeDefault) };
    juce::String provider { "CPU" };
};

//==============================================================================
OrtSession::OrtSession (const void* modelData, size_t modelBytes, const char* logId, juce::String& error)
{
    if (modelData == nullptr || modelBytes == 0)
    {
        error = "The model for " + juce::String (logId) + " is empty. This build is broken, "
                "not misconfigured: the weights are compiled into the binary.";
        return;
    }

    try
    {
        auto made = std::make_unique<Impl>();

        Ort::SessionOptions options;

        // One inference at a time, on a worker thread that is already ours.
        // ORT's default is a thread per core, which on an 8 GB M-series competes
        // with the DAW's own audio threads for exactly no gain: Basic Pitch's
        // graph is 248 nodes over a 43844-sample window.
        options.SetIntraOpNumThreads (2);
        options.SetInterOpNumThreads (1);
        options.SetGraphOptimizationLevel (GraphOptimizationLevel::ORT_ENABLE_ALL);
        options.DisableCpuMemArena();
        options.SetLogSeverityLevel (ORT_LOGGING_LEVEL_ERROR);

       #if JUCE_MAC && RIFFSHEET_ORT_HAS_COREML
        // THE ESCAPE HATCH, AND IT IS ONE LINE BECAUSE THE RUNTIME IS SHARED.
        // Same session, same model file, same front end and same post-processor:
        // appending the Apple execution provider is the whole of "use the Neural
        // Engine". It is compiled in only when the linked ORT was built
        // --use_coreml (see shell/cmake/OnnxRuntime.cmake), and even then ORT
        // silently falls back to CPU for any subgraph CoreML will not take, so
        // this can never be the reason a transcription fails.
        //
        // It is OFF in the shipping build. Measured on this Mac (M1, 8 GB) the
        // CPU provider transcribes far faster than real time - see BUILDING.md's
        // timing table - so a second code path bought nothing.
        uint32_t coreMLFlags = COREML_FLAG_USE_CPU_AND_GPU;

        if (OrtSessionOptionsAppendExecutionProvider_CoreML (options, coreMLFlags) == nullptr)
            made->provider = "CoreML";
       #endif

        made->session = std::make_unique<Ort::Session> (made->environment->env,
                                                        modelData,
                                                        modelBytes,
                                                        options);
        impl = std::move (made);
        juce::ignoreUnused (logId);
    }
    catch (const Ort::Exception& e)
    {
        error = "ONNX Runtime could not load the built-in " + juce::String (logId)
                  + " model: " + describe (e);
        impl.reset();
    }
    catch (const std::exception& e)
    {
        error = "Could not start the built-in " + juce::String (logId) + " model: " + describe (e);
        impl.reset();
    }
}

OrtSession::~OrtSession() = default;

bool OrtSession::isValid() const noexcept
{
    return impl != nullptr && impl->session != nullptr;
}

juce::String OrtSession::executionProvider() const
{
    return impl != nullptr ? impl->provider : juce::String ("none");
}

juce::String OrtSession::runtimeVersion()
{
    return juce::String (OrtGetApiBase()->GetVersionString());
}

bool OrtSession::run (const std::vector<const char*>& inputNames,
                      const std::vector<TensorView>& inputs,
                      const std::vector<const char*>& outputNames,
                      std::vector<Tensor>& outputs,
                      juce::String& error)
{
    if (! isValid())
    {
        error = "The inference session was never built.";
        return false;
    }

    if (inputNames.size() != inputs.size())
    {
        error = "Inference was asked for " + juce::String ((int) inputNames.size())
                  + " named inputs but given " + juce::String ((int) inputs.size()) + ".";
        return false;
    }

    try
    {
        std::vector<Ort::Value> inputValues;
        inputValues.reserve (inputs.size());

        for (const auto& input : inputs)
        {
            const auto count = input.elementCount();

            if (input.data == nullptr || count == 0)
            {
                error = "An input tensor was empty.";
                return false;
            }

            inputValues.push_back (Ort::Value::CreateTensor<float> (impl->memory,
                                                                    const_cast<float*> (input.data),
                                                                    count,
                                                                    input.shape.data(),
                                                                    input.shape.size()));
        }

        auto results = impl->session->Run (Ort::RunOptions { nullptr },
                                           inputNames.data(),
                                           inputValues.data(),
                                           inputValues.size(),
                                           outputNames.data(),
                                           outputNames.size());

        outputs.clear();
        outputs.resize (results.size());

        for (size_t i = 0; i < results.size(); ++i)
        {
            if (! results[i].IsTensor())
            {
                error = "Output " + juce::String (outputNames[i]) + " is not a tensor.";
                return false;
            }

            const auto info = results[i].GetTensorTypeAndShapeInfo();

            if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
            {
                error = "Output " + juce::String (outputNames[i]) + " is not float32.";
                return false;
            }

            outputs[i].shape = info.GetShape();

            const auto count = info.GetElementCount();
            const auto* source = results[i].GetTensorData<float>();
            outputs[i].data.assign (source, source + count);
        }

        return true;
    }
    catch (const Ort::Exception& e)
    {
        error = "Inference failed: " + describe (e);
        return false;
    }
    catch (const std::exception& e)
    {
        error = "Inference failed: " + describe (e);
        return false;
    }
}
