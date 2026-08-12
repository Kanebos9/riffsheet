#include <JuceHeader.h>
#include "ModelCatalog.h"

/**
    Which MuScriptor size `auto` asks for.

    THE RULE THESE TESTS EXIST TO PIN DOWN reversed: auto used to prefer the
    LARGEST installed weights and step down under memory pressure, and it now
    prefers the LIGHTEST installed weights, full stop. Riffsheet shares a machine
    with a DAW session, so a heavier model is a choice somebody makes (by
    installing only that size, or with RIFFSHEET_MUSCRIPTOR_MODEL) and never
    something the app picks for them. The fresh-install case moved with it: no
    weights on disk asks for "small", the size the setup guide installs, where it
    used to ask for "medium" and quietly disagree with the rest of the product.

    chooseAutomatically() takes the installed list and both memory figures as
    ARGUMENTS, which is what makes all of this testable without a HuggingFace
    cache, a machine of a particular size, or a running server. Nothing here
    touches the disk. installedModels() does read the real cache, so the one test
    that calls it asserts only what is true on any machine - the ordering and
    membership contract - and never that a particular size is present.
*/
class ModelCatalogTests final : public juce::UnitTest
{
public:
    ModelCatalogTests() : juce::UnitTest ("ModelCatalog", "ModelCatalog") {}

    void runTest() override
    {
        // 8 GB, and roughly what this development machine reports free. The
        // ceiling rule (a size may not want more than 40% of physical) admits
        // small and medium here and refuses large, so this one number exercises
        // both halves of the pick.
        constexpr int eightGb = 8192;
        constexpr int plentyFree = 6000;

        beginTest ("nothing installed asks for small, not medium");
        {
            const auto choice = ModelCatalog::chooseAutomatically ({}, eightGb, plentyFree);

            expectEquals (choice.model, juce::String ("small"),
                          "a fresh machine must be sent to the size the setup guide installs");
            expect (choice.reason.containsIgnoreCase ("small"),
                    "and the sentence must name it: " + choice.reason);
            expect (! choice.reason.containsIgnoreCase ("medium"),
                    "no medium anywhere in the fresh-install story: " + choice.reason);
        }

        beginTest ("nothing installed still asks for small on a huge machine");
        {
            // The old rule's motivation was "bigger is better when it fits", so
            // this is the case that would have regressed first: a 64 GB machine
            // with an empty cache must still be sent to small, because nothing
            // about a big machine means the person wants a big download.
            const auto choice = ModelCatalog::chooseAutomatically ({}, 65536, 48000);
            expectEquals (choice.model, juce::String ("small"));
        }

        beginTest ("nothing installed asks for small even when memory is unknown");
        {
            // ramTotalMb <= 0 is "could not tell", which fitsInPhysicalRam()
            // answers true for rather than hiding every size. The empty-cache
            // branch runs before any of that and must not depend on it.
            const auto choice = ModelCatalog::chooseAutomatically ({}, 0, 0);
            expectEquals (choice.model, juce::String ("small"));
        }

        beginTest ("all three installed picks the lightest");
        {
            const auto choice = ModelCatalog::chooseAutomatically ({ "small", "medium", "large" },
                                                                   eightGb, plentyFree);

            expectEquals (choice.model, juce::String ("small"),
                          "lightest-first, even with large sitting right there");
            expect (choice.reason.containsIgnoreCase ("lightest"),
                    "the sentence must say why: " + choice.reason);
        }

        beginTest ("the input order does not decide the answer");
        {
            // The list comes from installedModels(), and a caller (or a future
            // version of that function) must not be able to change the pick by
            // handing the sizes over in a different order.
            const juce::StringArray orders[] = {
                { "small", "medium", "large" },
                { "large", "medium", "small" },
                { "medium", "large", "small" }
            };

            for (const auto& installed : orders)
                expectEquals (ModelCatalog::chooseAutomatically (installed, eightGb, plentyFree).model,
                              juce::String ("small"),
                              "order-independent: " + installed.joinIntoString (","));
        }

        beginTest ("a huge machine with everything installed still picks the lightest");
        {
            // 64 GB clears the 40% ceiling for large as well, so nothing is
            // dropped and this is purely the ranking's decision.
            const auto choice = ModelCatalog::chooseAutomatically ({ "small", "medium", "large" },
                                                                   65536, 48000);
            expectEquals (choice.model, juce::String ("small"),
                          "roominess is not a reason to load 5 GB of weights nobody asked for");
        }

        beginTest ("medium alone is used, because nothing lighter is installed");
        {
            const auto choice = ModelCatalog::chooseAutomatically ({ "medium" }, eightGb, plentyFree);

            expectEquals (choice.model, juce::String ("medium"),
                          "lightest INSTALLED - never a size that would start a download");
            expect (choice.reason.containsIgnoreCase ("medium"));
        }

        beginTest ("large alone is used when the machine can carry it");
        {
            const auto choice = ModelCatalog::chooseAutomatically ({ "large" }, 65536, 48000);
            expectEquals (choice.model, juce::String ("large"));
        }

        beginTest ("medium and large installed picks medium");
        {
            const auto choice = ModelCatalog::chooseAutomatically ({ "medium", "large" },
                                                                   65536, 48000);
            expectEquals (choice.model, juce::String ("medium"));
        }

        beginTest ("the physical-RAM ceiling still drops sizes this machine cannot carry");
        {
            // 8 GB admits small (2.3 GB of machine) and medium (4.5 GB) and
            // refuses large (12.5 GB). With only medium and large on disk the
            // answer is therefore medium - the ceiling, not the ranking.
            expect (ModelCatalog::fitsInPhysicalRam ("small", eightGb));
            expect (ModelCatalog::fitsInPhysicalRam ("medium", eightGb));
            expect (! ModelCatalog::fitsInPhysicalRam ("large", eightGb));

            const auto choice = ModelCatalog::chooseAutomatically ({ "medium", "large" },
                                                                   eightGb, plentyFree);
            expectEquals (choice.model, juce::String ("medium"));
        }

        beginTest ("a machine too small for anything installed gets the smallest installed");
        {
            // 2 GB physical: small wants 2.3 GB of machine, so the ceiling drops
            // every size. The answer must still be a size that is ON THE DISK,
            // and the sentence must say the machine is tight rather than claim a
            // comfortable fit.
            const auto choice = ModelCatalog::chooseAutomatically ({ "medium", "large" }, 2048, 800);

            expectEquals (choice.model, juce::String ("medium"),
                          "the smallest installed, not small - small is not here");
            expect (choice.reason.containsIgnoreCase ("tight"),
                    "and it must admit the machine is tight: " + choice.reason);
        }

        beginTest ("free memory can no longer change the answer, only the sentence");
        {
            // The old rule stepped DOWN a size when free memory was short. There
            // is nothing to step down to any more - the pick is already the
            // lightest thing on the disk - so the size must be identical with
            // plenty free and with almost nothing free, and only the wording may
            // differ.
            const juce::StringArray installed { "small", "medium" };

            const auto roomy = ModelCatalog::chooseAutomatically (installed, eightGb, plentyFree);
            const auto tight = ModelCatalog::chooseAutomatically (installed, eightGb, 300);

            expectEquals (tight.model, roomy.model);
            expectEquals (tight.model, juce::String ("small"));
            expect (tight.reason != roomy.reason,
                    "a machine short of memory should say so");
            expect (tight.reason.contains ("300"),
                    "and quote the figure it is talking about: " + tight.reason);
        }

        beginTest ("free memory of 0 means 'could not tell' and is not treated as pressure");
        {
            const auto unknown = ModelCatalog::chooseAutomatically ({ "small", "medium" }, eightGb, 0);
            const auto roomy   = ModelCatalog::chooseAutomatically ({ "small", "medium" }, eightGb, plentyFree);

            expectEquals (unknown.model, juce::String ("small"));
            expectEquals (unknown.reason, roomy.reason,
                          "0 free is unknown, and unknown must read like ordinary");
        }

        beginTest ("no answer is ever a size that is not installed");
        {
            // Exhaustive over the seven non-empty subsets of {small, medium,
            // large}, at four machine sizes. The pick must always be installed,
            // and must always be the lightest installed size unless the ceiling
            // dropped it - which is only possible when something lighter is
            // absent, so "lightest installed" holds for every case here.
            const int machines[] = { 2048, 4096, eightGb, 65536 };
            const juce::StringArray all { "small", "medium", "large" };

            for (int mask = 1; mask < 8; ++mask)
            {
                juce::StringArray installed;

                for (int bit = 0; bit < 3; ++bit)
                    if ((mask & (1 << bit)) != 0)
                        installed.add (all[bit]);

                for (const auto ram : machines)
                {
                    const auto choice = ModelCatalog::chooseAutomatically (installed, ram, ram / 2);

                    expect (installed.contains (choice.model),
                            "picked " + choice.model + " which is not installed ("
                                + installed.joinIntoString (",") + " on a " + juce::String (ram) + " MB machine)");

                    // The lightest installed size, in every one of the 28 cases:
                    // the ceiling can only remove candidates from the light end
                    // when nothing lighter is installed at all.
                    juce::String lightest;

                    for (const auto& size : all)
                        if (installed.contains (size) && lightest.isEmpty())
                            lightest = size;

                    expectEquals (choice.model, lightest,
                                  installed.joinIntoString (",") + " on a " + juce::String (ram) + " MB machine");
                }
            }
        }

        beginTest ("resolve() keeps an explicit size, and 'auto' goes through the lightest-first rule");
        {
            // The explicit path is what RIFFSHEET_MUSCRIPTOR_MODEL rides on
            // - the only way left to name a size deliberately - and it must
            // NOT be quietly re-ranked: a person who asks for medium gets
            // medium, download or not.
            const auto explicitChoice = ModelCatalog::resolve ("medium", eightGb, plentyFree);
            expectEquals (explicitChoice.model, juce::String ("medium"));
            expect (explicitChoice.reason.containsIgnoreCase ("you chose"),
                    "the sentence must own the decision: " + explicitChoice.reason);

            // Anything unrecognised is 'auto'. resolve() reads the real cache, so
            // the assertion is the invariant rather than a particular size: the
            // answer is a known size, and it agrees with what the pure function
            // says about the same installed list.
            for (const auto* configured : { "auto", "", "AUTO-ish nonsense" })
            {
                const auto resolved = ModelCatalog::resolve (configured, eightGb, plentyFree);
                expect (ModelCatalog::isKnownModelName (resolved.model),
                        juce::String ("resolve(\"") + configured + "\") answered " + resolved.model);
                expectEquals (resolved.model,
                              ModelCatalog::chooseAutomatically (ModelCatalog::installedModels(),
                                                                 eightGb, plentyFree).model,
                              "resolve() must not re-decide what chooseAutomatically() decided");
            }
        }

        beginTest ("installedModels() answers lightest first, whatever is on this machine");
        {
            // Reads the real HuggingFace cache, so it asserts only what is true
            // everywhere: every entry is a known size, there are no duplicates,
            // and the order is the lightest-first order the header promises -
            // the head of that list is what `auto` picks, so the ordering IS the
            // contract.
            const auto installed = ModelCatalog::installedModels();
            const auto expectedOrder = ModelCatalog::allModelNames();
            int lastIndex = -1;

            for (const auto& size : installed)
            {
                expect (ModelCatalog::isKnownModelName (size), "unknown size reported: " + size);

                const auto index = expectedOrder.indexOf (size);
                expect (index > lastIndex,
                        "installedModels() must be lightest first with no repeats, got "
                            + installed.joinIntoString (","));
                lastIndex = index;
            }

            expectEquals (expectedOrder.joinIntoString (","), juce::String ("small,medium,large"),
                          "allModelNames() is the lightest-first order the rest of this relies on");
        }

        beginTest ("the resident-size estimates are the ones the guide and the cards quote");
        {
            // Three numbers, in three places: this table, BRIDGE.md, and the
            // sentence the setup guide's licence step now prints ("about 0.9 GB
            // of memory while it runs"). If any of them moves, all of them move.
            expectEquals (ModelCatalog::estimatedResidentMb ("small"), 900);
            expectEquals (ModelCatalog::estimatedResidentMb ("medium"), 1800);
            expectEquals (ModelCatalog::estimatedResidentMb ("large"), 5000);
            expectEquals (ModelCatalog::estimatedResidentMb ("something else"), 1800,
                          "an unknown name takes the safe middle assumption");
        }

        beginTest ("--model is read out of a command line, and never guessed at");
        {
            // The other half of size honesty: this is the ONLY way Riffsheet can
            // learn the size of a server somebody else started, and it must
            // answer "" rather than anything hopeful when the flag is absent.
            expectEquals (ModelCatalog::modelFromCommandLine (
                              "/x/venv/bin/muscriptor serve --model small --port 8222"),
                          juce::String ("small"));
            expectEquals (ModelCatalog::modelFromCommandLine (
                              "/x/venv/bin/muscriptor serve --model=medium"),
                          juce::String ("medium"));
            expectEquals (ModelCatalog::modelFromCommandLine (
                              "/x/venv/bin/muscriptor serve --model \"large\""),
                          juce::String ("large"));

            // A path or a URL is a real model and NOT a size. It comes back as
            // itself, and MuScriptorServer is what refuses to call it a size -
            // proved here so the two halves cannot drift apart.
            const auto path = ModelCatalog::modelFromCommandLine (
                                  "muscriptor serve --model /Users/x/weights.safetensors");
            expectEquals (path, juce::String ("/Users/x/weights.safetensors"));
            expect (! ModelCatalog::isKnownModelName (path),
                    "a path must not pass as one of the three sizes");

            expectEquals (ModelCatalog::modelFromCommandLine ("muscriptor serve --port 8222"),
                          juce::String (), "no flag, no answer");
            expectEquals (ModelCatalog::modelFromCommandLine (""), juce::String ());
            expectEquals (ModelCatalog::modelFromCommandLine ("muscriptor serve --model"),
                          juce::String (), "a trailing flag with no value is not a size");
        }
    }
};

static ModelCatalogTests modelCatalogTests;
