import type { HarnessKnowledgePreviewResult } from "../../shared/harness-board-types"
import {
  EXTERNAL_FILE_READ_GRANT_TTL_MS,
  issueExternalFileReadGrant
} from "../services/external-file-read-tokens"

/** Only accepts the main-owned worker's bounded, plugin-contained knowledge listing. */
export function authorizeKnowledgePreview(
  preview: HarnessKnowledgePreviewResult,
  senderId: number
): HarnessKnowledgePreviewResult {
  if (!preview.exists || !preview.path) return preview
  const paths = preview.files.filter((file) => !file.is_dir).map((file) => file.path)
  if (!paths.length) return preview
  const issued = issueExternalFileReadGrant(
    preview.path,
    senderId,
    paths,
    `harness-knowledge:${preview.adapterId}`,
    "market-knowledge"
  )
  if ("error" in issued) {
    return { ...preview, error: [preview.error, issued.error].filter(Boolean).join("；") }
  }
  return {
    ...preview,
    previewGrant: issued.grant,
    previewGrantExpiresAt: Date.now() + EXTERNAL_FILE_READ_GRANT_TTL_MS
  }
}
