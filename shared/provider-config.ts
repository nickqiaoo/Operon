/**
 * User-added model providers: any endpoint that speaks one of the three wire APIs below,
 * next to the built-in vendors. Stored with the built-in ones under `ai:provider_configs`,
 * keyed by an id that starts with `custom-` and never changes after creation (it is the
 * prefix of every `provider/model` id the chat picker saved), so renaming one only changes
 * its label.
 */

export type CustomProviderApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses'

export const CUSTOM_PROVIDER_APIS: readonly CustomProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages']

export interface CustomProviderInfo {
  /** Shown in Settings and the model picker. */
  name: string
  api: CustomProviderApi
}

export const CUSTOM_PROVIDER_PREFIX = 'custom-'

export function isCustomProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_PROVIDER_PREFIX) && providerId.length > CUSTOM_PROVIDER_PREFIX.length
}

export function isCustomProviderApi(value: unknown): value is CustomProviderApi {
  return typeof value === 'string' && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(value)
}

/**
 * A new provider's id, from its name: lowercase ASCII words joined by `-`, so it reads well
 * inside a model id (`custom-deepinfra/llama-4`). Names with no ASCII letters or digits
 * fall back to `provider`; a taken id gets `-2`, `-3`, ….
 */
export function customProviderId(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'provider'
  const base = `${CUSTOM_PROVIDER_PREFIX}${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
}

/**
 * The endpoint a custom provider's requests go to, from what the user typed.
 *
 * OpenAI clients take the base their docs print (`https://api.example.com/v1`,
 * `…/api/paas/v4`) and append `/chat/completions`, `/responses` and `/models` to it; a bare
 * host gets the usual `/v1`. The Anthropic client appends `/v1/messages` itself, so a
 * trailing `/v1` is dropped.
 */
export function customProviderBaseUrl(api: CustomProviderApi, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (api === 'anthropic-messages') return trimmed.replace(/\/v1$/, '')
  try {
    return new URL(trimmed).pathname.replace(/\/+$/, '') === '' ? `${trimmed}/v1` : trimmed
  } catch {
    return trimmed
  }
}
