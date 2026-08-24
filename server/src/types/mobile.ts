// Persistent device records shared by remote end-to-end encryption pairing.

export type MobilePairingStatus = 'pending' | 'confirmed' | 'revoked'

export interface MobilePairingRow {
  id: number
  desktopId: string
  mobileDeviceId: string
  mobilePublicKey: Uint8Array
  mobileFingerprint: string
  mobileLabel: string | null
  pairingNonce: string
  status: MobilePairingStatus
  createdAt: number
  confirmedAt: number | null
  revokedAt: number | null
  lastSeenAt: number | null
}

export interface CreateMobilePairingInput {
  desktopId: string
  mobileDeviceId: string
  mobilePublicKey: Uint8Array
  mobileFingerprint: string
  mobileLabel?: string | null
  pairingNonce: string
  status: MobilePairingStatus
}

// Public shape sent to the desktop settings UI. Private key bytes never leave
// the server; the public key is exposed as a hex string for display only.
export interface MobilePairingSummary {
  id: number
  desktopId: string
  mobileDeviceId: string
  mobileFingerprint: string
  mobileLabel: string | null
  status: MobilePairingStatus
  createdAt: number
  confirmedAt: number | null
  lastSeenAt: number | null
}
