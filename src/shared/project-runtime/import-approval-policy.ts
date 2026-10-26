import type { HostLegacyImportReceipt } from "./host-types"
import type { ProjectRuntimeManifest } from "./types"

/** Imported history never supplies a current approval. The manifest itself remains unchanged. */
export function effectiveHostResultApproval(
  stage: ProjectRuntimeManifest["stages"][number] | undefined,
  receipt?: HostLegacyImportReceipt
): boolean {
  return Boolean(
    stage &&
    (stage.resultApproval === "human" ||
      (receipt?.review.protocol === "devclaw.host-legacy-import/v2" &&
        receipt.review.prefixStageIds.includes(stage.id)))
  )
}

export function hostImportApprovalBinding(stageId: string, receipt?: HostLegacyImportReceipt) {
  return receipt?.review.protocol === "devclaw.host-legacy-import/v2" &&
    receipt.review.prefixStageIds.includes(stageId)
    ? { importReviewDigest: receipt.review.reviewDigest, resultApproval: "human" as const }
    : undefined
}
