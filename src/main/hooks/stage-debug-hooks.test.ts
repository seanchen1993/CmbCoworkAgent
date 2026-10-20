import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginMetadata } from "../types"
import type { HookConfig } from "./types"
const state = vi.hoisted(() => ({ active: false, execute: vi.fn(), classic: vi.fn() }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({
    isActive: () => state.active,
    isEnabled: () => state.active,
    classicEvent: state.classic
  })
}))
vi.mock("./http-runner", () => ({ executeHttpHook: state.execute }))
import { runHooks } from "./runner"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
const roots: string[] = []
afterEach(() => {
  state.active = false
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(requiredHooks = ["mandatory"]) {
  const root = mkdtempSync(join(tmpdir(), "debug-hooks-"))
  roots.push(root)
  const workspace = join(root, "workspace"),
    source = join(root, "package")
  mkdirSync(workspace)
  mkdirSync(source)
  const token = issueRuntimePluginSourceToken({
    mode: "host",
    threadId: "thread",
    incarnationKey: "incarnation",
    projectId: "branch",
    operationId: "operation",
    workspace,
    packageDigest: "a".repeat(64),
    stageId: "review",
    stageDebug: { workspace, baselineId: "baseline" },
    requiredHooks,
    plugin: { id: "plugin", path: source } as PluginMetadata
  })
  return {
    workspace,
    run: (hooks: HookConfig[], event: HookConfig["event"] = "PreToolUse") =>
      withRuntimePluginSource(token, () =>
        runHooks(hooks, event, {
          workspacePath: workspace,
          sessionId: "thread",
          toolName: "write_file",
          toolArgs: { filePath: "result.txt" }
        })
      )
  }
}
describe("stage-debug original Hook admission", () => {
  it.each(["global", "workspace", "plugin", "skill"] as const)(
    "rejects a real matching %s Hook before any execution",
    async (hookSourceType) => {
      const f = fixture()
      const hook: HookConfig = {
        id: "mandatory",
        event: "PreToolUse",
        matcher: "write_file",
        type: "http",
        url: "https://invalid.example",
        enabled: true,
        hookSourceType,
        createdAt: "",
        updatedAt: ""
      }
      await expect(f.run([hook])).rejects.toThrow("PROJECT_STAGE_DEBUG_HOOK_UNSUPPORTED:PreToolUse")
      expect(state.execute).not.toHaveBeenCalled()
      expect(state.classic).not.toHaveBeenCalled()
    }
  )
  it("keeps nonmatching hooks inert and refuses dynamically enabled Function interception", async () => {
    const f = fixture([])
    const hook: HookConfig = {
      id: "unmatched",
      event: "PreToolUse",
      matcher: "execute",
      type: "http",
      url: "https://invalid.example",
      enabled: true,
      createdAt: "",
      updatedAt: ""
    }
    expect(await f.run([hook])).toBeNull()
    state.active = true
    await expect(f.run([])).rejects.toThrow("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    expect(state.execute).not.toHaveBeenCalled()
    expect(state.classic).not.toHaveBeenCalled()
  })
  it("still rejects a missing declared mandatory business check", async () => {
    const f = fixture()
    await expect(f.run([])).rejects.toThrow("REQUIRED_BUSINESS_CHECK_MISSING")
    expect(state.execute).not.toHaveBeenCalled()
    expect(state.classic).not.toHaveBeenCalled()
  })
})
