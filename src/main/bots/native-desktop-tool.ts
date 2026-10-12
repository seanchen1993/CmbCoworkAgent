import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { tool } from "@langchain/core/tools"
import { ToolMessage } from "@langchain/core/messages"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import {
  botNativeDesktopAction,
  botNativeDesktopLaunch,
  type BotNativeDesktopFrame
} from "../../shared/bot-native-desktop"
import type { BotRuntimeRequest } from "./host"
import type { NativeDesktopBroker } from "./native-desktop-broker"
import { nativeDesktopModelFrame } from "./native-desktop-message-review"

function nativeFrameMessage(
  frame: BotNativeDesktopFrame,
  toolCallId: string,
  acknowledgement?: string
) {
  return new ToolMessage({
    tool_call_id: toolCallId,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...(acknowledgement ? { deliveryReceipt: JSON.parse(acknowledgement) } : {}),
          ...nativeDesktopModelFrame(frame)
        })
      },
      { type: "image_url", image_url: { url: frame.image } }
    ]
  })
}

/** The native worker is an execution port of the existing Bot graph. Approval,
 * effect receipts, cancellation and waiting remain owned by that graph. */
export function botNativeDesktopTool(input: {
  request: BotRuntimeRequest
  computer: NativeDesktopBroker
  check(): void
  assertScope?(): void
  otherComputerHeld?(): boolean
  approve(
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    beforeStart?: () => Promise<void | string>
  ): Promise<string>
}) {
  const { request, computer, check: checkRun, approve } = input
  const check = () => {
    checkRun()
    input.assertScope?.()
  }
  const { bot, run, store, lease, signal } = request
  return tool(
    async ({ op, arguments_json }, call) => {
      checkRun()
      const raw: unknown = JSON.parse(arguments_json)
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("原生电脑参数必须是 JSON 对象")
      const mutating = [
        "launch",
        "set_value",
        "invoke",
        "scroll",
        "message_pointer",
        "message_keyboard"
      ].includes(op)
      const effectId = `native-computer:${run.id}:${call.toolCall?.id ?? randomUUID()}`
      if (mutating) {
        const prior = store.effectResult(lease, effectId)
        if (prior?.status === "succeeded") return prior.result ?? "操作已完成"
        if (prior)
          throw new BotDomainError("effect_requires_review", "应用操作结果需要核对，不能自动重复")
      }
      check()
      await computer.ensure(bot.id)
      let waited = false
      while (computer.target(bot.id).control !== "bot" || input.otherComputerHeld?.()) {
        check()
        store.steering.interruptIfPending(lease)
        store.waitForComputer(lease, true)
        waited = true
        await delay(250, undefined, { signal })
      }
      check()
      if (waited) {
        store.waitForComputer(lease, false)
        if (mutating) return "本次操作未执行：电脑控制权已归还，请重新观察当前应用再选择操作。"
      }
      const target = computer.target(bot.id)
      if (op === "windows") return JSON.stringify(await computer.windows(target, check, signal))
      if (op === "select_window") {
        const args = z.object({ viewId: z.string().uuid() }).strict().parse(raw)
        return JSON.stringify(await computer.selectWindow(target, args.viewId, check, signal))
      }
      if (op === "observe") return JSON.stringify(await computer.observe(target, check, signal))
      if (op === "screenshot") {
        const frame = await computer.frame(bot.id, undefined, undefined, signal)
        check()
        return nativeFrameMessage(frame, call.toolCall?.id ?? "")
      }
      const stillCurrent = () => {
        check()
        const current = computer.target(bot.id)
        if (
          current.generation !== target.generation ||
          current.controlEpoch !== target.controlEpoch ||
          current.viewId !== target.viewId ||
          current.control !== "bot"
        )
          throw new BotDomainError("stale_target", "原生电脑目标或控制权已变化，请重新观察")
      }
      if (op === "launch") {
        const launch = botNativeDesktopLaunch.parse(raw)
        return approve(
          effectId,
          { nativeDesktop: { target, launch } },
          async () =>
            JSON.stringify(await computer.launchApplication(target, launch, stillCurrent, signal)),
          async () => {
            stillCurrent()
            return undefined
          }
        )
      }
      if (op === "message_pointer" || op === "message_keyboard") {
        const { frameSeq, captureId, frameVersion, description, ...args } = raw as Record<
          string,
          unknown
        >
        const submitted = {
          frameSeq,
          captureId,
          frameVersion,
          description,
          action: { ...args, op }
        }
        const review = await computer.prepareMessageReview(target, submitted, stillCurrent, signal)
        try {
          let dispatched = false
          const acknowledgement = await approve(
            effectId,
            { nativeDesktop: review.context },
            async () => {
              const delivered = await computer.actMessage(
                target,
                submitted,
                stillCurrent,
                signal,
                review
              )
              dispatched = true
              return JSON.stringify(delivered)
            },
            async () => {
              stillCurrent()
              try {
                await computer.assertMessageReview(target, submitted, review, stillCurrent, signal)
              } catch (error) {
                if (error instanceof BotDomainError && error.code === "native_review_changed")
                  return "本次操作未执行：审批期间原生窗口、画面或输入目标已变化，请重新截图后选择操作。"
                throw error
              }
              return undefined
            }
          )
          if (!dispatched) return acknowledgement
          // Keep image bytes outside approval/effect storage. A failed follow-up
          // observation never changes the settled delivery or resubmits input.
          try {
            stillCurrent()
            const frame = await computer.frame(bot.id, undefined, undefined, signal)
            stillCurrent()
            return nativeFrameMessage(frame, call.toolCall?.id ?? "", acknowledgement)
          } catch {
            check()
            return JSON.stringify({
              deliveryReceipt: JSON.parse(acknowledgement),
              nextObservation: "screenshot_required",
              observationError: "screenshot_unavailable"
            })
          }
        } finally {
          computer.discardMessageReview(review)
        }
      }
      const action = botNativeDesktopAction.parse({ ...raw, op })
      const review = await computer.prepareReview(target, action, stillCurrent, signal)
      try {
        let dispatched = false
        const acknowledgement = await approve(
          effectId,
          { nativeDesktop: review.context },
          async () => {
            const result = await computer.act(target, action, stillCurrent, signal, review)
            dispatched = true
            return JSON.stringify(result)
          },
          async () => {
            stillCurrent()
            try {
              await computer.assertReview(target, action, review, stillCurrent, signal)
            } catch (error) {
              if (error instanceof BotDomainError && error.code === "native_review_changed")
                return "本次操作未执行：审批期间应用内容已变化，请重新观察和确认操作。"
              throw error
            }
            return undefined
          }
        )
        if (action.op !== "invoke" || action.action !== "select_all_text" || !dispatched)
          return acknowledgement
        // The settled semantic effect is never replayed if its new image is unavailable.
        try {
          stillCurrent()
          const frame = await computer.frame(bot.id, undefined, undefined, signal)
          stillCurrent()
          return nativeFrameMessage(frame, call.toolCall?.id ?? "", acknowledgement)
        } catch {
          check()
          return JSON.stringify({
            deliveryReceipt: JSON.parse(acknowledgement),
            nextObservation: "screenshot_required",
            observationError: "screenshot_unavailable"
          })
        }
      } finally {
        computer.discardReview(review)
      }
    },
    {
      name: "native_computer",
      description:
        "Use this Bot's private Windows application environment. Operations: launch(executable:absolute local .exe path, arguments:string[], cwd:absolute local directory), windows(), select_window(viewId from windows), observe(), screenshot(), set_value(elementId,value), invoke(elementId,action:invoke|select|toggle|expand|collapse|select_all_text), scroll(elementId,direction,amount:small|large). arguments_json is a JSON object. Launch uses existing user approval and this computer's fixed filesystem permissions; it cannot elevate or run a shell string. Select a window and observe it to obtain current element IDs before accessibility input. select is SelectionItem selection; select_all_text selects one retained TextPattern document range only when a complete non-secret Value and document text can be verified. It does not send Ctrl+A or support modifiers; text changes require fresh observation and approval. For screenshot-driven input, take screenshot() and copy its frameSeq, captureId and frameVersion into exactly one action: message_pointer(x,y,kind:move|click|double_click|wheel|drag,button:left|right,delta:-1200..1200,path?:[{x,y}],description), or message_keyboard(key OR text,description,modifiers?:Control/Shift/Alt in that order). x/y are integer pixels in the returned preview image, not source dimensions; Host maps them to the exact window geometry. Supported unmodified keys: Enter,Tab,Escape,Backspace,Space,Insert,Delete,ArrowLeft,ArrowUp,ArrowRight,ArrowDown,Home,End,PageUp,PageDown,F1-F12. Function keys use the same exact-window message transport; delivery does not prove an accelerator or application effect. Drag requires 2–32 exact preview-pixel path points, starting at x/y, with delta=0. Every point must remain inside the same window client; the original child receives the complete drag and a release is attempted even on failure. One approval binds the complete path. No non-client caption/resize input, Win/system window switching, physical keyboard state, target IME or RawInput. Only when capabilities.messageChords is true may key include A-Z/0-9 with modifiers or the listed basic keys with modifiers. These are limited HWND WM_KEY/WM_SYSKEY messages, not real keyboard input: applications checking GetKeyState/GetAsyncKeyState or hooks may ignore them. Prefer observed UIA actions, including select_all_text for the intent of Ctrl+A; never claim a shortcut worked from delivery alone. Text is completed literal Unicode WM_CHAR, maximum 4096 UTF16 units with no half-surrogates; never send credentials or other secrets. Window-message operations require one-action manual approval under existing rules. description names the actual target and intended effect, and grants no permission. Approval binds the displayed frame, exact window and current child/focus; changed targets require another screenshot. Results report message delivery only, effectVerified:false, followed by a fresh screenshot when available. Verify the returned UI before further input; if screenshot_required is returned, call screenshot() before choosing another action. Input is bound to the exact application process, window and observed control, reviewed again after approval, and invalidated after each action. Password contents are never returned; do not send credentials through set_value. This backend currently supports exposed Windows accessibility controls; full physical mouse, IME and arbitrary canvas compatibility are not verified. Use the browser tool for web pages. Never bypass human takeover or replay an unknown result.",
      schema: z.object({
        op: z.enum([
          "launch",
          "windows",
          "select_window",
          "observe",
          "screenshot",
          "set_value",
          "invoke",
          "scroll",
          "message_pointer",
          "message_keyboard"
        ]),
        arguments_json: z.string().max(64000)
      })
    }
  )
}
