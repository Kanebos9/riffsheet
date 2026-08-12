#include "ModelCatalog.h"

namespace ModelCatalog
{
namespace
{
    /** Lightest first - the order auto-selection walks, and the order every
        list this file produces comes out in.

        It used to be largest first, because "bigger is better when it fits".
        The owner's decision reversed that: the machine Riffsheet runs on is
        somebody's DAW machine with a session already in it, and the engine is a
        Python process that holds its weights resident for the length of a job.
        Auto now asks for the LIGHTEST thing that is installed, and a heavier
        model is something a person chooses, never something Riffsheet picks for
        them. */
    const char* const sizesLightestFirst[] = { "small", "medium", "large" };

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

    for (const auto* size : sizesLightestFirst)
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

bool fitsInPhysicalRam (const juce::String& model, int ramTotalMb)
{
    // estimate <= 40% of physical, written as integers so there is no floating
    // point in a rule the UI quotes back to the user: e * 5 <= t * 2.
    return ramTotalMb <= 0 || estimatedResidentMb (model) * 5 <= ramTotalMb * 2;
}

//==============================================================================
Choice chooseAutomatically (const juce::StringArray& installed, int ramTotalMb, int ramFreeMb)
{
    // NOTHING INSTALLED. The first run asks for SMALL, which is the size the
    // setup guide installs and the lightest thing the server can be told to
    // fetch. This used to say "medium" and it was the one place the fresh-install
    // path disagreed with everything else: a machine with no weights on it is
    // exactly the machine that should not be handed a 1.8 GB download and a
    // 1.8 GB resident process without being asked.
    if (installed.isEmpty())
        return { "small",
                 "No weights are on this machine yet, so Riffsheet is asking for the small "
                 "model - the lightest one, and the one the setup guide installs. The server "
                 "will download it the first time you transcribe." };

    // Lightest first, keeping only the sizes actually on disk.
    juce::StringArray candidates;

    for (const auto* size : sizesLightestFirst)
        if (installed.contains (size))
            candidates.add (size);

    const auto smallestInstalled = candidates[0];

    // Step 2: what this machine can physically carry. See the header for the
    // arithmetic behind the 40%.
    juce::StringArray affordable;

    for (const auto& size : candidates)
        if (fitsInPhysicalRam (size, ramTotalMb))
            affordable.add (size);

    if (affordable.isEmpty())
        return { smallestInstalled,
                 "This machine has " + juce::String (ramTotalMb) + " MB of memory, which is tight for "
                 "every model you have installed, so Riffsheet picked the smallest one ("
                 + smallestInstalled + ")." };

    // Step 3: the lightest size that clears the physical-RAM ceiling. `affordable`
    // is already lightest first, so this IS the pick - there is no step down to
    // make afterwards and no larger model to grow into.
    const auto chosen = affordable[0];
    juce::String reason = "Using the lightest weights you have installed (" + chosen + ", about "
                        + juce::String (estimatedResidentMb (chosen) / 1000.0, 1)
                        + " GB while it runs). Riffsheet only asks for a heavier model when you "
                          "install one and nothing lighter is here.";

    // Free memory right now. It can no longer change the choice - the choice is
    // already the lightest thing on this disk that fits - so it only changes what
    // the card SAYS, and only when it is the interesting case: the machine is
    // short of memory and there is nothing lighter to fall back to.
    if (ramFreeMb > 0 && ramFreeMb < estimatedResidentMb (chosen) + 400)
        reason = "Only about " + juce::String (ramFreeMb) + " MB of memory is free right now and "
                 + chosen + " is the lightest model you have installed (it wants about "
                 + juce::String (estimatedResidentMb (chosen)) + " MB), so Riffsheet is using it "
                 "rather than anything heavier.";

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
