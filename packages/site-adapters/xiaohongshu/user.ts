/**
 * `xiaohongshu.userNotes`: a profile's public notes with signed URLs.
 * Page logic from OpenCLI clis/xiaohongshu/user.js (reads the Pinia user store).
 */

import { defineCommand } from "../define.ts"
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "../errors.ts"
import type { AdapterPage } from "../types.ts"
import { XHS_WEB_HOST, type Row } from "./shared.ts"
import { isRecord, requirePage } from "../runtime/values.ts"
import { extractXhsUserNotes, flattenXhsNoteGroups, normalizeXhsUserId, type XhsUserNoteRow } from "./user-helpers.ts"

const USER_SNAPSHOT_JS = `
  (() => {
    const safeClone = (value) => {
      try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return null; }
    };
    const userStore = window.__INITIAL_STATE__?.user;
    const hasUserStore = Boolean(userStore && typeof userStore === 'object');
    const rawNotes = hasUserStore ? (userStore.notes?._value || userStore.notes) : undefined;
    const rawPageData = hasUserStore ? (userStore.userPageData?._value || userStore.userPageData) : undefined;
    const loggedIn = hasUserStore ? (userStore.loggedIn?._value ?? userStore.loggedIn) : undefined;
    const basic = rawPageData?.basicInfo || {};
    return {
      noteGroups: safeClone(rawNotes || []),
      nickname: basic.nickname || '',
      storePresent: hasUserStore,
      notesPresent: Array.isArray(rawNotes),
      // Profiles are stricter than search: an expired session 302s to /login.
      loginWall: Boolean((location.pathname || '').indexOf('/login') === 0 || loggedIn === false),
    };
  })()
`

async function readSnapshot(page: AdapterPage): Promise<Row> {
  const snapshot = await page.evaluate(USER_SNAPSHOT_JS)
  if (!isRecord(snapshot)) throw new CommandExecutionError("xiaohongshu.userNotes: malformed user snapshot")
  if (snapshot.loginWall === true) {
    throw new AuthRequiredError(XHS_WEB_HOST, "Xiaohongshu profile requires login (redirected to /login)")
  }
  return snapshot
}

function assertReadable(snapshot: Row): void {
  if (snapshot.storePresent !== true) throw new CommandExecutionError("xiaohongshu.userNotes: user store was not found")
  if (snapshot.notesPresent !== true) throw new CommandExecutionError("xiaohongshu.userNotes: notes array was not found")
}

export const userNotes = defineCommand({
  site: "xiaohongshu",
  name: "userNotes",
  description: "Public notes of a Xiaohongshu user, newest first, with signed note URLs for getNote.",
  keywords: ["小红书", "用户", "博主", "主页", "笔记列表", "rednote", "xhs"],
  domain: XHS_WEB_HOST,
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", required: true, help: "User id or profile URL" },
    { name: "limit", type: "int", default: 15, help: "Number of notes" },
  ],
  func: async (rawPage, kwargs): Promise<XhsUserNoteRow[]> => {
    const page = requirePage(rawPage, "xiaohongshu.userNotes")
    const userId = normalizeXhsUserId(kwargs.user)
    const limit = Math.max(1, Number(kwargs.limit) || 15)
    await page.goto(`https://${XHS_WEB_HOST}/user/profile/${userId}`)

    // The store hydrates after first paint and notes load later still: retry
    // until notes appear (an empty account runs the retries out and ends empty).
    let snapshot = await readSnapshot(page)
    for (let i = 0; i < 8 && flattenXhsNoteGroups(snapshot.noteGroups).length === 0; i++) {
      await page.wait({ time: 2 })
      snapshot = await readSnapshot(page)
    }
    assertReadable(snapshot)
    let results = extractXhsUserNotes(snapshot, userId)
    for (let i = 0; results.length < limit && i < 4; i++) {
      await page.autoScroll({ times: 1, delayMs: 1500 })
      await page.wait(1)
      snapshot = await readSnapshot(page)
      assertReadable(snapshot)
      const next = extractXhsUserNotes(snapshot, userId)
      if (next.length <= results.length) break
      results = next
    }
    if (results.length === 0) {
      throw new EmptyResultError("xiaohongshu.userNotes", "This user has no public notes (deleted, private, or empty account).")
    }
    return results.slice(0, limit)
  },
})
