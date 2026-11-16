import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import type { ExecuteResponse } from "deepagents"
import ts from "typescript"
import { afterEach, expect, it, vi } from "vitest"
import {
  registerAgentRunSteerer,
  steerAgentRun,
  type AgentRunSteerRequest,
  type AgentRunSteerResult
} from "../agent/agent-run-service"
import * as queue from "../agent/current-run-message-queue"
import { LocalSandbox, type LocalSandboxOptions } from "../agent/local-sandbox"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"
import { canDeliverBotFeedback, canSteerBotTask } from "../bots/continuation"
import { LocalBotHost, type BotRunLease } from "../bots/host"
import { BotStore } from "../bots/store"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BOT_BROWSER_PROMPT_PREFIX } from "../../shared/user-input-transport"
import { AsyncKeyedLock } from "./async-keyed-lock"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function extract(file: URL, start: string, end: string): string {
  const source = readFileSync(file, "utf8")
  const from = source.indexOf(start), to = source.indexOf(end, from)
  if (from < 0 || to < from) throw new Error("Could not load the production steer function")
  return source.slice(from, to)
}

// Run the two production steer functions without starting Electron or a model.
// The actual Bot Store, queue, lease, keyed lock and command handoff run below.
function evaluate<T>(source: string, value: string, scope: Record<string, unknown>): T {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  })
  return new Function(...Object.keys(scope), outputText + "\nreturn " + value)(...Object.values(scope)) as T
}

const sharedSteerSource = extract(
  new URL("./agent.ts", import.meta.url),
  "const queueIntoOwnedRun = async", "  registerAgentRunSteerer(queueIntoOwnedRun)"
)
const botSteerSource = extract(
  new URL("../bots/runtime-adapter.ts", import.meta.url),
  "        async steer(message,", "        release() {"
)

function steeringFixture() {
  const activeRuns = new Map<string, AbortController>()
  const currentRunMessagePreparers = new Map<string, {
    runToken: string
    prepare: (input: { content: string }) => Promise<
      | { accepted: true; content: string; submissionContent: string }
      | { accepted: false; reason: "hook_blocked"; message: string }
    >
  }>()
  const steer = evaluate<(request: AgentRunSteerRequest) => Promise<AgentRunSteerResult>>(
    sharedSteerSource, "queueIntoOwnedRun", {
      ...queue, getLocalThreadRunLease, activeRuns, currentRunMessagePreparers, LocalSandbox,
      goalManager: new Map(), currentRunMessagePreparationKey: (threadId: string) => threadId,
      trackCurrentRunMessagePreparation: () => {}, currentRunMessagePreparationLocks: new AsyncKeyedLock(),
      neutralizeWorkflowPlumbingUserText: (content: string) => content
    }
  )
  registerAgentRunSteerer(steer)

  const start = (
    threadId: string, runId: string, owner: "bot" | "desktop", holdPreparation = false,
    preparation: "accept" | "reject" = "accept"
  ) => {
    const controller = new AbortController()
    const preparing = deferred<void>(), releasePreparation = deferred<void>()
    if (!holdPreparation) releasePreparation.resolve()
    claimLocalThreadRunLease({ threadId, runId, owner })
    queue.setCurrentRunMessageQueueOwner(threadId, runId)
    activeRuns.set(threadId, controller)
    currentRunMessagePreparers.set(threadId, {
      runToken: runId,
      prepare: async ({ content }) => {
        preparing.resolve()
        await releasePreparation.promise
        if (preparation === "reject")
          return { accepted: false, reason: "hook_blocked", message: "Blocked by the submit hook" }
        return { accepted: true, content, submissionContent: content }
      }
    })
    return {
      controller, preparing: preparing.promise, releasePreparation: releasePreparation.resolve,
      release() {
        releasePreparation.resolve()
        queue.clearCurrentRunMessageQueue(threadId, runId)
        releaseLocalThreadRunLease(threadId, owner, runId)
      }
    }
  }

  return { start }
}

const commandResult = { output: "DONE", exitCode: 0, truncated: false }
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  registerAgentRunSteerer(async () => ({ queued: false, reason: "run_not_ready" }))
  queue.setCurrentRunInjectionNotifier(() => {})
})

function runCommand(
  threadId: string,
  controller: AbortController,
  lifecycle: NonNullable<LocalSandboxOptions["backgroundCommandLifecycle"]>
) {
  const raw = deferred<ExecuteResponse>(), entered = deferred<void>()
  const sandbox = new LocalSandbox({
    rootDir: tmpdir(), runId: threadId, windowsSandbox: "none",
    abortSignal: controller.signal, backgroundCommandLifecycle: lifecycle
  })
  Reflect.set(sandbox, "runPreToolUseHook", async () => null)
  Reflect.set(sandbox, "runHooks", async () => null)
  Reflect.set(sandbox, "requestHumanGateForExecute", async () => ({ release() {} }))
  Reflect.set(sandbox, "executeRawUnserialized", async (
    _command: unknown, _mode: unknown, _timeout: unknown, signal: AbortSignal
  ) => {
    signal.addEventListener("abort", () => raw.resolve(commandResult), { once: true })
    entered.resolve()
    return raw.promise
  })
  const outcome = sandbox.execute("echo foreground")
  cleanups.push(async () => {
    raw.resolve(commandResult)
    await outcome
    await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
  })
  return { outcome, entered: entered.promise, finish: () => raw.resolve(commandResult) }
}

async function drain(threadId: string, runId: string) {
  const { beforeModel } = queue.createCurrentRunMessageQueueMiddleware(runId)
  const hook = typeof beforeModel === "function" ? beforeModel : beforeModel!.hook
  return hook({ messages: [] } as never, { configurable: { thread_id: threadId } } as never)
}

async function workFixture(holdPreparation = false, preparation: "accept" | "reject" = "accept") {
  const steering = steeringFixture()
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Test", color: "#123456", instructions: "", modelRef: null })
  const mainFinish = deferred<{ state: "completed" }>(), workFinish = deferred<{ state: "completed" }>()
  const mainStarted = deferred<void>()
  const workStarted = deferred<ReturnType<typeof steering.start>>()
  const steers = new Map<string, Promise<Awaited<ReturnType<NonNullable<BotRunLease["steer"]>>>>>()
  const executed: string[] = []
  const report = vi.fn()
  let originalWorkTask: string | undefined
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => {
      if (!task.workId) return { release() {}, execute: () => { mainStarted.resolve(); return mainFinish.promise } }
      if (originalWorkTask) return {
        release() {},
        execute: async () => { executed.push(task.id); return { state: "completed" } }
      }
      originalWorkTask = task.id
      const run = steering.start(task.threadId, task.id, "bot", holdPreparation, preparation)
      const steer = evaluate<NonNullable<BotRunLease["steer"]>>(
        "const runtime = {" + botSteerSource + "}", "runtime.steer", {
          task, canSteerBotTask, canDeliverBotFeedback, steerAgentRun,
          superseded: false, dismissedQuestion: false, interactionWaits: 0,
          reviewOwned: false, interruptModel: undefined, supplementalMessages: new Map(),
          getHost: () => host, getLocalThreadRunLease,
          resolveCoordinatorModeRequest: () => ({ enabled: false }), getThreadCore: () => null,
          getPendingUserInputForThread: () => null, mentionedBotContext: () => "",
          memoryUserText: (_message: unknown, accepted: string) => accepted,
          literalBotSkillMarker: (message: string) => message, BOT_BROWSER_PROMPT_PREFIX
        }
      )
      return {
        steer(...args) {
          const outcome = steer(...args)
          steers.set(args[0].id, outcome)
          return outcome
        },
        release: run.release,
        execute(signal) {
          signal.addEventListener("abort", () => run.controller.abort(), { once: true })
          host.onSteeringReady(task.id)
          workStarted.resolve(run)
          return workFinish.promise
        }
      }
    }
  }, 2, report)

  cleanups.push(async () => {
    workFinish.resolve({ state: "completed" })
    mainFinish.resolve({ state: "completed" })
    await host.stop()
    db.close()
    expect(report).not.toHaveBeenCalled()
  })
  const { work, task } = await host.createWork({ botId: bot.id, operationId: "work", title: "Report", goal: "Build the report" })
  const run = await workStarted.promise
  cleanups.push(run.releasePreparation)
  const main = await host.sendDesktopMessage({ botId: bot.id, requestId: "request", message: "Add an appendix to the report" })
  await mainStarted.promise
  host.beginInputPreparation(main.id, main.id)
  host.recordPreparedInput(main.id, main.id, main.message)

  const sendSupplement = () => host.sendWork({
    taskId: main.id, callId: "supplement", key: "supplement"
  }, work.id, "Add an appendix")
  const take = () => host.changeWorkControl({
    botId: bot.id, workId: work.id, expectedVersion: store.getWork(bot.id, work.id).version,
    operationId: "take", action: "take"
  })
  const returnControl = (confirmedTaskIds: string[]) => host.changeWorkControl({
    botId: bot.id, workId: work.id, expectedVersion: store.getWork(bot.id, work.id).version,
    operationId: "return", action: "return", confirmedTaskIds
  })
  const accepted = vi.fn(host.commandLifecycle(task.id).accepted)
  const lifecycle = { ...host.commandLifecycle(task.id), accepted }
  return { host, store, bot, work, task, run, take, returnControl, sendSupplement, steers, accepted, executed,
    command: () => runCommand(task.threadId, run.controller, lifecycle),
    finish: () => workFinish.resolve({ state: "completed" }) }
}

it.each(["take", "cancel"] as const)("keeps the command in the foreground when %s invalidates a preparing supplement", async action => {
  const fixture = await workFixture(true)
  const command = fixture.command()
  await command.entered
  const supplement = fixture.sendSupplement()
  await fixture.run.preparing
  if (action === "take") {
    expect(fixture.take().userControl).toMatchObject({ settling: true, heldInputs: 1 })
  } else {
    fixture.host.cancel(supplement.id)
  }
  fixture.run.releasePreparation()
  expect(await fixture.steers.get(supplement.id)).toBe(false)
  expect(queue.peekCurrentRunMessageQueue(fixture.task.threadId)).toEqual([])
  expect(fixture.accepted).not.toHaveBeenCalled()
  command.finish()
  expect(await command.outcome).toEqual(commandResult)
  fixture.finish()
  if (action === "take") {
    await vi.waitFor(() =>
      expect(fixture.store.getWork(fixture.bot.id, fixture.work.id).userControl?.settling).toBe(false))
    expect(fixture.store.getTask(supplement.id).state).toBe("queued")
    fixture.returnControl([supplement.id])
    await vi.waitFor(() => expect(fixture.store.getTask(supplement.id).state).toBe("completed"))
    expect(fixture.sendSupplement().id).toBe(supplement.id)
    expect(fixture.executed).toEqual([supplement.id])
  } else {
    expect(fixture.store.getTask(supplement.id).state).toBe("cancelled")
    expect(fixture.executed).toEqual([])
  }
})

it.each(["take", "cancel"] as const)("settles a submit-hook refusal only for the pending supplement after %s", async action => {
  const fixture = await workFixture(true, "reject")
  const supplement = fixture.sendSupplement()
  await fixture.run.preparing
  if (action === "take") {
    expect(fixture.take().userControl).toMatchObject({ settling: true, heldInputs: 1 })
  } else {
    fixture.host.cancel(supplement.id)
  }
  fixture.run.releasePreparation()
  await fixture.steers.get(supplement.id)
  const expectedState = action === "take" ? "failed" : "cancelled"
  await vi.waitFor(() => expect(fixture.store.getTask(supplement.id).state).toBe(expectedState))
  expect(queue.peekCurrentRunMessageQueue(fixture.task.threadId)).toEqual([])
  expect(fixture.store.getTask(fixture.task.id).state).toBe("running")
  fixture.finish()
  await vi.waitFor(() => expect(fixture.store.getTask(fixture.task.id).state).toBe("completed"))
  if (action === "take") {
    await vi.waitFor(() => expect(fixture.store.getWork(fixture.bot.id, fixture.work.id).userControl)
      .toMatchObject({ settling: false, heldInputs: 0 }))
    fixture.returnControl([])
  }
  expect(fixture.sendSupplement().id).toBe(supplement.id)
  expect(fixture.store.getTask(supplement.id).state).toBe(expectedState)
  expect(fixture.executed).toEqual([])
})

it.each([true, false])("checks an already queued work supplement again on a later command (take=%s)", async takeControl => {
  const fixture = await workFixture()
  const first = fixture.command()
  await first.entered
  const supplement = fixture.sendSupplement()
  expect(await fixture.steers.get(supplement.id)).toBe(true)
  expect((await first.outcome).exitCode).toBeNull()
  expect(fixture.accepted).toHaveBeenCalledOnce()
  if (takeControl) fixture.take()
  const second = fixture.command()
  await second.entered
  await Promise.resolve()
  if (takeControl) {
    expect(fixture.accepted).toHaveBeenCalledOnce()
    second.finish()
    expect(await second.outcome).toEqual(commandResult)
    expect(await drain(fixture.task.threadId, fixture.task.id)).toBeUndefined()
    expect(fixture.store.getTask(supplement.id).state).toBe("queued")
  } else {
    expect(fixture.accepted).toHaveBeenCalledTimes(2)
    expect((await second.outcome).exitCode).toBeNull()
    await expect(drain(fixture.task.threadId, fixture.task.id)).resolves.toMatchObject({
      messages: [{ id: supplement.requestId }]
    })
    expect(fixture.store.getTask(supplement.id)).toMatchObject({ state: "running", injectedInto: fixture.task.id })
  }
})

it("retries a confirmed injection receipt even after control changes", async () => {
  const fixture = await workFixture()
  const supplement = fixture.sendSupplement()
  expect(await fixture.steers.get(supplement.id)).toBe(true)
  const notify = vi.fn().mockRejectedValueOnce(new Error("transcript unavailable")).mockResolvedValue(undefined)
  queue.setCurrentRunInjectionNotifier(notify)
  await expect(drain(fixture.task.threadId, fixture.task.id)).rejects.toThrow("transcript unavailable")
  expect(fixture.store.getTask(supplement.id)).toMatchObject({ state: "running", injectedInto: fixture.task.id })
  expect(fixture.take().userControl).toMatchObject({ heldInputs: 0 })
  await expect(drain(fixture.task.threadId, fixture.task.id)).resolves.toMatchObject({
    messages: [{ id: supplement.requestId }]
  })
  expect(await drain(fixture.task.threadId, fixture.task.id)).toBeUndefined()
  expect(notify).toHaveBeenCalledTimes(2)
  fixture.finish()
  await vi.waitFor(() => expect(fixture.store.getTask(supplement.id).state).toBe("completed"))
  expect(fixture.executed).toEqual([])
})

it.each(["bot", "desktop"] as const)("retains the ordinary %s queue path without a dispatch check", async owner => {
  const { start } = steeringFixture()
  const threadId = "ordinary-" + owner, runId = threadId + "-run"
  const run = start(threadId, runId, owner)
  cleanups.push(run.release)
  const accepted = vi.fn()
  const first = runCommand(threadId, run.controller, { accepted, settled: vi.fn() })
  await first.entered
  const result = await steerAgentRun({
    threadId, runId, owner, message: { id: "guide", content: "Guide" }
  })
  expect(result).toEqual({ queued: true })
  if (owner === "bot") {
    expect((await first.outcome).exitCode).toBeNull()
    const second = runCommand(threadId, run.controller, { accepted, settled: vi.fn() })
    await second.entered
    expect((await second.outcome).exitCode).toBeNull()
    expect(accepted).toHaveBeenCalledTimes(2)
  } else {
    expect(accepted).not.toHaveBeenCalled()
    first.finish()
    expect(await first.outcome).toEqual(commandResult)
  }
  await expect(drain(threadId, runId)).resolves.toMatchObject({ messages: [{ id: "guide" }] })
  expect(await drain(threadId, runId)).toBeUndefined()
})
