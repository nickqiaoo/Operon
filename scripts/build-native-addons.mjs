/**
 * Build the Node native addons that ship in `dist-operon-runtime`.
 *
 * Only one is left: `peer-auth`, the codesign peer verification behind the
 * Node-hosted browser-use sockets.
 *
 * This script used to also `swift build` the in-tree `operon-computer-use`
 * engine and the `computer-use-host` addon that composited its capture into the
 * PiP preview window. Computer Use runs on the cua-driver daemon now, which is
 * fetched as an upstream release binary by `scripts/fetch-cua-driver.mjs`, so
 * neither is built or shipped. The Swift package is still in `native/computer-use`.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const peerAuthAddonDir = path.join(root, "native", "peer-auth");
const destinationDir = path.join(root, "dist-operon-runtime");
const peerAuthAddonDestination = path.join(destinationDir, "operon-peer-auth.node");
const requestedArch = process.env.TARGET_ARCH ?? process.env.npm_config_arch ?? process.arch;

await mkdir(destinationDir, { recursive: true });

const nodeGyp = path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [nodeGyp, "rebuild", "--arch", requestedArch], {
    cwd: peerAuthAddonDir,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`peer-auth node-gyp exited with code ${String(code)}`));
  });
});

await copyFile(
  path.join(peerAuthAddonDir, "build", "Release", "operon_peer_auth.node"),
  peerAuthAddonDestination,
);
