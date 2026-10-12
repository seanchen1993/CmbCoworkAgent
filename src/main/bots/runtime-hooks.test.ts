// Each native lifecycle case starts several isolated command workers and may
// reopen SQLite; allow startup overhead without changing any product deadlines.
import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BotStore } from "./store"
import { BotSkillHooks } from "./skill-hooks"
import { BotSkillPrompts } from "./skill-prompts"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import type { BotRuntimeRequest } from "./host"
import type { HookConfig } from "../hooks/types"
import { HumanMessage } from "@langchain/core/messages"
import type { McpCapabilityTool } from "../mcp/capability-types"
import { BotSessionLifecycle } from "./session-lifecycle"
import { BotSkillFailure } from "./skill-failure"

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(
  global: Partial<HookConfig>[] = [],
  project?: Partial<HookConfig>,
  plugin?: Partial<HookConfig>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-configured-hooks-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  for (const path of ["data", "host", "project/.cmbdevclaw/hooks", "plugin/hooks"])
    await mkdir(join(root, path), { recursive: true })
  const globalFile = join(root, "data/hooks.json")
  await writeFile(
    globalFile,
    JSON.stringify(global.map((hook, index) => ({ id: String(index), enabled: true, ...hook })))
  )
  if (project)
    await writeFile(
      join(root, "project/.cmbdevclaw/hooks/gate.json"),
      JSON.stringify({ enabled: true, ...project })
    )
  await writeFile(
    join(root, "data/plugins.json"),
    JSON.stringify(
      plugin ? [{ id: "review", name: "Reviewer", path: join(root, "plugin"), enabled: true }] : []
    )
  )
  if (plugin)
    await writeFile(
      join(root, "plugin/hooks/hooks.json"),
      JSON.stringify([{ id: "plugin-gate", enabled: true, ...plugin }])
    )
  for (const owner of ["data", "project", "plugin"])
    await writeFile(
      join(root, owner, "gate.cjs"),
      `
      let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{
        const fs=require('fs'),p=require('path');
        fs.appendFileSync(p.join(process.env.WORKSPACE_PATH,'checks'),${JSON.stringify(owner)}+'\\n');
        fs.writeFileSync(p.join(process.env.WORKSPACE_PATH,${JSON.stringify(owner)}+'-context.json'),JSON.stringify({cwd:process.cwd(),input:JSON.parse(text)}));
        console.log(JSON.stringify({additionalContext:${JSON.stringify(owner + " verified")}}));
      });
    `
    )
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: null,
    models: [],
    hookSources: { root: join(root, "data") },
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  }
  const modelFile = join(root, "host/models.private")
  await writeBotModelSnapshot(modelFile, snapshot)
  let store = new BotStore(join(root, "host/state.sqlite"))
  cleanups.push(() => store.close())
  const owner = store.createBot({
    nonce: "owner",
    name: "Engineer",
    workspacePath: join(root, "project")
  })
  store.send({ nonce: "send", conversationId: owner.conversationId, text: "Review this project" })
  const claimed = store.claim("fixture")!
  const controller = new AbortController()
  const request = (): BotRuntimeRequest => ({
    ...claimed,
    store,
    bot: owner.bot,
    messages: [],
    signal: controller.signal
  })
  const actions: unknown[] = []
  let beforeApproval: (() => Promise<void>) | undefined
  const shell = await createTrustedBotShellTestRunner(cleanups)
  const adapter = () =>
    new BotSkillHooks(
      request(),
      modelFile,
      snapshot,
      shell,
      () => {
        controller.signal.throwIfAborted()
        store.assertLease(claimed.lease)
      },
      async (id, action, operation, beforeStart) => {
        actions.push(action)
        const interaction = store.requestInteraction(claimed.lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action
        })
        await beforeApproval?.()
        store.answerInteraction({
          id: interaction.id,
          revision: interaction.revision,
          answer: "approve"
        })
        await beforeStart?.()
        store.beginEffect(claimed.lease, { id, action, approvalId: interaction.id })
        const result = await operation()
        store.settleEffect(claimed.lease, id, "succeeded", result)
        return result
      }
    )
  return {
    root,
    modelFile,
    snapshot,
    globalFile,
    adapter,
    actions,
    request,
    store: () => store,
    beforeApproval: (fn: () => Promise<void>) => {
      beforeApproval = fn
    },
    checks: () => readFile(join(root, "project/checks"), "utf8"),
    reopen: () => {
      store.close()
      store = new BotStore(join(root, "host/state.sqlite"))
    }
  }
}

it("executes global and project checks through original command workers and replays completed receipts after database recovery", async () => {
  const f = await fixture(
    [{ event: "PreToolUse", matcher: "remember", command: "node gate.cjs", once: true }],
    { event: "PreToolUse", matcher: "remember", command: "node gate.cjs" },
    { event: "PreToolUse", command: "node gate.cjs" }
  )
  const context = { toolName: "remember", toolArgs: { text: "review" }, toolCallId: "call-1" }
  const result = await f.adapter().run("PreToolUse", context, "call-1")
  expect(result?.additionalContext).toContain("data verified")
  expect(result?.additionalContext).toContain("project verified")
  expect(await f.checks()).toBe("data\nproject\n")
  expect(f.actions).toHaveLength(2)
  const projectContext = JSON.parse(
    await readFile(join(f.root, "project/project-context.json"), "utf8")
  )
  expect(projectContext.cwd).toBe(join(f.root, "project"))
  f.reopen()
  await f.adapter().run("PreToolUse", context, "call-1")
  expect(await f.checks()).toBe("data\nproject\n")
  expect(f.actions).toHaveLength(2)
  await f.adapter().run("PreToolUse", { ...context, toolCallId: "call-2" }, "call-2")
  expect(await f.checks()).toBe("data\nproject\nproject\n")
}, 20_000)

it("checks real user input without a selected skill and does not grant unrelated plugin scope", async () => {
  const f = await fixture([{ event: "UserPromptSubmit", command: "node gate.cjs" }], undefined, {
    event: "PreSkillUse",
    command: "node gate.cjs"
  })
  const input = f
    .store()
    .message({ conversationId: f.request().run.conversationId, id: f.request().run.messageId })
  const prepared = await new BotSkillPrompts(f.request(), f.adapter()).prepare([
    new HumanMessage({ id: input.id, content: input.text })
  ])
  expect(prepared[0].content).toContain("data verified")
  await f.adapter().run("PreSkillUse", { skillName: "unrelated", pluginId: "other" }, "skill-other")
  expect(await f.checks()).toBe("data\n")
  await f.adapter().run("PreSkillUse", { skillName: "review", pluginId: "review" }, "skill-review")
  expect(await f.checks()).toBe("data\nplugin\n")
}, 20_000)

it("revokes an old approval before any effect when configuration changes and rejects changed configuration on recovery", async () => {
  const f = await fixture([{ event: "PreToolUse", command: "node gate.cjs" }])
  f.beforeApproval(async () => {
    await writeFile(f.globalFile, "[]")
  })
  await expect(
    f.adapter().run("PreToolUse", { toolName: "remember" }, "first")
  ).rejects.toMatchObject({ code: "hook_configuration_changed" })
  expect(f.store().effects(f.request().run.id)).toHaveLength(0)
  await expect(f.checks()).rejects.toMatchObject({ code: "ENOENT" })
  f.reopen()
  await expect(f.adapter().refresh()).rejects.toThrow()
  expect(f.actions).toHaveLength(1)
}, 20_000)

it("stops unsupported required lifecycle checks before invoking a tool", async () => {
  const f = await fixture([{ event: "PreCompact", command: "node gate.cjs" }])
  await expect(f.adapter().refresh()).rejects.toThrow()
  expect(f.actions).toHaveLength(0)
  await expect(f.checks()).rejects.toMatchObject({ code: "ENOENT" })
}, 20_000)

it("persists execution-session start and the original completion without repeating end checks after recovery", async () => {
  const f = await fixture([
    { event: "SessionStart", matcher: "startup", command: "node gate.cjs" },
    { event: "SessionEnd", matcher: "other", command: "node gate.cjs" }
  ])
  const session = () => new BotSessionLifecycle(f.request(), f.adapter())
  await session().start()
  f.reopen()
  await session().start()
  expect(await f.checks()).toBe("data\n")
  expect(await session().finish("Original reviewed answer")).toBe("Original reviewed answer")
  expect(await f.checks()).toBe("data\ndata\n")
  f.reopen()
  expect(session().pending()).toEqual({ content: "Original reviewed answer" })
  expect(await session().finish("Must not replace the answer")).toBe("Original reviewed answer")
  expect(await f.checks()).toBe("data\ndata\n")
  expect(f.actions).toHaveLength(2)
}, 20_000)

it("settles an enabled session-end check after model failure without converting failure into success", async () => {
  const f = await fixture([{ event: "SessionEnd", command: "node gate.cjs" }])
  const failure = () =>
    new BotSkillFailure(f.request(), f.adapter(), () => f.store().assertDispatch(f.request().lease))
  const captured = await failure().capture(new Error("Model unavailable"))
  expect(captured?.message).toBe("Model unavailable")
  await expect(failure().finish(captured!)).rejects.toThrow("Model unavailable")
  f.reopen()
  await expect(failure().finish(failure().read()!)).rejects.toThrow("Model unavailable")
  expect(await f.checks()).toBe("data\n")
  expect(f.actions).toHaveLength(1)
}, 20_000)

it("activates only a resolved connector's plugin, checks the concrete tool and restores that scope after reopening", async () => {
  const f = await fixture([], undefined, {
    event: "PreToolUse",
    matcher: "mcp__review__submit",
    command: "node gate.cjs"
  })
  const target: McpCapabilityTool = {
    capabilityId: "cap",
    toolId: "mcp__review__submit",
    toolName: "submit",
    providerKey: "plugin:review/server",
    providerAlias: "review",
    providerDisplayName: "Review",
    visibility: "lazy",
    pluginId: "review"
  }
  const executed: unknown[] = []
  const execute = async (args: Record<string, unknown>) => {
    executed.push(args)
    return "submitted"
  }
  expect(await f.adapter().dispatchMcp(target, { text: "review" }, "connector-1", execute)).toBe(
    "submitted"
  )
  expect(await f.checks()).toBe("plugin\n")
  expect(executed).toEqual([{ text: "review" }])
  f.reopen()
  await f.adapter().run("PreToolUse", { toolName: target.toolId }, "later")
  expect(await f.checks()).toBe("plugin\nplugin\n")
  expect(f.actions).toHaveLength(2)
}, 20_000)

it("runs actual project Setup before SessionStart and retains initialization across reopen", async () => {
  const f = await fixture([
    { event: "Setup", matcher: "init", command: "node gate.cjs" },
    { event: "SessionStart", matcher: "startup", command: "node gate.cjs" }
  ])
  await new BotSessionLifecycle(f.request(), f.adapter()).start()
  expect(f.actions.map((action) => (action as { hook: { event: string } }).hook.event)).toEqual([
    "Setup",
    "SessionStart"
  ])
  expect(await f.checks()).toBe("data\ndata\n")
  expect(f.store().db.exec("SELECT completed_at FROM bot_workspace_setup")[0].values[0][0]).toEqual(
    expect.any(Number)
  )
  f.reopen()
  await new BotSessionLifecycle(f.request(), f.adapter()).start()
  expect(await f.checks()).toBe("data\ndata\n")
}, 20_000)

it("does not mark failed Setup complete or start the session", async () => {
  const f = await fixture([
    { event: "Setup", command: "node gate.cjs" },
    { event: "SessionStart", command: "node gate.cjs" }
  ])
  await writeFile(
    join(f.root, "data/gate.cjs"),
    "process.stdin.resume();process.stdin.on('end',()=>{console.error('INIT_FAILED');process.exitCode=1})"
  )
  await expect(new BotSessionLifecycle(f.request(), f.adapter()).start()).rejects.toThrow(
    "INIT_FAILED"
  )
  expect(f.actions).toHaveLength(1)
  expect(f.store().db.exec("SELECT completed_at FROM bot_workspace_setup")[0].values).toEqual([
    [null]
  ])
}, 20_000)
