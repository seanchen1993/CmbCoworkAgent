import { createHash } from "crypto"
import type { AgentTrace, TraceChatMessage, TraceNode, TraceToolCall } from "./types"

/**
 * A trace records the same content several times over, because the renderer has
 * three fallback chains and the collector cannot know which one will fire:
 * tool args land on the step, on the model call and on the tool node; assistant
 * text lands on the step, on the model call's output message and on the llm
 * node. Measured on a 20-step trace, ~46% of the bytes were duplicates, and
 * they crowd out everything recorded later — that is how identity fields ended
 * up as "[trace budget exhausted]".
 *
 * So each value is stored once, at its canonical position, and every other
 * position carries the id instead. Canonical is always the flattest structure
 * (`steps`, then `modelCalls`), which falls out for free: the collector is
 * called in that order, so "first occurrence wins" puts the literal there.
 *
 * Refs resolve only within one trace, and every read path rehydrates before
 * anything downstream sees a trace.
 */
/** Below this a ref costs more than the bytes it saves. */
const MIN_INTERNED_CHARS = 64

function digest(kind: string, text: string): string {
  return createHash("sha1").update(`${kind} ${text}`).digest("hex").slice(0, 16)
}

/**
 * Assigns ids to the first occurrence of a value and refs for the rest. One
 * instance per trace; shared by every recorder so copies collapse regardless of
 * which structure they land in.
 */
export class TraceContentInterner {
  private readonly stored = new Set<string>()

  /**
   * Claim `value` for the caller. `mid` means "you are the canonical copy,
   * stamp this id on yourself"; `ref` means "someone already stored it, keep an
   * id instead of the bytes"; `undefined` means it is too small for a ref to
   * pay for itself.
   *
   * Callers must pass the value they are actually going to store — ids are
   * content addresses, so interning before the byte budget truncates a value
   * would hand out an id nothing matches. Serialization happens once here: this
   * runs on every recorded value, and a second pass to measure the size showed
   * up immediately as a timeout in the bounds tests.
   */
  claim(value: unknown): { mid: string } | { ref: string } | undefined {
    if (value === null || value === undefined) return undefined
    const text = typeof value === "string" ? value : JSON.stringify(value)
    if (typeof text !== "string" || text.length < MIN_INTERNED_CHARS) return undefined
    const id = digest(typeof value, text)
    if (this.stored.has(id)) return { ref: id }
    this.stored.add(id)
    return { mid: id }
  }
}

type ContentIndex = Map<string, unknown>

/**
 * Rehydration restores the values, so the ids and pointers have done their job.
 * Strip them: a consumer should get back the shape it would have seen if the
 * trace had never been deduplicated, and a stray pointer is exactly the kind of
 * thing that reads as data to a dashboard.
 */
function stripRefFields<T extends object>(value: T): T {
  const next = { ...value } as Record<string, unknown>
  for (const key of Object.keys(next)) {
    if (key.endsWith("Ref") || key.endsWith("Mid") || key === "ref" || key === "mid") {
      delete next[key]
    }
  }
  return next as T
}

function indexToolCalls(calls: readonly TraceToolCall[] | undefined, index: ContentIndex): void {
  for (const call of calls ?? []) {
    if (typeof call?.argsMid === "string") index.set(call.argsMid, call.args)
  }
}

function indexMessage(message: TraceChatMessage | undefined, index: ContentIndex): void {
  if (!message) return
  if (typeof message.mid === "string") index.set(message.mid, message)
  if (typeof message.contentMid === "string") index.set(message.contentMid, message.content)
  if (typeof message.reasoningMid === "string" && typeof message.reasoning === "string") {
    index.set(message.reasoningMid, message.reasoning)
  }
}

/** Every id a trace declares, mapped to the literal that carries it. */
function buildContentIndex(trace: AgentTrace): ContentIndex {
  const index: ContentIndex = new Map()
  for (const step of trace.steps ?? []) {
    if (typeof step.assistantTextMid === "string") {
      index.set(step.assistantTextMid, step.assistantText)
    }
    indexToolCalls(step.toolCalls, index)
  }
  for (const call of trace.modelCalls ?? []) {
    indexToolCalls(call.toolCalls, index)
    indexMessage(call.outputMessage, index)
    for (const message of call.inputMessages ?? []) indexMessage(message, index)
  }
  for (const node of trace.nodes ?? []) {
    if (Array.isArray(node.input)) {
      for (const item of node.input) {
        if (item && typeof item === "object") indexMessage(item as TraceChatMessage, index)
      }
    }
  }
  return index
}

function rehydrateToolCalls(
  calls: TraceToolCall[] | undefined,
  index: ContentIndex
): TraceToolCall[] | undefined {
  if (!calls) return calls
  return calls.map((call) => {
    if (typeof call.argsRef !== "string") return stripRefFields(call)
    const args = index.get(call.argsRef)
    return stripRefFields({
      ...call,
      args:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {}
    })
  })
}

function rehydrateMessage(message: TraceChatMessage, index: ContentIndex): TraceChatMessage {
  let output = message
  if (typeof message.ref === "string") {
    const source = index.get(message.ref)
    output =
      source && typeof source === "object"
        ? { ...(source as TraceChatMessage), ...(message.name ? { name: message.name } : {}) }
        : { ...message, content: "" }
  }
  if (typeof output.contentRef === "string") {
    const text = index.get(output.contentRef)
    output = { ...output, content: typeof text === "string" ? text : "" }
  }
  if (typeof output.reasoningRef === "string") {
    const text = index.get(output.reasoningRef)
    output = typeof text === "string" ? { ...output, reasoning: text } : output
  }
  return stripRefFields(output)
}

function rehydrateNode(node: TraceNode, index: ContentIndex): TraceNode {
  const next: TraceNode = { ...node }
  if (typeof next.inputRef === "string") {
    next.input = index.get(next.inputRef)
    delete next.inputRef
  }
  if (typeof next.outputRef === "string") {
    next.output = index.get(next.outputRef)
    delete next.outputRef
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) =>
      item && typeof item === "object" ? rehydrateMessage(item as TraceChatMessage, index) : item
    )
  }
  if (next.metadata) {
    let changed = false
    const metadata: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(next.metadata)) {
      // Interned metadata lives under "<key>Ref" as a string, so restoring it
      // means putting the original key back and dropping the pointer.
      if (key.endsWith("Ref") && typeof value === "string" && index.has(value)) {
        metadata[key.slice(0, -3)] = index.get(value)
        changed = true
      } else {
        metadata[key] = value
      }
    }
    if (changed) next.metadata = metadata
  }
  return next
}

/**
 * Put every deduplicated value back. Call this at any boundary where a trace
 * leaves storage — nothing downstream should ever meet a ref. Cheap and
 * idempotent: a trace with no ids is returned untouched.
 */
export function rehydrateTraceContent<T extends AgentTrace>(trace: T): T {
  const index = buildContentIndex(trace)
  if (index.size === 0) return trace

  const next = { ...trace }
  next.steps = (trace.steps ?? []).map((step) =>
    stripRefFields({
      ...step,
      toolCalls: rehydrateToolCalls(step.toolCalls, index) ?? []
    })
  )
  if (trace.modelCalls) {
    next.modelCalls = trace.modelCalls.map((call) => ({
      ...call,
      inputMessages: (call.inputMessages ?? []).map((message) => rehydrateMessage(message, index)),
      outputMessage: rehydrateMessage(call.outputMessage, index),
      toolCalls: rehydrateToolCalls(call.toolCalls, index) ?? []
    }))
  }
  if (trace.nodes) next.nodes = trace.nodes.map((node) => rehydrateNode(node, index))
  return next
}
