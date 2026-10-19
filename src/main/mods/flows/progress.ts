import type { FlowAttempt } from "../../../shared/mods/flows/types"

type Observation = Omit<NonNullable<FlowAttempt["progress"]>, "updatedAt">
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined

/** Only the latest new assistant observation after this step's human prompt. */
export function publicFlowProgress(snapshot: unknown): Observation | undefined {
  const messages = record(snapshot)?.messages
  if (!Array.isArray(messages)) return undefined
  let latest: RecordValue | undefined
  let latestIsTool = false,
    foundPrompt = false
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 512); index--) {
    const message = record(messages[index])
    if (!message) continue
    const getType = message._getType
    const type = String(
      typeof getType === "function"
        ? getType.call(message)
        : Array.isArray(message.id)
          ? message.id.at(-1)
          : (message.type ?? message.role ?? "")
    ).toLowerCase()
    if (type === "human" || type === "user" || type === "humanmessage") {
      if (!latest) return undefined
      foundPrompt = true
      break
    }
    if (!latest && ["ai", "assistant", "aimessage"].includes(type)) latest = message
    // A tool result is never public text. Wait for the next assistant observation.
    if (!latest && ["tool", "toolmessage"].includes(type)) {
      latest = message
      latestIsTool = true
    }
  }
  if (!latest || !foundPrompt) return undefined
  if (latestIsTool) return { phase: "model" }
  const value = record(latest.kwargs) ?? latest
  const calls = value.tool_calls ?? record(value.additional_kwargs)?.tool_calls
  const call = Array.isArray(calls) ? record(calls.at(-1)) : undefined
  const name = call?.name ?? record(call?.function)?.name
  if (typeof name === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(name))
    return { phase: "tool", toolName: name }
  const content = value.content
  const text = (
    typeof content === "string"
      ? content.slice(0, 16384)
      : Array.isArray(content)
        ? content
            .slice(-32)
            .flatMap((block) => {
              const item = record(block)
              return item?.type === "text" && typeof item.text === "string"
                ? [item.text.slice(0, 2000)]
                : []
            })
            .join("")
        : ""
  )
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .trim()
    .slice(-2000)
  return text ? { phase: "model", text } : undefined
}

/** Coalesce presentation notifications; never persist, authorize, or fail execution. */
export function flowProgressReporter(
  current: () => boolean,
  write: (value: NonNullable<FlowAttempt["progress"]>) => void,
  notify: () => void
) {
  let closed = false,
    dirty = false,
    previous = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!dirty) return
    dirty = false
    try {
      if (current()) notify()
    } catch {
      /* Observation only. */
    }
  }
  return {
    report(value: Observation) {
      try {
        if (closed || !current() || !["model", "tool"].includes(value.phase)) return
        const observation: Observation = {
          phase: value.phase,
          ...(typeof value.text === "string" ? { text: value.text.slice(-2000) } : {}),
          ...(typeof value.toolName === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value.toolName)
            ? { toolName: value.toolName }
            : {})
        }
        const identity = JSON.stringify(observation)
        if (identity === previous) return
        previous = identity
        write({ ...observation, updatedAt: Date.now() })
        dirty = true
        if (!timer) {
          timer = setTimeout(flush, 500)
          timer.unref?.()
        }
      } catch {
        /* Observation only. */
      }
    },
    close() {
      if (closed) return
      closed = true
      flush()
    }
  }
}
