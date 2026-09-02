import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Bundle the Teams extension (server/src/extensions/peers) into
 * `<outdir>/extensions/peers/{index.js,manifest.json}` for the extension-market publisher.
 *
 * The bundle has TWO sources: this repo's own extension code, and `operon-agents-peers`
 * (which is most of it — the framework runtime itself is excluded below and comes from the
 * host). So neither number alone identifies a build: `version` tracks the app half and
 * `engine` the framework half, and the marketplace treats a move in EITHER as an update
 * (see `isOutdated` in `extension-marketplace.ts`). Publish after changing either one.
 */
export async function buildPeersExtension({ root, outdir }) {
  const src = path.join(root, "server", "src", "extensions", "peers");
  const dest = path.join(outdir, "extensions", "peers");
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const result = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: { index: path.join(src, "index.ts") },
    entryNames: "[name]",
    format: "esm",
    outdir: dest,
    platform: "node",
    target: "node20",
    sourcemap: false,
    splitting: false,
    metafile: true,
  });
  // The bundle may only carry the peers package (+ zod). Framework runtime code must come
  // from the host — a copy inside the bundle would be a second, disconnected framework.
  const framework = Object.keys(result.metafile.inputs).filter(
    (input) => /node_modules\/operon-agents(-core)?\//.test(input),
  );
  if (framework.length > 0) {
    throw new Error(`peers extension bundle unexpectedly contains framework runtime: ${framework.join(", ")}`);
  }

  const manifest = JSON.parse(await readFile(path.join(src, "manifest.json"), "utf8"));
  const app = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const engine = JSON.parse(await readFile(path.join(root, "node_modules", "operon-agents", "package.json"), "utf8"));
  await writeFile(
    path.join(dest, "manifest.json"),
    `${JSON.stringify({ ...manifest, version: app.version, engine: engine.version }, null, 2)}\n`,
  );
  return dest;
}
