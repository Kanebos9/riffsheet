#include <JuceHeader.h>
#include <cstdio>
#include <cstring>

/**
    The C++ unit tests.

    There were none anywhere in this repo before the multi-engine work, and
    BUILDING.md says out loud that a green CI badge means only "it compiles".
    Everything the engine work adds - a manifest with licensing invariants, a
    settings file two processes share, a resolver that decides which engine runs,
    a sha256 verifier and a mel filterbank later on - is exactly the kind of code
    that is silently wrong.

    juce::UnitTest, not GTest or Catch2: it is already in juce_core, already
    linked, and a first third-party test dependency would buy nothing here.

    This binary deliberately does NOT link the Riffsheet target. That target
    exports juce_recommended_lto_flags and the plugin client PUBLICly, so linking
    it would drag a plugin wrapper into a console app. The units under test are
    compiled straight into this binary instead - see shell/CMakeLists.txt.

    Run:  cmake -S shell -B shell/build_tests -DRIFFSHEET_BUILD_TESTS=ON
          cmake --build shell/build_tests
          ctest --test-dir shell/build_tests --output-on-failure
*/

namespace
{
    /** UnitTestRunner logs through juce::Logger, and a console app has no logger
        until it is given one - so without this the tests pass in silence and a
        failure says nothing. */
    class ConsoleLogger final : public juce::Logger
    {
    public:
        void logMessage (const juce::String& message) override
        {
            std::cout << message << std::endl;
        }
    };
}

namespace
{
    /*  THE CHATTY CHILD, and why the test binary is its own fixture.

        ChildProcessSupervisorTests has to prove that a subprocess which writes
        more than a pipe buffer's worth of output keeps running instead of
        blocking inside its own `write()`. That needs a real process that really
        talks - a mock cannot have the bug, because the bug is in the kernel's
        pipe, not in our code.

        Re-invoking this binary is how, rather than `/bin/sh -c 'while ...'`:
        it needs no shell quoting, no `timeout` versus `sleep` difference, and
        no "does this platform have that program" - the one program guaranteed
        to exist is the one already running. `--emit <kilobytes> <linger-ms>`
        writes that many KB across stdout and stderr as fast as it can, then
        stays alive for `linger-ms` so the parent can catch it running.

        It is checked before ANYTHING else in main() so that a child never
        constructs a logger, a UnitTestRunner or a MessageManager. */
    int runEmitMode (int kilobytes, int lingerMs)
    {
        // 64 printable characters plus a newline: one line is 65 bytes, so the
        // arithmetic below is exact and a truncated read is visible as a short
        // last line rather than as a plausible one.
        const char* line = "riffsheet-chatty-child-0123456789abcdefghijklmnopqrstuvwxyz-emit\n";
        const auto lineBytes = std::strlen (line);
        const auto totalBytes = (size_t) juce::jmax (0, kilobytes) * 1024u;

        for (size_t written = 0; written < totalBytes; written += lineBytes)
        {
            // Every tenth line to stderr, because JUCE points both pipes at the
            // same place and a drain that only covered stdout would still wedge
            // on a child that logs its errors.
            auto* stream = ((written / lineBytes) % 10 == 9) ? stderr : stdout;
            std::fwrite (line, 1, lineBytes, stream);
        }

        std::fflush (stdout);
        std::fflush (stderr);

        if (lingerMs > 0)
            juce::Thread::sleep (lingerMs);

        return 0;
    }
}

int main (int argc, char* argv[])
{
    if (argc > 3 && juce::String (argv[1]) == "--emit")
        return runEmitMode (juce::String (argv[2]).getIntValue(),
                            juce::String (argv[3]).getIntValue());

    ConsoleLogger logger;
    juce::Logger::setCurrentLogger (&logger);

    juce::String category;

    // One optional argument: a category, so `RiffsheetTests EngineSettings`
    // runs one file's worth while working on it.
    if (argc > 1)
        category = juce::String (argv[1]);

    juce::UnitTestRunner runner;
    // Assertions would pop a dialog / trap in a debugger rather than reporting a
    // failed test, which is not what a CI run wants.
    runner.setAssertOnFailure (false);
    runner.setPassesAreLogged (false);

    if (category.isNotEmpty())
        runner.runTestsInCategory (category);
    else
        runner.runAllTests();

    int failures = 0, tests = 0;

    for (int i = 0; i < runner.getNumResults(); ++i)
    {
        if (const auto* result = runner.getResult (i))
        {
            failures += result->failures;
            tests += result->passes + result->failures;
        }
    }

    std::cout << "\n" << (failures == 0 ? "PASS" : "FAIL")
              << " - " << (tests - failures) << "/" << tests << " checks"
              << std::endl;

    juce::Logger::setCurrentLogger (nullptr);
    return failures == 0 ? 0 : 1;
}
