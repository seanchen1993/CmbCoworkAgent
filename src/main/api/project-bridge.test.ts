import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  notify: vi.fn()
}))
vi.mock("../harness-board/service", () => ({
  listHarnessProjects: mocks.listProjects,
  getHarnessProjectDetail: vi.fn(),
  getHarnessRunDetail: vi.fn(),
  getHarnessDynamicWorkflowConfig: vi.fn(),
  resolveHarnessAdapterByName: vi.fn(async () => adapter),
  requireHarnessFeatureWorkspace: vi.fn()
}))
vi.mock("../harness-board/mutations", () => ({
  createProject: mocks.createProject,
  updateProject: mocks.updateProject,
  createFeature: vi.fn()
}))
vi.mock("../services/thread-service", () => ({ createThreadService: vi.fn() }))
vi.mock("../renderer-notifications", () => ({ notifyRenderer: mocks.notify }))

import { apiCreateProject, apiProjectError, apiUpdateProject } from "./project-bridge"

beforeEach(() => vi.clearAllMocks())

describe("HTTP project updates after UAT integration", () => {
  it.each([true, false])("preserves test-project policy %j on a partial update", async isTestProject => {
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

const adapter = { id: "adapter-id", type: "plugin" }
const projectId = "project-id"
const defaultWorkspaceBody = {
  "harness-adapter": { name: "adapter" },
  name: "项目",
  projectCode: "P001",
  projectFromLean: true,
  description: "项目描述",
  systemId: "system-id",
  systemName: "系统"
}
const body = {
  ...defaultWorkspaceBody,
  projectDir: "project",
  workspacePath: "/workspace"
}
const creator = { userName: "张三" }
const invalidSelection = {
  status: 400,
  code: "invalid_request",
  message: "isTestProject 必须是 boolean"
}

describe("HTTP project workspace", () => {
  beforeEach(() => mocks.createProject.mockResolvedValue({ projectId }))

  it("uses the service default when both workspace fields are omitted", async () => {
    await apiCreateProject({ ...defaultWorkspaceBody, isTestProject: false })
    const [input] = mocks.createProject.mock.calls[0]
    expect(input).not.toHaveProperty("workspacePath")
    expect(input).not.toHaveProperty("projectDir")
  })

  it("asks the service to create an explicit workspace", async () => {
    await apiCreateProject({ ...body, isTestProject: false })
    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/workspace", projectDir: "project" }),
      { createSpecifiedWorkspace: true }
    )
  })

  it("reports an existing workspace as a conflict", () => {
    const message = "指定的项目工作区已存在"
    expect(apiProjectError(new Error(message))).toEqual({
      status: 409,
      error: "resource_conflict",
      message
    })
  })

  it.each([{ workspacePath: "/workspace" }, { projectDir: "project" }])(
    "rejects an incomplete workspace %j",
    async (workspace) => {
      await expect(
        apiCreateProject({ ...defaultWorkspaceBody, ...workspace, isTestProject: false })
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" })
      expect(mocks.createProject).not.toHaveBeenCalled()
    }
  )
})

describe("HTTP project system constraints", () => {
  beforeEach(() => {
    mocks.createProject.mockResolvedValue({ projectId })
    mocks.updateProject.mockResolvedValue({ projectId })
    mocks.listProjects.mockResolvedValue([
      {
        ...body,
        projectId,
        harnessAdapter: adapter,
        isTestProject: false,
        knowledgeBaseIds: ["old"]
      }
    ])
  })

  it("passes system constraint IDs to creation with the default workspace", async () => {
    const knowledgeBaseIds = ["payment-constraints-main"]
    await apiCreateProject({ ...defaultWorkspaceBody, isTestProject: false, knowledgeBaseIds })
    expect(mocks.createProject.mock.calls[0][0]).toMatchObject({ knowledgeBaseIds })
  })

  it.each([{ knowledgeBaseIds: ["replacement"] }, { knowledgeBaseIds: [] }])(
    "passes $knowledgeBaseIds as the new list on update",
    async ({ knowledgeBaseIds }) => {
      await apiUpdateProject(projectId, { knowledgeBaseIds })
      expect(mocks.updateProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ knowledgeBaseIds })
      )
    }
  )

  it("leaves the existing bindings to the service on an unrelated update", async () => {
    await apiUpdateProject(projectId, { name: "更新后的项目" })
    expect(mocks.updateProject.mock.calls[0][1]).not.toHaveProperty("knowledgeBaseIds")
  })

  it.each([{ value: "constraints" }, { value: [12] }, { value: null }])(
    "rejects invalid constraint IDs $value on create and update",
    async ({ value }) => {
      const expected = { status: 400, code: "invalid_request" }
      await expect(
        apiCreateProject({ ...defaultWorkspaceBody, isTestProject: false, knowledgeBaseIds: value })
      ).rejects.toMatchObject(expected)
      await expect(apiUpdateProject(projectId, { knowledgeBaseIds: value })).rejects.toMatchObject(
        expected
      )
      expect(mocks.createProject).not.toHaveBeenCalled()
      expect(mocks.updateProject).not.toHaveBeenCalled()
    }
  )

  it("reports unavailable constraints as a client error", () => {
    const message = "所选知识库当前不可用，请刷新知识库列表后重试"
    expect(apiProjectError(new Error(message))).toEqual({
      status: 400,
      error: "invalid_request",
      message
    })
  })
})

describe("HTTP project test selection", () => {
  beforeEach(() => {
    mocks.listProjects.mockResolvedValue([
      { ...body, projectId, harnessAdapter: adapter, isTestProject: true }
    ])
    mocks.createProject.mockResolvedValue({ projectId })
    mocks.updateProject.mockResolvedValue({ projectId })
  })

  it.each([true, false])("passes %s and the creator to project creation", async (isTestProject) => {
    await apiCreateProject({ ...body, isTestProject, creator })
    expect(mocks.createProject.mock.calls[0][0]).toMatchObject({ isTestProject, creator })
  })

  it.each([{}, { isTestProject: "false" }, { isTestProject: null }])(
    "rejects missing or invalid creation input %j",
    async (selection) => {
      await expect(apiCreateProject({ ...body, ...selection })).rejects.toMatchObject(
        invalidSelection
      )
      expect(mocks.createProject).not.toHaveBeenCalled()
    }
  )

  it("preserves the selection when updating only the creator", async () => {
    await apiUpdateProject(projectId, { creator })
    expect(mocks.updateProject).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ isTestProject: true, creator })
    )
  })

  it("allows editing the selection to false", async () => {
    await apiUpdateProject(projectId, { isTestProject: false })
    expect(mocks.updateProject).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ isTestProject: false })
    )
  })

  it("requires a selection when editing a project that has no saved value", async () => {
    mocks.listProjects.mockResolvedValueOnce([
      { ...body, projectId, harnessAdapter: adapter }
    ])
    await expect(apiUpdateProject(projectId, { creator })).rejects.toMatchObject(invalidSelection)
    expect(mocks.updateProject).not.toHaveBeenCalled()
  })
})
