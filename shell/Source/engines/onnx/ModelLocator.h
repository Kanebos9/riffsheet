#pragma once
#include <JuceHeader.h>

/**
    Where a model's bytes come from, in one place, for every engine.

    THE RULE, decided once in engine-architecture.md §6.6 so nobody has to
    re-argue it per model:

      - a model of 1 MB or less is compiled into the binary with
        juce_add_binary_data and read zero-copy, exactly the way WebResources
        reads webcore.zip;
      - a model larger than that ships as a file in the bundle's Resources,
        because juce_add_plugin links THREE products on macOS (VST3, AU,
        Standalone) and every embedded byte is therefore paid three times.

    `nmp.onnx` is 225 KiB, so Basic Pitch is on the embedded side and the disk
    branches below exist for wave 4's beat_this checkpoint and for development.

    SEARCH ORDER, and why the environment variable comes first:

      1. $RIFFSHEET_MODEL_DIR/<fileName>   - dev override, same shape and same
                                             reason as RIFFSHEET_WEBCORE_DIR
                                             (WebResources.cpp): an override that
                                             loses to the built-in copy is not an
                                             override.
      2. BinaryData::<binaryName>          - the shipping path.
      3. <bundle>/Contents/Resources/models/<fileName>
      4. <appSupport>/models/<fileName>

    Nothing here downloads anything, ever. A model Riffsheet ships is in the
    release; a model it does not ship is a one-click engine's business.
*/
class ModelLocator
{
public:
    struct Model
    {
        const void* data = nullptr;   // valid while `owned` (or BinaryData) lives
        size_t size = 0;
        juce::String source;          // "built in" or the full path it was read from

        /** Non-empty only when the bytes came off disk. Keeps `data` alive. */
        juce::MemoryBlock owned;

        bool isValid() const noexcept { return data != nullptr && size > 0; }
    };

    /** Finds a model and fills `out`. `binaryName` is the juce_add_binary_data
        symbol stem (e.g. "nmp_onnx"); `fileName` is what the same model is
        called on disk (e.g. "nmp.onnx"). Returns false with `error` set and
        every path that was tried listed, in order - the same courtesy the engine
        setup screen already pays for a missing venv. */
    static bool find (const juce::String& binaryName,
                      const juce::String& fileName,
                      Model& out,
                      juce::String& error);

    /** The directories searched, in order, for diagnostics. */
    static juce::StringArray searchPaths (const juce::String& fileName);
};
