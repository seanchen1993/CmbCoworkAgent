import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CoordinatorWorkerManager } from "./coordinator-worker-manager"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), "coordinator-restore-source-"))
  cleanup.push(() => rm(workspacePath, { recursive: true, force: true }))
  const threadId = "parent", workerId = "implementer-10000-1"
  const directory = join(workspacePath, ".cmbdevclaw/coordinator", threadId, "workers")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${workerId}.json`), JSON.stringify({
    worker_id: workerId, worker_thread_id: `${threadId}__worker__${workerId}`,
    parent_thread_id: threadId, role: "implementer", description: "original worker",
    status: "completed", turns: 1, created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z", finished_at: "2026-04-29T00:00:00.000Z",
    notification_acknowledged: false, tool_call_count: 0, summary: "completed",
    last_event: "Worker completed."
  }))
  const manager = new CoordinatorWorkerManager()
  let valid = true
  const assertCurrent = () => {
    if (!valid) throw new DOMException("Original host source retired", "AbortError")
  }
  const onUpdate = vi.fn()
  const options = { parentThreadId: threadId, workspacePath, mode: "full" as const,
    assertCurrent, onUpdate }
  // Delay actual private operations only to position the source replacement. All file parsing,
  // commit selection and notification logic remain the production manager implementation.
  const internals = manager as unknown as {
    hydrateRestoredRawText(...args: unknown[]): Promise<void>
    queuePersistWorkerState(...args: unknown[]): Promise<void>
  }
  return { manager, internals, options, onUpdate, threadId, retire: () => { valid = false } }
}

describe("coordinator restore fixed host source", () => {
  it("rejects source retirement while pending hydration and commits no staged workers", async () => {
    const f = await fixture()
    const original = f.internals.hydrateRestoredRawText.bind(f.manager)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const hydrate = vi.spyOn(f.internals, "hydrateRestoredRawText").mockImplementation(async (...args) => {
      await held
      return original(...args)
    })
    const restore = f.manager.restoreWorkersForThread(f.options)
    const settled = restore.then(() => undefined, error => error as unknown)
    let failure: unknown
    try {
      await vi.waitFor(() => expect(hydrate).toHaveBeenCalledOnce())
      f.retire()
    } finally { release(); failure = await settled }
    expect(failure).toMatchObject({ name: "AbortError" })
    expect(f.manager.readWorkers(f.threadId)).toHaveLength(0)
    expect(f.manager.drainNotifications(f.threadId)).toHaveLength(0)
    expect(f.onUpdate).not.toHaveBeenCalled()
  })

  it("does not publish a notification if the host source retires during its durable write", async () => {
    const f = await fixture()
    const original = f.internals.queuePersistWorkerState.bind(f.manager)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const persist = vi.spyOn(f.internals, "queuePersistWorkerState").mockImplementation(async (...args) => {
      await original(...args)
      await held
    })
    const restore = f.manager.restoreWorkersForThread(f.options)
    const settled = restore.then(() => undefined, error => error as unknown)
    let failure: unknown
    try {
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
      f.retire()
    } finally { release(); failure = await settled }
    expect(failure).toMatchObject({ name: "AbortError" })
    expect(f.manager.drainNotifications(f.threadId)).toHaveLength(0)
    expect(f.onUpdate).not.toHaveBeenCalled()
    // The source guard belongs to that restore, not a long-lived worker record: a later caller
    // with its own valid scope can repair the original durable notification without poisoning.
    vi.restoreAllMocks()
    const current = await f.manager.restoreWorkersForThread({ ...f.options, assertCurrent() {} })
    expect(current).toHaveLength(1)
    expect(f.manager.drainNotifications(f.threadId)).toHaveLength(1)
  })
})
