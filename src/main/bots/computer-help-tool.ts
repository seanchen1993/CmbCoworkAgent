import { randomUUID } from "node:crypto"
import { tool } from "@langchain/core/tools"
import { ToolMessage } from "@langchain/core/messages"
import {
  botComputerHelpRequest,
  writeBotComputerHelp,
  readBotComputerHelp
} from "../../shared/bot-computer-help"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { LocalBotComputerProvider } from "./computer-provider"
import type { NativeDesktopBroker } from "./native-desktop-broker"
import { nativeDesktopModelFrame } from "./native-desktop-message-review"

/** Grok request_box_help's manual-step handoff, using the existing Cmb question
 * and graph wait. No background agent, endTurn shortcut or separate help queue. */
export function botComputerHelpTool(input: {
  request: BotRuntimeRequest
  browser: LocalBotComputerProvider
  native?: NativeDesktopBroker
  taskRunId?: string
  child: boolean
  nativeChild?: boolean
  assertNativeScope?(): void
  check(): void
  wait(interactionId: string): Promise<string>
}) {
  const { request, browser, native, taskRunId, child, check, wait } = input
  const { store, lease, bot, run, signal } = request
  return tool(
    async (args, call) => {
      check()
      if (child && (args.backend === "windows-native" ? !input.nativeChild : !taskRunId))
        throw new BotDomainError("tool_not_allowed", "此子任务未获对应电脑权限")
      if (args.backend === "windows-native") input.assertNativeScope?.()
      if (args.backend === "windows-native" && !native)
        throw new BotDomainError("computer_unavailable", "当前后台不支持原生工作应用")
      const key = `computer-help:${call.toolCall?.id ?? randomUUID()}`
      let target
      if (!store.hasToolResult(lease, key)) {
        if (args.backend === "windows-native") {
          await native!.ensure(bot.id)
          target = native!.target(bot.id)
        } else target = await (await browser.get()).ensure(bot.id, taskRunId)
        check()
      }
      const interaction = store.toolOnce(
        lease,
        key,
        { ...args, dataEpoch: store.dataEpoch() },
        () => {
          if (!target) throw new Error("电脑帮助缺少实际操作目标")
          return store.requestInteraction(lease, {
            kind: "question",
            prompt: writeBotComputerHelp({
              ...args,
              version: 1,
              hostId: lease.owner,
              dataEpoch: store.dataEpoch(),
              botId: bot.id,
              runId: run.id,
              runFence: lease.fence,
              conversationId: run.conversationId,
              ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
              ...(taskRunId ? { taskRunId } : {}),
              generation: target.generation,
              controlEpoch: target.controlEpoch
            })
          })
        }
      )
      const answer = await wait(interaction.id)
      check()
      if (answer !== "done")
        return "用户取消了本次人工电脑帮助，未确认登录或其他步骤已完成。请说明受阻原因，不要重复请求或假定已完成。"
      const card = readBotComputerHelp(interaction.prompt)!
      if (card.backend === "windows-native") {
        input.assertNativeScope?.()
        const current = native!.target(bot.id)
        if (current.generation !== card.generation || current.control !== "bot")
          return "人工归还已确认，但电脑已变化或再次被接管。请先等待控制权并重新观察，不要重放之前的输入。"
        try {
          const frame = await native!.frame(bot.id, undefined, undefined, signal)
          check()
          return new ToolMessage({
            tool_call_id: call.toolCall?.id ?? "",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  humanHelp: "returned",
                  ...nativeDesktopModelFrame(frame)
                })
              },
              { type: "image_url", image_url: { url: frame.image } }
            ]
          })
        } catch (error) {
          signal.throwIfAborted()
          check()
          return JSON.stringify({
            humanHelp: "returned",
            screenshotRequired: true,
            message: "人工归还已确认，新画面暂不可用；先重新截图，不能重放输入。",
            detail: error instanceof Error ? error.message : "画面不可用"
          })
        }
      }
      const broker = await browser.get()
      const current = broker.target(bot.id, taskRunId)
      if (current.generation !== card.generation || current.control !== "bot")
        return "人工归还已确认，但浏览器已变化或再次被接管。请先等待控制权并重新观察，不要重放之前的输入。"
      try {
        const result = await broker.act(current, { op: "screenshot" }, check)
        check()
        return new ToolMessage({
          tool_call_id: call.toolCall?.id ?? "",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                humanHelp: "returned",
                screenshot: result.summary
              })
            },
            ...(result.image ? [{ type: "image_url", image_url: { url: result.image } }] : [])
          ]
        })
      } catch (error) {
        signal.throwIfAborted()
        check()
        return JSON.stringify({
          humanHelp: "returned",
          screenshotRequired: true,
          message: "人工归还已确认，新画面暂不可用；先重新截图，不能重放输入。",
          detail: error instanceof Error ? error.message : "画面不可用"
        })
      }
    },
    {
      name: "request_computer_help",
      description:
        "Ask the user to perform an unavoidable manual step in this Bot's browser or native work application: login, SSO, MFA/passkey, captcha or payment. Give one short instruction without asking for passwords or OTP in chat. This pauses the owning run and shows the exact computer; the user takes control and returns it with one button, then the tool returns a fresh screenshot. Closing the viewer keeps the request waiting. Do not use for computer repair, to obtain new application permissions, or repeat an already pending request. Only an explicitly authorized computer task can use the shared native desktop; ordinary and browser children cannot gain application access.",
      schema: botComputerHelpRequest
    }
  )
}
