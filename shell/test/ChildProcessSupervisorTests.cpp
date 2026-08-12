#include <JuceHeader.h>
#include "ChildProcessSupervisor.h"

/**
    A child process that talks too much, and one that will not stop.

    THE TWO BUGS UNDER TEST ARE BOTH INVISIBLE TO A MOCK. The first is a
    property of the operating system's pipe: a kernel pipe holds 64 KB on macOS,
    and a child whose output fills it does not fail and does not lose the line -
    its next write() blocks, for ever, until somebody reads. MuScriptor's server
    prints model-loading progress, and Riffsheet attached both its pipes and then
    read them exactly once, in the error path, after the child had already died.
    So a first run that had a lot to say wedged inside its own imports, never
    bound its port, and was reported as "took too long to start".

    No fake child can reproduce that, because the blocking is in the kernel and
    not in our code. These tests therefore start a REAL process that really
    writes a quarter of a megabyte - four pipe buffers - and the pass condition
    is simply that it reaches its own exit. Against the old undrained code the
    same child stops at 64 KB and stays there.

    The second is ownership: a startup that was cancelled or timed out returned
    with the child still running and no handle left that would end it. Here that
    is a destructor, so the test is that a lingering child is gone afterwards.

    THE CHILD IS THIS TEST BINARY, re-invoked as `--emit <kb> <linger-ms>` (see
    TestMain.cpp). It needs no shell, no platform-specific program and no
    quoting, and it is guaranteed to exist because it is already running.
*/
namespace
{
    /** `RiffsheetTests --emit <kilobytes> <linger-ms>`. */
    juce::StringArray chattyChild (int kilobytes, int lingerMs)
    {
        return { juce::File::getSpecialLocation (juce::File::currentExecutableFile).getFullPathName(),
                 "--emit", juce::String (kilobytes), juce::String (lingerMs) };
    }

    /** Polls until the child has exited, or gives up. Returns how long it took,
        or -1. A poll rather than a wait because "did it get to the end without
        being blocked by its own output" is the whole question. */
    int waitForExit (const ChildProcessSupervisor& supervisor, int timeoutMs)
    {
        const auto start = juce::Time::getMillisecondCounter();

        while ((int) (juce::Time::getMillisecondCounter() - start) < timeoutMs)
        {
            if (! supervisor.isRunning())
                return (int) (juce::Time::getMillisecondCounter() - start);

            juce::Thread::sleep (20);
        }

        return -1;
    }
}

class ChildProcessSupervisorTests final : public juce::UnitTest
{
public:
    ChildProcessSupervisorTests()
        : juce::UnitTest ("ChildProcessSupervisor", "ChildProcessSupervisor") {}

    void runTest() override
    {
        beginTest ("a child that fills four pipe buffers still reaches its own exit");
        {
            // THE REGRESSION LOCK. 256 KB is four times a macOS pipe buffer and
            // sixty times a small Linux one. Undrained, this child stops on its
            // 64 KB-th byte and never exits, and this test times out.
            // A megabyte of tail, not the default 64 KB, precisely so the byte
            // count below measures what was READ rather than what the bound
            // allowed to be kept - the two are indistinguishable at the default,
            // and 64 KB is also the pipe size, which would make a wedged child
            // and a trimmed log produce the same number.
            ChildProcessSupervisor supervisor ("test-chatty", 1024 * 1024);
            expect (supervisor.start (chattyChild (256, 0)), "could not start the test binary");
            expect (supervisor.hasChild());

            // THIS is the assertion. The child cannot reach its own exit unless
            // somebody consumed all 256 KB, because its 65537th byte is a
            // write() into a full pipe and write() into a full pipe does not
            // return.
            const auto elapsed = waitForExit (supervisor, 20000);
            expect (elapsed >= 0, "the child never exited - its pipe was not being drained");

            // ...and the output really arrived, rather than the child dying of
            // something else and the test passing for the wrong reason.
            const auto output = supervisor.getOutput();
            expect (output.contains ("riffsheet-chatty-child"), "no output was captured at all");
            expect (output.length() > 200 * 1024,
                    "only " + juce::String (output.length()) + " characters came back of ~262144");
        }

        beginTest ("stderr is drained too, not only stdout");
        {
            // The emit mode sends every tenth line to stderr. A drain that
            // covered one pipe would deadlock on the other, so the interesting
            // assertion is the one above; this one only proves both are reaching
            // the same log.
            ChildProcessSupervisor supervisor ("test-both-pipes", 1024 * 1024);
            expect (supervisor.start (chattyChild (128, 0)));
            expect (waitForExit (supervisor, 20000) >= 0);

            // 128 KB of 65-byte lines is ~2015 lines, ~201 of them on stderr.
            const auto lines = juce::StringArray::fromLines (supervisor.getOutput());
            expect (lines.size() > 1900, "only " + juce::String (lines.size()) + " lines");
        }

        beginTest ("the captured log is bounded, and it is the TAIL that survives");
        {
            // A child in a retry loop for an hour must cost a fixed amount of
            // memory. The tail is kept because that is where a stack trace ends
            // up; the head is the part nobody reads.
            ChildProcessSupervisor supervisor ("test-bounded", 8 * 1024);
            expect (supervisor.start (chattyChild (256, 0)));
            expect (waitForExit (supervisor, 20000) >= 0);

            const auto output = supervisor.getOutput();
            expect (output.length() <= 8 * 1024,
                    "the bound did not hold: " + juce::String (output.length()) + " characters");
            expect (output.contains ("riffsheet-chatty-child"), "the tail is not the child's output");
        }

        beginTest ("killing a child that is still running ends it, promptly");
        {
            // The cancelled-startup case: a process that would otherwise sit
            // there for a minute holding a model.
            ChildProcessSupervisor supervisor ("test-kill");
            expect (supervisor.start (chattyChild (8, 60000)));

            // Give it long enough to be unambiguously alive.
            juce::Thread::sleep (300);
            expect (supervisor.isRunning(), "the child was gone before it could be killed");

            const auto start = juce::Time::getMillisecondCounter();
            supervisor.kill();
            const auto took = (int) (juce::Time::getMillisecondCounter() - start);

            expect (! supervisor.isRunning(), "the child outlived kill()");
            expect (! supervisor.hasChild(), "the handle was not released");
            // The point of killing before joining the drain thread: joining
            // first would wait out the child's whole 60-second linger.
            expect (took < 8000, "kill() took " + juce::String (took) + " ms");
        }

        beginTest ("the destructor is the ownership");
        {
            // No explicit kill anywhere: letting go of the object is what has to
            // end the process, because the startup paths that leaked children
            // leaked them by returning early, not by calling the wrong function.
            const auto start = juce::Time::getMillisecondCounter();

            {
                ChildProcessSupervisor supervisor ("test-raii");
                expect (supervisor.start (chattyChild (8, 60000)));
                juce::Thread::sleep (300);
                expect (supervisor.isRunning());
            }

            // The object is gone, so there is nothing left to ask - which is the
            // point. What is measurable is that leaving the scope did not wait
            // out the child's full minute, i.e. the destructor killed rather
            // than merely joined.
            const auto took = (int) (juce::Time::getMillisecondCounter() - start);
            expect (took < 8000, "the destructor took " + juce::String (took) + " ms");
        }

        beginTest ("kill() is safe when nothing was started, and when called twice");
        {
            ChildProcessSupervisor never ("test-never-started");
            never.kill();
            never.kill();
            expect (! never.hasChild());
            expect (! never.isRunning());
            expect (never.getOutput().isEmpty());

            ChildProcessSupervisor twice ("test-killed-twice");
            expect (twice.start (chattyChild (4, 20000)));
            twice.kill();
            twice.kill();
            expect (! twice.hasChild());
        }

        beginTest ("starting again replaces the first child rather than orphaning it");
        {
            ChildProcessSupervisor supervisor ("test-restart");
            expect (supervisor.start (chattyChild (8, 60000)));
            juce::Thread::sleep (300);

            // The second start() kills the first child on its way in. Without
            // that, a retry loop around spawn() would leave one process per
            // attempt behind.
            expect (supervisor.start (chattyChild (8, 0)));
            expect (waitForExit (supervisor, 20000) >= 0);

            // The log belongs to the SECOND child: a restart that carried the
            // first one's output forward would report the wrong failure.
            expect (supervisor.getOutput().length() < 40 * 1024,
                    "the log was not reset for the new child");
        }
    }
};

static ChildProcessSupervisorTests childProcessSupervisorTests;
