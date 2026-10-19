import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginHookMetadata } from "../types"
const state = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{
    id: string
    name: string
    version: string
    enabled: boolean
    path: string
  }>,
  sources: [] as Array<{ pluginId: string; capabilityId: string; packageDigest: string }>,
  revision: "v1",
  hooks: [] as PluginHookMetadata[],
  classic: vi.fn(),
  thread: { created_at: 1, metadata: "{}" },
  project: true
}))
vi.mock("../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: async () => ({ id: "original", type: "plugin" })
}))
vi.mock("../db", () => ({ getThreadCore: () => state.thread }))
vi.mock("../storage", () => ({
  getPlugins: () => state.plugins,
  getOpenworkDir: () => state.root,
  parsePluginHooks: () => state.hooks,
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined,
  parseMcpJsonFile: () => null
}))
vi.mock("../mods/project-capability-context", () => ({
  captureProjectCapabilityContext: () => ({
    projectId: "parent",
    identity: "scope",
    assertCurrent: () => {
      if (!state.project) throw Error("scope-changed")
    }
  })
}))
vi.mock("./project-capability-selection", () => ({
  readProjectCapabilitySelection: () => ({ sources: state.sources, revision: state.revision })
}))
vi.mock("../mcp/capability-service", () => ({ closeProjectCapabilityMcpService: vi.fn() }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({
    isEnabled: () => true,
    classicEvent: state.classic
  })
}))
vi.mock("../hooks/log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { registerProjectCapabilityRuntimeAdmission } from "./project-capability-admission"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import {
  registerAgentRunImplementation,
  startAgentRun,
  type AgentRunDelivery
} from "../agent/agent-run-service"
import {
  currentRuntimeCapabilitySources,
  currentRuntimePluginSource,
  assertCurrentRuntimePluginSourceContent
} from "./runtime-source-scope"
import { withPinnedAutobiz } from "../mods/v2/autobiz-source"
import { runHooks } from "../hooks/runner"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import {
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  wrapProjectRuntimeManifest
} from "../../shared/project-runtime"
import { reviewedAutobizRequiredHookIds } from "./autobiz-required-hooks"
let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  if (state.root) rmSync(state.root, { recursive: true, force: true })
  state.sources = []
  state.plugins = []
  state.project = true
  state.revision = "v1"
  state.hooks = []
})

it("protects the real original AutoBiz project entrance without requiring an independent capability selection", async () => {
  await withPinnedAutobiz(undefined, async (source) => {
    state.root = mkdtempSync(join(tmpdir(), "autobiz-original-admission-"))
    const metadata = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"))
    state.plugins = [
      {
        id: "original",
        name: metadata.name,
        version: metadata.version,
        path: source,
        enabled: true
      }
    ]
    state.thread.metadata = JSON.stringify({
      workspacePath: state.root,
      harnessProjectSession: { projectId: "parent", kind: "project" },
      cmb_thread_incarnation: "inc"
    })
    const original = JSON.parse(readFileSync(join(source, "hooks/hooks.json"), "utf8"))
    const boardPath = join(source, "board_core/board_config.json")
    const board = JSON.parse(readFileSync(boardPath, "utf8"))
    writeFileSync(boardPath, JSON.stringify({ ...board, apiVersion: 2 }))
    const required = reviewedAutobizRequiredHookIds(original)
    writeFileSync(
      join(source, "devclaw.capabilities.json"),
      JSON.stringify({
        apiVersion: "devclaw.capabilities/v1",
        capabilities: [
          {
            id: "flow",
            title: "AutoBiz",
            kind: "flow",
            usage: "project",
            entry: "devclaw.project-runtime.json",
            requiredHooks: required
          }
        ]
      })
    )
    writeFileSync(
      join(source, "devclaw.stage-checks.json"),
      JSON.stringify({
        apiVersion: "devclaw.stage-check-adapter/v1",
        adapter: "autobiz-v1"
      })
    )
    writeFileSync(
      join(source, "devclaw.project-runtime.json"),
      JSON.stringify(
        wrapProjectRuntimeManifest(
          {
            apiVersion: "devclaw.project-runtime/v1",
            plugin: { id: metadata.name, version: metadata.version },
            mode: "legacy",
            stateOwner: "plugin",
            stages: [],
            actions: [],
            artifacts: [],
            checks: [],
            environment: [],
            capabilities: {
              execution: true,
              conditionalTransition: false,
              idempotency: false,
              reconciliation: false,
              cancellation: true
            }
          },
          {
            apiVersion: EXTENSION_CONTRACT_API_VERSION,
            requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
          }
        )
      )
    )
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("classic.PreToolUse",async()=>({allow:true}))
    }}`)
    const session = new FunctionSession(
      [{ name: "DIY", root: "/diy", tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
      {
        workspace: state.root,
        threadId: "thread",
        assertLive: () => undefined,
        publish: async (value) => value
      }
    )
    state.classic.mockImplementation((_w, _t, e, input, signal, core) =>
      session.classicEvent(e, input, signal, core)
    )
    state.hooks = ["PreToolUse", "PostToolUse"].flatMap((event) =>
      (original[event] ?? []).flatMap(
        (group: { matcher: string; hooks: Array<Record<string, unknown>> }, mi: number) =>
          group.hooks.map(
            (hook, hi) =>
              ({
                ...hook,
                id: `plugin:original/${event}:${typeof hook.id === "string" ? hook.id.trim() : `${mi}:${hi}`}`,
                pluginId: "original",
                pluginName: metadata.name,
                pluginRoot: source,
                pluginEnabled: true,
                hookPath: "hooks/hooks.json",
                hookSourceType: "plugin",
                hookSourceRoot: source,
                event,
                matcher: group.matcher,
                type: "command",
                enabled: true,
                timeout: 10_000,
                createdAt: "",
                updatedAt: ""
              }) as PluginHookMetadata
          )
      )
    )
    stop = registerProjectCapabilityRuntimeAdmission()
    let checked = false
    registerAgentRunImplementation(async () => {
      const binding = currentRuntimePluginSource()!
      expect(binding.preserveParentContext).toBe(true)
      expect(binding.plugin.path).not.toBe(source)
      expect(binding.requiredHooks).toEqual(required.map((id) => `plugin:original/${id}`))
      expect(currentRuntimeCapabilitySources()).toEqual([])
      const hooks = state.hooks.map((hook) => ({
        ...hook,
        pluginRoot: binding.plugin.path,
        hookSourceRoot: binding.plugin.path
      }))
      const result = await runHooks(hooks, "PreToolUse", {
        sessionId: "thread",
        workspacePath: state.root,
        toolName: "write_file",
        toolArgs: { file_path: join(state.root, ".autobizdevops/state.json"), content: "{}" }
      })
      expect(result?.blocked).toBe(true)
      expect(result?.reason).toContain("状态文件不允许")
      checked = true
      state.project = false
      expect(() => assertCurrentRuntimePluginSourceContent()).toThrow("scope-changed")
    })
    try {
      const delivery = {
        isAvailable: () => true,
        send: () => undefined,
        finish: vi.fn(),
        window: {}
      } as unknown as AgentRunDelivery
      const terminated = vi.fn()
      const run = await startAgentRun(
        { threadId: "thread", message: "Continue original AutoBiz" },
        delivery,
        { source: "desktop", onRunTerminated: terminated }
      )
      await expect(run.completion).rejects.toThrow("scope-changed")
      expect(terminated).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "unknown", code: "project_capability_cleanup_unconfirmed" })
      )
      expect(delivery.finish).toHaveBeenCalledWith("thread")
      expect(checked).toBe(true)
    } finally {
      await session.close()
    }
  })
}, 30_000)
it.each(["harnessProjectSession", "harnessFeature"])(
  "the real %s gateway preserves the original parent and selected snapshots",
  async (binding) => {
    state.root = mkdtempSync(join(tmpdir(), "capability-gateway-"))
    state.thread.metadata = JSON.stringify({
      workspacePath: state.root,
      [binding]: { projectId: "parent", kind: "project", slug: "feature" },
      cmb_thread_incarnation: "inc"
    })
    for (const id of ["original", "derived"]) {
      const path = join(state.root, id)
      mkdirSync(join(path, "skills", "review"), { recursive: true })
      writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: id, version: "1" }))
      writeFileSync(join(path, "skills/review/SKILL.md"), `# ${id}`)
      writeFileSync(
        join(path, "devclaw.capabilities.json"),
        JSON.stringify({
          apiVersion: "devclaw.capabilities/v1",
          capabilities: [
            {
              id: "review",
              title: "Review",
              kind: "skill",
              usage: "project",
              entry: "skills/review/SKILL.md"
            }
          ]
        })
      )
      const plugin = { id, name: id, version: "1", enabled: true, path }
      state.plugins.push(plugin)
      const catalog = await readNativeCapabilityCatalog(plugin, "project")
      state.sources.push({
        pluginId: id,
        capabilityId: "review",
        packageDigest: catalog.packageDigest!
      })
    }
    stop = registerProjectCapabilityRuntimeAdmission()
    let seen: string[] = []
    registerAgentRunImplementation(async () => {
      expect(currentRuntimePluginSource()?.preserveParentContext).toBe(true)
      expect(currentRuntimePluginSource()?.plugin.id).toBe("original")
      seen = currentRuntimeCapabilitySources()!.map((source) => source.plugin.id)
      expect(
        currentRuntimeCapabilitySources()!.every((source) =>
          source.plugin.path.includes("capability-packages")
        )
      ).toBe(true)
      state.revision = "v2"
      expect(() => assertCurrentRuntimePluginSourceContent()).toThrow("CONTEXT_CHANGED")
    })
    const delivery = {
      isAvailable: () => true,
      send: () => {},
      finish: vi.fn(),
      window: {}
    } as unknown as AgentRunDelivery
    const terminated = vi.fn()
    const run = await startAgentRun(
      { threadId: "thread", message: "Execute selected skills" },
      delivery,
      { source: "desktop", onRunTerminated: terminated }
    )
    await expect(run.completion).rejects.toThrow("CONTEXT_CHANGED")
    expect(terminated).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", code: "project_capability_cleanup_unconfirmed" })
    )
    expect(delivery.finish).toHaveBeenCalledWith("thread")
    expect(seen).toEqual(["original", "derived"])
    expect(currentRuntimeCapabilitySources()).toBeUndefined()
    state.thread.metadata = JSON.stringify({ workspacePath: state.root })
    registerAgentRunImplementation(async () => {
      expect(currentRuntimeCapabilitySources()).toBeUndefined()
    })
    await (
      await startAgentRun({ threadId: "chat", message: "Ordinary chat" }, delivery)
    ).completion
  }
)

it("does not resolve new scope or initialize snapshots for unconfigured old project sessions", async () => {
  state.sources = []
  state.project = false
  state.thread.metadata = JSON.stringify({
    workspacePath: "missing/old-workspace",
    harnessProjectSession: { projectId: "old" }
  })
  stop = registerProjectCapabilityRuntimeAdmission()
  registerAgentRunImplementation(async () => {
    expect(currentRuntimeCapabilitySources()).toBeUndefined()
  })
  const delivery = {
    isAvailable: () => true,
    send: () => {},
    window: {}
  } as unknown as AgentRunDelivery
  await (
    await startAgentRun({ threadId: "old", message: "Continue" }, delivery)
  ).completion
})

it("rejects a self-declared AutoBiz v2 parent before entering the original runtime", async () => {
  state.root = mkdtempSync(join(tmpdir(), "unreviewed-original-parent-"))
  const path = join(state.root, "plugin")
  mkdirSync(join(path, "board_core"), { recursive: true })
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: "unreviewed", version: "1" }))
  writeFileSync(join(path, "board_core/board_config.json"), '{"apiVersion":2,"inspectCommands":{}}')
  writeFileSync(join(path, "devclaw.capabilities.json"), JSON.stringify({
    apiVersion: "devclaw.capabilities/v1", capabilities: [{ id: "flow", title: "Flow", kind: "flow",
      usage: "project", entry: "devclaw.project-runtime.json", requiredHooks: ["guard"] }]
  }))
  writeFileSync(join(path, "devclaw.stage-checks.json"), JSON.stringify({
    apiVersion: "devclaw.stage-check-adapter/v1", adapter: "autobiz-v1"
  }))
  writeFileSync(join(path, "devclaw.project-runtime.json"), JSON.stringify(wrapProjectRuntimeManifest({
    apiVersion: "devclaw.project-runtime/v1", plugin: { id: "unreviewed", version: "1" },
    mode: "legacy", stateOwner: "plugin", stages: [], actions: [], artifacts: [], checks: [], environment: [],
    capabilities: { execution: true, conditionalTransition: false, idempotency: false, reconciliation: false, cancellation: true }
  }, { apiVersion: EXTENSION_CONTRACT_API_VERSION, requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL] })))
  state.plugins = [{ id: "original", name: "unreviewed", version: "1", path, enabled: true }]
  state.thread.metadata = JSON.stringify({ workspacePath: state.root,
    harnessProjectSession: { projectId: "parent" }, cmb_thread_incarnation: "inc" })
  stop = registerProjectCapabilityRuntimeAdmission()
  const execute = vi.fn(async () => undefined)
  registerAgentRunImplementation(execute)
  const delivery = { isAvailable: () => true, send: () => undefined, window: {} } as unknown as AgentRunDelivery
  await expect(startAgentRun({ threadId: "thread", message: "Run forged adapter" }, delivery))
    .rejects.toThrow("PROJECT_AUTOBIZ_PARENT_PROTOCOL_UNREVIEWED")
  expect(execute).not.toHaveBeenCalled()
})
