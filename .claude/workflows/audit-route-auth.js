export const meta = {
  name: 'audit-route-auth',
  description: 'Audit every API endpoint under server/ and relay/ routes for missing auth checks',
  phases: [
    { title: 'Baseline', detail: 'map how auth is enforced + router mount points' },
    { title: 'Audit', detail: 'one agent per route file, list endpoints + auth status' },
    { title: 'Verify', detail: 'adversarially confirm each suspected missing-auth finding' },
  ],
}

const files = args

// ---------- Phase 1: establish the auth baseline (barrier) ----------
phase('Baseline')
const BASELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'authMechanisms', 'mounts', 'intentionallyPublic'],
  properties: {
    summary: { type: 'string', description: 'How auth is enforced across the server + relay apps' },
    authMechanisms: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'how'],
        properties: {
          name: { type: 'string' },
          how: { type: 'string', description: 'e.g. global app.use middleware, per-route requireAuth, applied at mount in app.ts, none' },
        },
      },
    },
    mounts: {
      type: 'array',
      description: 'Each router mount: which router file, at what path, and whether auth middleware is applied at the mount point',
      items: {
        type: 'object', additionalProperties: false,
        required: ['routerVar', 'mountPath', 'authAtMount'],
        properties: {
          routerVar: { type: 'string' },
          mountPath: { type: 'string' },
          authAtMount: { type: 'string', description: 'name of auth middleware applied at mount, or "none"' },
        },
      },
    },
    intentionallyPublic: {
      type: 'array', items: { type: 'string' },
      description: 'Routes/paths that are public by design (health, login, webhooks, pairing, metrics, etc.)',
    },
  },
}

const baseline = await agent(
  `You are establishing the AUTHENTICATION BASELINE for two Hono apps in this repo before a per-file security audit.

Read these files end-to-end:
- server/src/app.ts  (the main server: how middleware + routers are wired)
- server/src/index.ts and server/src/start.ts (entry, any global middleware)
- relay/src/server.ts and relay/src/index.ts (the relay app)
Also grep the codebase for auth primitives: requireAuth, authMiddleware, isAuthenticated, verifyToken, Bearer, x-api-key, HMAC, sessionToken, device token verification.

Produce a precise picture of:
1. What auth mechanisms exist and HOW each is applied — global app.use? per-route inside handlers? applied at the mount point in app.ts (e.g. app.use('/api/x', requireAuth, xRoutes))? or nothing at all?
2. A mount map: for EVERY router mounted in app.ts (and relay), the router variable, the mount path, and whether an auth middleware is attached AT THE MOUNT (this is critical — a route file can have zero in-file auth yet still be protected at the mount).
3. Which endpoints/paths are public BY DESIGN (login, health, webhooks, mobile pairing, metrics, register, etc.).

Be concrete with middleware names and file:line where it matters.`,
  { label: 'baseline', phase: 'Baseline', schema: BASELINE_SCHEMA }
)

log(`baseline ready: ${baseline.mounts.length} mounts, ${baseline.authMechanisms.length} auth mechanisms`)

const baselineJson = JSON.stringify(baseline)

// ---------- Phase 2+3: audit each file, then verify suspected gaps ----------
const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'isEndpointFile', 'endpoints'],
  properties: {
    file: { type: 'string' },
    isEndpointFile: { type: 'boolean', description: 'false for helper/types/rate-limit files with no HTTP endpoints' },
    endpoints: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['method', 'path', 'line', 'inFileAuth', 'verdict', 'reasoning'],
        properties: {
          method: { type: 'string' },
          path: { type: 'string', description: 'route path as declared in the file' },
          line: { type: 'number' },
          inFileAuth: { type: 'string', description: 'auth check found INSIDE this file/handler, or "none"' },
          verdict: { type: 'string', enum: ['protected', 'suspected-missing', 'public-by-design'] },
          reasoning: { type: 'string' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'confirmedMissing'],
  properties: {
    file: { type: 'string' },
    confirmedMissing: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['method', 'path', 'line', 'severity', 'whatItExposes', 'whyReal'],
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          whatItExposes: { type: 'string', description: 'what an unauthenticated caller can do/read/write' },
          whyReal: { type: 'string', description: 'why this is NOT covered by mount-level or global auth' },
        },
      },
    },
    dismissedFalsePositives: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'why'],
        properties: { path: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
}

phase('Audit')
const results = await pipeline(
  files,
  // stage 1: audit the file
  (file) => agent(
    `Audit this route file for MISSING AUTHENTICATION checks: ${file}

Read the full file. For EVERY HTTP endpoint it declares (router.get/post/put/delete/patch, app.get, .on, SSE/WS handlers), determine:
- method, path, line number, handler name
- whether an auth check exists INSIDE this file (middleware passed to the route, or a check at the top of the handler, or a router-level .use within this file)
- a verdict: "protected" (has in-file auth), "suspected-missing" (no in-file auth visible), or "public-by-design" (clearly meant to be public: login, health, webhook, pairing, metrics, register).

IMPORTANT: only judge what is IN THIS FILE. Auth applied at the MOUNT point lives in app.ts and is handled by a later verification step — so "suspected-missing" just means "no auth visible in this file", not a confirmed vulnerability. If the file has no HTTP endpoints (types, rate-limit helpers, transport plumbing), set isEndpointFile=false and return an empty endpoints array.

Here is the project's auth baseline for reference (do not rely on it to clear findings — that's the verifier's job):
${baselineJson}`,
    { label: `audit:${file.split('/').pop()}`, phase: 'Audit', schema: AUDIT_SCHEMA }
  ),
  // stage 2: verify only the suspected-missing ones against the mount map
  (audit, file) => {
    if (!audit || !audit.isEndpointFile) return { file, confirmedMissing: [] }
    const suspects = audit.endpoints.filter(e => e.verdict === 'suspected-missing')
    if (suspects.length === 0) return { file, confirmedMissing: [] }
    return agent(
      `Adversarially VERIFY suspected missing-auth findings in ${file}. Your job is to REFUTE false positives — default to dismissing a finding unless you can show an unauthenticated caller really can reach it.

For each suspected endpoint below, check the FULL auth picture:
- Is auth applied at the MOUNT point in server/src/app.ts (e.g. app.use('/path', requireAuth, theseRoutes)) or via a global app.use middleware? If so → NOT a vulnerability, dismiss it.
- Is it public by design (login/health/webhook/pairing/metrics/register/HMAC-signed device endpoint)? → dismiss.
- Only if NO mount-level, no global, and no in-file auth protects it, AND it exposes something sensitive (fs access, command/terminal exec, reading/writing project data, secrets/config, admin ops) → confirm it as a real missing-auth vulnerability with a severity.

Re-read server/src/app.ts (and relay/src/server.ts for relay files) to confirm the actual mount + middleware for this file. Cite file:line.

Auth baseline:
${baselineJson}

Suspected endpoints to verify:
${JSON.stringify(suspects)}`,
      { label: `verify:${file.split('/').pop()}`, phase: 'Verify', schema: VERIFY_SCHEMA }
    )
  }
)

// ---------- aggregate ----------
const clean = results.filter(Boolean)
const findings = clean
  .filter(r => r.confirmedMissing && r.confirmedMissing.length > 0)
  .map(r => ({ file: r.file, missing: r.confirmedMissing }))

const sevRank = { critical: 0, high: 1, medium: 2, low: 3 }
findings.sort((a, b) => {
  const sa = Math.min(...a.missing.map(m => sevRank[m.severity] ?? 9))
  const sb = Math.min(...b.missing.map(m => sevRank[m.severity] ?? 9))
  return sa - sb
})

const totalMissing = findings.reduce((n, f) => n + f.missing.length, 0)
log(`audit complete: ${totalMissing} confirmed missing-auth endpoints across ${findings.length} files`)

return {
  baselineSummary: baseline.summary,
  filesAudited: files.length,
  totalConfirmedMissing: totalMissing,
  findings,
}
