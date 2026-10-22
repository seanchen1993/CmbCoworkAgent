import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localBotWorkspaces } from "./workspace"
import { parseCreateBotWork } from "../../shared/bots/validation"

const fixture = vi.hoisted(() => ({ root: "", catalog: vi.fn() }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => fixture.root }))
vi.mock("../harness-board/catalog-client", () => ({
  readHarnessCatalogPageInWorker: fixture.catalog
}))
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "bot-workspace-"))
  fixture.catalog.mockReset()
})
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }))

describe("host-resolved work directories", () => {
  it("uses the Bot default only when no target was specified", async () => {
    const workspace = await localBotWorkspaces.resolve("owner")
    expect(workspace).toEqual({
      kind: "default",
      path: realpathSync(join(fixture.root, "bots/workspaces/owner"))
    })
    expect(fixture.catalog).not.toHaveBeenCalled()
  })
  it("canonicalizes explicit paths, including spaces and symlink aliases", async () => {
    const path = join(fixture.root, "Actual project")
    mkdirSync(path)
    const alias = join(fixture.root, "alias")
    symlinkSync(path, alias, "dir")
    expect(await localBotWorkspaces.resolve("owner", { kind: "directory", path: alias })).toEqual({
      kind: "directory",
      path: realpathSync(path)
    })
    expect(fixture.catalog).not.toHaveBeenCalled()
  })
  it("rejects missing directories, files and ambiguous relative paths without fallback or creation", async () => {
    const file = join(fixture.root, "input.txt")
    writeFileSync(file, "input")
    for (const path of [join(fixture.root, "missing"), file, "relative/project"])
      await expect(
        localBotWorkspaces.resolve("owner", { kind: "directory", path })
      ).rejects.toThrow("工作区")
  })
  it("looks up the exact project and pins its directory independently of later catalog edits", async () => {
    const path = join(fixture.root, "project")
    mkdirSync(path)
    fixture.catalog.mockResolvedValue({
      projects: [
        {
          projectId: "p1",
          name: "演示项目",
          workspacePath: fixture.root,
          projectDir: "project",
          projectCode: "code",
          lifecycle: { status: "active" }
        }
      ],
      projectNextCursor: null
    })
    const workspace = await localBotWorkspaces.resolve("owner", {
      kind: "project",
      projectId: "p1"
    })
    expect(workspace).toEqual({
      kind: "project",
      projectId: "p1",
      projectName: "演示项目",
      path: realpathSync(path)
    })
    expect(fixture.catalog).toHaveBeenCalledWith(
      { projectId: "p1", includeRegistry: false, projectLimit: 20 },
      expect.stringContaining("bot-work-workspace:")
    )
    fixture.catalog.mockResolvedValue({ projects: [] })
    await expect(
      localBotWorkspaces.resolve("owner", { kind: "project", projectId: "missing" })
    ).rejects.toThrow("不存在")
    expect(workspace.path).toBe(realpathSync(path))
  })
  it("does not choose among duplicate names; returns bounded metadata and the next cursor", async () => {
    fixture.catalog.mockResolvedValue({
      projects: ["p1", "p2"].map((projectId) => ({
        projectId,
        name: "同名项目",
        workspacePath: "/repo",
        projectDir: projectId,
        projectCode: projectId,
        lifecycle: { status: projectId === "p1" ? "active" : "archived" },
        description: "not needed"
      })),
      projectNextCursor: 20
    })
    const page = await localBotWorkspaces.projects("同名", 0)
    expect(page.items).toHaveLength(2)
    expect(page.items.map((p) => p.path)).toEqual(["/repo/p1", "/repo/p2"])
    expect(page.nextCursor).toBe(20)
    expect(page.items[0]).not.toHaveProperty("description")
    expect(fixture.catalog).toHaveBeenCalledWith(
      { query: "同名", projectCursor: 0, includeRegistry: false, projectLimit: 20 },
      expect.any(String)
    )
    await expect(localBotWorkspaces.projects("同名", -1)).rejects.toThrow("分页游标")
    await expect(
      localBotWorkspaces.resolve("owner", { kind: "project", projectId: "p2" })
    ).rejects.toThrow("已归档")
  })
  it("rejects client/model supplied resolved metadata or conflicting targets", () => {
    const base = { botId: "b", operationId: "op", title: "Title", goal: "Goal" }
    for (const workspace of [
      { kind: "default", path: "/fake" },
      { kind: "project", projectId: "p1", path: "/fake" },
      { kind: "directory", path: "/valid", projectId: "p1" },
      { kind: "directory", path: "/bad\u0000path" }
    ])
      expect(() => parseCreateBotWork({ ...base, workspace })).toThrow()
  })
})
