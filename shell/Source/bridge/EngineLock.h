#pragma once
#include <JuceHeader.h>
#include <mutex>

/**
    "Only one transcription runs on this machine at a time", enforced across
    processes, with the waiters queued in the order they arrived.

    WHY THIS EXISTS. MuScriptor holds about 1.5 GB resident while it works, and
    the server itself does one job at a time - a second client gets HTTP 503,
    which the user saw as a bare "busy with another job". On an 8 GB machine two
    Riffsheets transcribing at once is the difference between a slow
    transcription and a swap storm. And it really is several processes, not
    several objects in one: the standalone app and the plugin can both be open,
    and the user's own START-MEDIUM.command server may be busy with something
    that is not Riffsheet at all.

    HOW IT WORKS, and why it is two mechanisms rather than one.

      1. juce::InterProcessLock is the truth. On macOS and Linux it is an
         fcntl() write lock on a file, which the KERNEL releases the instant the
         owning process dies - so a hard-killed owner blocks nobody, not even for
         a second. That is the property the whole design hangs on and it is the
         reason there is no "steal the lock after N seconds" rule to get wrong.

         One trap: that lock is per PROCESS. A second thread in the same process
         calling enter() sails straight through JUCE's own reference count and
         gets told it succeeded. So it is paired with an ordinary in-process
         mutex, tried first, which is what actually keeps two plugin instances in
         one REAPER honest.

      2. A readable state file says WHO holds it, since when, and what they are
         doing - which the lock cannot report and the UI needs. It is refreshed
         by a heartbeat while held, so a stale file is recognisable rather than
         believed. It is never used to decide who gets the engine: it exists to
         be shown to a human.

    Queue order comes from one small "ticket" file per waiter, named with the
    millisecond it was created. Oldest ticket goes next. A waiter refreshes its
    own ticket every time round the loop; a ticket whose process is gone, or
    whose heartbeat is more than ten seconds old, is deleted by whoever notices.

    THREADING. acquire() blocks - sometimes for minutes. Call it only from the
    worker pool, exactly where transcribe() already runs. snapshot() and
    queueLength() are cheap (a few tiny file reads) and are safe on the message
    thread. Nothing here may ever be touched from the audio thread.
*/
class EngineLock
{
public:
    /** One per process. */
    static EngineLock& getInstance();

    /** Who has the engine right now, for showing to a human. */
    struct Snapshot
    {
        bool busy = false;              // somebody holds the engine
        bool heldByThisProcess = false; // ...and it is us
        int  holderPid = 0;
        juce::String holderLabel;       // "Riffsheet - riff.wav", say
        double heldForSec = 0.0;
        int  queueLength = 0;           // waiting jobs, everywhere, plus the holder
    };

    /** Waits our turn, then takes the engine. Returns false ONLY if
        `shouldAbandon` asked us to give up - there is no timeout, because a
        long wait is the correct answer to a long job in front of us.

        `onWaiting (queuePosition, holderLabel)` is called when our place in the
        queue changes and every couple of seconds otherwise, so the UI can say
        "waiting for another Riffsheet to finish" instead of looking hung.
        `queuePosition` is 1-based: 1 means "you are next".

        Must be released from the SAME thread that acquired it. */
    bool acquire (const juce::String& label,
                  std::function<bool()> shouldAbandon,
                  std::function<void (int queuePosition, const juce::String& holderLabel)> onWaiting);

    /** Takes the engine only if it is free THIS INSTANT, and never queues.

        For short housekeeping that must not interrupt anybody - closing an idle
        server is the only user - and never for a transcription, which must join
        the queue like everything else or it would jump the line. Returns false
        immediately when anyone holds it; the caller's answer to that is to give
        up and try again later, never to wait.

        Must be released from the same thread, exactly like acquire(). */
    bool tryAcquireNow (const juce::String& label);

    /** Gives the engine to whoever is next. Safe to call when we do not hold it.

        `finishedAJob` stamps the machine-wide "a transcription just finished"
        time that the idle shutdown counts its five minutes from. True for a
        transcription; false for housekeeping that merely borrowed the engine,
        which must not pretend to be work and push the clock forward. */
    void release (bool finishedAJob = true);

    /** When a transcription last finished ANYWHERE on this machine, in
        milliseconds since the epoch, or 0 when none ever has (or the record has
        been deleted).

        Machine-wide on purpose. Two plugin instances share one server, so
        instance A's idle timer must count from the last job on the machine, not
        from its own last job - otherwise A would close a server that B finished
        using ten seconds ago. Cheap: one small file. */
    double lastJobFinishedMs() const;

    bool isHeldByThisProcess() const noexcept { return heldHere.load(); }

    /** Cheap enough for the message thread. */
    Snapshot snapshot() const;

private:
    EngineLock();
    ~EngineLock();

    struct Ticket
    {
        juce::File file;
        double createdMs = 0.0;
    };

    struct Heartbeat final : juce::Thread
    {
        explicit Heartbeat (EngineLock& o) : juce::Thread ("Riffsheet engine lock"), owner (o) {}
        void run() override;
        EngineLock& owner;
    };

    juce::File queueDirectory() const;
    juce::File stateFile() const;
    juce::File idleFile() const;

    void     stampJobFinished();

    Ticket   writeTicket (const juce::String& label);
    void     refreshTicket (const Ticket& ticket, const juce::String& label);
    void     removeTicket (const Ticket& ticket);
    void     pruneStaleTickets() const;
    int      positionOf (const Ticket& ticket) const;
    int      countLiveTickets() const;
    void     writeStateFile (const juce::String& label);

    static bool isLiveRecord (const juce::var& record);

    /** Ten seconds. Only ever used to decide that a WRITTEN RECORD is not worth
        believing - never to decide who gets the engine, which is the kernel's
        job (see the class comment). A waiter refreshes every 200 ms, so this is
        fifty times the margin it needs. */
    static constexpr double staleAfterMs = 10000.0;

    /** In-process exclusion. The file lock alone cannot see two plugin instances
        inside one REAPER, because to the kernel they are one process. */
    std::mutex inProcess;
    std::atomic<bool> heldHere { false };

    // Read by the heartbeat thread and by snapshot() while the owning worker
    // thread writes them, so they take a lock like anything else shared here.
    mutable juce::CriticalSection heldInfoLock;
    juce::String heldLabel;
    double heldSinceMs = 0.0;

    Heartbeat heartbeat { *this };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EngineLock)
};
