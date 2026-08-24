const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.commandLine.appendSwitch("force-renderer-accessibility");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.setName("Operon CUA Electron Fixture");

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const statePath = argumentValue("--state-file");
if (!statePath) {
  throw new Error("Electron fixture requires --state-file");
}

function writeState(rendererState = {}) {
  const payload = {
    pid: process.pid,
    ready: true,
    ...rendererState,
  };
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), "utf8");
  fs.renameSync(temporaryPath, statePath);
}

ipcMain.on("fixture-state", (_event, state) => {
  writeState(state);
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 760,
    height: 680,
    x: 980,
    y: 150,
    show: false,
    title: "Operon CUA Electron Fixture",
    backgroundColor: "#f7f9fc",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  window.setTitle("Operon CUA Electron Fixture");
  await window.loadFile(path.join(__dirname, "index.html"));
  window.showInactive();
});

app.on("window-all-closed", () => app.quit());
