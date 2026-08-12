#include <JuceHeader.h>
#include "SystemProbe.h"

/**
    The machine facts Settings' system line is drawn from.

    Only the CPU half is in here, and only its CONTRACT: these functions report
    the machine the tests happen to be running on, so there is no right answer to
    assert - "Apple M1" is right here and wrong on the CI Linux box. What can be
    asserted, and is exactly what the UI depends on, is that an unknown answer is
    a documented empty value rather than a plausible invention, that the values
    are self-consistent, and that they are cheap enough to sit inside a 2 Hz
    status poll.

    The memory half already had a caller proving it (engineStatus reports it every
    poll and the auto model rule reads it); the CPU half is new and had none.
*/
class SystemProbeTests final : public juce::UnitTest
{
public:
    SystemProbeTests() : juce::UnitTest ("SystemProbe", "SystemProbe") {}

    void runTest() override
    {
        beginTest ("the CPU name is either a real name or empty");
        {
            const auto name = SystemProbe::cpuName();

            // "" is the documented "the machine would not say". Anything else has
            // to look like a name a person would recognise on a settings line -
            // and must not be one of the words this file uses for unknown, which
            // is what a well-meant placeholder would look like.
            if (name.isNotEmpty())
            {
                expect (name.length() >= 3, "suspiciously short CPU name: " + name);
                expect (name == name.trim(), "the name must arrive trimmed: [" + name + "]");
                expect (! name.equalsIgnoreCase ("unknown") && ! name.equalsIgnoreCase ("n/a"),
                        "unknown must be reported as an empty string, not as a word: " + name);
            }

            // Cached, so a second call must agree with the first - a status poll
            // asks repeatedly and a line that flickered between two answers would
            // be worse than one that said nothing.
            expectEquals (SystemProbe::cpuName(), name);
        }

        beginTest ("core counts are positive and consistent");
        {
            const auto physical = SystemProbe::cpuPhysicalCores();
            const auto logical  = SystemProbe::cpuLogicalCores();

            // 0 is the documented unknown, so both are >= 0 by contract. On every
            // platform this actually builds for, juce_core knows the answer.
            expect (physical >= 0);
            expect (logical >= 0);

            if (physical > 0 && logical > 0)
                expect (logical >= physical,
                        "there cannot be fewer hardware threads than cores: "
                            + juce::String (logical) + " < " + juce::String (physical));

            // Never a guess derived from the other one: hyperthreading doubles
            // logical, Apple Silicon does not, and neither is inferred here.
            expect (physical <= 1024 && logical <= 1024, "implausible core count");
        }

        beginTest ("the load average is a real average or the documented -1");
        {
            const auto load = SystemProbe::cpuLoadOneMinute();

            expect (load >= 0.0 || juce::approximatelyEqual (load, -1.0),
                    "the only negative answer allowed is the -1 that means unknown");
            expect (load < 10000.0, "implausible load average: " + juce::String (load));

           #if JUCE_MAC || JUCE_LINUX
            expect (load >= 0.0, "getloadavg() must answer on this platform");

            // It is a LOAD AVERAGE and not a percentage. A machine running these
            // tests is busy, so anything that looked like a 0-100 percentage
            // would be the mistake worth catching - assert the property instead:
            // it is not divided by the core count anywhere in this file.
            if (const auto cores = SystemProbe::cpuPhysicalCores(); cores > 0)
                expect (load <= (double) cores * 64.0, "not a plausible load average for "
                                                       + juce::String (cores) + " cores: "
                                                       + juce::String (load));
           #endif
        }

        beginTest ("all four are cheap enough for the status poll");
        {
            // engineStatus() reads them every two seconds on the message thread.
            // The budget is deliberately loose (a hundred reads must cost less
            // than a quarter of a second) because this is a smoke test for "did
            // somebody make one of these fork a process", which is what the rest
            // of SystemProbe does and these four must never do.
            const auto start = juce::Time::getMillisecondCounterHiRes();

            for (int i = 0; i < 100; ++i)
            {
                SystemProbe::cpuName();
                SystemProbe::cpuPhysicalCores();
                SystemProbe::cpuLogicalCores();
                SystemProbe::cpuLoadOneMinute();
            }

            const auto elapsedMs = juce::Time::getMillisecondCounterHiRes() - start;
            expect (elapsedMs < 250.0, "100 reads took " + juce::String (elapsedMs, 1) + " ms");
        }

        beginTest ("the memory figures the same line quotes are still sane");
        {
            // Not new, but the system line prints these beside the CPU now, and
            // nothing else in the test binary asserts them.
            const auto total = SystemProbe::physicalRamMb();
            const auto free  = SystemProbe::availableRamMb();

            expect (total > 256, "a machine running these tests has more than 256 MB");
            expect (free >= 0, "0 is the documented unknown; negative is not a value");

            if (free > 0)
                expect (free <= total, "more memory free than the machine has");
        }
    }
};

static SystemProbeTests systemProbeTests;
