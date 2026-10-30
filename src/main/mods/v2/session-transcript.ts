import { BaseMessage } from "@langchain/core/messages"
import { setImmediate as yieldImmediate } from "node:timers/promises"
import {
  isInternalNotificationMessage,
  isVisibleTranscriptMessage
} from "../../../shared/checkpoint-transcript"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type {
  FunctionSessionMessage,
  FunctionSessionToolResult,
  FunctionSessionToolUse
} from "../../../shared/mods/v2/session"

export const FUNCTION_SESSION_MESSAGE_LIMIT = 4096
const SCAN_LIMIT = 100000
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Accept actual LangChain messages and their durable constructor envelope, not UI logs. */
function source(value: unknown) {
  const outer = record(value)
  if (!outer) return undefined
  const message = record(outer.kwargs) ?? record(outer.message) ?? outer
  const type = BaseMessage.isInstance(value)
    ? value.getType()
    : (message.type ?? outer.type ?? message.role)
  const className = Array.isArray(outer.id) ? outer.id.at(-1) : undefined
  const role =
    type === "user" || type === "human" || className === "HumanMessage"
      ? "user"
      : type === "assistant" || type === "ai" || className === "AIMessage"
        ? "assistant"
        : type === "tool" || className === "ToolMessage"
          ? "tool"
          : undefined
  if (!role) return undefined
  if (
    role === "user" &&
    (outer.isMeta === true ||
      outer.isVirtual === true ||
      message.isMeta === true ||
      message.isVirtual === true ||
      isInternalNotificationMessage(value) ||
      !isVisibleTranscriptMessage(role, message.content))
  )
    return undefined
  return { outer, message, role }
}

function text(content: unknown): string {
  if (typeof content === "string") {
    if (content.length > MODS_MAX_BYTES) throw new ModFunctionError("MODS_JSON_SIZE")
    return content
  }
  if (!Array.isArray(content)) return ""
  let length = 0
  const pieces: string[] = []
  for (const raw of content) {
    const block = record(raw)
    if (block?.type !== "text" || typeof block.text !== "string") continue
    length += block.text.length
    if (length > MODS_MAX_BYTES) throw new ModFunctionError("MODS_JSON_SIZE")
    pieces.push(block.text)
  }
  return pieces.join("")
}

function project(value: unknown): FunctionSessionMessage | undefined {
  const entry = source(value)
  if (!entry) return undefined
  const { role, message, outer } = entry
  const blocks = Array.isArray(message.content) ? message.content : []
  if (role === "assistant") {
    const normalized = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    const calls = normalized
      ? (message.tool_calls as unknown[])
      : blocks.filter((block) => record(block)?.type === "tool_use")
    const toolUses: FunctionSessionToolUse[] = calls.map((raw) => {
      const call = record(raw)
      const input = call?.[normalized ? "args" : "input"]
      if (typeof call?.id !== "string" || typeof call.name !== "string" || !record(input))
        throw new ModFunctionError("MODS_SESSION_MESSAGES_INVALID")
      return { tool_use_id: call.id, tool: call.name, input: input as ModObject }
    })
    return { role: "assistant", text: text(message.content), toolUses }
  }
  const toolResults: FunctionSessionToolResult[] =
    role === "tool"
      ? [
          {
            tool_use_id: String(message.tool_call_id ?? ""),
            text: text(message.content),
            isError: message.status === "error" || message.is_error === true,
            ...(message.artifact !== undefined ? { result: message.artifact as ModJson } : {})
          }
        ]
      : blocks
          .filter((block) => record(block)?.type === "tool_result")
          .map((raw) => {
            const block = record(raw)!
            return {
              tool_use_id: String(block.tool_use_id ?? ""),
              text: text(block.content),
              isError: block.is_error === true,
              ...(outer.toolUseResult !== undefined
                ? { result: outer.toolUseResult as ModJson }
                : {})
            }
          })
  if (toolResults.some((result) => !result.tool_use_id))
    throw new ModFunctionError("MODS_SESSION_MESSAGES_INVALID")
  return {
    role: "user",
    text: role === "tool" ? "" : text(message.content),
    toolUses: [],
    ...(toolResults.length ? { toolResults } : {})
  }
}

/** Frozen Oyn/ZRe semantics: newest 4096 messages, paired results, no compaction handles. */
export function projectFunctionSessionMessages(
  messages: readonly unknown[]
): FunctionSessionMessage[] {
  function* reverse() {
    let scanned = 0,
      selected = 0
    for (let i = messages.length - 1; i >= 0 && selected < FUNCTION_SESSION_MESSAGE_LIMIT; i--) {
      if (++scanned > SCAN_LIMIT) throw new ModFunctionError("MODS_SESSION_MESSAGE_SCAN_LIMIT")
      const message = project(messages[i])
      if (message) {
        selected++
        yield message
      }
    }
  }
  return pairReverseMessages(reverse())
}

function pairReverseMessages(messages: Iterable<FunctionSessionMessage>): FunctionSessionMessage[] {
  const result: FunctionSessionMessage[] = []
  const answers = new Map<string, FunctionSessionToolResult>()
  let bytes = 2
  for (const original of messages) {
    const message = { ...original }
    for (const answer of message.toolResults ?? []) answers.set(answer.tool_use_id, answer)
    message.toolUses = message.toolUses.map((call) => {
      const answer = answers.get(call.tool_use_id)
      return answer
        ? {
            ...call,
            text: answer.text,
            ...(answer.result !== undefined ? { result: answer.result } : {}),
            ...(answer.isError ? { isError: true as const } : {})
          }
        : call
    })
    const json = encodeModJson(message)
    bytes += Buffer.byteLength(json) + (result.length ? 1 : 0)
    if (bytes > MODS_MAX_BYTES) throw new ModFunctionError("MODS_JSON_SIZE")
    result.push(JSON.parse(json) as FunctionSessionMessage)
  }
  result.reverse()
  // The guest also has a node/depth budget across the complete response.
  encodeModJson(result)
  return result
}

/** Live graph data stays on the host; large scans yield without copying raw history to a worker. */
export async function readLiveFunctionSessionTranscript(
  messages: readonly unknown[],
  method: "session.messages" | "session.turns",
  signal: AbortSignal,
  assertLive: () => void
): Promise<FunctionSessionMessage[] | number> {
  const check = () => {
    signal.throwIfAborted()
    assertLive()
  }
  check()
  if (method === "session.turns") {
    if (messages.length > SCAN_LIMIT) throw new ModFunctionError("MODS_SESSION_MESSAGE_SCAN_LIMIT")
    let turns = 0
    for (let index = 0; index < messages.length; index += 64) {
      turns += countFunctionSessionTurns(messages.slice(index, index + 64))
      if (index + 64 < messages.length) {
        await yieldImmediate()
        check()
      }
    }
    check()
    return turns
  }
  const selected: FunctionSessionMessage[] = []
  let scanned = 0,
    bytes = 2
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < FUNCTION_SESSION_MESSAGE_LIMIT;
    index--
  ) {
    if (++scanned > SCAN_LIMIT) throw new ModFunctionError("MODS_SESSION_MESSAGE_SCAN_LIMIT")
    const message = project(messages[index])
    if (message) {
      const json = encodeModJson(message)
      bytes += Buffer.byteLength(json) + (selected.length ? 1 : 0)
      if (bytes > MODS_MAX_BYTES) throw new ModFunctionError("MODS_JSON_SIZE")
      selected.push(JSON.parse(json) as FunctionSessionMessage)
    }
    if (scanned % 64 === 0) {
      await yieldImmediate()
      check()
    }
  }
  check()
  return pairReverseMessages(selected)
}

/** Chronological worker sink: retain at most 1 MiB, never return an incomplete selected tail. */
export class FunctionSessionTranscriptWindow {
  private readonly retained = new Map<number, string>()
  private selected = 0
  private bytes = 0
  private scanned = 0
  private turns = 0

  push(value: unknown): void {
    if (++this.scanned > SCAN_LIMIT) throw new ModFunctionError("MODS_SESSION_MESSAGE_SCAN_LIMIT")
    this.turns += countFunctionSessionTurns([value])
    const message = project(value)
    if (!message) return
    const index = this.selected++
    const expired = index - FUNCTION_SESSION_MESSAGE_LIMIT
    this.remove(expired)
    const json = encodeModJson(message)
    this.retained.set(index, json)
    this.bytes += Buffer.byteLength(json)
    while (this.bytes > MODS_MAX_BYTES) this.remove(this.retained.keys().next().value!)
  }

  private remove(index: number): void {
    const json = this.retained.get(index)
    if (json !== undefined) {
      this.bytes -= Buffer.byteLength(json)
      this.retained.delete(index)
    }
  }

  finish(): { messages: FunctionSessionMessage[]; turns: number } {
    if (this.retained.size !== Math.min(this.selected, FUNCTION_SESSION_MESSAGE_LIMIT))
      throw new ModFunctionError("MODS_JSON_SIZE")
    const messages = pairReverseMessages(
      [...this.retained.values()].reverse().map((json) => JSON.parse(json))
    )
    return { messages, turns: this.turns }
  }
}

/** Count prompts across the actual transcript, excluding tool replies and runtime prompts. */
export function countFunctionSessionTurns(messages: readonly unknown[]): number {
  if (messages.length > SCAN_LIMIT) throw new ModFunctionError("MODS_SESSION_MESSAGE_SCAN_LIMIT")
  let turns = 0
  for (const value of messages) {
    const entry = source(value)
    if (entry?.role !== "user") continue
    if (
      Array.isArray(entry.message.content) &&
      entry.message.content.some((block) => record(block)?.type === "tool_result")
    )
      continue
    turns++
  }
  return turns
}
