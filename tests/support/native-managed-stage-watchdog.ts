import assert from "node:assert/strict"
import type { ManagedRunSummary } from "../../src/shared/harness-board-types"

type Observation = Pick<ManagedRunSummary, "currentSession" | "lastDecision" | "status" | "updatedAt">
/** Test-only timing attribution. Reads original native sessions/decisions, never model actor labels. */
export function createNativeManagedStageWatchdog(
  nodes: readonly { id: string; skill: string }[], initialStage: string, startedAt: number,
  observeTiming?: (stage: string, stageStartedAt: number, at: number) => void
) {
  assert(nodes.every(node => typeof node.id === "string" && node.id.length > 0 &&
    typeof node.skill === "string" && node.skill.length > 0), "Fixed board nodes need explicit IDs and Skills")
  const bySkill = new Map(nodes.map(node => [node.skill, node.id]))
  assert.equal(bySkill.size, nodes.length, "Fixed board Skills must be unique for exact timing attribution")
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length, "Fixed board node IDs must be unique")
  assert(nodes.some(node => node.id === initialStage), "Initial timed stage must exist in the actual fixed board")
  const starts = new Map([[initialStage, startedAt]])
  const sessions = new Map<string, string>()
  let active = initialStage
  const time = (value: string) => {
    // Native journal stamps without offsets use the same machine's local timezone as this
    // Electron fixture. Explicit offsets (used by the standalone regression) remain intact.
    const timestamp = Date.parse(value.replace(" ", "T"))
    assert(Number.isFinite(timestamp), "Native decision must carry a valid durable timestamp")
    return timestamp
  }
  const within = (stage: string, at: number) => {
    if (observeTiming) observeTiming(stage, starts.get(stage)!, at)
    else assert(at - starts.get(stage)! < 90000, `Original native stage exceeded90s: ${stage}`)
  }
  return {
    observe(run: Observation, now: number): string {
      const thread = run.currentSession?.threadId
      if (thread && !sessions.has(thread)) {
        const decision = run.lastDecision, facts = decision?.policyResult.facts
        const stage = facts?.slashSkill && bySkill.get(facts.slashSkill)
        assert(stage && decision?.decisionAction === "start_new_thread",
          "New actual native session must have an exact original board Skill/decision")
        if (stage !== active) {
          assert(facts?.terminalOutcome === "success" &&
            ["done", "archived", "skipped"].includes(facts.currentNodeStatus),
          "A different native stage needs the previous durable successful completion")
          const transitionAt = time(decision.createTime)
          assert(transitionAt >= starts.get(active)!, "Native transition must belong to this active stage")
          within(active, transitionAt)
          // Includes native context preparation before first model IO. A repeated stage never
          // gets a fresh budget just because a new/retry session was created.
          if (!starts.has(stage)) starts.set(stage, transitionAt)
        }
        sessions.set(thread, stage)
        active = stage
      } else if (thread) active = sessions.get(thread)!
      within(active, run.status === "completed" ? time(run.updatedAt) : now)
      return active
    },
    evidence: () => ({ starts: Object.fromEntries(starts), sessions: Object.fromEntries(sessions) })
  }
}
