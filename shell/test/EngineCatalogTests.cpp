#include <JuceHeader.h>
#include "EngineCatalog.h"

#include <cstring>
#include <limits>

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

        beginTest ("every id the resolver names is a real row, and the order is a real order");
        {
            const auto order = EngineCatalog::autoOrder();

            expect (! order.empty(), "`auto` with no order to walk has nothing to resolve to");

            juce::StringArray seen;

            for (const auto* id : order)
            {
                expect (EngineCatalog::find (id) != nullptr,
                        juce::String ("`auto` names an engine that is not in the table: ") + id);
                expect (! seen.contains (id),
                        juce::String ("`auto` names the same engine twice: ") + id);
                seen.add (id);
            }

            const auto* preferred = EngineCatalog::find (EngineCatalog::autoPreferredId());
            const auto* fallback = EngineCatalog::find (EngineCatalog::fallbackId());

            expect (preferred != nullptr, "`auto` prefers an engine that is not in the table");
            expect (fallback != nullptr, "`auto` falls back to an engine that is not in the table");

            // The head and tail of the order ARE those two, rather than two more
            // constants that could drift away from it.
            expectEquals (juce::String (order.front()), juce::String (EngineCatalog::autoPreferredId()));
            expectEquals (juce::String (order.back()), juce::String (EngineCatalog::fallbackId()));

            if (fallback != nullptr)
            {
                expect (fallback->install == InstallKind::bundled,
                        "the fallback must need no setup at all");
                expect (! EngineCatalog::runsInPage (*fallback),
                        "the last resort has to be one the shell can drive itself");
            }

            expect (EngineCatalog::find ("no-such-engine") == nullptr);
        }

        beginTest ("the engine that runs in the page is bundled, weightless and offered");
        {
            auto found = 0;

            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
            {
                if (! EngineCatalog::runsInPage (*row))
                    continue;

                ++found;
                expect (row->install == InstallKind::bundled,
                        "an engine that IS the app cannot be downloaded or installed");
                expect (row->redistributable, "its bytes are ours");
                expectEquals ((int) row->approxDiskBytes, 0,
                              "it is inside the web bundle that has to be there anyway");
                expect (row->download.url == nullptr || juce::String (row->download.url).isEmpty(),
                        "there is nothing to fetch");
                expect (EngineCatalog::isOffered (*row), "it is the default; it has to have a card");
                expect (! row->producesVelocity,
                        "onset strength is relative to the take and is not a dynamic marking");
                expect (row->producesConfidence,
                        "every note carries the share of its frames that agreed");
            }

            expectEquals (found, 1, "exactly one in-page engine is expected today");
        }

        beginTest ("install kinds have their wire spellings");
        {
            expectEquals (EngineCatalog::installName (InstallKind::bundled), juce::String ("bundled"));
            expectEquals (EngineCatalog::installName (InstallKind::oneClick), juce::String ("one-click"));
            expectEquals (EngineCatalog::installName (InstallKind::guide), juce::String ("guide"));
        }

        //== the mojibake test =================================================
        //
        // The install guide was drawing "a"-with-a-hat where an em dash belongs.
        // The cause was not the literal: it was juce::String's `const char*`
        // constructor, which is CharPointer_ASCII - one byte per character - so
        // the three UTF-8 bytes of an em dash arrived as three Latin-1
        // characters and went onto the wire as three. manifestText() decodes
        // them properly, and these two tests are what stop it being quietly
        // removed or forgotten at the next call site.
        //
        // The property is exact: decoding UTF-8 and re-encoding it is the
        // identity function if and only if the decode was right. So every
        // string in the table must come back byte-for-byte.

        beginTest ("manifestText round-trips every table string byte for byte");
        {
            bool sawNonAscii = false;

            forEachManifestString ([&] (const juce::String& label, const char* raw)
            {
                const auto decoded = manifestText (raw);
                const auto limit = std::numeric_limits<int>::max();

                expect (juce::CharPointer_UTF8::isValidString (raw, limit),
                        label + " is not valid UTF-8 in the source");

                expect (std::strcmp (decoded.toRawUTF8(), raw) == 0,
                        label + " did not survive the round trip: got \"" + decoded + "\"");

                if (! juce::CharPointer_ASCII::isValidString (raw, limit))
                {
                    sawNonAscii = true;

                    // The broken path, spelled out. If this ever STOPS
                    // differing, juce::String's `const char*` constructor has
                    // changed and the wrapper may be reconsidered - until then
                    // this is the proof that it is load-bearing rather than
                    // decoration.
                    expect (juce::String (raw) != decoded,
                            label + " is non-ASCII, yet the raw juce::String path agrees with the "
                            "decoded one - the test is not testing anything");
                }
            });

            expect (sawNonAscii,
                    "no string in the engine table is non-ASCII any more, so this test can no "
                    "longer catch the bug it exists for. Either restore the em dash in the "
                    "MuScriptor guide or delete this test deliberately.");
        }

        beginTest ("the JSON the bridge emits carries no mangled bytes");
        {
            // The bridge's own construction, reproduced: guideSteps is an array
            // of {what, detail} objects and this is exactly how
            // NativeBridge::makeEngineStatusVar() builds it.
            juce::Array<juce::var> guideSteps;

            for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
                for (int i = 0; i < row->guideStepCount; ++i)
                {
                    auto* step = new juce::DynamicObject();
                    step->setProperty ("what", manifestText (row->guideSteps[i].what));
                    step->setProperty ("detail", manifestText (row->guideSteps[i].detail));
                    guideSteps.add (juce::var (step));
                }

            expect (! guideSteps.isEmpty(), "no engine in the table has a guide to check");

            const auto json = juce::JSON::toString (juce::var (guideSteps));
            logMessage ("guideSteps JSON as the bridge emits it:");
            logMessage (json);

            // U+00E2 is what an em dash's first byte becomes when UTF-8 is read
            // as Latin-1, and it is the visible half of the reported garbage.
            // U+0080..U+009F are the invisible other half - C1 controls, which
            // no honest prose contains and which are the real fingerprint.
            for (auto p = json.getCharPointer();;)
            {
                const auto c = p.getAndAdvance();

                if (c == 0)
                    break;

                expect (c != (juce::juce_wchar) 0x00e2,
                        "the emitted JSON contains U+00E2 - UTF-8 read as Latin-1 again");
                expect (! (c >= 0x0080 && c <= 0x009f),
                        "the emitted JSON contains a C1 control character, which is what mangled "
                        "UTF-8 leaves behind");
            }

            // And the em dash really is in there, as one character.
            expect (json.containsChar (juce::juce_wchar (0x2014))
                        || json.contains ("\\u2014"),
                    "the em dash did not reach the JSON at all, in either encoding");
        }
    }

private:
    /** Every string in the shipping table that can reach a human, with a label
        saying where it came from so a failure names the row and the field. The
        machine tokens - id, sourceUrl, the licence strings - are deliberately in
        here too: they are ASCII today, and the point of the test is that nothing
        in the table can mangle, including the fields nobody expects to change.
        (The install-layout fields - runtimeSubdir, argvTemplate, scriptResource,
        pythonRequirement - are paths and argv, never shown, and are left out.) */
    template <typename Fn>
    static void forEachManifestString (Fn&& visit)
    {
        for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
        {
            const juce::String where (row->id);

            visit (where + ".id",             row->id);
            visit (where + ".name",           row->name);
            visit (where + ".tierLabel",      row->tierLabel);
            visit (where + ".summary",        row->summary);
            visit (where + ".sourceUrl",      row->sourceUrl);
            visit (where + ".codeLicense",    row->codeLicense);
            visit (where + ".weightsLicense", row->weightsLicense);

            for (int i = 0; i < row->instrumentStrengthCount; ++i)
                visit (where + ".instrumentStrengths[" + juce::String (i) + "]",
                       row->instrumentStrengths[i]);

            for (int i = 0; i < row->guideStepCount; ++i)
            {
                visit (where + ".guideSteps[" + juce::String (i) + "].what",
                       row->guideSteps[i].what);
                visit (where + ".guideSteps[" + juce::String (i) + "].detail",
                       row->guideSteps[i].detail);
            }
        }
    }

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
        row.concurrency = EngineConcurrency::inProcess;
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
