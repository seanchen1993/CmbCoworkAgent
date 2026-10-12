import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { LocalBotComputerProvider } from "./computer-provider"
import { prepareApprovedBotComputer } from "./computer-wait"

type Approve = (
  id: string,
  action: unknown,
  operation: () => Promise<string>,
  beforeStart?: () => Promise<void | string>
) => Promise<string>

/** Shares the browser's real-target review and download router. A file receipt
 * is checked before touching the browser, including after the source tab closed. */
export function botDownloadTool(
  request: BotRuntimeRequest,
  computer: LocalBotComputerProvider,
  files: BotArtifacts,
  check: () => void,
  approve: Approve
) {
  const { run, bot, store, lease, signal } = request
  return tool(
    async ({ url, ref, name, element }, call) => {
      check()
      if ((url === undefined) === (ref === undefined))
        throw new Error("请指定文件网址或页面导出按钮，两者选一")
      const callId = call.toolCall?.id
      if (!callId) throw new BotDomainError("download_identity", "下载缺少稳定调用标识")
      const id = `download:${run.id}:${callId}`
      const previous = store.effectResult(lease, id)
      if (previous?.status === "succeeded") return previous.result ?? "文件已下载"
      if (previous)
        throw new BotDomainError("effect_requires_review", "下载结果需核对，不能自动重复")
      const broker = await computer.get()
      const taskRunId =
        store.workflowChildren.metadata(run.id)?.input.browserAccess === "page" ? run.id : undefined
      const target = await broker.ensure(bot.id, taskRunId)
      const action =
        url === undefined
          ? { op: "click", ref, ...(element === undefined ? {} : { element }) }
          : { op: "navigate", url }
      const review = await broker.prepareReview(target, action, check)
      try {
        return await approve(
          id,
          {
            download: {
              ...(url === undefined ? { ref } : { url }),
              ...(name === undefined ? {} : { name }),
              ...(element === undefined ? {} : { element })
            },
            botId: bot.id,
            target,
            browserReview: review.context
          },
          async () => {
            const downloaded =
              url === undefined
                ? await broker.downloadFromPage(target, ref!, check, signal, review, element)
                : await broker.download(target, url, check, signal, review)
            check()
            const artifact = await files.publish(
              {
                id,
                conversationId: run.conversationId,
                runId: run.id,
                name: name ?? downloaded.suggestedName,
                mime: "application/octet-stream",
                origin: "browser"
              },
              downloaded.bytes,
              lease
            )
            return JSON.stringify(artifact)
          },
          async () => {
            const notPerformed = await prepareApprovedBotComputer(request, computer, target)
            if (notPerformed) return notPerformed
            try {
              await broker.assertReview(target, action, review, check)
            } catch (error) {
              if (error instanceof BotDomainError && error.code === "browser_review_changed")
                return "This download was NOT performed: the page or export control changed during review. Take a fresh browser snapshot before choosing another action."
              throw error
            }
            return undefined
          }
        )
      } finally {
        await review.dispose()
      }
    },
    {
      name: "download_file",
      description:
        "Download one file using this user's Bot browser login. Specify exactly one: url for a direct HTTP/HTTPS file link (separate temporary page), or ref from a fresh browser snapshot to click the current page's download/export control (including forms, POST exports and generated blob files). For ref provide element: the target and intended export, not a claim of authorization. The Host reviews and binds the actual page/control; changed targets require a fresh snapshot. This tool waits for one expected file; ordinary browser clicks also collect downloads they initiate. Uses configured operation review, with human approval when needed; maximum 25 MiB and 30 seconds. Publishes an immutable file in this conversation; read its ID with read_file. Never retry an uncertain export automatically.",
      schema: z.object({
        url: z.string().url().max(8192).optional(),
        ref: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(200).optional(),
        element: z.string().trim().min(1).max(2000).optional()
      })
    }
  )
}
