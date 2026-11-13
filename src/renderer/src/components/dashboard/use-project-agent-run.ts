import { useCallback, useState } from "react"
import type { ProjectAgentRunEvent, ProjectAgentStep } from "../../../../shared/project-agent-run"

type Outcome = "running" | "completed" | "failed" | "cancelled"
export interface ProjectAgentRunState {
  steps: ProjectAgentStep[]
  text: string
  startedAt: number
  finishedAt?: number
  outcome: Outcome
}
const empty = (): ProjectAgentRunState => ({
  steps: [],
  text: "",
  startedAt: 0,
  outcome: "completed"
})
export function useProjectAgentRun() {
  const [state, setState] = useState<ProjectAgentRunState>(empty)
  const begin = useCallback(
    () => setState({ ...empty(), startedAt: Date.now(), outcome: "running" }),
    []
  )
  const receive = useCallback(
    (event: ProjectAgentRunEvent) =>
      setState((current) => {
        if (current.outcome !== "running") return current
        if (event.type === "text")
          return { ...current, text: event.reset ? event.text : current.text + event.text }
        const index = current.steps.findIndex((step) => step.id === event.step.id)
        const steps = [...current.steps]
        if (index >= 0) steps[index] = event.step
        else if (steps.length < 180) steps.push(event.step)
        return { ...current, steps }
      }),
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
