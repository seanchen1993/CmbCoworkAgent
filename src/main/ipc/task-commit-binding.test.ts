import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain } from "electron"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { TaskCommitBindingApi } from "../../shared/task-commit-binding"
import type { HarnessDeployUnitMapping } from "../../shared/harness-board-types"

const state = vi.hoisted(() => ({
  dir: "",
  pick: [] as string[],
  mappings: [] as HarnessDeployUnitMapping[]
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: state.pick }) }
}))
vi.mock("../storage", () => ({
  getDbPath: () => join(state.dir, "threads.sqlite"),
  getOpenworkDir: () => state.dir,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn(),
  getAgentAutoCommitWorkspaceCard: () => ({ cardNumber: "CACHED-1" })
}))
vi.mock("../harness-board/service", () => ({
  getHarnessProjectRootPath: () => state.dir,
  getHarnessFeatureBinding: async () => ({ selectedDeployUnitMappings: state.mappings })
}))
import { closeDatabase, createThread, deleteThread, initializeDatabase, updateThread } from "../db"
import {
  harnessProjectDeleted,
  publishFeatureRepositoryMappings
} from "../harness-board/feature-catalog-lifecycle"
import { readTaskCommitBinding } from "../services/task-commit-binding"
import { registerTaskCommitBindingHandlers } from "./task-commit-binding"

type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const sender = { id: 1 }
const event = { sender }
function invoke<K extends keyof TaskCommitBindingApi>(
  key: K,
  ...args: Parameters<TaskCommitBindingApi[K]>
): ReturnType<TaskCommitBindingApi[K]> {
  return Promise.resolve(handlers.get("taskCommitBinding:" + key)!(event, ...args)) as ReturnType<
    TaskCommitBindingApi[K]
  >
}
let workspace: string
let repo: string
let otherRepo: string

beforeAll(async () => {
  state.dir = realpathSync.native(mkdtempSync(join(tmpdir(), "task-commit-binding-")))
  workspace = join(state.dir, "session")
  repo = join(state.dir, "code")
  otherRepo = join(state.dir, "other-code")
  mkdirSync(workspace)
  for (const root of [repo, otherRepo]) execFileSync("git", ["init", "--quiet", root])
  await initializeDatabase()
  registerTaskCommitBindingHandlers(
    {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
    } as unknown as IpcMain,
    (entry) => entry.sender === (sender as unknown)
  )
})

afterAll(async () => {
  await closeDatabase()
  rmSync(state.dir, { recursive: true, force: true })
})

describe("task-local commit authorization", { timeout: 30_000 }, () => {
  it("requires the trusted desktop frame to open an editor", async () => {
    await expect(
      handlers.get("taskCommitBinding:open")!({ sender: { id: 2 } }, "A")
    ).rejects.toThrow("桌面任务窗口")
  })

  it("uses the legacy card only as a suggestion and accepts only checkouts offered to this editor", async () => {
    createThread("A", { workspacePath: workspace })
    createThread("B", { workspacePath: workspace })
    const edit = await invoke("open", "A")
    expect(edit.cardNumber).toBe("CACHED-1")
    expect(await invoke("read", "A")).toBeNull()
    await expect(invoke("save", edit.token, "K-1", [repo])).rejects.toThrow("显示的仓库")
    state.pick = [repo, otherRepo]
    expect(await invoke("choose", edit.token)).toEqual(state.pick)
    writeFileSync(join(repo, "existing.txt"), "user change")
    const binding = await invoke("save", edit.token, "K-1", [repo, otherRepo])
    expect(await readTaskCommitBinding("A")).toMatchObject({
      ...binding,
      dirtyAtSelection: { [repo]: ["existing.txt"], [otherRepo]: [] }
    })
    expect(await invoke("read", "B")).toBeNull()
    const next = await invoke("open", "A")
    const replacement = await invoke("save", next.token, "K-2", [otherRepo])
    expect(replacement.version).not.toBe(binding.version)
    const revoke = await invoke("open", "A")
    await invoke("revoke", revoke.token)
    expect(await invoke("read", "A")).toBeNull()
    await expect(invoke("save", next.token, "K-1", [repo])).rejects.toThrow("过期")
  })

  it("requires a repository choice when an ordinary workspace contains sibling checkouts", async () => {
    createThread("siblings", { workspacePath: state.dir })
    const draft = await invoke("open", "siblings")
    expect(new Set(draft.repositories)).toEqual(new Set([repo, otherRepo]))
    expect(draft.selected).toEqual([])
  })

  it("retains a repository-only authorization and never fills an explicitly empty card from cache", async () => {
    createThread("no-card", { workspacePath: workspace })
    const edit = await invoke("open", "no-card")
    expect(edit.cardNumber).toBe("CACHED-1")
    state.pick = [repo]
    await invoke("choose", edit.token)
    await expect(invoke("save", edit.token, "K 1", [repo])).rejects.toThrow("有效的任务卡号")
    const previous = await invoke("save", edit.token, "K-1", [repo])
    const clear = await invoke("open", "no-card")
    const saved = await invoke("save", clear.token, "  ", [repo])
    expect(saved.version).not.toBe(previous.version)
    expect(await invoke("read", "no-card")).toMatchObject({
      cardNumber: "",
      repositoryPaths: [repo]
    })
    const reopened = await invoke("open", "no-card")
    expect(reopened).toMatchObject({ active: true, cardNumber: "", selected: [repo] })
    await invoke("revoke", reopened.token)
    expect(await invoke("read", "no-card")).toBeNull()
  })

  it("authorizes a nested session directory and keeps its repository root outside the scope", async () => {
    const scope = join(repo, "nested-session")
    mkdirSync(scope)
    createThread("nested-session", { workspacePath: scope })
    const editor = await invoke("open", "nested-session")
    expect(editor.repositories).toEqual([scope])
    state.pick = [repo]
    await expect(invoke("choose", editor.token)).rejects.toThrow("保留会话子目录")
    await invoke("save", editor.token, "CARD-SUB", [scope])
    expect(await readTaskCommitBinding("nested-session")).toMatchObject({
      repositoryPaths: [scope],
      checkoutRoots: { [scope]: repo }
    })
  })

  it("revokes on workspace A→B→A and thread ID reuse, including previously opened editors", async () => {
    const id = "recreated"
    createThread(id, { workspacePath: workspace })
    const open = await invoke("open", id)
    state.pick = [repo]
    await invoke("choose", open.token)
    await invoke("save", open.token, "K-3", [repo])
    const stale = await invoke("open", id)
    updateThread(id, { metadata: JSON.stringify({ workspacePath: otherRepo }) })
    updateThread(id, { metadata: JSON.stringify({ workspacePath: workspace }) })
    expect(await invoke("read", id)).toBeNull()
    await expect(invoke("save", stale.token, "K-3", [repo])).rejects.toThrow("已更改")
    const beforeRecreate = await invoke("open", id)
    await invoke("choose", beforeRecreate.token)
    deleteThread(id)
    createThread(id, { workspacePath: workspace })
    await expect(invoke("save", beforeRecreate.token, "K-3", [repo])).rejects.toThrow("已更改")
  })

  it("invalidates a project mapping on removal even if it is subsequently re-added", async () => {
    const unit = { deployUnitIdMapping: "U1", deployUnitId: "unit", localRepoPath: repo }
    state.mappings = [unit]
    writeFileSync(join(state.dir, "harness-board-features.v2.json"), "{}")
    createThread("feature", {
      workspacePath: workspace,
      harnessFeature: { projectId: "p", slug: "f" }
    })
    const edit = await invoke("open", "feature")
    expect(edit.repositories).toEqual([repo])
    await invoke("save", edit.token, "", [repo])
    expect(await invoke("read", "feature")).toMatchObject({
      cardNumber: "",
      repositoryPaths: [repo]
    })
    state.mappings = []
    publishFeatureRepositoryMappings("p", "f", [])
    state.mappings = [unit]
    publishFeatureRepositoryMappings("p", "f", [unit])
    expect(await invoke("read", "feature")).toBeNull()
    const restored = await invoke("open", "feature")
    await invoke("save", restored.token, "K-4", [repo])
    harnessProjectDeleted("p")
    expect(await invoke("read", "feature")).toBeNull()
  })

  it("offers the current workspace Git root, blocks isolated escapes, detects replacement at the same path", async () => {
    createThread("worktree", { workspacePath: otherRepo, isWorktree: true })
    const edit = await invoke("open", "worktree")
    expect(edit.repositories).toEqual([otherRepo])
    state.pick = [repo]
    await expect(invoke("choose", edit.token)).rejects.toThrow("独立工作树")
    await invoke("save", edit.token, "K-5", [otherRepo])
    renameSync(join(otherRepo, ".git"), join(otherRepo, "old.git"))
    execFileSync("git", ["init", "--quiet", otherRepo])
    expect(await invoke("read", "worktree")).toBeNull()
  })
})
