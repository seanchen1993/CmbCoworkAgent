import { BotDomainError } from "../../../shared/bot-types"
import {
  botArtifactDownloadJobSchema,
  botArtifactDownloadPageSchema,
  type BotArtifactDownloadJob,
  type BotArtifactDownloadPage,
  type BotArtifactDownloadSource
} from "../../../shared/bot-artifact-downloads"

export type BotDownloadAction = "pause" | "resume" | "cancel" | "reveal" | "forget"
const labels: Record<BotArtifactDownloadJob["state"], string> = {
  choosing: "选择保存位置",
  queued: "等待保存",
  downloading: "正在保存",
  paused: "已暂停",
  verifying: "校验文件",
  publishing: "正在完成保存",
  completed: "已保存",
  cancelled: "已取消",
  failed: "保存失败"
}
export function botDownloadStateLabel(job: BotArtifactDownloadJob): string {
  return labels[job.state]
}
export function botDownloadPercent(job: BotArtifactDownloadJob): number {
  return job.total ? Math.floor((job.bytes * 100) / job.total) : job.state === "completed" ? 100 : 0
}
export function botDownloadActions(job: BotArtifactDownloadJob): BotDownloadAction[] {
  switch (job.state) {
    case "choosing":
      return ["cancel"]
    case "queued":
    case "downloading":
      return ["pause", "cancel"]
    case "paused":
      return ["resume", "cancel"]
    case "verifying":
      return ["cancel"]
    case "publishing":
      return []
    case "completed":
      return ["reveal", "forget"]
    case "cancelled":
    case "failed":
      return ["forget"]
  }
}
export function botDownloadsAreActive(page: BotArtifactDownloadPage): boolean {
  return page.items.some((job) =>
    ["choosing", "queued", "downloading", "verifying", "publishing"].includes(job.state)
  )
}
export function sameBotDownloadSource(
  a: BotArtifactDownloadSource,
  b: BotArtifactDownloadSource
): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.conversationId === b.conversationId &&
    a.sha256 === b.sha256 &&
    a.size === b.size &&
    a.dataEpoch === b.dataEpoch
  )
}
const invalidPacket = () =>
  new BotDomainError("invalid_download_receipt", "保存任务回执无效，请刷新后核对。")
export function verifyBotDownloadJob(
  value: unknown,
  expected?: {
    id: string
    source: BotArtifactDownloadSource
    revision?: number
  }
): BotArtifactDownloadJob {
  const parsed = botArtifactDownloadJobSchema.safeParse(value)
  if (!parsed.success) throw invalidPacket()
  const job = parsed.data
  if (job.state === "completed" && job.bytes !== job.total) throw invalidPacket()
  if (
    expected &&
    (job.id !== expected.id ||
      !sameBotDownloadSource(job.source, expected.source) ||
      (expected.revision !== undefined && job.revision < expected.revision))
  )
    throw invalidPacket()
  return job
}
export function verifyBotDownloadPage(
  value: unknown,
  conversationId?: string
): BotArtifactDownloadPage {
  const parsed = botArtifactDownloadPageSchema.safeParse(value)
  if (!parsed.success) throw invalidPacket()
  const page = parsed.data
  if (
    new Set(page.items.map((job) => job.id)).size !== page.items.length ||
    page.total < page.items.length ||
    page.items.some(
      (job) =>
        (conversationId && job.source.conversationId !== conversationId) ||
        (job.state === "completed" && job.bytes !== job.total)
    )
  )
    throw invalidPacket()
  return page
}
/** Polling may overlap a user action; an old page cannot undo an accepted ACK.
 * Membership/cursor remain the server page's, and only <=20 rows are retained. */
export function projectBotDownloadPage(
  current: BotArtifactDownloadPage | null,
  incoming: BotArtifactDownloadPage
): BotArtifactDownloadPage {
  if (!current) return incoming
  const prior = new Map(current.items.map((job) => [job.id, job]))
  return {
    ...incoming,
    items: incoming.items.map((job) => {
      const previous = prior.get(job.id)
      if (previous && !sameBotDownloadSource(previous.source, job.source)) throw invalidPacket()
      return previous && previous.revision > job.revision ? previous : job
    })
  }
}
export function isBotDownloadRevisionConflict(error: unknown): boolean {
  return error instanceof BotDomainError && error.code === "download_revision_conflict"
}
export function isDefiniteBotDownloadStartFailure(error: unknown): boolean {
  return (
    error instanceof BotDomainError &&
    [
      "download_request_rejected",
      "download_capacity",
      "download_nonce_conflict",
      "download_archived"
    ].includes(error.code)
  )
}
