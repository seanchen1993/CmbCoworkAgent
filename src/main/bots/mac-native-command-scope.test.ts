import { afterEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotShellProcess, type BotShellOwnedFactory } from "./shell-process"
import { createBotHostShellFactory } from "./host-shell-factory"
import { BotStore } from "./store"
import { BotHost, type BotRuntimeRequest } from "./host"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { createBotAPI } from "./rpc"
import { botShellTools } from "./shell-tools"
import { BotShellJobs } from "./shell-jobs"
import { BotShellServices } from "./shell-services"
import { BotHarnessContextProvider } from "./harness-context-provider"
import { executeBotSkillDependencyCheck } from "./skill-dependency-check"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(shell: BotShellProcess) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-scope-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "state.sqlite"))
  cleanup.push(() => store.close())
  const runtime = new CmbBotRuntime(
    join(directory, "models.private"),
    new LocalBotComputerProvider(join(directory, "browser")),
    { shell }
  )
  const host = new BotHost(store, runtime)
  cleanup.push(() => runtime.shellServices.close())
  return { directory, store, runtime, host, api: createBotAPI(host) }
}
it("Mac production Host exposes only history and rejects executable dependency submission before queueing", async () => {
  const original = process
  vi.stubGlobal(
    "process",
    new Proxy(original, {
      get: (target, key, receiver) =>
        key === "platform" ? "darwin" : Reflect.get(target, key, receiver)
    })
  )
  const prepare = vi.fn<BotShellOwnedFactory>(async () => {
    throw new Error("not admitted")
  })
  const factory = await createBotHostShellFactory({
    directory: "/absent-host",
    helperEntry: "/absent-helper",
    workerEntry: "/absent-worker",
    hostId: () => "native-scope",
    dataEpoch: () => "epoch",
    assertOwnership: vi.fn(async () => {}),
    platformFactory: prepare
  })
  const f = await fixture(new BotShellProcess(factory))
  const status = await f.api.status()
  expect(f.runtime.commandExecutionAvailable).toBe(false)
  expect(f.host.commandServicesAvailable).toBe(false)
  expect(status.capabilities).toContain("skill-dependency-history")
  for (const capability of [
    "harness-context",
    "skill-dependencies",
    "background-shell-jobs",
    "cross-turn-shell-services"
  ])
    expect(status.capabilities).not.toContain(capability)
  const submit = vi.spyOn(f.store.skillDependencies, "submit")
  const refresh = vi.spyOn(f.host, "refreshSkills")
  await expect(
    f.api.checkSkillDependencies({
      nonce: "no-submit",
      expectedDataEpoch: f.store.dataEpoch(),
      skill: { botId: "missing", id: "missing", version: 1 }
    })
  ).rejects.toMatchObject({ code: "shell_unavailable" })
  expect(submit).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(f.store.snapshot().runs).toHaveLength(0)
  expect(prepare).not.toHaveBeenCalled()
})
it("keeps prior shell job controls when the production Mac command runner is closed", async () => {
  const original = process
  vi.stubGlobal(
    "process",
    new Proxy(original, {
      get: (target, key, receiver) =>
        key === "platform" ? "darwin" : Reflect.get(target, key, receiver)
    })
  )
  const prepare = vi.fn<BotShellOwnedFactory>(async () => {
    throw new Error("no command may be prepared")
  })
  const factory = await createBotHostShellFactory({
    directory: "/absent-host",
    helperEntry: "/absent-helper",
    workerEntry: "/absent-worker",
    hostId: () => "native-controls",
    dataEpoch: () => "epoch",
    assertOwnership: vi.fn(async () => {}),
    platformFactory: prepare
  })
  const shell = new BotShellProcess(factory)
  const f = await fixture(shell)
  const status = await f.api.status()
  expect(shell.available).toBe(false)
  expect(f.runtime.commandExecutionAvailable).toBe(false)
  expect(status.capabilities).toContain("shell-job-controls-v1")
  expect(status.capabilities).toContain("mutation-data-epoch-v2")
  expect(status.capabilities).not.toContain("background-shell-jobs")
  expect(status.capabilities).not.toContain("cross-turn-shell-services")
  const { conversationId } = f.store.createBot({ nonce: "prior-owner", name: "Prior owner" })
  f.store.send({ nonce: "prior-task", conversationId, text: "Previous Host task" })
  const claimed = f.store.claim("previous-host")!
  const action = { command: "previous-host-command" }
  const approval = f.store.requestInteraction(claimed.lease, {
    kind: "approval",
    prompt: "Previous Host approval",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  const jobId = f.store.toolOnce(claimed.lease, "prior-shell", action, () => {
    f.store.beginEffect(claimed.lease, {
      id: "prior-shell-effect",
      action,
      approvalId: approval.id
    })
    return f.store.shellJobs.reserve(
      claimed.lease,
      "prior-shell",
      "prior-shell-effect",
      action.command
    )
  })
  // Existing execution records are domain fixtures; no process or closure is fabricated.
  f.store.shellJobs.start(claimed.lease, jobId)
  f.store.shellJobs.progress(claimed.lease, jobId, {
    output: "PRIOR_HOST_OUTPUT",
    truncated: false
  })
  const address = { conversationId, runId: claimed.run.id, jobId }
  const prior = await f.api.shellJob(address)
  const priorEffects = f.store.effects(claimed.run.id)
  const input = {
    ...address,
    nonce: randomUUID(),
    revision: prior.revision,
    dataEpoch: f.store.dataEpoch()
  }
  const stopped = await f.api.stopShellJob(input)
  expect(stopped).toMatchObject({
    status: "cancelling",
    output: "PRIOR_HOST_OUTPUT",
    exitCode: null
  })
  expect(await f.api.stopShellJob(input)).toEqual(stopped)
  expect(f.store.effects(claimed.run.id)).toEqual(priorEffects)
  expect(priorEffects).toEqual([expect.objectContaining({ status: "started" })])
  await expect(f.api.stopShellJob({ ...input, nonce: randomUUID() })).rejects.toMatchObject({
    code: "revision_conflict"
  })
  await expect(f.api.stopShellJob({ ...input, dataEpoch: "restored" })).rejects.toMatchObject({
    code: "data_epoch"
  })
  expect(f.store.shellJobs.get(claimed.run.id, jobId).status).toBe("cancelling")
  expect(shell.available).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
})
it("Host capabilities follow a trusted runner rather than client or current process platform", async () => {
  const prepare = vi.fn<BotShellOwnedFactory>(async () => {
    throw new Error("this test starts no command")
  })
  const f = await fixture(new BotShellProcess(prepare))
  const status = await f.api.status()
  expect(f.runtime.commandExecutionAvailable).toBe(true)
  expect(f.host.commandServicesAvailable).toBe(true)
  for (const capability of [
    "harness-context",
    "skill-dependencies",
    "background-shell-jobs",
    "cross-turn-shell-services"
  ])
    expect(status.capabilities).toContain(capability)
  expect(prepare).not.toHaveBeenCalled()
})
it("unavailable runner with configured execution emits no command tools", () => {
  const check = vi.fn()
  const approve = vi.fn()
  const request = { bot: { workspacePath: "/configured-project" } } as BotRuntimeRequest
  expect(
    botShellTools(
      request,
      "/models.private",
      { windowsSandbox: "none", resourceDirectory: "/resources" },
      {} as Parameters<typeof botShellTools>[3],
      check,
      approve,
      new BotShellProcess()
    )
  ).toEqual([])
  expect(check).not.toHaveBeenCalled()
  expect(approve).not.toHaveBeenCalled()
})
it("manual job, service and dependency admission rejects before callbacks or store work", async () => {
  const runner = new BotShellProcess()
  const request = {} as BotRuntimeRequest
  const start = vi.fn(async () => {})
  const input = {} as Parameters<BotShellProcess["start"]>[0]
  expect(() => new BotShellJobs(request, runner).start("not-started", input, start)).toThrow(
    "未运行命令"
  )
  await expect(
    new BotShellServices("/models.private", runner).start(
      request,
      {} as Parameters<BotShellServices["start"]>[1],
      input,
      start
    )
  ).rejects.toMatchObject({ code: "shell_unavailable" })
  await expect(
    executeBotSkillDependencyCheck({ request, runner } as Parameters<
      typeof executeBotSkillDependencyCheck
    >[0])
  ).rejects.toMatchObject({ code: "shell_unavailable" })
  expect(start).not.toHaveBeenCalled()
})
it("unavailable command Harness is not prepared even when its saved Bot binding exists", async () => {
  const runner = new BotShellProcess()
  const provider = new BotHarnessContextProvider("/models.private", runner)
  const request = {
    bot: { harnessBinding: { projectId: "saved-project", instructionWorkspacePaths: [] } }
  } as unknown as BotRuntimeRequest
  const approve = vi.fn()
  const check = vi.fn()
  const result = await provider.prepare(
    request,
    {} as Parameters<typeof provider.prepare>[1],
    approve,
    check
  )
  expect(result).toBeNull()
  expect(approve).not.toHaveBeenCalled()
  expect(check).not.toHaveBeenCalled()
})
