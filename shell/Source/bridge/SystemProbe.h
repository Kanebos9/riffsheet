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

        Captured audio and browser-provided audio without a stable native path
        are written here as real 24-bit WAVs. These are durable user data that
        survive a closed project or reboot and are never temp cleanup targets.
        See PcmStore::persistTake(). */
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

    //== time ==================================================================

    /** Milliseconds since the epoch, as a double. Used as the timestamp in every
        state file here, so different processes can compare them. */
    double nowMs();
}
