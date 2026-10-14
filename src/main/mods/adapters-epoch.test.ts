import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { withModToolCall } from "./adapters"
import { getModCallContext } from "./context"
import { ModsManager, getModsManager, setModsManager, type ModThreadBinding } from "./manager"
import type { ModRuntimeAuthority } from "./runtime-instance"
import { currentFunctionExecution } from "./v2/execution-context"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mods-adapter-epoch-"))
  const manager = new ModsManager(
    join(directory, "control.sqlite"), () => [], async () => true, () => {}
  )
  const previous = getModsManager()
  setModsManager(manager)
  manager.configure(directory, true, false)
  const controller = new AbortController()
  const workspace = manager.workspaceKey(directory)
  const root = manager.createRuntimeAuthority({
    workspace, threadId: "thread", turnId: "main-turn", signal: controller.signal
  })
  manager.bindThread({
    ...root.authority, runtimeAuthority: root.authority, signal: controller.signal
  })
  const thinBinding = (authority: ModRuntimeAuthority): ModThreadBinding => ({
    workspace, threadId: authority.threadId, turnId: authority.turnId,
    agentId: authority.agentId, runtimeAuthority: authority, signal: controller.signal
  })
  const run = <T>(operation: () => Promise<T>) => manager.withSharedAgent(
    root.authority, `mod-task:${randomUUID()}`, controller.signal,
    { blockedToolNames: new Set(), readOnly: false }, operation, "main-run",
    { type: "general-purpose", description: "Actual thin native adapter binding" }
  )
  cleanup.push(() => {
    controller.abort()
    manager.close()
    setModsManager(previous)
    if (dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("mods-adapter-epoch-")) throw Error("Unexpected cleanup path")
    rmSync(directory, { recursive: true, force: true })
  })
  return { manager, workspace, root: root.authority, thinBinding, run }
}

const request = { toolCall: { name: "read_file", id: "native-read", args: {} } }

it.each([false, true])(
  "rejects a stale thin task binding before native execution with Mods re-enabled=%s",
  async enabled => {
    const f = fixture()
    const handler = vi.fn(async () => "must not execute")
    await f.run(async () => {
      const authority = currentFunctionExecution()!.runtimeAuthority!
      const binding = f.thinBinding(authority)
      expect(binding.assertLive).toBeUndefined()
      f.manager.configure(f.workspace, false, false)
      if (enabled) f.manager.configure(f.workspace, true, false)
      expect(f.manager.isActive(f.workspace)).toBe(enabled)
      await expect((async () => withModToolCall(
        binding, request, new Set(), handler
      ))()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
      authority.assertLive()
    })
    expect(handler).not.toHaveBeenCalled()
    f.root.assertLive()
  }
)

it.each(["disabled", "re-enabled", "binding-replaced"] as const)(
  "blocks a held native result and its context guard after %s",
  async change => {
    const f = fixture()
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    let guard: (() => void) | undefined
    let owner: ModRuntimeAuthority | undefined
    const handler = vi.fn(async () => {
      const context = getModCallContext()
      expect(context?.runtimeAuthority).toBe(owner)
      guard = context?.assertLive
      expect(guard).toBeTypeOf("function")
      guard!()
      enter()
      await released
      return "late native result"
    })
    const running = f.run(async () => {
      owner = currentFunctionExecution()!.runtimeAuthority!
      const binding = f.thinBinding(owner)
      expect(binding.assertLive).toBeUndefined()
      return withModToolCall(binding, request, new Set(), handler)
    })
    const rejected = expect(running).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await entered
    if (change === "binding-replaced") f.manager.bindThread(f.thinBinding(owner!))
    else {
      f.manager.configure(f.workspace, false, false)
      if (change === "re-enabled") f.manager.configure(f.workspace, true, false)
    }
    expect(() => guard!()).toThrow("MODS_CALL_SCOPE_CHANGED")
    resume()
    await rejected
    expect(handler).toHaveBeenCalledOnce()
    expect(() => owner!.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    f.root.assertLive()
  }
)

it("allows a fresh cold task's native operation without upgrading its owner", async () => {
  const f = fixture()
  f.manager.configure(f.workspace, false, false)
  await f.run(async () => {
    const authority = currentFunctionExecution()!.runtimeAuthority!
    const binding = f.thinBinding(authority)
    const handler = vi.fn(async (native: typeof request) => {
      expect(native).toBe(request)
      expect(getModCallContext()).toBeUndefined()
      expect(currentFunctionExecution()?.runtimeAuthority).toBe(authority)
      return "cold native result"
    })
    await expect(withModToolCall(binding, request, new Set(), handler))
      .resolves.toBe("cold native result")
    expect(handler).toHaveBeenCalledExactlyOnceWith(request)
  })
  f.root.assertLive()
})
