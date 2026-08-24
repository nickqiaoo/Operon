const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fixtureBridge", {
  report(state) {
    ipcRenderer.send("fixture-state", state);
  },
});
