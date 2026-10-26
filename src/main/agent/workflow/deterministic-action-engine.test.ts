import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { runWorkflowEngine, type WorkflowEngineOptions } from "./engine"
import { runWorkflowScriptInSandbox } from "./sandbox"
import { validateWorkflowScript } from "./script"
import { createWorkflowRunStore, generateWorkflowRunId, sha256Hex } from "./run-store"
import type { WorkflowDeterministicActionRunner } from "./deterministic-action"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
async function fixture(body: string, runner?: WorkflowDeterministicActionRunner) {
  const workspace = await mkdtemp(join(tmpdir(), "workflow-action-engine-"))
  cleanup.push(() => rm(workspace, { recursive: true, force: true }))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", workspace)
  const script = `export const meta={name:"actions",description:"Native actions"};\n${body}`
  const now = new Date().toISOString()
  const runStore = createWorkflowRunStore({
    workspacePath: workspace,
    threadId: "thread",
    initial: {
      version: 1,
      runId: generateWorkflowRunId(),
      threadId: "thread",
      workflowName: "actions",
      script,
      scriptSha256: sha256Hex(script),
      status: "running",
      phases: [],
      currentPhase: null,
      agents: [],
      logs: [],
      journal: [],
      stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
      startedAt: now,
      updatedAt: now
    }
  })
  await runStore.whenInitialPersisted
  const controller = new AbortController()
  const model = vi.fn(async () => ({ text: "model", structured: undefined, outputTokens: 1 }))
  const run = (extra: Partial<WorkflowEngineOptions> = {}) =>
    runWorkflowEngine({
      parsed: validateWorkflowScript(script),
      runStore,
      workspacePath: workspace,
      agentProfiles: [],
      signal: controller.signal,
      emit: vi.fn(),
      actionRunner: runner,
      subagentRunner: model,
      ...extra
    })
  return { run, runStore, model, controller, workspace }
}

it("journals named resource agents and validates their original Git checkpoint before replay", async () => {
  const handle = "12345678-1234-4234-8234-123456789abc"
  const f = await fixture(`return await agent("implement", {resourceHandle:"${handle}"})`)
  const checkpoint = {
    handle,
    generation: 1,
    resourceId: "a".repeat(64),
    sourceIdentity: "b".repeat(64),
    headCommit: "c".repeat(40)
  }
  const resourceJournal = {
    capture: vi.fn(async () => checkpoint),
    validate: vi.fn(async () => {})
  }
  expect(await f.run({ resourceJournal })).toMatchObject({ status: "completed", result: "model" })
  expect(f.runStore.state.journal[0].resourceCheckpoint).toEqual(checkpoint)
  expect(await f.run({ resourceJournal })).toMatchObject({ status: "completed", result: "model" })
  expect(f.model).toHaveBeenCalledTimes(1)
  expect(resourceJournal.validate).toHaveBeenCalledWith(handle, checkpoint)
  resourceJournal.validate.mockRejectedValueOnce(Error("RESOURCE_UNKNOWN"))
  expect(await f.run({ resourceJournal })).toMatchObject({
    status: "error",
    error: "RESOURCE_UNKNOWN"
  })
  expect(f.model).toHaveBeenCalledTimes(1)
})

it("executes a deterministic node through the real sandbox and engine without a model", async () => {
  const runner = vi.fn<WorkflowDeterministicActionRunner>(async () => ({
    stepId: "compile",
    status: "succeeded",
    output: { files: 2 }
  }))
  const f = await fixture('return await action({stepId:"compile",input:{count:2}})', runner)
  const result = await f.run()
  expect(result).toMatchObject({
    status: "completed",
    result: { status: "succeeded", output: { files: 2 } },
    stats: { agentsTotal: 0, outputTokens: 0 }
  })
  expect(result.warning).toBeUndefined()
  expect(f.model).not.toHaveBeenCalled()
  expect(runner).toHaveBeenCalledWith(
    { stepId: "compile", input: { count: 2 } },
    undefined,
    expect.any(AbortSignal)
  )
  expect(f.runStore.state.journal).toEqual([])
})

it("does not finalize a fire-and-forget action until its original native work settles", async () => {
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>((resolveReady) => {
    entered = resolveReady
  })
  const f = await fixture('action({stepId:"compile"}); return "script returned"', async () => {
    entered()
    await new Promise<void>((resolveResult) => {
      finish = resolveResult
    })
    return { stepId: "compile", status: "succeeded" }
  })
  let settled = false
  const pending = f.run().then((result) => {
    settled = true
    return result
  })
  await ready
  await new Promise<void>((tick) => setImmediate(tick))
  expect(settled).toBe(false)
  expect(f.runStore.state.status).toBe("running")
  finish()
  expect(await pending).toMatchObject({ status: "completed" })
})

it("does not report parent completion when source catches an unknown action", async () => {
  const f = await fixture(
    'try { await action({stepId:"publish"}) } catch {} return "claimed success"',
    async () => {
      throw Error("CLAW_ACTION_PLATFORM_UNSETTLED")
    }
  )
  expect(await f.run()).toMatchObject({ status: "error", error: "CLAW_ACTION_PLATFORM_UNSETTLED" })
  expect(f.runStore.state.status).toBe("error")
})

it("propagates cancellation and drains late native results before publishing an aborted parent", async () => {
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>((resolveReady) => {
    entered = resolveReady
  })
  let nativeSignal!: AbortSignal
  const f = await fixture(
    'return await action({stepId:"publish"})',
    async (_input, _child, signal) => {
      nativeSignal = signal
      entered()
      await new Promise<void>((resolveResult) => {
        finish = resolveResult
      })
      return { stepId: "publish", status: "succeeded" }
    }
  )
  let settled = false
  const pending = f.run().then((result) => {
    settled = true
    return result
  })
  await ready
  f.controller.abort()
  await new Promise<void>((tick) => setImmediate(tick))
  expect(nativeSignal.aborted).toBe(true)
  expect(settled).toBe(false)
  finish()
  expect(await pending).toMatchObject({ status: "aborted" })
  expect(f.runStore.state.status).toBe("aborted")
})

it("fails closed when deterministic actions have no registered native service", async () => {
  const f = await fixture('return await action({stepId:"publish"})')
  expect(await f.run()).toMatchObject({ status: "error", error: "WORKFLOW_ACTION_UNAVAILABLE" })
  expect(f.model).not.toHaveBeenCalled()
})

it("binds child actions to the engine-resolved source location and content digest", async () => {
  const runner = vi.fn<WorkflowDeterministicActionRunner>(async () => ({
    stepId: "child-step",
    status: "succeeded"
  }))
  const f = await fixture('return await workflow({scriptPath:"child.js"})', runner)
  const source =
    'export const meta={name:"child",description:"Child"}; return await action({stepId:"child-step"})'
  await writeFile(join(f.workspace, "child.js"), source)
  expect(await f.run()).toMatchObject({ status: "completed" })
  const identity = resolve(f.workspace, "child.js")
  expect(runner.mock.calls[0][1]).toEqual({
    identity: process.platform === "win32" ? identity.toLowerCase() : identity,
    scriptSha256: sha256Hex(source)
  })
})

it("bounds a hostile action getter after await before it can reach a native handler", async () => {
  const handler = vi.fn()
  await expect(
    runWorkflowScriptInSandbox({
      body: "await Promise.resolve(); await action({get input(){while(true){}}})",
      globals: { action: handler },
      signal: new AbortController().signal,
      syncTimeoutMs: 50
    })
  ).rejects.toThrow(/synchronous execution limit/)
  expect(handler).not.toHaveBeenCalled()
})

it("copies action results and exceptions into the VM realm", async () => {
  const result = await runWorkflowScriptInSandbox({
    body: `try { await action({}) } catch(e) {
      try { return e.constructor.constructor("return process")().version } catch { return "isolated" }
    }`,
    globals: {
      action: async () => {
        throw Error("native failure")
      }
    },
    signal: new AbortController().signal,
    syncTimeoutMs: 50
  })
  expect(result.value).toBe("isolated")
})
