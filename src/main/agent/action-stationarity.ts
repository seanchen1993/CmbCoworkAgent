import { createHash } from "crypto"
import { AIMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"

export const ACTION_STATIONARITY_NUDGE_THRESHOLD = 8
export const ACTION_STATIONARITY_HALT_THRESHOLD = 16
export const ACTION_STATIONARITY_BLOCKING_POLL_HALT_THRESHOLD = 32

const LOOP_GUARD_DISABLED_VALUES = new Set(["0", "false", "off", "no"])

/** Emergency kill switch. Guards are enabled unless explicitly disabled. */
export function areAgentLoopGuardsEnabled(
  value: string | undefined = process.env.CMB_AGENT_LOOP_GUARDS
): boolean {
  return !value || !LOOP_GUARD_DISABLED_VALUES.has(value.trim().toLowerCase())
}

const MAX_TRACKED_SCOPES = 1024
const TRACKER_TTL_MS = 10 * 60 * 1000
const MAX_ARG_DEPTH = 8
const MAX_ARG_COLLECTION_ITEMS = 40
const MAX_HASH_NODES = 4096
const MAX_ARG_STRING_BYTES = 1024 * 1024
const MAX_HASH_BYTES = 4 * 1024 * 1024
const MAX_TOOL_CALL_BATCH_ITEMS = 128
const MAX_DISPLAY_TOOL_NAMES = 8
const MIN_BLOCKING_TASK_OUTPUT_TIMEOUT_MS = 1000
const SCOPE_SEPARATOR = "\u001f"

let middlewareInstanceSequence = 0

export interface ActionStationarityDecision {
  action: "nudge" | "halt"
  fingerprint: string
  count: number
  threshold: number
  reason: string
  toolName?: string
}

interface ThreadStationarityState {
  threadId?: string
  turnId?: string
  fingerprint?: string
  count: number
  toolName?: string
  pendingNudge?: ActionStationarityDecision
  lastSeenAt: number
  inFlight: number
}

export interface ActionStationarityMiddlewareOptions {
  /** Stable logical-turn id reused by invoke/resume/interrupt/failover runtimes. */
  turnId?: string
  /** Configurable key stamped on synchronous task-subagent invocations. */
  ownerConfigKey?: string
  /** Shared task middleware must not merge id-less child invocations into main. */
  requireOwner?: boolean
}

interface HashBudget {
  remainingNodes: number
  remainingBytes: number
}

const states = new Map<string, ThreadStationarityState>()

function updateHash(
  hash: ReturnType<typeof createHash>,
  value: string,
  budget: HashBudget
): boolean {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes > budget.remainingBytes) return false
  budget.remainingBytes -= bytes
  hash.update(value)
  return true
}

export class ActionStationarityHaltError extends Error {
  readonly decision: ActionStationarityDecision

  constructor(decision: ActionStationarityDecision) {
    super(decision.reason)
    this.name = "ActionStationarityHaltError"
    this.decision = decision
  }
}

function directActionStationarityHaltError(error: unknown): ActionStationarityHaltError | null {
  if (!(error instanceof Error)) return null
  const decision = (error as { decision?: unknown }).decision
  if (
    error.name === "ActionStationarityHaltError" &&
    decision &&
    typeof decision === "object" &&
    (decision as { action?: unknown }).action === "halt" &&
    typeof (decision as { reason?: unknown }).reason === "string"
  ) {
    return error as ActionStationarityHaltError
  }
  return null
}

export function getActionStationarityHaltError(error: unknown): ActionStationarityHaltError | null {
  const seen = new Set<unknown>()
  const pending: unknown[] = [error]

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const direct = directActionStationarityHaltError(current)
    if (direct) return direct

    const nested = current as { cause?: unknown; toolError?: unknown }
    if (nested.cause !== undefined) pending.push(nested.cause)
    if (nested.toolError !== undefined) pending.push(nested.toolError)
  }
  return null
}

function hashUnknown(
  hash: ReturnType<typeof createHash>,
  value: unknown,
  seen: WeakSet<object>,
  budget: HashBudget,
  depth = 0
): boolean {
  if (budget.remainingNodes <= 0) {
    return false
  }
  budget.remainingNodes -= 1
  if (depth > MAX_ARG_DEPTH) {
    return false
  }
  if (value === null) {
    return updateHash(hash, "null;", budget)
  }
  const type = typeof value
  if (!updateHash(hash, `${type}:`, budget)) return false
  if (type === "string") {
    const text = String(value)
    // Bound both the cheap rejection path and the UTF-8 byte scan. A tool
    // argument beyond this size is intentionally untrackable rather than
    // hashing untrusted model output on Electron's main thread without limit.
    if (
      text.length > MAX_ARG_STRING_BYTES ||
      Buffer.byteLength(text, "utf8") > MAX_ARG_STRING_BYTES
    ) {
      return false
    }
    if (!updateHash(hash, `len=${text.length}:`, budget)) return false
    // Hash every byte inside the hard limit. Truncating the middle would make
    // distinct write_file calls look identical.
    if (!updateHash(hash, text, budget)) return false
    return updateHash(hash, ";", budget)
  }
  if (type === "number" || type === "boolean" || type === "bigint" || type === "undefined") {
    if (!updateHash(hash, String(value), budget)) return false
    return updateHash(hash, ";", budget)
  }
  if (type !== "object") {
    if (!updateHash(hash, String(value), budget)) return false
    return updateHash(hash, ";", budget)
  }

  const object = value as object
  if (seen.has(object)) {
    return false
  }
  seen.add(object)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARG_COLLECTION_ITEMS) return false
      if (!updateHash(hash, `[len=${value.length};`, budget)) return false
      for (let index = 0; index < value.length; index += 1) {
        if (!updateHash(hash, `${index}:`, budget)) return false
        if (!hashUnknown(hash, value[index], seen, budget, depth + 1)) return false
      }
      return updateHash(hash, "]", budget)
    }
    if (!updateHash(hash, "{", budget)) return false
    const record = value as Record<string, unknown>
    const keys: string[] = []
    // Stop enumeration at budget + 1. Object.keys(record).sort() would first
    // allocate and sort every key, defeating the collection bound.
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue
      keys.push(key)
      if (keys.length > MAX_ARG_COLLECTION_ITEMS) return false
    }
    keys.sort()
    if (!updateHash(hash, `keys=${keys.length};`, budget)) return false
    for (const key of keys) {
      if (!hashUnknown(hash, key, seen, budget, depth + 1)) return false
      if (!updateHash(hash, ":", budget)) return false
      if (!hashUnknown(hash, record[key], seen, budget, depth + 1)) return false
    }
    return updateHash(hash, "}", budget)
  } finally {
    seen.delete(object)
  }
}

function toolCallName(call: unknown): string {
  if (!call || typeof call !== "object") return "<unknown-tool>"
  const name = (call as { name?: unknown }).name
  return typeof name === "string" && name ? name : "<unknown-tool>"
}

function toolCallArgs(call: unknown): unknown {
  if (!call || typeof call !== "object") return undefined
  return (call as { args?: unknown }).args
}

function isBlockingTaskOutputCall(call: unknown): boolean {
  if (toolCallName(call) !== "task_output") return false
  const args = toolCallArgs(call)
  if (!args || typeof args !== "object" || Array.isArray(args)) return false
  const record = args as Record<string, unknown>
  if (typeof record.task_id !== "string" || !record.task_id.trim()) return false
  if (record.block !== undefined && record.block !== true) return false
  if (record.timeout === undefined) return true
  return (
    typeof record.timeout === "number" &&
    Number.isFinite(record.timeout) &&
    record.timeout >= MIN_BLOCKING_TASK_OUTPUT_TIMEOUT_MS &&
    record.timeout <= 600_000
  )
}

function isBlockingTaskOutputBatch(toolCalls: readonly unknown[]): boolean {
  return toolCalls.length > 0 && toolCalls.every(isBlockingTaskOutputCall)
}

export function actionStationaritySignature(toolCalls: readonly unknown[]): {
  fingerprint: string
  toolName: string
} | null {
  if (toolCalls.length === 0 || toolCalls.length > MAX_TOOL_CALL_BATCH_ITEMS) return null
  const hash = createHash("sha256")
  const names: string[] = []
  const budget: HashBudget = {
    remainingNodes: MAX_HASH_NODES,
    remainingBytes: MAX_HASH_BYTES
  }
  if (!updateHash(hash, `batch=${toolCalls.length};`, budget)) return null
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index]
    const name = toolCallName(call)
    if (names.length < MAX_DISPLAY_TOOL_NAMES) names.push(name)
    if (!updateHash(hash, `tool[${index}]:`, budget)) return null
    if (!hashUnknown(hash, name, new WeakSet<object>(), budget)) return null
    if (!updateHash(hash, "\u001fargs:", budget)) return null
    if (!hashUnknown(hash, toolCallArgs(call), new WeakSet<object>(), budget)) return null
    if (!updateHash(hash, "\u001e", budget)) return null
  }
  if (toolCalls.length > names.length) names.push(`…(+${toolCalls.length - names.length})`)
  return {
    fingerprint: hash.digest("hex").slice(0, 16),
    toolName: names.join(", ")
  }
}

function stationarityReason(toolName: string, count: number): string {
  return `工具调用“${toolName}”以完全相同的参数连续出现 ${count} 次，平台已停止当前 agent turn，避免继续空转和消耗 token。请改变参数或策略，或者明确报告阻塞原因。`
}

function stationarityNudge(toolName: string, count: number, blockingTaskOutput: boolean): string {
  return [
    "## Repeated Tool Call Guard",
    `你已经使用完全相同的参数连续调用工具“${toolName}” ${count} 次。`,
    blockingTaskOutput
      ? "这是阻塞式后台任务轮询。请确认任务仍在运行，并改用更长的 timeout 一次等待；若任务不存在、已经完成或无法继续，请结束本轮并明确说明。继续重复将在更高阈值自动停止当前 agent turn。"
      : "停止重复这一调用并重新判断当前状态。若在等待后台任务，请使用更长的阻塞超时后只检查一次；若无法继续，请结束本轮并明确说明阻塞原因。继续重复将自动停止当前 agent turn。"
  ].join("\n\n")
}

function compactStates(states: Map<string, ThreadStationarityState>, now: number): void {
  for (const [key, state] of states) {
    // Stable logical turns have explicit lifecycle cleanup and may legitimately
    // wait on user approval for longer than the fallback TTL. Only anonymous,
    // instance-local scopes are eligible for age-based cleanup.
    if (!state.turnId && state.inFlight === 0 && now - state.lastSeenAt > TRACKER_TTL_MS) {
      states.delete(key)
    }
  }
  const excess = states.size - MAX_TRACKED_SCOPES
  if (excess > 0) {
    const oldestKeys = [...states.entries()]
      // Explicit logical turns may be waiting for approval and are cleaned by
      // their lifecycle owner. Capacity pressure may evict only anonymous,
      // instance-local fallback state.
      .filter(([, state]) => !state.turnId && state.inFlight === 0)
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, excess)
      .map(([key]) => key)
    for (const key of oldestKeys) states.delete(key)
  }
}

function runtimeConfigurable(request: unknown): Record<string, unknown> | undefined {
  if (!request || typeof request !== "object") return undefined
  const runtime = (request as { runtime?: unknown }).runtime
  if (!runtime || typeof runtime !== "object") return undefined
  const configurable = (runtime as { configurable?: unknown }).configurable
  return configurable && typeof configurable === "object"
    ? (configurable as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stationarityScope(
  request: unknown,
  options: ActionStationarityMiddlewareOptions,
  instanceId: string
): { key: string; threadId?: string } | null {
  const configurable = runtimeConfigurable(request)
  const threadId = nonEmptyString(configurable?.thread_id)
  const ownerId = options.ownerConfigKey
    ? nonEmptyString(configurable?.[options.ownerConfigKey])
    : undefined
  if (options.requireOwner && !ownerId) return null
  // A logical turn intentionally crosses runtime rebuilds. Runtimes without a
  // thread id remain instance-local even if a turn id was supplied, because
  // they cannot be resumed or cleaned with thread-level isolation. Task owner
  // keeps concurrent deepagents children independent.
  const lifecycleId = options.turnId ?? instanceId
  return {
    key: [threadId ?? instanceId, lifecycleId, ownerId ?? "main"].join(SCOPE_SEPARATOR),
    threadId
  }
}

export function clearActionStationarityTurn(threadId: string, turnId: string): void {
  for (const [key, state] of states) {
    const belongsToThread =
      state.threadId === threadId || state.threadId?.startsWith(`${threadId}__`) === true
    if (belongsToThread && state.turnId === turnId) states.delete(key)
  }
}

export function clearActionStationarityState(): void {
  states.clear()
}

/**
 * Detects action stationarity at the model-response boundary, before ToolNode
 * executes the next repeated batch. One middleware instance may be shared by
 * concurrent task subagents; state is isolated by logical turn and task owner.
 */
export function createActionStationarityMiddleware(
  options: ActionStationarityMiddlewareOptions = {}
): ReturnType<typeof createMiddleware> {
  middlewareInstanceSequence += 1
  const instanceId = `instance-${middlewareInstanceSequence}`

  return createMiddleware({
    name: "actionStationarity",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: async (request: any, handler: any) => {
      const scope = stationarityScope(request, options, instanceId)
      if (!scope) return handler(request)
      const now = Date.now()
      compactStates(states, now)
      let state = states.get(scope.key)
      if (!state) {
        state = {
          threadId: scope.threadId,
          // A stable turn is meaningful only with a stable thread identity.
          // Thread-less runtimes stay instance-local and retain TTL/LRU cleanup.
          turnId: scope.threadId ? options.turnId : undefined,
          count: 0,
          lastSeenAt: now,
          inFlight: 0
        }
        states.set(scope.key, state)
      }
      state.lastSeenAt = now

      let effectiveRequest = request
      const pendingNudge = state.pendingNudge
      if (pendingNudge) {
        effectiveRequest = {
          ...request,
          systemMessage: request.systemMessage.concat(`\n\n${pendingNudge.reason}`)
        }
      }

      state.inFlight += 1
      try {
        const response: unknown = await handler(effectiveRequest)
        // A turn may be cleared or replaced while the model request is in
        // flight. Ignore the retired response for guard accounting so it
        // cannot emit a stale nudge/halt against the old lifecycle.
        if (states.get(scope.key) !== state) return response
        if (pendingNudge && state.pendingNudge === pendingNudge) state.pendingNudge = undefined
        if (!AIMessage.isInstance(response)) return response

        const calls = Array.isArray(response.tool_calls) ? response.tool_calls : []
        const signature = actionStationaritySignature(calls)
        if (!signature) {
          if (states.get(scope.key) === state) states.delete(scope.key)
          return response
        }

        if (state.fingerprint === signature.fingerprint) {
          state.count += 1
        } else {
          state.fingerprint = signature.fingerprint
          state.count = 1
          state.pendingNudge = undefined
        }
        state.toolName = signature.toolName
        state.lastSeenAt = Date.now()
        const blockingTaskOutput = isBlockingTaskOutputBatch(calls)
        const haltThreshold = blockingTaskOutput
          ? ACTION_STATIONARITY_BLOCKING_POLL_HALT_THRESHOLD
          : ACTION_STATIONARITY_HALT_THRESHOLD

        if (state.count >= haltThreshold) {
          const decision: ActionStationarityDecision = {
            action: "halt",
            fingerprint: signature.fingerprint,
            count: state.count,
            threshold: haltThreshold,
            reason: stationarityReason(signature.toolName, state.count),
            toolName: signature.toolName
          }
          if (states.get(scope.key) === state) states.delete(scope.key)
          throw new ActionStationarityHaltError(decision)
        }

        if (state.count === ACTION_STATIONARITY_NUDGE_THRESHOLD) {
          state.pendingNudge = {
            action: "nudge",
            fingerprint: signature.fingerprint,
            count: state.count,
            threshold: ACTION_STATIONARITY_NUDGE_THRESHOLD,
            reason: stationarityNudge(signature.toolName, state.count, blockingTaskOutput),
            toolName: signature.toolName
          }
        }
        return response
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1)
        if (states.get(scope.key) === state) {
          state.lastSeenAt = Date.now()
        }
        // All-active scopes may temporarily exceed the retention limit. As
        // soon as any request settles, immediately trim completed states.
        compactStates(states, Date.now())
      }
    }
  })
}
