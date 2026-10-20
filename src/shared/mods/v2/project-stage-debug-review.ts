/** Trusted native-to-renderer navigation only. No execution or approval token is present. */
export interface StageDebugReviewIntent {
  id: string
  threadId: string
  workspace: string
  incarnation: { token: string | null; legacyCreatedAt: number }
  snapshotId: string
  draftId: string
  revision: number
  candidateDigest: string
  mode: "stage" | "downstream"
  caller: { name: string; digest: string }
  expiresAt: number
}
