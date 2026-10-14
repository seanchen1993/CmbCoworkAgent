import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as appDb from "../db"
import { modCallContext, getModCallContext } from "../mods/context"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import {
  functionCallAuthority,
  functionCallTurn,
  runFunctionHostCall,
  withFunctionAgentExecution
} from "../mods/v2/host-call"
import { functionExecutionScope } from "../mods/v2/execution-context"
import {
  CoordinatorWorkerManager,
  type CoordinatorWorkerRunner,
  type CoordinatorWorkerSnapshot
} from "./coordinator-worker-manager"
import {
  readCoordinatorWorkerModsContext,
  type CoordinatorWorkerModsContext
} from "./coordinator-worker-mods-context"
import { CoordinatorWorkerRestoreIndexStore } from "./coordinator-worker-restore-index"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let root = ""
const managers: CoordinatorWorkerManager[] = []
const stores: CoordinatorWorkerRestoreIndexStore[] = []
const releaseGates: Array<() => void> = []
const pending: Promise<unknown>[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cmb-worker-mods-context-"))
  paths.database = join(root, "actual.sqlite")
  await appDb.initializeDatabase()
})

afterEach(async () => {
  const failures: unknown[] = []
  const attempt = async (run: () => void | Promise<unknown>) => {
    try {
      await run()
    } catch (reason) {
      failures.push(reason)
    }
  }
  for (const release of releaseGates.splice(0)) await attempt(release)
  for (const manager of managers) await attempt(() => manager.cancelAllWorkersAndWait())
  const results = await Promise.allSettled(pending.splice(0))
  for (const result of results) if (result.status === "rejected") failures.push(result.reason)
  for (const manager of managers.splice(0)) await attempt(() => manager.clear())
  for (const store of stores.splice(0)) await attempt(() => store.waitForIdle())
  vi.restoreAllMocks()
  await attempt(() => appDb.closeDatabase())
  await attempt(() => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-worker-mods-context-")
    )
      throw Error("Only the isolated worker fixture directory may be removed")
    rmSync(root, { recursive: true, force: true })
  })
  if (failures.length) throw new AggregateError(failures, "Worker Mods fixture cleanup failed")
})

function fixture(store = new CoordinatorWorkerRestoreIndexStore()) {
  const workspace = join(root, "project")
  mkdirSync(workspace)
  const parentThreadId = randomUUID()
  const parent = appDb.createThread(parentThreadId, {
    workspacePath: workspace,
    agentMode: "coordinator"
  })
  const manager = new CoordinatorWorkerManager({ restoreIndexStore: store })
  managers.push(manager)
  stores.push(store)
  const canonical = realpathSync(workspace)
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
  const start = (runner: CoordinatorWorkerRunner, parentSignal?: AbortSignal) =>
    manager.startWorker({
      parentThreadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "read_only",
      description: "Actual worker context",
      prompt: "Inspect the fixture",
      runner,
      parentSignal
    })
  const wait = (worker: CoordinatorWorkerSnapshot) => {
    const run = manager.waitForWorkers(parentThreadId, { workerId: worker.worker_id })
    pending.push(run)
    return run
  }
  const changeMetadata = (fields: Record<string, unknown>) =>
    appDb.updateThread(parentThreadId, {
      metadata: JSON.stringify({ ...JSON.parse(parent.metadata ?? "{}"), ...fields })
    })
  return { workspace, key, parentThreadId, parent, manager, start, wait, changeMetadata }
}

function gate() {
  const held = deferred<void>()
  releaseGates.push(() => held.resolve(undefined))
  return held
}

describe("actual coordinator worker Mods attribution", () => {
  it("clears parent host-call and transport authority before the actual runner", async () => {
    const f = fixture(),
      entered = deferred<void>(),
      held = gate()
    const authorities = new ModRuntimeAuthorities()
    const parentAuthority = authorities.create({
      workspace: f.key,
      threadId: f.parentThreadId,
      turnId: "actual-parent-turn"
    })
    const identity = {
      workspace: f.key,
      threadId: f.parentThreadId,
      agentId: "main",
      turnId: "actual-parent-turn",
      callId: randomUUID(),
      origin: "model" as const,
      modId: "function:fixture",
      grantEpoch: 1
    }
    let view: CoordinatorWorkerModsContext | undefined = undefined
    const started = await withFunctionAgentExecution(
      {
        workspace: f.key,
        threadId: f.parentThreadId,
        runtimeAuthority: parentAuthority.authority,
        turnId: identity.turnId,
        userInitiated: true,
        leased: false,
        immediate: false
      },
      () =>
        modCallContext.run(
          {
            identity,
            runtimeAuthority: parentAuthority.authority,
            toolId: "start_worker",
            routeClaimed: true,
            protectedOutput: false,
            readOnly: false,
            userInitiated: true
          },
          () =>
            runFunctionHostCall({
              store: {
                settle: () => {
                  /* Boundary accounting only; no execution grant. */
                },
                blockPublication: () => {
                  /* No publication fails in this actual worker test. */
                }
              },
              identity,
              assertLive: () => parentAuthority.authority.assertLive(),
              admit: async () => {
                /* The original coordinator has already selected its worker. */
              },
              claim: () => {
                /* This observer does not create a file or process permit. */
              },
              invoke: async () =>
                f.start(async (input) => {
                  entered.resolve(undefined)
                  view = readCoordinatorWorkerModsContext(input.workerThreadId)
                  expect(view).toMatchObject({
                    workerThreadId: input.workerThreadId,
                    parentThreadId: f.parentThreadId,
                    workspace: f.key,
                    signal: input.abortSignal
                  })
                  expect(getModCallContext()).toBeUndefined()
                  expect(functionCallAuthority(f.key, input.workerThreadId)).toBeUndefined()
                  expect(functionCallTurn(f.key, input.workerThreadId)).toBeUndefined()
                  expect(functionExecutionScope(f.key, input.workerThreadId)).toMatchObject({
                    userInitiated: false,
                    leased: false,
                    immediate: false,
                    runtimeAuthority: undefined
                  })
                  await held.promise
                  view?.assertCurrent()
                  return { summary: "Real worker finished" }
                }),
              status: () => "succeeded",
              publish: async (value) => value
            })
        )
    )
    try {
      await entered.promise
      expect(readCoordinatorWorkerModsContext(started.worker_thread_id)).toBeUndefined()
      held.resolve(undefined)
      expect((await f.wait(started))[0].status).toBe("completed")
      expect(() => view?.assertCurrent()).toThrow("MODS_CALL_SCOPE_EXPIRED")
    } finally {
      parentAuthority.release()
    }
  })

  it("keeps two genuine workers isolated across awaits", async () => {
    const f = fixture(),
      held = gate()
    const entries: string[] = []
    const entered = deferred<void>()
    const runner: CoordinatorWorkerRunner = async (input) => {
      entries.push(input.workerThreadId)
      if (entries.length === 2) entered.resolve(undefined)
      const view = readCoordinatorWorkerModsContext(input.workerThreadId)
      expect(view?.parentThreadId).toBe(f.parentThreadId)
      expect(readCoordinatorWorkerModsContext("unknown-worker")).toBeUndefined()
      await held.promise
      expect(readCoordinatorWorkerModsContext(input.workerThreadId)).toBe(view)
      expect(
        readCoordinatorWorkerModsContext(entries.find((id) => id !== input.workerThreadId)!)
      ).toBeUndefined()
      return { summary: input.workerThreadId }
    }
    const first = f.start(runner),
      second = f.start(runner)
    await entered.promise
    expect(new Set(entries).size).toBe(2)
    held.resolve(undefined)
    expect((await f.wait(first))[0].status).toBe("completed")
    expect((await f.wait(second))[0].status).toBe("completed")
  })

  it("captures the original parent before awaiting actual worker state persistence", async () => {
    const store = new CoordinatorWorkerRestoreIndexStore(),
      f = fixture(store)
    const entered = deferred<void>(),
      held = gate()
    const write = store.writeWorkerState
    let first = true,
      calls = 0
    vi.spyOn(store, "writeWorkerState").mockImplementation(async (...args) => {
      if (first) {
        first = false
        entered.resolve(undefined)
        await held.promise
      }
      return Reflect.apply(write, store, args)
    })
    const started = f.start(async () => {
      calls++
      return { summary: "A replacement parent cannot admit the old worker" }
    })
    await entered.promise
    appDb.getDb().run("DELETE FROM threads WHERE thread_id = ?", [f.parentThreadId])
    appDb.createThread(f.parentThreadId, { workspacePath: f.workspace, agentMode: "coordinator" })
    appDb
      .getDb()
      .run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [
        f.parent.created_at,
        f.parentThreadId
      ])
    held.resolve(undefined)
    expect((await f.wait(started))[0]).toMatchObject({
      status: "failed",
      error: "MODS_CALL_SCOPE_CHANGED"
    })
    expect(calls).toBe(0)
  })

  it.each(["recreated", "workspace", "readonly"] as const)(
    "rechecks the actual parent %s before the first host read and after an await",
    async (change) => {
      const f = fixture()
      let rejected = 0
      const started = f.start(async (input) => {
        if (change === "recreated") {
          appDb.getDb().run("DELETE FROM threads WHERE thread_id = ?", [f.parentThreadId])
          appDb.createThread(f.parentThreadId, {
            workspacePath: f.workspace,
            agentMode: "coordinator"
          })
          appDb
            .getDb()
            .run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [
              f.parent.created_at,
              f.parentThreadId
            ])
        } else if (change === "workspace") {
          const other = join(root, "other-project")
          mkdirSync(other)
          f.changeMetadata({ workspacePath: other })
        } else f.changeMetadata({ remoteState: "historical" })
        expect(() => readCoordinatorWorkerModsContext(input.workerThreadId)).toThrow(
          "MODS_CALL_SCOPE_CHANGED"
        )
        rejected++
        await Promise.resolve()
        expect(() => readCoordinatorWorkerModsContext(input.workerThreadId)).toThrow(
          "MODS_CALL_SCOPE_CHANGED"
        )
        rejected++
        return { summary: "Changed parent rejected by both reads" }
      })
      expect((await f.wait(started))[0].status).toBe("completed")
      expect(rejected).toBe(2)
    }
  )

  it("retains the actual worker cancellation after a held await", async () => {
    const f = fixture(),
      entered = deferred<void>(),
      held = gate()
    const controller = new AbortController()
    let denied = false
    const started = f.start(async (input) => {
      const view = readCoordinatorWorkerModsContext(input.workerThreadId)
      expect(view).toBeDefined()
      entered.resolve(undefined)
      await held.promise
      expect(() => readCoordinatorWorkerModsContext(input.workerThreadId)).toThrow()
      expect(() => view?.assertCurrent()).toThrow()
      expect(input.abortSignal.aborted).toBe(true)
      denied = true
      return { summary: "Cancelled original run" }
    }, controller.signal)
    await entered.promise
    controller.abort(new DOMException("Actual parent cancelled", "AbortError"))
    held.resolve(undefined)
    expect((await f.wait(started))[0].status).toBe("cancelled")
    expect(denied).toBe(true)
  })

  it("retires the prior run before a true continuation reuses the worker ID", async () => {
    const f = fixture(),
      entered = deferred<void>(),
      held = gate()
    let previous: CoordinatorWorkerModsContext | undefined = undefined
    const started = f.start(async (input) => {
      previous = readCoordinatorWorkerModsContext(input.workerThreadId)
      entered.resolve(undefined)
      await held.promise
      expect(() => previous?.assertCurrent()).toThrow()
      return { summary: "Prior cleanup complete" }
    })
    await entered.promise
    let continued = 0
    const next = f.manager.continueWorker({
      parentThreadId: f.parentThreadId,
      workerId: started.worker_id,
      prompt: "Real replacement task",
      continuationIntent: "redirect_running_worker",
      runner: async (input) => {
        const current = readCoordinatorWorkerModsContext(input.workerThreadId)
        expect(current).toBeDefined()
        expect(current === previous).toBe(false)
        expect(input.workerThreadId).toBe(started.worker_thread_id)
        expect(() => previous?.assertCurrent()).toThrow()
        current?.assertCurrent()
        continued++
        return { summary: "Replacement completed" }
      }
    })
    pending.push(next)
    expect(continued).toBe(0)
    held.resolve(undefined)
    await next
    expect((await f.wait(started))[0].status).toBe("completed")
    expect(continued).toBe(1)
  })

  it("rejects a forgotten private record while its actual runner is still held", async () => {
    const f = fixture(),
      entered = deferred<void>(),
      held = gate(),
      exited = deferred<void>()
    let denied = false
    f.start(async (input) => {
      expect(readCoordinatorWorkerModsContext(input.workerThreadId)).toBeDefined()
      entered.resolve(undefined)
      try {
        await held.promise
        expect(() => readCoordinatorWorkerModsContext(input.workerThreadId)).toThrow()
        denied = true
        return { summary: "Forgotten run rejected" }
      } finally {
        exited.resolve(undefined)
      }
    })
    await entered.promise
    f.manager.forgetThread(f.parentThreadId)
    held.resolve(undefined)
    await exited.promise
    expect(denied).toBe(true)
    expect(f.manager.readWorkers(f.parentThreadId)).toStrictEqual([])
  })

  it("preserves the original standalone runner when AppDB cannot supply a parent", async () => {
    const f = fixture()
    await appDb.closeDatabase()
    let calls = 0
    const started = f.start(async (input) => {
      calls++
      expect(readCoordinatorWorkerModsContext(input.workerThreadId)).toBeUndefined()
      expect(functionExecutionScope(f.key, input.workerThreadId)).toBeUndefined()
      return { summary: "Original runner remains available" }
    })
    expect((await f.wait(started))[0].status).toBe("completed")
    expect(calls).toBe(1)
  })
})
