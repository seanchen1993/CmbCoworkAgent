import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { createModAuthoringRuntimeTools } from "../agent/mod-authoring-runtime"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "./devtools/development-service"
import { withModToolCall } from "./adapters"
import { ModsManager, getModsManager, setModsManager } from "./manager"
import { ModPluginChangedError } from "./errors"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
  setModDevelopmentService(undefined)
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-native-catalog-"))
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const previous = getModsManager()
  setModsManager(manager)
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const controller = new AbortController()
  const scope = { workspace, threadId: "creator", turnId: "native-turn" }
  const runtime = manager.createRuntimeAuthority({ ...scope, signal: controller.signal })
  const binding = { ...scope, signal: controller.signal, runtimeAuthority: runtime.authority }
  manager.bindThread(binding)
  claimLocalThreadRunLease({ threadId: scope.threadId, owner: "desktop", runId: scope.turnId })
  setModDevelopmentService({
    isEnabled: (threadId, expected) => threadId === scope.threadId && expected === workspace,
    isCreatorMode: (threadId, expected) => threadId === scope.threadId && expected === workspace
  } as ModDevelopmentService)
  cleanups.push(() => {
    controller.abort()
    releaseLocalThreadRunLease(scope.threadId, "desktop", scope.turnId)
    manager.close()
    setModsManager(previous)
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-native-catalog-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  return { manager, workspace, scope, binding, controller }
}

it.each(["package-toggle", "legacy-grant-revoke"] as const)(
  "retains the original native creator owner and executes its tool exactly once across %s",
  async (change) => {
    const f = fixture()
    const guard = f.manager.captureFunctionRuntimeGuard(f.binding.runtimeAuthority)
    const [authoring] = createModAuthoringRuntimeTools({ ...f.scope, projectMode: false })
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>((done) => {
      enter = done
    })
    const released = new Promise<void>((done) => {
      resume = done
    })
    const core = vi.fn(async () => {
      enter()
      await released
      return authoring.invoke({ action: "catalog" })
    })
    const running = withModToolCall(
      f.binding,
      {
        toolCall: { name: "mod_authoring", id: "creator-catalog", args: {} }
      },
      new Set(),
      core
    )
    await entered
    if (change === "legacy-grant-revoke") {
      f.manager.store.grant(f.workspace, "other-legacy-mod", "digest", true)
      f.manager.revoke(f.workspace, "other-legacy-mod")
      expect(f.manager.store.getGrant(f.workspace, "other-legacy-mod")?.enabled).toBe(false)
    } else f.manager.pluginsChanged(["other-ui-plugin"])
    expect(() => guard()).not.toThrow()
    resume()
    const result = await running
    expect(JSON.parse(String(result))).toMatchObject({ ok: true })
    expect(core).toHaveBeenCalledOnce()
    expect(() => guard()).not.toThrow()
  }
)

it.each(["workspace-mods-disabled", "output-protection", "binding-replaced", "cancelled"] as const)(
  "keeps native creation fenced after %s",
  (change) => {
    const f = fixture()
    const guard = f.manager.captureFunctionRuntimeGuard(f.binding.runtimeAuthority)
    f.manager.pluginsChanged(["other-ui-plugin"])
    if (change === "workspace-mods-disabled") f.manager.configure(f.workspace, false, false)
    if (change === "output-protection") f.manager.configure(f.workspace, true, true)
    if (change === "binding-replaced") f.manager.bindThread({ ...f.binding })
    if (change === "cancelled") f.controller.abort()
    expect(() => guard()).toThrow()
  }
)

it("reports an explicitly retired guest call as a tool failure without retrying or retiring the creator", async () => {
  const f = fixture()
  const intercept = vi.fn(async () => {
    throw new ModPluginChangedError()
  })
  f.manager.attachFunctions({
    toolCall: intercept,
    invalidate: () => {},
    closeThread: () => {},
    close: () => {}
  } as unknown as Parameters<ModsManager["attachFunctions"]>[0])
  const core = vi.fn(async () => "must not execute")
  const result = await withModToolCall(
    f.binding,
    {
      toolCall: { name: "retired_guest_tool", id: "retired-tool", args: {} }
    },
    new Set(),
    core
  )
  expect(result).toMatchObject({
    status: "error",
    content: expect.stringContaining("不会自动重试")
  })
  expect(core).not.toHaveBeenCalled()
  expect(intercept).toHaveBeenCalledOnce()
  expect(() => f.manager.captureFunctionRuntimeGuard(f.binding.runtimeAuthority)()).not.toThrow()
})
