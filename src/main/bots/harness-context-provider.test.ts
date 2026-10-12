import { afterEach, expect, it, vi } from "vitest"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotLocalToolGate } from "./local-tool-gate"
import { setTimeout as delay } from "node:timers/promises"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { BotHarnessContextProvider, assertBotHarnessContext } from "./harness-context-provider"
import { readBotHarnessCatalog } from "./harness-catalog-reader"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { FEATURE_V2_FILE } from "../harness-board/config-v2"
import type { BotRuntimeRequest } from "./host"
import { BotSkillHooks } from "./skill-hooks"
import { BotWorkflowStore } from "./workflow-store"
import { prepareBotWorkflow } from "./workflow-tool"
import type { BotExternalSkill } from "./skill-catalog-contract"
import { BotShellServices } from "./shell-services"
import { parseBotHarnessRunContext } from "./harness-context-contract"

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture(
  options: {
    dynamic?: boolean
    mappings?: (project: string, outside: string) => string[]
    extra?: boolean
    secret?: string
    text?: string
    connectorIds?: string[]
  } = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-harness-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const catalog = join(root, "catalog"),
    project = join(root, "project"),
    outside = join(root, "outside"),
    plugin = join(root, "plugin"),
    host = join(root, "host")
  for (const directory of [catalog, project, outside, join(plugin, "board_core"), host])
    await mkdir(directory, { recursive: true })
  await writeFile(join(project, "AGENTS.md"), "PRIMARY_PROJECT_RULE")
  await writeFile(join(outside, "AGENTS.md"), "OUTSIDE_PROJECT_RULE")
  const configPath = join(plugin, "board_core/board_config.json")
  const secret = options.secret ?? "private-token-only"
  const config = {
    apiVersion: 1,
    inspectCommands: {
      [process.platform]: {
        system_prompt_inject: "STATIC ${projectCode} ${feature} ${leanToken}",
        plugin_dir_hook: "${pluginPath}/output",
        ...(options.dynamic
          ? {
              session_context_inject: 'node inspect.cjs "${leanToken}" "${selectedDeployUnits}"',
              feature_status: "node status.cjs ${feature}"
            }
          : {})
      }
    }
  }
  await writeFile(configPath, JSON.stringify(config))
  await writeFile(
    join(catalog, "plugins.json"),
    JSON.stringify([
      {
        id: "plugin-one",
        name: "Bound plugin",
        version: "1.0",
        path: plugin,
        enabled: true,
        description: "Fixture",
        author: "fixture",
        skillCount: 0,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    ])
  )
  await writeFile(
    join(catalog, "harness-board-projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: "project-one",
          name: "Project",
          projectCode: "P1",
          projectDir: "project",
          workspacePath: root,
          systemId: "system-one",
          "harness-adapter": {
            id: "plugin-one",
            name: "Bound plugin",
            version: "1.0",
            type: "plugin"
          },
          lifecycle: { status: "active", createAt: "2026-01-01" }
        }
      ]
    })
  )
  const mappingPaths = options.mappings?.(project, outside) ?? []
  await writeFile(
    join(catalog, FEATURE_V2_FILE),
    JSON.stringify({
      version: 2,
      bindings: [
        {
          projectId: "project-one",
          featureId: "feature-one",
          sessionContextInjectionSource: options.dynamic ? "plugin" : "cmbdevclaw",
          selectedDeployUnitMappings: mappingPaths.map((path, index) => ({
            deployUnitIdMapping: `mapped-${index}`,
            deployUnitId: `unit-${index}`,
            localRepoPath: path
          }))
        }
      ]
    })
  )
  await writeFile(join(catalog, "leanstar-config.json"), JSON.stringify({ leanToken: secret }))
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: "test",
    models: [
      {
        id: "test",
        ref: "test",
        name: "Test",
        model: "gpt-test",
        baseUrl: "https://model.invalid/v1",
        apiKey: "test-only"
      }
    ],
    harnessSources: { root: catalog },
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  }
  const modelFile = join(host, "models.private")
  await writeBotModelSnapshot(modelFile, snapshot)
  let now = 1_900_000_000_000
  const store = new BotStore(join(host, "bots.sqlite"), () => now)
  cleanups.push(() => store.close())
  const owner = store.createBot({
    nonce: "create",
    name: "Project bot",
    workspacePath: project,
    connectorIds: options.connectorIds,
    harnessBinding: {
      projectId: "project-one",
      featureSlug: "feature-one",
      instructionWorkspacePaths: options.extra ? [outside] : []
    }
  })
  store.send({
    nonce: "task",
    conversationId: owner.conversationId,
    text: options.text ?? "Review project"
  })
  const claimed = store.claim("test-host", 300_000)!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot: owner.bot,
    messages: store.messages(owner.conversationId),
    store,
    signal: new AbortController().signal
  }
  const shell = await createTrustedBotShellTestRunner(cleanups)
  const calls = vi.spyOn(shell, "execute").mockImplementation(async (input) => ({
    exitCode: 0,
    truncated: false,
    output: "",
    hook: {
      stderr: "",
      stdout: JSON.stringify(
        input.hook?.invocation?.args.includes("status.cjs")
          ? {
              run: {
                currentNodeId: "review",
                currentNodeStatus: "not_started",
                nodes: [{ id: "review", nodeStatus: "done" }]
              },
              workflow: { nodes: [{ id: "review", label: "Code review", group: "Quality" }] }
            }
          : {
              ok: true,
              sessionContext: `PLUGIN_PROJECT_RULE ${secret}`,
              agentConfig: {
                subagentConfig: { disabledBuiltinSubagents: ["Explore"], customSubagentFiles: [] }
              },
              nested: { credential: secret }
            }
      )
    }
  }))
  const provider = new BotHarnessContextProvider(modelFile, shell, {
    entry: resolve("src/main/bots/harness-catalog-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const check = () => {
    store.assertLease(request.lease)
    request.signal.throwIfAborted()
  }
  const approve = async (
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    before?: () => Promise<void>
  ) => {
    const previous = store.effectResult(request.lease, id, action)
    if (previous) {
      if (previous.status !== "succeeded") throw new Error("uncertain effect")
      return previous.result!
    }
    const permission = store.requestInteraction(request.lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    store.answerInteraction({ id: permission.id, revision: permission.revision, answer: "approve" })
    await before?.()
    store.beginEffect(request.lease, { id, action, approvalId: permission.id })
    try {
      const result = await operation()
      store.settleEffect(request.lease, id, "succeeded", result)
      return result
    } catch (error) {
      store.settleEffect(
        request.lease,
        id,
        "unknown",
        error instanceof Error ? error.message : "failure"
      )
      throw error
    }
  }
  const prepare = () => provider.prepare(request, snapshot, approve, check)
  return {
    root,
    catalog,
    project,
    outside,
    plugin,
    configPath,
    config,
    snapshot,
    modelFile,
    store,
    request,
    provider,
    shell,
    calls,
    secret,
    check,
    approve,
    prepare,
    advance: (ms: number) => {
      now += ms
    }
  }
}

it.each([false, true])(
  "rejects a retargeted declared catalog root even with legacy pin=%s and original source files unchanged",
  async (legacy) => {
    const f = await fixture()
    const alias = join(f.root, "catalog-alias"),
      replacement = join(f.root, "replacement-catalog")
    await symlink(f.catalog, alias, process.platform === "win32" ? "junction" : "dir")
    f.snapshot.harnessSources = { root: alias }
    await writeBotModelSnapshot(f.modelFile, f.snapshot)
    const prepared = (await f.prepare())!
    if (legacy) delete prepared.catalog.rootIdentity
    const pinned = parseBotHarnessRunContext(JSON.parse(JSON.stringify(prepared)))
    await f.provider.assertCurrent(pinned, f.request.signal)
    await cp(f.catalog, replacement, { recursive: true })
    const projects = JSON.parse(
      await readFile(join(replacement, "harness-board-projects.json"), "utf8")
    )
    projects.projects[0].lifecycle.status = "archived"
    await writeFile(join(replacement, "harness-board-projects.json"), JSON.stringify(projects))
    await unlink(alias)
    await symlink(replacement, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(f.provider.assertCurrent(pinned, f.request.signal)).rejects.toThrow("配置已变化")
  }
)

it("rejects replacement of the declared catalog directory while keeping each source file identity unchanged", async () => {
  const f = await fixture()
  const prepared = (await f.prepare())!
  const prior = join(f.root, "prior-catalog")
  await rename(f.catalog, prior)
  await mkdir(f.catalog)
  for (const entry of await readdir(prior)) await rename(join(prior, entry), join(f.catalog, entry))
  await expect(f.provider.assertCurrent(prepared, f.request.signal)).rejects.toThrow("配置已变化")
})

it.each(["project", "published", "installed"] as const)(
  "continues a cross-turn service after an unrelated project edit and stops after %s authority is revoked",
  async (authority) => {
    const f = await fixture()
    await f.prepare()
    f.store.bindLeaseGuard(f.request.lease.owner, () => {})
    let revokeSkill: (() => void) | undefined
    if (authority === "published") {
      const skill = f.store.saveSkill({
        botId: f.request.bot.id,
        name: "Server",
        instructions: "Run server",
        enabled: true
      })
      const published = f.store.skillLibrary.publish({
        nonce: "publish-service",
        botId: skill.botId,
        skillId: skill.id,
        version: skill.version,
        libraryRevision: 0
      })
      f.store.skillLibrary.readForRun(f.request.run.id, published.id)
      revokeSkill = () => {
        f.store.skillLibrary.withdraw({
          nonce: "withdraw-service",
          id: published.id,
          revision: published.revision
        })
      }
    } else if (authority === "installed") {
      const skill: BotExternalSkill = {
        id: `desktop:${"b".repeat(64)}`,
        catalogId: "server",
        name: "Server",
        instructions: "Run server",
        description: "",
        sha256: "c".repeat(64),
        fileStamp: "original",
        filePath: join(f.root, "SKILL.md"),
        catalogPath: f.root,
        rootPath: f.root,
        resources: [],
        compatibility: "",
        pluginId: null,
        pluginName: null,
        isProjectModePlugin: false,
        source: "user"
      }
      f.store.externalSkills.apply({ skills: [skill], warnings: [], truncated: false })
      f.store.skillLibrary.readForRun(f.request.run.id, skill.id)
      revokeSkill = () =>
        f.store.externalSkills.apply({ skills: [], warnings: [], truncated: false })
    }
    const action = { shell: { command: "server", keepAlive: true } }
    const approval = f.store.requestInteraction(f.request.lease, {
      kind: "approval",
      prompt: "Start?",
      action
    })
    f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    const reserved = f.store.toolOnce(f.request.lease, "create-service", action, () => {
      f.store.beginEffect(f.request.lease, {
        id: "service-effect",
        action,
        approvalId: approval.id
      })
      const jobId = f.store.shellJobs.reserve(f.request.lease, "server", "service-effect", "server")
      return { jobId, service: f.store.shellServices.attach(f.request.lease, jobId, 60_000) }
    })
    const runner = await createTrustedBotShellTestRunner(cleanups)
    let aborted = false
    vi.spyOn(runner, "start").mockImplementation((_input, signal) => ({
      admitted: Promise.resolve(),
      completion: new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            resolve({ output: "Interrupted", exitCode: 130, truncated: false })
          },
          { once: true }
        )
      })
    }))
    const guard = vi.spyOn(f.provider, "assertCurrent")
    const manager = new BotShellServices(f.modelFile, runner, f.provider)
    manager.bind(f.store, f.request.lease.owner)
    try {
      await manager.start(
        f.request,
        reserved.service,
        {
          command: "server",
          cwd: f.project,
          workspaceRoot: f.project,
          runId: f.request.run.id,
          timeoutMs: 60_000,
          background: true,
          execution: f.snapshot.execution!
        },
        async () => {}
      )
      f.store.finish(f.request.lease, "succeeded", "Server started")
      guard.mockClear()
      const path = join(f.catalog, "harness-board-projects.json")
      const projects = JSON.parse(await readFile(path, "utf8"))
      projects.projects.push({
        ...projects.projects[0],
        projectId: "unrelated-project",
        name: "Other",
        lifecycle: { status: "archived", createAt: "2026-01-01" }
      })
      await writeFile(path, JSON.stringify(projects))
      manager.tick()
      await vi.waitFor(() => expect(guard).toHaveBeenCalled(), { timeout: 2000 })
      await guard.mock.results.at(-1)!.value
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(aborted).toBe(false)
      if (revokeSkill) revokeSkill()
      else {
        projects.projects[0].lifecycle.status = "archived"
        await writeFile(path, JSON.stringify(projects))
      }
      await vi.waitFor(
        () => {
          manager.tick()
          expect(aborted).toBe(true)
        },
        { timeout: 2000 }
      )
      await vi.waitFor(() => expect(manager.busy).toBe(false))
      expect(f.store.getRun(f.request.run.id).status).toBe("needs_review")
      expect(
        f.store.effects(f.request.run.id).find((effect) => effect.id === "service-effect")?.status
      ).toBe("unknown")
      expect(f.store.claim(f.request.lease.owner)).toBeNull()
    } finally {
      await manager.close()
    }
  }
)

it("prepares in a real Node catalog process, reuses Cmb AGENTS, and pins recovery without rereading commands", async () => {
  const f = await fixture({ dynamic: true, secret: 'private"\\token' })
  const first = await f.prepare()
  expect(first?.context).toMatchObject({
    enableAgentsPrompt: false,
    harnessProjectId: "project-one",
    pluginId: "plugin-one",
    featureId: "feature-one",
    systemPromptInject: "STATIC P1 feature-one",
    agentConfig: { subagentConfig: { disabledBuiltinSubagents: ["Explore"] } }
  })
  expect(first?.instructionPrompt).toContain("PLUGIN_PROJECT_RULE [已隐藏凭据]")
  expect(first?.instructionPrompt).not.toContain("PRIMARY_PROJECT_RULE")
  expect(first).toMatchObject({
    harnessNodeName: "Quality-Code review",
    harnessNodeStatus: "已完成"
  })
  expect(f.calls).toHaveBeenCalledTimes(2)
  expect(f.calls.mock.calls[0][0].hook?.invocation?.args).toContain(f.secret)
  expect(f.calls.mock.calls[0][0].command).not.toContain(f.secret)
  expect(f.calls.mock.calls[0][0]).toMatchObject({ readOnly: true, workspaceRoot: f.project })
  for (const table of [
    "bot_harness_run_contexts",
    "bot_harness_skill_scopes",
    "bot_effects",
    "bot_interactions",
    "bot_events"
  ])
    expect(JSON.stringify(f.store.db.exec(`SELECT * FROM ${table}`))).not.toContain(f.secret)
  const second = await f.prepare()
  expect(second).toEqual(first)
  expect(f.calls).toHaveBeenCalledTimes(2)
  f.advance(300_001)
  f.store.recoverExpired()
  const run = f.store.getRun(f.request.run.id)
  f.store.recover({
    id: run.id,
    revision: run.revision,
    decision: "resume",
    note: "上下文和两个检查结果已经核对",
    effects: []
  })
  const reclaimed = f.store.claim("new-host", 300_000)!
  f.request.run = reclaimed.run
  f.request.lease = reclaimed.lease
  expect(await f.prepare()).toEqual(first)
  expect(f.calls).toHaveBeenCalledTimes(2)
})

it("falls back to authorized project and explicit extra instructions, and omits ungranted repositories", async () => {
  const f = await fixture({ mappings: (_, outside) => [outside] })
  const prepared = await f.prepare()
  expect(prepared?.instructionPrompt).toContain("PRIMARY_PROJECT_RULE")
  expect(prepared?.instructionPrompt).not.toContain("OUTSIDE_PROJECT_RULE")
  expect(prepared?.context.sessionContextInjectWarning).toContain("未获指令目录授权")
  expect(f.calls).not.toHaveBeenCalled()
  const extra = await fixture({ extra: true, mappings: (_, outside) => [outside] })
  expect((await extra.prepare())?.instructionPrompt).toContain("OUTSIDE_PROJECT_RULE")
  expect(extra.request.bot.workspacePath).toBe(extra.project)
})

it.each(["last", "middle"])(
  "rejects %s symlink mappings under the primary root before reading outside AGENTS",
  async (mode) => {
    const f = await fixture({
      mappings: (project) => [join(project, mode === "last" ? "linked" : "linked/nested")]
    })
    await mkdir(join(f.outside, "nested"))
    await writeFile(join(f.outside, "nested/AGENTS.md"), "EXTERNAL_NESTED_RULE")
    await symlink(
      f.outside,
      join(f.project, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(f.prepare()).rejects.toThrow("不跟随符号链接")
    expect(f.store.db.exec("SELECT * FROM bot_harness_run_contexts")[0]?.values ?? []).toEqual([])
  }
)

it("retains mapping identities and rejects replacement by a junction even to the same original repository", async () => {
  const f = await fixture({ mappings: (project) => [join(project, "module")] })
  await mkdir(join(f.project, "module"))
  await writeFile(join(f.project, "module/AGENTS.md"), "MODULE_RULE")
  const prepared = (await f.prepare())!
  expect(prepared.instructionPrompt).toContain("MODULE_RULE")
  await rename(join(f.project, "module"), join(f.outside, "original-module"))
  await symlink(
    join(f.outside, "original-module"),
    join(f.project, "module"),
    process.platform === "win32" ? "junction" : "dir"
  )
  expect(() => assertBotHarnessContext(prepared)).toThrow("项目绑定")
  await expect(f.prepare()).rejects.toThrow("项目绑定")
})

it("revalidates source configuration after an approval before starting a plugin command", async () => {
  const f = await fixture({ dynamic: true })
  await expect(
    f.provider.prepare(
      f.request,
      f.snapshot,
      async (id, action, operation, before) => {
        await writeBotModelSnapshot(f.modelFile, {
          ...f.snapshot,
          execution: { ...f.snapshot.execution!, windowsSandbox: "readonly" }
        })
        return f.approve(id, action, operation, before)
      },
      f.check
    )
  ).rejects.toThrow("项目绑定")
  expect(f.calls).not.toHaveBeenCalled()
  expect(f.store.effects(f.request.run.id)).toEqual([])
})

it("fails closed on declined or incomplete inspection instead of persisting a usable project context", async () => {
  const declined = await fixture({ dynamic: true })
  await expect(
    declined.provider.prepare(
      declined.request,
      declined.snapshot,
      async () => "用户拒绝",
      declined.check
    )
  ).rejects.toThrow("未授权")
  expect(declined.calls).not.toHaveBeenCalled()
  const incomplete = await fixture({ dynamic: true })
  incomplete.calls.mockResolvedValue({
    exitCode: 0,
    truncated: true,
    output: "",
    hook: { stdout: '{"ok":true}', stderr: "" }
  })
  await expect(incomplete.prepare()).rejects.toThrow("未取得完整结果")
  expect(incomplete.store.effects(incomplete.request.run.id)[0].status).toBe("unknown")
  expect(
    incomplete.store.db.exec("SELECT * FROM bot_harness_run_contexts")[0]?.values ?? []
  ).toEqual([])
})

it("reuses the original role registry in workflows with pinned custom-role files and disabled builtins", async () => {
  const f = await fixture({ dynamic: true })
  const role = join(f.plugin, "reviewer.md")
  await writeFile(
    role,
    "---\nname: ProjectReviewer\ndescription: Bound project review\n---\nPROJECT_REVIEWER_RULE"
  )
  f.calls.mockResolvedValue({
    exitCode: 0,
    truncated: false,
    output: "",
    hook: {
      stdout: JSON.stringify({
        ok: true,
        sessionContext: "PLUGIN_PROJECT_RULE",
        agentConfig: {
          subagentConfig: {
            disabledBuiltinSubagents: ["Explore"],
            customSubagentFiles: ["reviewer.md"]
          }
        }
      }),
      stderr: ""
    }
  })
  await f.prepare()
  const definition = await prepareBotWorkflow(
    { request: f.request, modelFile: f.modelFile },
    {
      script: 'export const meta={name:"Review",description:"Review"}; return 1;',
      maxConcurrency: 1
    }
  )
  expect(definition.agentProfiles.some((profile) => profile.name === "Explore")).toBe(false)
  expect(JSON.stringify(definition.agentProfiles)).toContain("PROJECT_REVIEWER_RULE")
  await writeFile(role, "CHANGED_ROLE")
  await expect(
    prepareBotWorkflow(
      { request: f.request, modelFile: f.modelFile },
      {
        script: 'export const meta={name:"Review",description:"Review"}; return 1;',
        maxConcurrency: 1
      }
    )
  ).rejects.toThrow("项目绑定")
})

it("rejects custom role paths beyond project/plugin/explicit instruction roots", async () => {
  const f = await fixture({ dynamic: true })
  await writeFile(join(f.outside, "role.md"), "PRIVATE_ROLE")
  f.calls.mockResolvedValue({
    exitCode: 0,
    truncated: false,
    output: "",
    hook: {
      stdout: JSON.stringify({
        ok: true,
        sessionContext: "RULE",
        agentConfig: {
          subagentConfig: {
            disabledBuiltinSubagents: [],
            customSubagentFiles: [join(f.outside, "role.md")]
          }
        }
      }),
      stderr: ""
    }
  })
  await expect(f.prepare()).rejects.toThrow("角色文件超出授权目录")
  expect(f.store.db.exec("SELECT * FROM bot_harness_run_contexts")[0]?.values ?? []).toEqual([])
})

it("provides project skill visibility before the first run, and enforces the same boundary on direct skill reads", async () => {
  const f = await fixture()
  const skill = (
    name: string,
    pluginId: string | null,
    isProjectModePlugin: boolean | undefined
  ): BotExternalSkill => ({
    id: `desktop:${name.padEnd(64, "0")}`,
    catalogId: name,
    name,
    description: "",
    instructions: "STEPS",
    sha256: "a".repeat(64),
    fileStamp: "fixture",
    filePath: join(f.plugin, `${name}.md`),
    catalogPath: join(f.plugin, `${name}.md`),
    rootPath: f.plugin,
    resources: [],
    compatibility: "",
    pluginId,
    pluginName: pluginId === "plugin-one" ? "Bound plugin" : "Other plugin",
    isProjectModePlugin,
    source: "user"
  })
  const skills = [
    skill("a", "plugin-one", true),
    skill("b", "plugin-two", true),
    skill("c", null, false),
    skill("d", "normal-plugin", false),
    skill("e", "legacy-plugin", undefined)
  ]
  f.store.externalSkills.apply({ skills, warnings: [], truncated: false })
  expect(f.store.externalSkills.list(f.request.bot.id).map((item) => item.name)).toEqual(["c", "d"])
  await f.provider.refreshSkillScopes(f.store, f.snapshot, f.request.signal)
  expect(f.calls).not.toHaveBeenCalled()
  expect(f.store.externalSkills.list(f.request.bot.id).map((item) => item.name)).toEqual([
    "a",
    "c",
    "d"
  ])
  expect(f.store.externalSkills.source(f.request.bot.id, skills[0].id, 1).name).toBe("a")
  for (const index of [1, 4])
    expect(() => f.store.externalSkills.source(f.request.bot.id, skills[index].id, 1)).toThrow(
      "未绑定"
    )
  await writeFile(f.configPath, JSON.stringify({ ...f.config, apiVersion: 2 }))
  expect(f.store.externalSkills.list(f.request.bot.id).map((item) => item.name)).toEqual(["c", "d"])
  await f.provider.refreshSkillScopes(f.store, f.snapshot, f.request.signal)
  expect(f.store.db.exec("SELECT * FROM bot_harness_skill_scopes")[0]?.values ?? []).toEqual([])
})

it("rejects disabled plugins, archived projects and linked catalog files in the shared catalog reader", async () => {
  const f = await fixture()
  const input = { sources: f.snapshot.harnessSources, binding: f.request.bot.harnessBinding }
  expect((await readBotHarnessCatalog(input)).context.project.projectId).toBe("project-one")
  await writeFile(
    join(f.catalog, "plugins.json"),
    JSON.stringify([
      { id: "plugin-one", name: "Bound plugin", version: "1", path: f.plugin, enabled: false }
    ])
  )
  await expect(readBotHarnessCatalog(input)).rejects.toThrow("不可用")
  await rm(join(f.catalog, "plugins.json"))
  await writeFile(join(f.outside, "plugins.json"), "[]")
  await symlink(join(f.outside, "plugins.json"), join(f.catalog, "plugins.json"))
  await expect(readBotHarnessCatalog(input)).rejects.toThrow("不能使用链接")
})

it("propagates only project attribution fields to real Hook assembly, without prompt or grants", async () => {
  const f = await fixture({ dynamic: true })
  await writeFile(
    join(f.catalog, "hooks.json"),
    JSON.stringify([
      {
        id: "project-hook",
        enabled: true,
        event: "UserPromptSubmit",
        matcher: "*",
        command: "node project-hook.cjs"
      }
    ])
  )
  f.snapshot.hookSources = { root: f.catalog }
  await writeBotModelSnapshot(f.modelFile, f.snapshot)
  const prepared = await f.prepare()
  f.calls.mockResolvedValue({
    exitCode: 0,
    truncated: false,
    output: "{}",
    hook: { stdout: "{}", stderr: "" }
  })
  const hooks = new BotSkillHooks(
    f.request,
    f.modelFile,
    f.snapshot,
    f.shell,
    f.check,
    f.approve,
    undefined,
    prepared,
    () => f.provider.assertCurrent(prepared!, f.request.signal)
  )
  await hooks.run("UserPromptSubmit", { userPrompt: "Review project" }, "prompt-submit")
  const input = f.calls.mock.calls.at(-1)![0]
  const context = JSON.parse(input.hook!.stdin)
  expect(context).toMatchObject({
    harness_project_id: "project-one",
    feature_id: "feature-one",
    harness_adapter_name: "Bound plugin",
    harness_adapter_version: "1.0",
    project_code: "P1",
    harness_node_name: "Quality-Code review",
    harness_node_status: "已完成"
  })
  expect(input.hook?.env).toMatchObject({
    HARNESS_PROJECT_ID: "project-one",
    FEATURE_ID: "feature-one"
  })
  expect(input.hook!.stdin).not.toContain("PLUGIN_PROJECT_RULE")
  expect(context).not.toHaveProperty("instructionWorkspacePaths")
  expect(input.hook!.stdin).not.toContain(f.secret)
})

it("inherits pinned context into a workflow child without another inspection or broader file authority", async () => {
  const f = await fixture({ dynamic: true })
  const parent = await f.prepare()
  const workflow = BotWorkflowStore.open(f.store, f.request.lease, "review-workflow", {
    script: 'export const meta={name:"Review",description:"Review"};return 1;',
    maxConcurrency: 1,
    defaultModelId: "test",
    agentProfiles: [],
    authority: {}
  })
  const child = f.store.workflowChildren.claim(workflow, f.request.lease, {
    prompt: "Review only",
    agentIndex: 1,
    toolStreamKey: `${"a".repeat(64)}_c1`,
    durableCallKey: `${"a".repeat(64)}_n1`,
    label: "Review",
    phase: null,
    shellAccess: "read_only"
  })
  const request: BotRuntimeRequest = { ...f.request, run: child.run, lease: child.lease! }
  expect(
    await f.provider.prepare(
      request,
      f.snapshot,
      async () => {
        throw new Error("unexpected child approval")
      },
      () => f.store.assertLease(request.lease)
    )
  ).toEqual(parent)
  expect(f.calls).toHaveBeenCalledTimes(2)
  expect(request.bot.workspacePath).toBe(f.project)
  const contexts = f.store.db.exec("SELECT run_id FROM bot_harness_run_contexts")[0].values.flat()
  expect(contexts).toContain(child.run.id)
})

it("allows unrelated project/feature changes while keeping the original context and completed inspect receipts", async () => {
  const f = await fixture({ dynamic: true })
  const prepared = (await f.prepare())!
  const { readFile } = await import("node:fs/promises")
  const projectsPath = join(f.catalog, "harness-board-projects.json")
  const projects = JSON.parse(await readFile(projectsPath, "utf8"))
  projects.projects.push({
    ...projects.projects[0],
    projectId: "unrelated-project",
    systemId: "other-system"
  })
  await writeFile(projectsPath, JSON.stringify(projects))
  const featurePath = join(f.catalog, FEATURE_V2_FILE)
  const features = JSON.parse(await readFile(featurePath, "utf8"))
  features.bindings.push({
    projectId: "unrelated-project",
    featureId: "other-feature",
    selectedDeployUnitMappings: []
  })
  features.bindings[0].progress = "complete"
  await writeFile(featurePath, JSON.stringify(features))
  await f.provider.assertCurrent(prepared, f.request.signal)
  expect(await f.prepare()).toEqual(prepared)
  expect(f.calls).toHaveBeenCalledTimes(2)
  projects.projects[0].systemId = "changed-current-system"
  await writeFile(projectsPath, JSON.stringify(projects))
  await expect(f.provider.assertCurrent(prepared, f.request.signal)).rejects.toThrow("项目绑定")
})

it("rejects a changed current project while waiting for inspect approval before any command starts", async () => {
  const f = await fixture({ dynamic: true })
  const { readFile } = await import("node:fs/promises")
  await expect(
    f.provider.prepare(
      f.request,
      f.snapshot,
      async (id, action, operation, before) => {
        const path = join(f.catalog, "harness-board-projects.json")
        const projects = JSON.parse(await readFile(path, "utf8"))
        projects.projects[0].systemId = "revoked"
        await writeFile(path, JSON.stringify(projects))
        return f.approve(id, action, operation, before)
      },
      f.check
    )
  ).rejects.toThrow("项目绑定")
  expect(f.calls).not.toHaveBeenCalled()
  expect(f.store.effects(f.request.run.id)).toEqual([])
})

it("awaits revocation at direct native and Hook dispatch instead of trusting a previously valid context", async () => {
  const f = await fixture()
  const prepared = await f.prepare()
  const hooks = new BotSkillHooks(
    f.request,
    f.modelFile,
    f.snapshot,
    f.shell,
    f.check,
    f.approve,
    undefined,
    prepared,
    () => f.provider.assertCurrent(prepared!, f.request.signal)
  )
  const { readFile } = await import("node:fs/promises")
  const path = join(f.catalog, "harness-board-projects.json")
  const projects = JSON.parse(await readFile(path, "utf8"))
  projects.projects[0].lifecycle.status = "archived"
  await writeFile(path, JSON.stringify(projects))
  const execute = vi.fn(async () => "READ_ONLY_SECRET")
  await expect(
    hooks.dispatchNative("project_read", { path: "private.txt" }, "native-read", execute)
  ).rejects.toThrow("项目绑定")
  expect(execute).not.toHaveBeenCalled()
  await expect(
    hooks.run("UserPromptSubmit", { userPrompt: "Read project" }, "hook-attempt")
  ).rejects.toThrow("项目绑定")
  expect(f.calls).not.toHaveBeenCalled()
})

it.each(["unrelated", "revoke"])(
  "awaits project projection in the actual model/tool graph (%s)",
  async (mode) => {
    const f = await fixture()
    f.store.localTools.bind({
      target: { id: "a".repeat(64), label: "Fixture computer", platform: "darwin" },
      assertCurrent: vi.fn()
    })
    const local = f.store.localTools.read()
    f.store.localTools.change({
      nonce: "graph-local-always",
      targetId: local.target.id,
      dataEpoch: local.dataEpoch,
      revision: local.revision,
      choice: "always"
    })
    const { createServer } = await import("node:http")
    const { readFile } = await import("node:fs/promises")
    const { CmbBotRuntime } = await import("./agent-runtime")
    const { LocalBotComputerProvider } = await import("./computer-provider")
    const { BotArtifacts } = await import("./artifacts")
    const bodies: { messages: { role: string; content: unknown }[] }[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      bodies.push(body)
      const first = bodies.length === 1
      if (first) {
        const path = join(f.catalog, "harness-board-projects.json")
        const document = JSON.parse(await readFile(path, "utf8"))
        if (mode === "unrelated")
          document.projects.push({ ...document.projects[0], projectId: "unrelated-project" })
        else document.projects[0].lifecycle.status = "archived"
        await writeFile(path, JSON.stringify(document))
      }
      const message = first
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "project-read",
                type: "function",
                function: { name: "project_read", arguments: JSON.stringify({ path: "app.txt" }) }
              }
            ]
          }
        : { role: "assistant", content: "PROJECT_READ_VERIFIED" }
      const id = `chatcmpl-${bodies.length}`
      if (body.stream) {
        response.setHeader("Content-Type", "text/event-stream")
        const delta = first
          ? {
              role: "assistant",
              tool_calls: message.tool_calls!.map((call, index) => ({ index, ...call }))
            }
          : { role: "assistant", content: message.content }
        response.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\n`
        )
        response.end("data: [DONE]\n\n")
      } else {
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created: 1,
            model: "gpt-test",
            choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
          })
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
    const port = (server.address() as { port: number }).port
    f.snapshot.models[0].baseUrl = `http://127.0.0.1:${port}/v1`
    await writeBotModelSnapshot(f.modelFile, f.snapshot)
    await writeFile(join(f.project, "app.txt"), "APP_READ_EVIDENCE")
    const computer = new LocalBotComputerProvider(join(f.root, "browser"))
    cleanups.push(() => computer.close())
    const runtime = new CmbBotRuntime(f.modelFile, computer, {
      harness: f.provider,
      shell: f.shell,
      files: new BotArtifacts(join(f.root, "objects"), f.store)
    })
    if (mode === "unrelated") {
      expect(await runtime.execute(f.request)).toBe("PROJECT_READ_VERIFIED")
      expect(bodies).toHaveLength(2)
      expect(
        JSON.stringify(bodies[1].messages.filter((message) => message.role === "tool"))
      ).toContain("APP_READ_EVIDENCE")
    } else {
      await expect(runtime.execute(f.request)).rejects.toThrow("项目绑定")
      expect(bodies).toHaveLength(1)
    }
    expect(JSON.stringify(bodies[0].messages)).toContain("STATIC P1 feature-one")
    expect(JSON.stringify(bodies[0].messages)).toContain("PRIMARY_PROJECT_RULE")
    expect(JSON.stringify(bodies)).not.toContain(f.secret)
  },
  15000
)

it.each(["unrelated", "revoke"] as const)(
  "awaits pinned Harness at the actual Mods function model fetch (%s)",
  async (mode) => {
    const f = await fixture({ text: "/plugin model-proof", connectorIds: ["bot-mod:fixture"] })
    const prepared = (await f.prepare())!
    const { build } = await import("esbuild")
    const { createServer } = await import("node:http")
    const { writeFileSync, readFileSync } = await import("node:fs")
    const modelFactory = await import("../models/model-factory")
    const { BotModsRun } = await import("./mods-runtime")
    const { DEFAULT_MOD_POLICY } = await import("../mods/policy-core")
    const plugin = join(f.root, "function-plugin")
    await mkdir(resolve("output"), { recursive: true })
    // Match the original Mods fixtures: the worker's external QuickJS package
    // resolves from the repository runtime dependency directory.
    const workers = await mkdtemp(join(resolve("output"), "bot-harness-model-"))
    cleanups.push(() => rm(workers, { recursive: true, force: true }))
    await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
    await writeFile(
      join(plugin, "hooks/registered-tools.ts"),
      `export function register(on) {
    on("session.start", {}, async ($, e, next) => {
      await $.command.register({name:"model-proof", description:"Model proof", immediate:true}); return next(e);
    });
    on("command.run", {command:"model-proof"}, async ($) => ({text:await $.model.complete({model:"default", prompt:"MODEL_AUTHORITY_PROOF", maxTokens:64})}));
  }`
    )
    await build({
      entryPoints: {
        "mod-host": "src/main/mods/host-entry.ts",
        "function-mod-host": "src/main/mods/v2/host-entry.ts"
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outdir: workers,
      external: ["quickjs-emscripten"],
      logLevel: "silent"
    })
    let received = 0
    const server = createServer((_request, response) => {
      received++
      response.setHeader("Content-Type", "text/event-stream")
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "MODEL_AUTHORITY_PROOF" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`
      )
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
    )
    f.snapshot.models[0].baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    f.snapshot.mods = {
      enabled: true,
      policy: DEFAULT_MOD_POLICY,
      plugins: [{ id: "fixture", name: "Function fixture", enabled: true, path: plugin }]
    }
    await writeBotModelSnapshot(f.modelFile, f.snapshot)
    const current = () => f.provider.assertCurrent(prepared, f.request.signal)
    const mods = (await BotModsRun.open(
      f.request,
      f.modelFile,
      f.snapshot,
      f.approve,
      async (_action, operation) => operation(),
      f.check,
      [],
      workers,
      undefined,
      undefined,
      undefined,
      undefined,
      current
    ))!
    cleanups.push(() => mods.close())
    const create = modelFactory.createConfiguredCmbModel
    const spy = vi
      .spyOn(modelFactory, "createConfiguredCmbModel")
      .mockImplementation((config, options) => {
        const model = create(config, options)
        const path = join(f.catalog, "harness-board-projects.json")
        const document = JSON.parse(readFileSync(path, "utf8"))
        if (mode === "revoke") document.projects[0].lifecycle.status = "archived"
        else document.projects.push({ ...document.projects[0], projectId: "unrelated-project" })
        writeFileSync(path, JSON.stringify(document))
        return model
      })
    try {
      const result = mods.userCommand({ kind: "run", name: "model-proof", args: "" })
      if (mode === "revoke") {
        await expect(result).rejects.toThrow()
        expect(received).toBe(0)
        expect(
          f.store.db.exec("SELECT COUNT(*) FROM bot_workflow_model_calls")[0].values[0][0]
        ).toBe(0)
        expect(f.store.effects(f.request.run.id)).toMatchObject([{ status: "unknown" }])
      } else {
        await expect(result).resolves.toContain("MODEL_AUTHORITY_PROOF")
        expect(received).toBe(1)
        expect(f.store.db.exec("SELECT consumed FROM bot_workflow_model_calls")[0].values).toEqual([
          [5]
        ])
      }
    } finally {
      spy.mockRestore()
    }
  },
  15000
)

it("awaits current project authority for each workflow SDK file primitive after dispatch", async () => {
  const f = await fixture()
  const prepared = (await f.prepare())!
  const { BotArtifacts } = await import("./artifacts")
  const { botWorkflowFiles } = await import("./workflow-files")
  const { readFile } = await import("node:fs/promises")
  const workflow = BotWorkflowStore.open(f.store, f.request.lease, "sdk-workflow", {
    script: 'export const meta={name:"Read",description:"Read"};return 1;',
    maxConcurrency: 1,
    defaultModelId: "test",
    agentProfiles: [],
    authority: {}
  })
  const files = await botWorkflowFiles({
    request: f.request,
    workflow,
    artifacts: new BotArtifacts(join(f.root, "objects"), f.store),
    deniedRoots: [join(f.root, "host")],
    check: f.check,
    approve: f.approve,
    assertCurrent: () => f.provider.assertCurrent(prepared, f.request.signal)
  })
  const path = join(f.catalog, "harness-board-projects.json")
  const document = JSON.parse(await readFile(path, "utf8"))
  document.projects[0].lifecycle.status = "archived"
  await writeFile(path, JSON.stringify(document))
  for (const call of [
    () => files.read("AGENTS.md", f.request.signal, "read"),
    () => files.exists("AGENTS.md", f.request.signal, "exists"),
    () => files.glob("*", f.request.signal, "glob"),
    () => files.write("file.txt", "content", f.request.signal, "write")
  ])
    await expect(call()).rejects.toThrow("项目绑定")
  expect(f.store.effects(f.request.run.id)).toEqual([])
  await expect(readFile(join(f.project, "file.txt"))).rejects.toThrow()
})

it("does not open unused deploy-unit roots when the plugin provides complete project instructions", async () => {
  const f = await fixture({
    dynamic: true,
    mappings: (project) => [join(project, "missing-module")]
  })
  const prepared = await f.prepare()
  expect(prepared?.context.enableAgentsPrompt).toBe(false)
  expect(prepared?.context.sessionContextInjectWarning).toBeUndefined()
  expect(prepared?.rootIdentities).toHaveLength(2)
})

it("rejects truncated fallback instructions without storing an incomplete prepared context", async () => {
  const f = await fixture()
  await writeFile(join(f.project, "AGENTS.md"), "Project constraint ".repeat(12000))
  await expect(f.prepare()).rejects.toThrow("项目指令超过")
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_harness_run_contexts")[0].values[0][0]).toBe(0)
})

it("renews local read admission after a long inspect before reading fresh AGENTS, while pinned recovery reads no project files", async () => {
  const f = await fixture({ dynamic: true })
  f.store.localTools.bind({
    target: { id: "a".repeat(64), label: "本机", platform: "darwin" },
    assertCurrent: vi.fn()
  })
  const policy = f.store.localTools.read()
  f.store.localTools.change({
    nonce: "local-ask",
    targetId: policy.target.id,
    dataEpoch: policy.dataEpoch,
    revision: policy.revision,
    choice: "ask"
  })
  const gate = BotLocalToolGate.open(f.request)!
  const initial = gate.read()
  const first = f.store
    .snapshot()
    .interactions.find((item) => item.status === "pending" && item.localProjectAccess)!
  f.store.localTools.resolve({
    nonce: "allow-initial-read",
    id: first.id,
    revision: first.revision,
    targetId: policy.target.id,
    dataEpoch: policy.dataEpoch,
    resolution: "allow-once"
  })
  await initial
  // A completed inspect may follow a long human approval. Expire only the local
  // read permit, keeping this run's original lease and inspect receipt intact.
  f.calls.mockImplementationOnce(async () => {
    f.store.db.run("UPDATE bot_local_tool_requests SET record=json_set(record,'$.expiresAt',?)", [
      f.store.now() - 1
    ])
    return {
      exitCode: 0,
      truncated: false,
      output: "",
      hook: { stderr: "", stdout: JSON.stringify({ ok: false }) }
    }
  })
  let finished = false,
    admissions = 0
  const pending = f.provider
    .prepare(f.request, f.snapshot, f.approve, f.check, (signal) => {
      admissions++
      return gate.read(signal)
    })
    .finally(() => {
      finished = true
    })
  const deadline = Date.now() + 5000
  let card = f.store
    .snapshot()
    .interactions.find((item) => item.status === "pending" && item.localProjectAccess)
  while (!finished && !card && Date.now() < deadline) {
    await delay(10)
    card = f.store
      .snapshot()
      .interactions.find((item) => item.status === "pending" && item.localProjectAccess)
  }
  expect(finished).toBe(false)
  expect(card).toBeDefined()
  const current = f.store.localTools.read()
  f.store.localTools.resolve({
    nonce: "renew-after-inspect",
    id: card!.id,
    revision: card!.revision,
    targetId: current.target.id,
    dataEpoch: current.dataEpoch,
    resolution: "allow-once"
  })
  const prepared = await pending
  expect(prepared?.instructionPrompt).toContain("PRIMARY_PROJECT_RULE")
  const count = admissions
  f.store.db.run("UPDATE bot_local_tool_requests SET record=json_set(record,'$.expiresAt',?)", [
    f.store.now() - 1
  ])
  expect(
    await f.provider.prepare(f.request, f.snapshot, f.approve, f.check, (signal) => {
      admissions++
      return gate.read(signal)
    })
  ).toEqual(prepared)
  expect(admissions).toBe(count)
  expect(f.calls).toHaveBeenCalledTimes(2)
}, 15000)
