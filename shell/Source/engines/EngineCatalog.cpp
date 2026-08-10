#include "EngineCatalog.h"

/*
    The engines Riffsheet knows about, and the compile-time proof that none of
    them is a half-finished promise.

    THE TABLE IS FOUR ROWS: the bundled engine, the guided one, and the two
    one-click ones whose URL, sha256 and byte count are pinned below from files
    that were downloaded, hashed, and then re-fetched with a ranged request and
    hashed again. The static_assert at the bottom is impossible to satisfy while
    an entry still carries kSha256Pending, so there was never a window in which a
    half-pinned engine looked installable.

    THE ROW THAT IS NOT HERE. SOME (github.com/openvpi/SOME, singing
    transcription) was auditioned and works, and it is still absent - deleted
    rather than commented out, so nobody has to decide again. Its code is MIT but
    its published weights are CC BY-NC-SA per its own release notes, and
    Riffsheet's one-click install is only ever offered for engines whose bytes it
    may fetch on a user's behalf without dragging a non-commercial term into
    their work. A guided entry would be the honest alternative and is a product
    decision, not a licensing one; it is not being made here. See NOTICE.md.
*/

namespace
{
    //== guide steps ===========================================================

    /*  THE ONE COPY OF THE MUSCRIPTOR INSTALL GUIDE.

        This is the wording the setup screen has always shown, moved here from
        webcore/src/ui/settings.ts: the page now renders engineStatus().guideSteps
        instead of a TypeScript copy of it, so the guide the engine ships with is
        the guide the user reads. Two of the web harness's checks read this text
        through the bridge - that the guide is STEPS rather than a paragraph, and
        that the steps name python, venv and `pip install` - so shortening a step
        here breaks a test over there. That is the intended coupling.

        Each step is a heading and the line you actually type, because the
        renderer draws `what` in a <strong> and `detail` in a <div class="dim">.
        A flat string list would silently lose half of every step, and the half
        it loses is the half with the command in it. */
    constexpr GuideStep kMuScriptorSteps[] = {
        { "Install Python 3.10 or newer",
          "From python.org, or \"brew install python@3.10\" if you use Homebrew. Nothing else "
          "here works without it." },
        { "Make a folder for the engine and a virtual environment inside it",
          "In Terminal: mkdir -p ~/muscriptor && cd ~/muscriptor && python3 -m venv venv — a "
          "virtual environment keeps this install out of the way of everything else on your "
          "machine." },
        { "Install MuScriptor into it",
          "Still in Terminal: ./venv/bin/pip install muscriptor — this is the part that takes a "
          "few minutes." },
        { "Accept the model licence, once",
          "The weights are gated: sign in at huggingface.co, open the MuScriptor model page, "
          "accept the licence, then make a Read token in your account settings. The engine asks "
          "for it the first time and never again." },
        { "Come back and press Check again",
          "Riffsheet looks in ~/muscriptor/venv by itself, along with everywhere else listed "
          "below. Installed it somewhere unusual? Use the custom-location box under this list." }
    };

    //== instrument strengths, for the cards ===================================

    constexpr const char* kBpStrengths[]    = { "Guitar", "Piano", "Voice", "Any single instrument" };
    constexpr const char* kMuStrengths[]    = { "Bass", "Guitar", "Piano", "Drums", "35 groups" };
    constexpr const char* kBassStrengths[]  = { "Bass" };
    constexpr const char* kPianoStrengths[] = { "Piano" };

    //== the table =============================================================
    //
    // Field order is EngineManifest's, and every field is present. The comments
    // name the ones that carry a decision rather than a value.

    constexpr EngineManifest kEngines[] =
    {
      //-------------------------------------------------------------------- basic-pitch
      { "basic-pitch", "Basic Pitch", "Built in",
        "Always available. Fast, general purpose, works with no setup at all.",
        "https://github.com/spotify/basic-pitch",
        AdapterKind::inProcessOnnx, InstallKind::bundled, Concurrency::inProcess,
        kBpStrengths, 4,
        /*acceptsInstrumentConstraint*/ false,
        /*producesBeatGrid*/ false, /*producesConfidence*/ true, /*producesVelocity*/ false,
        /*needsGainNorm*/ false, /*needsTuningNorm*/ false, /*preferredInputRate*/ 22050.0,
        "Apache-2.0", "Apache-2.0", /*redistributable*/ true,
        {},                       // no download: it is in the binary
        "", "", "", "", 230 * 1024, 120,
        nullptr, 0 },

      //--------------------------------------------------------------------- muscriptor
      { "muscriptor", "MuScriptor", "Best quality - guided setup",
        "The highest quality engine Riffsheet can drive, and the only one that knows "
        "35 instrument groups. Its weights are non-commercial and gated, so Riffsheet "
        "can never install it for you.",
        "https://pypi.org/project/muscriptor/",
        AdapterKind::httpServerVenv, InstallKind::guide, Concurrency::exclusiveMachineWide,
        kMuStrengths, 5,
        /*acceptsInstrumentConstraint*/ true,
        /*producesBeatGrid*/ true, /*producesConfidence*/ false, /*producesVelocity*/ false,
        /*needsGainNorm*/ true,  /*needsTuningNorm*/ true,  /*preferredInputRate*/ 0.0,
        "see upstream", "CC BY-NC 4.0 (gated)", /*redistributable*/ false,
        {},                       // NEVER a download. This is the AGPL red line.
        "engine", "", "", "", 0, 1800,
        kMuScriptorSteps, 5 },

      //------------------------------------------------------------------------ bass-v2
      // Code AND weights are MIT (LICENSE in the repo, and the model repository
      // carries no separate terms), which is what makes a one-click install of
      // somebody else's bytes acceptable at all.
      //
      // THE URL IS A COMMIT, NOT A TAG OR A BRANCH. GitHub builds this zip from
      // the tree at 2964b39a on demand; pinning the commit is what makes the
      // sha256 meaningful, and if upstream's archive bytes ever change the
      // install fails loudly instead of installing something else. The two
      // checkpoints are pinned separately in EngineInstaller.cpp at a Hugging
      // Face revision, for the same reason - a manifest row carries one
      // download, and this engine needs three files.
      { "bass-v2", "Instrument-Agnostic AMT", "One-click",
        "A bass transcriber that is very good at exactly that, and carries a general "
        "checkpoint for everything else. About 1 GB once its Python environment is built.",
        "https://github.com/anime-song/instrument-agnostic-amt",
        AdapterKind::sidecarVenv, InstallKind::oneClick, Concurrency::exclusiveMachineWide,
        kBassStrengths, 1,
        /*acceptsInstrumentConstraint*/ true,
        /*producesBeatGrid*/ false, /*producesConfidence*/ false, /*producesVelocity*/ true,
        /*needsGainNorm*/ true, /*needsTuningNorm*/ true, /*preferredInputRate*/ 44100.0,
        "MIT", "MIT", /*redistributable*/ true,
        { "https://codeload.github.com/anime-song/instrument-agnostic-amt/zip/"
          "2964b39af3d122ab087010e562ead53005c57e5d",
          "faa967a9c6f967ab352688b1298164156c712b36a805c4700c52550c0aef51f0",
          582715, ArchiveKind::zip, "", "" },
        "bass-v2",
        "{python} {script} --root {root} --audio {audio} --output-midi {midi} "
        "--output-json {json} --instruments {instruments}",
        "amt_sidecar.py",
        // Measured on this machine after a real install: 803 MB of files, 876 MB
        // allocated. The card quotes the second one, because that is the space
        // that actually disappears. Peak RSS is 1.7 GB during a job, which is
        // why this engine takes the machine-wide turn like MuScriptor does.
        ">=3.10,<3.13", 880ll * 1024 * 1024, 1700,
        nullptr, 0 },

      //----------------------------------------------------------------------- transkun
      // No download at all: the weights are inside the wheel, and the wheel and
      // every one of its dependencies are hash-pinned in
      // Resources/engines/transkun-requirements-<platform>.txt, which pip is run
      // with --require-hashes against.
      { "transkun", "Transkun v2", "One-click",
        "Piano only, and very good at it. Everything it needs comes from pip.",
        "https://pypi.org/project/transkun/",
        AdapterKind::sidecarPipCli, InstallKind::oneClick, Concurrency::exclusiveMachineWide,
        kPianoStrengths, 1,
        /*acceptsInstrumentConstraint*/ false,
        /*producesBeatGrid*/ false, /*producesConfidence*/ false, /*producesVelocity*/ true,
        /*needsGainNorm*/ true, /*needsTuningNorm*/ true, /*preferredInputRate*/ 44100.0,
        "MIT", "MIT", /*redistributable*/ true,
        { "", "", 0, ArchiveKind::pipPackage, "", "transkun==2.0.1" },
        "transkun", "{bin} {audio} {midi} --device cpu", "",
        // Measured after a real install: 920 MB of files, 996 MB allocated.
        // Peak RSS 1.4 GB during a job.
        ">=3.10,<3.13", 1000ll * 1024 * 1024, 1400,
        nullptr, 0 },
    };

    constexpr int kEngineCount = (int) (sizeof (kEngines) / sizeof (kEngines[0]));

    //== the compile-time audit ================================================

    constexpr bool sameString (const char* a, const char* b)
    {
        int i = 0;

        for (; a[i] != '\0' && b[i] != '\0'; ++i)
            if (a[i] != b[i])
                return false;

        return a[i] == b[i];
    }

    constexpr bool catalogIsSane()
    {
        for (int i = 0; i < kEngineCount; ++i)
        {
            if (! EngineCatalog::entryIsSane (kEngines[i]))
                return false;

            // Ids are the wire value everywhere, so two rows sharing one would
            // make selectEngine() ambiguous rather than wrong-looking.
            for (int j = i + 1; j < kEngineCount; ++j)
                if (sameString (kEngines[i].id, kEngines[j].id))
                    return false;
        }

        return true;
    }

    static_assert (catalogIsSane(),
                   "EngineCatalog: an entry is unpinned, unverified, or would ship "
                   "bytes it has no right to ship. See engine-architecture.md §2.3.");

    // The two ids the resolver names. Spelled once, proved to exist once, so a
    // rename of a row cannot leave `auto` pointing at nothing.
    constexpr const char* kAutoPreferredId = "muscriptor";
    constexpr const char* kFallbackId      = "basic-pitch";

    constexpr bool containsId (const char* id)
    {
        for (int i = 0; i < kEngineCount; ++i)
            if (sameString (kEngines[i].id, id))
                return true;

        return false;
    }

    static_assert (containsId (kAutoPreferredId),
                   "EngineCatalog: `auto` prefers an engine that is not in the table.");
    static_assert (containsId (kFallbackId),
                   "EngineCatalog: `auto` falls back to an engine that is not in the table.");
}

//==============================================================================
const EngineManifest* EngineCatalog::begin() noexcept   { return kEngines; }
const EngineManifest* EngineCatalog::end() noexcept     { return kEngines + kEngineCount; }
int EngineCatalog::size() noexcept                      { return kEngineCount; }

const EngineManifest* EngineCatalog::find (const juce::String& id) noexcept
{
    for (const auto& engine : kEngines)
        if (id == engine.id)
            return &engine;

    return nullptr;
}

bool EngineCatalog::isOffered (const EngineManifest& engine) noexcept
{
    return ! (engine.install == InstallKind::oneClick && ! engine.redistributable);
}

std::vector<const EngineManifest*> EngineCatalog::offered()
{
    std::vector<const EngineManifest*> result;

    for (const auto& engine : kEngines)
        if (isOffered (engine))
            result.push_back (&engine);

    return result;
}

const char* EngineCatalog::autoPreferredId() noexcept { return kAutoPreferredId; }
const char* EngineCatalog::fallbackId() noexcept      { return kFallbackId; }

juce::String EngineCatalog::installName (InstallKind kind)
{
    switch (kind)
    {
        case InstallKind::bundled:  return "bundled";
        case InstallKind::oneClick: return "one-click";
        case InstallKind::guide:    return "guide";
    }

    return "guide";
}
