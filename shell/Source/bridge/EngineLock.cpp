#include "EngineLock.h"
#include "SystemProbe.h"

#if JUCE_MAC || JUCE_LINUX
 #include <fcntl.h>
 #include <unistd.h>
#endif

#if JUCE_WINDOWS
 #include <windows.h>
#endif

namespace
{
    juce::var makeObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
    {
        auto* obj = new juce::DynamicObject();

        for (const auto& property : properties)
            obj->setProperty (property.first, property.second);

        return juce::var (obj);
    }

    /**
        An exclusive lock on a file, held by the PROCESS, released by the KERNEL.

        This is hand-rolled rather than juce::InterProcessLock, and the reason is
        specific and load-bearing. JUCE's macOS implementation tries
        ~/Library/Caches/com.juce.locks/<name> and, if that fails for ANY reason
        - including "somebody else already holds it" - silently falls back to
        locking a different file in /tmp instead:

            if (! createLockFile (File ("~/Library/Caches/com.juce.locks")...))
                createLockFile (File ("/tmp/com.juce.locks")...);

        So a contended enter(0) can return true. That is fine for its intended
        use (stopping two copies of an app launching) and completely wrong for
        "am I allowed to load a gigabyte of model right now".

        What is used instead is what JUCE uses underneath on the happy path: a
        POSIX fcntl() write lock, which the kernel drops the moment the process
        dies, however it dies. There is no lease, no timeout and no stale-lock
        rule to get wrong - a force-quit during a transcription frees the engine
        instantly. On Windows the equivalent is an exclusive CreateFile handle,
        which Windows closes on process exit for the same reason.
    */
    class ExclusiveFileLock
    {
    public:
        explicit ExclusiveFileLock (juce::File f) : file (std::move (f)) {}
        ~ExclusiveFileLock() { release(); }

        /** Non-blocking. False means somebody else has it. */
        bool tryAcquire()
        {
            if (isHeld())
                return true;

            if (! file.existsAsFile())
                file.create();

           #if JUCE_WINDOWS
            handle = ::CreateFileW (file.getFullPathName().toWideCharPointer(),
                                    GENERIC_READ | GENERIC_WRITE,
                                    0,                      // no sharing: the open IS the lock
                                    nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

            return handle != INVALID_HANDLE_VALUE;
           #else
            descriptor = ::open (file.getFullPathName().toRawUTF8(), O_RDWR | O_CREAT, 0644);

            if (descriptor < 0)
            {
                descriptor = -1;
                return false;
            }

            struct flock request {};
            request.l_type   = F_WRLCK;
            request.l_whence = SEEK_SET;
            request.l_start  = 0;
            request.l_len    = 0;          // the whole file, however long it gets

            if (::fcntl (descriptor, F_SETLK, &request) < 0)
            {
                ::close (descriptor);
                descriptor = -1;
                return false;
            }

            return true;
           #endif
        }

        void release()
        {
           #if JUCE_WINDOWS
            if (handle != INVALID_HANDLE_VALUE)
            {
                ::CloseHandle (handle);
                handle = INVALID_HANDLE_VALUE;
            }
           #else
            if (descriptor >= 0)
            {
                // Closing the descriptor releases every fcntl lock this process
                // holds on the file. Nothing else in Riffsheet ever opens it.
                ::close (descriptor);
                descriptor = -1;
            }
           #endif
        }

        bool isHeld() const noexcept
        {
           #if JUCE_WINDOWS
            return handle != INVALID_HANDLE_VALUE;
           #else
            return descriptor >= 0;
           #endif
        }

    private:
        juce::File file;
       #if JUCE_WINDOWS
        HANDLE handle = INVALID_HANDLE_VALUE;
       #else
        int descriptor = -1;
       #endif
    };

    ExclusiveFileLock& engineFileLock()
    {
        static ExclusiveFileLock lock (SystemProbe::appSupportDirectory().getChildFile ("engine.lock"));
        return lock;
    }
}

//==============================================================================
EngineLock& EngineLock::getInstance()
{
    static EngineLock instance;
    return instance;
}

EngineLock::EngineLock()
{
    queueDirectory().createDirectory();
}

EngineLock::~EngineLock()
{
    // Static destruction. If a job somehow still holds the engine we are past
    // caring about strict mutex ownership - the process is going away and the
    // kernel is about to drop the file lock anyway.
    release();
}

juce::File EngineLock::queueDirectory() const
{
    return SystemProbe::appSupportDirectory().getChildFile ("queue");
}

juce::File EngineLock::idleFile() const
{
    // "When did this machine last finish a transcription." One number, written
    // by whoever releases the engine, read by every idle timer in every
    // Riffsheet on the box. It outlives all of them on purpose: a machine that
    // finished a job a minute before this process started should still not have
    // its server closed for another four.
    return SystemProbe::appSupportDirectory().getChildFile ("engine-idle.json");
}

juce::File EngineLock::stateFile() const
{
    // Deliberately NOT the file that carries the OS lock. Keeping the two apart
    // means anybody can read "who is transcribing" without having to open, and
    // therefore possibly disturb, the thing that decides it.
    return SystemProbe::appSupportDirectory().getChildFile ("engine-owner.json");
}

//==============================================================================
bool EngineLock::isLiveRecord (const juce::var& record)
{
    auto* obj = record.getDynamicObject();

    if (obj == nullptr)
        return false;

    const auto pid = (int) obj->getProperty ("pid");

    if (! SystemProbe::isProcessAlive (pid))
        return false;

    const auto heartbeat = (double) obj->getProperty ("heartbeatMs");
    return SystemProbe::nowMs() - heartbeat < staleAfterMs;
}

EngineLock::Ticket EngineLock::writeTicket (const juce::String& label)
{
    Ticket ticket;
    ticket.createdMs = SystemProbe::nowMs();

    // The name carries the arrival time, so a plain directory listing is already
    // the queue in order and a human can read it.
    const auto name = juce::String ((juce::int64) ticket.createdMs).paddedLeft ('0', 14)
                    + "-" + juce::String (SystemProbe::currentProcessId())
                    + "-" + juce::String::toHexString (juce::Random::getSystemRandom().nextInt())
                    + ".ticket";

    ticket.file = queueDirectory().getChildFile (name);
    refreshTicket (ticket, label);
    return ticket;
}

void EngineLock::refreshTicket (const Ticket& ticket, const juce::String& label)
{
    // Written every time round the wait loop, which doubles as the heartbeat
    // AND recreates the ticket if some other process pruned it while this
    // machine was asleep - keeping our original arrival time, so a nap does not
    // send us to the back of the queue.
    const auto record = makeObject ({ { "pid", SystemProbe::currentProcessId() },
                                      { "createdMs", ticket.createdMs },
                                      { "heartbeatMs", SystemProbe::nowMs() },
                                      { "label", label } });

    ticket.file.replaceWithText (juce::JSON::toString (record, true));
}

void EngineLock::removeTicket (const Ticket& ticket)
{
    ticket.file.deleteFile();
}

void EngineLock::pruneStaleTickets() const
{
    const auto dir = queueDirectory();

    if (! dir.isDirectory())
        return;

    for (const auto& entry : juce::RangedDirectoryIterator (dir, false, "*.ticket"))
    {
        const auto file = entry.getFile();

        if (! isLiveRecord (juce::JSON::parse (file.loadFileAsString())))
            file.deleteFile();
    }
}

int EngineLock::positionOf (const Ticket& ticket) const
{
    auto ahead = 0;
    const auto dir = queueDirectory();

    if (! dir.isDirectory())
        return 1;

    for (const auto& entry : juce::RangedDirectoryIterator (dir, false, "*.ticket"))
    {
        const auto file = entry.getFile();

        if (file == ticket.file)
            continue;

        const auto record = juce::JSON::parse (file.loadFileAsString());

        if (! isLiveRecord (record))
            continue;

        const auto created = (double) record.getDynamicObject()->getProperty ("createdMs");

        // Ties broken by file name so every process agrees on the same order.
        if (created < ticket.createdMs
            || (created == ticket.createdMs && file.getFileName() < ticket.file.getFileName()))
            ++ahead;
    }

    return ahead + 1;
}

int EngineLock::countLiveTickets() const
{
    auto count = 0;
    const auto dir = queueDirectory();

    if (! dir.isDirectory())
        return 0;

    for (const auto& entry : juce::RangedDirectoryIterator (dir, false, "*.ticket"))
        if (isLiveRecord (juce::JSON::parse (entry.getFile().loadFileAsString())))
            ++count;

    return count;
}

void EngineLock::writeStateFile (const juce::String& label)
{
    double startedMs = 0.0;

    {
        const juce::ScopedLock sl (heldInfoLock);
        startedMs = heldSinceMs;
    }

    const auto record = makeObject ({ { "pid", SystemProbe::currentProcessId() },
                                      { "label", label },
                                      { "startedMs", startedMs },
                                      { "heartbeatMs", SystemProbe::nowMs() } });

    stateFile().replaceWithText (juce::JSON::toString (record, true));
}

void EngineLock::stampJobFinished()
{
    const auto record = makeObject ({ { "lastFinishedMs", SystemProbe::nowMs() },
                                      { "pid", SystemProbe::currentProcessId() } });

    idleFile().replaceWithText (juce::JSON::toString (record, true));
}

double EngineLock::lastJobFinishedMs() const
{
    // Named, not a temporary. getDynamicObject() points into the var's
    // ref-counted payload and the var returned by JSON::parse is its only
    // owner, so reading through the pointer after the condition's
    // full-expression ends is a use-after-free that usually looks like it works.
    const auto parsed = juce::JSON::parse (idleFile().loadFileAsString());

    if (auto* obj = parsed.getDynamicObject())
    {
        const auto stamped = (double) obj->getProperty ("lastFinishedMs");

        // A timestamp from the future means the clock moved (or the file was
        // hand-edited). Believing it would freeze the idle countdown forever,
        // so treat it as "just now" and let the five minutes run from here.
        return stamped > SystemProbe::nowMs() ? SystemProbe::nowMs() : stamped;
    }

    return 0.0;
}

//==============================================================================
void EngineLock::Heartbeat::run()
{
    // Keeps the readable record honest while a job runs, so a reader can tell a
    // live owner from the leftovers of a crashed one. It is NOT what frees the
    // engine - the kernel does that (see ExclusiveFileLock).
    while (! threadShouldExit())
    {
        if (owner.heldHere.load())
        {
            juce::String label;

            {
                const juce::ScopedLock sl (owner.heldInfoLock);
                // A copy under the lock: juce::String is reference counted and
                // must not be read while another thread reassigns it.
                label = owner.heldLabel;
            }

            owner.writeStateFile (label);
        }

        wait (2000);
    }
}

//==============================================================================
bool EngineLock::acquire (const juce::String& label,
                          std::function<bool()> shouldAbandon,
                          std::function<void (int, const juce::String&)> onWaiting)
{
    // Never the message thread: this call is allowed to take minutes.
    jassert (! juce::MessageManager::existsAndIsCurrentThread());

    queueDirectory().createDirectory();

    const auto ticket = writeTicket (label);

    auto lastReportedPosition = -1;
    auto lastReportMs = 0.0;

    for (;;)
    {
        if (shouldAbandon != nullptr && shouldAbandon())
        {
            removeTicket (ticket);
            return false;
        }

        pruneStaleTickets();

        const auto position = positionOf (ticket);

        if (position <= 1)
        {
            // In-process exclusion FIRST. Two plugin instances in one REAPER are
            // two objects in one process, and a file lock cannot see the
            // difference between them.
            std::unique_lock<std::mutex> local (inProcess, std::try_to_lock);

            if (local.owns_lock() && engineFileLock().tryAcquire())
            {
                {
                    const juce::ScopedLock sl (heldInfoLock);
                    heldSinceMs = SystemProbe::nowMs();
                    heldLabel = label;
                }

                heldHere = true;

                removeTicket (ticket);
                writeStateFile (label);

                if (! heartbeat.isThreadRunning())
                    heartbeat.startThread();

                local.release();     // ownership passes to release()
                return true;
            }
        }

        const auto now = SystemProbe::nowMs();

        if (onWaiting != nullptr && (position != lastReportedPosition || now - lastReportMs > 2000.0))
        {
            lastReportedPosition = position;
            lastReportMs = now;
            onWaiting (juce::jmax (1, position), snapshot().holderLabel);
        }

        refreshTicket (ticket, label);
        juce::Thread::sleep (200);
    }
}

bool EngineLock::tryAcquireNow (const juce::String& label)
{
    // Never the message thread: whoever calls this is about to do something
    // slow with the engine, which is the only reason to hold it.
    jassert (! juce::MessageManager::existsAndIsCurrentThread());

    // Same two-step as acquire(), minus the queue. In-process mutex first,
    // because two plugin instances in one REAPER are one process to the kernel
    // and its file lock cannot tell them apart.
    std::unique_lock<std::mutex> local (inProcess, std::try_to_lock);

    if (! local.owns_lock() || ! engineFileLock().tryAcquire())
        return false;

    {
        const juce::ScopedLock sl (heldInfoLock);
        heldSinceMs = SystemProbe::nowMs();
        heldLabel = label;
    }

    heldHere = true;
    writeStateFile (label);

    if (! heartbeat.isThreadRunning())
        heartbeat.startThread();

    local.release();     // ownership passes to release(), as in acquire()
    return true;
}

void EngineLock::release (bool finishedAJob)
{
    if (! heldHere.exchange (false))
        return;

    if (finishedAJob)
        stampJobFinished();

    heartbeat.stopThread (1500);
    stateFile().deleteFile();
    engineFileLock().release();

    // Matched with the unique_lock::release() in acquire(). Must be the same
    // thread that acquired it, which is why acquire/release are documented as a
    // pair on one worker job.
    inProcess.unlock();
}

//==============================================================================
EngineLock::Snapshot EngineLock::snapshot() const
{
    Snapshot result;

    const auto record = juce::JSON::parse (stateFile().loadFileAsString());

    if (auto* obj = record.getDynamicObject())
    {
        const auto pid = (int) obj->getProperty ("pid");
        const auto heartbeat = (double) obj->getProperty ("heartbeatMs");
        const auto fresh = SystemProbe::nowMs() - heartbeat < staleAfterMs;

        if (pid > 0 && fresh && SystemProbe::isProcessAlive (pid))
        {
            result.busy = true;
            result.holderPid = pid;
            result.holderLabel = obj->getProperty ("label").toString();
            result.heldForSec = juce::jmax (0.0, (SystemProbe::nowMs()
                                                  - (double) obj->getProperty ("startedMs")) / 1000.0);
            result.heldByThisProcess = pid == SystemProbe::currentProcessId();
        }
    }

    // Our own view is authoritative about ourselves: if this process holds the
    // engine, say so even if the file was somehow not written yet.
    if (heldHere.load())
    {
        result.busy = true;
        result.heldByThisProcess = true;

        if (result.holderPid == 0)
        {
            const juce::ScopedLock sl (heldInfoLock);
            result.holderPid = SystemProbe::currentProcessId();
            result.holderLabel = heldLabel;
            result.heldForSec = juce::jmax (0.0, (SystemProbe::nowMs() - heldSinceMs) / 1000.0);
        }
    }

    result.queueLength = countLiveTickets() + (result.busy ? 1 : 0);
    return result;
}
