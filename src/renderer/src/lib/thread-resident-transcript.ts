import {
  parseThreadTranscriptSourceScope,
  type ThreadTranscriptSourceScope
} from "../../../shared/thread-transcript-source-scope"

/** Explicit host source rejection is an invalidation, never an empty transcript
 * or admission proof. Match Electron's whole error envelope, not arbitrary text.
 */
export function isInvalidTranscriptSourceError(error: unknown,
  channel: "threads:messages-page" | "threads:bootstrap-legacy-checkpoint-transcript"
): boolean {
  if (!(error instanceof Error)) return false
  const code = "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"
  return error.message === code ||
    error.message === `Error invoking remote method '${channel}': Error: ${code}`
}

export function sameTranscriptIncarnation(
  first: ThreadTranscriptSourceScope | undefined,
  second: ThreadTranscriptSourceScope | undefined
): boolean {
  return !!first && !!second && first.threadId === second.threadId &&
    first.incarnation.token === second.incarnation.token &&
    first.incarnation.legacyCreatedAt === second.incarnation.legacyCreatedAt
}

/** Actual directory rows, including ordinary chats with no workspace. Never an admission proof. */
export function rendererTranscriptSourceScope(thread: {
  thread_id: string; created_at: Date; metadata?: Record<string, unknown>
} | null | undefined): ThreadTranscriptSourceScope | undefined {
  if (!thread) return undefined
  const createdAt = thread.created_at instanceof Date ? thread.created_at.getTime() :
    typeof thread.created_at === "string" ? Date.parse(thread.created_at) : NaN
  const token = thread.metadata?.cmb_thread_incarnation
  const workspacePath = thread.metadata?.workspacePath
  return parseThreadTranscriptSourceScope({ threadId: thread.thread_id,
    incarnation: { token: typeof token === "string" && token ? token : null,
      legacyCreatedAt: createdAt },
    ...(typeof workspacePath === "string" && workspacePath ? { workspacePath } : {}) })
}

export interface ResidentTranscript {
  scope: ThreadTranscriptSourceScope | undefined
  pageAccepted: boolean
  dirty: number
  completed: number
}

/** Only initialized residents occupy this registry. Versions are local invalidations,
 * never durable transcript sequence numbers. A captured record is also its owner token.
 */
export class ThreadResidentTranscripts {
  private readonly residents = new Map<string, ResidentTranscript>()

  enter(threadId: string, scope: ThreadTranscriptSourceScope | undefined): ResidentTranscript {
    const resident = { scope, pageAccepted: false, dirty: 0, completed: 0 }
    this.residents.set(threadId, resident)
    return resident
  }

  get(threadId: string): ResidentTranscript | undefined { return this.residents.get(threadId) }
  forget(threadId: string): void { this.residents.delete(threadId) }

  capture(threadId: string, generation: () => number | undefined): () => boolean {
    const owner = this.residents.get(threadId)
    const originalGeneration = generation()
    return () => !!owner && this.residents.get(threadId) === owner && generation() === originalGeneration
  }

  /** One continuation of an empty legacy initial page in the same hydration.
   * The caller creates this only for the existing shouldBootstrap branch; it
   * cannot authorize another page, another owner, or a later hydration.
   */
  captureLegacyBootstrap(threadId: string, generation: () => number | undefined): () => boolean {
    const current = this.capture(threadId, generation)
    let pending = true
    return () => {
      if (!pending || !current()) return false
      pending = false
      return true
    }
  }

  invalidate(threadId?: string): void {
    if (threadId !== undefined) {
      const resident = this.residents.get(threadId)
      if (resident) resident.dirty++
    } else {
      for (const resident of this.residents.values()) resident.dirty++
    }
  }

  complete(threadId: string, owner: ResidentTranscript, version: number): void {
    if (this.residents.get(threadId) === owner) owner.completed = Math.max(owner.completed, version)
  }

  /** A legacy page may seed an empty resident once, but cannot incrementally merge
   * into retained history. Its caller resets locally and starts one fresh hydration.
   */
  acceptPage(threadId: string, source: unknown, fresh: boolean): boolean {
    const resident = this.residents.get(threadId)
    if (!resident) return false
    const scope = parseThreadTranscriptSourceScope(source)
    if (!scope) {
      if (!fresh || resident.pageAccepted) return false
    } else {
      if (scope.threadId !== threadId ||
        (resident.scope && !sameTranscriptIncarnation(resident.scope, scope)) ||
        (!resident.scope && resident.pageAccepted)) return false
      resident.scope = scope
    }
    resident.pageAccepted = true
    return true
  }
}
