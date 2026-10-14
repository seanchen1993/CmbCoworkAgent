import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { isModObject, ModFunctionError } from "./contracts"

/** These are bounded public projections, never conversation authority or a storage receipt. */
export const FUNCTION_SESSION_APPEND_DOORS = [
  "prompt", "command", "response", "tool-result", "tool-message", "delivery", "attachment",
  "hook-context", "note", "compaction", "notice"
] as const
export type FunctionSessionAppendDoor = (typeof FUNCTION_SESSION_APPEND_DOORS)[number]
export type FunctionApiContentBlock = ModObject & { type: string }
export type FunctionApiTextBlock = ModObject & { type: "text"; text: string }
export type FunctionApiMessage = ModObject & {
  role: "user" | "assistant"
  content: FunctionApiContentBlock[]
}
export type FunctionSessionAppendMessage = ModObject & {
  type: "user" | "assistant" | "attachment" | "system"
  name?: string
  role?: "user" | "assistant"
  isMeta?: true
  content: FunctionApiContentBlock[]
}
export type FunctionSessionAppendOrigin = ModObject & (
  | { kind: "composer" | "bridge" | "sdk" | "task-notification" | "scheduled-trigger" |
      "peer" | "peer-send-message" | "projects-relay" | "coordinator" | "observer" |
      "observer-activity" | "auto-continuation" | "unclassified" | "slack-ping" | "engine" }
  | { kind: "channel"; server: string }
  | { kind: "plugin"; name: string; asUser?: true }
  | { kind: "hook" | "plugin"; event: string }
  | { kind: "model"; model: string }
  | { kind: "tool"; tool: string }
)
export type FunctionSessionAppendInput = ModObject & {
  message: FunctionSessionAppendMessage
  door: FunctionSessionAppendDoor
  origin: FunctionSessionAppendOrigin
  uuid: string
  agentId?: string
}
export type FunctionSessionAppendArgs = ModObject & {
  message: ModObject & { type: "user" | "system"; content: FunctionApiTextBlock[] }
  /** A selector only; the native registry must find an actual current conversation. */
  agentId?: string
}
export type FunctionSessionAppendResult =
  | (ModObject & { message: FunctionSessionAppendMessage; uuid: string })
  | (ModObject & { deny: string })
export type FunctionSessionMessagesArgs = ModObject & { as?: "api"; agentId?: string }
export type FunctionSessionMessagesDeny = ModObject & { deny: string }

const NO_FIELDS = ["composer", "bridge", "sdk", "task-notification", "scheduled-trigger",
  "peer", "peer-send-message", "projects-relay", "coordinator", "observer", "observer-activity",
  "auto-continuation", "unclassified", "slack-ping", "engine"]
const MESSAGE_FIELDS = ["type", "name", "role", "isMeta", "content"]
const INPUT_FIELDS = ["message", "door", "origin", "uuid", "agentId"]
const MEDIA = new Set(["image", "document"])

function invalid(code = "MODS_SESSION_APPEND_INVALID"): never {
  throw new ModFunctionError(code)
}

/** Stricter than JSON.stringify: no hidden/symbol/accessor fields or sparse arrays are skipped. */
function strictJson(value: unknown): asserts value is ModJson {
  const ancestors = new Set<object>()
  let nodes = 30000
  const walk = (current: unknown, depth: number): void => {
    if (--nodes < 0 || depth > 32) invalid("MODS_SESSION_APPEND_LIMIT")
    if (current === null || typeof current === "string" || typeof current === "boolean") return
    if (typeof current === "number" && Number.isFinite(current)) return
    if (!current || typeof current !== "object" || ancestors.has(current)) invalid()
    const array = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      invalid()
    const keys = Reflect.ownKeys(current)
    if (array && keys.length !== current.length + 1) invalid()
    ancestors.add(current)
    for (const key of keys) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
        invalid()
      const field = Object.getOwnPropertyDescriptor(current, key)
      if (!field || !("value" in field)) invalid()
      if (array && key === "length") continue
      if (!field.enumerable || (array && !/^(0|[1-9]\d*)$/.test(key))) invalid()
      walk(field.value, depth + 1)
    }
    ancestors.delete(current)
  }
  walk(value, 0)
  encodeModJson(value)
}

function object(value: ModJson): ModObject {
  if (!isModObject(value)) invalid()
  return value
}

function fields(value: ModObject, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}

function named(value: ModJson | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function blocks(value: ModJson | undefined): FunctionApiContentBlock[] {
  if (!Array.isArray(value)) invalid()
  return value.map((raw) => {
    const block = object(raw)
    if (!named(block.type)) invalid()
    if (block.type === "text" && typeof block.text !== "string") invalid()
    if (block.type === "tool_result") {
      if (!named(block.tool_use_id) ||
        (block.is_error !== undefined && typeof block.is_error !== "boolean")) invalid()
      if (block.content !== undefined) {
        if (typeof block.content !== "string") blocks(block.content)
      }
    }
    return block as FunctionApiContentBlock
  })
}

function origin(value: ModJson | undefined): FunctionSessionAppendOrigin {
  const input = object(value ?? null)
  if (typeof input.kind !== "string") invalid()
  if (NO_FIELDS.includes(input.kind)) fields(input, ["kind"])
  else if (input.kind === "channel") {
    fields(input, ["kind", "server"])
    if (!named(input.server)) invalid()
  } else if (input.kind === "model" || input.kind === "tool") {
    const key = input.kind === "model" ? "model" : "tool"
    fields(input, ["kind", key])
    if (!named(input[key])) invalid()
  } else if (input.kind === "plugin" && Object.hasOwn(input, "name")) {
    fields(input, ["kind", "name", "asUser"])
    if (!named(input.name) || (input.asUser !== undefined && input.asUser !== true)) invalid()
  } else if (input.kind === "hook" || input.kind === "plugin") {
    fields(input, ["kind", "event"])
    if (!named(input.event)) invalid()
  } else invalid()
  return input as FunctionSessionAppendOrigin
}

/** Provenance data only. No source object, runtime authority or registration is created. */
export function validateFunctionSessionAppendOrigin(value: unknown):
  asserts value is FunctionSessionAppendOrigin {
  strictJson(value)
  origin(value)
}

function message(value: ModJson): FunctionSessionAppendMessage {
  const input = object(value)
  fields(input, MESSAGE_FIELDS)
  if (typeof input.type !== "string" ||
    !["user", "assistant", "attachment", "system"].includes(input.type) ||
    (input.name !== undefined && !named(input.name)) ||
    (input.role !== undefined && input.role !== "user" && input.role !== "assistant") ||
    (input.isMeta !== undefined && input.isMeta !== true)) invalid()
  const content = blocks(input.content)
  if ((input.type === "user" || input.type === "assistant") && input.name !== undefined) invalid()
  if (input.type === "system" && (input.role !== undefined || content.length !== 1 ||
    content[0].type !== "text")) invalid()
  return input as FunctionSessionAppendMessage
}

export function validateFunctionSessionAppendArgs(value: unknown):
  asserts value is FunctionSessionAppendArgs {
  strictJson(value)
  const input = object(value)
  fields(input, ["message", "agentId"])
  if (input.agentId !== undefined && !named(input.agentId)) invalid()
  const row = object(input.message)
  fields(row, ["type", "content"])
  if (row.type !== "user" && row.type !== "system") invalid()
  if (!Array.isArray(row.content) || (row.type === "system" && row.content.length !== 1)) invalid()
  for (const raw of row.content) {
    const block = object(raw)
    fields(block, ["type", "text"])
    if (block.type !== "text" || typeof block.text !== "string") invalid()
  }
}

export function validateFunctionSessionMessagesArgs(value: unknown):
  asserts value is FunctionSessionMessagesArgs {
  strictJson(value)
  const input = object(value)
  fields(input, ["as", "agentId"])
  if ((input.as !== undefined && input.as !== "api") ||
    (input.agentId !== undefined && !named(input.agentId))) invalid("MODS_SESSION_MESSAGES_ARGUMENT")
}

export function normalizeFunctionSessionMessagesArgs(value: unknown): FunctionSessionMessagesArgs {
  if (value === undefined) return {}
  validateFunctionSessionMessagesArgs(value)
  return value
}

export function validateFunctionSessionApiMessages(value: unknown):
  asserts value is FunctionApiMessage[] {
  strictJson(value)
  if (!Array.isArray(value) || value.length > 4096) invalid("MODS_SESSION_MESSAGES_RESULT")
  for (const raw of value) {
    const row = object(raw)
    fields(row, ["role", "content"])
    if (row.role !== "user" && row.role !== "assistant") invalid("MODS_SESSION_MESSAGES_RESULT")
    blocks(row.content)
  }
}

/** Large native rows may be unavailable to a bounded hook; their real core must retain them. */
export function validateFunctionSessionAppendInput(value: unknown):
  asserts value is FunctionSessionAppendInput {
  strictJson(value)
  const input = object(value)
  fields(input, INPUT_FIELDS)
  if (typeof input.door !== "string" ||
    !FUNCTION_SESSION_APPEND_DOORS.includes(input.door as FunctionSessionAppendDoor) ||
    !named(input.uuid) || (input.agentId !== undefined && !named(input.agentId))) invalid()
  origin(input.origin)
  message(input.message)
}

function equal(left: ModJson, right: ModJson): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
  if (!isModObject(left) || !isModObject(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
}

function copy(value: ModJson): ModJson {
  if (Array.isArray(value)) return value.map(copy)
  if (!isModObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
}

/** Fixed fields may be omitted, but a present different field is never silently overwritten. */
function pinned(candidate: ModObject, baseline: ModObject, writable: readonly string[]): ModObject {
  for (const [key, value] of Object.entries(candidate))
    if (!writable.includes(key) && (!Object.hasOwn(baseline, key) || !equal(value, baseline[key])))
      invalid("MODS_SESSION_APPEND_PINNED")
  const result = object(copy(baseline))
  for (const key of writable) if (Object.hasOwn(candidate, key)) result[key] = copy(candidate[key])
  return result
}

function normalizeToolResult(candidate: ModObject, baseline: FunctionApiContentBlock):
  FunctionApiContentBlock {
  const result = pinned(candidate, baseline, ["content", "is_error"])
  if (result.is_error !== undefined && typeof result.is_error !== "boolean") invalid()
  if (Object.hasOwn(candidate, "content")) {
    const old = baseline.content
    const input = candidate.content
    const oldBlocks = typeof old === "string" ? [{ type: "text", text: old }] : old ?? []
    if (!Array.isArray(oldBlocks)) invalid()
    const nextBlocks = typeof input === "string" ? [{ type: "text", text: input }] : input
    const normalized = normalizeContent(nextBlocks, blocks(oldBlocks))
    result.content = typeof input === "string" ? input : normalized
  }
  return result as FunctionApiContentBlock
}

function normalizeContent(candidate: ModJson | undefined, baseline: readonly FunctionApiContentBlock[]):
  FunctionApiContentBlock[] {
  if (!Array.isArray(candidate)) invalid()
  const fixed = baseline.filter((block) => block.type !== "text" && !MEDIA.has(block.type))
  const media = baseline.filter((block) => MEDIA.has(block.type))
  const used = new Set<number>()
  let occurrence = 0
  const result = candidate.map((raw) => {
    const block = object(raw)
    if (!named(block.type)) invalid()
    if (block.type === "text") {
      if (typeof block.text !== "string") invalid()
      return object(copy(block)) as FunctionApiContentBlock
    }
    if (MEDIA.has(block.type)) {
      const index = media.findIndex((old, index) => !used.has(index) && equal(block, old))
      if (index < 0) invalid("MODS_SESSION_APPEND_MEDIA")
      used.add(index)
      return object(copy(media[index])) as FunctionApiContentBlock
    }
    const old = fixed[occurrence++]
    if (!old || old.type !== block.type) invalid("MODS_SESSION_APPEND_PINNED")
    return block.type === "tool_result" ? normalizeToolResult(block, old) :
      pinned(block, old, []) as FunctionApiContentBlock
  })
  // We cannot infer where a removed fixed occurrence belonged: fail this transformation,
  // then the native dispatcher can retain the original row rather than invent a position.
  if (occurrence !== fixed.length) invalid("MODS_SESSION_APPEND_PINNED")
  return result
}

/** Data normalization only. Private source/target, once proof and durable commit stay on main. */
export function normalizeFunctionSessionAppendInput(candidate: unknown,
  baseline: FunctionSessionAppendInput): FunctionSessionAppendInput {
  validateFunctionSessionAppendInput(baseline)
  strictJson(candidate)
  const input = object(candidate)
  fields(input, INPUT_FIELDS)
  const result = pinned(input, baseline, ["message"])
  if (Object.hasOwn(input, "message")) {
    const proposed = object(input.message)
    fields(proposed, MESSAGE_FIELDS)
    const row = pinned(proposed, baseline.message, ["content"])
    if (Object.hasOwn(proposed, "content"))
      row.content = normalizeContent(proposed.content, baseline.message.content)
    result.message = row
  }
  validateFunctionSessionAppendInput(result)
  return result
}

/** A structurally valid success is still not proof that next/core stored anything. */
export function validateFunctionSessionAppendResultShape(value: unknown):
  asserts value is FunctionSessionAppendResult {
  strictJson(value)
  const input = object(value)
  if (Object.hasOwn(input, "deny")) {
    fields(input, ["deny"])
    if (!named(input.deny)) invalid("MODS_SESSION_APPEND_RESULT")
    return
  }
  fields(input, ["message", "uuid"])
  if (!named(input.uuid)) invalid("MODS_SESSION_APPEND_RESULT")
  message(input.message)
}
