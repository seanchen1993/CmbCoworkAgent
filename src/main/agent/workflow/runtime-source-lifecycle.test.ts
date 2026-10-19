import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { AIMessage } from "@langchain/core/messages"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => {}, on: () => {} }
}))
vi.mock("../../services/subagent-session-capture", () => ({
  withSubagentSessionCapture: (_context: unknown, _label: string, run: () => Promise<unknown>) => run(),
  subagentSessionCallbacks: () => []
}))
vi.mock("../../services/adoption-tracker", () => ({ setAdoptionContext: vi.fn() }))

import { workflowRunManager, deferOwnedRuntimeWorkflowSettlement } from "./run-manager"
import { validateWorkflowScript } from "./script"
import { loadWorkflowRun } from "./run-store"
import { currentRuntimePluginSource, issueRuntimePluginSourceToken, withRuntimePluginSource } from "../../plugins/runtime-source-scope"
import { registerAgentRunAdmission } from "../agent-run-admission"
import { registerAgentRunImplementation, startAgentRun } from "../agent-run-service"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-source-owner-"))
  const previous = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
  cleanup.push(() => {
    if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = previous
    rmSync(root, { recursive: true, force: true })
  })
  const threadId = randomUUID()
  const token = issueRuntimePluginSourceToken({
    mode: "legacy", threadId, incarnationKey: "exact-incarnation", projectId: "project",
    operationId: randomUUID(), workspace: root, packageDigest: "a".repeat(64), stageId: "code",
    plugin: { id: randomUUID(), name: "retained", version: "1", path: root,
      description: "", author: "", enabled: true, skillCount: 1, mcpServerCount: 1,
      hookCount: 0, createdAt: "", updatedAt: "" }
  })
  return { root, threadId, token }
}

it.each([false, true])("finishes the parent stream while its exact-token child remains physically active (child fails=%s)", async fail => {
  const f = fixture()
  const started = deferred(), release = deferred(), finalized = deferred()
  const cleanupEntered = deferred(), cleanupReleased = deferred()
  cleanup.push(async () => { release.resolve(); cleanupReleased.resolve(); await workflowRunManager.cancelAndWait(f.threadId) })
  let childCleaned = false
  let finalFailure: unknown
  let finalCalls = 0
  let runId = ""
  const script = 'export const meta = {name:"source owner",description:"physical lifetime"}\nreturn await agent("task")'
  const finish = vi.fn()
  cleanup.push(registerAgentRunAdmission(async (_request, context) => ({
    context: { ...context, pluginSourceSnapshot: f.token },
    settle: async () => {
      const finalize = async (failure?: unknown) => {
        expect(childCleaned).toBe(true)
        expect(loadWorkflowRun(f.root, f.threadId, runId)?.completedAt).toBeTruthy()
        finalCalls++
        finalFailure = failure
        cleanupEntered.resolve()
        await cleanupReleased.promise
        finalized.resolve()
      }
      expect(deferOwnedRuntimeWorkflowSettlement(f.token, finalize)).toEqual({ deferred: true })
      // Returning here is the production admission contract; no waiting for the child.
    }
  })))
  registerAgentRunImplementation(async () => {
    await workflowRunManager.prepareLaunch(f.root, f.threadId)
    runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const launch = workflowRunManager.launch({
      threadId: f.threadId, workspacePath: f.root, runId,
      parsed: validateWorkflowScript(script), script, scriptSha256: "b".repeat(64),
      subagentDeps: {
        parentThreadId: f.threadId, isRetryableApiError: () => false,
        cleanupThread: async () => {},
        createRuntime: async () => ({
          stream: async () => (async function* () {
            started.resolve()
            try {
              await release.promise
              if (fail) throw Error("actual-child-failed")
              yield ["values", { messages: [new AIMessage("physical done")] }]
            } finally { childCleaned = true }
          })()
        })
      }
    })
    await launch.whenInitialPersisted
    await started.promise
  })
  const delivery = { window: {} as import("electron").BrowserWindow,
    send: vi.fn(), isAvailable: () => true, finish }
  const parent = await startAgentRun({ threadId: f.threadId, message: "launch" }, delivery)
  await parent.completion
  expect(finish).toHaveBeenCalledWith(f.threadId)
  expect(finalCalls).toBe(0)
  expect(workflowRunManager.activeRunId(f.threadId)).toBe(runId)
  const unrelated = withRuntimePluginSource(f.token, () => issueRuntimePluginSourceToken({ ...currentRuntimePluginSource()! }))
  expect(deferOwnedRuntimeWorkflowSettlement(unrelated, async () => { throw Error("wrong owner") })).toEqual({ deferred: false, failure: undefined })
  release.resolve()
  await cleanupEntered.promise
  expect(workflowRunManager.activeRunId(f.threadId)).toBe(runId)
  let physicalSettled = false
  const waiter = workflowRunManager.waitForRunLifecycle(f.threadId, runId).then(() => { physicalSettled = true })
  let cancellationSettled = false
  const cancellation = workflowRunManager.cancelAndWait(f.threadId).then(() => { cancellationSettled = true })
  await new Promise<void>(done => setImmediate(done))
  expect(physicalSettled).toBe(false)
  expect(cancellationSettled).toBe(false)
  cleanupReleased.resolve()
  await finalized.promise
  await Promise.all([waiter, cancellation])
  expect(finalCalls).toBe(1)
  if (fail) expect(finalFailure).toBeInstanceOf(AggregateError)
  else expect(finalFailure).toBeUndefined()
  // No active owner means future notification turns cannot inherit this cleanup transaction.
  const retired = deferOwnedRuntimeWorkflowSettlement(f.token, async () => { throw Error("replayed") })
  assertRetired(retired, fail)
})

it("joins multiple original physical owners once without waiting on their own finalization", async () => {
  const f = fixture()
  const gates = [deferred(), deferred()]
  const entered = [deferred(), deferred()]
  const cleaned = [deferred(), deferred()]
  const closeEntered = deferred(), closeReleased = deferred()
  const owners = [randomUUID(), randomUUID()]
  const runs = ["wf_" + randomUUID().slice(0, 8), "wf_" + randomUUID().slice(0, 8)]
  cleanup.push(async () => {
    for (const gate of gates) gate.resolve()
    closeReleased.resolve()
    await Promise.all(owners.map(owner => workflowRunManager.cancelAndWait(owner)))
  })
  const script = 'export const meta={name:"parallel owners",description:"exact source"}\nreturn await agent("task")'
  await workflowRunManager.prepareLaunch(f.root, owners[0])
  await workflowRunManager.prepareLaunch(f.root, owners[1])
  const launches = owners.map((threadId, index) => withRuntimePluginSource(f.token, () =>
    workflowRunManager.launch({
      threadId, workspacePath: f.root, runId: runs[index], script,
      parsed: validateWorkflowScript(script), scriptSha256: "c".repeat(64),
      subagentDeps: { parentThreadId: threadId, isRetryableApiError: () => false,
        cleanupThread: async () => {}, createRuntime: async () => ({
          stream: async () => (async function* () {
            entered[index].resolve()
            try {
              await gates[index].promise
              yield ["values", { messages: [new AIMessage("done")] }]
            } finally { cleaned[index].resolve() }
          })()
        }) }
    })))
  await Promise.all(launches.map(launch => launch.whenInitialPersisted))
  await Promise.all(entered.map(gate => gate.promise))
  let calls = 0
  expect(deferOwnedRuntimeWorkflowSettlement(f.token, async failure => {
    expect(failure).toBeUndefined()
    calls++
    closeEntered.resolve()
    await closeReleased.promise
  })).toEqual({ deferred: true })
  gates[0].resolve()
  await cleaned[0].promise
  await new Promise<void>(done => setImmediate(done))
  expect(calls).toBe(0)
  gates[1].resolve()
  await closeEntered.promise
  expect(calls).toBe(1)
  for (let i = 0; i < owners.length; i++) expect(workflowRunManager.activeRunId(owners[i])).toBe(runs[i])
  const waiters = owners.map((owner, index) => workflowRunManager.waitForRunLifecycle(owner, runs[index]))
  closeReleased.resolve()
  await Promise.all(waiters)
  for (const owner of owners) expect(workflowRunManager.activeRunId(owner)).toBeUndefined()
})

function assertRetired(result: ReturnType<typeof deferOwnedRuntimeWorkflowSettlement>, failed: boolean) {
  expect(result.deferred).toBe(false)
  if (result.deferred) throw Error("Unexpected live owner")
  if (failed) expect(result.failure).toBeInstanceOf(Error)
  else expect(result.failure).toBeUndefined()
}

it.each([false, true])("retains exact-token fast physical failure until the later parent settlement (fail=%s)", async fail => {
  const f = fixture()
  const runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const script = 'export const meta={name:"fast child",description:"settled before parent"}\nreturn await agent("task")'
  cleanup.push(() => workflowRunManager.cancelAndWait(f.threadId))
  await workflowRunManager.prepareLaunch(f.root, f.threadId)
  const launch = withRuntimePluginSource(f.token, () => workflowRunManager.launch({
    threadId: f.threadId, workspacePath: f.root, runId, script,
    parsed: validateWorkflowScript(script), scriptSha256: "d".repeat(64),
    subagentDeps: { parentThreadId: f.threadId, isRetryableApiError: () => false,
      cleanupThread: async () => {}, createRuntime: async () => ({
        stream: async () => (async function* () {
          if (fail) throw Error("fast original child failure")
          yield ["values", { messages: [new AIMessage("fast original success")] }]
        })()
      }) }
  }))
  await launch.whenInitialPersisted
  await workflowRunManager.waitForRunLifecycle(f.threadId, runId)
  expect(workflowRunManager.activeRunId(f.threadId)).toBeUndefined()
  const finalize = vi.fn(async (failure?: unknown) => {
    if (fail) expect(failure).toBeInstanceOf(Error)
    else expect(failure).toBeUndefined()
  })
  for (let index = 0; index < 2; index++) {
    const result = deferOwnedRuntimeWorkflowSettlement(f.token, finalize)
    assertRetired(result, fail)
    if (result.deferred) throw Error("Retired workflow cannot be deferred")
    await finalize(result.failure)
  }
  expect(finalize).toHaveBeenCalledTimes(2)
  const otherToken = withRuntimePluginSource(f.token, () => issueRuntimePluginSourceToken({ ...currentRuntimePluginSource()! }))
  assertRetired(deferOwnedRuntimeWorkflowSettlement(otherToken, finalize), false)
})

it("keeps an actual asynchronous source cleanup rejection sticky after its physical owner retires", async () => {
  const f = fixture()
  const started = deferred(), release = deferred()
  const runId = "wf_" + randomUUID().replaceAll("-", "").slice(0, 12)
  cleanup.push(async () => { release.resolve(); await workflowRunManager.cancelAndWait(f.threadId) })
  const script = 'export const meta={name:"cleanup rejection",description:"original finalizer"}\nreturn await agent("task")'
  await workflowRunManager.prepareLaunch(f.root, f.threadId)
  const launch = withRuntimePluginSource(f.token, () => workflowRunManager.launch({
    threadId: f.threadId, workspacePath: f.root, runId, script,
    parsed: validateWorkflowScript(script), scriptSha256: "e".repeat(64),
    subagentDeps: { parentThreadId: f.threadId, isRetryableApiError: () => false,
      cleanupThread: async () => {}, createRuntime: async () => ({
        stream: async () => (async function* () {
          started.resolve()
          await release.promise
          yield ["values", { messages: [new AIMessage("physical business succeeded")] }]
        })()
      }) }
  }))
  await launch.whenInitialPersisted
  await started.promise
  expect(deferOwnedRuntimeWorkflowSettlement(f.token, async () => {
    await new Promise<void>(done => setImmediate(done))
    throw Error("private-close-detail-must-not-be-latched")
  })).toEqual({ deferred: true })
  const failure = expect(workflowRunManager.waitForRunLifecycle(f.threadId, runId))
    .rejects.toThrow("WORKFLOW_SOURCE_CLEANUP_UNCONFIRMED")
  release.resolve()
  await failure
  expect(workflowRunManager.activeRunId(f.threadId)).toBeUndefined()
  for (let index = 0; index < 2; index++) {
    const result = deferOwnedRuntimeWorkflowSettlement(f.token, async () => { throw Error("must not replay") })
    assertRetired(result, true)
    if (result.deferred) throw Error("Original owner is already retired")
    expect(result.failure?.message).toBe("WORKFLOW_SOURCE_CLEANUP_UNCONFIRMED")
  }
})
