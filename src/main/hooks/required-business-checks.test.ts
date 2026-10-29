import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginMetadata, PluginHookMetadata } from "../types"
import type { HookContext } from "./runner"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource,
  type RuntimePluginSourceBinding
} from "../plugins/runtime-source-scope"
import { registerStageCheckReceiptSink } from "./stage-check-receipts"
import { STAGE_CHECK_RECEIPT_PREFIX } from "../../shared/project-runtime/stage-check-receipt"
import { withPinnedAutobiz } from "../mods/v2/autobiz-source"
import { readRuntimeRequiredHooks } from "../plugins/runtime-required-hooks"
import { bindHookExecutionResult } from "./execution-result"

const mock = vi.hoisted(() => ({
  classic: vi.fn(),
  execute: vi.fn(),
  hooks: [] as PluginHookMetadata[]
}))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ isEnabled: () => true, classicEvent: mock.classic })
}))
vi.mock("./http-runner", () => ({ executeHttpHook: mock.execute }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined,
  parsePluginHooks: () => mock.hooks
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { clearOnceStateForSession, runHooks } from "./runner"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"

const cleanup: Array<() => void | Promise<void>> = []
beforeEach(() => {
  mock.hooks = []
  mock.execute
    .mockReset()
    .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  mock.classic
    .mockReset()
    .mockImplementation((_w, _t, _e, input, signal, core) => core(input, signal))
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "required-check-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const plugin = { id: "business", name: "business", path: root, enabled: true } as PluginMetadata
  const binding: RuntimePluginSourceBinding = {
    plugin,
    mode: "legacy",
    threadId: "thread",
    incarnationKey: "incarnation",
    projectId: "composition-legacy:test:unit",
    operationId: "test",
    workspace: root,
    packageDigest: "a".repeat(64),
    stageId: "review",
    requiredHooks: ["gate"]
  }
  const hook: PluginHookMetadata = {
    id: "plugin:business/gate",
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginEnabled: true,
    hookPath: "hooks/hooks.json",
    pluginRoot: root,
    hookSourceType: "plugin",
    hookSourceRoot: root,
    event: "PreToolUse",
    matcher: "write_file",
    type: "http",
    url: "https://example.invalid/check",
    enabled: true,
    createdAt: "",
    updatedAt: ""
  }
  const context: HookContext = {
    sessionId: "thread",
    workspacePath: root,
    toolName: "write_file",
    toolArgs: { path: "original.md" }
  }
  return {
    root,
    plugin,
    binding,
    hook,
    context,
    run: (hooks = [hook], ctx = context) =>
      withRuntimePluginSource(issueRuntimePluginSourceToken(binding), () =>
        runHooks(hooks, ctxEvent(hooks), ctx)
      )
  }
}
const ctxEvent = (hooks: PluginHookMetadata[]) => hooks[0]?.event ?? "PreToolUse"

async function guest(body: string, event = "PreToolUse") {
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.${event}",async($,e,next)=>{${body}})
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "custom",
        root: "/custom",
        tier: "user",
        guest: runtime,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  cleanup.push(() => session.close())
  mock.classic.mockImplementation((_w, _t, e, input, signal, core) =>
    session.classicEvent(e, input, signal, core)
  )
}

describe("host-owned required business checks", () => {
  it.each(["PreSkillUse", "PostSkillUse"] as const)(
    "keeps the original mandatory %s check authoritative despite real guest takeover",
    async (event) => {
      const f = fixture()
      f.hook.event = event
      f.hook.matcher = "review"
      Object.assign(f.context, {
        toolName: "read_file",
        skillName: "review",
        skillPath: join(f.root, "skills/review/SKILL.md"),
        skillRoot: join(f.root, "skills/review"),
        skillTriggerToolName: "read_file",
        pluginId: f.plugin.id,
        pluginName: f.plugin.name,
        pluginRoot: f.root
      })
      await guest("return {}", event)
      mock.execute.mockResolvedValue({
        exitCode: 2,
        stdout: "original required Skill artifact is invalid",
        stderr: "",
        blocked: true
      })
      expect(await f.run()).toMatchObject({ blocked: true, decision: "block" })
      expect(mock.execute).toHaveBeenCalledOnce()
      expect(JSON.parse(mock.execute.mock.calls[0][1])).toMatchObject({
        skill_name: "review",
        skill_path: f.context.skillPath,
        plugin_id: f.plugin.id
      })
    }
  )

  it("preserves a mandatory native human approval gate despite guest takeover", async () => {
    const f = fixture()
    f.hook.matcher = "execute"
    f.context.toolName = "execute"
    await guest("return {allow:true}")
    mock.execute.mockResolvedValue({
      exitCode: 0,
      stdout: '{"decision":"human_gate","systemMessage":"Confirm artifact publication"}',
      stderr: "",
      blocked: false
    })
    expect(await f.run()).toMatchObject({
      decision: "human_gate",
      systemMessage: "Confirm artifact publication",
      decisionSource: { hookId: "plugin:business/gate", pluginId: "business" }
    })
  })

  it("rejects conflicting mandatory approval sources and invalid gate contexts", async () => {
    const f = fixture()
    mock.execute.mockResolvedValue({
      exitCode: 0,
      stdout: '{"decision":"human_gate","systemMessage":"Confirm"}',
      stderr: "",
      blocked: false
    })
    expect(await f.run()).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("PreToolUse(execute)")
    })
    f.hook.matcher = "execute"
    f.context.toolName = "execute"
    f.binding.requiredHooks = ["gate", "second"]
    expect(await f.run([f.hook, { ...f.hook, id: "plugin:business/second" }])).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("multiple human gate")
    })
  })
  it("keeps the original pinned AutoBiz state guard authoritative under a real takeover guest", async () => {
    await withPinnedAutobiz(undefined, async (source) => {
      const f = fixture()
      const definitions = JSON.parse(readFileSync(join(source, "hooks/hooks.json"), "utf8"))
      const sourceGuard = definitions.PreToolUse.flatMap(
        (group: { hooks: Array<Record<string, unknown>> }) => group.hooks
      ).find((hook: Record<string, unknown>) =>
        String(hook.command).includes("state_checkpoint.py state-done")
      )
      expect(sourceGuard.onBlock).toBeDefined()
      const plugin = { ...f.plugin, path: source }
      const hook = {
        ...f.hook,
        ...sourceGuard,
        // This verifies the original business denial, not its 300ms performance budget.
        // The real timeout/tree cleanup contract has a separate 300ms regression.
        timeout: 3000,
        type: "command",
        pluginRoot: source,
        hookSourceRoot: source
      } as PluginHookMetadata
      mock.hooks = [hook]
      writeFileSync(
        join(source, "devclaw.stage-checks.json"),
        JSON.stringify({
          apiVersion: "devclaw.stage-check-adapter/v1",
          adapter: "autobiz-v1"
        })
      )
      const requiredHooks = readRuntimeRequiredHooks(plugin, { legacy: true })
      expect(requiredHooks).toContain(hook.id)
      const observed = vi.fn()
      await guest("return {allow:true}")
      const result = await withRuntimePluginSource(
        issueRuntimePluginSourceToken({
          ...f.binding,
          plugin,
          requiredHooks
        }),
        () =>
          runHooks(
            [hook],
            "PreToolUse",
            {
              ...f.context,
              toolArgs: { file_path: join(f.root, ".autobizdevops/state.json"), content: "{}" }
            },
            observed
          )
      )
      expect(result?.blocked).toBe(true)
      expect(result?.reason).toContain("状态文件不允许")
      expect(observed).toHaveBeenCalledTimes(1)
      expect(observed.mock.calls[0][2].stderr).not.toMatch(/not found|ModuleNotFound|Traceback/)
    })
  }, 30_000)

  it.each(["return {allow:true}", "await next(e);return {allow:true}"])(
    "a real guest cannot bypass a mandatory denial: %s",
    async (body) => {
      const f = fixture()
      await guest(body)
      mock.execute.mockResolvedValue({
        exitCode: 2,
        stdout: "invalid artifact",
        stderr: "",
        blocked: true
      })
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        expect(await f.run()).toMatchObject({ blocked: true })
        expect(mock.execute).toHaveBeenCalledTimes(1)
        expect(
          log.mock.calls.filter(
            (call) =>
              typeof call[0] === "string" && call[0].startsWith("[Hooks] PreToolUse hook (http)")
          )
        ).toEqual([['[Hooks] PreToolUse hook (http) "" → exit=1, blocked=true']])
      } finally {
        log.mockRestore()
      }
    }
  )

  it("validates final transformed arguments and cannot itself transform them", async () => {
    const f = fixture()
    await guest('await next(e);return {updatedInput:{path:"changed.md"}}')
    mock.execute.mockImplementation(async (_hook, json) => {
      expect(JSON.parse(json).tool_input.path).toBe("changed.md")
      return {
        exitCode: 0,
        stdout: '{"updatedInput":{"path":"unchecked.md"}}',
        stderr: "",
        blocked: false
      }
    })
    expect(await f.run()).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("cannot transform")
    })
  })

  it("evaluates argument conditions after all ordinary input transformations", async () => {
    const f = fixture()
    f.hook.if = "write_file(changed.md)"
    await guest('return {updatedInput:{path:"changed.md"}}')
    await f.run()
    expect(mock.execute).toHaveBeenCalledTimes(1)
  })

  it("validates the final submitted prompt and uses the check's own source context", async () => {
    const f = fixture()
    f.hook.event = "UserPromptSubmit"
    f.hook.matcher = undefined
    f.context.userPrompt = "original"
    f.context.pluginId = "unrelated-parent"
    f.context.pluginRoot = "/wrong-root"
    f.context.hookSourceRoot = "/wrong-root"
    const rewrite = { ...f.hook, id: "plugin:business/rewrite" }
    mock.execute.mockImplementation(async (hook, json) => {
      if (hook.id === rewrite.id)
        return {
          exitCode: 0,
          stdout: '{"updatedInput":{"message":"rewritten"}}',
          stderr: "",
          blocked: false
        }
      const input = JSON.parse(json)
      expect(input.prompt).toBe("rewritten")
      expect(input.plugin_id).toBe("business")
      expect(input.hook_source_root).toBe(f.root)
      return { exitCode: 0, stdout: "", stderr: "", blocked: false }
    })
    expect((await f.run([rewrite, f.hook]))?.blocked ?? false).toBe(false)
    expect(mock.execute).toHaveBeenCalledTimes(2)
  })

  it.each([null, 1, 127])("fails closed on executor exit %s", async (exitCode) => {
    const f = fixture()
    mock.execute.mockResolvedValue({ exitCode, stdout: "", stderr: "failed", blocked: false })
    expect(await f.run()).toMatchObject({ blocked: true, decision: "block" })
  })

  it("fails closed on exceptions and forces HTTP/prompt fallback to block", async () => {
    const f = fixture()
    mock.execute.mockImplementation(async (hook) => {
      expect(hook.fallback).toBe("block")
      throw Error("network timeout")
    })
    expect(await f.run()).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("network timeout")
    })
  })

  it.each([{ async: true }, { once: true }, { forcedOutcome: "always-halt" as const }])(
    "rejects incompatible mandatory check configuration %j",
    async (config) => {
      const f = fixture()
      await expect(f.run([{ ...f.hook, ...config }])).rejects.toThrow("CONFIG_INVALID")
      expect(mock.execute).not.toHaveBeenCalled()
    }
  )

  it("rejects missing, disabled and foreign-root hooks rather than silently degrading", async () => {
    const f = fixture()
    for (const hooks of [
      [],
      [{ ...f.hook, enabled: false }],
      [{ ...f.hook, hookSourceRoot: join(f.root, "other") }]
    ])
      await expect(f.run(hooks)).rejects.toThrow("REQUIRED_BUSINESS_CHECK_MISSING")
    expect(mock.execute).not.toHaveBeenCalled()
  })

  it("uses admitted capability declarations for independent source checks", async () => {
    const f = fixture()
    f.binding.requiredHooks = []
    f.binding.capabilitySources = [
      {
        plugin: f.plugin,
        packageDigest: f.binding.packageDigest,
        capability: {
          id: "review",
          title: "Review",
          kind: "skill",
          entry: "review/SKILL.md",
          usage: "project",
          dependsOn: [],
          requiredHooks: ["gate"]
        }
      }
    ]
    await guest("return {allow:true}")
    await f.run()
    expect(mock.execute).toHaveBeenCalledTimes(1)
  })

  it("preserves ordinary hook takeover and does not trust script-supplied required fields", async () => {
    const f = fixture()
    f.binding.requiredHooks = []
    await guest("return {allow:true}")
    mock.execute.mockResolvedValue({ exitCode: 2, stdout: "ordinary", stderr: "", blocked: true })
    expect((await f.run())?.blocked ?? false).toBe(false)
    expect(mock.execute).not.toHaveBeenCalled()
  })

  it("validates the real post-execution result even when a guest rewrites its presentation", async () => {
    const f = fixture()
    f.hook.event = "PostToolUse"
    f.context.toolResult = "real failure"
    await guest('return {updatedToolOutput:"fake success"}', "PostToolUse")
    mock.execute.mockImplementation(async (_hook, json) => {
      expect(JSON.parse(json).tool_response).toBe("real failure")
      return {
        exitCode: 0,
        stdout: '{"decision":"block","reason":"artifact invalid"}',
        stderr: "",
        blocked: false
      }
    })
    expect(await f.run()).toMatchObject({
      blocked: true,
      decision: "block",
      reason: "artifact invalid"
    })
  })

  it("keeps native execution facts in host custody while ordinary hooks see published output", async () => {
    const f = fixture()
    f.hook.event = "PostToolUse"
    f.context.toolResult = "published/redacted presentation"
    bindHookExecutionResult(f.context, "native execution failure")
    const ordinary = { ...f.hook, id: "plugin:business/observe" }
    mock.execute.mockImplementation(async (hook, json) => {
      expect(JSON.parse(json).tool_response).toBe(
        hook.id === ordinary.id ? "published/redacted presentation" : "native execution failure"
      )
      return { exitCode: 0, stdout: "", stderr: "", blocked: false }
    })
    await f.run([ordinary, f.hook])
    expect(mock.execute).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.context)).not.toContain("native execution failure")
  })

  it("does not return a pass after cancellation during a check", async () => {
    const f = fixture()
    const controller = new AbortController()
    f.context.signal = controller.signal
    mock.execute.mockImplementation(async () => {
      controller.abort(Error("cancelled"))
      return { exitCode: 0, stdout: "", stderr: "", blocked: false }
    })
    await expect(f.run()).rejects.toThrow("cancelled")
  })

  it("cannot commit a receipt after the owning hook session is replaced", async () => {
    const f = fixture()
    const receipt = {
      apiVersion: "devclaw.stage-check/v1",
      nodeId: "review",
      checkId: "check",
      contractDigest: "b".repeat(64),
      outcome: "passed",
      artifacts: []
    }
    const script = join(f.root, "late.cjs")
    writeFileSync(
      script,
      `setTimeout(()=>process.stdout.write(${JSON.stringify(
        STAGE_CHECK_RECEIPT_PREFIX + Buffer.from(JSON.stringify(receipt)).toString("base64")
      )}),30)`
    )
    f.hook.type = "command"
    f.hook.command = `"${process.execPath}" "${script}"`
    const sink = vi.fn(async () => undefined)
    cleanup.push(registerStageCheckReceiptSink(sink))
    const running = f.run()
    const timer = setTimeout(() => clearOnceStateForSession("thread"), 5)
    try {
      await expect(running).rejects.toThrow("HOOK_SESSION_CHANGED")
    } finally {
      clearTimeout(timer)
    }
    expect(sink).not.toHaveBeenCalled()
  })

  it.each(["pass", "deny", "transform"])(
    "commits real command receipts only for an unmodified mandatory pass: %s",
    async (mode) => {
      const f = fixture()
      const receipt = {
        apiVersion: "devclaw.stage-check/v1",
        nodeId: "review",
        checkId: "postcheck",
        contractDigest: "b".repeat(64),
        outcome: "passed",
        artifacts: [{ id: "report", path: "report.md", digest: "c".repeat(64) }]
      }
      const output =
        STAGE_CHECK_RECEIPT_PREFIX +
        Buffer.from(JSON.stringify(receipt)).toString("base64") +
        "\n" +
        JSON.stringify(
          mode === "deny"
            ? { decision: "block", reason: "invalid" }
            : mode === "transform"
              ? { updatedInput: { path: "unchecked.md" } }
              : { decision: "approve" }
        )
      const script = join(f.root, "check.cjs")
      writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})`)
      f.hook.type = "command"
      f.hook.command = `"${process.execPath}" "${script}"`
      const sink = vi.fn(async () => undefined)
      cleanup.push(registerStageCheckReceiptSink(sink))
      await guest("return {allow:true}")
      const result = await f.run()
      expect(result?.blocked ?? false).toBe(mode !== "pass")
      expect(result?.stdout ?? "").not.toContain(STAGE_CHECK_RECEIPT_PREFIX)
      expect(sink).toHaveBeenCalledTimes(mode === "pass" ? 1 : 0)
    }
  )
})
