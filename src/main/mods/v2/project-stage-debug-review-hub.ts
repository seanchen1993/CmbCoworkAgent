import { randomUUID } from "node:crypto"
import type { StageDebugReviewIntent } from "../../../shared/mods/v2/project-stage-debug-review"
import type { NativeStageDebugReviewRequest } from "./platform-project-stage-debug-provider"

/** Ephemeral navigation ledger. A queued intent cannot create or execute a branch. */
export class ProjectStageDebugReviewHub {
  private readonly requests = new Map<string, StageDebugReviewIntent>()
  constructor(
    private readonly publish: (intent: StageDebugReviewIntent) => boolean,
    /** A fresh native source/creator check, independent of the completed guest invocation. */
    private readonly assertFresh: (intent: StageDebugReviewIntent) => Promise<void>
  ) {}

  async request(input: NativeStageDebugReviewRequest): Promise<{ requested: boolean; queued: boolean }> {
    input.assertCurrent()
    this.prune()
    const intent: StageDebugReviewIntent = {
      id: randomUUID(), threadId: input.scope.threadId, workspace: input.scope.workspace,
      incarnation: structuredClone(input.scope.incarnation), snapshotId: input.preparation.snapshotId,
      draftId: input.draftId, revision: input.revision,
      candidateDigest: input.preparation.candidateDigest, mode: input.preparation.mode,
      caller: { name: input.context.caller.name, digest: input.context.caller.digest },
      expiresAt: Date.now() + 5 * 60 * 1000
    }
    if (this.requests.size >= 32 && !this.requests.has(intent.threadId))
      throw Error("PROJECT_STAGE_DEBUG_REVIEW_LIMIT")
    input.assertCurrent()
    this.requests.set(intent.threadId, intent)
    let queued = false
    try { queued = this.publish(structuredClone(intent)) }
    catch { /* The original view may be closed. A later trusted read can still find the intent. */ }
    try { input.assertCurrent() }
    catch (error) {
      if (this.requests.get(intent.threadId) === intent) this.requests.delete(intent.threadId)
      throw error
    }
    return { requested: true, queued }
  }

  /** Trusted IPC caller supplies the current creator binding; never accepts a guest scope. */
  async current(threadId: string, workspace: string, incarnation: StageDebugReviewIntent["incarnation"]): Promise<StageDebugReviewIntent | undefined> {
    this.prune()
    const found = this.requests.get(threadId)
    if (!found) return undefined
    if (found.workspace !== workspace ||
      JSON.stringify(found.incarnation) !== JSON.stringify(incarnation)) return undefined
    try { await this.assertFresh(structuredClone(found)) }
    catch {
      if (this.requests.get(threadId) === found) this.requests.delete(threadId)
      return undefined
    }
    if (this.requests.get(threadId) !== found || found.expiresAt <= Date.now()) return undefined
    return structuredClone(found)
  }

  private prune() {
    for (const [key, found] of this.requests)
      if (found.expiresAt <= Date.now()) this.requests.delete(key)
  }
  close() { this.requests.clear() }
}
