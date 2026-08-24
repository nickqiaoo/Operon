/**
 * Persistent session config store for the Operon adapter plugin.
 * Session entries are keyed by a stable conversation key.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OperonSessionConfig {
  providerId?: string;
  providerLabel?: string;
  workspaceId?: number;
  workspaceName?: string;
  modelId?: string;
  chatId?: number;
  ready?: boolean;
  /** Temporary: workspace choices during wizard */
  _workspaceChoices?: unknown;
  /** Temporary: model choices during wizard */
  _modelChoices?: unknown;
}

interface PersistedOperonStore {
  version: 1;
  sessions: Record<string, OperonSessionConfig>;
  runtimeSessions: Record<string, string>;
}

const DEFAULT_STORE_PATH = join(
  process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw"),
  "plugins",
  "operon-adapter",
  "sessions.json",
);

let storePath = DEFAULT_STORE_PATH;
let cachedStore: PersistedOperonStore | null = null;

export function configureSessionStore(nextPath?: string): string {
  storePath = nextPath?.trim() || DEFAULT_STORE_PATH;
  cachedStore = null;
  return storePath;
}

export function getSessionStorePath(): string {
  return storePath;
}

export function buildLegacySessionKey(channel: string, senderId?: string): string {
  return `${channel}:${senderId?.trim() || "anon"}`;
}

export function deriveSessionStoreKeyFromSessionKey(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:[^:]+:([^:]+):(direct|group|channel):(.+)$/);
  if (!match) return null;
  const [, channel, , conversationId] = match;
  return buildLegacySessionKey(channel, conversationId);
}

export function getSessionConfig(key: string): OperonSessionConfig | undefined {
  const config = loadStore().sessions[key];
  return config ? { ...config } : undefined;
}

export function setSessionConfig(key: string, config: OperonSessionConfig): void {
  updateStore((store) => {
    store.sessions[key] = { ...config };
  });
}

export function clearSessionConfig(key: string): void {
  updateStore((store) => {
    delete store.sessions[key];
  });
}

export function getRuntimeSessionKey(sessionId: string): string | undefined {
  const sessionKey = loadStore().runtimeSessions[sessionId];
  return typeof sessionKey === "string" && sessionKey.length > 0 ? sessionKey : undefined;
}

export function setRuntimeSessionKey(sessionId: string, sessionKey: string): void {
  if (!sessionId.trim() || !sessionKey.trim()) return;
  updateStore((store) => {
    store.runtimeSessions[sessionId] = sessionKey;
  });
}

function loadStore(): PersistedOperonStore {
  if (cachedStore) return cachedStore;

  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedOperonStore>;
    cachedStore = normalizeStore(parsed);
  } catch {
    cachedStore = createEmptyStore();
  }

  return cachedStore;
}

function updateStore(mutator: (store: PersistedOperonStore) => void): void {
  const store = loadStore();
  mutator(store);
  writeStore(store);
}

function writeStore(store: PersistedOperonStore): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tempPath, storePath);
  cachedStore = store;
}

function normalizeStore(store: Partial<PersistedOperonStore> | null | undefined): PersistedOperonStore {
  return {
    version: 1,
    sessions: isRecord(store?.sessions) ? toSessionConfigRecord(store.sessions) : {},
    runtimeSessions: isRecord(store?.runtimeSessions) ? toStringRecord(store.runtimeSessions) : {},
  };
}

function createEmptyStore(): PersistedOperonStore {
  return {
    version: 1,
    sessions: {},
    runtimeSessions: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function toSessionConfigRecord(value: Record<string, unknown>): Record<string, OperonSessionConfig> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, OperonSessionConfig] =>
        typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
    ),
  );
}
