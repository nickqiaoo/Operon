// Verifies the boot-failure recovery path against the real built output:
// simulate a stale index.html whose hashed entry bundle no longer exists (the
// deployment it was built against is gone), which is what Cloudflare answers
// with 404.html — HTML where the browser expected an ES module.
//
// Run: node scripts/verify-pwa-recovery.mjs
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir, networkInterfaces } from 'node:os'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '..', 'dist-web')
const PORT = 4399

// The bootstrap disables itself on localhost, and serviceWorker/caches need a
// secure context — so this has to be https on a non-loopback address. A throwaway
// self-signed cert is enough; Chrome is launched ignoring cert errors.
const certDir = await mkdtemp(path.join(tmpdir(), 'operon-pwa-cert-'))
const keyPath = path.join(certDir, 'key.pem')
const certPath = path.join(certDir, 'cert.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath,
  '-days', '1', '-subj', '/CN=operon-pwa-verify',
], { stdio: 'ignore' })
const TLS = { key: await readFile(keyPath), cert: await readFile(certPath) }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

// Paths to answer with 404.html — the way a stale index.html sees a resource
// that the current deployment no longer has.
let broken = [/^\/assets\/index-.*\.js$/]
const ENTRY = [/^\/assets\/index-.*\.js$/]
const ICONS_AND_MANIFEST = [/^\/favicon\.svg$/, /^\/apple-touch-icon\.png$/, /^\/manifest\.webmanifest$/]
const STYLES = [/^\/assets\/.*\.css$/]

const server = createServer(TLS, async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  let pathname = url.pathname

  if (broken.some((re) => re.test(pathname))) {
    const body = await readFile(path.join(ROOT, '404.html'), 'utf8')
    res.writeHead(404, { 'content-type': TYPES['.html'] })
    res.end(body)
    return
  }

  if (pathname === '/') pathname = '/index.html'
  if (pathname === '/pwa-recover') pathname = '/pwa-recover.html'

  try {
    const body = await readFile(path.join(ROOT, pathname))
    res.writeHead(200, {
      'content-type': TYPES[path.extname(pathname)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    // Cloudflare serves 404.html for unknown paths, incl. missing assets.
    const body = await readFile(path.join(ROOT, '404.html'), 'utf8')
    res.writeHead(404, { 'content-type': TYPES['.html'] })
    res.end(body)
  }
})

await new Promise((resolve) => server.listen(PORT, resolve))

// The bootstrap deliberately disables itself on localhost and needs a secure
// context for serviceWorker/caches. Map a fake hostname to loopback and have
// Chrome treat it as secure, so this exercises the real production branch.
// A LAN IP rather than a fake hostname: no resolver rules needed, and it is not
// in the bootstrap's localhost exclusion list.
const HOST = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
if (!HOST) throw new Error('no non-loopback IPv4 address found')
const ORIGIN = `https://${HOST}:${PORT}`
const profile = await mkdtemp(path.join(tmpdir(), 'operon-pwa-verify-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  ignoreHTTPSErrors: true,
})
const results = []

async function check(name, fn) {
  const page = await context.newPage()
  try {
    await fn(page)
    results.push(`PASS  ${name}`)
  } catch (err) {
    results.push(`FAIL  ${name} — ${err.message.split('\n')[0]}`)
  } finally {
    // Persistent context shares storage between pages — reset between checks.
    await page.goto(`${ORIGIN}/404.html`).catch(() => {})
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() }).catch(() => {})
    await page.close()
  }
}

await check('broken entry bundle routes to /pwa-recover fast (not after the 20s watchdog)', async (page) => {
  const started = Date.now()
  await page.goto(`${ORIGIN}/`)
  await page.waitForURL(/pwa-recover/, { timeout: 15000 })
  const elapsed = Date.now() - started
  if (elapsed > 15000) throw new Error(`took ${elapsed}ms — watchdog fallback, not the error listener`)
  console.log(`   → reached /pwa-recover in ${elapsed}ms`)
})

await check('repair returns with a cache-busting param and sets the retry marker', async (page) => {
  await page.goto(`${ORIGIN}/pwa-recover?return=${encodeURIComponent(`${ORIGIN}/`)}`)
  await page.waitForURL(/__operon_recovery=/, { timeout: 15000 })
  const marker = await page.evaluate(() => localStorage.getItem('operon:pwa-recovery-attempt:v1'))
  if (marker !== '1') throw new Error(`retry marker is ${JSON.stringify(marker)}, expected "1" in localStorage`)
})

await check('a healthy boot clears the splash and never touches recovery', async (page) => {
  broken = []
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => !document.getElementById('loading-screen'), null, { timeout: 15000 })
  if (/pwa-recover/.test(page.url())) throw new Error('healthy boot was sent to recovery')
  const marker = await page.evaluate(() => localStorage.getItem('operon:pwa-recovery-attempt:v1'))
  if (marker !== null) throw new Error('healthy boot left a stale retry marker behind')
  broken = ENTRY
})

// REGRESSION: a first cut treated ANY failed same-origin script/link as fatal.
// On iOS a missing icon or manifest then sent a perfectly working app into an
// endless repair loop.
await check('a missing icon/manifest does NOT trigger recovery', async (page) => {
  broken = ICONS_AND_MANIFEST
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => !document.getElementById('loading-screen'), null, { timeout: 15000 })
  await page.waitForTimeout(1500)
  if (/pwa-recover/.test(page.url())) throw new Error('a harmless icon 404 was treated as fatal')
  broken = ENTRY
})

await check('a missing stylesheet does NOT trigger recovery', async (page) => {
  broken = STYLES
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => !document.getElementById('loading-screen'), null, { timeout: 15000 })
  await page.waitForTimeout(1500)
  if (/pwa-recover/.test(page.url())) throw new Error('a missing stylesheet was treated as fatal')
  broken = ENTRY
})

// REGRESSION (the loop the user actually hit): repair must run AT MOST once.
// location.replace() does not stop the page, so the entry module could still
// resolve, fire boot-module-loaded and wipe the retry marker on the way out —
// every repair then looked like the first one and it never converged.
await check('an unfixable boot visits /pwa-recover exactly once, then stops', async (page) => {
  let recoverVisits = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && /\/pwa-recover/.test(frame.url())) recoverVisits += 1
  })

  await page.goto(`${ORIGIN}/`)
  await page.getByRole('button', { name: /^reload$/i }).waitFor({ timeout: 25000 })
  // Give a loop a chance to show itself.
  await page.waitForTimeout(4000)

  const marker = await page.evaluate(() => localStorage.getItem('operon:pwa-recovery-attempt:v1'))
  if (marker !== '1') throw new Error(`retry marker was wiped (${JSON.stringify(marker)}) — that is the loop`)
  if (recoverVisits !== 1) throw new Error(`visited /pwa-recover ${recoverVisits}x, expected exactly 1`)
  console.log(`   → /pwa-recover visited ${recoverVisits}x, then settled on the manual button`)
})

await check('the failure screen reports which build is running', async (page) => {
  await page.goto(`${ORIGIN}/`)
  await page.getByRole('button', { name: /^reload$/i }).waitFor({ timeout: 25000 })
  const build = await page.locator('text=/^build: /').innerText()
  if (!/build: (index-.*\.js|no entry script)/.test(build)) throw new Error(`unhelpful build line: ${build}`)
  console.log(`   → ${build}`)
})

await context.close()
server.close()

console.log('\n' + results.join('\n'))
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
