import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  root: `/tmp/harness-project-create-${process.pid}-${Date.now()}`
}))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getUserInfo: () => null,
  getPlugins: () => [{ id: "plugin", name: "plugin", path: join(state.root, "plugin") }]
}))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./managed-run-store", () => ({ managedRunStore: {} }))
vi.mock("./catalog-client", () => ({}))
import { createHarnessProject } from "./service"
import { initializeHarnessConfigV2 } from "./config-v2"

const input = () => ({
  adapterId: "plugin",
  adapterType: "plugin" as const,
  name: "项目名称",
  description: "",
  projectCode: "P001",
  projectFromLean: false,
  systemId: "system",
  systemName: "系统",
  workspacePath: join(state.root, "work space"),
  projectDir: "项目_A-1"
})
const storePath = () => join(state.root, "harness-board-projects.json")
const projectPath = () => join(input().workspacePath, input().projectDir)

beforeEach(async () => {
  await mkdir(join(state.root, "plugin", "board_core"), { recursive: true })
  await mkdir(projectPath(), { recursive: true })
  await initializeHarnessConfigV2(state.root)
  await writeFile(
    join(state.root, "plugin", "init.cjs"),
    `const fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(path.join(process.argv[2], process.argv[3], 'initialized.json'),
  JSON.stringify({ workspacePath: process.argv[2], projectDir: process.argv[3] }));`
  )
  await writeFile(
    join(state.root, "plugin", "board_core", "board_config.json"),
    JSON.stringify({
      apiVersion: 1,
      inspectCommands: {
        [process.platform]: {
          create_project: `"${process.execPath}" "\${pluginPath}/init.cjs" "\${pluginWorkspace}" "\${projectDir}"`
        }
      }
    })
  )
})
afterEach(() => rm(state.root, { recursive: true, force: true }))

describe("create project in a selected directory", () => {
  it("initializes the selected empty directory and persists its parent and name", async () => {
    const created = await createHarnessProject(input())
    const initialized = JSON.parse(await readFile(join(projectPath(), "initialized.json"), "utf8"))
    expect(initialized).toEqual({
      workspacePath: input().workspacePath,
      projectDir: input().projectDir
    })
    expect(await readdir(projectPath())).toEqual(["initialized.json"])
    const store = JSON.parse(await readFile(storePath(), "utf8"))
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0]).toMatchObject({
      projectId: created.projectId,
      workspacePath: input().workspacePath,
      projectDir: input().projectDir
    })
  })

  it("blocks hidden content before invoking the plugin or saving a project", async () => {
    await mkdir(join(projectPath(), ".git"))
    await expect(createHarnessProject(input())).rejects.toThrow("必须为空")
    expect(await readdir(projectPath())).toEqual([".git"])
    await expect(readFile(storePath())).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["My Project", "project.v1"])("blocks invalid folder name %s", async (projectDir) => {
    await expect(createHarnessProject({ ...input(), projectDir })).rejects.toThrow("仅支持")
    expect(await readdir(projectPath())).toEqual([])
  })

  it("allows an empty directory even when another project record references it", async () => {
    const first = await createHarnessProject(input())
    await rm(join(projectPath(), "initialized.json"))
    const second = await createHarnessProject({ ...input(), projectCode: "P002" })
    expect(second.projectId).not.toBe(first.projectId)
    const store = JSON.parse(await readFile(storePath(), "utf8"))
    expect(store.projects).toHaveLength(2)
  })
})
