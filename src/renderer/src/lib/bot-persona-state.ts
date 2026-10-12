import type { BotRun } from "../../../shared/bot-types"
import type { AgentAvatarProps } from "../components/bots/upstream/grok-agent-avatar"

export function botPersonaState(
  run?: Pick<BotRun, "status" | "waitingForBot" | "activity" | "output" | "hasOutput">
): AgentAvatarProps["state"] {
  if (!run) return "idle"
  if (run.waitingForBot) return "orbit"
  switch (run.status) {
    case "running":
      if (run.activity?.kind === "thinking" && (run.hasOutput ?? !!run.output)) return "writing"
      if (run.activity?.kind === "thinking" || run.activity?.kind === "memory") return "thinking"
      if (run.activity?.kind === "browser") return "searching"
      if (run.activity?.kind === "file") return "writing"
      if (run.activity?.kind === "collaboration") return "sending"
      return "working"
    case "queued":
      return "thinking"
    case "waiting_input":
      return "listening"
    case "needs_review":
      return "alerting"
    case "cancelling":
      return "powering-down"
    case "failed":
      return "confused"
    case "succeeded":
      return "happy"
    default:
      return "idle"
  }
}
