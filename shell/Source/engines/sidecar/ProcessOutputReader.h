#pragma once
#include <JuceHeader.h>
#include <atomic>

/**
    Reads a child process's stdout+stderr on its own thread, with a bound.

    WHY IT IS A THREAD AND NOT A POLL. juce::ChildProcess::readProcessOutput()
    may block until the child writes anything at all. A worker that called it
    inline would stop polling its own cancellation flag and its own deadline for
    as long as the child stayed quiet - which for a model loading half a gigabyte
    of weights is tens of seconds. Keeping the read on its own thread is what
    makes "cancel" mean cancel.

    WHY IT IS BOUNDED. A subprocess that decides to print a progress bar to
    stderr can produce megabytes a second. The tail is what a failure message
    needs, so the head is what gets dropped, with a line saying so.

    WHERE IT CAME FROM AND WHERE IT IS GOING. This was BeatProcessOutputReader,
    a private class inside MuScriptorServer.cpp, serving the Python beat sidecar
    that wave 4 deleted. It is not deleted with it: every subprocess engine
    (bass_v2, Transkun, SOME - engine-architecture.md 1.3c) has exactly this
    problem, and SidecarAdapter in wave 5 is its next caller. Until then
    ProcessOutputReaderTests keeps it compiled and honest rather than letting it
    rot as an unbuilt header.
*/
class ProcessOutputReader final : private juce::Thread
{
public:
    /** `maxChars` is the size of the tail kept; everything earlier is dropped. */
    explicit ProcessOutputReader (juce::ChildProcess& process, int maxChars = 128 * 1024)
        : juce::Thread ("Riffsheet process output"), child (process), limit (maxChars)
    {
    }

    ~ProcessOutputReader() override
    {
        processFinished.store (true, std::memory_order_release);
        stopThread (2000);
    }

    bool start() { return startThread(); }

    /** Call once the process has exited. Joins the reader and returns everything
        it captured. */
    juce::String finishAfterProcessExit()
    {
        processFinished.store (true, std::memory_order_release);
        waitForThreadToExit (-1);
        return output;
    }

private:
    void run() override
    {
        for (;;)
        {
            char bytes[4096];
            const auto count = child.readProcessOutput (bytes, (int) sizeof (bytes));

            if (count > 0)
            {
                output += juce::String::fromUTF8 (bytes, count);

                if (output.length() > limit)
                    output = "[earlier output omitted]\n" + output.substring (output.length() - limit);

                continue;
            }

            if (processFinished.load (std::memory_order_acquire))
                return;

            juce::Thread::sleep (10);
        }
    }

    juce::ChildProcess& child;
    const int limit;
    std::atomic<bool> processFinished { false };
    juce::String output;
};
