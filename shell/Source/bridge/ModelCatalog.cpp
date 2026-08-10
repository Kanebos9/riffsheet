#include "ModelCatalog.h"

namespace ModelCatalog
{
namespace
{
    /** Largest first - the order auto-selection walks. */
    const char* const sizesLargestFirst[] = { "large", "medium", "small" };

    juce::File fromEnvironment (const char* name)
    {
        const auto value = juce::SystemStats::getEnvironmentVariable (name, {});
        return value.isNotEmpty() ? juce::File (value) : juce::File();
    }

    /** True when a size's snapshot really has weights behind it.

        HuggingFace snapshots are symlinks into `blobs`, and an interrupted
        download leaves the link pointing at nothing. existsAsFile() follows the
        link, so a dangling one reads as absent - which is exactly right. */
    bool hasUsableWeights (const juce::File& modelDirectory)
    {
        const auto snapshots = modelDirectory.getChildFile ("snapshots");

        if (! snapshots.isDirectory())
            return false;

        for (const auto& entry : juce::RangedDirectoryIterator (snapshots, false, "*",
                                                                juce::File::findDirectories))
            if (entry.getFile().getChildFile ("model.safetensors").existsAsFile())
                return true;

        return false;
    }
}

//==============================================================================
juce::StringArray allModelNames()
{
    return { "small", "medium", "large" };
}

bool isKnownModelName (const juce::String& name)
{
    return allModelNames().contains (name);
}

juce::File cacheDirectory()
{
    // huggingface_hub's own resolution order.
    if (const auto direct = fromEnvironment ("HUGGINGFACE_HUB_CACHE"); direct != juce::File())
        return direct;

    if (const auto home = fromEnvironment ("HF_HOME"); home != juce::File())
        return home.getChildFile ("hub");

    if (const auto xdg = fromEnvironment ("XDG_CACHE_HOME"); xdg != juce::File())
        return xdg.getChildFile ("huggingface").getChildFile ("hub");

    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
               .getChildFile (".cache")
               .getChildFile ("huggingface")
               .getChildFile ("hub");
}

juce::StringArray installedModels()
{
    const auto cache = cacheDirectory();
    juce::StringArray found;

    if (! cache.isDirectory())
        return found;

    for (const auto* size : sizesLargestFirst)
    {
        const auto dir = cache.getChildFile ("models--MuScriptor--muscriptor-" + juce::String (size));

        if (dir.isDirectory() && hasUsableWeights (dir))
            found.add (size);
    }

    return found;
}

int estimatedResidentMb (const juce::String& model)
{
    if (model == "large")  return 5000;
    if (model == "small")  return 900;
    return 1800;                          // medium, and the safe assumption
}

//==============================================================================
Choice chooseAutomatically (const juce::StringArray& installed, int ramTotalMb, int ramFreeMb)
{
    if (installed.isEmpty())
        return { "medium",
                 "No weights are on this machine yet, so Riffsheet is asking for the medium "
                 "model - the server will download it the first time you transcribe." };

    // Largest first, keeping only the sizes actually on disk.
    juce::StringArray candidates;

    for (const auto* size : sizesLargestFirst)
        if (installed.contains (size))
            candidates.add (size);

    const auto smallestInstalled = candidates[candidates.size() - 1];

    // Step 2: what this machine can physically carry. See the header for the
    // arithmetic behind the 40%.
    juce::StringArray affordable;

    for (const auto& size : candidates)
        if (ramTotalMb <= 0 || estimatedResidentMb (size) * 5 <= ramTotalMb * 2)
            affordable.add (size);

    if (affordable.isEmpty())
        return { smallestInstalled,
                 "This machine has " + juce::String (ramTotalMb) + " MB of memory, which is tight for "
                 "every model you have installed, so Riffsheet picked the smallest one ("
                 + smallestInstalled + ")." };

    auto chosen = affordable[0];
    juce::String reason = "Using the largest weights you have installed that this machine can carry ("
                        + chosen + ", about " + juce::String (estimatedResidentMb (chosen) / 1000.0, 1)
                        + " GB while it runs).";

    // Step 3: free memory right now. Only ever a step DOWN, and never past the
    // smallest thing on disk - picking something that is not installed would
    // start a download, which helps nobody.
    if (ramFreeMb > 0)
    {
        while (ramFreeMb < estimatedResidentMb (chosen) + 400)
        {
            const auto next = affordable.indexOf (chosen) + 1;

            if (next >= affordable.size())
                break;

            const auto smaller = affordable[next];
            reason = "Only about " + juce::String (ramFreeMb) + " MB of memory is free right now, so "
                     "Riffsheet stepped down from " + chosen + " to " + smaller + " rather than push "
                     "this machine into swapping.";
            chosen = smaller;
        }
    }

    return { chosen, reason };
}

Choice resolve (const juce::String& configured, int ramTotalMb, int ramFreeMb)
{
    if (isKnownModelName (configured))
    {
        const auto installed = installedModels();

        if (installed.contains (configured))
            return { configured, "You chose the " + configured + " model." };

        return { configured,
                 "You chose the " + configured + " model. It is not on this machine yet, so the "
                 "server will download it the first time you transcribe." };
    }

    return chooseAutomatically (installedModels(), ramTotalMb, ramFreeMb);
}

//==============================================================================
juce::String modelFromCommandLine (const juce::String& commandLine)
{
    if (commandLine.isEmpty())
        return {};

    juce::StringArray tokens;
    tokens.addTokens (commandLine, " \t", "\"'");
    tokens.removeEmptyStrings();

    for (int i = 0; i < tokens.size(); ++i)
    {
        const auto token = tokens[i];

        if (token.startsWith ("--model="))
            return token.fromFirstOccurrenceOf ("=", false, false).unquoted();

        if (token == "--model" && i + 1 < tokens.size())
            return tokens[i + 1].unquoted();
    }

    return {};
}

} // namespace ModelCatalog
