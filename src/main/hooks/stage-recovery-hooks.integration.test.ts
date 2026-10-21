import { once } from "node:events"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import type { HookConfig } from "./types"
import { runHooks, resetHookOnceStateForTests } from "./runner"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import {
  configureStageRecoveryHookJournal,
  StageRecoveryHookJournal
} from "./stage-recovery-journal"
import { createHash } from "node:crypto"

const state = vi.hoisted(() => ({ baseUrl: "" }))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: () => ({
    id: "recovery",
    model: "recovery",
    apiKey: "fixture-only",
    baseUrl: state.baseUrl,
    maxOutputTokens: 64
  }),
  getModelConfigByRef: () => undefined
}))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: true }),
  getUserInfo: () => undefined
}))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../mods/builtins/policy-decisions", () => ({ observeBuiltinPolicyDecision: vi.fn() }))

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  resetHookOnceStateForTests()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-recovery-hooks-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "branch"),
    source = join(root, "source")
  mkdirSync(workspace)
  mkdirSync(source)
  mkdirSync(join(source, "hooks"))
  const sourcePath = join(source, "hooks/hooks.json"),
    bytes = "original exact hook source"
  writeFileSync(sourcePath, bytes)
  let decision = "block"
  const requests: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: "actual-recovery-hook",
        object: "chat.completion",
        created: 1,
        model: "recovery",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                decision,
                ...(decision === "block" ? { reason: "artifact quality must be fixed" } : {})
              })
            },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      })
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  state.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const settings = new Map<string, string>()
  const journal = new StageRecoveryHookJournal({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    compareAndSetSetting: (key, expected, next) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, next)
      return true
    }
  })
  configureStageRecoveryHookJournal({
    begin: (source, originalHook) =>
      journal.begin(
        {
          projectId: source.projectId,
          operationId: source.operationId,
          threadId: source.threadId,
          baselineId: "baseline",
          packageDigest: source.packageDigest,
          stageId: source.stageId,
          policyDigest: "b".repeat(64),
          hookDigest: createHash("sha256").update(JSON.stringify(originalHook)).digest("hex")
        },
        () => {}
      ),
    unresolved: (projectId, operationId) => journal.hasUnresolved(projectId, operationId)
  })
  const hook = {
    id: "plugin:retained/check",
    event: "PostSkillUse",
    enabled: true,
    type: "prompt",
    prompt: "Verify the actual stage output",
    fallback: "block",
    hookSourceType: "plugin",
    hookSourceRoot: source,
    hookSourcePath: sourcePath,
    createdAt: "",
    updatedAt: "",
    pluginId: "retained",
    pluginName: "retained",
    pluginRoot: source
  } satisfies HookConfig & {
    pluginId: string
    pluginName: string
    pluginRoot: string
  }
  const run = (
    thread: string,
    hooks: HookConfig[] = [hook],
    required = true,
    commandHooks = false,
    signal?: AbortSignal
  ) => {
    const token = issueRuntimePluginSourceToken(
      {
        mode: "host",
        threadId: thread,
        incarnationKey: thread,
        projectId: thread,
        operationId: "operation",
        workspace,
        packageDigest: "a".repeat(64),
        stageId: "review",
        stageDebug: {
          workspace,
          baselineId: "baseline",
          allowPromptHooks: true,
          ...(commandHooks
            ? {
                commandHooks: {
                  readOnlyRoots: [source],
                  networkAccess: "explicitly-approved" as const
                }
              }
            : {})
        },
        requiredHooks: required ? ["check"] : [],
        plugin: { id: "retained", path: source } as PluginMetadata
      },
      () => {
        if (readFileSync(sourcePath, "utf8") !== bytes) throw Error("PINNED_SOURCE_CHANGED")
      }
    )
    return withRuntimePluginSource(token, () =>
      runHooks(hooks, "PostSkillUse", {
        workspacePath: workspace,
        sessionId: thread,
        skillName: "review",
        toolResult: "actual stage result",
        signal
      })
    )
  }
  return {
    hook,
    run,
    requests,
    sourcePath,
    source,
    workspace,
    journal,
    allow: () => {
      decision = "allow"
    }
  }
}

it("reruns the retained mandatory gate through the real model client, keeps denials, and refuses a missing check", async () => {
  const f = await fixture()
  const blocked = await f.run("branch-first")
  expect(blocked?.blocked).toBe(true)
  expect(blocked?.reason).toContain("artifact quality")
  expect(f.requests).toHaveLength(1)
  f.allow()
  expect((await f.run("branch-revised"))?.blocked).toBe(false)
  expect(f.requests).toHaveLength(2)
  expect(JSON.stringify(f.requests)).toContain("Verify the actual stage output")
  await expect(f.run("branch-missing", [])).rejects.toThrow("REQUIRED_BUSINESS_CHECK_MISSING")
  expect(f.requests).toHaveLength(2)
  writeFileSync(f.sourcePath, "changed hook source")
  const tampered = await f.run("branch-tampered")
  expect(tampered?.blocked).toBe(true)
  expect(tampered?.reason).toContain("PINNED_SOURCE_CHANGED")
  expect(f.requests).toHaveLength(2)
})

it("gives a new branch its own once lifecycle instead of importing the old branch's consumed result", async () => {
  const f = await fixture()
  f.allow()
  const onceHook = { ...f.hook, once: true }
  await f.run("old-branch", [onceHook], false)
  await f.run("old-branch", [onceHook], false)
  expect(f.requests).toHaveLength(1)
  await f.run("new-branch", [onceHook], false)
  expect(f.requests).toHaveLength(2)
})

it.runIf(process.platform === "win32")(
  "executes the original mandatory command gate under recovery confinement and preserves its failure and real stdin",
  async () => {
    const f = await fixture()
    const script = join(f.source, "actual-check.ps1")
    writeFileSync(
      script,
      "$raw=[Console]::In.ReadToEnd();[IO.File]::WriteAllText((Join-Path $env:WORKSPACE_PATH 'hook-input.json'),$raw);" +
        "if(!(Test-Path (Join-Path $env:WORKSPACE_PATH 'artifacts-valid.txt'))){[Console]::Error.WriteLine('actual artifact missing');exit 2};" +
        '[Console]::WriteLine(\'{"decision":"allow"}\');exit 0'
    )
    const hook: HookConfig = {
      ...f.hook,
      type: "command",
      prompt: undefined,
      command: `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`
    }
    expect((await f.run("command-missing", [hook], true, true))?.blocked).toBe(true)
    const input = JSON.parse(readFileSync(join(f.workspace, "hook-input.json"), "utf8"))
    expect(input.hook_event_name).toBe("PostSkillUse")
    expect(input.cwd).toBe(f.source)
    expect(input.workspace_path).toBe(f.workspace)
    expect(input.skill_name).toBe("review")
    writeFileSync(join(f.workspace, "artifacts-valid.txt"), "actual repaired output")
    const passed = await f.run("command-revised", [hook], true, true)
    expect(passed?.blocked).toBe(false)
    expect(passed?.exitCode).toBe(0)
    expect(f.journal.list("command-missing")).toMatchObject([{ phase: "settled", exitCode: 2 }])
    expect(f.journal.list("command-revised")).toMatchObject([{ phase: "settled", exitCode: 0 }])
    expect(f.requests).toHaveLength(0)
  },
  20000
)

it.runIf(process.platform === "win32")(
  "persists actual cancelled command uncertainty and reaps its child before any recovery can pass",
  async () => {
    const f = await fixture()
    const script = join(f.source, "cancelled-check.ps1")
    writeFileSync(
      script,
      "[IO.File]::WriteAllText((Join-Path $env:WORKSPACE_PATH 'started.txt'),'actual');" +
        "Start-Sleep -Seconds 30;[IO.File]::WriteAllText((Join-Path $env:WORKSPACE_PATH 'late.txt'),'unsafe');exit 0"
    )
    const hook: HookConfig = {
      ...f.hook,
      type: "command",
      prompt: undefined,
      command: `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`
    }
    const controller = new AbortController()
    const execution = f.run("command-cancelled", [hook], true, true, controller.signal)
    const deadline = Date.now() + 10000
    try {
      while (!existsSync(join(f.workspace, "started.txt")) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25))
      expect(existsSync(join(f.workspace, "started.txt"))).toBe(true)
    } finally {
      controller.abort()
      await execution.catch(() => {})
    }
    const [intent] = f.journal.list("command-cancelled")
    expect(intent.phase).toBe("unknown")
    expect(existsSync(join(f.workspace, "late.txt"))).toBe(false)
    await expect(
      f.journal.reconcile(
        "command-cancelled",
        intent.id,
        async (current) => f.journal.inspectPhysical(current),
        () => {}
      )
    ).resolves.toBe(false)
    const retry = await f.run("command-cancelled", [hook], true, true)
    expect(retry?.blocked).toBe(true)
    expect(retry?.reason ?? retry?.stderr).toContain("OUTCOME_UNCONFIRMED")
    expect(f.journal.list("command-cancelled")).toHaveLength(1)
  },
  20000
)
