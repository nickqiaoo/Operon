// Minimal reproduction of the headless Chrome modifier-key wedge. Nothing to do
// with this package's SDK.
//
// Symptom: on macOS with Chrome 150 headless=new, dispatching bare modifier-key
// events (Shift keyDown/keyUp pairs) at a focused <input> wedges the renderer's
// input pipeline after roughly 6 to 10 events. Every later
// `Input.dispatchKeyEvent` and `Runtime.evaluate` then never returns, sometimes
// recovering after about 10 seconds and sometimes not at all. Spacing the events
// 30 or 60ms apart makes no difference: it accumulates by count, not by rate.
// `--disable-ipc-flooding-protection`, `--single-process` and `--disable-gpu`
// all fail to help. The same machine in a good state, freshly rebooted for
// instance, will not reproduce it.
//
// Use: when `sdk-locator-real.test.ts` shows a dozen tests cascading into 60s
// timeouts, run this first. If it wedges too (a TIMEOUT at round N), the problem
// is the machine and its Chrome, which a reboot usually fixes, and there is no
// point looking at the SDK.
//
//   node packages/browser-use/docs/headless-key-wedge-repro.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-repro-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

let port = 0;
const portFile = path.join(userDir, "DevToolsActivePort");
for (let i = 0; i < 100 && !port; i++) {
  try { port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) || 0; } catch { /* not yet */ }
  if (!port) await new Promise((r) => setTimeout(r, 100));
}
if (!port) { console.error("Chrome did not start"); process.exit(2); }
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === "page");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id == null) return;
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((r) => setTimeout(() => r(`TIMEOUT-${label}`), ms))]);

await cdp("Runtime.evaluate", { expression: `document.body.innerHTML='<input id="k" value="hello">'; document.getElementById('k').focus(); "ok"`, returnByValue: true });

let wedged = false;
for (let round = 1; round <= 8; round++) {
  const t = Date.now();
  for (const ev of [
    { type: "keyDown", code: "ShiftLeft", key: "Shift", modifiers: 8, nativeVirtualKeyCode: 16, windowsVirtualKeyCode: 16 },
    { type: "keyUp", code: "ShiftLeft", key: "Shift", modifiers: 8, nativeVirtualKeyCode: 16, windowsVirtualKeyCode: 16 },
  ]) {
    const r = await withTimeout(cdp("Input.dispatchKeyEvent", ev), 20000, ev.type);
    if (typeof r === "string") { console.log(`round ${round}: ${r} (${Date.now() - t}ms) -> machine is wedged`); wedged = true; }
    if (wedged) break;
  }
  if (wedged) break;
  const e = await withTimeout(cdp("Runtime.evaluate", { expression: "1+1", returnByValue: true }), 20000, "eval");
  if (typeof e === "string") { console.log(`round ${round}: ${e} -> machine is wedged`); wedged = true; break; }
  console.log(`round ${round}: ${Date.now() - t}ms`);
}
console.log(wedged
  ? "\nConclusion: reproduced. The headless input pipeline wedges on this machine, so the cascading timeouts in sdk-locator-real are not a code problem. Reboot before running the tests again."
  : "\nConclusion: all 8 rounds completed instantly and the machine is healthy. If sdk-locator-real still cascades into timeouts, the tests or the SDK itself are worth investigating.");
chrome.kill("SIGKILL");
process.exit(wedged ? 1 : 0);
