/**
 * Risk-control pacing for the note / comments / download detail pages.
 *
 * Reading notes back-to-back trips a soft block (`website-login/error?error_code=300017`
 * / `300031`, or a "安全限制" / "访问链接异常" page) that a single reload after a
 * real cooldown often clears. So retry ONCE after a long randomized cooldown,
 * never more: hammering a hot risk state is what escalates it toward an
 * account violation.
 */

import { SiteAdapterError } from "../errors.ts"
import type { AdapterPage } from "../types.ts"
import { isRecord } from "./shared.ts"

export function jitterSeconds(minS: number, maxS: number, rand: () => number = Math.random): number {
  return minS + rand() * (maxS - minS)
}

export function isSecurityBlock(data: unknown): boolean {
  return isRecord(data) && Boolean(data.securityBlock)
}

export class SecurityBlockError extends SiteAdapterError {
  constructor(message: string, hint?: string) {
    super("SECURITY_BLOCK", message, hint)
    this.name = "SecurityBlockError"
  }
}

export interface DetailReadOptions {
  url: string
  extractJs: string
  securityHelp?: string
  settleMinS?: number
  settleMaxS?: number
  retryOnBlock?: boolean
  cooldownMinS?: number
  cooldownMaxS?: number
  rand?: () => number
  /**
   * Run the extract through the privileged channel. Needed when the script
   * awaits inside the page (scroll-and-wait loops) or clicks: the read-only
   * guard blocks the page's own DOM inserts for as long as the script runs.
   */
  privileged?: boolean
  /**
   * Epoch ms the whole command must finish by. The cooldown retry is skipped
   * (and the block reported) when it would not fit: MCP clients abandon a tool
   * call after about a minute, and a result nobody receives helps no one.
   */
  deadlineAt?: number
}

/** A retry is a cooldown plus a full navigation, settle and read. */
const RETRY_READ_ALLOWANCE_MS = 25_000

export async function readXhsDetailPage(page: AdapterPage, options: DetailReadOptions): Promise<unknown> {
  const {
    url,
    extractJs,
    securityHelp,
    settleMinS = 2,
    settleMaxS = 5,
    retryOnBlock = true,
    cooldownMinS = 8,
    cooldownMaxS = 18,
    rand = Math.random,
    privileged = false,
    deadlineAt,
  } = options
  const readOnce = async () => {
    await page.goto(url)
    await page.wait({ time: jitterSeconds(settleMinS, settleMaxS, rand) })
    return privileged ? page.evaluateWrite(extractJs) : page.evaluate(extractJs)
  }

  let data = await readOnce()
  // At most one retry, structurally: a single `if`, never a loop.
  if (retryOnBlock && isSecurityBlock(data)) {
    const cooldownS = jitterSeconds(cooldownMinS, cooldownMaxS, rand)
    const fits = deadlineAt == null || Date.now() + cooldownS * 1000 + RETRY_READ_ALLOWANCE_MS < deadlineAt
    if (fits) {
      await page.wait({ time: cooldownS })
      data = await readOnce()
    }
  }
  if (isSecurityBlock(data)) {
    throw new SecurityBlockError(
      "Xiaohongshu security block: the note detail page was blocked by risk control.",
      securityHelp,
    )
  }
  return data
}
