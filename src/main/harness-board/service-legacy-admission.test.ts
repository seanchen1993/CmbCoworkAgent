import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createProjectTemplate } from "../mods/devtools/project-template"
import type { PluginMetadata } from "../types"
import type { HarnessProjectCreateInput } from "../../shared/harness-board-types"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => state.plugins,
  getUserInfo: () => undefined
}))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))

let service: typeof import("./service")
beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), "harness-direct-admission-"))
  const path = join(state.root, "plugin")
  await mkdir(join(path, "board_core"), { recursive: true })
  const command = join(path, "create-project.cjs")
  await writeFile(
    command,
    `require("node:fs").writeFileSync(${JSON.stringify(join(state.root, "created-marker.txt"))}, "created by original command")`
  )
  await writeFile(
    join(path, "board_core/board_config.json"),
    JSON.stringify({
      apiVersion: 1,
      inspectCommands: {
        [process.platform]: { create_project: `"${process.execPath}" "${command}"` }
      }
    })
  )
  state.plugins = [
    {
      id: "plugin",
      name: "native-package",
      path,
      version: "1.0.0",
      enabled: true,
      description: "fixture",
      author: "fixture",
      skillCount: 0,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  service = await import("./service")
})
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

function input(): HarnessProjectCreateInput {
  return {
    adapterId: "plugin",
    adapterType: "plugin",
    name: "Project",
    description: "",
    projectCode: "sample",
    projectDir: "sample",
    projectFromLean: false,
    systemId: "system",
    systemName: "System",
    workspacePath: state.root
  }
}
async function declareHost() {
  const source = createProjectTemplate({ packageId: "native-package", name: "Host" })
  await writeFile(
    join(state.plugins[0].path, "devclaw.project-runtime.json"),
    source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
  )
}

it("rejects direct legacy create by installed Host id or name even with board-shaped ordinary data", async () => {
  await declareHost()
  for (const adapterId of ["plugin", "native-package"])
    await expect(service.createHarnessProject({ ...input(), adapterId })).rejects.toThrow(
      "Selected plugin is not installed or does not provide"
    )
})

it("preserves old creation and rejects an existing binding changed to a native Host declaration", async () => {
  const project = await service.createHarnessProject(input())
  expect(project["harness-adapter"].id).toBe("plugin")
  expect(await readFile(join(state.root, "created-marker.txt"), "utf8")).toBe(
    "created by original command"
  )
  const before = await readFile(join(state.root, "harness-board-projects.json"), "utf8")
  await declareHost()
  await expect(service.updateHarnessProjectMetadata(project.projectId, input())).rejects.toThrow(
    "Selected plugin is not installed or does not provide"
  )
  expect(await readFile(join(state.root, "harness-board-projects.json"), "utf8")).toBe(before)
})
