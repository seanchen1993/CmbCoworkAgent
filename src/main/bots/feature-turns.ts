import type { FeatureOwner } from "./feature-store"

/** A linked thread may later be run by the desktop. Only the particular Bot submission owns this signal. */
export class BotFeatureTurns {
  private readonly turns = new Map<
    string,
    {
      followId: string
      botId: string
      bindingId?: string
      operationId: string
      phase: "running" | "question" | "approval"
      controller: AbortController
    }
  >()

  begin(owner: FeatureOwner, threadId: string, operationId: string, bindingId?: string) {
    if (this.turns.has(threadId)) throw new Error("此项目会话仍在执行上一轮交办")
    const controller = new AbortController()
    const entry = {
      followId: owner.id,
      botId: owner.botId,
      bindingId,
      operationId,
      controller,
      phase: "running" as const
    }
    this.turns.set(threadId, entry)
    return {
      signal: controller.signal,
      release: () => {
        if (this.turns.get(threadId) === entry) this.turns.delete(threadId)
        controller.abort()
      }
    }
  }
  operation(threadId: string) {
    return this.turns.get(threadId)?.operationId
  }
  phase(threadId: string) {
    return this.turns.get(threadId)?.phase
  }
  setPhase(threadId: string, operationId: string, phase: "running" | "question" | "approval") {
    const turn = this.turns.get(threadId)
    if (turn?.operationId === operationId) turn.phase = phase
  }
  activity(followId: string) {
    let primary: { phase: "running" | "question" | "approval"; threadId: string } | undefined
    for (const [threadId, turn] of this.turns) {
      if (turn.followId !== followId) continue
      if (!primary || primary.phase === "running" || turn.phase === "question")
        primary = { phase: turn.phase, threadId }
      if (primary.phase === "question") break
    }
    return primary
  }
  interrupt(followId: string, threadId: string): boolean {
    const turn = this.turns.get(threadId)
    if (turn?.followId !== followId || turn.controller.signal.aborted) return false
    turn.controller.abort()
    return true
  }
  cancel(botId?: string, bindingId?: string) {
    for (const turn of this.turns.values())
      if ((!botId || turn.botId === botId) && (!bindingId || turn.bindingId === bindingId))
        turn.controller.abort()
  }
  cancelFollow(followId: string) {
    for (const turn of this.turns.values())
      if (turn.followId === followId) turn.controller.abort()
  }
}
