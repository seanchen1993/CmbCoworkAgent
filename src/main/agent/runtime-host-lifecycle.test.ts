import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModsManager } from "../mods/manager"
import { createHostRuntimeLifecycle } from "./runtime-host-lifecycle"
import { functionCallAgent, functionCallAuthority } from "../mods/v2/host-call"
import { currentFunctionExecution } from "../mods/v2/execution-context"
import { getCurrentHookAgentId } from "../hooks/execution-context"
import { functionFileScope } from "../mods/v2/file-permission-host"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run())
)

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "runtime-lifecycle-"))
  const manager = new ModsManager(
    join(folder, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(folder, true, false)
  const workspace = manager.workspaceKey(folder)
  const scope = { workspace, threadId: "flow-child", turnId: "flow-child", agentId: "flow:agent:0" }
  const instance = manager.createRuntimeAuthority(scope)
  const releaseBinding = manager.bindThread({
    ...scope,
    runtimeAuthority: instance.authority,
    queryTool: async () => ({ decision: "allow" })
  })
  cleanup.push(() => {
    manager.close()
    rmSync(folder, { recursive: true, force: true })
  })
  cleanup.push(releaseBinding)
  cleanup.push(instance.release)
  return { manager, scope, instance, run: createHostRuntimeLifecycle(instance.authority) }
}

it("enters the exact non-main binding for external Skill prepare and complete hooks", async () => {
  const { manager, scope, instance, run } = fixture()
  const denyStandalone = () => {
    throw Error("MODS_THREAD_CONTEXT_REQUIRED")
  }
  // Reproduce the previous path: no stream middleware scope, so child looks cold/main.
  expect(() => functionFileScope(manager, denyStandalone, scope.workspace, scope.threadId)).toThrow(
    "MODS_THREAD_CONTEXT_REQUIRED"
  )
  for (const phase of ["prepare", "complete"]) {
    await run(async () => {
      expect(functionCallAgent(scope.workspace, scope.threadId)).toBe(scope.agentId)
      expect(functionCallAuthority(scope.workspace, scope.threadId)).toBe(instance.authority)
      expect(getCurrentHookAgentId()).toBe(scope.agentId)
      expect(manager.functionRuntimeScope(scope.workspace, scope.threadId).bound).toBe(true)
      expect(() =>
        functionFileScope(manager, denyStandalone, scope.workspace, scope.threadId)
      ).not.toThrow()
      expect(currentFunctionExecution()?.userInitiated).toBe(false)
      await Promise.resolve(phase)
      expect(functionCallAuthority(scope.workspace, scope.threadId)).toBe(instance.authority)
    })
    expect(currentFunctionExecution()).toBeUndefined()
  }
})

it("never reacquires a replacement runtime after the captured authority expires", async () => {
  const { manager, scope, instance, run } = fixture()
  instance.release()
  const replacement = manager.createRuntimeAuthority(scope)
  cleanup.push(replacement.release)
  const work = vi.fn(async () => {})
  await expect(run(work)).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(work).not.toHaveBeenCalled()
})

it("rejects a result when the owning runtime is revoked during its hook", async () => {
  const { instance, run } = fixture()
  await expect(
    run(async () => {
      instance.release()
      return "late success"
    })
  ).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
})
