import { useCallback, useState } from "react"
import type { ProjectAgentRunEvent, ProjectAgentStep } from "../../../../shared/project-agent-run"

type Outcome = "running" | "completed" | "failed" | "cancelled"
export interface ProjectAgentRunState {
  steps: ProjectAgentStep[]
  text: string
  replies: Record<string, string>
  startedAt: number
  finishedAt?: number
  outcome: Outcome
  historyTruncated?: boolean
}
const empty = (): ProjectAgentRunState => ({
  steps: [],
  text: "",
  replies: {},
  startedAt: 0,
  outcome: "completed"
})
export function receiveProjectAgentEvent(
  current: ProjectAgentRunState,
  event: ProjectAgentRunEvent
): ProjectAgentRunState {
  if (current.outcome !== "running" || event.type === "report-checkpoint") return current
  if (event.type === "text") {
    const replies = current.steps.some((step) => step.id === event.stepId)
      ? {
          ...current.replies,
          [event.stepId]: event.reset
            ? event.text
            : (current.replies[event.stepId] ?? "") + event.text
        }
      : current.replies
    return {
      ...current,
      replies,
      text:
        event.answer === false ? current.text : event.reset ? event.text : current.text + event.text
    }
  }
  const index = current.steps.findIndex((step) => step.id === event.step.id)
  const steps = [...current.steps]
  if (index >= 0) steps[index] = event.step
  else steps.push(event.step)
  // Keep the latest activity visible during long retry/review runs, without retaining every reply.
  const removed = steps.splice(0, Math.max(0, steps.length - 180))
  let replies = current.replies
  if (removed.length) {
    replies = { ...replies }
    for (const step of removed) delete replies[step.id]
  }
  return {
    ...current,
    steps,
    replies,
    historyTruncated: current.historyTruncated || removed.length > 0
  }
}
export function useProjectAgentRun() {
  const [state, setState] = useState<ProjectAgentRunState>(empty)
  const begin = useCallback(
    () => setState({ ...empty(), startedAt: Date.now(), outcome: "running" }),
    []
  )
  const receive = useCallback(
    (event: ProjectAgentRunEvent) =>
      setState((current) => receiveProjectAgentEvent(current, event)),
    []
  )
  const end = useCallback(
    (outcome: Exclude<Outcome, "running">) =>
      setState((current) => ({
        ...current,
        outcome,
        finishedAt: Date.now(),
        text: outcome === "completed" ? "" : current.text,
        steps: current.steps.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: outcome === "cancelled" ? "cancelled" : "failed",
                elapsedMs: Date.now() - step.startedAt,
                detail: outcome === "cancelled" ? "已停止" : "此步骤未完成"
              }
            : step
        )
      })),
    []
  )
  const clear = useCallback(() => setState(empty()), [])
  return { state, begin, receive, end, clear }
}
