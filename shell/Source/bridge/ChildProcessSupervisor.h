#pragma once
#include <JuceHeader.h>

/**
    A child process that is READ FROM FOR ITS WHOLE LIFE, and that cannot be
    left behind.

    ---- the two bugs this exists for --------------------------------------

    (1) NOBODY WAS READING THE PIPE. MuScriptorServer launched its Python server
    with `wantStdOut | wantStdErr`, which on every platform means "give me a
    pipe", and then read that pipe exactly once - in the error path, after the
    child had already died. A pipe is a fixed-size buffer in the kernel (64 KB
    on macOS, often 4 KB on Linux with a fresh page). When it fills, the child's
    next `write()` does not fail and does not drop the line: IT BLOCKS. For ever,
    or until somebody reads.

    So the failure was: MuScriptor prints model-loading progress, HuggingFace
    prints a download bar, torch prints its usual warnings - and 64 KB in, the
    server stops dead, mid-import, before it ever binds its port. Riffsheet then
    waited out the whole startup timeout probing a port nothing was listening on,
    reported "the server took too long to start", and left the wedged process
    sitting there holding a gigabyte. The more the engine had to say - a first
    run, a model download, a warning about the user's hardware - the more
    reliably it hung, which is the wrong way round and is what made it look like
    an engine problem rather than ours.

    A drain thread fixes it because there is nothing else that can. Reading the
    pipe on the thread that is also waiting for the port cannot work: JUCE's read
    blocks, and a startup poll that blocks is not a poll.

    (2) A CANCELLED STARTUP LEAKED THE CHILD. `ensureRunning()` returned the
    moment the user cancelled, and the timeout path returned too - both with the
    child still running, still loading a model, and with no handle left anywhere
    that would end it. Ownership was implicit and therefore optional. Here it is
    a destructor: whoever holds the supervisor holds the process, and letting go
    kills and reaps it.

    ---- why it is its own file -------------------------------------------

    Same reason PlaybackResampler.h is: MuScriptorServer.cpp cannot be linked
    into the unit tests (it drags WebResources, juce_gui_extra and a WebView in
    behind it), so anything left inside it is untestable by construction - which
    is exactly how a pipe nobody drained survived. This file needs juce_core and
    nothing else, so ChildProcessSupervisorTests drives THE SAME CLASS the plugin
    runs, against a deliberately chatty real child.

    ---- why this is not ProcessOutputReader -------------------------------

    `engines/sidecar/ProcessOutputReader.h` also drains a child on a thread, and
    the two are deliberately not merged. That one is for a subprocess that RUNS
    TO COMPLETION - pip, a sidecar transcription, Audiveris - so it borrows a
    `juce::ChildProcess` it does not own and its finishing move is
    `finishAfterProcessExit()`. There is no such moment for a server that stays
    up for the length of a session, and borrowing a process is exactly the
    ownership gap that leaked children here. This class owns instead, and the
    difference shows up in its one non-obvious rule: kill first, join second.

    ---- what it does not do ----------------------------------------------

    It does not keep the output. It keeps the LAST `maxLogBytes` of it - enough
    for a stack trace or a pip error, bounded so that a child stuck in a retry
    loop for an hour costs a fixed amount of memory. The whole point is that
    reading is unconditional; a drain that could run out of room would be a drain
    that stops draining.

    THREADING. start(), kill(), isRunning() and getOutput() may be called from
    any thread except the audio thread. Only the drain thread ever reads the
    pipe - JUCE reads it through a `FILE*` and two threads in `fread` on one
    `FILE*` is undefined behaviour, which is also why there is no public
    "read the rest now".
*/
class ChildProcessSupervisor final : private juce::Thread
{
public:
    /** @param threadName  what this shows up as in a debugger / Instruments.
        @param maxLogBytes how much of the tail to keep. */
    explicit ChildProcessSupervisor (const juce::String& threadName, int maxLogBytes = 64 * 1024);

    /** Kills and reaps. See the class comment: this is the ownership. */
    ~ChildProcessSupervisor() override;

    /** Launches `args` with both pipes attached and starts draining immediately.
        False if the process could not be launched at all. */
    bool start (const juce::StringArray& args);

    /** True while the child is alive, AND while its output is still being
        drained. Also reaps the child once it has exited, so a false here means
        three things at once: no child, no zombie, and no more output to come.

        The drain is part of the answer because the child reaches its own exit as
        soon as it has written its last byte into the PIPE - at which point up to
        a pipe buffer of it is still unread. A caller that treated exit alone as
        "done" would read a log with its tail missing, which is the half that
        says what went wrong. See the note in the .cpp. */
    bool isRunning() const;

    /** The tail of everything the child has said so far, stdout and stderr
        interleaved the way the terminal would have shown them.

        May lag by up to one read buffer while the child is alive and quiet -
        JUCE's read fills its buffer or waits for EOF - and is complete once
        `isRunning()` has gone false, which is why that answer waits for the
        drain and not merely for the child. Diagnostics are read after a failure,
        so the lag is never on the path that matters. */
    juce::String getOutput() const;

    /** Ends the child and waits for it to be gone. Safe to call twice, and safe
        to call when nothing was ever started.

        THE ORDER INSIDE IS NOT AN IMPLEMENTATION DETAIL: the child is killed
        first and the drain thread joined second, because the drain thread is
        blocked in a read that only the child's death unblocks. Joining first
        would hang until the child felt like talking. */
    void kill();

    /** True once the child has been started and not yet killed - i.e. whether
        this object is holding an operating-system resource. */
    bool hasChild() const;

private:
    void run() override;
    void append (const char* data, int numBytes);

    juce::CriticalSection processLock;   // guards `child`
    juce::CriticalSection logLock;       // guards `log`
    std::unique_ptr<juce::ChildProcess> child;
    juce::String log;
    const int maxLogBytes;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ChildProcessSupervisor)
};
