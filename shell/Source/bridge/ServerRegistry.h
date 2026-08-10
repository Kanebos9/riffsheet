#pragma once
#include <JuceHeader.h>
#include <optional>

/**
    A record on disk of every MuScriptor server Riffsheet has started, so a
    force-quit cannot leave one running forever with nobody left who knows it is
    there.

    THE PROBLEM. The shell kills only the child process it started, and only on
    a clean shutdown. Force-quit skips that, and design notes §5.3 have been
    telling the user to go and look in Activity Monitor ever since. A leftover
    server holds about 1.5 GB on an 8 GB machine.

    THE RULE, and it is deliberately timid. On startup, for every server we ever
    recorded:

      - the pid is gone            -> forget it. Pids get recycled; never kill.
      - it is alive but its command line is not a muscriptor server
                                   -> forget it. That pid belongs to somebody
                                      else now.
      - the Riffsheet that started it is still running
                                   -> leave it completely alone. Somebody is
                                      using it.
      - the owner is gone and it ANSWERS /health
                                   -> do not kill it. Take responsibility for it
                                      instead: it is a perfectly good warm
                                      server, the adopt path will reuse it, and
                                      recording ourselves as the new owner means
                                      our own clean shutdown finally cleans it
                                      up. That is worth more than killing it.
      - the owner is gone and it does NOT answer /health
                                   -> kill it. This is the actual harm: a wedged
                                      process sitting on port 8223 that nothing
                                      can use and nothing will ever clean up.

    So nothing is ever killed unless WE wrote its pid down AND its own command
    line still says it is a MuScriptor server AND nobody is using it AND it has
    stopped answering. On Windows the command line cannot be read without a lot
    of extra machinery, so `looksLikeMuScriptorServer` always fails there and the
    reaper does nothing at all - which is the right way round to be wrong.

    Everything here shells out or does HTTP. Worker threads only.
*/
namespace ServerRegistry
{
    struct Entry
    {
        int serverPid = 0;
        int port = 0;
        int ownerPid = 0;        // the Riffsheet process that started it
        double startedMs = 0.0;
        juce::String model;
    };

    /** Remembers a server we just spawned. */
    void record (int serverPid, int port, const juce::String& model);

    /** Forgets one we have stopped (or that we know has gone). */
    void forget (int serverPid);

    /** The entry for `serverPid`, if Riffsheet is the one that started it.

        THIS IS THE OWNERSHIP TEST, and it is the reason the idle shutdown can
        exist at all. A server the user launched themselves - the
        START-MEDIUM.command window on port 8222 - was never written here by
        anybody, so this returns nothing for it and every "may we stop this?"
        question about it answers no. Nothing else in the shell is allowed to
        conclude "ours" from a port number, a model name or the fact that it
        answers /health: those are all equally true of the user's own server.

        Reads one small JSON file. Cheap enough for the message thread, though
        working out WHICH pid is listening on a port is not (that shells out to
        lsof), so callers cache the answer. */
    std::optional<Entry> findByPid (int serverPid);

    /** As findByPid, by the port we recorded. Useful when the listening pid
        cannot be read; still only ever finds servers Riffsheet started. */
    std::optional<Entry> findByPort (int port);

    struct ReapReport
    {
        juce::StringArray killed;      // plain sentences, safe to show a user
        juce::StringArray adopted;     // orphans we took responsibility for
        int adoptedPid = 0;            // the one we took over, 0 if none
        int adoptedPort = 0;
    };

    /** Applies the rule above. `healthProbe(port)` must answer "is a MuScriptor
        answering there right now". Safe to call more than once; it is idempotent
        and it never touches an entry another live Riffsheet owns. */
    ReapReport reapOrphans (const std::function<bool (int)>& healthProbe);
}
