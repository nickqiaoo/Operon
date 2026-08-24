/**
 * Startup-token auth for talking to the Operon server.
 *
 * The server gates /api/* behind a per-launch token (see
 * server/src/services/api-token.ts) and publishes it for out-of-process local
 * consumers at ~/.operon/run/api-token (0600). This native host runs as the
 * same user, so it reads the file and stamps the token on every request.
 *
 * Read fresh with a short cache rather than once at startup: the token rotates
 * whenever the Operon app restarts, and this host outlives those restarts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_PATH = join(homedir(), ".operon", "run", "api-token");
const CACHE_MS = 5_000;

let cached: string | null = null;
let cachedAt = 0;

function readToken(): string | null {
  const now = Date.now();
  if (now - cachedAt < CACHE_MS) return cached;
  cachedAt = now;
  try {
    cached = readFileSync(TOKEN_PATH, "utf-8").trim() || null;
  } catch {
    // No file: the server predates token auth or runs with it disabled.
    cached = null;
  }
  return cached;
}

/** Headers to spread into every fetch against the Operon server. */
export function operonAuthHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { "x-operon-token": token } : {};
}
