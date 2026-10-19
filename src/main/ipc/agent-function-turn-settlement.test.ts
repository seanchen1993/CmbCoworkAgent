import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { settleAgentFunctionTurn } from "../agent/agent-run-service"
import { runSettlementPhases } from "../agent/run-settlement-fence"

// Run the actual IPC settlement body without booting the unrelated Electron IPC registry.
const source = ts.createSourceFile(
  "agent.ts",
  readFileSync(new URL("./agent.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)
const declaration = source.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "settlePhysicalAgentRun"
)
if (!declaration) throw Error("Actual physical settlement helper is missing")
const javascript = ts.transpile(declaration.getText(source), { target: ts.ScriptTarget.ES2022 })

function fixture(settlement: Promise<void>) {
  const release = vi.fn(),
    publish = vi.fn(),
    maintenance = vi.fn(),
    complete = vi.fn()
  const invalidate = vi.fn(),
    capture = vi.fn(() => ({ settlement, invalidate }))
  const register = vi.fn()
  const manager = {
    functionTurns: { captureSettlementOwner: capture, finish: complete, suspend: vi.fn() },
    finishTurn: vi.fn(),
    releaseExpiredRuntimeBindings: vi.fn()
  }
  const globals = {
    getModsManager: () => manager,
    getThreadCore: () => ({ id: "thread", createdAt: "original" }),
    captureThreadIncarnation: () => "original",
    matchesThreadIncarnation: () => true,
    physicalRunHasSuccessor: () => false,
    runSettlementPhases,
    settleAgentFunctionTurn,
    agentRunExecutionContextStorage: {
      getStore: () => ({ onFunctionTurnSettlement: register })
    },
    flushPendingStreamTranscriptMessages: vi.fn(),
    discardStreamTranscriptToolCallAccumulators: vi.fn(),
    invalidateCurrentRunMessagePreparer: vi.fn(),
    activeRuns: new Map(),
    activeRunSettled: new Map(),
    clearCurrentRunMessageQueue: vi.fn(),
    revokeSandboxAclsForRun: vi.fn(),
    notifyAgentRunSettled: vi.fn(),
    shouldDisposeTurnState: () => false,
    discardAgentAutoCommitTracking: vi.fn(),
    releaseLocalThreadRunLease: release,
    publishDevelopmentTurnSettlement: publish,
    runPostRunMaintenanceInBackground: maintenance,
    RUN_SETTLEMENT_NOTIFICATION_TIMEOUT_MS: 1000
  }
  const execute = new Function(
    ...Object.keys(globals),
    `${javascript}; return settlePhysicalAgentRun`
  )(...Object.values(globals)) as (options: Record<string, unknown>) => Promise<void>
  const options = {
    functionTurnReason: "answer",
    kind: "invoke",
    threadId: "thread",
    runToken: "exact-run",
    controller: new AbortController(),
    settledPromise: Promise.resolve(),
    resolveSettlement: vi.fn(),
    removeWindowListener: vi.fn(),
    settleNotifications: async () => {},
    cleanupNotificationSkills: vi.fn(),
    turnStateShouldDispose: false,
    disposeTurnState: vi.fn()
  }
  return {
    execute,
    options,
    release,
    publish,
    maintenance,
    complete,
    capture,
    register,
    invalidate
  }
}

it("joins actual logical completion only after the original physical lease release", async () => {
  const held = Promise.withResolvers<void>(),
    f = fixture(held.promise)
  const pending = f.execute(f.options)
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  expect(f.capture).toHaveBeenCalledExactlyOnceWith("thread", "exact-run")
  expect(f.complete).toHaveBeenCalledExactlyOnceWith("thread", "exact-run", { reason: "answer" })
  expect(f.publish).not.toHaveBeenCalled()
  held.resolve()
  await pending
  expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }))
  expect(f.maintenance).toHaveBeenCalledOnce()
})

it("keeps original development failure publication and maintenance before propagating revoked authority", async () => {
  const held = Promise.withResolvers<void>(),
    f = fixture(held.promise)
  const pending = f.execute(f.options)
  void pending.catch(() => {})
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  held.reject(new Error("MODS_GRANT_REVOKED"))
  await expect(pending).rejects.toThrow("Function turn settlement could not confirm")
  expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }))
  expect(f.maintenance).toHaveBeenCalledOnce()
})

it("hands the exact observer to the external source owner without waiting or releasing its lease", async () => {
  const held = Promise.withResolvers<void>(),
    f = fixture(held.promise)
  await f.execute({ ...f.options, releaseRunLease: false })
  expect(f.release).not.toHaveBeenCalled()
  expect(f.capture).toHaveBeenCalledExactlyOnceWith("thread", "exact-run")
  expect(f.register).toHaveBeenCalledExactlyOnceWith(held.promise, f.invalidate)
  expect(f.complete).toHaveBeenCalledOnce()
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.maintenance).toHaveBeenCalledOnce()
  held.resolve()
})
