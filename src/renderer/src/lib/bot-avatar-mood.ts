import type { LiveStreamMessage } from "./live-stream-messages"
import type { BotTask } from "../../../shared/bots/contracts"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"

export type BotAvatarMood =
  | "idle"
  | "think"
  | "work"
  | "read"
  | "write"
  | "run"
  | "search"
  | "send"
  | "orbit"
  | "stream"
  | "blocked"

type ActivityMessage = LiveStreamMessage & { role?: string; created_at?: Date }

export function botActiveTaskCreatedAt(
  tasks: readonly Pick<BotTask, "threadId" | "state" | "createdAt">[],
  threadId: string
): number | undefined {
  return tasks.findLast(
    (task) =>
      task.threadId === threadId && (task.state === "running" || task.state === "waiting_user")
  )?.createdAt
}

/** Inspect only the live tail, never old transcript text or hidden reasoning. */
export function botIsSpeaking(
  loading: boolean,
  messages: readonly ActivityMessage[],
  turnStart: number | null
): boolean {
  const tail = messages.at(-1)
  const started = tail?.start_at ?? tail?.created_at
  if (
    !loading ||
    turnStart == null ||
    !tail ||
    !["ai", "assistant"].includes(tail.role ?? tail.type ?? "") ||
    tail.end_at ||
    tail.tool_calls?.length ||
    !started ||
    !(new Date(started).getTime() >= turnStart)
  )
    return false
  if (typeof tail.content === "string") return /\S/.test(splitBotInlineReasoning(tail.content).body)
  return Boolean(
    tail.content?.some((block) => {
      if (!block || typeof block !== "object") return false
      const text = block as { type?: unknown; text?: unknown }
      return (
        text.type === "text" &&
        typeof text.text === "string" &&
        /\S/.test(splitBotInlineReasoning(text.text).body)
      )
    })
  )
}

/** Grok-style pending request posture, not proof of lock acquisition or execution. */
export function botAvatarMood(
  busy: boolean,
  waiting: boolean,
  messages: readonly ActivityMessage[],
  turnStart: number | null
): BotAvatarMood {
  if (waiting) return "blocked"
  if (!busy) return "idle"
  if (turnStart == null) return "work"
  const returned = new Set<string>()
  // Only the current trailing result batch and adjacent assistant; never scan older turns.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const started = message.start_at ?? message.created_at
    if (!started || !(new Date(started).getTime() >= turnStart)) return "work"
    const role = message.role ?? message.type
    if (role === "tool" && message.tool_call_id) {
      returned.add(message.tool_call_id)
      continue
    }
    if (role === "assistant" || role === "ai") {
      const pending = message.tool_calls?.find((call) => call.id && !returned.has(call.id))
      if (pending) return toolRequestMood(pending.name)
      return index === messages.length - 1 && botIsSpeaking(true, [message], turnStart)
        ? "stream"
        : "think"
    }
    return role === "user" || role === "human" ? "think" : "work"
  }
  return "work"
}

function toolRequestMood(toolName: string): BotAvatarMood {
  // Grok's activity dispatcher, mapped to the tools actually injected by CMB's Runtime.
  const name = toolName.toLowerCase()
  if (name === "read_file") return "read"
  if (name === "write_file" || name === "edit_file") return "write"
  if (name === "execute") return "run"
  if (
    ["bot_delegate", "bot_update_profile", "bot_create_teammate", "bot_update_teammate"].includes(
      name
    )
  )
    return "send"
  if (
    name === "bot_browser" ||
    name.startsWith("browser_") ||
    ["websearch", "webfetch", "web_search", "web_fetch", "search_tool"].includes(name)
  )
    return "search"
  if (["task", "task_output", "await", "checksubagent"].includes(name)) return "orbit"
  return "work"
}
