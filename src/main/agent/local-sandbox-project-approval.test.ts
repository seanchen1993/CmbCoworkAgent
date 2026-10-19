import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { withProjectActionScope } from "../harness-board/project-action-scope"
import { ModsManager, getModsManager, setModsManager } from "../mods/manager"
import { withFunctionExecution } from "../mods/v2/execution-context"
import { LocalSandbox } from "./local-sandbox"

const processSpawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>()
  return {
    ...native,
    spawn: (...args: Parameters<typeof native.spawn>) => {
      processSpawn(...args)
      return Reflect.apply(native.spawn, native, args)
    }
  }
})

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

it.each(["write", "execute"] as const)(
  "rechecks project content after real native %s confirmation and before the effect",
  async (tool) => {
    for (const change of ["knowledge", "source", "unchanged"] as const) {
      const root = mkdtempSync(join(tmpdir(), "project-native-approval-"))
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      const knowledge = join(root, "knowledge.md"), source = join(root, "plugin.json")
      writeFileSync(knowledge, "approved knowledge")
      writeFileSync(source, '{"version":"1"}')
      const target = join(workspace, "effect.txt")
      const contentRejected = vi.fn()
      let entered!: () => void, release!: () => void
      const approvalEntered = new Promise<void>((done) => { entered = done })
      const approvalReleased = new Promise<void>((done) => { release = done })
      const confirm = vi.fn(async () => {
        entered()
        await approvalReleased
        return true
      })
      const previous = getModsManager()
      const manager = new ModsManager(join(root, "control.sqlite"), () => [], confirm, () => {})
      setModsManager(manager)
      manager.configure(workspace, true, false)
      const controller = new AbortController()
      const owner = manager.createRuntimeAuthority({
        workspace, threadId: "project-thread", turnId: "project-turn", signal: controller.signal
      })
      const grant = manager.store.grant(manager.workspaceKey(workspace), "function:project", "digest", true)
      let unbind = () => {}
      try {
        const pending = withProjectActionScope(
          "project-thread",
          { project: "generic-project", operation: "post-skill-action" },
          () => owner.authority.assertLive(),
          async () => {
            // This is the post-Skill path: no opaque runtime-plugin-source token exists.
            new LocalSandbox({
              rootDir: workspace,
              runId: "project-thread",
              hookTurnId: "project-turn",
              modRuntimeAuthority: owner.authority,
              modWorkspace: workspace,
              modCommandOnly: true,
              modManagedExecution: true,
              windowsSandbox: "none",
              abortSignal: controller.signal,
              onModBinding: (dispose) => { unbind = dispose }
            })
            return withFunctionExecution({
              workspace: manager.workspaceKey(workspace), threadId: "project-thread",
              turnId: "project-turn", leased: true, immediate: false, userInitiated: true
            }, () => manager.invokeFunctionTool(
              workspace, "project-thread", grant, `host:${tool === "write" ? "write_file" : "execute"}`,
              tool === "write"
                ? { file_path: "effect.txt", content: "effect" }
                : { command: "node -e \"require('fs').writeFileSync('effect.txt','effect')\"" },
              controller.signal, false, true
            ))
          },
          () => {
            if (readFileSync(knowledge, "utf8") !== "approved knowledge") {
              contentRejected("PROJECT_KNOWLEDGE_CHANGED")
              throw Error("PROJECT_KNOWLEDGE_CHANGED")
            }
            if (readFileSync(source, "utf8") !== '{"version":"1"}') {
              contentRejected("PROJECT_SOURCE_CHANGED")
              throw Error("PROJECT_SOURCE_CHANGED")
            }
          }
        )
        // Observe rejection before releasing the real native confirmation callback.
        const result = pending.catch((error) => ({ error: String(error) }))
        await approvalEntered
        expect(existsSync(target)).toBe(false)
        processSpawn.mockClear()
        if (change === "knowledge") writeFileSync(knowledge, "changed knowledge")
        if (change === "source") writeFileSync(source, '{"version":"2"}')
        release()
        const value = await result
        expect(confirm).toHaveBeenCalledOnce()
        if (change === "unchanged") {
          expect(value).not.toHaveProperty("error")
          expect(readFileSync(target, "utf8")).toBe("effect")
          expect(contentRejected).not.toHaveBeenCalled()
          if (tool === "execute") expect(processSpawn).toHaveBeenCalledOnce()
        } else {
          // The public dispatcher deliberately sanitizes the private guard error.
          expect(JSON.stringify(value)).toContain("MODS_EXECUTION_FAILED")
          expect(contentRejected).toHaveBeenCalledWith(`PROJECT_${change.toUpperCase()}_CHANGED`)
          expect(existsSync(target)).toBe(false)
          expect(processSpawn).not.toHaveBeenCalled()
        }
      } finally {
        release()
        controller.abort()
        unbind()
        owner.release()
        manager.close()
        setModsManager(previous)
        rmSync(root, { recursive: true, force: true })
      }
    }
  },
  30_000
)
