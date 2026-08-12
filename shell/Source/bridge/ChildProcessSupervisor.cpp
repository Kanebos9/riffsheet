#include "ChildProcessSupervisor.h"

ChildProcessSupervisor::ChildProcessSupervisor (const juce::String& threadName, int maxLogBytesIn)
    : juce::Thread (threadName), maxLogBytes (juce::jmax (1024, maxLogBytesIn))
{
}

ChildProcessSupervisor::~ChildProcessSupervisor()
{
    kill();
}

bool ChildProcessSupervisor::start (const juce::StringArray& args)
{
    kill();

    auto process = std::make_unique<juce::ChildProcess>();

    // Both pipes. On every platform JUCE points stdout and stderr at the SAME
    // pipe, which is why one drain covers both and why the log below reads the
    // way the terminal would have shown it.
    if (! process->start (args, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
        return false;

    {
        const juce::ScopedLock sl (processLock);
        child = std::move (process);
    }

    {
        const juce::ScopedLock sl (logLock);
        log.clear();
    }

    // Draining starts NOW, not when somebody gets round to asking for output.
    // The child can fill the kernel's pipe buffer and wedge inside its own
    // imports before it has printed anything a human would call interesting.
    startThread (juce::Thread::Priority::background);
    return true;
}

bool ChildProcessSupervisor::hasChild() const
{
    const juce::ScopedLock sl (processLock);
    return child != nullptr;
}

bool ChildProcessSupervisor::isRunning() const
{
    const bool processAlive = [this]
    {
        const juce::ScopedLock sl (processLock);
        // juce::ChildProcess::isRunning() waitpid()s with WNOHANG, so asking the
        // question is also what reaps an exited child. That is deliberate: "no
        // zombie" and "not running" have to be the same answer.
        return child != nullptr && child->isRunning();
    }();

    // ...AND THE DRAIN HAS TO HAVE CAUGHT UP. The child exits the moment it has
    // written its last byte INTO THE PIPE, not when we have read it, so at that
    // instant up to a whole pipe buffer - 64 KB on macOS - is still sitting in
    // the kernel with the drain thread working through it. Reporting "finished"
    // there hands the caller a log that is missing its TAIL, and the tail is the
    // traceback: the only reason anybody reads this log at all.
    //
    // That is not hypothetical. MuScriptorServer's startup-failure path is
    // exactly `! isRunning()` followed by `getOutput()`, so a Python server that
    // died loudly - the noisier the failure, the more it had written - reported
    // its own death with the explanation cut off.
    //
    // The drain thread breaks on EOF, which it can only see once the pipe is
    // empty and closed, so "the thread has exited" IS "there is nothing more to
    // come". Held together, a false here means the child is reaped AND the log
    // is whole, which is what both the header and every caller already assumed.
    //
    // A grandchild holding the write end keeps the thread alive past the child
    // (the class comment covers this); callers poll against a deadline, so that
    // degrades to the timeout they already have rather than to a wrong answer.
    return processAlive || isThreadRunning();
}

juce::String ChildProcessSupervisor::getOutput() const
{
    const juce::ScopedLock sl (logLock);
    return log;
}

void ChildProcessSupervisor::kill()
{
    // ---- ORDER MATTERS, AND THIS IS THE WHOLE COMMENT --------------------
    //
    // 1. kill the child   - the drain thread is sitting inside a blocking read
    //                       on the child's pipe, and the only thing that returns
    //                       from that read is the child's end of the pipe
    //                       closing, which happens when it dies.
    // 2. join the thread  - now it can finish.
    // 3. reap and release - after the thread is gone, so nothing is reading a
    //                       ChildProcess while it is being destroyed.
    //
    // Doing 2 before 1 hangs until the child feels like talking, which for a
    // model load is minutes and for a wedged process is never.

    {
        const juce::ScopedLock sl (processLock);

        if (child != nullptr && child->isRunning())
            child->kill();
    }

    // Generous, because the read only has to notice an EOF. It can still be
    // missed if the child left a grandchild holding the write end of the pipe -
    // a shell wrapper, a Python multiprocessing worker - in which case JUCE ends
    // the thread the hard way. That is a leaked read, once, at teardown; the
    // alternative is a DAW that will not quit.
    stopThread (4000);

    std::unique_ptr<juce::ChildProcess> dying;

    {
        const juce::ScopedLock sl (processLock);
        dying = std::move (child);
    }

    if (dying != nullptr)
        dying->waitForProcessToFinish (2000);
}

void ChildProcessSupervisor::run()
{
    juce::ChildProcess* process = nullptr;

    {
        const juce::ScopedLock sl (processLock);
        process = child.get();
    }

    if (process == nullptr)
        return;

    // Small on purpose. JUCE's read fills the buffer or waits for EOF, so the
    // buffer size is also how far behind getOutput() can be while the child is
    // alive and quiet. 1 KB keeps that lag to about one log line's worth while
    // still costing one read per kilobyte rather than one per line.
    char buffer[1024];

    while (! threadShouldExit())
    {
        const auto numRead = process->readProcessOutput (buffer, (int) sizeof (buffer));

        // 0 is end-of-file: the child closed its end, which means it has exited.
        // There is nothing left to drain and nothing to be gained by spinning.
        if (numRead <= 0)
            break;

        append (buffer, numRead);
    }

    // The pointer is not touched after this. kill() only releases the
    // ChildProcess once this thread has been joined.
}

void ChildProcessSupervisor::append (const char* data, int numBytes)
{
    const juce::ScopedLock sl (logLock);

    // A read can land in the middle of a multi-byte sequence and juce::String
    // will substitute for the broken half. These are engine logs, not content:
    // a mangled glyph once every 1024 bytes of non-ASCII output is a fair price
    // for never having to buffer a partial character across reads.
    log += juce::String::fromUTF8 (data, numBytes);

    // The bound is in characters, which for the ASCII these children emit is
    // the same number as bytes. What matters is that it IS bounded: a child in
    // a retry loop for an hour must cost a fixed amount of memory, or the drain
    // becomes its own leak.
    if (log.length() > maxLogBytes)
        log = log.substring (log.length() - maxLogBytes);
}
