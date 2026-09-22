import { ToolMessage } from "@langchain/core/messages"
import { Command, isCommand } from "@langchain/langgraph"
import type { ModJson, ModProjection } from "../../shared/mods/types"
import { ModError } from "./errors"

const MASK = "[REDACTED]"
const sensitiveKey =
  /^(?:authorization|password|secret|access_token|refresh_token|api[-_]?key|accountNumber)$/i
const tokenPattern = /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi

export function filterModText(text: string): string {
  if (text.length > 1024 * 1024) throw new ModError("MODS_OUTPUT_LIMIT")
  return text.replace(tokenPattern, MASK).replace(bearerPattern, `Bearer ${MASK}`)
}

/** Copies JSON-compatible payloads. Never mutates a raw result in place. */
export function filterModData(value: unknown, protectedOutput: boolean): ModJson {
  let remaining = 1024 * 1024
  let nodes = 0
  const seen = new Set<object>()
  function visit(input: unknown, depth: number): ModJson {
    if (++nodes > 30_000 || depth > 32) throw new ModError("MODS_OUTPUT_LIMIT")
    if (input == null) return null
    if (typeof input === "boolean") return input
    if (typeof input === "number") return Number.isFinite(input) ? input : null
    if (typeof input === "string") {
      remaining -= input.length * 2
      if (remaining < 0) throw new ModError("MODS_OUTPUT_LIMIT")
      return protectedOutput ? filterModText(input) : input
    }
    if (typeof input !== "object") throw new ModError("MODS_OUTPUT_TYPE")
    if (seen.has(input)) throw new ModError("MODS_OUTPUT_CYCLE")
    seen.add(input)
    try {
      if (Array.isArray(input)) return input.map((v) => visit(v, depth + 1))
      if (protectedOutput && (ArrayBuffer.isView(input) || input instanceof ArrayBuffer)) {
        return "[Binary output suppressed]"
      }
      if (protectedOutput) {
        const type = Object.getOwnPropertyDescriptor(input, "type")?.value
        if (["image", "image_url", "audio", "file", "resource"].includes(type)) {
          return { type: "text", text: "[Non-text output suppressed by project policy]" }
        }
        if (Object.getOwnPropertyDescriptor(input, "truncated")?.value === true) {
          return {
            ...(visit(
              { exitCode: Object.getOwnPropertyDescriptor(input, "exitCode")?.value ?? null },
              depth + 1
            ) as object),
            output: "[Incomplete output suppressed by project policy]",
            truncated: true
          } as ModJson
        }
      }
      const out: Record<string, ModJson> = {}
      for (const key of Object.keys(input)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) continue
        const property = Object.getOwnPropertyDescriptor(input, key)
        if (!property || !("value" in property)) throw new ModError("MODS_OUTPUT_ACCESSOR")
        if (property.value === undefined) continue
        if (protectedOutput && (sensitiveKey.test(key) || key === "base64" || key === "dataUrl")) {
          out[key] = MASK
        } else out[key] = visit(property.value, depth + 1)
      }
      return out
    } finally {
      seen.delete(input)
    }
  }
  return visit(value, 0)
}

export function filterModResult<T>(value: T, protectedOutput: boolean, toolCallId?: string): T {
  if (!protectedOutput) return value
  if (ToolMessage.isInstance(value)) {
    return new ToolMessage({
      content: filterModData(value.content, true) as ToolMessage["content"],
      tool_call_id: value.tool_call_id,
      id: value.id,
      name: value.name,
      status: value.status,
      artifact: filterModData(value.artifact, true),
      metadata: filterModData(value.metadata ?? {}, true) as Record<string, unknown>,
      additional_kwargs: filterModData(value.additional_kwargs ?? {}, true) as Record<
        string,
        unknown
      >,
      response_metadata: filterModData(value.response_metadata ?? {}, true) as Record<
        string,
        unknown
      >
    }) as T
  }
  if (isCommand(value)) {
    const command = value as Command
    const update = command.update as Record<string, unknown> | undefined
    if (!update || !Array.isArray(update.messages)) return value
    return new Command({
      update: {
        ...update,
        messages: update.messages.map((message) =>
          ToolMessage.isInstance(message) && (!toolCallId || message.tool_call_id === toolCallId)
            ? filterModResult(message, true, toolCallId)
            : message
        )
      },
      ...(command.graph !== undefined ? { graph: command.graph } : {}),
      ...(command.goto !== undefined ? { goto: command.goto } : {}),
      ...(command.resume !== undefined ? { resume: command.resume } : {})
    }) as T
  }
  return filterModData(value, true) as T
}

/** A single policy payload contains every observable field, while host routing stays private. */
export async function mapModResult<T>(
  value: T,
  filter: (data: unknown) => Promise<ModJson>,
  toolCallId?: string
): Promise<T> {
  if (ToolMessage.isInstance(value)) {
    const data = (await filter({
      content: value.content,
      artifact: value.artifact ?? null,
      metadata: value.metadata ?? {},
      additional_kwargs: value.additional_kwargs ?? {},
      response_metadata: value.response_metadata ?? {}
    })) as Record<string, unknown>
    return new ToolMessage({
      content: data.content as ToolMessage["content"],
      artifact: data.artifact,
      metadata: data.metadata as Record<string, unknown>,
      additional_kwargs: data.additional_kwargs as Record<string, unknown>,
      response_metadata: data.response_metadata as Record<string, unknown>,
      tool_call_id: value.tool_call_id,
      id: value.id,
      name: value.name,
      status: value.status
    }) as T
  }
  if (isCommand(value)) {
    const command = value as Command
    const update = command.update as Record<string, unknown> | undefined
    if (!update || !Array.isArray(update.messages)) return value
    const messages = [] as unknown[]
    for (const message of update.messages)
      messages.push(
        ToolMessage.isInstance(message) && (!toolCallId || message.tool_call_id === toolCallId)
          ? await mapModResult(message, filter, toolCallId)
          : message
      )
    return new Command({
      update: { ...update, messages },
      ...(command.graph !== undefined ? { graph: command.graph } : {}),
      ...(command.goto !== undefined ? { goto: command.goto } : {}),
      ...(command.resume !== undefined ? { resume: command.resume } : {})
    }) as T
  }
  const result = await filter(value)
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    result &&
    typeof result === "object" &&
    !Array.isArray(result)
  ) {
    for (const key of ["exitCode", "status", "isError", "capabilityId", "task_id"])
      if (Object.hasOwn(value, key)) result[key] = (value as Record<string, ModJson>)[key]
  }
  return result as T
}

export function projectModResult(value: unknown, toolCallId?: string): ModProjection {
  if (ToolMessage.isInstance(value)) {
    const content = filterModData(value.content, false)
    return { text: typeof content === "string" ? content : JSON.stringify(content), data: content }
  }
  if (isCommand(value)) {
    const update = (value as Command).update as Record<string, unknown> | undefined
    const message = Array.isArray(update?.messages)
      ? update.messages.findLast(
          (message) =>
            ToolMessage.isInstance(message) && (!toolCallId || message.tool_call_id === toolCallId)
        )
      : undefined
    return message ? projectModResult(message, toolCallId) : { text: "[Host control flow]" }
  }
  const data = filterModData(value, false)
  if (typeof data === "string") return { text: data }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const text =
      typeof data.text === "string"
        ? data.text
        : typeof data.output === "string"
          ? data.output
          : JSON.stringify(data)
    return { text, data }
  }
  return { text: JSON.stringify(data), data }
}

export function replaceModProjection<T>(
  original: T,
  projection: ModProjection,
  toolCallId?: string
): T {
  if (ToolMessage.isInstance(original)) {
    return new ToolMessage({
      content: projection.text,
      tool_call_id: original.tool_call_id,
      id: original.id,
      name: original.name,
      status: original.status,
      artifact: projection.data,
      metadata: original.metadata,
      additional_kwargs: original.additional_kwargs,
      response_metadata: original.response_metadata
    }) as T
  }
  if (isCommand(original)) {
    const command = original as Command
    const update = command.update as Record<string, unknown> | undefined
    if (!update || !Array.isArray(update.messages)) return original
    return new Command({
      update: {
        ...update,
        messages: update.messages.map((message) =>
          ToolMessage.isInstance(message) && (!toolCallId || message.tool_call_id === toolCallId)
            ? replaceModProjection(message, projection, toolCallId)
            : message
        )
      },
      ...(command.graph !== undefined ? { graph: command.graph } : {}),
      ...(command.goto !== undefined ? { goto: command.goto } : {}),
      ...(command.resume !== undefined ? { resume: command.resume } : {})
    }) as T
  }
  if (typeof original === "string") return projection.text as T
  if (original && typeof original === "object" && !Array.isArray(original)) {
    const record = original as Record<string, unknown>
    if (typeof record.capabilityId === "string" && typeof record.isError === "boolean") {
      const content = [{ type: "text", text: projection.text }]
      return {
        ...record,
        text: projection.text,
        contentBlocks: content,
        structuredContent: projection.data,
        raw: {
          content,
          ...(projection.data !== undefined ? { structuredContent: projection.data } : {}),
          isError: record.isError
        }
      } as T
    }
    if (typeof record.output === "string") return { ...record, output: projection.text } as T
    // Filesystem write results contain execution truth. Only attach presentation metadata.
    return {
      ...record,
      metadata: { ...((record.metadata as object) ?? {}), modProjection: projection }
    } as T
  }
  return original
}
