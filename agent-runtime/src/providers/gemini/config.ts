import {
  ApprovalMode,
  AuthType,
  Config,
  createPolicyEngineConfig,
  SkillManager,
  Storage,
  type ConfigParameters,
  type MCPServerConfig,
} from '@google/gemini-cli-core'
import type { GeminiProviderOptions, GeminiRuntimeSettings, GeminiSkillItem } from './types.js'

export async function listSkills(cwd?: string): Promise<GeminiSkillItem[]> {
  const workDir = cwd ?? process.cwd()
  const manager = new SkillManager()
  const storage = new Storage(workDir)
  await manager.discoverSkills(storage)
  return manager.getDisplayableSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
  }))
}

function mapAuthType(options: GeminiProviderOptions): AuthType | undefined {
  if (options.authType === 'api-key' || options.authType === 'gemini-api-key') {
    return AuthType.USE_GEMINI
  }
  if (options.authType === 'vertex-ai') {
    return AuthType.USE_VERTEX_AI
  }
  if (options.authType === 'oauth' || options.authType === 'oauth-personal') {
    return AuthType.LOGIN_WITH_GOOGLE
  }
  if (options.authType === 'google-auth-library') {
    return AuthType.USE_GEMINI
  }
  return undefined
}

function mapApprovalMode(mode?: string): ApprovalMode {
  if (!mode) return ApprovalMode.DEFAULT
  switch (mode.toLowerCase()) {
    case 'autoedit':
      return ApprovalMode.AUTO_EDIT
    case 'yolo':
      return ApprovalMode.YOLO
    default:
      return ApprovalMode.DEFAULT
  }
}

function toGeminiMcpServers(
  mcpServers?: GeminiRuntimeSettings['mcpServers'],
): Record<string, MCPServerConfig> | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined
  const result: Record<string, MCPServerConfig> = {}
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry.type || entry.type === 'stdio') {
      result[name] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
      } as unknown as MCPServerConfig
      continue
    }
    if (!('url' in entry)) continue
    result[name] = {
      url: entry.url,
      headers: entry.headers,
      type: entry.type,
    } as unknown as MCPServerConfig
  }
  return result
}

export async function initializeRuntime(
  providerOptions: GeminiProviderOptions,
  modelId: string,
  runtimeSettings: GeminiRuntimeSettings,
): Promise<{ config: Config; sessionId: string }> {
  const sessionId = crypto.randomUUID()
  const cwd = runtimeSettings.cwd || process.cwd()
  const interactive = runtimeSettings.interactive ?? true
  const approvalMode = mapApprovalMode(runtimeSettings.approvalMode)
  const authType = mapAuthType(providerOptions) ?? AuthType.LOGIN_WITH_GOOGLE

  if (
    (providerOptions.authType === 'api-key' || providerOptions.authType === 'gemini-api-key') &&
    'apiKey' in providerOptions &&
    providerOptions.apiKey
  ) {
    process.env.GEMINI_API_KEY = providerOptions.apiKey
  }

  const policyEngineConfig = await createPolicyEngineConfig(
    {
      mcp: runtimeSettings.policySettings?.mcp ?? {},
      tools: runtimeSettings.policySettings?.tools ?? {},
      mcpServers: runtimeSettings.policySettings?.mcpServers ?? {},
    },
    approvalMode,
  )

  const geminiMcpServers = toGeminiMcpServers(runtimeSettings.mcpServers)
  const configParams: ConfigParameters = {
    sessionId,
    targetDir: cwd,
    debugMode: false,
    cwd,
    model: modelId,
    modelSteering: runtimeSettings.modelSteering ?? true,
    approvalMode,
    policyEngineConfig,
    noBrowser: true,
    interactive,
    proxy:
      providerOptions.proxy ||
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      undefined,
    usageStatisticsEnabled: false,
    telemetry: { enabled: false },
    ...(geminiMcpServers ? { mcpServers: geminiMcpServers } : {}),
  }

  const config = new Config(configParams)
  await config.refreshAuth(authType)
  await config.initialize()
  await config.refreshMcpContext()
  return { config, sessionId }
}
