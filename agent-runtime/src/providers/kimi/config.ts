import type { Model } from '../../types.js'
import type { AcpDiscoveryContext, AcpModelDiscovery, AcpProviderConfig } from '../acp/index.js'

export const DEFAULT_KIMI_MODEL_ID = 'kimi-code/kimi-for-coding'

/**
 * Kimi Code exposes its model list through the ACP `session/new` `configOptions`
 * extension, which the standard SDK schema drops during validation. Since the
 * default install ships a single coding model, we surface it statically rather
 * than parsing a non-standard field; `setSessionModel` still applies the id.
 */
const KIMI_MODELS: Model[] = [
  {
    id: DEFAULT_KIMI_MODEL_ID,
    name: 'Kimi K2.6',
    description: 'Kimi Code default coding model',
    providerId: 'kimi',
    providerLabel: 'Kimi Code',
    providerLogo: 'moonshot',
  },
]

function extractKimiModels(_ctx: AcpDiscoveryContext, preferredModelId?: string): AcpModelDiscovery {
  const availableIds = new Set(KIMI_MODELS.map((m) => m.id))
  const currentModelId = preferredModelId && availableIds.has(preferredModelId) ? preferredModelId : DEFAULT_KIMI_MODEL_ID
  return { models: KIMI_MODELS, currentModelId }
}

export const KIMI_CONFIG: AcpProviderConfig = {
  providerId: 'kimi',
  cliId: 'kimi',
  label: 'Kimi Code',
  logo: 'moonshot',
  agentArgs: ['acp'],
  modes: [
    { id: 'default', name: 'Default', description: 'Manual approvals; tools execute normally' },
    { id: 'plan', name: 'Plan', description: 'Read-only planning; no tool execution' },
    { id: 'auto', name: 'Auto', description: 'Auto-approve safe operations' },
    { id: 'yolo', name: 'YOLO', description: 'Auto-approve everything' },
  ],
  defaultModeId: 'default',
  defaultModelId: DEFAULT_KIMI_MODEL_ID,
  features: {
    permissions: true,
    attachments: true,
    injection: false,
    sessionResume: true,
  },
  modelProbe: 'none',
  extractModels: extractKimiModels,
}
