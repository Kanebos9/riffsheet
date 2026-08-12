/**
 * THE SHARED PROBE BOOTSTRAP: launch a headless Chrome that CANNOT outlive the script.
 *
 * THE INCIDENT THIS EXISTS FOR. A probe's Chrome survived the probe by a day and then blocked
 * the owner's real Chrome from opening — macOS activates the existing instance rather than
 * starting a new one, so an orphan with a temp `--user-data-dir` is not a stray process anybody
 * notices, it is "Chrome will not launch". Every probe in this directory now launches through
 * here, and none of them can leave one behind.
 *
 * WHY THE THREE SCRIPTS' OWN `finally` BLOCKS WERE NOT ENOUGH, precisely:
 *
 *   1. A `finally` runs for a thrown error and a normal return. It does NOT run for Ctrl-C, for
 *      a `kill`, for a terminal closing, or for the parent being reaped — which is exactly how a
 *      long headless run ends when somebody gives up on it.
 *   2. `proc.kill()` signals the BROWSER process only. Chrome's zygote, GPU and renderer helpers
 *      are separate processes; when the browser dies cleanly they follow it, but when it is
 *      killed mid-launch — before it has adopted them — they do not. Spawning `detached` puts
 *      the whole family in one process GROUP, and `kill(-pid)` signals all of it.
 *   3. Nothing removed the temp profile directory on those paths either, so a killed run left a
 *      `--user-data-dir` behind as well as the process holding it.
 *
 * The reaper is idempotent and registered once per child, so calling `dispose()` from a probe's
 * own `finally` (which is still the normal path, and the only one that gets to wait for exit)
 * costs nothing and the signal handlers become no-ops.
 */

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Signals that must take the browser with them. `exit` covers a plain fall-off-the-end. */
const FATAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * Launch Chrome so that it belongs to this script and dies with it.
 *
 * Returns the child plus a `dispose()` that kills the whole process group and removes the
 * profile. `dispose()` is safe to call more than once and from any exit path.
 *
 * `profileDir` is removed on dispose; pass the same `--user-data-dir` the args use.
 */
export function launchChrome(chromePath, args, { profileDir = null, stdio = ['ignore', 'ignore', 'pipe'] } = {}) {
  // `detached` is what makes the group exist. It does NOT mean "outlive the parent": nothing
  // calls `unref()`, so node still waits on it, and the handlers below still own it.
  const proc = spawn(chromePath, args, { stdio, detached: true });

  let disposed = false;
  const killGroup = () => {
    if (disposed) return;
    disposed = true;
    // The GROUP, by negative pid — the browser process, its zygote and every helper. Chrome
    // does not shut down gracefully on SIGTERM in headless mode reliably enough to wait for,
    // so SIGKILL follows unconditionally a moment later.
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try {
        if (proc.pid) process.kill(-proc.pid, sig);
      } catch {
        /* already gone, or never became a group leader */
      }
      try {
        proc.kill(sig);
      } catch {
        /* already gone */
      }
    }
    if (profileDir) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* best effort: a locked profile dir is not worth failing a probe over */
      }
    }
  };

  process.on('exit', killGroup);
  // THE LISTENER IS NAMED, and it has to be: `removeListener` compares by IDENTITY, so
  // registering `() => onSignal(sig)` and then removing `onSignal` removes nothing at all —
  // the re-raise below re-enters the same handler, `killGroup` short-circuits on `disposed`,
  // and the process spins instead of dying. Measured: Ctrl-C left the browser running.
  for (const sig of FATAL_SIGNALS) {
    const handler = () => {
      killGroup();
      // Re-raise with the DEFAULT disposition so the exit code says what actually happened,
      // rather than turning a Ctrl-C into a silent success.
      process.removeListener(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
  // A throw that escapes the probe's own try/catch must not leave a browser running either.
  process.on('uncaughtException', (e) => {
    killGroup();
    console.error('probe: uncaught exception —', e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    killGroup();
    console.error('probe: unhandled rejection —', e);
    process.exit(1);
  });

  return { proc, dispose: killGroup };
}
