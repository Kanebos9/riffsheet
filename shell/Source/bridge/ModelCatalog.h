#pragma once
#include <JuceHeader.h>

/**
    Which MuScriptor weights are actually on this disk, and which of them this
    machine can sensibly run.

    Riffsheet used to ask for "medium" and nothing else, hardcoded. Somebody with
    small, medium AND large downloaded had no way of telling which one was
    running - which is punch-list item 10.

    WHAT PICKS, NOW. Riffsheet picks, and it picks the LIGHTEST size that is
    installed (chooseAutomatically() below spells out the rule). There is no
    size chooser in Settings any more: a dropdown that offers three sizes is a
    question a musician cannot answer, and the two honest ways to override the
    pick both survive - install only the size you want, or set
    RIFFSHEET_MUSCRIPTOR_MODEL, which nothing here auto-selects around.

    WHERE THE WEIGHTS LIVE. MuScriptor resolves a bare size keyword to
    `hf://MuScriptor/muscriptor-<size>/model.safetensors` (its own
    transcription_model.py says so), and huggingface_hub caches that at

        <cache>/models--MuScriptor--muscriptor-<size>/snapshots/<rev>/model.safetensors

    Verified on this machine: `models--MuScriptor--muscriptor-medium` is there,
    1.1 GB, with a real `model.safetensors` in its snapshot. The cache root is
    ~/.cache/huggingface/hub unless HF_HOME or HUGGINGFACE_HUB_CACHE says
    otherwise, and both are honoured here.

    A directory on its own is not enough: an interrupted download leaves the
    folder with a dangling symlink into `blobs`. So a size only counts as
    installed when the weights file behind the link really opens.
*/
namespace ModelCatalog
{
    /** The three published sizes, smallest first. */
    juce::StringArray allModelNames();

    bool isKnownModelName (const juce::String& name);

    /** Where huggingface_hub keeps its cache on this machine. */
    juce::File cacheDirectory();

    /** Which of small/medium/large have usable weights on disk, LIGHTEST FIRST -
        the order auto-selection walks, so the head of this list is the thing
        `auto` will ask for whenever the machine can carry it.
        Empty is a perfectly normal answer on a fresh machine. */
    juce::StringArray installedModels();

    /** Roughly how much RAM the server holds while that model is loaded, in MB,
        Python and the Metal/CPU runtime included. */
    int estimatedResidentMb (const juce::String& model);

    /** Step 1 of the auto rule below, on its own: would this size fit in a
        machine with this much PHYSICAL memory, at the 40% ceiling?

        It is a separate function because two callers need the same answer and a
        second copy of "* 5 <= * 2" is exactly how the UI ends up telling the
        user something the resolver does not believe. engineStatus() reports it
        per model so a card can list all three sizes with an honest "this
        machine cannot carry that one"; chooseAutomatically() uses it to drop
        sizes before it takes the lightest of what is left.
        `ramTotalMb <= 0` means "could not tell", and answers true rather than
        hiding every model behind an unknown. */
    bool fitsInPhysicalRam (const juce::String& model, int ramTotalMb);

    struct Choice
    {
        juce::String model;      // always one of small/medium/large
        juce::String reason;     // a plain sentence, safe to show the user
    };

    /**
        What "auto" should mean on a machine with this much memory.

        THE RULE, and the numbers behind it.

        Loaded, the server holds roughly 0.9 GB for small, 1.8 GB for medium and
        5 GB for large - Python, torch and the Metal buffers included, not just
        the weights file. (Measured indirectly: design notes §3.3 records
        that a second copy of the medium server costs "about another gigabyte",
        and the weights on disk are 1.1 GB for medium.)

          1. Prefer the LIGHTEST installed weights. This is the owner's decision
             and it reverses what this function used to do: Riffsheet shares a
             machine with a DAW session, and the cheapest model that is actually
             on the disk is the one a person did not have to be asked about. A
             heavier model is a CHOICE, never an automatic pick - somebody who
             wants medium installs medium and selects it, or sets
             RIFFSHEET_MUSCRIPTOR_MODEL.
          2. Drop any size whose estimate is more than 40% of PHYSICAL RAM. That
             makes small want 2.3 GB, medium 4.5 GB and large 12.5 GB of machine.
             The ceiling still applies, so on a machine too small even for the
             lightest installed size the answer is that size anyway (see below)
             rather than nothing.
          3. FREE memory right now cannot change the answer any more - step 1
             already picked the lightest thing on the disk, and stepping "down"
             to something that is not installed would trigger a download, which
             is the opposite of helping. It changes only the SENTENCE, so a
             machine under memory pressure says so honestly.
          4. If nothing is installed at all, ask for "small". That is the size
             the setup guide installs, and a fresh machine is precisely the one
             that must not be handed a heavier download it never asked for.

        `ramFreeMb` may be 0 for "could not tell", in which case the wording in
        step 3 is skipped rather than guessed at.
    */
    Choice chooseAutomatically (const juce::StringArray& installed, int ramTotalMb, int ramFreeMb);

    /** Resolves a user setting ('auto'/'small'/'medium'/'large') to a concrete
        size. Anything unrecognised is treated as 'auto'. */
    Choice resolve (const juce::String& configured, int ramTotalMb, int ramFreeMb);

    /** Digs `--model X` (or `--model=X`) out of a server's command line, so the
        model of a server somebody else started can be reported honestly instead
        of guessed. Returns "" when the flag is not there. */
    juce::String modelFromCommandLine (const juce::String& commandLine);
}
