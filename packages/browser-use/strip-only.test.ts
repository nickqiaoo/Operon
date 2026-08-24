import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * This package has to be loadable under Node's strip-only type erasure.
 *
 * `vite.config.ts` marks `@operon/browser-use` and `@operon/computer-use` as
 * external, because they fork kernel child processes and vendor a native
 * classic-level build, and bundling them into dist-electron breaks both. So the
 * Electron main process loads the `.ts` sources directly, through Node's built-in
 * strip-only erasure.
 *
 * Strip-only removes types without lowering syntax, so the following blow up at
 * runtime with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` while neither `tsc --noEmit`
 * nor vitest notices:
 *   - parameter properties, `constructor(private readonly x: T) {}`
 *   - `enum` (and `const enum`), `namespace`, decorators
 *
 * This has genuinely broken twice, in NodeReplSession and JsonRpcPeer, and only
 * surfaces when the app starts, which is why a test guards it.
 */

const DIR = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * The walk has to recurse. It used to be a flat `readdirSync(dir)`, which reached
 * not one file under `sdk/`, `kernel/` or `adapters/`. The entire browser SDK
 * lives in `sdk/`, so a flat scan left it completely unguarded.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const FILES = [...sourceFiles(DIR), ...sourceFiles(path.join(DIR, "..", "computer-use"))];

/** Strip comments, so a comment mentioning one of these patterns is not a false
 *  positive. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("strip-only compatibility: an external package must load as .ts under Node", () => {
  it.each(FILES.map((f) => [path.relative(path.join(DIR, ".."), f), f]))(
    "%s contains no parameter properties",
    (_name, file) => {
      const src = stripComments(fs.readFileSync(file, "utf8"));
      const offenders: string[] = [];
      for (const m of src.matchAll(/constructor\s*\(([^)]*)\)/gs)) {
        if (/\b(private|public|protected|readonly)\b/.test(m[1])) {
          offenders.push(m[1].trim().slice(0, 60));
        }
      }
      expect(offenders, "parameter properties fail at runtime under strip-only; use explicit fields").toEqual([]);
    },
  );

  it.each(FILES.map((f) => [path.relative(path.join(DIR, ".."), f), f]))(
    "%s contains no enum, namespace or decorator",
    (_name, file) => {
      const src = stripComments(fs.readFileSync(file, "utf8"));
      // `const enum` is out too, since strip-only does not inline constants. Use a
      // union type or `as const` instead.
      expect(src, "enum is unsupported under strip-only").not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
      expect(src, "namespace is unsupported under strip-only").not.toMatch(/^\s*(export\s+)?namespace\s/m);
      expect(src, "decorators are unsupported under strip-only").not.toMatch(/^\s*@[A-Za-z]/m);
    },
  );
});
