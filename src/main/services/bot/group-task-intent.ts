/** Prepared by a trusted IM adapter, not parsed from a user-written @name. */
export interface GroupTaskMessage {
  mentioned: boolean
  /** Body with structured mentions removed; ordinary text must not be rewritten. */
  text: string
}

export type GroupTaskIntent =
  | { kind: "ignore" }
  | { kind: "create_task"; content: string }
  | { kind: "continue_task"; taskNumber: string; content: string }
  | {
      kind: "clarify"
      reason: "missing_task" | "empty_content" | "invalid_task_number" | "too_large"
    }

const MAX_MESSAGE_CHARACTERS = 16_384
const MAX_TASK_NUMBER = 9_007_199_254_740_991n

/** Intent only: no lookup, implicit latest-task association, authorization or write. */
export function parseGroupTaskIntent(message: GroupTaskMessage): GroupTaskIntent {
  if (message.mentioned !== true) return { kind: "ignore" }
  if (message.text.length > MAX_MESSAGE_CHARACTERS) {
    return { kind: "clarify", reason: "too_large" }
  }
  const text = message.text.trim()
  const newTask = /^新任务(?:[：:]|\s|$)/.exec(text)
  if (newTask) {
    const content = text.slice(newTask[0].length).trim()
    return content ? { kind: "create_task", content } : { kind: "clarify", reason: "empty_content" }
  }

  const task = /^#?(TASK-([^\s：:]+))(?:[：:]|\s|$)/i.exec(text)
  if (!task) return { kind: "clarify", reason: "missing_task" }
  const number = task[2]
  // Matches the current service's TASK-<positive safe integer>, not arbitrary IDs.
  if (!/^[1-9]\d{0,15}$/.test(number) || BigInt(number) > MAX_TASK_NUMBER) {
    return { kind: "clarify", reason: "invalid_task_number" }
  }
  const content = text.slice(task[0].length).trim()
  return content
    ? { kind: "continue_task", taskNumber: `TASK-${number}`, content }
    : { kind: "clarify", reason: "empty_content" }
}
