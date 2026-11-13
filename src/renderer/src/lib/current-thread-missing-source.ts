import {
  parseThreadTranscriptSourceScope,
  type ThreadTranscriptSourceScope
} from "../../../shared/thread-transcript-source-scope"
import { sameTranscriptIncarnation } from "./thread-resident-transcript"

/** One selected source explicitly rejected by the host. Directory observations
 * may restart hydration, but never provide message/read admission themselves.
 */
export class CurrentThreadMissingSource {
  private pending: {
    scope: ThreadTranscriptSourceScope
    account: number
    sawAbsent: boolean
  } | undefined

  get threadId(): string | undefined { return this.pending?.scope.threadId }

  remember(threadId: string, source: ThreadTranscriptSourceScope | undefined,
    account: number): void {
    const scope = parseThreadTranscriptSourceScope(source)
    this.pending = scope?.threadId === threadId ? { scope, account, sawAbsent: false } : undefined
  }

  clear(threadId?: string): void {
    if (threadId === undefined || this.threadId === threadId) this.pending = undefined
  }

  observe(input: {
    currentThreadId: string | null
    account: number
    retired: boolean
    rowPresent: boolean
    scope: ThreadTranscriptSourceScope | undefined
  }): ThreadTranscriptSourceScope | undefined {
    const pending = this.pending
    if (!pending) return undefined
    if (input.currentThreadId !== pending.scope.threadId || input.account !== pending.account ||
      input.retired) {
      this.pending = undefined
      return undefined
    }
    if (!input.rowPresent) {
      pending.sawAbsent = true
      return undefined
    }
    const actual = input.scope
    if (!actual || actual.threadId !== pending.scope.threadId ||
      (!pending.sawAbsent && sameTranscriptIncarnation(pending.scope, actual))) return undefined
    this.pending = undefined // Consume before any initialization or synchronous store notification.
    return actual
  }
}
