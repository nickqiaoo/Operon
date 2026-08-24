/**
 * Dynamic port discovery for Operon.
 *
 * Operon's server port may change on each launch. This module discovers
 * the current URL by:
 *   1. Reading a metadata file published by Operon itself
 *   2. Falling back to scanning localhost LISTEN ports via `lsof`
 *   3. Caching the result until a connection failure triggers re-discovery
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerUrlResolver } from "./types.js";
import { operonAuthHeaders } from "./auth.js";

const PROBE_PATH = "/api/plugin/providers";
const PROBE_TIMEOUT_MS = 800;
const DISCOVERY_FILE_PATH = join(homedir(), ".operon", "plugin-server.json");

let cachedUrl: string | null = null;
let discoveryInFlight: Promise<string | null> | null = null;

/**
 * Get the Operon server URL, discovering it automatically if needed.
 * Returns null if Operon is not reachable.
 */
export async function getOperonUrl(): Promise<string | null> {
  // Fast path: cached and still alive
  if (cachedUrl) {
    const alive = await probe(cachedUrl);
    if (alive) return cachedUrl;
    cachedUrl = null;
  }

  // Deduplicate concurrent discovery calls
  if (discoveryInFlight) return discoveryInFlight;

  discoveryInFlight = discover();
  try {
    const url = await discoveryInFlight;
    cachedUrl = url;
    return url;
  } finally {
    discoveryInFlight = null;
  }
}

/**
 * Invalidate the cached URL so the next call re-discovers.
 */
export function invalidateCache(): void {
  cachedUrl = null;
}

export async function withOperonServerRetry<T>(
  resolveUrl: ServerUrlResolver,
  run: (serverUrl: string) => Promise<T>,
): Promise<T> {
  const serverUrl = await resolveUrl();
  if (!serverUrl) {
    throw new Error("Operon not found. Make sure the desktop app is running.");
  }

  try {
    return await run(serverUrl);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    invalidateCache();
    const retriedUrl = await resolveUrl();
    if (!retriedUrl) {
      throw error;
    }
    return await run(retriedUrl);
  }
}

/**
 * Discover Operon's server URL by scanning localhost listening ports.
 */
async function discover(): Promise<string | null> {
  const publishedUrl = await getPublishedUrl();
  if (publishedUrl) return publishedUrl;

  const ports = getListeningPorts();
  if (ports.length === 0) return null;

  // Probe ports in parallel batches for speed
  const BATCH_SIZE = 20;
  for (let i = 0; i < ports.length; i += BATCH_SIZE) {
    const batch = ports.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (port) => {
        const url = `http://localhost:${port}`;
        const ok = await probe(url);
        return ok ? url : null;
      }),
    );
    const found = results.find((r) => r !== null);
    if (found) return found;
  }

  return null;
}

async function getPublishedUrl(): Promise<string | null> {
  const publishedUrl = readPublishedUrl();
  if (!publishedUrl) return null;
  return (await probe(publishedUrl)) ? publishedUrl : null;
}

function readPublishedUrl(): string | null {
  try {
    if (!existsSync(DISCOVERY_FILE_PATH)) return null;
    const raw = readFileSync(DISCOVERY_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { url?: unknown; port?: unknown };

    if (typeof parsed.url === "string" && parsed.url.trim()) {
      return parsed.url.trim().replace(/\/+$/, "");
    }
    if (typeof parsed.port === "number" && Number.isFinite(parsed.port) && parsed.port > 0) {
      return `http://127.0.0.1:${parsed.port}`;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Probe a URL to check if it's an Operon server.
 */
async function probe(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${PROBE_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: operonAuthHeaders(),
    });
    if (!response.ok) return false;
    // Verify the response looks like Operon's provider list
    const data = (await response.json()) as Record<string, unknown>;
    return Array.isArray(data.providers);
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Get all TCP ports currently in LISTEN state on localhost.
 */
function getListeningPorts(): number[] {
  try {
    const output = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });

    const ports = new Set<number>();
    for (const line of output.split("\n")) {
      // Match lines like: node  12345  user  22u  IPv4  ...  TCP *:3000 (LISTEN)
      // or: node  12345  user  22u  IPv6  ...  TCP [::1]:3000 (LISTEN)
      const match = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port > 0 && port <= 65535) {
          ports.add(port);
        }
      }
    }

    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}
