import { createHash } from "node:crypto"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { tool, type DynamicStructuredTool } from "@langchain/core/tools"
import { createMiddleware } from "langchain"
import { z } from "zod"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { MAIN_TURN_ONLY_TOOL_METADATA_KEY } from "./runtime-tool-catalog"
import { parseGeneratedImageReceipt } from "../../shared/generated-image"

export interface ImageGenerationTurn {
  threadId: string
  userMessageId: string
  assertCurrent: () => void
  signal: AbortSignal
  forkable?: boolean
  /** On a checkpoint continuation only a previously produced group image may be delivered. */
  resumeMessageId?: string
  group?: { instanceKey: string; messageId: string }
}

/** Use only the current author's direct instruction, before host-appended attachment data. */
export function imageGenerationIntent(text: string) {
  // Transport suffixes hold files, selected source text and the local SKILL.md path.
  // Drop the entire suffix, including malformed markup, before considering either entry point.
  const direct = text.split(/<\/?(?:attachment\b|CMBDEVCLAW[-:])|(?:^|\n)# userselect:|<builtin-browser-instructions>/i, 1)[0].trim()
  const explicit = /^\/生成图片(?:\s+|[：:]\s*)([\s\S]+)$/.exec(direct)
  if (explicit) return { prompt: explicit[1].trim(), explicit: true }
  // Keep questions about drawing, source code, quotations and negations on the normal chat path.
  const request = direct.replace(/^(?:你?(?:可以|能不能|能否)|(?:can|could) you\s+)/i, "")
    .replace(/(?:[吗么][？?]?|\?)$/, "").trim()
  if (!request || /[?？]|是什么|是什么意思|怎么(?:办|做|实现)|(?:的|有)(?:方法|步骤|接口)|^(?:如何|怎么|为什么|解释|分析|不要|别|how\b|why\b)/i.test(request)) return
  const subject = request.replace(/^(?:(?:请|麻烦|帮我|给我|为我|你|再)\s*)+/, "")
  const draw = /^(?:画|绘制|绘画)(?:一?[张幅个只艘头棵朵条匹座轮辆片]|出)/.test(subject) ||
    (subject !== request && /^(?:画|绘制)(?!面|家|风|法|质|图工具|图接口).+/.test(subject))
  const asked = draw ||
    /^(?:生成|制作|设计|绘制|画)(?:一[张幅个份])?[^\n。！？]{0,90}(?:图片|插画|海报|图像|壁纸|封面|头像|照片|配图|示意图|图标|漫画)/.test(subject) ||
    /^(?:please\s+)?(?:(?:generate|make|create|design)\s+(?:me\s+)?(?:an?\s+)?(?:\w+[ -]){0,4}(?:image|picture|poster|painting|illustration|photo|logo)\b|(?:draw|paint)\s+(?:me\s+)?(?:an?|the)\s+)/i.test(request)
  return asked ? { prompt: direct, explicit: false } : undefined
}

type Intent = NonNullable<ReturnType<typeof imageGenerationIntent>>
const imageTurns = new WeakMap<object, { turn: ImageGenerationTurn; intent: Intent }>()

export function createImageGenerationTool(turn: ImageGenerationTurn, intent: Intent) {
  const result = tool(async (_input, config) => {
    if (getHookAgentIdFromRequest(config) || !config.toolCall?.id)
      throw new Error("生成图片需要当前用户回合")
    turn.assertCurrent()
    try {
      const { runGeneratedImage, resumeGeneratedGroupImage } = await import("../generated-images")
      // Send only the authorized prompt, never a model's rewrite containing other chat data.
      const ctx = { ...turn, callId: config.toolCall.id }
      const receipt = turn.resumeMessageId
        ? await resumeGeneratedGroupImage(ctx) : await runGeneratedImage(ctx, intent.prompt)
      return JSON.stringify(receipt)
    } catch (error) {
      turn.signal.throwIfAborted()
      return new ToolMessage({ name: "generate_image", status: "error",
        tool_call_id: config.toolCall.id,
        content: error instanceof Error ? error.message : "生成图片失败" })
    }
  }, {
    name: "generate_image",
    description: "Generate the single image requested by the current user. The host uses the original instruction. In a group, deliver its actionId with bot_deliver_files.",
    schema: z.object({ prompt: z.string().trim().min(1).max(12000) }).strict(),
    metadata: { [MAIN_TURN_ONLY_TOOL_METADATA_KEY]: true }
  })
  imageTurns.set(result, { turn, intent })
  return result
}

/** The composer command drives the same tool and transcript without relying on model tool selection. */
export function explicitImageCommandMiddleware(tools?: DynamicStructuredTool[]) {
  const entry = tools?.find(candidate => imageTurns.has(candidate))
  if (!entry) return []
  const { turn, intent } = imageTurns.get(entry)!
  const boundaryId = turn.resumeMessageId ?? turn.userMessageId
  const suffix = createHash("sha256").update(boundaryId).digest("hex").slice(0, 24)
  const generateId = `gen_${suffix}`, deliveryId = `deliver_${suffix}`
  return [createMiddleware({
    name: "explicitImageCommand",
    wrapToolCall: (request, handler) => {
      if (request.toolCall.name === "generate_image" &&
          request.state.messages.findLast(m => HumanMessage.isInstance(m))?.id !== boundaryId)
        return new ToolMessage({ content: "当前用户回合未授权生成图片", status: "error",
          name: "generate_image", tool_call_id: request.toolCall.id ?? "" })
      return handler(request)
    },
    wrapModelCall: async (request, handler) => {
      const lastUser = request.messages.findLastIndex(m => HumanMessage.isInstance(m))
      if (lastUser < 0 || request.messages[lastUser].id !== boundaryId)
        return handler({ ...request, tools: request.tools.filter(t => t.name !== "generate_image") })
      turn.assertCurrent()
      const tail = request.messages.slice(lastUser + 1)
      const callIds = new Set(tail.flatMap(m => AIMessage.isInstance(m)
        ? (m.tool_calls ?? []).filter(call => call.name === "generate_image").map(call => call.id) : []))
      const result = tail.find(m => ToolMessage.isInstance(m) && callIds.has(m.tool_call_id))
      const done = (content: string) => new AIMessage({ content, response_metadata: { finish_reason: "stop" } })
      if (!result) {
        if (intent.explicit || turn.resumeMessageId) return new AIMessage({ content: "", tool_calls: [
          { id: generateId, name: "generate_image", args: { prompt: intent.prompt } }
        ] })
        const response = await handler(request)
        if (!AIMessage.isInstance(response)) return response
        const calls = response.tool_calls ?? []
        const first = calls.find(call => call.name === "generate_image")
        if (!first || calls.every(call => call.name !== "generate_image" || call === first)) return response
        return new AIMessage({ ...response, tool_calls: calls.filter(call => call.name !== "generate_image" || call === first) })
      }
      const receipt = ToolMessage.isInstance(result) && result.status !== "error"
        ? parseGeneratedImageReceipt(result.content) : undefined
      if (!receipt && !turn.group) return done(String(result.content))
      if (receipt && !turn.group && !intent.explicit) {
        const response = await handler({ ...request, tools: request.tools.filter(t => t.name !== "generate_image") })
        if (AIMessage.isInstance(response) && response.tool_calls?.some(call => call.name === "generate_image")) {
          const remaining = response.tool_calls.filter(call => call.name !== "generate_image")
          return remaining.length ? new AIMessage({ ...response, tool_calls: remaining }) : done("图片已生成。")
        }
        return response
      }
      if (turn.group) {
        const delivered = tail.find(m => ToolMessage.isInstance(m) && m.tool_call_id === deliveryId)
        if (!delivered && receipt) {
          return new AIMessage({ content: "", tool_calls: [{ id: deliveryId, name: "bot_deliver_files",
            args: { files: [receipt.actionId], content: "" } }] })
        }
        if (!receipt || (delivered && ToolMessage.isInstance(delivered) && delivered.status === "error")) {
          const text = receipt ? "图片已生成，群交付失败。" : String(result.content)
          const noticeId = `notice_${suffix}`
          if (tail.some(m => ToolMessage.isInstance(m) && m.tool_call_id === noticeId))
            return done(text)
          return new AIMessage({ content: "", tool_calls: [
            { id: noticeId, name: "bot_send_message", args: { content: text } }
          ] })
        }
      }
      return done("图片已生成。")
    }
  })]
}
