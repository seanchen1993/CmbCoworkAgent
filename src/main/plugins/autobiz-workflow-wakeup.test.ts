import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createContext, Script } from "node:vm"
import ts from "typescript"
import { expect, it } from "vitest"
import { transformAutobizWorkflowWakeup, AUTOBIZ_WORKFLOW_TARGET_SHA256 } from "../../../scripts/prepare-autobiz-workflow-wakeup-source"
import { createHash } from "node:crypto"

const workflow = resolve("output/deliveries/mods-creator-accepted-20261017/Mods来源/AutoBiz/workflows/code-batched-execution.workflow.js")

function sourceFunctions(source: string, names: string[]) {
  const parsed = ts.createSourceFile("original-workflow.js", source, ts.ScriptTarget.ESNext, true)
  return names.map(name => {
    const node = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name)
    if (!node) throw Error(`Original function missing: ${name}`)
    return source.slice(node.getStart(parsed), node.end)
  }).join("\n")
}

/** Algorithm regression only: exact original functions, explicit virtual timers, no business IO. */
interface PoolOptions {
  maxParallel?: number; failBatch?: string; refreshFails?: boolean; fatalCapacity?: boolean
  staggered?: boolean; jobs?: string[]; releaseOrder?: string[]
}
async function observeDefaultPool(source: string, extra: string[] = [], options: PoolOptions = {}) {
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const releases = new Map<string, () => void>()
  const requestedJobs = options.jobs ?? ["B001", "B002"]
  const jobs = [...requestedJobs]
  let current = 0, timerId = 0, settled = false, capacityCalls = 0
  const started: string[] = [], unresolved: unknown[] = [], states = new Set<{
    active: number; closed: boolean; revision: number; waiters: Set<() => void>
  }>()
  const context = createContext({
    Set, Promise, Math, Array, Number, Error,
    maxParallel: options.maxParallel ?? 5, timeoutPerBatch: 600, schedulerCycles: 0,
    DISPATCH_POLL_INTERVAL_MS: 30 * 60 * 1000,
    lastScheduler: { activeWorkers: 0, retryPendingBatches: [], readyBatches: jobs },
    schedulerFallbackConsumed: new Set(),
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId; timers.set(id, { callback, delay }); return id
    },
    clearTimeout: (id: number) => { timers.delete(id) },
    phase: () => {}, isValidBatchId: () => true, errorText: String,
    recordUnresolved: (row: unknown) => unresolved.push(row),
    pendingRetriesOf: () => [], canStartLifecycle: () => true,
    dispatchOccupiedSlots: (_state: unknown, dispatcher: { active: number }) => {
      if (options.fatalCapacity && ++capacityCalls === 3) throw Error("ORIGINAL_CANCELLED")
      return dispatcher.active
    },
    takeNextRunnableLifecycle: () => {
      const batchId = jobs.shift()
      return batchId ? { batchId, source: "original", execute: () => {}, fallback: () => {} } : null
    },
    runLifecycleSafely: async (batchId: string) => {
      current++
      started.push(batchId)
      await new Promise<void>(done => releases.set(batchId, done))
      current--
      if (options.failBatch === batchId) throw Error("ORIGINAL_LIFECYCLE_REJECTED")
    },
    refreshSchedulerForDispatch: async () => {
      context.lastScheduler = { activeWorkers: current, retryPendingBatches: [], readyBatches: jobs }
      return options.refreshFails ? null : context.lastScheduler
    },
    dispatchHasPotentialWork: () => current > 0 || jobs.length > 0,
    parallel: async (callbacks: Array<() => Promise<void>>) => Promise.all(callbacks.map(fn => fn()))
  })
  new Script(sourceFunctions(source, [...extra, "runDispatchWorker", "drainRunnableLifecycles"]) +
    `\nglobalThis.drainForFixture = drainRunnableLifecycles;
${extra.length ? `const waitForFixture = waitForDispatcherChange;
waitForDispatcherChange = (state, revision) => { observeState(state); return waitForFixture(state, revision); };` : ""}`)
    .runInContext(context)
  context.observeState = (state: Parameters<typeof states.add>[0]) => states.add(state)
  const drain = (context.drainForFixture as (label: string) => Promise<unknown>)("fixture")
    .then(value => { settled = true; return value })
  for (let tick = 0; tick < 20; tick++) await Promise.resolve()
  expect([...releases.keys()].sort()).toEqual(options.maxParallel === 1 ? ["B001"] : ["B001", "B002"])
  const before = [...timers.values()].map(timer => timer.delay)
  if (options.staggered) {
    for (const batchId of options.releaseOrder ?? requestedJobs) {
      expect(releases.has(batchId), `Original worker slot must admit ${batchId} before prior wave fully finishes`).toBe(true)
      releases.get(batchId)!()
      for (let tick = 0; tick < 80; tick++) await Promise.resolve()
      expect(unresolved).toEqual([])
    }
  } else {
    for (const release of releases.values()) release()
    for (let tick = 0; tick < 80; tick++) await Promise.resolve()
  }
  if (options.maxParallel === 1 && !options.staggered) {
    expect(releases.has("B002")).toBe(true)
    releases.get("B002")!()
    for (let tick = 0; tick < 80; tick++) await Promise.resolve()
  }
  return { before, settled, remaining: [...timers.values()].map(timer => timer.delay), drain,
    started, unresolved, states: [...states], context }
}

it("reproduces the original default-five-workers/two-Batches 30-minute wait without advancing time", async () => {
  const result = await observeDefaultPool(readFileSync(workflow, "utf8"))
  expect(result.before).toEqual([1800000, 1800000, 1800000])
  expect(result.settled).toBe(false)
  expect(result.remaining).toEqual([1800000, 1800000, 1800000])
  // Intentionally pending original drain proves the defect. Virtual timers own no native handles.
})

const cases: Array<[string, PoolOptions]> = [
  ["default five/two", {}], ["one capacity", { maxParallel: 1 }],
  ["default five/two staggered completions", { staggered: true }],
  ["two slots and multiple staggered waves", { maxParallel: 2, staggered: true,
    jobs: ["B001", "B002", "B003", "B004"], releaseOrder: ["B001", "B003", "B002", "B004"] }],
  ["lifecycle failure", { failBatch: "B001" }],
  ["failed refresh", { refreshFails: true }],
  ["failure plus failed refresh", { failBatch: "B001", refreshFails: true }],
  ["cancelled dispatcher", { fatalCapacity: true }]
]
it.each(cases)("wakes and drains original workers for %s without replay or timer leaks", async (_name, options) => {
  const source = await transformAutobizWorkflowWakeup(Buffer.from(readFileSync(workflow)))
  expect(createHash("sha256").update(source).digest("hex")).toBe(AUTOBIZ_WORKFLOW_TARGET_SHA256)
  const result = await observeDefaultPool(source.toString("utf8"),
    ["notifyDispatcherChange", "waitForDispatcherChange"], options)
  expect(result.settled).toBe(true)
  expect(result.remaining).toEqual([])
  expect(result.started.sort()).toEqual(options.jobs ?? ["B001", "B002"])
  expect(result.states.every(state => state.closed && state.waiters.size === 0)).toBe(true)
  if (options.fatalCapacity) expect(result.unresolved).toEqual([
    expect.objectContaining({ status: "parallel_execution_failed" })
  ])
  else if (options.failBatch) expect(result.unresolved).toEqual([
    expect.objectContaining({ status: "dispatch_worker_failed", batchId: "B001" })
  ])
  else expect(result.unresolved).toEqual([])
  await result.drain
})

it("cannot lose a completion just before waiter registration and retains the 30-minute external fallback", async () => {
  const source = (await transformAutobizWorkflowWakeup(Buffer.from(readFileSync(workflow)))).toString("utf8")
  const timers = new Map<number, () => void>()
  let nextId = 0
  const context = createContext({ Set, Array, Promise, DISPATCH_POLL_INTERVAL_MS: 1800000,
    setTimeout: (callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(1800000)
      const id = ++nextId; timers.set(id, callback); return id
    }, clearTimeout: (id: number) => timers.delete(id) })
  new Script(sourceFunctions(source, ["notifyDispatcherChange", "waitForDispatcherChange"]) +
    "\nglobalThis.notify = notifyDispatcherChange; globalThis.wait = waitForDispatcherChange;").runInContext(context)
  const state = { revision: 0, closed: false, waiters: new Set<() => void>() }
  const observed = state.revision
  context.notify(state)
  expect(await context.wait(state, observed)).toBe("progress")
  expect(timers.size).toBe(0)
  const pending = context.wait(state, state.revision)
  expect(state.waiters.size).toBe(1)
  expect(timers.size).toBe(1)
  for (const timer of timers.values()) timer()
  expect(await pending).toBe("fallback")
  expect(timers.size).toBe(0)
  expect(state.waiters.size).toBe(0)
  state.closed = true
  expect(await context.wait(state, state.revision)).toBe("closed")
  expect(timers.size).toBe(0)
})

it("does not claim a new lifecycle after a peer closes the drain during pending-retry refresh", async () => {
  const source = (await transformAutobizWorkflowWakeup(Buffer.from(readFileSync(workflow)))).toString("utf8")
  let release!: (value: unknown) => void
  const blocked = new Promise(done => { release = done })
  let refreshes = 0, claims = 0, starts = 0, settled = false
  const unresolved: unknown[] = []
  const snapshot = { activeWorkers: 0, retryPendingBatches: ["B001"], readyBatches: ["B001"] }
  const context = createContext({ Set, Promise, Array, Math, Number, Error,
    maxParallel: 2, timeoutPerBatch: 600, schedulerCycles: 0, lastScheduler: snapshot,
    DISPATCH_POLL_INTERVAL_MS: 1800000, schedulerFallbackConsumed: new Set(),
    phase: () => {}, isValidBatchId: () => true, errorText: String,
    recordUnresolved: (row: unknown) => unresolved.push(row),
    refreshSchedulerForDispatch: () => ++refreshes === 1 ? blocked : Promise.resolve(snapshot),
    dispatchOccupiedSlots: () => { throw Error("PEER_CANCELLED") },
    takeNextRunnableLifecycle: () => { claims++; return { batchId: "B001" } },
    canStartLifecycle: () => true, runLifecycleSafely: () => { starts++ },
    dispatchHasPotentialWork: () => true,
    parallel: (callbacks: Array<() => Promise<void>>) => Promise.all(callbacks.map(fn => fn())),
    setTimeout: () => { throw Error("No fallback wait expected") }, clearTimeout: () => {}
  })
  new Script(sourceFunctions(source, ["notifyDispatcherChange", "waitForDispatcherChange",
    "runDispatchWorker", "drainRunnableLifecycles"]) +
    "\nglobalThis.drain = drainRunnableLifecycles;").runInContext(context)
  const drain = context.drain("retry-close").then(() => { settled = true })
  for (let tick = 0; tick < 30; tick++) await Promise.resolve()
  expect(settled).toBe(false)
  expect(claims).toBe(0)
  release({ ...snapshot, retryPendingBatches: [] })
  await drain
  expect(claims).toBe(0)
  expect(starts).toBe(0)
  expect(unresolved).toEqual([expect.objectContaining({ status: "parallel_execution_failed" })])
})

it("still spends the original idle timeout budget only on actual fallback timer expiry", async () => {
  const source = (await transformAutobizWorkflowWakeup(Buffer.from(readFileSync(workflow)))).toString("utf8")
  const timers = new Map<number, () => void>(), unresolved: unknown[] = []
  let next = 0, finished = false
  const state = { active: 0, ranAny: false, runningBatchIds: new Set(), revision: 0,
    waiters: new Set(), closed: false, refreshFailed: false }
  const snapshot = { activeWorkers: 1, retryPendingBatches: [] }
  const context = createContext({ Set, Promise, Math, Array, Number, Error,
    maxParallel: 5, timeoutPerBatch: 600, schedulerCycles: 0, lastScheduler: snapshot,
    DISPATCH_POLL_INTERVAL_MS: 1800000, isValidBatchId: () => true,
    dispatchOccupiedSlots: () => 1, takeNextRunnableLifecycle: () => null,
    dispatchHasPotentialWork: () => true, refreshSchedulerForDispatch: async () => snapshot,
    recordUnresolved: (row: unknown) => unresolved.push(row),
    setTimeout: (callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(1800000); const id = ++next; timers.set(id, callback); return id
    }, clearTimeout: (id: number) => timers.delete(id) })
  new Script(sourceFunctions(source, ["notifyDispatcherChange", "waitForDispatcherChange", "runDispatchWorker"]) +
    "\nglobalThis.worker = runDispatchWorker;").runInContext(context)
  const worker = context.worker(1, new Set(), "external", state).then(() => { finished = true })
  for (let count = 0; count < 2; count++) {
    for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    expect(finished).toBe(false)
    expect(timers.size).toBe(1)
    const [id, timer] = [...timers.entries()][0]
    timers.delete(id); timer()
  }
  await worker
  expect(unresolved).toEqual([expect.objectContaining({ status: "dispatcher_idle_timeout" })])
  expect(timers.size).toBe(0)
  expect(state.waiters.size).toBe(0)
})
