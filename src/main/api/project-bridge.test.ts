import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  updateProject: vi.fn(),
  notify: vi.fn()
}))
vi.mock("../harness-board/service", () => ({
  listHarnessProjects: mocks.listProjects,
  getHarnessProjectDetail: vi.fn(),
  getHarnessRunDetail: vi.fn(),
  getHarnessDynamicWorkflowConfig: vi.fn(),
  resolveHarnessAdapterByName: vi.fn(),
  requireHarnessFeatureWorkspace: vi.fn()
}))
vi.mock("../harness-board/mutations", () => ({
  createProject: vi.fn(), updateProject: mocks.updateProject, createFeature: vi.fn()
}))
vi.mock("../services/thread-service", () => ({ createThreadService: vi.fn() }))
vi.mock("../renderer-notifications", () => ({ notifyRenderer: mocks.notify }))

import { apiUpdateProject } from "./project-bridge"

beforeEach(() => vi.clearAllMocks())

describe("HTTP project updates after UAT integration", () => {
  it.each([true, false, undefined])("preserves test-project policy %j on a partial update", async isTestProject => {
    const existing = {
      projectId: "project-a", name: "Original", projectCode: "A", projectFromLean: false,
      isTestProject, description: "Description", systemId: "system", systemName: "System",
      workspacePath: "C:/workspace", projectDir: "project-folder",
      harnessAdapter: { id: "adapter", type: "plugin" }
    }
    mocks.listProjects.mockResolvedValue([existing])
    const updated = { ...existing, name: "Updated" }
    mocks.updateProject.mockResolvedValue(updated)
    await expect(apiUpdateProject("project-a", { name: "Updated" })).resolves.toBe(updated)
    expect(mocks.updateProject).toHaveBeenCalledExactlyOnceWith("project-a", {
      adapterId: "adapter", adapterType: "plugin", name: "Updated", projectCode: "A",
      projectFromLean: false, isTestProject, description: "Description", systemId: "system",
      systemName: "System", workspacePath: "C:/workspace", projectDir: "project-folder"
    })
    expect(mocks.notify).toHaveBeenCalledWith("harnessBoard:apiChanged", { projectId: "project-a" })
  })
})
