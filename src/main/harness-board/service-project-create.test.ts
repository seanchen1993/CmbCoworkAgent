import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"

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
vi.mock("./catalog-client", () => ({
  cancelHarnessCatalogScope: () => undefined,
  readHarnessProjectContextsInWorker: async (projectIds: string[]) => {
    const store = JSON.parse(await readFile(storePath(), "utf8")) as {
      projects: HarnessProjectMetadata[]
    }
    const plugin = { id: "plugin", name: "plugin", path: join(state.root, "plugin") }
    const value = JSON.parse(
      await readFile(join(plugin.path, "board_core", "board_config.json"), "utf8")
    )
    return {
      projects: Object.fromEntries(
        store.projects
          .filter(({ projectId }) => projectIds.includes(projectId))
          .map((project) => [
            project.projectId,
            {
              project,
              plugin,
              configSnapshot: { value, error: null },
              projectDirectoryExists: true
            }
          ])
      )
    }
  }
}))
vi.mock("./adapter-detail-client", async () => {
  const { normalizeHarnessAdapterDetailBatch } = await import("./adapter-detail-normalizer")
  return {
    cancelHarnessAdapterDetailScope: () => undefined,
    parseHarnessAdapterDetailBatchInWorker: async (
      buffer: Buffer,
      projects: Parameters<typeof normalizeHarnessAdapterDetailBatch>[1]
    ) => normalizeHarnessAdapterDetailBatch(buffer, projects).result
  }
})
import {
  archiveHarnessProject,
  createHarnessProject,
  deleteHarnessProject,
  getDefaultHarnessProjectDirectoryPreview,
  getHarnessProjectDetails,
  refreshFollowedHarnessProjects,
  updateHarnessProjectMetadata
} from "./service"
import { initializeHarnessConfigV2 } from "./config-v2"
import { onHarnessFeatureCatalogChange } from "./feature-catalog-lifecycle"

const automaticInput = () => ({
  adapterId: "plugin",
  adapterType: "plugin" as const,
  name: "项目名称",
  description: "",
  projectCode: "P001",
  projectFromLean: false,
  isTestProject: false,
  systemId: "system",
  systemName: "系统"
})
const input = () => ({
  ...automaticInput(),
  workspacePath: join(state.root, "work space"),
  projectDir: "项目_A-1"
})
const storePath = () => join(state.root, "harness-board-projects.json")
const projectPath = () => join(input().workspacePath, input().projectDir)

async function writeProjectCreateCommand(command: string, projectStatus?: string): Promise<void> {
  await writeFile(
    join(state.root, "plugin", "board_core", "board_config.json"),
    JSON.stringify({
      apiVersion: 1,
      inspectCommands: {
        [process.platform]: { create_project: command, project_status: projectStatus }
      }
    })
  )
}

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
  await writeProjectCreateCommand(
    `"${process.execPath}" "\${pluginPath}/init.cjs" "\${pluginWorkspace}" "\${projectDir}"`
  )
})
afterEach(() => rm(state.root, { recursive: true, force: true }))

describe("create project in a managed directory", () => {
  const previewProjectId = "7adc35d3-dac4-4cb3-973c-8ccdd037ed2b"

  it.each([{}, { workspacePath: "", projectDir: "" }])(
    "creates the default directory when no folder is selected (%j)",
    async (workspace) => {
      const workspacePath = join(state.root, "project-workspaces")
      const created = await createHarnessProject({ ...automaticInput(), ...workspace })
      const projectDir = created.projectId
      const initialized = JSON.parse(
        await readFile(join(workspacePath, projectDir, "initialized.json"), "utf8")
      )
      expect(initialized).toEqual({ workspacePath, projectDir })
      const store = JSON.parse(await readFile(storePath(), "utf8"))
      expect(store.projects[0]).toMatchObject({ workspacePath, projectDir })
    }
  )

  it("uses the previewed directory and preserves plugin output if initialization fails", async () => {
    const workspacePath = join(state.root, "project-workspaces")
    const preview = getDefaultHarnessProjectDirectoryPreview(previewProjectId)
    expect(preview).toBe(join(workspacePath, previewProjectId))
    await expect(readdir(workspacePath)).rejects.toMatchObject({ code: "ENOENT" })

    const scriptPath = join(state.root, "plugin", "init.cjs")
    const workingScript = await readFile(scriptPath, "utf8")
    await writeFile(scriptPath, `${workingScript}\nprocess.exit(1)`)
    const createInput = { ...automaticInput(), projectId: previewProjectId }

    await expect(createHarnessProject(createInput)).rejects.toThrow(
      "插件「plugin」执行「create_project」失败"
    )
    const initialized = JSON.parse(await readFile(join(preview, "initialized.json"), "utf8"))
    expect(initialized).toEqual({ workspacePath, projectDir: previewProjectId })
    await expect(readFile(storePath())).rejects.toMatchObject({ code: "ENOENT" })

    await writeFile(scriptPath, workingScript)
    const created = await createHarnessProject(automaticInput())
    expect(created).toMatchObject({
      projectDir: created.projectId,
      workspacePath
    })
    expect(created.projectId).not.toBe(previewProjectId)
    expect(await readdir(preview)).toEqual(["initialized.json"])
  })

  it("rejects an invalid project ID before previewing or creating the directory", async () => {
    const projectId = "../invalid"
    expect(() => getDefaultHarnessProjectDirectoryPreview(projectId)).toThrow("项目 ID 无效")
    await expect(createHarnessProject({ ...automaticInput(), projectId })).rejects.toThrow(
      "项目 ID 无效"
    )
    await expect(readdir(join(state.root, "project-workspaces"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  })

  it("rejects a duplicate ID even when the second project uses a manual directory", async () => {
    await createHarnessProject({ ...automaticInput(), projectId: previewProjectId })
    await expect(
      createHarnessProject({ ...input(), projectCode: "P002", projectId: previewProjectId })
    ).rejects.toThrow("项目 ID 已被使用")
    expect(await readdir(projectPath())).toEqual([])
  })

  it.each([{ workspacePath: "/tmp" }, { projectDir: "my-project" }])(
    "rejects an incomplete manual selection (%j)",
    async (workspace) => {
      await expect(createHarnessProject({ ...automaticInput(), ...workspace })).rejects.toThrow(
        "请选择完整的插件工作区文件夹"
      )
      await expect(readdir(join(state.root, "project-workspaces"))).rejects.toMatchObject({
        code: "ENOENT"
      })
    }
  )
})

describe("create project with an explicitly specified workspace", () => {
  it("creates the specified workspace and its missing parent for HTTP creation", async () => {
    const workspacePath = join(state.root, "http", "parent")
    const projectDir = "项目_HTTP"
    const created = await createHarnessProject(
      { ...automaticInput(), workspacePath, projectDir },
      { createSpecifiedWorkspace: true }
    )

    expect(created).toMatchObject({ workspacePath, projectDir })
    const file = await readFile(join(workspacePath, projectDir, "initialized.json"), "utf8")
    expect(JSON.parse(file)).toEqual({ workspacePath, projectDir })
  })

  it("rejects an existing workspace for HTTP creation even when it is empty", async () => {
    await expect(createHarnessProject(input(), { createSpecifiedWorkspace: true })).rejects.toThrow(
      "指定的项目工作区已存在"
    )
    expect(await readdir(projectPath())).toEqual([])
    await expect(readFile(storePath())).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("requires a selected workspace to exist for UI creation", async () => {
    const projectDir = "missing"
    await expect(createHarnessProject({ ...input(), projectDir })).rejects.toThrow(
      "项目工作区文件夹不存在或无法访问"
    )
    await expect(readdir(join(input().workspacePath, projectDir))).rejects.toMatchObject({
      code: "ENOENT"
    })
  })
})

describe("inspect projects sharing a managed workspace", () => {
  it.each([
    ["${projectDir}", false],
    ["${projectDirs...}", true],
    ["${projectCodes...}", true]
  ])("queries all projects when the plugin uses %s", async (placeholder, supportsBatch) => {
    const first = await createHarnessProject(automaticInput())
    const second = await createHarnessProject({ ...automaticInput(), projectCode: "P002" })
    const projectIds = [first.projectId, second.projectId]
    const logPath = join(state.root, "plugin", "inspected.jsonl")
    await writeFile(
      join(state.root, "plugin", "inspect.cjs"),
      `const fs = require("node:fs");
const projectDirs = process.argv.slice(2);
fs.appendFileSync("inspected.jsonl", JSON.stringify(projectDirs) + "\\n");
console.log(JSON.stringify({
  workflow: {},
  projects: Object.fromEntries(projectDirs.map((dir) => [dir, { runs: [] }]))
}));`
    )
    await writeProjectCreateCommand(
      "",
      `"${process.execPath}" "\${pluginPath}/inspect.cjs" "${placeholder}"`
    )

    const details = await getHarnessProjectDetails(projectIds)
    expect(projectIds.map((id) => details[id].error)).toEqual([null, null])
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls).toEqual(supportsBatch ? [projectIds] : [[first.projectId], [second.projectId]])
  })

  it("identifies project_status when the plugin returns no project status", async () => {
    const { projectId } = await createHarnessProject(automaticInput())
    await writeFile(
      join(state.root, "plugin", "inspect.cjs"),
      "console.log(JSON.stringify({ workflow: {}, projects: {} }))"
    )
    await writeProjectCreateCommand("", `"${process.execPath}" "\${pluginPath}/inspect.cjs"`)

    const details = await getHarnessProjectDetails([projectId])
    expect(details[projectId].error).toBe(
      "插件「plugin」执行「project_status」失败，请联系插件开发者"
    )
  })
})

describe("create project in a selected directory", () => {
  it("notifies after committed deletion and recovers missed deletions from an intact registry", async () => {
    const created = await createHarnessProject(input())
    const changed = vi.fn()
    const unsubscribe = onHarnessFeatureCatalogChange(changed)
    try {
      await archiveHarnessProject(created.projectId)
      await expect(deleteHarnessProject("unknown")).rejects.toThrow("not found")
      expect(changed).not.toHaveBeenCalled()
      await deleteHarnessProject(created.projectId)
      expect(changed.mock.calls).toEqual([[created.projectId, new Set()]])
      changed.mockClear()
      await refreshFollowedHarnessProjects([created.projectId])
      expect(changed.mock.calls).toEqual([[created.projectId, new Set()]])
      changed.mockClear()
      await writeFile(storePath(), JSON.stringify({ projects: [{}] }))
      await refreshFollowedHarnessProjects([created.projectId])
      await rm(storePath())
      await refreshFollowedHarnessProjects([created.projectId])
      expect(changed).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })
  it.each([true, false])(
    "persists the explicit test project selection: %s",
    async (isTestProject) => {
      const created = await createHarnessProject({ ...input(), isTestProject })
      expect(created.isTestProject).toBe(isTestProject)
      const store = JSON.parse(await readFile(storePath(), "utf8"))
      expect(store.projects[0].isTestProject).toBe(isTestProject)
      expect(created.lifecycle.createAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    }
  )

  it.each([undefined, null, "false", 0])(
    "rejects missing or invalid test project selection before initialization: %j",
    async (isTestProject) => {
      await expect(
        createHarnessProject({ ...input(), isTestProject } as unknown as ReturnType<typeof input>)
      ).rejects.toThrow("请选择是否作为测试项目")
      expect(await readdir(projectPath())).toEqual([])
      await expect(readFile(storePath())).rejects.toMatchObject({ code: "ENOENT" })
    }
  )

  it.each([true, false])("updates the test project selection to %s", async (isTestProject) => {
    const created = await createHarnessProject({ ...input(), isTestProject: !isTestProject })
    const updated = await updateHarnessProjectMetadata(created.projectId, {
      ...input(),
      isTestProject
    })
    expect(updated.isTestProject).toBe(isTestProject)
    const store = JSON.parse(await readFile(storePath(), "utf8"))
    expect(store.projects[0].isTestProject).toBe(isTestProject)
    expect(updated.lifecycle.updateAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it.each([undefined, null, "false", 0])(
    "rejects edits without a boolean test project selection: %j",
    async (isTestProject) => {
      const created = await createHarnessProject(input())
      const before = await readFile(storePath(), "utf8")
      await expect(
        updateHarnessProjectMetadata(created.projectId, {
          ...input(),
          isTestProject
        } as unknown as ReturnType<typeof input>)
      ).rejects.toThrow("请选择是否作为测试项目")
      expect(await readFile(storePath(), "utf8")).toBe(before)
    }
  )

  it("keeps legacy projects unselected until an explicit metadata edit", async () => {
    const created = await createHarnessProject(input())
    const store = JSON.parse(await readFile(storePath(), "utf8"))
    delete store.projects[0].isTestProject
    await writeFile(storePath(), JSON.stringify(store))

    const archived = await archiveHarnessProject(created.projectId)
    expect(archived).not.toHaveProperty("isTestProject")
    const unchanged = JSON.parse(await readFile(storePath(), "utf8"))
    expect(unchanged.projects[0]).not.toHaveProperty("isTestProject")

    const updated = await updateHarnessProjectMetadata(created.projectId, {
      ...input(),
      isTestProject: true
    })
    expect(updated.isTestProject).toBe(true)
  })

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

  it("shows the plugin and command names and logs the original failure", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await writeFile(
        join(state.root, "plugin", "init.cjs"),
        'console.error("spawn python ENOENT"); process.exit(1)'
      )

      await expect(createHarnessProject(input())).rejects.toMatchObject({
        message: "插件「plugin」执行「create_project」失败，请联系插件开发者"
      })
      expect(logs).toHaveBeenCalledWith(expect.stringContaining("exit 1: spawn python ENOENT"))
      await expect(readFile(storePath())).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      logs.mockRestore()
    }
  })

  it.each([
    ["python", "请安装最新版 Python 3"],
    ["python3", "请安装最新版 Python 3"],
    ["python.exe", "请安装最新版 Python 3"],
    ["missing-plugin-command", "插件「plugin」执行「create_project」失败，请联系插件开发者"]
  ])("shows the appropriate message when %s cannot start", async (command, message) => {
    const emptyPath = join(state.root, "empty-path")
    await mkdir(emptyPath)
    await writeProjectCreateCommand(command)
    const logs = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubEnv("PATH", emptyPath)
    try {
      await expect(createHarnessProject(input())).rejects.toMatchObject({ message })
      expect(logs).toHaveBeenCalledWith(expect.stringContaining(`spawn ${command} ENOENT`))
      await expect(readFile(storePath())).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      vi.unstubAllEnvs()
      logs.mockRestore()
    }
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
