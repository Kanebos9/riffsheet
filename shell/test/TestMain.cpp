#include <JuceHeader.h>

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

int main (int argc, char* argv[])
{
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
