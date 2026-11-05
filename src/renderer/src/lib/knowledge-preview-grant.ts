import type { HarnessKnowledgePreviewResult } from "@/types"

export function createKnowledgePreviewGrantResolver(
  preview: HarnessKnowledgePreviewResult,
  refresh: (adapterId: string) => Promise<HarnessKnowledgePreviewResult>
): () => Promise<string> {
  let current = preview
  let pending: Promise<string> | undefined
  return async () => {
    if (current.previewGrant && (current.previewGrantExpiresAt ?? 0) > Date.now() + 5_000) {
      return current.previewGrant
    }
    pending ??= refresh(preview.adapterId)
      .then((next) => {
        if (!next.exists || next.path !== preview.path || !next.previewGrant) {
          throw new Error(next.error || "系统约束目录已变化，请刷新预览")
        }
        current = next
        return next.previewGrant
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}
