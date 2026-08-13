#pragma once
#include <JuceHeader.h>

/**
    Small facts about this machine that JUCE does not offer, and the one folder
    Riffsheet keeps its cross-process bookkeeping in.

    Everything here is READ-ONLY about the system except terminateProcess(),
    which is deliberately hard to reach: nothing kills a process unless the
    caller has already proved, from our own records plus the process's own
    command line, that it is a MuScriptor server we started.

    ONE CALLER PROVES SOMETHING ELSE, and it is worth knowing about before
    reading the rest as an absolute: MuScriptorServer::stopExternalServer() ends
    a server Riffsheet did NOT start. It is reachable only from a button a human
    presses, and it substitutes a stronger proof for the ownership half - the
    listening pid, no record of it in ServerRegistry, its own command line, and a
    live /health answer, all re-taken at the moment of the kill. Nothing in here
    is loosened for it; the caller simply has more to prove, not less.

    None of this is safe on the audio thread and most of it (the ones that shell
    out) is not safe on the message thread either - each one says which.
*/
namespace SystemProbe
{
    //== paths =================================================================

    /** ~/Library/Application Support/Riffsheet (created if missing).

        This is where the engine lock, the queue tickets and the record of
        servers we started live. It is deliberately NOT the temp directory: a
        record of "I started this server" has to survive a reboot's tmp sweep,
        because the whole point of it is to outlive a force-quit.

        Windows: %APPDATA%\Riffsheet. Linux: ~/.config/Riffsheet. */
    juce::File appSupportDirectory();

    /** <appSupportDirectory>/takes (created if missing).

        NOTHING IS WRITTEN HERE ANY MORE. Riffsheet used to copy every capture,
        every drop and every opened file into this folder as a dated 24-bit WAV;
        that is what filled it with duplicates and is gone (see PcmStore.cpp,
        where persistTake() used to be). The directory itself stays, and stays
        readable: existing documents and DAW projects reference files inside it
        by path, and NativeBridge::isAuthorizedAudioPath() still accepts it so
        those keep opening. Its contents are user data - never a cleanup
        target. */
    juce::File takesDirectory();

    //== processes =============================================================
    // Cheap (a syscall). Safe anywhere except the audio thread.

    int currentProcessId();

    /** True if a process with this id exists right now.

        A dead pid can be recycled by the OS, so this on its own is never enough
        to justify killing anything - pair it with processCommandLine(). */
    bool isProcessAlive (int pid);

    // Slow (forks a helper). Worker threads only - never the message thread.

    /** The full command line of `pid`, or "" when it cannot be read.

        Implemented with `ps` on macOS/Linux. Returns "" on Windows, which by
        design makes every "is this really ours?" test fail there, so the orphan
        reaper simply does nothing rather than guessing. */
    juce::String processCommandLine (int pid);

    /** True when a command line is unmistakably a MuScriptor server: it names
        the muscriptor executable AND its `serve` subcommand. Both, so a text
        editor with muscriptor.py open is never a candidate. */
    bool looksLikeMuScriptorServer (const juce::String& commandLine);

    /** The pid listening on a local TCP port, or 0 when it cannot be worked out.
        Implemented with `lsof`; macOS/Linux only. */
    int listeningProcessId (int port);

    /** SIGTERM, then SIGKILL if it is still there after `graceMs`.
        Returns true if the process is gone afterwards. */
    bool terminateProcess (int pid, int graceMs = 2000);

    /** Resident set size of `pid` in MB, or **-1 when it cannot be measured**.

        This is the number Activity Monitor calls "Memory" - physical RAM the
        process is actually holding right now, which for a loaded MuScriptor is
        the ~1.5 GB the whole idle-shutdown feature exists to give back.

        -1, never a guess: the user's objection is about real memory, and an
        invented figure would be worse than an honest "unknown". Implemented
        with `ps -o rss=` on macOS/Linux; Windows always answers -1 for now,
        for the same reason processCommandLine() does. */
    int processResidentMemoryMb (int pid);

    //== memory ================================================================
    // Both cheap. Safe on the message thread.

    /** Physical RAM in MB. */
    int physicalRamMb();

    /** RAM the system could hand out right now without swapping, in MB, or 0
        when the figure cannot be read.

        On macOS this is NOT `vm_stat`'s "Pages free" - that number is near zero
        on a healthy Mac because the OS spends everything spare on disk cache.
        The honest figure is free + inactive + speculative + purgeable, which is
        what Activity Monitor means by memory being available. */
    int availableRamMb();

    //== processor =============================================================
    // All three cheap. Safe on the message thread, and polled beside the memory
    // figures by engineStatus() - see NativeBridge::makeEngineStatusVar().
    //
    // WHY THEY ARE HERE. Settings shows one system line at the top, and until now
    // the only thing this file could tell it was how much memory the machine has.
    // "8 GB" on its own says nothing about whether a transcription is going to
    // take twenty seconds or four minutes; the chip in front of it is half that
    // answer. Every one of these returns an honest "do not know" rather than a
    // plausible number, for the same reason processResidentMemoryMb() does.

    /** The processor's own name for itself ("Apple M1", "Intel Core i7-9750H"),
        or "" when the platform will not say. Never assembled out of a family
        name and a core count - a made-up chip name is worse than none. */
    juce::String cpuName();

    /** PHYSICAL cores, or 0 when unknown. On an Apple Silicon Mac this counts
        performance and efficiency cores together, which is what the machine has;
        it is deliberately not a guess at how many of them a transcription will
        actually get. */
    int cpuPhysicalCores();

    /** Logical processors (hardware threads), or 0 when unknown. Equal to
        cpuPhysicalCores() on Apple Silicon, twice it on a hyperthreaded Intel. */
    int cpuLogicalCores();

    /** The one-minute load average, or **-1.0 when it cannot be read**.
        NOT a percentage and not divided by the core count: it is the number
        `uptime` prints, and the only honest way to turn it into a percentage is
        with cpuPhysicalCores(), which the caller already has. Windows has no
        equivalent cheap figure and answers -1.0. */
    double cpuLoadOneMinute();

    //== time ==================================================================

    /** Milliseconds since the epoch, as a double. Used as the timestamp in every
        state file here, so different processes can compare them. */
    double nowMs();
}
