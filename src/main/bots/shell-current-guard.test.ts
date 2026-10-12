import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotDomainError } from "../../shared/bot-types"
import { unwrapBotIpcResult } from "../../shared/bot-ipc-result"
import { botIpcFailure, serializeBotFailure } from "./error-diagnostic"
import { BotStore } from "./store"
import { BotShellJobs } from "./shell-jobs"
import { BotShellServices } from "./shell-services"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { BotOwnedShellUnknown } from "./owned-shell-process"
import { BotShellMaintenanceBlocked } from "./owned-shell-maintenance-fence"
import { BotProjectFiles } from "./project-files"
import { withBotProjectMutation } from "./project-lock"
import { assertBotShellCurrent } from "./shell-current-guard"
import type { BotShellRequest } from "./shell-contract"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-shell-current-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const privateRoot = join(directory, "owner")
  mkdirSync(privateRoot, { mode: 0o700 })
  const store = new BotStore(join(privateRoot, "bots.sqlite"))
  cleanup.push(() => store.close())
  store.bindLeaseGuard("host", () => {})
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Builder" })
  store.send({ nonce: "message", conversationId, text: "Build" })
  const parent = store.claim("host", 60000)!
  const controller = new AbortController()
  const request = { ...parent, bot, store, messages: [], signal: controller.signal }
  const input: BotShellRequest = {
    command: "echo must-not-replay",
    cwd: directory,
    runId: parent.run.id,
    timeoutMs: 1000,
    execution: { windowsSandbox: "none", resourceDirectory: directory }
  }
  function reserve(service = false) {
    const action = { shell: { command: input.command, keepAlive: service } }
    const approval = store.requestInteraction(parent.lease, {
      kind: "approval",
      prompt: "Build",
      action
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    return store.toolOnce(parent.lease, "cmd", action, () => {
      store.beginEffect(parent.lease, { id: "effect:cmd", action, approvalId: approval.id })
      const jobId = store.shellJobs.reserve(parent.lease, "cmd", "effect:cmd", input.command)
      return {
        jobId,
        service: service ? store.shellServices.attach(parent.lease, jobId, 60000) : undefined
      }
    })
  }
  return { directory, privateRoot, store, parent, request, input, reserve }
}

it("cancels a pre-start job guard and releases the project fence without a late launch", async () => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>()
  const execute = vi.fn(async () => {
    throw new Error("unexpected launch")
  })
  const runner = await createTrustedBotShellTestRunner(cleanup)
  vi.spyOn(runner, "execute").mockImplementation(execute)
  const manager = new BotShellJobs(f.request, runner)
  const { jobId } = f.reserve()
  manager.start(jobId, f.input, async () => {
    entered.resolve()
    await gate.promise
  })
  await entered.promise
  try {
    const close = manager.close()
    const closed = await Promise.race([close.then(() => true), delay(250).then(() => false)])
    expect(closed).toBe(true)
    expect(manager.activeCount()).toBe(0)
    expect(f.store.shellJobs.get(f.parent.run.id, jobId, 0).status).toBe("cancelled")
    await withBotProjectMutation(f.directory, async () => undefined)
    expect(execute).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
    await manager.close()
  }
  await delay(5)
  expect(execute).not.toHaveBeenCalled()
})

it("cancels a pre-start service guard without waiting for its uncancellable read", async () => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>()
  const start = vi.fn(() => {
    throw new Error("unexpected launch")
  })
  const runner = await createTrustedBotShellTestRunner(cleanup)
  vi.spyOn(runner, "start").mockImplementation(start)
  const manager = new BotShellServices(join(f.privateRoot, "models.private"), runner)
  manager.bind(f.store, "host")
  const { jobId, service } = f.reserve(true)
  const admitted = manager
    .start(f.request, service!, f.input, async () => {
      entered.resolve()
      await gate.promise
    })
    .catch((error) => error)
  await entered.promise
  try {
    const close = manager.close()
    const closed = await Promise.race([close.then(() => true), delay(250).then(() => false)])
    expect(closed).toBe(true)
    expect(manager.hasRun(f.parent.run.id)).toBe(false)
    expect(f.store.shellJobs.get(f.parent.run.id, jobId, 0).status).toBe("cancelled")
    expect(start).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
    await admitted
    await manager.close()
  }
  await delay(5)
  expect(start).not.toHaveBeenCalled()
})

it("cancels the entire pre-start project read and refuses a late completed preparation", async () => {
  const f = fixture(),
    gate = deferred<BotProjectFiles>(),
    entered = deferred<void>()
  vi.spyOn(BotProjectFiles, "open").mockImplementationOnce(async () => {
    entered.resolve()
    return gate.promise
  })
  const start = vi.fn(() => {
    throw new Error("unexpected launch")
  })
  const runner = await createTrustedBotShellTestRunner(cleanup)
  vi.spyOn(runner, "start").mockImplementation(start)
  const manager = new BotShellServices(join(f.privateRoot, "models.private"), runner)
  manager.bind(f.store, "host")
  const { service } = f.reserve(true)
  const admitted = manager
    .start(f.request, service!, f.input, async () => undefined)
    .catch((error) => error)
  await entered.promise
  try {
    const close = manager.close()
    expect(await Promise.race([close.then(() => true), delay(250).then(() => false)])).toBe(true)
    expect(start).not.toHaveBeenCalled()
  } finally {
    gate.resolve({ root: f.directory } as BotProjectFiles)
    await admitted
    await manager.close()
  }
  await delay(5)
  expect(start).not.toHaveBeenCalled()
})

it("keeps an admitted resource attached until its physical completion settles", async () => {
  const f = fixture(),
    completion = deferred<{ output: string; exitCode: number | null; truncated: boolean }>()
  let aborted = false
  const start = vi.fn((_input: unknown, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted = true
      },
      { once: true }
    )
    return { admitted: Promise.resolve(), completion: completion.promise }
  })
  const runner = await createTrustedBotShellTestRunner(cleanup)
  vi.spyOn(runner, "start").mockImplementation(start)
  const manager = new BotShellServices(join(f.privateRoot, "models.private"), runner)
  manager.bind(f.store, "host")
  const { service, jobId } = f.reserve(true)
  await manager.start(f.request, service!, f.input, async () => undefined)
  try {
    const close = manager.close()
    expect(aborted).toBe(true)
    expect(await Promise.race([close.then(() => true), delay(30).then(() => false)])).toBe(false)
    expect(manager.hasRun(f.parent.run.id)).toBe(true)
    completion.resolve({ output: "already ran; closed", exitCode: null, truncated: false })
    await close
    expect(f.store.shellJobs.get(f.parent.run.id, jobId, 0).status).toBe("needs_review")
    expect(f.store.effects(f.parent.run.id)).toMatchObject([{ status: "unknown" }])
    expect(f.store.finish(f.parent.lease, "failed", "Interrupted").status).toBe("needs_review")
    expect(start).toHaveBeenCalledTimes(1)
  } finally {
    completion.resolve({ output: "closed", exitCode: null, truncated: false })
    await manager.close()
  }
})

it("preserves owned unknown as a fatal domain failure and safe error packet", () => {
  const error = new BotOwnedShellUnknown(true, false, "command interrupted")
  expect(error).toBeInstanceOf(BotDomainError)
  expect(error.requestMayHaveStarted).toBe(true)
  expect(error.resourceClosed).toBe(false)
  const failure = serializeBotFailure(new Error("wrapped", { cause: error }))
  expect(failure.code).toBe("bot_shell_unknown")
  expect(failure.diagnostic).toEqual({ code: "bot_shell_unknown" })
  expect(JSON.stringify(failure)).not.toContain("requestMayHaveStarted")
  expect(() => unwrapBotIpcResult(botIpcFailure(error))).toThrow(
    expect.objectContaining({ code: "bot_shell_unknown" })
  )
})

it("keeps maintenance rejection code while review evidence stays private", () => {
  const review = {
    state: "requires_review" as const,
    reason: "physical-closure-unproven" as const,
    entries: [],
    title: "命令现场待核对",
    hint: "请保留原目录"
  }
  const error = new BotShellMaintenanceBlocked(review)
  expect(error).toBeInstanceOf(BotDomainError)
  expect(error.definitive).toBe(true)
  expect(error.review).toBe(review)
  expect(serializeBotFailure(error).code).toBe("bot_shell_resource_requires_review")
  expect(botIpcFailure(error).botFailure.diagnostic).toEqual({
    code: "bot_shell_resource_requires_review"
  })
  expect(JSON.stringify(botIpcFailure(error))).not.toContain('"review"')
})

it("settles a cancelled readonly guard before its late rejection", async () => {
  const gate = deferred<void>(),
    controller = new AbortController()
  const operation = assertBotShellCurrent(async () => gate.promise, controller.signal)
  controller.abort(new Error("cancelled"))
  await expect(operation).rejects.toThrow("cancelled")
  gate.reject(new Error("late readonly failure"))
  await delay(5)
})

it("checks the existing guard deadline before starting a read", async () => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort(new Error("deadline")))
  const check = vi.fn(async () => undefined)
  await expect(assertBotShellCurrent(check, new AbortController().signal)).rejects.toThrow(
    "deadline"
  )
  expect(check).not.toHaveBeenCalled()
  expect(AbortSignal.timeout).toHaveBeenCalledWith(30000)
})
