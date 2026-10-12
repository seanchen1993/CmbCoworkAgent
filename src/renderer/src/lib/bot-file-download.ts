import { toast } from "sonner"
import { botApi } from "@/lib/bot-api"
import { reportBotError } from "@/lib/bot-error-toast"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotDomainError, type BotArtifact } from "../../../shared/bot-types"
import {
  botArtifactDownloadSourceSchema,
  type BotArtifactDownloadSource
} from "../../../shared/bot-artifact-downloads"
import { createBotDownloadStartStore } from "./bot-artifact-download-starts"
import { createBotArtifactDownloadClient } from "./bot-artifact-download-client"
import { isDefiniteBotDownloadStartFailure } from "./bot-artifact-download-view"

/** Native saving keeps file paths and file-sized buffers in the main process. */
export const botArtifactDownloadClient = createBotArtifactDownloadClient(
  () => window.api.botArtifactDownloads,
  createBotDownloadStartStore()
)
const starting = new Map<string, Promise<void>>()
function dataEpoch() {
  const value = useBotWorkspaceStore.getState().snapshot?.dataEpoch
  if (!value) throw new Error("后台尚未连接，请连接后再保存文件。")
  return value
}
export async function downloadBotFile(
  id: string,
  known?: BotArtifact,
  showDownloads?: () => void
): Promise<void> {
  let epoch: string
  try {
    epoch = dataEpoch()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "后台尚未连接")
    return
  }
  const key = JSON.stringify([epoch, id, known?.sha256 ?? null])
  const pending = starting.get(key)
  if (pending) return pending
  if (starting.size >= 16) {
    toast.error("请先在下载列表中核对当前保存请求。")
    return
  }
  const request = (async () => {
    try {
      // File cards/preview already have this authenticated metadata. Only the
      // existing id-only caller uses one bounded first-chunk metadata read.
      const artifact = known ?? (await botApi.fileChunk({ id, offset: 0 })).artifact
      if (artifact.id !== id || dataEpoch() !== epoch)
        throw new Error("文件来源已变化，请重新选择保存。")
      const parsedSource = botArtifactDownloadSourceSchema.safeParse({
        artifactId: id,
        conversationId: artifact.conversationId,
        sha256: artifact.sha256,
        size: artifact.size,
        dataEpoch: epoch
      })
      if (!parsedSource.success) throw new Error("文件信息无效，请重新选择保存。")
      const source: BotArtifactDownloadSource = parsedSource.data
      const result = await botArtifactDownloadClient.start(source, {
        name: artifact.name,
        mime: artifact.mime
      })
      if (useBotWorkspaceStore.getState().snapshot?.dataEpoch !== epoch) return
      if (result.cleanupFailed)
        toast.error("保存任务已接收，本机请求记录尚未清理。", {
          action: showDownloads ? { label: "查看任务", onClick: showDownloads } : undefined
        })
      else if (result.job.state === "cancelled") toast.info("已取消保存")
      else if (result.job.state === "failed")
        reportBotError(
          new BotDomainError(
            result.job.diagnostic?.code ?? "download_failed",
            result.job.error ?? "保存失败，请选择新名称另存。",
            result.job.diagnostic
          ),
          "保存失败，请选择新名称另存。"
        )
      else
        toast.success(
          result.job.state === "choosing" ? "请选择文件的保存位置" : "文件已加入后台保存任务",
          {
            action: showDownloads ? { label: "查看任务", onClick: showDownloads } : undefined
          }
        )
    } catch (error) {
      if (useBotWorkspaceStore.getState().snapshot?.dataEpoch === epoch)
        reportBotError(
          error,
          isDefiniteBotDownloadStartFailure(error)
            ? "保存请求被拒绝，请调整后重试。"
            : "保存请求尚未确认，请在下载列表中核对。"
        )
    }
  })().finally(() => {
    if (starting.get(key) === request) starting.delete(key)
  })
  starting.set(key, request)
  return request
}
