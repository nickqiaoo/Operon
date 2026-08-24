/**
 * Popup: shows whether the native host is reachable.
 *
 * Upstream also rendered per-OS `npm install -g …` commands here, because its host ships
 * as a standalone CLI the user installs themselves. Operon's host is installed by the
 * desktop app, so there is no command for the user to run and that section is gone.
 */
const NATIVE_HOST_STATUS_KEY = "OPERON_BROWSER_USE_NATIVE_HOST_STATUS";
const NATIVE_HOST_NAME = "com.operon.browser_use.extension";
const REFRESH_INTERVAL_MS = 5000;

const statusPill = document.getElementById("status-pill");
const statusLabel = document.getElementById("status-label");
const statusMessage = document.getElementById("status-message");
const hostName = document.getElementById("host-name");
const lastChecked = document.getElementById("last-checked");
const errorMessage = document.getElementById("error-message");
const extensionVersion = document.getElementById("extension-version");
const chromeApi = globalThis.chrome;

renderExtensionVersion();
void refreshStatus();
setInterval(() => {
  void refreshStatus();
}, REFRESH_INTERVAL_MS);

async function refreshStatus() {
  if (!chromeApi?.runtime?.sendMessage) {
    renderStatus(undefined);
    return;
  }
  try {
    const response = await chromeApi.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" });
    renderStatus(response?.status);
  } catch {
    // The service worker may be asleep. It writes every status change to storage for
    // exactly this case, so the last known state is still readable.
    if (!chromeApi?.storage?.local?.get) {
      renderStatus(undefined);
      return;
    }
    const value = await chromeApi.storage.local.get(NATIVE_HOST_STATUS_KEY);
    renderStatus(value[NATIVE_HOST_STATUS_KEY]);
  }
}

function renderStatus(status) {
  const state = normalizeState(status?.state);
  const detail = statusDetails(state, status);
  statusPill.dataset.state = state;
  statusLabel.textContent = detail.label;
  statusMessage.textContent = detail.message;
  hostName.textContent = status?.hostName ?? NATIVE_HOST_NAME;
  lastChecked.textContent = formatLastChecked(status?.lastChecked);

  const error = typeof status?.error === "string" ? status.error.trim() : "";
  if (error) {
    errorMessage.hidden = false;
    errorMessage.textContent = error;
  } else {
    errorMessage.hidden = true;
    errorMessage.textContent = "";
  }
}

function renderExtensionVersion() {
  const version = chromeApi?.runtime?.getManifest?.().version;
  if (typeof version === "string" && version.trim() !== "") {
    extensionVersion.textContent = `v${version}`;
  }
}

function normalizeState(state) {
  if (state === "connected" || state === "reconnecting" || state === "disconnected") {
    return state;
  }
  return "unknown";
}

function statusDetails(state, status) {
  if (state === "connected") {
    return {
      label: "Connected",
      message: "Operon is connected and can drive this browser."
    };
  }
  if (state === "reconnecting") {
    const attempt =
      Number.isInteger(status?.reconnectAttempt) && status.reconnectAttempt > 0
        ? ` Attempt ${status.reconnectAttempt}.`
        : "";
    return {
      label: "Reconnecting",
      message: `Trying to reach the Operon native host.${attempt}`
    };
  }
  if (state === "disconnected") {
    return {
      label: "Disconnected",
      message: "The Operon native host is not running."
    };
  }
  return {
    label: "Unknown",
    message: "Native host status is unavailable."
  };
}

function formatLastChecked(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown";
  }
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
