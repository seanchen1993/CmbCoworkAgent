import { expect, it } from "vitest"
import type { HarnessProjectListItem } from "../../../shared/harness-board-types"
import { findExistingPluginProject } from "../components/harness-board/harness-existing-project-intent"

const project = (projectId: string, id: string, type = "plugin") =>
  ({
    projectId,
    harnessAdapter: { id, type }
  }) as HarnessProjectListItem

it("opens only the exact existing project and installed plugin identity", () => {
  const selected = project("original", "installed-plugin")
  const rows = [project("another", "installed-plugin"), selected]
  expect(
    findExistingPluginProject(rows, { projectId: "original", pluginId: "installed-plugin" })
  ).toBe(selected)
  expect(
    findExistingPluginProject(rows, { projectId: "missing", pluginId: "installed-plugin" })
  ).toBeNull()
  expect(
    findExistingPluginProject(rows, { projectId: "original", pluginId: "replacement-plugin" })
  ).toBeNull()
  expect(findExistingPluginProject(rows, { pluginId: "installed-plugin" })).toBeNull()
  expect(
    findExistingPluginProject([project("original", "installed-plugin", "builtin")], {
      projectId: "original",
      pluginId: "installed-plugin"
    })
  ).toBeNull()
})
