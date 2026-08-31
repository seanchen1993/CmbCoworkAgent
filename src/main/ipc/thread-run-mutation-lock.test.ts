import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

const dbState = vi.hoisted(() => ({
  row: null as { thread_id: string; created_at: number; metadata: string | null } | null
}))

vi.mock("../db", () => ({
  getThreadCore: () => dbState.row
}))

import {
  requireThreadMutationLease,
  withThreadMutationLeaseLock,
  withThreadRunMutationLock
} from "./thread-run-mutation-lock"

describe("thread mutation incarnation lease", () => {
  it("rejects a queued old request after a same-ms same-id replacement", async () => {
    dbState.row = {
      thread_id: "fixed-id",
      created_at: 123,
      metadata: JSON.stringify({ cmb_thread_incarnation: "old-token" })
    }
    const lease = requireThreadMutationLease("fixed-id")

    let acquired!: () => void
    let release!: () => void
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = withThreadRunMutationLock("fixed-id", async () => {
      acquired()
      await releasePromise
    })
    await acquiredPromise

    let committed = false
    const queued = withThreadMutationLeaseLock(lease, () => {
      committed = true
    })
    dbState.row = {
      thread_id: "fixed-id",
      created_at: 123,
      metadata: JSON.stringify({ cmb_thread_incarnation: "replacement-token" })
    }
    release()
    await holder

    await expect(queued).rejects.toThrow(/Thread changed while the request was queued/)
    expect(committed).toBe(false)
  })

  it("routes every source-sensitive queued thread operation through the lease helper", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./threads.ts", import.meta.url)),
      "utf8"
    )

    for (const pattern of [
      /export async function forkThread[\s\S]{0,700}requireThreadMutationLease[\s\S]{0,500}withThreadMutationLeaseLock/,
      /async function listForkableCheckpoints[\s\S]{0,500}requireThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/,
      /export async function resolveForkCheckpointForMessage[\s\S]{0,700}requireThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/,
      /"threads:appendMessages"[\s\S]{0,500}captureThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/,
      /"threads:replaceMessageId"[\s\S]{0,700}requireThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/,
      /"threads:update"[\s\S]{0,700}requireThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/,
      /"threads:mergeThreadValues"[\s\S]{0,500}requireThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/,
      /"threads:persistSubagentTranscripts"[\s\S]{0,500}requireThreadMutationLease[\s\S]{0,300}withThreadMutationLeaseLock/
    ]) {
      expect(source).toMatch(pattern)
    }
  })
})
