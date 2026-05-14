import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { v4 as uuid } from "uuid"
import { getOpenworkDir } from "../storage"
import type {
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessFeatureSummary,
  HarnessSessionBinding,
  HarnessSessionBindingUpsertInput,
  HarnessSkillRegistryItem,
  HarnessStatus,
  HarnessWatchRef,
  HarnessWorkflow
} from "../../shared/harness-board-types"

interface HarnessProjectStoreFile {
  version: 1
  projects: HarnessProjectMetadata[]
}

interface HarnessSessionBindingStoreFile {
  version: 1
  bindings: HarnessSessionBinding[]
}

const HARNESS_BOARD_FILE = join(getOpenworkDir(), "harness-board-projects.json")
const HARNESS_SESSION_BINDINGS_FILE = join(getOpenworkDir(), "harness-board-session-bindings.json")

const DEFAULT_CACHE = {
  featureCount: null,
  activeFeatureCount: null,
  lastInspectedAt: null
}

export const HARNESS_SKILL_REGISTRY: HarnessSkillRegistryItem[] = [
  {
    id: "autobizdevops",
    name: "AutoBizDevOps",
    version: "1.1.0",
    description: "Biz / Dev / Ops 全流程研发技能",
    adapter: {
      command: "python",
      args: ["inspect_state.py"]
    },
    supportedSchemaVersions: ["skill.inspect.v1"]
  }
]

function emptyProjectStore(): HarnessProjectStoreFile {
  return {
    version: 1,
    projects: []
  }
}

function emptySessionBindingStore(): HarnessSessionBindingStoreFile {
  return {
    version: 1,
    bindings: []
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function normalizeProject(value: unknown): HarnessProjectMetadata | null {
  if (!isObject(value)) return null
  if (typeof value.projectId !== "string" || typeof value.name !== "string") return null
  const product = isObject(value.product) ? value.product : {}
  const workspace = isObject(value.workspace) ? value.workspace : {}
  const skill = isObject(value.skill) ? value.skill : HARNESS_SKILL_REGISTRY[0]
  const lifecycle = isObject(value.lifecycle) ? value.lifecycle : {}
  const adapter = isObject(skill.adapter) ? skill.adapter : HARNESS_SKILL_REGISTRY[0].adapter

  return {
    projectId: value.projectId,
    name: value.name,
    description: normalizeText(value.description),
    projectCode: normalizeText(value.projectCode),
    product: {
      code: normalizeText(product.code),
      name: normalizeText(product.name)
    },
    workspace: {
      path: normalizeText(workspace.path)
    },
    skill: {
      id: normalizeText(skill.id) || HARNESS_SKILL_REGISTRY[0].id,
      name: normalizeText(skill.name) || HARNESS_SKILL_REGISTRY[0].name,
      version: normalizeText(skill.version) || HARNESS_SKILL_REGISTRY[0].version,
      adapter: {
        command: normalizeText(adapter.command) || HARNESS_SKILL_REGISTRY[0].adapter.command,
        args: Array.isArray(adapter.args)
          ? adapter.args.filter((arg): arg is string => typeof arg === "string")
          : HARNESS_SKILL_REGISTRY[0].adapter.args
      }
    },
    owner: isObject(value.owner)
      ? {
          id: normalizeText(value.owner.id) || undefined,
          name: normalizeText(value.owner.name) || undefined
        }
      : undefined,
    lifecycle: {
      status: value.lifecycle && lifecycle.status === "archived" ? "archived" : "active",
      createdAt: normalizeText(lifecycle.createdAt) || new Date().toISOString(),
      updatedAt: normalizeText(lifecycle.updatedAt) || new Date().toISOString(),
      archivedAt: typeof lifecycle.archivedAt === "string" ? lifecycle.archivedAt : null
    },
    cachedRunSummary: isObject(value.cachedRunSummary)
      ? {
          featureCount:
            typeof value.cachedRunSummary.featureCount === "number"
              ? value.cachedRunSummary.featureCount
              : null,
          activeFeatureCount:
            typeof value.cachedRunSummary.activeFeatureCount === "number"
              ? value.cachedRunSummary.activeFeatureCount
              : null,
          lastInspectedAt:
            typeof value.cachedRunSummary.lastInspectedAt === "string"
              ? value.cachedRunSummary.lastInspectedAt
              : null
        }
      : DEFAULT_CACHE
  }
}

function normalizeSessionBinding(value: unknown): HarnessSessionBinding | null {
  if (!isObject(value)) return null
  if (
    typeof value.projectId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.slug !== "string"
  ) {
    return null
  }
  return {
    projectId: value.projectId,
    threadId: value.threadId,
    createdAt: normalizeText(value.createdAt),
    lastActiveAt: normalizeText(value.lastActiveAt),
    slug: value.slug
  }
}

function readProjectStore(): HarnessProjectStoreFile {
  getOpenworkDir()
  if (!existsSync(HARNESS_BOARD_FILE)) return emptyProjectStore()
  try {
    const parsed = JSON.parse(readFileSync(HARNESS_BOARD_FILE, "utf-8")) as unknown
    if (!isObject(parsed)) return emptyProjectStore()
    return {
      version: 1,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .map((item) => normalizeProject(item))
            .filter((item): item is HarnessProjectMetadata => item !== null)
        : []
    }
  } catch {
    return emptyProjectStore()
  }
}

function writeProjectStore(store: HarnessProjectStoreFile): void {
  getOpenworkDir()
  writeFileSync(HARNESS_BOARD_FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function readSessionBindingStore(): HarnessSessionBindingStoreFile {
  getOpenworkDir()
  if (!existsSync(HARNESS_SESSION_BINDINGS_FILE)) return emptySessionBindingStore()
  try {
    const parsed = JSON.parse(readFileSync(HARNESS_SESSION_BINDINGS_FILE, "utf-8")) as unknown
    if (!isObject(parsed)) return emptySessionBindingStore()
    return {
      version: 1,
      bindings: Array.isArray(parsed.bindings)
        ? parsed.bindings
            .map((item) => normalizeSessionBinding(item))
            .filter((item): item is HarnessSessionBinding => item !== null)
        : []
    }
  } catch {
    return emptySessionBindingStore()
  }
}

function writeSessionBindingStore(store: HarnessSessionBindingStoreFile): void {
  getOpenworkDir()
  writeFileSync(HARNESS_SESSION_BINDINGS_FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function toListItem(project: HarnessProjectMetadata): HarnessProjectListItem {
  return {
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    projectCode: project.projectCode,
    productCode: project.product.code,
    productName: project.product.name,
    workspacePath: project.workspace.path,
    skill: {
      id: project.skill.id,
      name: project.skill.name
    },
    lifecycle: {
      status: project.lifecycle.status,
      createdAt: project.lifecycle.createdAt,
      updatedAt: project.lifecycle.updatedAt
    },
    cachedRunSummary: project.cachedRunSummary ?? DEFAULT_CACHE
  }
}

function requireProject(projectId: string): HarnessProjectMetadata {
  const project = readProjectStore().projects.find((item) => item.projectId === projectId)
  if (!project) {
    throw new Error("Project not found")
  }
  return project
}

function sessionBindingKey(binding: Pick<HarnessSessionBinding, "projectId" | "slug" | "threadId">): string {
  return `${binding.projectId}:${binding.slug}:${binding.threadId}`
}

function sortSessionBindings(bindings: HarnessSessionBinding[]): HarnessSessionBinding[] {
  return [...bindings].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
}

function validateCreateInput(input: HarnessProjectCreateInput): void {
  const required = [
    input.skillId,
    input.name,
    input.projectCode,
    input.description,
    input.product?.code,
    input.product?.name,
    input.workspace?.path
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, product and workspace are required")
  }
}

function validateProjectMetadataInput(input: HarnessProjectMetadataUpdateInput): void {
  const required = [
    input.name,
    input.projectCode,
    input.description,
    input.product?.code,
    input.product?.name,
    input.workspace?.path
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, product and workspace are required")
  }
}

function okStatus(id: string, label: string): HarnessStatus {
  return { id, label, uiKind: "ok" }
}

function makeWatchRefs(projectId: string, slug?: string): HarnessWatchRef[] {
  const base = `.autobizdevops/projects/${projectId}`
  return slug
    ? [
        { path: `${base}/STATE.md`, purpose: "run-state" },
        { path: `${base}/features/${slug}`, purpose: "artifacts" },
        { path: `${base}/logs/hooks.ndjson`, purpose: "hook-log" }
      ]
    : [
        { path: `${base}/STATE.md`, purpose: "run-list" },
        { path: `${base}/logs/hooks.ndjson`, purpose: "hook-log" }
      ]
}

function mockRuns(now: string): HarnessFeatureSummary[] {
  return [
    {
      id: "comment-refresh",
      kind: "feature",
      slug: "comment-refresh",
      title: "评论列表刷新链路",
      location: "active",
      overallStatus: { id: "dev_in_progress", label: "Dev 进行中", uiKind: "active" },
      position: {
        currentNodeId: "dev.code",
        currentNodeLabel: "代码实现",
        progressIndex: 4,
        totalNodes: 6
      },
      summary: {
        text: "PRD 与执行计划已完成，正在实现列表刷新逻辑",
        updatedAt: now
      },
      sourceHealth: okStatus("ok", "状态正常")
    },
    {
      id: "permission-check",
      kind: "feature",
      slug: "permission-check",
      title: "评论权限校验",
      location: "active",
      overallStatus: { id: "biz_ready", label: "Biz 已确认", uiKind: "done" },
      position: {
        currentNodeId: "dev.plan",
        currentNodeLabel: "计划生成",
        progressIndex: 3,
        totalNodes: 6
      },
      summary: {
        text: "需求边界已确认，等待生成开发计划",
        updatedAt: now
      },
      sourceHealth: okStatus("ok", "状态正常")
    }
  ]
}

function mockWorkflow(): HarnessWorkflow {
  const states: HarnessStatus[] = [
    { id: "not_started", label: "未开始", uiKind: "pending" },
    { id: "in_progress", label: "进行中", uiKind: "active" },
    { id: "done", label: "已完成", uiKind: "done" }
  ]
  return {
    id: "autobizdevops.default",
    version: "1.0.0",
    kind: "graph",
    display: {
      mode: "ordered_nodes",
      groupBy: "group"
    },
    nodes: [
      {
        id: "biz.discuss",
        label: "需求澄清",
        group: "Biz",
        order: 10,
        description: "沉淀需求讨论稿",
        states,
        artifactDefinitions: [
          { id: "prd_discuss", label: "需求讨论稿", kind: "file", required: true }
        ],
        hookDefinitions: [
          { id: "biz-discuss-validate", label: "需求澄清产物校验", event: "PostSkillUse", required: true }
        ]
      },
      {
        id: "biz.prd",
        label: "PRD 定稿",
        group: "Biz",
        order: 20,
        description: "形成可开发需求",
        states
      },
      {
        id: "dev.plan",
        label: "计划生成",
        group: "Dev",
        order: 30,
        description: "生成执行计划",
        states
      },
      {
        id: "dev.code",
        label: "代码实现",
        group: "Dev",
        order: 40,
        description: "完成代码改造",
        states
      },
      {
        id: "dev.verify",
        label: "验证回归",
        group: "Dev",
        order: 50,
        description: "完成验证与风险检查",
        states
      },
      {
        id: "ops.release",
        label: "发布准备",
        group: "Ops",
        order: 60,
        description: "输出发布说明与检查项",
        states
      }
    ],
    transitions: [
      {
        id: "biz-discuss-to-prd",
        from: { nodeId: "biz.discuss", state: "done" },
        to: { nodeId: "biz.prd", state: "in_progress" }
      },
      {
        id: "prd-to-plan",
        from: { nodeId: "biz.prd", state: "done" },
        to: { nodeId: "dev.plan", state: "in_progress" }
      },
      {
        id: "plan-to-code",
        from: { nodeId: "dev.plan", state: "done" },
        to: { nodeId: "dev.code", state: "in_progress" }
      }
    ]
  }
}

function mockRunNodes(projectId: string, slug: string): HarnessRunNode[] {
  const artifactBase = `.autobizdevops/projects/${projectId}/features/${slug}`
  return [
    {
      id: "biz.discuss",
      label: "需求澄清",
      group: "Biz",
      order: 10,
      status: { id: "done", label: "已完成", uiKind: "done" },
      artifacts: [
        {
          id: "prd_discuss",
          label: "需求讨论稿",
          kind: "file",
          path: `${artifactBase}/DISCUSS.md`,
          required: true,
          status: okStatus("present", "已生成"),
          exists: true,
          nonEmpty: true,
          size: 3842,
          summary: "覆盖目标、非目标、关键交互和验收口径",
          validation: { status: "valid", message: "结构有效" }
        }
      ],
      hooks: [
        {
          hookId: "biz-discuss-validate",
          label: "需求澄清产物校验",
          event: "PostSkillUse",
          status: okStatus("passed", "通过"),
          decision: "pass",
          exitCode: 0,
          durationMs: 612,
          summary: "POST_SKILL_PASS skill=autobizdevops-biz-discuss"
        }
      ]
    },
    {
      id: "biz.prd",
      label: "PRD 定稿",
      group: "Biz",
      order: 20,
      status: { id: "done", label: "已完成", uiKind: "done" },
      artifacts: [
        {
          id: "prd",
          label: "PRD",
          kind: "file",
          path: `${artifactBase}/PRD.md`,
          required: true,
          status: okStatus("present", "已生成"),
          exists: true,
          nonEmpty: true,
          size: 6920,
          summary: "包含页面行为、接口依赖和权限边界"
        }
      ],
      hooks: [
        {
          hookId: "biz-prd-contract-check",
          label: "PRD 契约检查",
          event: "PostSkillUse",
          status: okStatus("passed", "通过"),
          decision: "pass",
          exitCode: 0,
          durationMs: 744,
          summary: "PRD 覆盖目标、范围、验收标准和接口依赖"
        }
      ]
    },
    {
      id: "dev.plan",
      label: "计划生成",
      group: "Dev",
      order: 30,
      status: { id: "done", label: "已完成", uiKind: "done" },
      artifacts: [
        {
          id: "plan",
          label: "执行计划",
          kind: "file",
          path: `${artifactBase}/PLAN.md`,
          required: true,
          status: okStatus("present", "已生成"),
          exists: true,
          nonEmpty: true,
          size: 5421,
          summary: "4 个任务，其中 2 个已完成，2 个进行中",
          validation: { status: "valid", message: "PLAN.md 结构有效" }
        }
      ],
      hooks: [
        {
          hookId: "autodev-plan-postcheck",
          label: "Plan 产物自检",
          event: "PostSkillUse",
          status: okStatus("passed", "通过"),
          decision: "pass",
          exitCode: 0,
          durationMs: 830,
          summary: "POST_SKILL_PASS skill=autodev-plan"
        }
      ]
    },
    {
      id: "dev.code",
      label: "代码实现",
      group: "Dev",
      order: 40,
      status: { id: "in_progress", label: "进行中", uiKind: "active", isCurrent: true },
      artifacts: [
        {
          id: "code_execution",
          label: "代码实现摘要",
          kind: "virtual",
          path: null,
          required: true,
          status: okStatus("present", "进行中"),
          summary: "已完成数据模型与 IPC 框架，前端详情面板正在接入"
        }
      ],
      hooks: [
        {
          hookId: "autodev-code-scope-check",
          label: "代码范围检查",
          event: "PostToolUse",
          status: okStatus("passed", "通过"),
          decision: "pass",
          exitCode: 0,
          durationMs: 486,
          summary: "变更文件集中在 harness board 模块，未触及无关目录"
        },
        {
          hookId: "autodev-code-compile-check",
          label: "编译预检查",
          event: "PostSkillUse",
          status: { id: "warning", label: "提示", uiKind: "warning" },
          decision: "warn",
          exitCode: 0,
          durationMs: 1290,
          summary: "Web typecheck 存在既有错误，当前阶段继续等待修复"
        }
      ]
    },
    {
      id: "dev.verify",
      label: "验证回归",
      group: "Dev",
      order: 50,
      status: { id: "not_started", label: "未开始", uiKind: "pending" },
      artifacts: [
        {
          id: "verification",
          label: "验证摘要",
          kind: "virtual",
          path: null,
          required: true,
          status: { id: "missing", label: "未生成", uiKind: "warning" },
          summary: "等待代码实现完成后生成"
        }
      ],
      hooks: [
        {
          hookId: "autodev-verify-report-check",
          label: "验证报告检查",
          event: "PostSkillUse",
          status: { id: "skipped", label: "跳过", uiKind: "skipped" },
          decision: "pass",
          exitCode: 0,
          durationMs: 0,
          summary: "验证阶段尚未开始，等待生成 VERIFY_REPORT.md"
        }
      ]
    },
    {
      id: "ops.release",
      label: "发布准备",
      group: "Ops",
      order: 60,
      status: { id: "not_started", label: "未开始", uiKind: "pending" },
      artifacts: [],
      hooks: [
        {
          hookId: "autoops-release-readiness",
          label: "发布就绪检查",
          event: "PreSkillUse",
          status: { id: "skipped", label: "跳过", uiKind: "skipped" },
          decision: "pass",
          exitCode: 0,
          durationMs: 0,
          summary: "发布准备阶段未开始，暂不检查发布清单"
        }
      ]
    }
  ]
}

export function listHarnessProjects(): HarnessProjectListItem[] {
  return readProjectStore().projects.map(toListItem)
}

export function createHarnessProject(input: HarnessProjectCreateInput): HarnessProjectMetadata {
  validateCreateInput(input)
  const store = readProjectStore()
  const now = new Date().toISOString()
  const skill = HARNESS_SKILL_REGISTRY.find((item) => item.id === input.skillId)
  if (!skill) {
    throw new Error("Selected skill is not supported")
  }
  const project: HarnessProjectMetadata = {
    projectId: uuid(),
    name: input.name.trim(),
    description: input.description.trim(),
    projectCode: input.projectCode.trim(),
    product: {
      code: input.product.code.trim(),
      name: input.product.name.trim()
    },
    workspace: {
      path: input.workspace.path.trim()
    },
    skill: {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      adapter: {
        command: skill.adapter.command,
        args: [...skill.adapter.args]
      }
    },
    lifecycle: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    },
    cachedRunSummary: DEFAULT_CACHE
  }

  store.projects.unshift(project)
  writeProjectStore(store)
  return project
}

export function updateHarnessProjectMetadata(
  projectId: string,
  input: HarnessProjectMetadataUpdateInput
): HarnessProjectMetadata {
  validateProjectMetadataInput(input)
  const store = readProjectStore()
  const index = store.projects.findIndex((item) => item.projectId === projectId)
  if (index === -1) {
    throw new Error("Project not found")
  }

  const existing = store.projects[index]
  const updated: HarnessProjectMetadata = {
    ...existing,
    name: input.name.trim(),
    description: input.description.trim(),
    projectCode: input.projectCode.trim(),
    product: {
      code: input.product.code.trim(),
      name: input.product.name.trim()
    },
    workspace: {
      path: input.workspace.path.trim()
    },
    lifecycle: {
      ...existing.lifecycle,
      updatedAt: new Date().toISOString()
    }
  }

  store.projects[index] = updated
  writeProjectStore(store)
  return updated
}

export function archiveHarnessProject(projectId: string): HarnessProjectMetadata {
  const store = readProjectStore()
  const index = store.projects.findIndex((item) => item.projectId === projectId)
  if (index === -1) {
    throw new Error("Project not found")
  }

  const now = new Date().toISOString()
  const existing = store.projects[index]
  const archived: HarnessProjectMetadata = {
    ...existing,
    lifecycle: {
      ...existing.lifecycle,
      status: "archived",
      updatedAt: now,
      archivedAt: existing.lifecycle.archivedAt ?? now
    }
  }

  store.projects[index] = archived
  writeProjectStore(store)
  return archived
}

export function upsertHarnessSessionBinding(input: HarnessSessionBindingUpsertInput): HarnessSessionBinding {
  const project = requireProject(input.projectId)
  const slug = input.slug.trim()
  const threadId = input.threadId.trim()
  if (!slug || !threadId) {
    throw new Error("Feature slug and thread id are required")
  }

  const store = readSessionBindingStore()
  const now = new Date().toISOString()
  const key = sessionBindingKey({ projectId: project.projectId, slug, threadId })
  const existing = store.bindings.find((item) => sessionBindingKey(item) === key)
  const binding: HarnessSessionBinding = {
    projectId: project.projectId,
    slug,
    threadId,
    createdAt: existing?.createdAt || now,
    lastActiveAt: now
  }

  const nextBindings = store.bindings.filter((item) => sessionBindingKey(item) !== key)
  nextBindings.push(binding)
  writeSessionBindingStore({ version: 1, bindings: sortSessionBindings(nextBindings) })
  return binding
}

export function getHarnessProjectDetail(projectId: string): HarnessProjectDetailViewModel {
  const project = requireProject(projectId)
  const sessionStore = readSessionBindingStore()
  const generatedAt = new Date().toISOString()
  const runs = mockRuns(generatedAt)
  const sessionsBySlug: Record<string, HarnessSessionBinding[]> = {}
  for (const binding of sessionStore.bindings.filter((item) => item.projectId === projectId)) {
    sessionsBySlug[binding.slug] = [...(sessionsBySlug[binding.slug] ?? []), binding]
  }

  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      projectCode: project.projectCode,
      productCode: project.product.code,
      productName: project.product.name,
      workspacePath: project.workspace.path
    },
    adapterSnapshot: {
      schemaVersion: "skill.inspect.v1",
      mode: "project",
      generatedAt,
      mock: true
    },
    projectState: okStatus("initialized", "已初始化"),
    runs,
    sessionsBySlug,
    watchRefs: makeWatchRefs(project.projectId),
    loading: false,
    error: null
  }
}

export function getHarnessRunDetail(projectId: string, slug: string): HarnessRunDetailViewModel {
  const project = requireProject(projectId)
  const sessionStore = readSessionBindingStore()
  const generatedAt = new Date().toISOString()
  const runSummary = mockRuns(generatedAt).find((item) => item.slug === slug) ?? mockRuns(generatedAt)[0]
  const sessions = sessionStore.bindings.filter(
    (item) => item.projectId === projectId && item.slug === runSummary.slug
  )
  const nodes = mockRunNodes(project.projectId, runSummary.slug)

  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      projectCode: project.projectCode,
      productCode: project.product.code,
      workspacePath: project.workspace.path
    },
    adapterSnapshot: {
      schemaVersion: "skill.inspect.v1",
      mode: "run",
      generatedAt,
      mock: true
    },
    workflow: mockWorkflow(),
    run: {
      id: runSummary.id,
      kind: runSummary.kind,
      slug: runSummary.slug,
      title: runSummary.title,
      location: runSummary.location,
      source: {
        label: project.skill.name,
        summary: runSummary.summary.text
      },
      sourceHealth: runSummary.sourceHealth,
      hookLogRefs: [
        {
          id: "default",
          path: `.autobizdevops/projects/${project.projectId}/logs/hooks.ndjson`,
          format: "ndjson"
        }
      ],
      watchRefs: makeWatchRefs(project.projectId, runSummary.slug),
      overallStatus: runSummary.overallStatus,
      position: {
        currentNodeId: runSummary.position.currentNodeId,
        currentNodeState: runSummary.position.currentNodeState ?? "in_progress",
        progressIndex: runSummary.position.progressIndex,
        totalNodes: runSummary.position.totalNodes
      },
      nodes,
      unmatchedHooks: [
        {
          hookId: "workspace-health",
          label: "工作区健康检查",
          event: "PostSkillUse",
          status: { id: "warning", label: "提示", uiKind: "warning" },
          summary: "Mock 数据：真实 hook log tail 将在 adapter 就绪后接入"
        }
      ]
    },
    sessions
  }
}
