import { expect, it } from "vitest"
import type { HarnessProjectListItem } from "../../../shared/harness-board-types"
import { installedProjectPluginIdentity, nativeProjectBindings } from "./native-project-binding"

const installed = { id: "plugin", name: "Review", version: "2", enabled: true }
const project = {
  projectId: "project",
  name: "Review project",
  workspacePath: "C:/projects",
  projectDir: "review",
  harnessAdapter: { id: "plugin", name: "Review", type: "plugin", boundVersion: "1" },
  lifecycle: { status: "active" },
  boardCompatibility: { compatible: true }
} as HarnessProjectListItem

it("includes installed path and replacement revision without inventing missing fields", () => {
  expect(installedProjectPluginIdentity({ ...installed })).toBe(
    installedProjectPluginIdentity(installed)
  )
  const pinned = { ...installed, path: "C:/plugins/first", updatedAt: "one" }
  expect(installedProjectPluginIdentity({ ...pinned, path: "C:/plugins/reinstalled" })).not.toBe(
    installedProjectPluginIdentity(pinned)
  )
  expect(installedProjectPluginIdentity({ ...pinned, updatedAt: "two" })).not.toBe(
    installedProjectPluginIdentity(pinned)
  )
})

it("distinguishes another directory from an absent binding", () => {
  expect(
    nativeProjectBindings("plugin", "C:/elsewhere", [], [project], installed)[0]
  ).toMatchObject({ reason: "other-workspace", versionChanged: true })
  expect(nativeProjectBindings("other", "C:/projects", [], [project], installed)).toEqual([])
})

it("does not infer a version failure from an unavailable catalog or an old version field", () => {
  expect(
    nativeProjectBindings("plugin", "C:/projects", [project], [project], installed)[0]
  ).toMatchObject({ reason: "available", versionChanged: true })
  const legacy = {
    ...project,
    harnessAdapter: { ...project.harnessAdapter, boundVersion: undefined }
  }
  expect(
    nativeProjectBindings("plugin", "C:/projects/review", [], [legacy], installed)[0]
  ).toMatchObject({ reason: "unavailable", sameWorkspace: true, versionChanged: false })
})

it("reports disabled and missing plugins without granting or changing their binding", () => {
  expect(
    nativeProjectBindings("plugin", "C:/projects", [], [project], {
      ...installed,
      enabled: false
    })[0].reason
  ).toBe("disabled")
  expect(nativeProjectBindings("plugin", "C:/projects", [], [project], undefined)[0].reason).toBe(
    "missing"
  )
  expect(project.harnessAdapter.boundVersion).toBe("1")
})

it("keeps compatibility failures separate from directory mismatch and hides archived projects", () => {
  const incompatible = {
    ...project,
    boardCompatibility: { compatible: false }
  } as HarnessProjectListItem
  expect(
    nativeProjectBindings("plugin", "C:/elsewhere", [], [incompatible], installed)[0].reason
  ).toBe("incompatible")
  const archived = { ...project, lifecycle: { ...project.lifecycle, status: "archived" as const } }
  expect(nativeProjectBindings("plugin", "C:/projects", [], [archived], installed)).toEqual([])
})
