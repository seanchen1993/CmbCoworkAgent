import { z } from "zod"
import { botErrorDiagnosticSchema } from "./bot-error-diagnostic"
import { BOT_VIDEO_BYTES } from "./bot-files"

export const BOT_ARTIFACT_DOWNLOAD_CONCURRENCY = 2
export const BOT_ARTIFACT_DOWNLOAD_PENDING = 16
export const BOT_ARTIFACT_DOWNLOAD_RETAINED_BYTES = 2 * 1024 ** 3
export const BOT_ARTIFACT_DOWNLOAD_HISTORY = 200
export const BOT_ARTIFACT_DOWNLOAD_PAGE = 20
export const BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES = 4 * 1024 ** 2
export const BOT_ARTIFACT_DOWNLOAD_RECEIPTS = 10_000

const identifier = z.string().min(1).max(200)
export const botArtifactDownloadNonceSchema = z.uuid()
export const botArtifactDownloadSourceSchema = z
  .object({
    artifactId: identifier,
    conversationId: identifier,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(BOT_VIDEO_BYTES),
    dataEpoch: identifier
  })
  .strict()
export type BotArtifactDownloadSource = z.infer<typeof botArtifactDownloadSourceSchema>

export const botArtifactDownloadStateSchema = z.enum([
  "choosing",
  "queued",
  "downloading",
  "paused",
  "verifying",
  "publishing",
  "completed",
  "cancelled",
  "failed"
])
export const botArtifactDownloadJobSchema = z
  .object({
    id: botArtifactDownloadNonceSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    source: botArtifactDownloadSourceSchema,
    name: z.string().min(1).max(255),
    mime: z.string().max(100),
    state: botArtifactDownloadStateSchema,
    bytes: z.number().int().min(0).max(BOT_VIDEO_BYTES),
    total: z.number().int().min(0).max(BOT_VIDEO_BYTES),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    diagnostic: botErrorDiagnosticSchema.optional(),
    error: z.string().min(1).max(2000).optional()
  })
  .strict()
  .refine(
    (job) =>
      job.total === job.source.size &&
      job.bytes <= job.total &&
      (job.state !== "completed" || job.bytes === job.total),
    "Invalid artifact save progress"
  )
export type BotArtifactDownloadJob = z.infer<typeof botArtifactDownloadJobSchema>
export const botArtifactDownloadMutationSchema = z
  .object({
    id: botArtifactDownloadNonceSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export const botArtifactDownloadStartSchema = z
  .object({
    nonce: botArtifactDownloadNonceSchema,
    source: botArtifactDownloadSourceSchema
  })
  .strict()
export const botArtifactDownloadPageInputSchema = z
  .object({
    before: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(BOT_ARTIFACT_DOWNLOAD_PAGE).optional(),
    conversationId: identifier.optional()
  })
  .strict()
export const botArtifactDownloadPageSchema = z
  .object({
    items: z.array(botArtifactDownloadJobSchema).max(BOT_ARTIFACT_DOWNLOAD_PAGE),
    nextCursor: z.string().max(1024).nullable(),
    total: z
      .number()
      .int()
      .nonnegative()
      .max(BOT_ARTIFACT_DOWNLOAD_HISTORY + BOT_ARTIFACT_DOWNLOAD_PENDING)
  })
  .strict()
export type BotArtifactDownloadPage = z.infer<typeof botArtifactDownloadPageSchema>

/** Native paths belong only to Main. This API accepts immutable Host identity. */
export interface BotArtifactDownloadsAPI {
  start(input: z.infer<typeof botArtifactDownloadStartSchema>): Promise<BotArtifactDownloadJob>
  page(input: z.infer<typeof botArtifactDownloadPageInputSchema>): Promise<BotArtifactDownloadPage>
  resume(input: z.infer<typeof botArtifactDownloadMutationSchema>): Promise<BotArtifactDownloadJob>
  pause(input: z.infer<typeof botArtifactDownloadMutationSchema>): Promise<BotArtifactDownloadJob>
  cancel(input: z.infer<typeof botArtifactDownloadMutationSchema>): Promise<BotArtifactDownloadJob>
  reveal(input: z.infer<typeof botArtifactDownloadMutationSchema>): Promise<void>
  forget(input: z.infer<typeof botArtifactDownloadMutationSchema>): Promise<void>
}
