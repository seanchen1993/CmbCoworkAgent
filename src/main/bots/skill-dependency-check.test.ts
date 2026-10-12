import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import type { BotShellProcess } from "./shell-process"
import { writeBotModelSnapshot } from "./model-config"
import { botSkillDependencyReport } from "../../shared/bot-skill-dependencies"
import { createBotAPI } from "./rpc"
import type { BotSkillSelection } from "../../shared/bot-skill-references"
import { BotProjectFiles } from "./project-files"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error("controlled dependency task did not settle")
}
async function fixture(
  checks: unknown[],
  stdout = "present\n",
  permission: "always" | "never" = "always",
  configuredModel = true,
  actualRunner?: BotShellProcess
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-skill-dependencies-")))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "package.json"), "{}")
  const modelFile = join(root, "host", "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "fixture",
    execution: {
      windowsSandbox: "none",
      resourceDirectory: join(root, "resources")
    },
    models: configuredModel
      ? [
          {
            id: "fixture",
            ref: "fixture",
            name: "Fixture",
            model: "fixture",
            apiKey: "MODEL_SECRET_CANARY_DO_NOT_PUBLISH",
            baseUrl: "http://127.0.0.1:1/v1"
          }
        ]
      : []
  })
  const store = new BotStore(join(root, "bots.sqlite"))
  closes.push(() => store.close())
  store.localTools.bind({
    target: {
      id: "a".repeat(64),
      label: "受控测试环境",
      platform: process.platform as "darwin" | "win32" | "linux"
    },
    assertCurrent() {
      /* The policy target is fixed to this fixture and actual process platform. */
    }
  })
  const policy = store.localTools.read()
  store.localTools.change({
    nonce: "permission",
    targetId: policy.target.id,
    dataEpoch: policy.dataEpoch,
    revision: policy.revision,
    choice: permission
  })
  const created = store.createBot({
    nonce: "bot",
    name: "Bot",
    workspacePath: workspace
  })
  const skill = store.saveSkill({
    botId: created.bot.id,
    name: "Skill",
    instructions: `---\ncmbdevclaw-dependencies:\n  schemaVersion: 1\n  checks: ${JSON.stringify(checks)}\n---\nDo the work.`,
    enabled: true
  })
  const selection: BotSkillSelection = {
    botId: skill.botId,
    id: skill.id,
    version: skill.version
  }
  const runner = actualRunner ?? (await createTrustedBotShellTestRunner(closes))
  const executions: unknown[] = []
  if (!actualRunner)
    vi.spyOn(runner, "execute").mockImplementation(async (request, signal, progress, guard) => {
      signal.throwIfAborted()
      expect(progress).toBeUndefined()
      await guard?.(signal)
      executions.push(request)
      return { output: stdout, exitCode: 0, truncated: false }
    })
  const computer = new LocalBotComputerProvider(join(root, "browser"))
  closes.push(() => computer.shutdown())
  const runtime = new CmbBotRuntime(modelFile, computer, { shell: runner })
  const host = new BotHost(store, runtime)
  closes.push(() => host.stop())
  const api = createBotAPI(host)
  const input = {
    nonce: "check",
    expectedDataEpoch: store.dataEpoch(),
    skill: selection
  }
  const receipt = await api.checkSkillDependencies(input)
  host.start()
  return {
    root,
    workspace,
    store,
    host,
    runtime,
    api,
    input,
    receipt,
    selection,
    executions,
    modelFile
  }
}
async function approvals(
  f: Awaited<ReturnType<typeof fixture>>,
  decision: "approve" | "reject" = "approve"
) {
  await until(
    () =>
      f.store
        .snapshot()
        .interactions.some(
          (item) =>
            item.runId === f.receipt.runId && item.kind === "approval" && item.status === "pending"
        ) || ["failed", "succeeded"].includes(f.store.getRun(f.receipt.runId).status)
  )
  for (let i = 0; i < 200; i++) {
    const run = f.store.getRun(f.receipt.runId)
    if (["failed", "succeeded", "cancelled", "needs_review"].includes(run.status)) return
    for (const item of f.store
      .snapshot()
      .interactions.filter(
        (item) => item.runId === run.id && item.kind === "approval" && item.status === "pending"
      ))
      f.store.answerInteraction({
        id: item.id,
        revision: item.revision,
        answer: decision
      })
    f.host.tick()
    await delay(20)
  }
  throw new Error("controlled approval did not settle")
}
it("runs real project presence under the original local gate, approval and effect receipt without an LLM request", async () => {
  const f = await fixture([
    { id: "platform", kind: "platform", platforms: [process.platform] },
    { id: "file", kind: "file", path: "package.json", type: "file" }
  ])
  await approvals(f)
  expect(f.store.getRun(f.receipt.runId)).toMatchObject({
    status: "succeeded"
  })
  const report = botSkillDependencyReport.parse(f.store.skillDependencies.report(f.receipt.runId))
  expect(report.status).toBe("satisfied")
  expect(report.checks.map((item) => item.status)).toEqual(["satisfied", "satisfied"])
  expect(f.executions).toEqual([])
  expect(f.store.effects(f.receipt.runId)).toMatchObject([{ status: "succeeded" }])
  expect(f.store.skills(f.selection.botId)[0].verified).toBe(false)
  expect((await f.api.skillDependencies(f.selection)).history[0].current).toBe(true)
  expect(await readFile(join(f.workspace, "package.json"), "utf8")).toBe("{}")
})
it("human rejection yields unverified and never invokes the command runner", async () => {
  const f = await fixture([{ id: "node", kind: "executable", name: "node" }])
  await approvals(f, "reject")
  const run = f.store.getRun(f.receipt.runId)
  expect(run.status).toBe("succeeded")
  const report = botSkillDependencyReport.parse(f.store.skillDependencies.report(run.id))
  expect(report.checks).toEqual([{ id: "node", status: "unverified", reason: "permission_denied" }])
  expect(f.executions).toEqual([])
  expect(f.store.effects(run.id)).toEqual([])
})
it("local device never policy keeps all dependency results unverified before any command", async () => {
  const f = await fixture([{ id: "node", kind: "executable", name: "node" }], "present\n", "never")
  await until(() => f.store.getRun(f.receipt.runId).status === "failed")
  expect(f.executions).toEqual([])
  expect((await f.api.skillDependencies(f.selection)).history[0]).toMatchObject({
    report: null,
    current: false,
    reason: "not_checked"
  })
  expect(f.store.effects(f.receipt.runId)).toEqual([])
})
it("version output with sensitive canary is not a version and never enters receipts/artifacts/messages", async () => {
  const f = await fixture([
    { id: "node", kind: "executable", name: "node", minimumVersion: "22.16.0" }
  ])
  const runner = (f.runtime as unknown as { shell: BotShellProcess }).shell
  vi.mocked(runner.execute).mockImplementation(async (request, signal, progress, guard) => {
    signal.throwIfAborted()
    expect(progress).toBeUndefined()
    await guard?.(signal)
    f.executions.push(request)
    return {
      output: request.command.includes("--version")
        ? "v22.23.3\nDEPENDENCY_OUTPUT_SECRET_CANARY"
        : "present\n",
      exitCode: 0,
      truncated: false
    }
  })
  await approvals(f)
  const run = f.store.getRun(f.receipt.runId)
  expect(run.status).toBe("succeeded")
  const report = botSkillDependencyReport.parse(f.store.skillDependencies.report(run.id))
  expect(report.checks[0]).toMatchObject({
    status: "unverified",
    reason: "probe_output_invalid"
  })
  expect(JSON.stringify(f.store.effects(run.id))).not.toContain("DEPENDENCY_OUTPUT_SECRET_CANARY")
  expect(JSON.stringify(f.store.messages(run.conversationId))).not.toContain(
    "DEPENDENCY_OUTPUT_SECRET_CANARY"
  )
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    "DEPENDENCY_OUTPUT_SECRET_CANARY"
  )
  expect(JSON.stringify(report)).not.toContain("MODEL_SECRET_CANARY_DO_NOT_PUBLISH")
  expect(f.store.artifacts(run.conversationId)).toEqual([])
})
it("exact acknowledged retry never reenqueues and changed permission/environment retires prior evidence", async () => {
  const f = await fixture([{ id: "platform", kind: "platform", platforms: [process.platform] }])
  await until(() => f.store.getRun(f.receipt.runId).status === "succeeded")
  expect(await f.api.checkSkillDependencies(f.input)).toEqual(f.receipt)
  expect(
    f.store.snapshot().runs.filter((item) => item.source === "skill-dependency-check")
  ).toHaveLength(0)
  const policy = f.store.localTools.read()
  f.store.localTools.change({
    nonce: "revoke",
    targetId: policy.target.id,
    dataEpoch: policy.dataEpoch,
    revision: policy.revision,
    choice: "never"
  })
  const view = await f.api.skillDependencies(f.selection)
  expect(view.history[0]).toMatchObject({
    current: false,
    reason: "stale_environment"
  })
  expect(view.history[0].report?.status).toBe("satisfied")
})
it("original project link boundary remains unavailable rather than falsely absent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-dependency-boundary-")))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, "project"),
    other = join(root, "private")
  await mkdir(workspace)
  await mkdir(other)
  await writeFile(join(other, "secret.txt"), "PRIVATE_FILE_CANARY")
  await symlink(other, join(workspace, "linked"))
  const project = await BotProjectFiles.open(workspace)
  await expect(project.probe("linked/secret.txt", "file")).rejects.toThrow("符号链接")
  expect(await project.probe("missing/secret.txt", "file")).toBe(false)
  await expect(project.probe(".git/config", "file")).rejects.toThrow("Git")
})

it("checks declared platform/file dependencies without constructing or calling a model", async () => {
  const log = vi.spyOn(console, "log")
  const f = await fixture(
    [{ id: "platform", kind: "platform", platforms: [process.platform] }],
    "present\n",
    "always",
    false
  )
  await until(() => f.store.getRun(f.receipt.runId).status === "succeeded")
  expect(
    botSkillDependencyReport.parse(f.store.skillDependencies.report(f.receipt.runId)).status
  ).toBe("satisfied")
  expect(log.mock.calls.flat().join("\n")).not.toContain("[Runtime] Custom model")
  expect(f.executions).toEqual([])
})

it.each([null, 124, 130])(
  "does not repeat an interrupted probe or turn exit %s into a missing dependency",
  async (exitCode) => {
    const f = await fixture([{ id: "node", kind: "executable", name: "node" }])
    const runner = (f.runtime as unknown as { shell: BotShellProcess }).shell
    vi.mocked(runner.execute).mockImplementation(async (request, signal, progress, guard) => {
      signal.throwIfAborted()
      expect(progress).toBeUndefined()
      await guard?.(signal)
      f.executions.push(request)
      return { output: "RAW_UNKNOWN_SECRET_CANARY", exitCode, truncated: false }
    })
    await approvals(f)
    const effects = f.store.effects(f.receipt.runId)
    expect(effects).toMatchObject([{ status: "unknown" }])
    expect(JSON.stringify(effects)).not.toContain("RAW_UNKNOWN_SECRET_CANARY")
    expect(await f.api.checkSkillDependencies(f.input)).toEqual(f.receipt)
    expect(f.executions).toHaveLength(1)
    expect((await f.api.skillDependencies(f.selection)).history[0].current).toBe(false)
  }
)

it("known file absence is missing while weak CLI closure and unsupported secret requirements remain unverified", async () => {
  const f = await fixture(
    [
      { id: "absent", kind: "executable", name: "not-installed" },
      { id: "private-env", kind: "environment", name: "INTERNAL_SECRET_TOKEN" },
      { id: "absent-file", kind: "file", path: "not-installed.txt", type: "file" }
    ],
    "absent\n"
  )
  await approvals(f)
  const report = botSkillDependencyReport.parse(f.store.skillDependencies.report(f.receipt.runId))
  expect(report.status).toBe("missing")
  expect(report.checks).toMatchObject([
    { status: "unverified", reason: "command_exit_unconfirmed" },
    { status: "unverified", reason: "unsupported" },
    { status: "missing", reason: "not_found" }
  ])
  expect(f.executions).toHaveLength(1)
})

it("an environment/permission stamp never carries a satisfied result to another Host instance", async () => {
  const f = await fixture([{ id: "platform", kind: "platform", platforms: [process.platform] }])
  await until(() => f.store.getRun(f.receipt.runId).status === "succeeded")
  expect((await f.api.skillDependencies(f.selection)).history[0].current).toBe(true)
  const replacement = new CmbBotRuntime(
    f.modelFile,
    new LocalBotComputerProvider(join(f.root, "other-browser"))
  )
  const view = await replacement.skillDependencies(f.selection, f.store)
  expect(view.history[0]).toMatchObject({ current: false, reason: "stale_environment" })
  expect(view.history[0].report?.status).toBe("satisfied")
})

it("remembering the exact human-approved probe rule does not retire a physically unchanged check", async () => {
  const f = await fixture(
    [{ id: "cargo", kind: "executable", name: "cargo", minimumVersion: "1.0.0" }],
    "present\n"
  )
  const runner = (f.runtime as unknown as { shell: BotShellProcess }).shell
  vi.mocked(runner.execute).mockImplementation(async (request, signal, progress, guard) => {
    signal.throwIfAborted()
    expect(progress).toBeUndefined()
    await guard?.(signal)
    f.executions.push(request)
    return {
      output: request.command.includes("--version")
        ? "cargo 1.90.0 (abcdef0 2025-01-01)"
        : "present\n",
      exitCode: 0,
      truncated: false
    }
  })
  await until(() =>
    f.store
      .snapshot()
      .interactions.some((item) => item.runId === f.receipt.runId && item.status === "pending")
  )
  const first = f.store
    .snapshot()
    .interactions.find((item) => item.runId === f.receipt.runId && item.status === "pending")!
  f.store.answerInteraction({ id: first.id, revision: first.revision, answer: "approve" })
  f.host.tick()
  await until(() =>
    f.store
      .snapshot()
      .interactions.some((item) => item.runId === f.receipt.runId && item.status === "pending")
  )
  const interaction = f.store
    .snapshot()
    .interactions.find((item) => item.runId === f.receipt.runId && item.status === "pending")!
  expect(interaction.review?.canRemember).toBe(true)
  f.store.answerInteraction({
    id: interaction.id,
    revision: interaction.revision,
    answer: "approve",
    remember: true
  })
  f.host.tick()
  await until(() =>
    ["failed", "succeeded", "needs_review"].includes(f.store.getRun(f.receipt.runId).status)
  )
  expect(f.store.getRun(f.receipt.runId).status).toBe("succeeded")
  expect((await f.api.skillDependencies(f.selection)).history[0].current).toBe(true)
  expect(f.store.skillDependencies.report(f.receipt.runId)?.environment.commandRulesRevision).toBe(
    1
  )
})

it.skipIf(process.platform !== "darwin")(
  "observes a real CLI/version through the original trusted owner, worker, sandbox and approvals",
  async () => {
    const runner = await createTrustedBotShellTestRunner(closes)
    const f = await fixture(
      [
        { id: "node", kind: "executable", name: "node", minimumVersion: "20.0.0" },
        { id: "path", kind: "environment", name: "PATH" }
      ],
      "unused",
      "always",
      false,
      runner
    )
    await approvals(f)
    const run = f.store.getRun(f.receipt.runId)
    expect(run.status).toBe("succeeded")
    const report = botSkillDependencyReport.parse(f.store.skillDependencies.report(run.id))
    expect(report.checks[0]).toMatchObject({
      id: "node",
      status: "unverified",
      reason: "command_exit_unconfirmed"
    })
    expect(report.status).toBe("unverified")
    expect(report.checks[0].observedVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(report.checks[1]).toMatchObject({ id: "path", status: "satisfied", reason: "observed" })
    expect(f.store.effects(run.id)).toHaveLength(3)
    expect(f.store.effects(run.id).every((item) => item.status === "succeeded")).toBe(true)
    expect(f.store.artifacts(run.conversationId)).toEqual([])
    expect(run.result).not.toContain('"environment"')
  },
  20000
)

it("uses the closed Go version subcommand and accepts only its complete version response", async () => {
  const f = await fixture([{ id: "go", kind: "executable", name: "go", minimumVersion: "1.24.0" }])
  const runner = (f.runtime as unknown as { shell: BotShellProcess }).shell
  vi.mocked(runner.execute).mockImplementation(async (request, signal, progress, guard) => {
    signal.throwIfAborted()
    expect(progress).toBeUndefined()
    await guard?.(signal)
    f.executions.push(request)
    return {
      output:
        request.command === `${process.platform === "win32" ? "& " : ""}'go' version`
          ? `go version go1.24.3 ${process.platform === "win32" ? "windows" : process.platform}/amd64`
          : "present\n",
      exitCode: 0,
      truncated: false
    }
  })
  await approvals(f)
  expect(f.store.skillDependencies.report(f.receipt.runId)?.checks[0]).toMatchObject({
    status: "unverified",
    reason: "command_exit_unconfirmed",
    observedVersion: "1.24.3"
  })
  expect(f.executions).toMatchObject([
    {},
    { command: process.platform === "win32" ? "& 'go' version" : "'go' version" }
  ])
})
