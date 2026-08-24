/**
 * A cross-process mutex for the test files that drive a real Chrome. Tests only.
 *
 * Four test files in this package spawn a real headless Chrome
 * (sdk-locator-real, playwright-injected, sdk-inject-navigation,
 * switchover.e2e), and vitest runs files
 * in parallel by default, so several headless Chromes end up live at once.
 * Reproducible with bare CDP: under concurrent multi-instance load, headless=new
 * wedges the renderer pipeline *permanently* on a burst of input events, where a
 * single instance recovers after about 10 seconds. Even `Runtime.evaluate` and
 * `Browser.grantPermissions` stop returning, which shows up as a dozen tests
 * cascading into timeouts while the same file passes when run alone.
 *
 * The product is unaffected: a headed webview and the user's real Chrome do not
 * do this. It is purely an artefact of the test environment.
 *
 * Hence: take the lock before spawning Chrome and release it in afterAll. The
 * three files then exclude each other and each passes with the machine to itself.
 *
 * Implementation: `mkdir`'s atomicity is the lock, plus a pid file checked for
 * liveness so a run killed with SIGKILL, which never reaches afterAll, cannot
 * leave a zombie lock behind. vitest's default forks pool gives each file its own
 * process, so pid semantics hold.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_DIR = path.join(os.tmpdir(), "operon-chrome-e2e.lock");

let held = false;

function ownerAlive(): boolean {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8"));
  } catch {
    // The pid file has not been written yet, in the window between mkdir and
    // write. Treat the holder as alive and check again shortly.
    return true;
  }
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is not ours, so it is alive; ESRCH means
    // it is gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireChromeE2eLock(timeoutMs = 240_000): Promise<void> {
  if (held) return; // A repeat call within the same file, such as an on-demand
                    // openChrome, reuses the lock.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, "pid"), String(process.pid));
      held = true;
      return;
    } catch {
      if (!ownerAlive()) {
        // A zombie lock whose holder is dead. Do not rm and then mkdir: several
        // waiters doing that at once all "succeed", because B removes the lock A
        // just created. Claim it atomically with rename instead, so exactly one
        // process wins and the rest go back to waiting.
        try {
          fs.renameSync(LOCK_DIR, `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`);
        } catch { /* Someone else claimed it. */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`chrome-e2e lock: waited ${timeoutMs}ms without acquiring it (holder pid is in ${LOCK_DIR}/pid)`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export function releaseChromeE2eLock(): void {
  if (!held) return;
  held = false;
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* Already gone. */ }
}
