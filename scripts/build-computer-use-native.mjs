import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "native", "computer-use");
const hostAddonDir = path.join(root, "native", "computer-use-host");
const peerAuthAddonDir = path.join(root, "native", "peer-auth");
const destinationDir = path.join(root, "dist-operon-runtime");
const destination = path.join(destinationDir, "operon-computer-use");
const hostAddonDestination = path.join(destinationDir, "operon-computer-use-host.node");
const peerAuthAddonDestination = path.join(destinationDir, "operon-peer-auth.node");
const requestedArch = process.env.TARGET_ARCH ?? process.env.npm_config_arch ?? process.arch;
const swiftArch = requestedArch === "x64" ? "x86_64" : requestedArch === "arm64" ? "arm64" : undefined;
if (swiftArch == null) {
  throw new Error(`Unsupported macOS architecture for Computer Use: ${requestedArch}`);
}
const swiftArgs = ["build", "-c", "release", "--arch", swiftArch, "--package-path", packageDir];

await new Promise((resolve, reject) => {
  const child = spawn("swift", swiftArgs, {
    cwd: root,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`swift build exited with code ${String(code)}`));
  });
});

await mkdir(destinationDir, { recursive: true });
await copyFile(
  path.join(packageDir, ".build", `${swiftArch}-apple-macosx`, "release", "operon-computer-use"),
  destination,
);
await chmod(destination, 0o755);

const nodeGyp = path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [nodeGyp, "rebuild", "--arch", requestedArch], {
    cwd: hostAddonDir,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`computer-use-host node-gyp exited with code ${String(code)}`));
  });
});

await copyFile(
  path.join(hostAddonDir, "build", "Release", "operon_computer_use_host.node"),
  hostAddonDestination,
);

// peer-auth addon: codesign peer verification for the Node-hosted browser-use sockets.
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
