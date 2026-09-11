import { readThreadWorkspacePathInWorker } from "../thread-metadata-hydration/client"
import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { getAllThreadSummaries } from "../db"
import {
  listHarnessProjects,
  getHarnessProjectDetail,
  getHarnessRunDetail,
  getHarnessDynamicWorkflowConfig,
  resolveHarnessAdapterByName,
  readHarnessFeatureMetadata
} from "../harness-board/service"
import { createProject, updateProject, createFeature } from "../harness-board/mutations"
import { createThreadService } from "../services/thread-service"
import {
  HARNESS_SOURCE,
  type HarnessProjectCreateInput,
  type HarnessDeployUnitMapping
} from "../../shared/harness-board-types"
import {
  defaultWorkflowTemplateId,
  requiredWorkflowNodeIds,
  resolveHarnessSessionWorkspace
} from "../../shared/harness-feature-defaults"
import { resolveHarnessNextAction } from "../../shared/harness-run-next-action"
import { notifyRenderer } from "../renderer-notifications"

export class ApiInputError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code
  ) {
    super(message)
  }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiInputError(400, "invalid_request", "请求体必须是 JSON 对象")
  }
  return value as Record<string, unknown>
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== "string" || !value.trim())
    throw new ApiInputError(400, "invalid_request", `${key} 必填`)
  return value.trim()
}

function allowedKeys(body: Record<string, unknown>, keys: string[]): void {
  const unexpected = Object.keys(body).find((key) => !keys.includes(key))
  if (unexpected) throw new ApiInputError(400, "invalid_request", `不支持字段 ${unexpected}`)
}

async function requireDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
    throw new ApiInputError(400, "invalid_workspace_path", "workspacePath 必须是有效绝对目录")
  }
  const path = value.trim()
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory())
    throw new ApiInputError(400, "invalid_workspace_path", "目录不存在或不可访问")
  return path
}

async function requireProject(projectId: string) {
  const project = (await listHarnessProjects()).find((item) => item.projectId === projectId)
  if (!project) throw new ApiInputError(404, "project_not_found")
  return project
}

async function projectAdapterInput(value: unknown) {
  const adapterInput = requireObject(value)
  allowedKeys(adapterInput, ["name"])
  const adapterName = requiredText(adapterInput, "name")
  return resolveHarnessAdapterByName(adapterName).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "adapter_not_installed" || message === "adapter_name_ambiguous") throw error
    throw new ApiInputError(422, "adapter_unavailable", message)
  })
}

async function projectInput(body: Record<string, unknown>): Promise<HarnessProjectCreateInput> {
  allowedKeys(body, [
    "harness-adapter",
    "name",
    "projectCode",
    "projectFromLean",
    "projectDir",
    "description",
    "systemId",
    "systemName",
    "workspacePath",
    "sessionWorkspacePath"
  ])
  const fields = Object.fromEntries(
    [
      "name",
      "projectCode",
      "projectDir",
      "description",
      "systemId",
      "systemName",
      "workspacePath"
    ].map((key) => [key, requiredText(body, key)])
  )
  if (typeof body.projectFromLean !== "boolean")
    throw new ApiInputError(400, "invalid_request", "projectFromLean 必须是 boolean")
  if (body.sessionWorkspacePath !== undefined && typeof body.sessionWorkspacePath !== "string")
    throw new ApiInputError(400, "invalid_request", "sessionWorkspacePath 必须是 string")
  const adapter = await projectAdapterInput(body["harness-adapter"])
  return {
    ...fields,
    adapterId: adapter.id,
    adapterType: adapter.type,
    projectFromLean: body.projectFromLean,
    sessionWorkspacePath: body.sessionWorkspacePath
  } as HarnessProjectCreateInput
}

function projectChanged(projectId: string): void {
  notifyRenderer("harnessBoard:apiChanged", { projectId })
}

export async function apiCreateProject(body: Record<string, unknown>) {
  const project = await createProject(await projectInput(body))
  projectChanged(project.projectId)
  return project
}

export async function apiUpdateProject(projectId: string, body: Record<string, unknown>) {
  allowedKeys(body, [
    "harness-adapter",
    "name",
    "projectCode",
    "projectFromLean",
    "description",
    "systemId",
    "systemName",
    "sessionWorkspacePath"
  ])
  const existing = await requireProject(projectId)
  const input: HarnessProjectCreateInput = {
    adapterId: existing.harnessAdapter.id,
    adapterType: existing.harnessAdapter.type,
    name: existing.name,
    projectCode: existing.projectCode,
    projectFromLean: existing.projectFromLean,
    description: existing.description,
    systemId: existing.systemId,
    systemName: existing.systemName,
    workspacePath: existing.workspacePath,
    projectDir: existing.projectDir,
    sessionWorkspacePath: existing.sessionWorkspacePath
  }
  for (const key of ["name", "projectCode", "description", "systemId", "systemName"] as const) {
    if (key in body) input[key] = requiredText(body, key)
  }
  if ("projectFromLean" in body) {
    if (typeof body.projectFromLean !== "boolean")
      throw new ApiInputError(400, "invalid_request", "projectFromLean 必须是 boolean")
    input.projectFromLean = body.projectFromLean
  }
  if ("sessionWorkspacePath" in body) {
    if (typeof body.sessionWorkspacePath !== "string")
      throw new ApiInputError(400, "invalid_request", "sessionWorkspacePath 必须是 string")
    input.sessionWorkspacePath = body.sessionWorkspacePath
  }
  if ("harness-adapter" in body) {
    const adapter = await projectAdapterInput(body["harness-adapter"])
    input.adapterId = adapter.id
    input.adapterType = adapter.type
  }
  const project = await updateProject(projectId, input)
  projectChanged(project.projectId)
  return project
}

export async function apiCreateFeature(projectId: string, body: Record<string, unknown>) {
  allowedKeys(body, ["feature", "selectedDeployUnits"])
  const feature = requiredText(body, "feature")
  const project = await requireProject(projectId)
  if (body.selectedDeployUnits !== undefined) {
    if (!Array.isArray(body.selectedDeployUnits) || body.selectedDeployUnits.length === 0)
      throw new ApiInputError(
        400,
        "invalid_request",
        "selectedDeployUnits 必须是非空数组；不选择时省略"
      )
    for (const value of body.selectedDeployUnits) {
      const mapping = requireObject(value)
      for (const field of ["deployUnitIdMapping", "deployUnitId", "localRepoPath"])
        requiredText(mapping, field)
      if (mapping.description !== undefined && typeof mapping.description !== "string")
        throw new ApiInputError(400, "invalid_request", "description 必须是 string")
    }
  }
  // The UI also leaves its template empty when loading the optional config fails.
  const config = await getHarnessDynamicWorkflowConfig(projectId).catch(() => null)
  const templateId = defaultWorkflowTemplateId(config)
  const required = requiredWorkflowNodeIds(config, templateId)
  const template = config?.templates[0]
  const result = await createFeature({
    projectId,
    feature,
    sessionContextInjectionSource: project.supportsSessionContextInjection
      ? "plugin"
      : "cmbdevclaw",
    ...(body.selectedDeployUnits
      ? { selectedDeployUnits: body.selectedDeployUnits as HarnessDeployUnitMapping[] }
      : {}),
    ...(config && templateId
      ? {
          workflowTemplate: templateId,
          workflowConfig: config,
          ...(template?.templateType === "custom"
            ? {
                workflowNodes: config.nodes
                  .filter((node) => required.has(node.id))
                  .map((node) => node.id)
              }
            : {})
        }
      : {})
  })
  projectChanged(projectId)
  return { projectId: result.projectId, featureId: result.slug }
}

export async function apiCreateFeatureThread(body: Record<string, unknown>) {
  allowedKeys(body, [
    "threadType",
    "projectId",
    "featureId",
    "workspacePath",
    "title",
    "model",
    "agentMode",
    "yolo",
    "sandbox"
  ])
  const projectId = requiredText(body, "projectId")
  const slug = requiredText(body, "featureId")
  const project = await requireProject(projectId)
  const detail = await getHarnessProjectDetail(projectId)
  if (!detail.runs.some((run) => run.slug === slug))
    throw new ApiInputError(404, "feature_not_found")
  const metadata: Record<string, unknown> = {}
  for (const field of ["title", "model", "agentMode"]) {
    if (field in body) metadata[field] = requiredText(body, field)
  }
  if (
    metadata.agentMode !== undefined &&
    !["normal", "coordinator", "workflow"].includes(String(metadata.agentMode))
  )
    throw new ApiInputError(400, "invalid_request", "agentMode 无效")
  for (const field of ["yolo", "sandbox"]) {
    if (!(field in body)) continue
    if (typeof body[field] !== "boolean")
      throw new ApiInputError(400, "invalid_request", `${field} 必须是 boolean`)
    metadata[field] = body[field]
  }
  const workspacePath =
    "workspacePath" in body
      ? await requireDirectory(body.workspacePath)
      : await resolveHarnessSessionWorkspace(
          project.sessionWorkspacePath,
          (project.sessionWorkspacePath?.trim() ? [] : getAllThreadSummaries()).flatMap((row) => {
            let stored: Record<string, unknown>
            try {
              const value: unknown = row.metadata ? JSON.parse(row.metadata) : {}
              if (!value || typeof value !== "object" || Array.isArray(value)) return []
              stored = value as Record<string, unknown>
            } catch {
              // An unrelated corrupt historical row must not block a new session.
              return []
            }
            const binding = readHarnessFeatureMetadata(stored)
            if (
              stored.harnessProjectSession ||
              binding?.projectId !== projectId ||
              binding.slug !== slug
            )
              return []
            return [
              {
                threadId: row.thread_id,
                lastActiveAt: new Date(row.updated_at).toISOString(),
                workspacePaths: [stored.workspacePath]
              }
            ]
          }),
          readThreadWorkspacePathInWorker
        )
  const runDetail = await getHarnessRunDetail(projectId, slug)
  const node = runDetail.run.nodes.find((item) => item.id === runDetail.run.currentNodeId)
  const nextAction = node
    ? resolveHarnessNextAction(runDetail.workflow, node.id, node.nodeStatus)
    : undefined
  const thread = await createThreadService(
    {
      ...metadata,
      workspacePath,
      harnessFeature: { projectId, slug, source: HARNESS_SOURCE }
    },
    { grantFeatureAccess: true }
  )
  notifyRenderer("threads:changed")
  if (nextAction)
    notifyRenderer("threads:apiFeatureCreated", { threadId: thread.thread_id, nextAction })
  return thread
}

export function apiProjectError(error: unknown): {
  status: number
  error: string
  message: string
} {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof URIError) return { status: 400, error: "invalid_path", message }
  if (error instanceof ApiInputError) return { status: error.status, error: error.code, message }
  // Keep legacy service errors unchanged until the UAT domain-error migration.
  if (message === "adapter_not_installed") return { status: 404, error: message, message }
  if (message === "adapter_name_ambiguous") return { status: 409, error: message, message }
  if (/已存在|已有项目|已有文件夹/.test(message))
    return { status: 409, error: "resource_conflict", message }
  if (/Selected plugin|compatible/.test(message))
    return { status: 422, error: "adapter_unavailable", message }
  if (
    /不允许修改|不能为空|必须|必填|仅支持|只允许|required|invalid characters|特性名称|项目编号|项目文件夹/.test(
      message
    ) &&
    !/创建.*失败/.test(message)
  )
    return { status: 400, error: "invalid_request", message }
  return { status: 500, error: "internal_error", message }
}
