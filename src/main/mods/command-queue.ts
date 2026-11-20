import { randomUUID } from "node:crypto"
import type { ModCommandJob, ModProjection } from "../../shared/mods/types"
import {
  claimLocalThreadRunLease,
  releaseLocalThreadRunLease,
  onLocalThreadRunLeaseReleased
} from "../agent/thread-run-lease"
import { ModError, modErrorCode } from "./errors"

export interface ModJobStore {
  saveJob(job: ModCommandJob): void
  jobs(threadId: string): ModCommandJob[]
}
interface Pending {
  job: ModCommandJob
  controller: AbortController
  run: (signal: AbortSignal) => Promise<ModProjection>
  resolve: (value: ModProjection) => void
  reject: (error: unknown) => void
  completion: Promise<ModProjection>
}

/** Commands share the same physical thread lease as desktop, IM and scheduled runs. */
export class ModCommandQueue {
  private readonly pending = new Map<string, Pending>()
  private readonly unsubscribe: () => void
  private closed = false
  constructor(
    private readonly store: ModJobStore,
    private readonly notify: (threadId: string) => void
  ) {
    this.unsubscribe = onLocalThreadRunLeaseReleased((lease) => this.pump(lease.threadId))
  }

  enqueue(
    workspace: string,
    threadId: string,
    command: string,
    run: Pending["run"]
  ): { job: ModCommandJob; completion: Promise<ModProjection> } {
    if (this.closed) throw new ModError("MODS_QUEUE_CLOSED")
    if (
      this.pending.size >= 32 ||
      [...this.pending.values()].filter((item) => item.job.threadId === threadId).length >= 8
    )
      throw new ModError("MODS_QUEUE_LIMIT")
    const job: ModCommandJob = {
      id: randomUUID(),
      threadId,
      workspace,
      command,
      state: "queued",
      createdAt: Date.now()
    }
    let resolve!: Pending["resolve"]
    let reject!: Pending["reject"]
    const completion = new Promise<ModProjection>((yes, no) => {
      resolve = yes
      reject = no
    })
    void completion.catch(() => {})
    this.store.saveJob(job)
    this.pending.set(job.id, {
      job,
      run,
      resolve,
      reject,
      completion,
      controller: new AbortController()
    })
    this.notify(threadId)
    queueMicrotask(() => this.pump(threadId))
    return { job: { ...job }, completion }
  }

  private pump(threadId: string): void {
    if (this.closed) return
    const item = [...this.pending.values()].find(
      (entry) => entry.job.threadId === threadId && entry.job.state === "queued"
    )
    if (!item) return
    const lease = claimLocalThreadRunLease({ threadId, owner: "mods", runId: item.job.id })
    if (!lease.acquired) return
    item.job.state = "running"
    try {
      this.store.saveJob(item.job)
    } catch (error) {
      this.pending.delete(item.job.id)
      item.reject(error)
      releaseLocalThreadRunLease(threadId, "mods", item.job.id)
      return
    }
    this.notify(threadId)
    const timer = setTimeout(() => item.controller.abort(), 120_000)
    timer.unref()
    void (async () => {
      try {
        const result = await item.run(item.controller.signal)
        if (item.controller.signal.aborted) throw new ModError("MODS_CANCELLED")
        item.job.result = result
        item.job.state = "succeeded"
        item.job.finishedAt = Date.now()
        this.store.saveJob(item.job)
        item.resolve(result)
      } catch (error) {
        // Once execution began, cancellation cannot prove an external side effect did not happen.
        item.job.state = item.controller.signal.aborted ? "unknown" : "failed"
        item.job.error = modErrorCode(error)
        item.job.finishedAt = Date.now()
        delete item.job.result
        try {
          this.store.saveJob(item.job)
        } catch {
          /* Retain persisted running => unknown on restart. */
        }
        item.reject(error)
      } finally {
        clearTimeout(timer)
        this.pending.delete(item.job.id)
        releaseLocalThreadRunLease(threadId, "mods", item.job.id)
        this.notify(threadId)
      }
    })()
  }

  cancel(threadId: string, id: string): void {
    const item = this.pending.get(id)
    if (!item || item.job.threadId !== threadId) throw new ModError("MODS_JOB_UNAVAILABLE")
    item.controller.abort()
    if (item.job.state === "queued") {
      item.job.state = "cancelled"
      item.job.finishedAt = Date.now()
      this.store.saveJob(item.job)
      this.pending.delete(id)
      item.reject(new ModError("MODS_CANCELLED"))
      this.notify(threadId)
    }
  }

  close(): void {
    this.closed = true
    this.unsubscribe()
    for (const item of this.pending.values()) this.cancel(item.job.threadId, item.job.id)
  }
}
