import type { ToolCallState } from "@/types"
import type { LiveStreamMessage } from "./live-stream-messages"
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

/** Inspect only the live tail, never old transcript text or hidden reasoning. */
export function botIsSpeaking(
  loading: boolean,
  messages: readonly LiveStreamMessage[],
  turnStart: number | null
): boolean {
  const tail = messages.at(-1)
  if (
    !loading ||
    turnStart == null ||
    !tail ||
    !["ai", "assistant"].includes(tail.type ?? "") ||
    tail.end_at ||
    tail.tool_calls?.length ||
    !tail.start_at ||
    new Date(tail.start_at).getTime() < turnStart
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

/** Original Runtime activity is authoritative; queued and approval-waiting work is not execution. */
export function botAvatarMood(
  busy: boolean,
  waiting: boolean,
  tools: Record<string, ToolCallState>,
  turnStart: number | null,
  speaking = false
): BotAvatarMood {
  if (waiting) return "blocked"
  if (!busy) return "idle"
  let latest: ToolCallState | undefined
  for (const tool of Object.values(tools)) {
    if (
      tool.status === "running" &&
      (turnStart == null || new Date(tool.updatedAt).getTime() >= turnStart) &&
      (!latest || new Date(tool.updatedAt).getTime() > new Date(latest.updatedAt).getTime())
    )
      latest = tool
  }
  if (!latest) return speaking ? "stream" : "think"
  // Grok's activity dispatcher, mapped to the tools actually injected by CMB's Runtime.
  const name = latest.name?.toLowerCase() ?? ""
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
