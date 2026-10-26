import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { runSettlementPhases } from "../agent/run-settlement-fence"
import {
  confirmRunCancellationSettlement,
  createRunCancellationSettlement,
  invalidateRunCancellationSettlement,
  markRunCancellationEffectDispatched,
  recordRunCancellation,
  settledRunCancellationTerminal
} from "../agent/run-cancellation-settlement"

// Execute the actual physical finally function. Do not replace it with a model of its ordering.
const source = ts.createSourceFile(
  "agent.ts",
  readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const original = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "settlePhysicalAgentRun"
)!
if (!original) throw Error("Original physical settlement is missing")
const code = ts.transpile(original.getText(source), { target: ts.ScriptTarget.ES2022 })

function fixture(
  options: {
    phaseFailure?: boolean
    functionFailure?: boolean
    successor?: boolean
    missingOwner?: boolean
    unknown?: number
    running?: number
  } = {}
) {
  const controller = new AbortController()
  controller.abort()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const counts = {
    not_started: 0,
    succeeded: 0,
    failed: 0,
    running: options.running ?? 0,
    unknown: options.unknown ?? 0
  }
  const summary = vi.fn(() => counts)
  const noop = () => {}
  const dependencies = {
    ownsPhysicalStreamRunLease: () => true,
    getModsManager: () => ({
      functionTurns: {
        captureSettlementOwner: () =>
          options.missingOwner
            ? undefined
            : {
                workspace: "original-workspace",
                turnId: "original-turn",
                settlement: release.promise
              },
        finish: noop,
        suspend: noop
      },
      store: { turnSummary: summary },
      finishTurn: noop,
      releaseExpiredRuntimeBindings: noop
    }),
    agentRunExecutionContextStorage: { getStore: () => undefined },
    getThreadCore: () => undefined,
    captureThreadIncarnation: noop,
    physicalRunHasSuccessor: () => Boolean(options.successor),
    runSettlementPhases,
    flushPendingStreamTranscriptMessages: noop,
    discardStreamTranscriptToolCallAccumulators: noop,
    invalidateCurrentRunMessagePreparer: noop,
    activeRuns: new Map([["thread", controller]]),
    clearCurrentRunMessageQueue: noop,
    revokeSandboxAclsForRun: noop,
    activeRunSettled: new Map(),
    notifyAgentRunSettled: noop,
    shouldDisposeTurnState: () => true,
    discardAgentAutoCommitTracking: noop,
    releaseLocalThreadRunLease: noop,
    settleAgentFunctionTurn: async (promise: Promise<void> | undefined) => {
      entered.resolve()
      await promise
      if (options.functionFailure) throw Error("original Function owner lost")
    },
    matchesThreadIncarnation: () => false,
    publishDevelopmentTurnSettlement: noop,
    runPostRunMaintenanceInBackground: noop,
    RUN_SETTLEMENT_NOTIFICATION_TIMEOUT_MS: 1,
    confirmRunCancellationSettlement,
    invalidateRunCancellationSettlement,
    console: { warn: noop }
  }
  const invoke = new Function(
    ...Object.keys(dependencies),
    `${code};return settlePhysicalAgentRun`
  )(...Object.values(dependencies)) as (input: Record<string, unknown>) => Promise<void>
  const run = () =>
    invoke({
      kind: "invoke",
      threadId: "thread",
      runToken: "original-run",
      controller,
      settledPromise: Promise.resolve(),
      resolveSettlement: noop,
      removeWindowListener: noop,
      settleNotifications: async () => {},
      cleanupNotificationSkills: () => {
        if (options.phaseFailure) throw Error("cleanup incomplete")
      },
      turnStateShouldDispose: true,
      disposeTurnState: noop
    })
  return { run, entered: entered.promise, release: release.resolve, summary }
}

it("only publishes the default cancelled classification after original physical/Function settlement", async () => {
  const f = fixture()
  const scope = createRunCancellationSettlement()
  const pending = scope.run(async () => {
    recordRunCancellation()
    await f.run()
    return settledRunCancellationTerminal()
  })
  await f.entered
  expect(scope.read().confirmed).toBe(false)
  f.release()
  await expect(pending).resolves.toEqual({
    outcome: "error",
    code: "cancelled_before_effect_dispatch"
  })
  expect(f.summary).toHaveBeenCalledWith("original-workspace", "thread", "original-turn")
})

it.each([
  { phaseFailure: true },
  { functionFailure: true },
  { successor: true },
  { missingOwner: true },
  { unknown: 1 },
  { running: 1 }
])("original physical boundary refuses incomplete evidence %j", async (options) => {
  const f = fixture(options)
  const scope = createRunCancellationSettlement()
  const pending = scope.run(async () => {
    recordRunCancellation()
    await f.run()
  })
  // Observe rejection before releasing the actual barrier.
  const observed = pending.catch(() => {})
  await f.entered
  f.release()
  await observed
  expect(scope.read().confirmed).toBe(false)
})

it("a completed tool still vetoes cancellation even when the original ledger has no unknown rows", async () => {
  const f = fixture()
  const scope = createRunCancellationSettlement()
  const pending = scope.run(async () => {
    markRunCancellationEffectDispatched()
    recordRunCancellation()
    await f.run()
  })
  await f.entered
  f.release()
  await pending
  expect(scope.read().confirmed).toBe(false)
})
