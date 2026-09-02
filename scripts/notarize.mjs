import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'

const exec = promisify(execFile)

// 一次提交在 Apple 侧超过这个时长仍是 In Progress，就判定为卡死并重新提交。
// 正常公证是 3~10 分钟；2026-09-01 遇到过一次卡死 74 分钟无响应，重传后 3 分钟通过。
const STALL_TIMEOUT_MS = 20 * 60 * 1000
const POLL_INTERVAL_MS = 30 * 1000
const MAX_SUBMISSIONS = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(`  • notarize  ${msg}`)

function readCredentials() {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) return null
  return ['--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID]
}

async function notarytool(args, credentials) {
  const { stdout } = await exec('xcrun', ['notarytool', ...args, ...credentials, '--output-format', 'json'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/**
 * 票据在 Apple 侧是按 app 签名的 CDHash 索引的，与提交 ID 无关。
 * 所以先直接试 staple：若这个 CDHash 之前已公证通过（上一轮构建公证成功但
 * 后续步骤失败），就能直接命中，省掉整个打包上传流程。
 */
async function tryStapleExistingTicket(appPath) {
  try {
    await exec('xcrun', ['stapler', 'staple', appPath])
    return true
  } catch {
    return false
  }
}

async function submitOnce(zipPath, credentials) {
  const result = await notarytool(['submit', zipPath, '--no-wait'], credentials)
  return result.id
}

/**
 * 轮询单次提交的结果。
 * 网络错误不视为失败——继续轮询即可，包已经在 Apple 手里了。
 * 这正是 electron-builder 内置公证的缺陷：轮询期间一次 connectTimeout 就整轮报错退出。
 */
async function waitForResult(submissionId, credentials) {
  const deadline = Date.now() + STALL_TIMEOUT_MS
  let networkErrors = 0

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    try {
      const info = await notarytool(['info', submissionId], credentials)
      if (info.status !== 'In Progress') return info.status
      networkErrors = 0
    } catch (error) {
      networkErrors += 1
      log(`查询状态失败（第 ${networkErrors} 次，将继续重试）: ${error.message.split('\n')[0]}`)
    }
  }
  return 'Stalled'
}

async function printFailureLog(submissionId, credentials) {
  try {
    const detail = await notarytool(['log', submissionId], credentials)
    console.error(JSON.stringify(detail, null, 2).slice(0, 4000))
  } catch (error) {
    console.error(`  • notarize  无法获取失败日志: ${error.message}`)
  }
}

/**
 * afterSign hook for electron-builder.
 * 取代 electron-builder 内置公证（配置里已 notarize: false），
 * 增加三层容错：命中已有票据 / 轮询期网络错误重试 / 提交卡死后重新提交。
 */
export default async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return

  const credentials = readCredentials()
  if (!credentials) {
    log('未设置 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID，跳过公证')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) throw new Error(`找不到待公证的 app: ${appPath}`)

  if (await tryStapleExistingTicket(appPath)) {
    log('该签名已有公证票据，直接 staple 完成（跳过上传）')
    return
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-notarize-'))
  const zipPath = path.join(tmpDir, `${appName}.zip`)

  try {
    log(`打包待公证 app: ${appPath}`)
    await exec('ditto', ['-c', '-k', '--keepParent', appPath, zipPath])

    for (let attempt = 1; attempt <= MAX_SUBMISSIONS; attempt += 1) {
      log(`提交公证（第 ${attempt}/${MAX_SUBMISSIONS} 次）...`)
      const submissionId = await submitOnce(zipPath, credentials)
      log(`提交 ID: ${submissionId}，等待结果（最长 ${STALL_TIMEOUT_MS / 60000} 分钟）`)

      const status = await waitForResult(submissionId, credentials)

      if (status === 'Accepted') {
        log('公证通过，staple 票据')
        await exec('xcrun', ['stapler', 'staple', appPath])
        await exec('xcrun', ['stapler', 'validate', appPath])
        log('完成')
        return
      }

      if (status === 'Stalled') {
        log(`提交 ${submissionId} 超过 ${STALL_TIMEOUT_MS / 60000} 分钟无结果，判定卡死，重新提交`)
        continue
      }

      log(`公证失败，状态: ${status}`)
      await printFailureLog(submissionId, credentials)
      throw new Error(`公证失败: ${status}`)
    }

    throw new Error(`公证连续 ${MAX_SUBMISSIONS} 次卡死，请检查 https://developer.apple.com/system-status/`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
