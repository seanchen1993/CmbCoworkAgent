import type { Thread } from "../types"
import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../../shared/mods/v2/resource-budgets"
import { captureThreadDirectoryIncarnation, sameThreadDirectoryIncarnation } from "./thread-directory-mutation-scope"

interface PendingRead {
  threadId: string
  account: number
  original: ReturnType<typeof captureThreadDirectoryIncarnation>
  absent: boolean
  hardRevoked: boolean
  transitioned: boolean
}

/** Local pending display publishers only. This never owns or releases physical
 * Main IPC credit and conveys no execution/read admission. Closed records leave
 * no tombstones; deletion revokes existing records irreversibly until close.
 */
export class ThreadDirectoryReadPublishers {
  private readonly records = new Map<object, PendingRead>()
  private readonly byId = new Map<string, Set<object>>()

  begin(threadId: string, account: number, thread: Thread | undefined): object | undefined {
    if (this.records.size >= FUNCTION_MOD_RESOURCE_BUDGETS.rendererThreadSummaryRead.pending)
      return undefined
    const original = captureThreadDirectoryIncarnation(thread)
    if (thread && !original) return undefined
    const ticket = Object.freeze({})
    this.records.set(ticket, { threadId, account, original, absent: !thread,
      hardRevoked: false, transitioned: false })
    const group = this.byId.get(threadId) ?? new Set<object>()
    group.add(ticket)
    this.byId.set(threadId, group)
    return ticket
  }

  current(ticket: object): boolean { return this.records.get(ticket)?.hardRevoked === false }

  observe(ticket: object, account: number, thread: Thread | undefined): void {
    const read = this.records.get(ticket)
    if (!read || read.hardRevoked) return
    if (account !== read.account) { read.hardRevoked = true; return }
    if (read.absent !== !thread ||
      (!read.absent && !sameThreadDirectoryIncarnation(read.original,
        captureThreadDirectoryIncarnation(thread)))) read.transitioned = true
  }

  canPublish(ticket: object, account: number, current: Thread | undefined, returned: Thread): boolean {
    this.observe(ticket, account, current)
    const read = this.records.get(ticket)
    const returnedScope = captureThreadDirectoryIncarnation(returned)
    if (!read || read.hardRevoked || returned.thread_id !== read.threadId || !returnedScope) return false
    // Actual-current host facts remain useful after directory enrichment or the
    // first legacy token promotion. They never override deletion/account revoke.
    if (sameThreadDirectoryIncarnation(returnedScope, captureThreadDirectoryIncarnation(current))) return true
    if (read.transitioned) return false
    if (read.absent) return current === undefined
    return sameThreadDirectoryIncarnation(read.original, captureThreadDirectoryIncarnation(current))
  }

  revoke(threadId: string): void {
    for (const ticket of this.byId.get(threadId) ?? []) {
      const read = this.records.get(ticket)
      if (read) read.hardRevoked = true
    }
  }

  close(ticket: object): void {
    const read = this.records.get(ticket)
    if (!read) return
    this.records.delete(ticket)
    const group = this.byId.get(read.threadId)
    group?.delete(ticket)
    if (group?.size === 0) this.byId.delete(read.threadId)
  }
}
