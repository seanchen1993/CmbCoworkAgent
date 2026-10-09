import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModsManager } from "./manager"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "cmb-mod-workspace-"))
  const workspace = join(root, "project")
  mkdirSync(workspace)
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => false,
    () => {},
    undefined,
    undefined,
    () => enabled
  )
  cleanup.push(() => {
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-mod-workspace-")
    )
      throw new Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, manager }
}

describe("Mods workspace admission", () => {
  it.each([true, false])(
    "primes a valid workspace with the global switch set to %s",
    async (enabled) => {
      const { workspace, manager } = fixture(enabled)
      await manager.prepareWorkspace(workspace)
      const canonical = realpathSync(workspace)
      expect(manager.workspaceKey(workspace)).toBe(
        process.platform === "win32" ? canonical.toLowerCase() : canonical
      )
      const { authority } = manager.createRuntimeAuthority({
        workspace,
        threadId: "thread",
        turnId: "turn"
      })
      expect(() => authority.assertLive()).not.toThrow()
      expect(manager.isActive(workspace)).toBe(false)
    }
  )

  it.each([true, false])(
    "does not trust cached paths after deletion (global switch %s)",
    async (enabled) => {
      const { workspace, manager, root } = fixture(enabled)
      await manager.prepareWorkspace(workspace)
      if (dirname(workspace) !== root) throw new Error("Unexpected workspace")
      // Empty directory; no recursive removal or user data.
      rmSync(workspace, { recursive: true })
      await expect(manager.prepareWorkspace(workspace)).rejects.toMatchObject({
        code: "invalid_workspace_path"
      })
    }
  )

  it("does not transfer cached grants to a retargeted directory link", async () => {
    const { workspace, manager, root } = fixture()
    const second = join(root, "second")
    mkdirSync(second)
    const alias = join(root, "alias")
    symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir")
    await manager.prepareWorkspace(alias)
    manager.configure(alias, true, false)
    unlinkSync(alias)
    symlinkSync(second, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(manager.prepareWorkspace(alias)).rejects.toThrow("实际路径已变化")
    expect(manager.isEnabled(second)).toBe(false)
  })

  it("gives synchronous callers the same actionable error for a missing path", () => {
    const { root, manager } = fixture()
    expect(() => manager.workspaceKey(join(root, "Users", "demo"))).toThrow(
      "请选择运行应用的机器上实际存在"
    )
  })
})
