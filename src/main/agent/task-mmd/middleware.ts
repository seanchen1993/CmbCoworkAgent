import { randomUUID } from "crypto"
import { SystemMessage, ToolMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import type { ToolCallRequest } from "langchain"
import { renderTaskMmdSystemBlock } from "./prompts"
import { sanitizePlainText, sanitizePreview } from "./sanitizer"
import {
  appendTaskMmdEntry,
  getTaskMmdSettings,
  readTaskMmd
} from "./storage"
import {
  scheduleTaskMmdCompile,
  shouldCompileTaskMmd
} from "./compiler"
import type { TaskMmdScope, TaskMmdToolEntry } from "./types"

export interface TaskMmdMiddlewareOptions {
  threadId: string
  scope: TaskMmdScope
}

const seenToolCallsByThread = new Map<string, Set<string>>()
const SEEN_TOOL_CALL_LIMIT_PER_THREAD = 1000

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result
  if (ToolMessage.isInstance(result)) {
    if (typeof result.content === "string") return result.content
    if (Array.isArray(result.content)) {
      return result.content
        .map((item) => {
          if (typeof item === "string") return item
          if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
            return item.text
          }
          try {
            return JSON.stringify(item)
          } catch {
            return String(item)
          }
        })
        .join("\n")
    }
  }
  try {
    return JSON.stringify(result) ?? String(result)
  } catch {
    return String(result)
  }
}

function isToolError(result: unknown): boolean {
  return ToolMessage.isInstance(result) && result.status === "error"
}

function rememberToolCall(threadId: string, key: string): boolean {
  let seenToolCalls = seenToolCallsByThread.get(threadId)
  if (!seenToolCalls) {
    seenToolCalls = new Set<string>()
    seenToolCallsByThread.set(threadId, seenToolCalls)
  }

  if (seenToolCalls.has(key)) return false
  seenToolCalls.add(key)
  while (seenToolCalls.size > SEEN_TOOL_CALL_LIMIT_PER_THREAD) {
    const first = seenToolCalls.values().next().value
    if (!first) break
    seenToolCalls.delete(first)
  }
  return true
}

function appendTaskMapToSystemMessage(systemMessage: unknown, block: string): SystemMessage {
  if (systemMessage instanceof SystemMessage) {
    const content = systemMessage.content
    if (typeof content === "string") {
      return new SystemMessage({
        content: `${content}${block}`,
        additional_kwargs: systemMessage.additional_kwargs,
        response_metadata: systemMessage.response_metadata,
        id: systemMessage.id,
        name: systemMessage.name
      })
    }
    if (Array.isArray(content)) {
      return new SystemMessage({
        content: [...content, { type: "text", text: block }],
        additional_kwargs: systemMessage.additional_kwargs,
        response_metadata: systemMessage.response_metadata,
        id: systemMessage.id,
        name: systemMessage.name
      })
    }
  }

  if (typeof systemMessage === "string") {
    return new SystemMessage(`${systemMessage}${block}`)
  }

  const content =
    systemMessage &&
    typeof systemMessage === "object" &&
    "content" in systemMessage &&
    typeof systemMessage.content === "string"
      ? systemMessage.content
      : ""
  return new SystemMessage(`${content}${block}`)
}

function clipMmdForPrompt(mmd: string, maxChars: number): string {
  if (mmd.length <= maxChars) return mmd
  const clipped = mmd.slice(0, maxChars)
  const lineBreak = clipped.lastIndexOf("\n")
  const lineSafe = lineBreak > 20 ? clipped.slice(0, lineBreak) : clipped
  return `${lineSafe}\n%% task map truncated for prompt`
}

async function recordToolCall(
  options: TaskMmdMiddlewareOptions,
  toolCall: ToolCallRequest["toolCall"] | undefined,
  result: unknown,
  durationMs: number
): Promise<void> {
  const settings = getTaskMmdSettings()
  if (!settings.enabled || !options.threadId || !toolCall?.name) return

  const toolCallId = toolCall.id || `${toolCall.name}:${randomUUID()}`
  const dedupeKey = `${options.scope}:${toolCallId}`
  if (!rememberToolCall(options.threadId, dedupeKey)) return

  const entry: TaskMmdToolEntry = {
    id: randomUUID(),
    threadId: options.threadId,
    scope: options.scope,
    toolCallId,
    toolName: toolCall.name,
    argsPreview: sanitizePreview(toolCall.args ?? {}, settings.argsPreviewChars),
    resultPreview: sanitizePlainText(stringifyToolResult(result), settings.resultPreviewChars),
    status: isToolError(result) ? "error" : "success",
    timestamp: new Date().toISOString(),
    durationMs
  }

  await appendTaskMmdEntry(entry)
  if (shouldCompileTaskMmd(options.threadId)) {
    scheduleTaskMmdCompile(options.threadId, "threshold-or-timeout")
  }
}

export function createTaskMmdMiddleware(options: TaskMmdMiddlewareOptions) {
  return createMiddleware({
    name: `taskMmd:${options.scope}`,

    wrapToolCall: async (request, handler) => {
      const settings = getTaskMmdSettings()
      if (!settings.enabled) return handler(request)

      const startedAt = Date.now()
      try {
        const result = await handler(request)
        void recordToolCall(options, request.toolCall, result, Date.now() - startedAt).catch((error) =>
          console.warn("[TaskMMD] Failed to record tool call:", error)
        )
        return result
      } catch (error) {
        const resultText = error instanceof Error ? error.message : String(error)
        void recordToolCall(
          options,
          request.toolCall,
          new ToolMessage({
            content: `Tool execution threw before recovery: ${resultText}`,
            tool_call_id: request.toolCall?.id ?? request.toolCall?.name ?? "unknown",
            name: request.toolCall?.name,
            status: "error"
          }),
          Date.now() - startedAt
        ).catch((recordError) =>
          console.warn("[TaskMMD] Failed to record thrown tool call:", recordError)
        )
        throw error
      }
    },

    wrapModelCall: async (request, handler) => {
      const settings = getTaskMmdSettings()
      if (!settings.enabled || !options.threadId) return handler(request)

      const mmd = readTaskMmd(options.threadId).trim()
      if (!mmd) return handler(request)

      const clippedMmd = clipMmdForPrompt(mmd, settings.maxMmdChars)
      return handler({
        ...request,
        systemMessage: appendTaskMapToSystemMessage(
          request.systemMessage,
          renderTaskMmdSystemBlock(clippedMmd)
        )
      })
    }
  })
}
