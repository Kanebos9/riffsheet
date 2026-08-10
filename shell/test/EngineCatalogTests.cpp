#include <JuceHeader.h>
#include "EngineCatalog.h"

/**
    The catalog's invariants, at runtime as well as at compile time.

    EngineCatalog.cpp already static_asserts entryIsSane() over the shipping
    table, so a bad row cannot compile. What that cannot do is prove the RULE is
    right: a predicate that accidentally returns true for everything would pass
    the assertion silently. So these tests run the same predicate over rows built
    to be wrong, and check it says no for the reason it is there.
*/
class EngineCatalogTests final : public juce::UnitTest
{
public:
    EngineCatalogTests() : juce::UnitTest ("EngineCatalog", "EngineCatalog") {}

    void runTest() override
    {
        beginTest ("the table is not empty and every row is sane");
        {
            expect (EngineCatalog::size() > 0);

            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
                expect (EngineCatalog::entryIsSane (*row),
                        juce::String ("row is not sane: ") + row->id);
        }

        beginTest ("ids are unique, lowercase and hyphenated");
        {
            juce::StringArray seen;

            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
            {
                const juce::String id (row->id);
                expect (! seen.contains (id), "duplicate engine id: " + id);
                seen.add (id);

                expect (id.isNotEmpty());
                expect (id == id.toLowerCase(), "id is not lowercase: " + id);
                expect (! id.containsChar (' '), "id contains a space: " + id);
                expect (! id.containsChar ('_'), "id uses an underscore, not a hyphen: " + id);
            }
        }

        beginTest ("a bundled engine must be redistributable - its bytes are in the release");
        {
            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
                if (row->install == InstallKind::bundled)
                    expect (row->redistributable, juce::String (row->id) + " ships in the binary "
                                                  "but is marked non-redistributable");

            auto bad = makeRow ("bundled-but-not-redistributable", InstallKind::bundled);
            bad.redistributable = false;
            expect (! EngineCatalog::entryIsSane (bad));
        }

        beginTest ("a guided engine must have no download at all - the AGPL red line");
        {
            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
                if (row->install == InstallKind::guide)
                {
                    expect (juce::String (row->download.url).isEmpty(),
                            juce::String (row->id) + " is guide-only but carries a download URL");
                    expect (juce::String (row->download.pipSpec).isEmpty(),
                            juce::String (row->id) + " is guide-only but carries a pip spec");
                }

            auto withUrl = makeRow ("guide-with-a-download", InstallKind::guide);
            withUrl.download.url = "https://example.com/weights.zip";
            expect (! EngineCatalog::entryIsSane (withUrl));

            auto withPip = makeRow ("guide-with-a-pip-spec", InstallKind::guide);
            withPip.download.pipSpec = "muscriptor==1.0";
            expect (! EngineCatalog::entryIsSane (withPip));
        }

        beginTest ("a guided engine must carry its steps");
        {
            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
                if (row->install == InstallKind::guide)
                {
                    expect (row->guideSteps != nullptr && row->guideStepCount > 0,
                            juce::String (row->id) + " is guide-only with no steps");

                    for (int i = 0; i < row->guideStepCount; ++i)
                    {
                        expect (juce::String (row->guideSteps[i].what).isNotEmpty());
                        expect (juce::String (row->guideSteps[i].detail).isNotEmpty(),
                                "a step with no detail loses half of itself in the UI");
                    }
                }

            auto stepless = makeRow ("guide-with-no-steps", InstallKind::guide);
            stepless.guideSteps = nullptr;
            stepless.guideStepCount = 0;
            expect (! EngineCatalog::entryIsSane (stepless));
        }

        beginTest ("MuScriptor's guide still names python, venv and pip install");
        {
            // The same three facts webcore's harness checks on the rendered
            // screen. Wave 2 renders these steps instead of its own copy, so a
            // shell-side edit that quietly drops one would break the setup
            // screen without the web tests being touched.
            const auto* muScriptor = EngineCatalog::find ("muscriptor");
            expect (muScriptor != nullptr);

            juce::String all;

            for (int i = 0; muScriptor != nullptr && i < muScriptor->guideStepCount; ++i)
                all << muScriptor->guideSteps[i].what << " " << muScriptor->guideSteps[i].detail << "\n";

            expect (all.containsIgnoreCase ("python"));
            expect (all.containsIgnoreCase ("venv"));
            expect (all.containsIgnoreCase ("pip install"));

            // The web harness also refuses a step that is too short to be an
            // instruction - a heading on its own is not a step. Same rule here,
            // so a shell-side edit fails on this side first.
            for (int i = 0; muScriptor != nullptr && i < muScriptor->guideStepCount; ++i)
            {
                const juce::String what (muScriptor->guideSteps[i].what);
                const juce::String detail (muScriptor->guideSteps[i].detail);
                expect (what.length() + detail.length() > 20,
                        "step " + juce::String (i + 1) + " is too short to be an instruction");
            }
        }

        beginTest ("a one-click engine must be pinned, hashed and https");
        {
            auto pending = makeRow ("pending-hash", InstallKind::oneClick);
            pending.download.url = "https://github.com/example/engine/releases/download/v1/e.zip";
            pending.download.sha256 = kSha256Pending;      // the sentinel wave 5 replaces
            pending.download.bytes = 1024;
            pending.download.archive = ArchiveKind::zip;
            expect (! EngineCatalog::entryIsSane (pending), "SHA256-PENDING must not be acceptable");

            auto good = pending;
            good.download.sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            expect (EngineCatalog::entryIsSane (good));

            auto uppercaseHash = good;
            uppercaseHash.download.sha256 = "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef";
            expect (! EngineCatalog::entryIsSane (uppercaseHash), "hashes are compared lowercase");

            auto shortHash = good;
            shortHash.download.sha256 = "0123456789abcdef";
            expect (! EngineCatalog::entryIsSane (shortHash));

            auto plainHttp = good;
            plainHttp.download.url = "http://github.com/example/engine/releases/download/v1/e.zip";
            expect (! EngineCatalog::entryIsSane (plainHttp), "http:// must be refused");

            auto noBytes = good;
            noBytes.download.bytes = 0;
            expect (! EngineCatalog::entryIsSane (noBytes), "the byte count is the disk check");

            auto notRedistributable = good;
            notRedistributable.redistributable = false;
            expect (! EngineCatalog::entryIsSane (notRedistributable));

            auto pipWithoutSpec = makeRow ("pip-without-a-spec", InstallKind::oneClick);
            pipWithoutSpec.download.archive = ArchiveKind::pipPackage;
            expect (! EngineCatalog::entryIsSane (pipWithoutSpec));

            auto pipWithSpec = pipWithoutSpec;
            pipWithSpec.download.pipSpec = "transkun==0.1.2";
            expect (EngineCatalog::entryIsSane (pipWithSpec));
        }

        beginTest ("ids are rejected when they are not lowercase-hyphen");
        {
            expect (! EngineCatalog::entryIsSane (makeRow ("Basic-Pitch", InstallKind::bundled)));
            expect (! EngineCatalog::entryIsSane (makeRow ("basic_pitch", InstallKind::bundled)));
            expect (! EngineCatalog::entryIsSane (makeRow ("basic pitch", InstallKind::bundled)));
            expect (! EngineCatalog::entryIsSane (makeRow ("-basic", InstallKind::bundled)));
            expect (! EngineCatalog::entryIsSane (makeRow ("basic-", InstallKind::bundled)));
            expect (! EngineCatalog::entryIsSane (makeRow ("", InstallKind::bundled)));
            expect (EngineCatalog::entryIsSane (makeRow ("bass-v2", InstallKind::bundled)));
        }

        beginTest ("an engine whose bytes we may not fetch is not offered at all");
        {
            auto unverified = makeRow ("unverified-weights", InstallKind::oneClick);
            unverified.redistributable = false;
            expect (! EngineCatalog::isOffered (unverified),
                    "a card with an Install button that must refuse is worse than no card");

            auto guideOnly = makeRow ("guide-only", InstallKind::guide);
            guideOnly.redistributable = false;
            expect (EngineCatalog::isOffered (guideOnly),
                    "a guided engine is offered - it just installs itself elsewhere");

            for (const auto* row : EngineCatalog::offered())
                expect (EngineCatalog::isOffered (*row));

            expect ((int) EngineCatalog::offered().size() <= EngineCatalog::size());
        }

        beginTest ("the resolver's two ids are real rows");
        {
            const auto* preferred = EngineCatalog::find (EngineCatalog::autoPreferredId());
            const auto* fallback = EngineCatalog::find (EngineCatalog::fallbackId());

            expect (preferred != nullptr, "`auto` prefers an engine that is not in the table");
            expect (fallback != nullptr, "`auto` falls back to an engine that is not in the table");

            if (fallback != nullptr)
                expect (fallback->install == InstallKind::bundled,
                        "the fallback must need no setup at all");

            expect (EngineCatalog::find ("no-such-engine") == nullptr);
        }

        beginTest ("install kinds have their wire spellings");
        {
            expectEquals (EngineCatalog::installName (InstallKind::bundled), juce::String ("bundled"));
            expectEquals (EngineCatalog::installName (InstallKind::oneClick), juce::String ("one-click"));
            expectEquals (EngineCatalog::installName (InstallKind::guide), juce::String ("guide"));
        }
    }

private:
    /** A minimal row that passes, so each test can break exactly one thing. */
    static EngineManifest makeRow (const char* id, InstallKind install)
    {
        EngineManifest row {};
        row.id = id;
        row.name = "Test Engine";
        row.tierLabel = "Test";
        row.summary = "For the tests.";
        row.sourceUrl = "https://example.com";
        row.adapter = AdapterKind::inProcessOnnx;
        row.install = install;
        row.concurrency = Concurrency::inProcess;
        row.instrumentStrengths = nullptr;
        row.instrumentStrengthCount = 0;
        row.redistributable = true;
        row.codeLicense = "MIT";
        row.weightsLicense = "MIT";
        row.runtimeSubdir = "";
        row.argvTemplate = "";
        row.scriptResource = "";
        row.pythonRequirement = "";
        row.guideSteps = install == InstallKind::guide ? &placeholderStep() : nullptr;
        row.guideStepCount = install == InstallKind::guide ? 1 : 0;
        return row;
    }

    static const GuideStep& placeholderStep()
    {
        static constexpr GuideStep step { "Do the thing", "In the way the thing is done." };
        return step;
    }
};

static EngineCatalogTests engineCatalogTests;
