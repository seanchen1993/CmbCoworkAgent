import { createHash } from "crypto"
import type { ToolFailureSignal } from "../hooks/tool-failure"

export type FailureFuseAction = "observe" | "warn" | "strong_warn" | "halt"
export type FailureFuseMode = "off" | "warn" | "debug"

export interface FailureFuseInput {
  threadId: string
  turnId: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  signal: ToolFailureSignal
  mode: FailureFuseMode
}

export interface FailureFuseDecision {
  action: FailureFuseAction
  fingerprint: string
  count: number
  threshold: number
  reason: string
  toolName?: string
  lastError?: string
}

export type FailureFuseNoticeCallback = (decision: FailureFuseDecision) => void

interface FailureFuseState {
  threadId: string
  turnId: string
  toolName?: string
  toolArgsKey: string
  count: number
  firstSeenAt: number
  lastSeenAt: number
  lastToolCallId?: string
  lastError?: string
}

export class FailureFuseHaltError extends Error {
  readonly decision: FailureFuseDecision

  constructor(decision: FailureFuseDecision) {
    super(decision.reason)
    this.name = "FailureFuseHaltError"
    this.decision = decision
  }
}

function isFailureFuseDecision(value: unknown): value is FailureFuseDecision {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.action === "halt" &&
    typeof record.fingerprint === "string" &&
    typeof record.count === "number" &&
    typeof record.threshold === "number" &&
    typeof record.reason === "string"
  )
}

function getDirectFailureFuseHaltError(error: unknown): FailureFuseHaltError | null {
  if (!(error instanceof Error)) return null
  const decision = (error as { decision?: unknown }).decision
  if (error.name === "FailureFuseHaltError" && isFailureFuseDecision(decision)) {
    return error as FailureFuseHaltError
  }
  return null
}

export function isFailureFuseHaltError(error: unknown): error is FailureFuseHaltError {
  return getDirectFailureFuseHaltError(error) !== null
}

export function getFailureFuseHaltError(error: unknown): FailureFuseHaltError | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const direct = getDirectFailureFuseHaltError(current)
    if (direct) return direct
    current = (current as { cause?: unknown }).cause
  }
  return null
}

const WARN_THRESHOLD = 3
const DEBUG_THRESHOLD = 1
const MAX_STATES = 4096
const STATE_TTL_MS = 10 * 60 * 1000
const KEY_SEPARATOR = "\u001f"
const MAX_NORMALIZED_MESSAGE_CHARS = 2000
const MAX_STABLE_ARG_STRING_CHARS = 512
const STABLE_ARG_STRING_EDGE_CHARS = 240
const MAX_STABLE_ARG_COLLECTION_ITEMS = 40
const MAX_STABLE_ARG_DEPTH = 8

const states = new Map<string, FailureFuseState>()

function nowMs(): number {
  return Date.now()
}

function compactStates(now = nowMs()): void {
  for (const [key, state] of states) {
    if (now - state.lastSeenAt > STATE_TTL_MS) states.delete(key)
  }

  while (states.size > MAX_STATES) {
    const firstKey = states.keys().next().value
    if (!firstKey) break
    states.delete(firstKey)
  }
}

function normalizeMessage(message: string): string {
  const clipped =
    message.length > MAX_NORMALIZED_MESSAGE_CHARS
      ? `${message.slice(0, 1000)}...[${message.length} chars]...${message.slice(-1000)}`
      : message

  return clipped
    .replace(/C:\\Users\\[^\\\s]+/gi, "%USERPROFILE%")
    .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
    .replace(/\/home\/[^/\s]+/g, "/home/<user>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<uuid>"
    )
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hash>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<timestamp>")
    .replace(/:\d+:\d+/g, ":<line>:<col>")
    .replace(/:\d+\b/g, ":<line>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

function firstShellWord(command: string): string {
  const start = command.search(/\S/)
  if (start < 0) return ""

  const preview = command.slice(start, Math.min(command.length, start + 2000))
  const quote = preview[0]
  if (quote === '"' || quote === "'") {
    const closingQuote = preview.indexOf(quote, 1)
    return closingQuote > 0 ? preview.slice(1, closingQuote) : preview.slice(1)
  }

  const whitespace = /\s/.exec(preview)
  const end = whitespace?.index ?? preview.length
  return preview.slice(0, end)
}

function summarizeToolArgs(toolArgs: unknown): string {
  if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return ""
  const record = toolArgs as Record<string, unknown>
  const parts: string[] = []

  for (const key of ["tool_id", "toolId", "name", "provider", "capabilityId"]) {
    if (typeof record[key] === "string" && record[key]) {
      parts.push(`${key}=${record[key]}`)
      break
    }
  }

  if (typeof record.command === "string") {
    const commandWord = firstShellWord(record.command)
    if (commandWord) parts.push(`command=${commandWord}`)
  }

  const pathValue = record.file_path ?? record.filePath ?? record.path
  if (typeof pathValue === "string" && pathValue.trim()) {
    const normalized = pathValue.replace(/\\/g, "/")
    const basename = normalized.split("/").filter(Boolean).pop() ?? normalized
    const extension = /\.[^.]+$/.exec(basename)?.[0] ?? ""
    parts.push(`path=*${extension || "<no-ext>"}`)
  }

  return parts.join("|")
}

function clipStableArgString(value: string): string {
  if (value.length <= MAX_STABLE_ARG_STRING_CHARS) return value
  return `${value.slice(0, STABLE_ARG_STRING_EDGE_CHARS)}...[${value.length} chars]...${value.slice(
    -STABLE_ARG_STRING_EDGE_CHARS
  )}`
}

function stableArgsJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): string {
  if (depth > MAX_STABLE_ARG_DEPTH) return JSON.stringify("[MaxDepth]")
  if (value === null || value === undefined) return String(value)
  if (typeof value === "string") return JSON.stringify(clipStableArgString(value))
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "bigint") return `${value.toString()}n`
  if (typeof value === "function" || typeof value === "symbol") {
    return JSON.stringify(String(value))
  }
  if (typeof value !== "object") return JSON.stringify(String(value))

  if (seen.has(value)) return JSON.stringify("[Circular]")
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_STABLE_ARG_COLLECTION_ITEMS)
      .map((item) => stableArgsJson(item, seen, depth + 1))
    if (value.length > MAX_STABLE_ARG_COLLECTION_ITEMS) {
      items.push(JSON.stringify(`[${value.length - MAX_STABLE_ARG_COLLECTION_ITEMS} more items]`))
    }
    return `[${items.join(",")}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const usedKeys = keys.slice(0, MAX_STABLE_ARG_COLLECTION_ITEMS)
  const pairs = usedKeys.map(
    (key) => `${JSON.stringify(key)}:${stableArgsJson(record[key], seen, depth + 1)}`
  )
  if (keys.length > MAX_STABLE_ARG_COLLECTION_ITEMS) {
    pairs.push(`"__truncated_keys__":${keys.length - MAX_STABLE_ARG_COLLECTION_ITEMS}`)
  }
  return `{${pairs.join(",")}}`
}

function toolArgsKey(toolArgs: unknown): string {
  return createHash("sha256").update(stableArgsJson(toolArgs)).digest("hex").slice(0, 16)
}

export function buildToolFailureFingerprint(input: FailureFuseInput): string {
  return [
    input.toolName ?? "<unknown-tool>",
    input.signal.kind,
    input.signal.errorType,
    normalizeMessage(input.signal.message),
    summarizeToolArgs(input.toolArgs)
  ]
    .filter(Boolean)
    .join("|")
}

function buildToolFailureObservationFingerprint(input: FailureFuseInput): string {
  return [
    input.toolName ?? "<unknown-tool>",
    input.signal.kind,
    input.signal.errorType,
    normalizeMessage(input.signal.message)
  ]
    .filter(Boolean)
    .join("|")
}

function makeStateKey(input: FailureFuseInput, fingerprint: string, argsKey: string): string {
  return [input.threadId, input.turnId, fingerprint, argsKey].join(KEY_SEPARATOR)
}

function decisionReason(
  action: FailureFuseAction,
  count: number,
  threshold: number,
  fingerprint: string
): string {
  if (action === "halt") {
    return `同类工具错误已重复出现 ${count} 次，已达到阈值 ${threshold}，平台已停止自动重试，避免继续消耗 token 或制造副作用。fingerprint=${fingerprint}`
  }
  if (action === "strong_warn") {
    return `同类工具错误已重复出现 ${count} 次，已达到强提醒阈值 ${threshold}。平台不会停止本轮，但不要继续用相同参数重试；请改变策略、换参数，或向用户说明阻塞原因。fingerprint=${fingerprint}`
  }
  if (action === "warn") {
    return `同类工具错误已重复出现 ${count} 次，接近阈值 ${threshold}。不要继续用相同参数重试，请先改变策略或向用户报告阻塞原因。`
  }
  return "工具失败已记录，未达到熔断阈值。"
}

export function recordToolFailure(input: FailureFuseInput): FailureFuseDecision {
  const threshold = input.mode === "debug" ? DEBUG_THRESHOLD : WARN_THRESHOLD

  if (input.mode === "off") {
    const fingerprint = buildToolFailureObservationFingerprint(input)
    return {
      action: "observe",
      fingerprint,
      count: 0,
      threshold: 0,
      reason: "工具失败提醒未开启，未记录失败计数。",
      toolName: input.toolName,
      lastError: input.signal.message
    }
  }

  if (input.signal.isInterrupt || input.signal.kind === "abort") {
    const fingerprint = buildToolFailureObservationFingerprint(input)
    return {
      action: "observe",
      fingerprint,
      count: 0,
      threshold,
      reason: "用户取消或中断不计入工具错误熔断。",
      toolName: input.toolName,
      lastError: input.signal.message
    }
  }

  const fingerprint = buildToolFailureFingerprint(input)
  const argsKey = toolArgsKey(input.toolArgs)
  const now = nowMs()
  compactStates(now)

  const key = makeStateKey(input, fingerprint, argsKey)
  const existing = states.get(key)
  const state: FailureFuseState = existing ?? {
    threadId: input.threadId,
    turnId: input.turnId,
    toolName: input.toolName,
    toolArgsKey: argsKey,
    count: 0,
    firstSeenAt: now,
    lastSeenAt: now
  }
  state.count += 1
  state.lastSeenAt = now
  state.lastToolCallId = input.toolCallId
  state.lastError = input.signal.message
  states.set(key, state)

  let action: FailureFuseAction = "observe"
  if (input.mode === "debug" && state.count >= threshold) {
    action = "halt"
  } else if (input.mode === "warn" && state.count >= threshold) {
    action = "strong_warn"
  } else if (input.mode === "warn" && state.count === threshold - 1) {
    action = "warn"
  }

  return {
    action,
    fingerprint,
    count: state.count,
    threshold,
    reason: decisionReason(action, state.count, threshold, fingerprint),
    toolName: input.toolName,
    lastError: input.signal.message
  }
}

export function recordToolSuccess(input: {
  threadId: string
  turnId: string
  toolName?: string
  toolArgs?: unknown
}): void {
  if (states.size === 0) return

  const candidateKeys: string[] = []
  for (const [key, state] of states) {
    if (
      state.threadId === input.threadId &&
      state.turnId === input.turnId &&
      (!input.toolName || state.toolName === input.toolName)
    ) {
      candidateKeys.push(key)
    }
  }
  if (candidateKeys.length === 0) return

  const argsKey = toolArgsKey(input.toolArgs)
  for (const key of candidateKeys) {
    const state = states.get(key)
    if (state?.toolArgsKey === argsKey) {
      states.delete(key)
    }
  }
}

export function clearFailureFuseTurn(threadId: string, turnId: string): void {
  for (const [key, state] of states) {
    if (state.threadId === threadId && state.turnId === turnId) states.delete(key)
  }
}

export function clearFailureFuseState(): void {
  states.clear()
}

export function getFailureFuseMode(): FailureFuseMode {
  if (process.env.CMB_AGENT_FAIL_FAST === "1") return "debug"
  if (isFailureFuseUserNoticeEnabled() || isFailureFuseModelFeedbackEnabled()) return "warn"
  return "off"
}

export function isFailureFuseUserNoticeEnabled(): boolean {
  const value = process.env.CMB_AGENT_FAILURE_FUSE_WARN?.trim().toLowerCase()
  return value !== "0" && value !== "false"
}

export function isFailureFuseModelFeedbackEnabled(): boolean {
  return process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK === "1"
}

function isFailureFuseReminderDecision(
  decision: FailureFuseDecision | null | undefined | void
): decision is FailureFuseDecision {
  return decision?.action === "warn" || decision?.action === "strong_warn"
}

export function shouldSendFailureFuseNotice(
  decision: FailureFuseDecision | null | undefined | void
): decision is FailureFuseDecision {
  return isFailureFuseUserNoticeEnabled() && isFailureFuseReminderDecision(decision)
}

export function shouldAttachFailureFuseFeedback(
  decision: FailureFuseDecision | null | undefined | void
): decision is FailureFuseDecision {
  return isFailureFuseModelFeedbackEnabled() && isFailureFuseReminderDecision(decision)
}

export function formatFailureFuseWarning(decision: FailureFuseDecision): string {
  const title = decision.action === "strong_warn" ? "Failure fuse strong warning" : "Failure fuse warning"
  return `[${title}]\n${decision.reason}\ntool=${decision.toolName ?? "<unknown>"}\nfingerprint=${decision.fingerprint}`
}

export function throwIfFailureFuseHalt(decision: FailureFuseDecision): void {
  if (decision.action === "halt") {
    throw new FailureFuseHaltError(decision)
  }
}
