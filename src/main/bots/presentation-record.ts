import { createHash } from "node:crypto"
import { z } from "zod"
import type { BotStore } from "./store"
import type { BotArtifact } from "../../shared/bot-types"
import { botPresentationLayout } from "./presentation-contract"

export const presentationHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const presentationManifest = z
  .object({
    version: z.literal(1),
    artifactId: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    layout: botPresentationLayout
  })
  .strict()
export const presentationManifestCall = (id: string) =>
  `presentation-manifest:${presentationHash(id)}`
/** Indexed receipt lookup: no scan of artifacts or full conversation history. */
export function readPresentationManifest(store: BotStore, artifact: BotArtifact) {
  if (!artifact.runId) return null
  const row = store.db.exec("SELECT response FROM bot_receipts WHERE nonce=?", [
    `tool:${artifact.runId}:${presentationManifestCall(artifact.id)}`
  ])[0]?.values[0]?.[0]
  if (row === undefined) return null
  if (typeof row !== "string" || row.length > 1_000_000) throw new Error("演示文稿布局记录无效")
  const result = presentationManifest.parse(JSON.parse(row))
  if (
    result.artifactId !== artifact.id ||
    result.artifactSha256 !== artifact.sha256 ||
    result.conversationId !== artifact.conversationId ||
    result.runId !== artifact.runId
  )
    throw new Error("演示文稿预览身份与原文件不一致，请保存原件查看")
  return result
}
