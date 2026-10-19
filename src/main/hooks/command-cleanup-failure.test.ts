import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginHookMetadata } from "../types"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

const mock = vi.hoisted(() => ({
  enabled: false,
  wrapped: false,
  duringCleanup: () => {},
  results: vi.fn(),
  spawn: vi.fn()
}))
vi.mock("./owned-command", async (original) => {
  const actual = await original<typeof import("./owned-command")>()
  return {
    ...actual,
    startOwnedHookCommand: mock.spawn.mockImplementation(() => ({
      stop: vi.fn(),
      completion: Promise.resolve().then(() => {
        mock.duringCleanup()
        throw new actual.HookProcessCleanupError()
      })
    }))
  }
})
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({
    isEnabled: () => mock.enabled,
    classicEvent: async (
      _w: string,
      _t: string,
      _e: string,
      input: never,
      signal: AbortSignal,
      core: (input: never, signal: AbortSignal) => Promise<unknown>
    ) =>
      core(input, signal).catch((error) => {
        throw mock.wrapped ? new Error("Native middleware error", { cause: error }) : error
      })
  })
}))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: mock.results }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { runHooks } from "./runner"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  mock.spawn.mockClear()
  mock.results.mockClear()
  mock.enabled = false
  mock.wrapped = false
  mock.duringCleanup = () => {}
})

it.each([
  "ordinary",
  "classic-next",
  "required",
  "cancelled-classic",
  "cancelled-required",
  "wrapped-classic"
])(
  "%s cannot turn unconfirmed physical cleanup into a passed Hook or a successful receipt",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "hook-cleanup-failure-"))
    roots.push(root)
    const hook: PluginHookMetadata = {
      id: "plugin:cleanup/gate",
      pluginId: "cleanup",
      pluginName: "cleanup",
      pluginEnabled: true,
      pluginRoot: root,
      hookPath: "hooks/hooks.json",
      hookSourceType: "plugin",
      hookSourceRoot: root,
      event: "PreToolUse",
      type: "command",
      command: "echo ignored",
      enabled: true,
      createdAt: "",
      updatedAt: ""
    }
    const controller = new AbortController()
    const context = {
      sessionId: "cleanup",
      workspacePath: root,
      toolName: "read_file",
      signal: controller.signal
    }
    const notices = vi.fn()
    mock.enabled = kind.includes("classic")
    mock.wrapped = kind === "wrapped-classic"
    if (kind.startsWith("cancelled"))
      mock.duringCleanup = () => controller.abort(new Error("CANCEL_MUST_NOT_MASK_CLEANUP"))
    const invoke = () =>
      runHooks([hook, { ...hook, id: "next-side-effect" }], "PreToolUse", context, notices)
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: "cleanup",
        incarnationKey: "cleanup",
        projectId: "composition-legacy:cleanup:unit",
        operationId: "cleanup",
        workspace: root,
        packageDigest: "a".repeat(64),
        stageId: "check",
        plugin: { id: "cleanup", name: "cleanup", enabled: true, path: root } as never,
        requiredHooks: ["gate"]
      },
      () => {}
    )
    await expect(
      kind.includes("required") ? withRuntimePluginSource(token, invoke) : invoke()
    ).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
    expect(mock.spawn).toHaveBeenCalledOnce()
    expect(notices).not.toHaveBeenCalled()
    expect(mock.results).not.toHaveBeenCalled()
  }
)
