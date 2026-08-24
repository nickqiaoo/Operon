// Frontend mirror of the server's persistent remote-device summary.
// Kept in-sync by hand; the shape is stable and narrow.

export type MobilePairingStatus = 'pending' | 'confirmed' | 'revoked'

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
