#pragma once
#include <JuceHeader.h>

/**
    "Is a MuScriptor answering on this port?" - asked over HTTP, of the server
    itself.

    WHY THIS EXISTS. Everything else in the shell asks the OPERATING SYSTEM that
    question: `lsof` for the pid listening on the port, `ps` for that pid's
    command line, and SystemProbe::looksLikeMuScriptorServer() for the two halves
    `muscriptor` and `serve` in it. That test is the right one for a KILL - it is
    the only evidence strong enough to end somebody's process - and it was also,
    until now, the only way a server got REPORTED at all.

    Those are two different questions and they need two different answers. The
    process test is unavailable in exactly the situations the user hits:

      - a sandboxed host (AU in Logic, anything with the App Sandbox on) cannot
        spawn `lsof`, so the listening pid reads as 0 and a perfectly healthy
        server the user started themselves became invisible;
      - `lsof` shows only the calling user's processes, so a server started under
        another account is a blank as well;
      - Windows has no listeningProcessId() implementation at all - it returns 0
        by definition (SystemProbe.cpp), so NO external server has ever been
        reportable there.

    In every one of those cases the server is on the wire and Riffsheet said
    "stopped". This asks the server instead, and the server always answers.

    WHAT IT IS AND IS NOT ALLOWED TO DECIDE. A handshake is proof enough to SHOW
    something - a chip saying "there is a listener up, and it is not one Riffsheet
    started" - and it is NOT proof enough to kill a process or to upload a user's
    recording. Both of those still require the pid and its command line, exactly
    as before; see MuScriptorServer::stopExternalServer() and the
    `handshakeIdentifiedOnly` flag in MuScriptorServer. Nothing here reads a pid,
    signals anything, or sends a byte of audio.

    THE HANDSHAKE. /health answering {"status":"ok"} is necessary and nowhere near
    sufficient - any localhost process can return that. So the second half is
    GET /instruments, whose payload is the server's own 35-name instrument-group
    contract (BRIDGE.md "Valid `instruments` values (35)"): three or more of those
    names in one JSON array is a signature nothing else on a loopback port is
    going to produce by accident.
*/
namespace MuScriptorProbe
{
    struct Answer
    {
        bool reachable = false;          // something answered /health with {"status":"ok"}
        bool identified = false;         // ...and /instruments reads like MuScriptor's
        juce::StringArray instruments;   // what it listed, empty when it listed nothing
    };

    /** One handshake against host:port, no cache. Blocks for up to roughly
        2 x timeoutMs. Worker threads only - never the message thread. */
    Answer handshake (const juce::String& host, int port, int timeoutMs = 1200);

    /** The same question answered from a process-wide cache no older than
        `ttlMs`, so that N plugin windows polling engineStatus() every ten
        seconds cannot turn into N requests a second at somebody's server.
        Failures are cached as well as successes - a port with nothing behind it
        must not be retried on every poll either.

        Thread-safe. Blocks only on a cache miss. Worker threads only. */
    bool answersLikeMuScriptor (const juce::String& host, int port,
                                int timeoutMs = 1200, int ttlMs = 5000);

    /** Drops every cached answer. For tests, and for anything that has just
        changed the world on purpose (a server stopped by hand) and wants the
        next question asked for real. */
    void forgetCachedAnswers();

    /** The identity rule itself, over an already-fetched /instruments list, so it
        can be tested without a socket. True when at least three of MuScriptor's
        own 35 group names are in there. */
    bool instrumentsLookLikeMuScriptor (const juce::StringArray& instruments);
}
