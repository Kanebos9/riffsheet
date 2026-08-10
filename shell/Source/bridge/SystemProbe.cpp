#include "SystemProbe.h"

#if JUCE_MAC || JUCE_LINUX
 #include <signal.h>
 #include <errno.h>
 #include <unistd.h>
#endif

#if JUCE_MAC
 #include <mach/mach.h>
#endif

#if JUCE_WINDOWS
 #include <windows.h>
#endif

namespace SystemProbe
{
namespace
{
    /** Runs a short command and returns its stdout, or "" if it could not run.

        `timeoutMs` is a real limit: a wedged `lsof` must not be able to hold a
        worker thread forever. juce::ChildProcess::readAllProcessOutput() has no
        timeout of its own, so this polls instead and kills on overrun. */
    juce::String runCapturing (const juce::StringArray& args, int timeoutMs)
    {
        if (args.isEmpty() || ! juce::File (args[0]).existsAsFile())
            return {};

        juce::ChildProcess proc;

        if (! proc.start (args, juce::ChildProcess::wantStdOut))
            return {};

        juce::String output;
        const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;

        for (;;)
        {
            char buffer[1024];
            const auto read = proc.readProcessOutput (buffer, (int) sizeof (buffer));

            if (read > 0)
            {
                output += juce::String::fromUTF8 (buffer, read);
                continue;
            }

            if (! proc.isRunning())
                break;

            if (juce::Time::getMillisecondCounter() > deadline)
            {
                proc.kill();
                return output;
            }

            juce::Thread::sleep (10);
        }

        return output;
    }

    /** The first of `candidates` that exists, so this works when the host has
        handed the plugin a minimal PATH (REAPER does). */
    juce::StringArray withTool (const juce::StringArray& candidates, const juce::StringArray& arguments)
    {
        for (const auto& candidate : candidates)
        {
            if (juce::File (candidate).existsAsFile())
            {
                juce::StringArray args { candidate };
                args.addArray (arguments);
                return args;
            }
        }

        return {};
    }
}

//==============================================================================
juce::File appSupportDirectory()
{
    // JUCE's userApplicationDataDirectory is "~/Library" on macOS, not
    // "~/Library/Application Support" - that step is the caller's job there and
    // nowhere else. On Windows it is already %APPDATA% and on Linux ~/.config,
    // both of which are the right level already.
    auto dir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory);

   #if JUCE_MAC
    dir = dir.getChildFile ("Application Support");
   #endif

    dir = dir.getChildFile ("Riffsheet");

    if (! dir.isDirectory())
        dir.createDirectory();

    return dir;
}

juce::File takesDirectory()
{
    auto dir = appSupportDirectory().getChildFile ("takes");

    if (! dir.isDirectory())
        dir.createDirectory();

    return dir;
}

double nowMs()
{
    return (double) juce::Time::currentTimeMillis();
}

//==============================================================================
int currentProcessId()
{
   #if JUCE_WINDOWS
    return (int) ::GetCurrentProcessId();
   #else
    return (int) ::getpid();
   #endif
}

bool isProcessAlive (int pid)
{
    if (pid <= 0)
        return false;

   #if JUCE_WINDOWS
    if (auto* handle = ::OpenProcess (SYNCHRONIZE, FALSE, (DWORD) pid))
    {
        const auto alive = ::WaitForSingleObject (handle, 0) == WAIT_TIMEOUT;
        ::CloseHandle (handle);
        return alive;
    }

    return false;
   #else
    // Signal 0 does not deliver anything; it only performs the existence and
    // permission checks. EPERM means "it exists but belongs to somebody else",
    // which still counts as alive.
    if (::kill ((pid_t) pid, 0) == 0)
        return true;

    return errno == EPERM;
   #endif
}

juce::String processCommandLine (int pid)
{
    if (pid <= 0)
        return {};

   #if JUCE_WINDOWS
    // Reading another process's command line on Windows needs either WMI or
    // NtQueryInformationProcess. Nothing here needs it badly enough to justify
    // that, and returning "" simply means the orphan reaper never identifies a
    // process positively and therefore never kills one. Conservative on purpose.
    juce::ignoreUnused (pid);
    return {};
   #else
    const auto args = withTool ({ "/bin/ps", "/usr/bin/ps" },
                                { "-o", "command=", "-p", juce::String (pid) });
    return runCapturing (args, 3000).trim();
   #endif
}

bool looksLikeMuScriptorServer (const juce::String& commandLine)
{
    if (commandLine.isEmpty())
        return false;

    // Both halves, deliberately. "muscriptor" alone would also match a shell
    // sitting in the muscriptor folder, an editor with the source open, or the
    // user's own START-MEDIUM.command wrapper script - none of which is a server
    // and none of which we are ever allowed to kill.
    return commandLine.contains ("muscriptor") && commandLine.contains ("serve");
}

int listeningProcessId (int port)
{
    if (port <= 0)
        return 0;

   #if JUCE_WINDOWS
    juce::ignoreUnused (port);
    return 0;
   #else
    const auto args = withTool ({ "/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof" },
                                { "-nP",
                                  "-iTCP:" + juce::String (port),
                                  "-sTCP:LISTEN",
                                  "-t" });

    const auto output = runCapturing (args, 5000);

    juce::StringArray lines;
    lines.addLines (output);

    for (const auto& line : lines)
    {
        const auto pid = line.trim().getIntValue();

        if (pid > 0)
            return pid;
    }

    return 0;
   #endif
}

bool terminateProcess (int pid, int graceMs)
{
    if (pid <= 0 || ! isProcessAlive (pid))
        return true;

   #if JUCE_WINDOWS
    if (auto* handle = ::OpenProcess (PROCESS_TERMINATE | SYNCHRONIZE, FALSE, (DWORD) pid))
    {
        ::TerminateProcess (handle, 1);
        ::WaitForSingleObject (handle, (DWORD) graceMs);
        ::CloseHandle (handle);
    }
   #else
    ::kill ((pid_t) pid, SIGTERM);

    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) graceMs;

    while (juce::Time::getMillisecondCounter() < deadline)
    {
        if (! isProcessAlive (pid))
            return true;

        juce::Thread::sleep (50);
    }

    // Still there. A Python server mid-inference can ignore SIGTERM for a long
    // time, and the whole reason we are here is that it is not answering.
    ::kill ((pid_t) pid, SIGKILL);
    juce::Thread::sleep (200);
   #endif

    return ! isProcessAlive (pid);
}

int processResidentMemoryMb (int pid)
{
    if (pid <= 0 || ! isProcessAlive (pid))
        return -1;

   #if JUCE_WINDOWS
    // GetProcessMemoryInfo would need psapi and a handle with
    // PROCESS_QUERY_INFORMATION. Nothing on Windows can identify the server
    // process in the first place (see processCommandLine), so there is nothing
    // here to measure yet - report "unknown" rather than a zero that reads as
    // "it is using no memory at all".
    juce::ignoreUnused (pid);
    return -1;
   #else
    // rss is in kilobytes on both macOS and Linux. `ps` is used rather than
    // /proc so the same code path works on the Mac this is developed on.
    const auto args = withTool ({ "/bin/ps", "/usr/bin/ps" },
                                { "-o", "rss=", "-p", juce::String (pid) });

    const auto kb = runCapturing (args, 3000).trim().getLargeIntValue();

    return kb > 0 ? (int) (kb / 1024) : -1;
   #endif
}

//==============================================================================
int physicalRamMb()
{
    return juce::SystemStats::getMemorySizeInMegabytes();
}

int availableRamMb()
{
   #if JUCE_MAC
    vm_statistics64_data_t stats {};
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;

    if (host_statistics64 (mach_host_self(), HOST_VM_INFO64,
                           (host_info64_t) &stats, &count) != KERN_SUCCESS)
        return 0;

    const auto pageSize = (juce::uint64) ::sysconf (_SC_PAGESIZE);

    if (pageSize == 0)
        return 0;

    // free + inactive + speculative + purgeable. Everything in that set can be
    // handed to a new process without swapping anything out; "Pages free" alone
    // is close to zero on any Mac that has been up for five minutes, because
    // macOS spends all spare RAM on the file cache and reclaims it on demand.
    const juce::uint64 pages = (juce::uint64) stats.free_count
                             + (juce::uint64) stats.inactive_count
                             + (juce::uint64) stats.speculative_count
                             + (juce::uint64) stats.purgeable_count;

    return (int) ((pages * pageSize) / (1024ull * 1024ull));

   #elif JUCE_WINDOWS
    MEMORYSTATUSEX status {};
    status.dwLength = sizeof (status);

    if (! ::GlobalMemoryStatusEx (&status))
        return 0;

    return (int) (status.ullAvailPhys / (1024ull * 1024ull));

   #elif JUCE_LINUX
    // MemAvailable is the kernel's own estimate of what a new process can get
    // without swapping - the same idea as the macOS sum above, already computed.
    const auto meminfo = juce::File ("/proc/meminfo").loadFileAsString();

    juce::StringArray lines;
    lines.addLines (meminfo);

    for (const auto& line : lines)
    {
        if (! line.startsWith ("MemAvailable:"))
            continue;

        const auto kb = line.fromFirstOccurrenceOf (":", false, false)
                            .upToFirstOccurrenceOf ("kB", false, false)
                            .trim()
                            .getLargeIntValue();

        return (int) (kb / 1024);
    }

    return 0;

   #else
    return 0;
   #endif
}

} // namespace SystemProbe
