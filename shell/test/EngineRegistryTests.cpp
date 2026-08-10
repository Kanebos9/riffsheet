#include <JuceHeader.h>
#include <atomic>
#include <stdexcept>
#include <thread>
#include "EngineRegistry.h"

/**
    What `auto` means, what an explicit choice means when the engine cannot run,
    and the promise that the engine is always given back.

    THE LIFECYCLE TEST IS THE IMPORTANT ONE. NativeBridge's transcribe job cannot
    be linked into a console app - it needs a plugin host - so the discipline it
    depends on lives in EngineJob, and this is where it is proved: prepare then
    transcribe then endOfJob, in that order, and endOfJob on the cancel path and
    the failure path too. An engine that is not given back is a Python process
    holding 1.5 GB until the DAW quits.
*/
namespace
{
    /** An adapter that does nothing but remember what it was asked to do. */
    class FakeAdapter final : public EngineAdapter
    {
    public:
        FakeAdapter (const EngineManifest& row, EngineAdapter::Availability initial)
            : availability (initial), manifestRow (row)
        {
        }

        //== the script ========================================================
        juce::StringArray calls;             // "prepare", "transcribe", "endOfJob", "rediscover"
        bool prepareSucceeds = true;
        bool transcribeSucceeds = true;
        bool cancelDuringTranscribe = false;
        Availability availability;
        juce::String error;

        //== the interface =====================================================
        const EngineManifest& manifest() const noexcept override { return manifestRow; }

        Capabilities capabilities() const override { return {}; }

        Status status() const override
        {
            Status out;
            out.availability = availability;
            out.stateName = availability == Availability::ready ? "ready" : "stopped";
            out.location = "in the test";
            out.error = error;
            return out;
        }

        void rediscover() override { calls.add ("rediscover"); }

        bool prepare (std::function<void (const juce::String&)> onProgress,
                      std::function<bool()> shouldCancel) override
        {
            calls.add ("prepare");

            if (onProgress)
                onProgress ("starting the fake engine");

            if (shouldCancel && shouldCancel())
                return false;

            if (! prepareSucceeds)
            {
                error = "the fake engine refused to start";
                return false;
            }

            return true;
        }

        void endOfJob() override { calls.add ("endOfJob"); }

        juce::var transcribe (const AudioInput& input,
                              const Request& request,
                              Callbacks callbacks,
                              juce::String& transcribeError) override
        {
            calls.add ("transcribe");
            lastFile = input.file;
            lastInstruments = request.instruments;
            lastClientId = request.clientId;

            if (callbacks.onProgress)
                callbacks.onProgress (1, 2);

            if (cancelDuringTranscribe && callbacks.shouldCancel && callbacks.shouldCancel())
            {
                transcribeError = "cancelled";
                return {};
            }

            if (! transcribeSucceeds)
            {
                transcribeError = "the fake engine broke";
                return {};
            }

            auto* object = new juce::DynamicObject();
            object->setProperty ("notes", juce::Array<juce::var>{});
            return juce::var (object);
        }

        juce::File lastFile;
        juce::StringArray lastInstruments;
        juce::String lastClientId;

    private:
        const EngineManifest& manifestRow;
    };

    /** A settings file of our own, so the tests never touch the real one. */
    struct ScratchSettings
    {
        ScratchSettings()
            : file (juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getChildFile ("riffsheet-engine-registry-tests")
                        .getChildFile (juce::Uuid().toDashedString() + ".json")),
              settings (file)
        {
            file.getParentDirectory().createDirectory();
        }

        ~ScratchSettings() { file.deleteFile(); }

        const juce::File file;
        EngineSettings settings;
    };
}

class EngineRegistryTests final : public juce::UnitTest
{
public:
    EngineRegistryTests() : juce::UnitTest ("EngineRegistry", "EngineRegistry") {}

    void runTest() override
    {
        const auto* muScriptorRow = EngineCatalog::find (EngineCatalog::autoPreferredId());
        const auto* bundledRow = EngineCatalog::find (EngineCatalog::fallbackId());

        if (muScriptorRow == nullptr || bundledRow == nullptr)
        {
            beginTest ("the catalog has the two rows the resolver names");
            expect (false, "EngineCatalog is missing the preferred or fallback engine");
            return;
        }

        // The environment override is a hard one by design, so a developer with
        // RIFFSHEET_ENGINE exported would otherwise see these fail for the wrong
        // reason. Say so instead of pretending.
        const auto overridden = EngineSettings::environmentOverride().isNotEmpty();

        beginTest ("auto + MuScriptor installed -> MuScriptor");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::installed));
            registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));

            const auto resolution = registry.resolve();

            if (! overridden)
            {
                expectEquals (resolution.configured, juce::String ("auto"));
                expectEquals (resolution.resolved, juce::String (muScriptorRow->id));
                expect (resolution.adapter != nullptr);
                expect (resolution.reason.isNotEmpty(), "a resolution with no sentence is not a resolution");
                expect (resolution.reason.containsIgnoreCase (muScriptorRow->name));
            }
        }

        beginTest ("auto + MuScriptor NOT installed -> the bundled engine");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::notInstalled));
            registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));

            const auto resolution = registry.resolve();

            if (! overridden)
            {
                expectEquals (resolution.resolved, juce::String (bundledRow->id));
                expect (resolution.reason.containsIgnoreCase (bundledRow->name));
            }
        }

        beginTest ("auto + a MuScriptor that failed to start still means MuScriptor");
        {
            // `broken` is "installed, and its last start failed". Moving the user
            // silently onto a different engine - with different output - hides
            // the one error they can act on. It is also what engineStatus's
            // long-standing `engineInstalled` field has always said about this
            // state, and that field must not change meaning.
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::broken));
            registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));

            if (! overridden)
                expectEquals (registry.resolve().resolved, juce::String (muScriptorRow->id));

            expect (EngineRegistry::isPresent (EngineAdapter::Availability::broken));
        }

        beginTest ("an explicit choice + MuScriptor installed -> the choice, not MuScriptor");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::ready));
            registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));

            const auto outcome = registry.select (bundledRow->id);
            expect (outcome.ok);

            const auto resolution = registry.resolve();

            if (! overridden)
            {
                expectEquals (resolution.configured, juce::String (bundledRow->id));
                expectEquals (resolution.resolved, juce::String (bundledRow->id));
                expect (resolution.reason.containsIgnoreCase ("you chose"));
            }
        }

        beginTest ("an explicit choice that cannot run falls back, and says why");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::notInstalled));
            registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));

            expect (registry.select (muScriptorRow->id).ok,
                    "selecting a not-yet-installed engine is how the card's Select works");

            const auto resolution = registry.resolve();

            if (! overridden)
            {
                expectEquals (resolution.configured, juce::String (muScriptorRow->id));
                expectEquals (resolution.resolved, juce::String (bundledRow->id));
                expect (resolution.reason.containsIgnoreCase (muScriptorRow->name));
                expect (resolution.reason.containsIgnoreCase (bundledRow->name));
            }
        }

        beginTest ("with nothing else to fall back to, the choice keeps its own honest error");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::notInstalled));

            const auto resolution = registry.resolve();

            if (! overridden)
            {
                expectEquals (resolution.resolved, juce::String (muScriptorRow->id),
                              "falling back to an equally unavailable engine would replace one honest "
                              "error with a vaguer one");
                expect (resolution.adapter != nullptr);
            }
        }

        beginTest ("an engine in the table but not in this build resolves to something that runs");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::ready));

            expect (registry.select (bundledRow->id).ok);
            const auto resolution = registry.resolve();

            if (! overridden)
            {
                expectEquals (resolution.configured, juce::String (bundledRow->id));
                expectEquals (resolution.resolved, juce::String (muScriptorRow->id));
                expect (resolution.adapter != nullptr);
            }
        }

        beginTest ("an unknown engine is refused, and never stored");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::ready));

            const auto outcome = registry.select ("no-such-engine");
            expect (! outcome.ok);
            expect (outcome.error.contains ("no-such-engine"));

            if (! overridden)
                expectEquals (registry.configuredEngine(), juce::String ("auto"));
        }

        beginTest ("resolveExplicit answers for one engine, and says when it cannot");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::ready));

            const auto known = registry.resolveExplicit (muScriptorRow->id);
            expect (known.adapter != nullptr);
            expectEquals (known.resolved, juce::String (muScriptorRow->id));

            const auto missing = registry.resolveExplicit (bundledRow->id);
            expect (missing.adapter == nullptr, "an engine with no adapter must not pretend");
            expect (missing.reason.isNotEmpty());

            const auto unknown = registry.resolveExplicit ("no-such-engine");
            expect (unknown.adapter == nullptr);
            expect (unknown.reason.contains ("unknown engine"));
        }

        beginTest ("the choice survives a new registry, which is what two windows do");
        {
            ScratchSettings scratch;

            {
                EngineRegistry registry { scratch.settings };
                registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::ready));
                registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));
                expect (registry.select (bundledRow->id).ok);
            }

            EngineSettings reopened { scratch.file };
            EngineRegistry registry { reopened };
            registry.add (std::make_unique<FakeAdapter> (*muScriptorRow, EngineAdapter::Availability::ready));
            registry.add (std::make_unique<FakeAdapter> (*bundledRow, EngineAdapter::Availability::ready));

            if (! overridden)
                expectEquals (registry.resolve().resolved, juce::String (bundledRow->id));
        }

        //== the lifecycle =====================================================

        beginTest ("a job runs prepare, transcribe, endOfJob - in that order");
        {
            FakeAdapter adapter { *muScriptorRow, EngineAdapter::Availability::ready };

            {
                EngineJob job { adapter };
                expect (job.prepare ({}, {}));

                juce::String error;
                EngineAdapter::AudioInput input;
                input.file = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                 .getChildFile ("riff.wav");

                EngineAdapter::Request request;
                request.clientId = "riffsheet-test";
                request.instruments.add ("electric_bass");

                const auto result = job.transcribe (input, request, {}, error);
                expect (! result.isVoid());
                expect (error.isEmpty());
                expectEquals (adapter.lastClientId, juce::String ("riffsheet-test"));
                expectEquals (adapter.lastInstruments.joinIntoString (","), juce::String ("electric_bass"));
                expectEquals (adapter.calls.joinIntoString (","), juce::String ("prepare,transcribe"),
                              "endOfJob must not run before the job is over");
            }

            expectEquals (adapter.calls.joinIntoString (","), juce::String ("prepare,transcribe,endOfJob"));
        }

        beginTest ("endOfJob runs when the engine refuses to start");
        {
            FakeAdapter adapter { *muScriptorRow, EngineAdapter::Availability::installed };
            adapter.prepareSucceeds = false;

            {
                EngineJob job { adapter };
                expect (! job.prepare ({}, {}));
                // The bridge returns from the worker right here; the scope exit
                // is the whole safety net.
            }

            expectEquals (adapter.calls.joinIntoString (","), juce::String ("prepare,endOfJob"));
            expect (adapter.status().error.isNotEmpty());
        }

        beginTest ("endOfJob runs when the job is cancelled");
        {
            FakeAdapter adapter { *muScriptorRow, EngineAdapter::Availability::ready };
            adapter.cancelDuringTranscribe = true;

            juce::String error;

            {
                EngineJob job { adapter };
                expect (job.prepare ({}, [] { return false; }));

                EngineAdapter::Callbacks callbacks;
                callbacks.shouldCancel = [] { return true; };

                const auto result = job.transcribe ({}, {}, callbacks, error);
                expect (result.isVoid());
            }

            expectEquals (error, juce::String ("cancelled"),
                          "\"cancelled\" is the reserved error string");
            expectEquals (adapter.calls.joinIntoString (","), juce::String ("prepare,transcribe,endOfJob"));
        }

        beginTest ("endOfJob runs when the engine fails mid-transcription");
        {
            FakeAdapter adapter { *muScriptorRow, EngineAdapter::Availability::ready };
            adapter.transcribeSucceeds = false;

            juce::String error;

            {
                EngineJob job { adapter };
                expect (job.prepare ({}, {}));
                expect (job.transcribe ({}, {}, {}, error).isVoid());
            }

            expect (error.isNotEmpty());
            expectEquals (adapter.calls.joinIntoString (","), juce::String ("prepare,transcribe,endOfJob"));
        }

        beginTest ("endOfJob runs even when the job throws on the way out");
        {
            FakeAdapter adapter { *muScriptorRow, EngineAdapter::Availability::ready };

            try
            {
                EngineJob job { adapter };
                expect (job.prepare ({}, {}));
                throw std::runtime_error ("something in the worker went wrong");
            }
            catch (const std::runtime_error&)
            {
            }

            expectEquals (adapter.calls.joinIntoString (","), juce::String ("prepare,endOfJob"));
        }

        //== the in-process turn ===============================================

        beginTest ("an in-process job is visible as busy, and is serialised");
        {
            ScratchSettings scratch;
            EngineRegistry registry { scratch.settings };

            expect (! registry.isLocalBusy());

            std::atomic<bool> secondStarted { false };
            std::thread other;

            {
                EngineRegistry::LocalJob job { registry };
                expect (registry.isLocalBusy(),
                        "an in-process engine holds no file lock, so this is the only thing that "
                        "stops engineStatus() reporting idle while it works");

                other = std::thread ([&]
                {
                    EngineRegistry::LocalJob queued { registry };
                    secondStarted = true;
                });

                juce::Thread::sleep (150);
                expect (! secondStarted.load(),
                        "two in-process jobs in one process must not run at once - eight plugin "
                        "instances in one REAPER is the case this exists for");
            }   // our turn ends here

            other.join();
            expect (secondStarted.load(), "the queued job must take its turn once ours is over");
            expect (! registry.isLocalBusy(), "the busy flag must clear when the job ends");
        }

        beginTest ("wire spellings");
        {
            expectEquals (EngineRegistry::stateName (EngineAdapter::Availability::ready),
                          juce::String ("ready"));
            expectEquals (EngineRegistry::stateName (EngineAdapter::Availability::installed),
                          juce::String ("installed"));
            expectEquals (EngineRegistry::stateName (EngineAdapter::Availability::notInstalled),
                          juce::String ("not-installed"));
            expectEquals (EngineRegistry::stateName (EngineAdapter::Availability::broken),
                          juce::String ("broken"));

            expect (EngineRegistry::isPresent (EngineAdapter::Availability::ready));
            expect (EngineRegistry::isPresent (EngineAdapter::Availability::installed));
            expect (EngineRegistry::isPresent (EngineAdapter::Availability::broken),
                    "broken is installed-and-failing, not missing");
            expect (! EngineRegistry::isPresent (EngineAdapter::Availability::notInstalled));
        }
    }
};

static EngineRegistryTests engineRegistryTests;
