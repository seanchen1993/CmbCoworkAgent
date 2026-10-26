import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import type { ManagedRunSnapshot } from "../../shared/harness-board-types"

/** Executes the real private host producer/retirement functions without Electron singletons. */
function functions(file: string, names: string[], dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const declarations = source.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? "")
  )
  expect(declarations).toHaveLength(names.length)
  const code = ts.transpileModule(
    declarations.map((node) => node.getText(source).replace(/^export /, "")).join("\n"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }
  ).outputText
  return new Function(
    "deps",
    `const {${Object.keys(dependencies).join(",")}}=deps;
    ${code};return {${names.join(",")}}`
  )(dependencies) as Record<string, (...args: unknown[]) => unknown>
}

function fixture() {
  const run = {
    projectId: "project",
    featureId: "feature",
    runId: "managed-original",
    workspacePath: "C:/workspace",
    currentSession: { threadId: "stage-original" },
    decisionBaseline: { nodeId: "dev.plan" }
  } as ManagedRunSnapshot
  const thread = {
    created_at: "original-incarnation",
    metadata: JSON.stringify({
      workspacePath: run.workspacePath,
      harnessFeature: {
        projectId: run.projectId,
        slug: run.featureId,
        runId: run.runId,
        nodeId: "dev.plan"
      }
    })
  }
  const sourceTail = Promise.withResolvers<void>()
  const retire = vi.fn(async () => {})
  const release = vi.fn()
  const state = {
    incarnation: "original-incarnation",
    busy: false,
    workersRunning: false,
    workerTerminalPending: false,
    autoNotifications: false,
    resident: true,
    hasTail: true,
    sameHandle: true,
    stopped: false
  }
  const captured = {
    completion: sourceTail.promise,
    release,
    assertCurrent: () => {
      if (!state.sameHandle) throw Error("MANAGED_SESSION_RETIREMENT_SCOPE_CHANGED")
    }
  }
  const waiters = new Map<string, Set<() => void>>()
  const actual = functions("./auto-mode-controller.ts", [
    "awaitManagedRetirement", "retireManagedPredecessor", "hasPendingCoordinatorWork"
  ], {
    managedRetirementStopWaiters: waiters,
    isManagedRunStopRequested: () => state.stopped,
    getThreadCore: () => ({ ...thread, created_at: state.incarnation }),
    captureThreadIncarnation: (value: typeof thread) => value.created_at,
    matchesThreadIncarnation: (value: typeof thread, incarnation: string) =>
      value.created_at === incarnation,
    readHarnessFeatureMetadata: (value: { harnessFeature: unknown }) => value.harnessFeature,
    getModsManager: () => ({
      captureFunctionThreadRetirement: () => ({ resident: state.resident, retire })
    }),
    captureManagedAgentRunTail: () => (state.hasTail ? captured : undefined),
    managedRunStore: { getRun: () => ({ snapshot: run, corrupt: false }) },
    isSameWorkspacePath: (left: string, right: string) => left === right,
    isAgentRunBusy: () => state.busy,
    coordinatorWorkerManager: {
      hasRunningWorkersForThread: () => state.workersRunning,
      hasTerminalWorkerAwaitingNotificationForThread: () => state.workerTerminalPending,
      hasAutoRunnableNotifications: () => state.autoNotifications
    },
    workflowRunManager: { isBusyForThreadAsync: async () => false }
  })
  return {
    run,
    thread,
    sourceTail,
    retire,
    release,
    state,
    waiters,
    stop: () => {
      state.stopped = true
      for (const wake of waiters.get(run.runId) ?? []) wake()
    },
    advance: () => actual.retireManagedPredecessor(run) as Promise<void>
  }
}

it.each([false, true])("stops only the controller wait and never releases a later handle on late rejection=%s", async reject => {
  const f = fixture()
  const waiting = f.advance()
  f.stop()
  await waiting
  expect(f.retire).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
  expect(f.waiters.size).toBe(0)
  f.state.sameHandle = false
  if (reject) f.sourceTail.reject(Error("OLD_SOURCE_FAILED"))
  else f.sourceTail.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.retire).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
})

it("registers before work starts, isolates other runs and removes only its own Stop waiter", async () => {
  const waiters = new Map<string, Set<() => void>>()
  const stopped = new Set<string>()
  const actual = functions("./auto-mode-controller.ts", ["awaitManagedRetirement"], {
    managedRetirementStopWaiters: waiters,
    isManagedRunStopRequested: (run: { runId: string }) => stopped.has(run.runId)
  })
  const foreign = Promise.withResolvers<string>()
  const foreignWait = actual.awaitManagedRetirement({ runId: "other" }, () => foreign.promise)
  const blocked = Promise.withResolvers<void>()
  const original = actual.awaitManagedRetirement({ runId: "original" }, () => {
    stopped.add("original")
    for (const wake of waiters.get("original") ?? []) wake()
    return blocked.promise
  })
  expect(await original).toEqual({ stopped: true })
  expect(waiters.has("original")).toBe(false)
  expect(waiters.has("other")).toBe(true)
  const mustNotRun = vi.fn(async () => {})
  expect(await actual.awaitManagedRetirement({ runId: "original" }, mustNotRun))
    .toEqual({ stopped: true })
  expect(mustNotRun).not.toHaveBeenCalled()
  foreign.resolve("owned result")
  expect(await foreignWait).toEqual({ stopped: false, value: "owned result" })
  blocked.reject(Error("LATE_VM_FAILURE"))
  await Promise.resolve()
  expect(waiters.size).toBe(0)
})

it("awaits the captured original source tail before retiring a generated stage", async () => {
  const f = fixture()
  const completed = f.advance()
  await Promise.resolve()
  expect(f.retire).not.toHaveBeenCalled()
  f.sourceTail.resolve()
  await completed
  expect(f.retire).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
})

it.each(["workersRunning", "workerTerminalPending", "autoNotifications"] as const)(
  "does not retire or release when %s remains after the original source tail",
  async pending => {
    const f = fixture()
    const rejected = expect(f.advance()).rejects.toThrow("MANAGED_SESSION_RETIREMENT_UNCONFIRMED")
    f.state[pending] = true
    f.sourceTail.resolve()
    await rejected
    expect(f.retire).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  }
)

it.each(["workersRunning", "workerTerminalPending", "autoNotifications"] as const)(
  "rechecks %s after asynchronous VM retirement before releasing the original handle",
  async pending => {
    const f = fixture()
    f.retire.mockImplementation(async () => { f.state[pending] = true })
    const rejected = expect(f.advance()).rejects.toThrow("MANAGED_SESSION_RETIREMENT_SCOPE_CHANGED")
    f.sourceTail.resolve()
    await rejected
    expect(f.retire).toHaveBeenCalledOnce()
    expect(f.release).not.toHaveBeenCalled()
  }
)

it.each([
  "incarnation",
  "handle",
  "new-active",
  "foreign-feature",
  "foreign-node",
  "foreign-workspace"
])(
  "rejects %s changes during the exact source tail without retiring a replacement",
  async (kind) => {
    const f = fixture()
    const completed = f.advance()
    const rejected = expect(completed).rejects.toThrow(/MANAGED_SESSION_RETIREMENT_/)
    if (kind === "incarnation") f.state.incarnation = "replacement"
    if (kind === "handle") f.state.sameHandle = false
    if (kind === "new-active") f.state.busy = true
    if (kind.startsWith("foreign-")) {
      const metadata = JSON.parse(f.thread.metadata)
      if (kind === "foreign-feature") metadata.harnessFeature.slug = "another-feature"
      if (kind === "foreign-node") metadata.harnessFeature.nodeId = "another-node"
      if (kind === "foreign-workspace") metadata.workspacePath = "C:/another"
      f.thread.metadata = JSON.stringify(metadata)
    }
    f.sourceTail.resolve()
    await rejected
    expect(f.retire).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  }
)

it("does not retire a live instance without its original handle after restart", async () => {
  const f = fixture()
  f.state.hasTail = false
  await expect(f.advance()).rejects.toThrow("MANAGED_SESSION_RETIREMENT_UNCONFIRMED")
  expect(f.retire).not.toHaveBeenCalled()
  f.state.resident = false
  await f.advance()
})

it("keeps a source settlement failure and a VM cleanup failure from advancing", async () => {
  const f = fixture()
  const rejected = expect(f.advance()).rejects.toThrow("SOURCE_CHANGED")
  f.sourceTail.reject(Error("SOURCE_CHANGED"))
  await rejected
  expect(f.retire).not.toHaveBeenCalled()
  const g = fixture()
  g.retire.mockRejectedValue(Error("EXIT_UNCONFIRMED"))
  const failed = expect(g.advance()).rejects.toThrow("EXIT_UNCONFIRMED")
  g.sourceTail.resolve()
  await failed
  expect(g.release).not.toHaveBeenCalled()
})

it("uses the actual managed submission handle's physical plus source tail, never a new same-thread run", async () => {
  const physical = Promise.withResolvers<void>(),
    source = Promise.withResolvers<void>()
  const handles = new Map()
  const thread = { created_at: "original" }
  const actual = functions(
    "./auto-mode-action-executor.ts",
    ["captureManagedAgentRunTail", "startPreparedManagedAgentRun"],
    {
      managedRunHandles: handles,
      getThreadCore: () => thread,
      captureThreadIncarnation: (value: typeof thread) => value.created_at,
      matchesThreadIncarnation: (value: typeof thread, original: string) =>
        value.created_at === original,
      upsertThreadMessages: () => 1,
      startAgentRun: async () => ({
        threadId: "stage",
        completion: physical.promise,
        sourceSettlement: source.promise
      }),
      AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL: "managed-start",
      emitAppAttention: vi.fn(),
      resolveAgentStreamRequestChannel: () => "stream"
    }
  )
  await actual.startPreparedManagedAgentRun({
    request: { threadId: "stage", streamRequestId: "original" },
    message: { userMessageId: "message", displayMessage: "native stage" },
    delivery: { send: vi.fn() }
  })
  const original = actual.captureManagedAgentRunTail("stage") as {
    completion: Promise<void>
    assertCurrent(): void
    release(): void
  }
  let settled = false
  const completion = original.completion.then(() => {
    settled = true
  })
  physical.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  source.resolve()
  await completion
  original.assertCurrent()
  const replacement = { completion: new Promise<void>(() => {}), settled: false }
  handles.set("stage", replacement)
  expect(() => original.assertCurrent()).toThrow("MANAGED_SESSION_RETIREMENT_SCOPE_CHANGED")
  original.release()
  expect(handles.get("stage")).toBe(replacement)
})
