#include "ModelLocator.h"
#include "SystemProbe.h"

#include <BinaryData.h>

namespace
{
    juce::File envModelDir()
    {
        const auto dir = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_MODEL_DIR", {});
        return dir.isNotEmpty() ? juce::File (dir) : juce::File();
    }

    juce::File bundleModelDir()
    {
        // On macOS this resolves inside the .vst3 / .component / .app that is
        // running; on Windows and Linux it is the folder beside the binary. Both
        // are "wherever this build put its resources", which is all this needs
        // to mean.
        const auto self = juce::File::getSpecialLocation (juce::File::currentApplicationFile);

       #if JUCE_MAC
        if (self.isDirectory())
            return self.getChildFile ("Contents").getChildFile ("Resources").getChildFile ("models");
       #endif

        return self.getParentDirectory().getChildFile ("models");
    }

    bool readWholeFile (const juce::File& file, ModelLocator::Model& out)
    {
        if (! file.existsAsFile())
            return false;

        juce::MemoryBlock block;

        if (! file.loadFileAsData (block) || block.getSize() == 0)
            return false;

        out.owned = std::move (block);
        out.data = out.owned.getData();
        out.size = out.owned.getSize();
        out.source = file.getFullPathName();
        return true;
    }
}

//==============================================================================
juce::StringArray ModelLocator::searchPaths (const juce::String& fileName)
{
    juce::StringArray paths;

    if (const auto dir = envModelDir(); dir != juce::File())
        paths.add (dir.getChildFile (fileName).getFullPathName() + "  (RIFFSHEET_MODEL_DIR)");

    paths.add ("built in  (compiled into this binary)");
    paths.add (bundleModelDir().getChildFile (fileName).getFullPathName());
    paths.add (SystemProbe::appSupportDirectory().getChildFile ("models")
                                                 .getChildFile (fileName).getFullPathName());
    return paths;
}

bool ModelLocator::find (const juce::String& binaryName,
                         const juce::String& fileName,
                         Model& out,
                         juce::String& error)
{
    out = {};

    // 1. The dev override wins, or it is not an override.
    if (const auto dir = envModelDir(); dir != juce::File())
        if (readWholeFile (dir.getChildFile (fileName), out))
            return true;

    // 2. The shipping path. Zero copy: the pointer is into the binary's own
    //    read-only data, exactly like WebResources' MemoryInputStream over
    //    BinaryData::webcore_zip.
    if (binaryName.isNotEmpty())
    {
        int size = 0;

        if (const auto* data = BinaryData::getNamedResource (binaryName.toRawUTF8(), size); data != nullptr && size > 0)
        {
            out.data = data;
            out.size = (size_t) size;
            out.source = "built in";
            return true;
        }
    }

    // 3 and 4. Beside the binary, then in Application Support - the wave-4 path
    //    for a checkpoint too big to embed.
    if (readWholeFile (bundleModelDir().getChildFile (fileName), out))
        return true;

    if (readWholeFile (SystemProbe::appSupportDirectory().getChildFile ("models").getChildFile (fileName), out))
        return true;

    error = "Could not find the model \"" + fileName + "\". Looked in: "
              + searchPaths (fileName).joinIntoString ("; ") + ".";
    return false;
}
