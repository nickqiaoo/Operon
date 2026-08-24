export type PermissionOutcome = 'allow' | 'deny' | 'allowAlways'
export type WirePermissionOutcome = 'allow' | 'deny' | 'allow-always'

export interface PermissionOption {
  outcome: PermissionOutcome
  label: string
  tone: 'allow' | 'reject'
  updatedInput?: Record<string, unknown>
}

interface RawPermissionOption {
  kind: string
  name: string
  optionId: string
}

function normalizeRawOption(raw: RawPermissionOption): PermissionOption {
  const isReject = raw.kind.startsWith('reject')
  const outcome: PermissionOutcome = isReject
    ? 'deny'
    : raw.kind === 'allow_always'
      ? 'allowAlways'
      : 'allow'

  return {
    outcome,
    label: raw.name,
    tone: isReject ? 'reject' : 'allow',
  }
}

const DEFAULT_OPTIONS: PermissionOption[] = [
  { outcome: 'deny', label: 'Reject', tone: 'reject' },
  { outcome: 'allow', label: 'Allow', tone: 'allow' },
  { outcome: 'allowAlways', label: 'Allow always', tone: 'allow' },
]

export interface ExtractedPermissions {
  options: PermissionOption[]
  displayInput: Record<string, unknown>
}

export function extractPermissionOptions(
  rawInput: Record<string, unknown>,
  defaults?: PermissionOption[],
): ExtractedPermissions {
  const { permissionOptions, ...displayInput } = rawInput as {
    permissionOptions?: RawPermissionOption[]
    [key: string]: unknown
  }

  if (!permissionOptions || permissionOptions.length === 0) {
    return { options: defaults ?? DEFAULT_OPTIONS, displayInput }
  }

  const normalized = permissionOptions.map(normalizeRawOption)

  if (!normalized.some((option) => option.outcome === 'allowAlways')) {
    normalized.push({ outcome: 'allowAlways', label: 'Allow always', tone: 'allow' })
  }

  return { options: normalized, displayInput }
}

export function toWirePermissionOutcome(outcome: PermissionOutcome): WirePermissionOutcome {
  return outcome === 'allowAlways' ? 'allow-always' : outcome
}
