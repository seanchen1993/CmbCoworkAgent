import type { EvidenceVerdict } from "./delivery-evidence-store"
import { BOT_OUTPUT_FILE_BYTES } from "./output-contract"
import { createHash, randomUUID } from "node:crypto"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import { attachmentExtension } from "../../shared/upstream/grok-attachment-open-policy"

/** Only newly authored UTF-8 text; never infer a binary/media type from a filename. */
function generatedTextMime(name: string): string {
  switch (attachmentExtension(name)) {
    case "csv":
      return "text/csv"
    case "tsv":
      return "text/tab-separated-values"
    case "json":
      return "application/json"
    case "md":
    case "markdown":
    case "mdx":
      return "text/markdown"
    default:
      return "text/plain"
  }
}

/** Root JSON schema remains an object for the existing provider adapters. */
export const botDeliverFileInput = z
  .object({
    file_id: z.string().min(1).max(160).optional(),
    name: z
      .string()
      .max(200)
      .describe("The requested filename for a genuinely new artifact; preserve its extension.")
      .optional(),
    content: z
      .string()
      .max(128000)
      .describe(
        "Complete newly authored UTF-8 file contents. For CSV or TSV, preserve the user's exact requested column names, order, language and units; do not translate or normalize them. Check the values and output format before publishing. To return an existing original, use file_id instead."
      )
      .optional()
  })
  .strict()
  .refine(
    (input) =>
      input.file_id !== undefined
        ? input.name === undefined && input.content === undefined
        : input.name !== undefined && input.content !== undefined,
    {
      message:
        "Choose exactly one mode: file_id for an existing original, or name and content for a new file."
    }
  )

/** Both modes retain the original artifact ID/byte publication and lease boundaries.
 * A generation receipt records an intent only; successful publish is the result.
 * Receipt identity also rejects a changed mode/name/content on a replayed tool call. */
export function botDeliverFileTool(
  request: BotRuntimeRequest,
  files: BotArtifacts,
  check: () => void,
  review?: (
    callId: string,
    name: string,
    bytes: Buffer,
    artifactId: string
  ) => Promise<EvidenceVerdict | undefined>
) {
  const { store, run, lease } = request
  return tool(
    async (input, call) => {
      check()
      const value = botDeliverFileInput.parse(input)
      const callId = call.toolCall?.id ?? randomUUID()
      if (value.file_id !== undefined) {
        const original = store.artifactForRun(run.id, value.file_id)
        const recheck = review && store.deliveryEvidence.hasReviewedArtifact(run.id, original.id)
        let originalBytes: Buffer | undefined
        if (store.outputContracts.requirement(lease, original.name)) {
          if (original.size > BOT_OUTPUT_FILE_BYTES)
            return JSON.stringify(
              store.outputContracts.authorize(lease, callId, original.name, original, original.id)
            )
          const { bytes } = await files.read(original.id)
          originalBytes = bytes
          check()
          store.artifactForRun(run.id, original.id)
          const validated = store.outputContracts.authorize(
            lease,
            callId,
            original.name,
            bytes,
            original.id
          )
          if (validated.status === "not_generated") return JSON.stringify(validated)
        }
        if (recheck) {
          const bytes = originalBytes ?? (await files.read(original.id)).bytes
          check()
          store.artifactForRun(run.id, original.id)
          const evidence = await review(callId, original.name, bytes, original.id)
          if (evidence && !["pass", "not_reviewed"].includes(evidence.decision))
            return JSON.stringify({
              status: "not_generated",
              reason: "原文件未通过当前要求的核验，请依据反馈修正；已完成的外部操作不会重做。",
              errors: evidence.findings
            })
        }
        return JSON.stringify(store.deliverExistingArtifact(lease, callId, value.file_id))
      }
      const name = value.name!,
        content = value.content!
      if (attachmentExtension(name) === "pptx")
        return JSON.stringify({
          status: "not_generated",
          reason:
            "UTF-8 文本不能作为 PowerPoint 原件。请使用 create_presentation 生成可编辑 .pptx；返回已有原件请使用 file_id。"
        })
      const publicationId = `result:${run.id}:${callId}`
      const bytes = Buffer.from(content, "utf8")
      const validated = store.outputContracts.authorize(lease, callId, name, bytes, publicationId)
      if (validated.status === "not_generated") return JSON.stringify(validated)
      const evidence = await review?.(callId, name, bytes, publicationId)
      if (evidence && !["pass", "not_reviewed"].includes(evidence.decision))
        return JSON.stringify({
          status: "not_generated",
          reason: "原件核验未通过，请依据以下反馈修正后重新交付；不要重复已完成的外部操作。",
          errors: evidence.findings
        })
      const publication = store.toolOnce<{
        publicationId: string
        mime?: string
      }>(
        lease,
        callId,
        {
          tool: "deliver_file",
          mode: "generate",
          name,
          contentSha256: createHash("sha256").update(content, "utf8").digest("hex")
        },
        () => ({ publicationId, mime: generatedTextMime(name) })
      )
      check()
      const result = await files.publish(
        {
          id: publicationId,
          conversationId: run.conversationId,
          runId: run.id,
          name,
          // Old intent receipts predate MIME freezing. Preserve their original
          // metadata on recovery, including already published immutable files.
          mime: publication.mime ?? (name.endsWith(".md") ? "text/markdown" : "text/plain")
        },
        bytes,
        lease,
        undefined,
        {
          kind: "delivery",
          nonce: `file-delivery:${publicationId}`,
          botId: run.botId,
          ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
          text: `已交付：${name}`
        }
      )
      return JSON.stringify(
        evidence?.decision === "not_reviewed"
          ? {
              ...result,
              verification: {
                status: "not_reviewed",
                coverage: evidence.coverage,
                reasons: evidence.findings
              }
            }
          : result
      )
    },
    {
      name: "deliver_file",
      description:
        "Deliver one file. To deliver a downloaded or existing task-visible original, provide only file_id from its successful file result/list_files: this reuses that exact immutable artifact and bytes, without rewriting BOM, encoding, line endings, formatting or data. Browser downloads are already attached and downloadable; you may simply reference their original ID in your answer. Do not copy read_file text into a new same-name file to redeliver an original. Provide name and content only to create genuinely new UTF-8 text, Markdown, JSON, CSV or code, or a transformation requested by the user; use a distinct descriptive name for a derivative. Choose exactly one mode: file_id OR name+content. This never overwrites project files or imports another conversation/branch's private files.",
      schema: botDeliverFileInput
    }
  )
}
