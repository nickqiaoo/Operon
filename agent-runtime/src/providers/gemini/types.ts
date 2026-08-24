export interface BaseProviderOptions {
  proxy?: string
}

export type GeminiProviderOptions =
  | (GeminiApiKeyAuth & BaseProviderOptions)
  | (VertexAIAuth & BaseProviderOptions)
  | (OAuthAuth & BaseProviderOptions)
  | (GoogleAuthLibraryAuth & BaseProviderOptions)
  | ({ authType?: undefined } & BaseProviderOptions)

export interface GeminiApiKeyAuth {
  authType: 'api-key' | 'gemini-api-key'
  apiKey?: string
}

export interface VertexAIAuth {
  authType: 'vertex-ai'
  vertexAI: {
    projectId: string
    location: string
    apiKey?: string
  }
}

export interface OAuthAuth {
  authType: 'oauth' | 'oauth-personal'
  cacheDir?: string
}

export interface GoogleAuthLibraryAuth {
  authType: 'google-auth-library'
  googleAuth?: unknown
  googleAuthClient?: unknown
}

export interface GeminiSkillItem {
  name: string
  description: string
}

export type GeminiMcpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

export interface GeminiRuntimeSettings {
  cwd?: string
  interactive?: boolean
  modelSteering?: boolean
  approvalMode?: string
  sessionId?: string
  logger?: false
  verbose?: boolean
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  thinkingConfig?: {
    thinkingLevel?: string
    thinkingBudget?: number
    includeThoughts?: boolean
  }
  userMemory?: string
  mcpServers?: Record<string, GeminiMcpServerEntry>
  policySettings?: {
    mcp?: { excluded?: string[]; allowed?: string[] }
    tools?: { exclude?: string[]; allowed?: string[] }
    mcpServers?: Record<string, { trust?: boolean }>
  }
}
