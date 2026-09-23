import { ModError } from "../errors"
import { getDb, getThreadCore, updateThread } from "../../db"
import { observeThreadTitle } from "../../db/thread-title-observer"
import {
  ThreadMutationLeaseExpiredError,
  requireThreadMutationLease,
  withThreadMutationLeaseLock
} from "../../ipc/thread-run-mutation-lock"

export interface FunctionSessionTitleUpdate {
  apply(title: string): Promise<boolean>
  close(): void
}

/** Title proposals cannot supersede a human rename or a recreated thread. */
export function prepareFunctionSessionTitle(
  threadId: string,
  assertLive: () => void,
  changed: () => void,
  signal?: AbortSignal
): FunctionSessionTitleUpdate {
  assertLive()
  const database = getDb()
  const lease = requireThreadMutationLease(threadId)
  const originalTitle = getThreadCore(threadId)!.title
  const observer = observeThreadTitle(threadId)
  return {
    async apply(value) {
      const title = value.trim()
      if (
        !observer.isCurrent() ||
        !title ||
        title.length > 512 ||
        /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
      )
        return false
      const write = withThreadMutationLeaseLock(lease, (row) => {
        signal?.throwIfAborted()
        assertLive()
        if (getDb() !== database) throw new ModError("MODS_SESSION_DATABASE_CHANGED")
        if (!observer.isCurrent() || row.title !== originalTitle || row.title === title) return false
        if (!updateThread(threadId, { title })) return false
        changed()
        return true
      }).catch((error: unknown) => {
        if (error instanceof ThreadMutationLeaseExpiredError)
          throw new ModError("MODS_SESSION_TITLE_STALE")
        throw error
      })
      if (!signal) return write
      return new Promise<boolean>((resolve, reject) => {
        const abort = () => {
          observer.close()
          reject(signal.reason)
        }
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
        // The original lock keeps its place. A cancelled waiter may later enter,
        // but its closed observer and signal prevent any mutation.
        write.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
      })
    },
    close: observer.close
  }
}
