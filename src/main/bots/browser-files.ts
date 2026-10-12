import { randomUUID } from "node:crypto"
import type { BotArtifact, BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import type { BotArtifacts } from "./artifacts"
import type { BotBrowserDownloadReceiver } from "./browser-downloads"
import { validateBotFileName } from "./artifact-validation"

/** Bind once at dispatch/download start, never look up a newly selected conversation on completion. */
export function botBrowserFileReceiver(input: {
  botId: string
  taskRunId?: string
  conversationId: string
  threadRootId?: string
  store: BotStore
  files: BotArtifacts
  lease?: BotRunLease
  check?: () => void
  results?: BotArtifact[]
  errors?: string[]
}): BotBrowserDownloadReceiver {
  const { botId, conversationId, store, files, lease } = input
  const runId = lease?.runId ?? input.taskRunId ?? null
  const threadRootId = lease ? store.assertLease(lease).threadRootId : input.threadRootId
  if (input.threadRootId !== undefined && input.threadRootId !== threadRootId)
    throw new Error("下载不属于当前分支")
  const address = { botId, conversationId, runId, threadRootId: threadRootId ?? null }
  const check = () => {
    input.check?.()
    if (input.taskRunId) {
      store.taskBrowsers.assertOwner(botId, input.taskRunId, true)
      store.assertRunAddress({ conversationId, runId: input.taskRunId, threadRootId })
    }
    store.getBot(botId)
    if (!store.getConversation(conversationId).members.includes(botId))
      throw new Error("Bot 已离开该对话")
    if (threadRootId !== undefined) store.threads.root(conversationId, threadRootId)
    if (lease) {
      const run = store.assertLease(lease)
      if (run.botId !== botId || run.conversationId !== conversationId)
        throw new Error("下载不属于当前任务")
    }
  }
  check()
  return {
    owner: botId,
    check,
    started: (guid) => {
      check()
      store.browserDownloads.started(guid, address)
    },
    complete: async ({ guid, bytes, suggestedName }, assertActive) => {
      const current = () => {
        assertActive()
        check()
      }
      current()
      let name: string
      try {
        name = validateBotFileName(suggestedName)
      } catch {
        name = `download-${guid}.bin`
      }
      const artifact = await files.publish(
        {
          id: `browser-download:${guid}`,
          conversationId,
          runId,
          name,
          mime: "application/octet-stream",
          origin: "browser"
        },
        bytes,
        lease,
        current,
        {
          nonce: `browser-download-notice:${guid}`,
          botId,
          ...(threadRootId ? { threadRootId } : {}),
          text: `已下载：${name}`
        }
      )
      store.browserDownloads.settled(guid, address)
      input.results?.push(artifact)
    },
    failed: (message, guid) => {
      // Page URLs, response headers, local paths and browser error stacks never enter chat.
      const reason =
        /^(下载文件超过 25 MiB 上限|文件下载超过 30 秒，请稍后重试|文件下载已取消|下载期间控制权已变化|同时下载的文件过多，请等待当前下载完成|浏览器已关闭，下载未完成|下载操作已结束)$/.test(
          message
        )
          ? message
          : "文件未能保存，请检查页面后重试"
      if (guid) store.browserDownloads.settled(guid, address, reason)
      else
        store.browserDownloadNotice({
          nonce: `browser-download-failure:${randomUUID()}`,
          botId,
          conversationId,
          runId,
          ...(threadRootId ? { threadRootId } : {}),
          text: `下载未完成：${reason}`
        })
      input.errors?.push(reason)
    }
  }
}
