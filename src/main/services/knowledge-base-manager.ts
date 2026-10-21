import type {
  KnowledgeBaseListItem,
  KnowledgeBaseListResult,
  KnowledgeBaseState,
  KnowledgeBaseStateItem,
  KnowledgeBaseSyncResult,
  KnowledgeDepositionWorkspace,
  KnowledgeWorkspaceRole,
  KnowledgeWorkspaceState,
  KnowledgeWorkspaceSyncResult
} from "../../shared/knowledge-base-types"
import { resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { formatKnowledgeSyncError } from "./knowledge-sync-error"
import { formatGmt8Timestamp } from "../../shared/gmt8-time"
import { getLocalThreadRunLeases } from "../agent/thread-run-lease"
import { getThreadCore } from "../db"
import { getUserInfo } from "../storage"
import {
  KNOWLEDGE_WORKSPACE_ROLES,
  isValidKnowledgeDirectory,
  knowledgeDirectory,
  mergeCloudKnowledgeState,
  parseCloudKnowledgeItems,
  readKnowledgeState,
  writeKnowledgeState
} from "./knowledge-base-state"
import {
  KnowledgeRepositoryLocalChangesError,
  knowledgeWorkspaceHasChanges,
  syncKnowledgeRepository,
  validateKnowledgeRepositorySource
} from "./knowledge-repository"

const REFRESH_INTERVAL_MS = 90 * 60 * 1_000
const QUERY_PATH = "/devclaw/knowledge-config/query"
const QUERY_TIMEOUT_MS = 5_000

let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshing = false
let syncingId: string | null = null
let syncingRole: KnowledgeWorkspaceRole | null = null
let queryError: string | null = null
const previewRevisions = new Map<string, number>()

function pathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isKnowledgeDirectoryInUse(path: string): boolean {
  for (const lease of getLocalThreadRunLeases()) {
    const thread = getThreadCore(lease.threadId)
    if (!thread?.metadata) continue
    let metadata: unknown
    try {
      metadata = JSON.parse(thread.metadata)
    } catch {
      continue
    }
    if (
      isRecord(metadata) &&
      isRecord(metadata.harnessProjectSession) &&
      metadata.harnessProjectSession.kind === "system-constraints-update" &&
      typeof metadata.workspacePath === "string" &&
      pathKey(metadata.workspacePath) === pathKey(path)
    )
      return true
  }
  return false
}

export function isKnowledgeDirectorySyncing(path: string): boolean {
  return (
    syncingId !== null &&
    syncingRole === "write" &&
    pathKey(path) === pathKey(knowledgeDirectory(syncingId, "write"))
  )
}

export function isKnowledgeDepositionBlocked(
  metadata: Record<string, unknown>,
  workspacePath: unknown = metadata.workspacePath
): boolean {
  return (
    isRecord(metadata.harnessProjectSession) &&
    metadata.harnessProjectSession.kind === "system-constraints-update" &&
    typeof workspacePath === "string" &&
    isKnowledgeDirectorySyncing(workspacePath)
  )
}

function apiBaseUrl(): string {
  const value = (import.meta.env.VITE_ENTERPRISE_PROJECT_QUERY_URL as string | undefined)?.trim()
  if (!value) throw new Error("VITE_ENTERPRISE_PROJECT_QUERY_URL 未配置，无法查询知识库配置")
  return new URL(value).origin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function errorMessage(error: unknown, item?: KnowledgeBaseStateItem): string {
  let message =
    error instanceof AggregateError
      ? errorMessage(error.errors[0], item)
      : error instanceof Error
        ? error.message
        : String(error)
  for (const source of [item?.repoUrl, item?.sshUrl]) {
    if (source) message = message.split(source).join("<knowledge-repository>")
  }
  message = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1<credentials>@")
  return stripVTControlCharacters(message).slice(0, 4_096)
}

async function queryCloudKnowledgeBases(): Promise<ReturnType<typeof parseCloudKnowledgeItems>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS)
  try {
    let body: unknown
    if (import.meta.env.DEV) {
      body = {
        code: 200,
        data: {
          items: [
            {
              idKey: "test-agents-main",
              name: "测试知识库",
              description: "外网调试",
              repoUrl: "https://github.com/seikou00/testAgents.git",
              sshUrl: null,
              gitRef: "main"
            },
            {
              idKey: "hello-world-master",
              name: "Hello World 测试知识库",
              description: "外网多知识库调试",
              repoUrl: "https://github.com/octocat/Hello-World.git",
              sshUrl: null,
              gitRef: "master"
            }
          ]
        }
      }
    } else {
      const user = getUserInfo()
      const response = await fetch(`${apiBaseUrl()}${QUERY_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sapId: user?.sapId ?? "",
          pathName: user?.pathName ?? "",
          originPathId: user?.originPathId ?? ""
        }),
        signal: controller.signal
      })
      if (response.status !== 200) throw new Error(`知识库配置查询失败：HTTP ${response.status}`)
      body = (await response.json()) as unknown
    }
    if (!isRecord(body) || body.code !== 200 || !isRecord(body.data)) {
      const message =
        isRecord(body) && typeof body.message === "string" ? body.message : "响应格式无效"
      throw new Error(`知识库配置查询失败：${message}`)
    }
    const items = parseCloudKnowledgeItems(body.data.items)
    for (const item of items) {
      await validateKnowledgeRepositorySource(
        {
          idKey: item.idKey,
          role: "read",
          url: item.repoUrl,
          ref: item.gitRef,
          sshUrl: item.sshUrl ?? undefined
        },
        controller.signal
      )
    }
    return items
  } catch (error) {
    if (controller.signal.aborted)
      throw new DOMException("知识库配置查询超时（5 秒）", "TimeoutError")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function updateWorkspace(idKey: string, workspace: KnowledgeWorkspaceState): Promise<void> {
  const state = await readKnowledgeState()
  if (!state) return
  const item = state.knowledgeBases.find((entry) => entry.idKey === idKey)
  if (!item) return
  item.workspaces = item.workspaces.map((entry) =>
    entry.role === workspace.role ? workspace : entry
  )
  await writeKnowledgeState(state)
}

async function syncWorkspace(
  item: KnowledgeBaseStateItem,
  role: KnowledgeWorkspaceRole
): Promise<KnowledgeWorkspaceSyncResult> {
  const path = knowledgeDirectory(item.idKey, role)
  if (role === "write" && isKnowledgeDirectoryInUse(path)) {
    return { role, status: "paused", message: "沉淀会话运行中，暂停更新" }
  }
  syncingRole = role
  try {
    const result = await syncKnowledgeRepository({
      idKey: item.idKey,
      role,
      url: item.repoUrl,
      sshUrl: item.sshUrl ?? undefined,
      ref: item.gitRef
    })
    await updateWorkspace(item.idKey, { role, status: "success", lastError: null })
    return {
      role,
      status: result.updated ? "downloaded" : "up_to_date",
      message: result.updated ? "更新成功" : "已是最新"
    }
  } catch (error) {
    const blocked = error instanceof KnowledgeRepositoryLocalChangesError
    const message = blocked ? error.message : formatKnowledgeSyncError(error)
    if (!blocked) {
      console.warn(
        `[knowledge_manage] ${item.idKey}/${role} 同步失败：${errorMessage(error, item)}`
      )
    }
    await updateWorkspace(item.idKey, {
      role,
      status: blocked ? "blocked" : "failed",
      lastError: message
    })
    return { role, status: blocked ? "paused" : "failed", message }
  } finally {
    if (role === "read") {
      previewRevisions.set(item.idKey, (previewRevisions.get(item.idKey) ?? 0) + 1)
    }
    syncingRole = null
  }
}

async function syncStateItem(item: KnowledgeBaseStateItem): Promise<KnowledgeBaseSyncResult> {
  const workspaces: KnowledgeWorkspaceSyncResult[] = []
  for (const role of KNOWLEDGE_WORKSPACE_ROLES) workspaces.push(await syncWorkspace(item, role))
  const succeeded = workspaces.filter(
    (entry) => entry.status === "downloaded" || entry.status === "up_to_date"
  )
  if (succeeded.length === 2) {
    const state = await readKnowledgeState()
    const current = state?.knowledgeBases.find((entry) => entry.idKey === item.idKey)
    if (state && current) {
      current.lastSuccessfulSyncAt = formatGmt8Timestamp()
      await writeKnowledgeState(state)
    }
  }
  const allLatest = workspaces.every((entry) => entry.status === "up_to_date")
  const status =
    succeeded.length === 2
      ? allLatest
        ? "up_to_date"
        : "downloaded"
      : succeeded.length > 0
        ? "partial"
        : workspaces.some((entry) => entry.status === "failed")
          ? "failed"
          : "paused"
  const message =
    succeeded.length === 2
      ? allLatest
        ? "知识库已是最新"
        : "知识库更新成功"
      : workspaces.every(
            (entry) =>
              entry.status === workspaces[0].status && entry.message === workspaces[0].message
          )
        ? `读取内容、沉淀工作区${status === "failed" ? "更新失败" : "暂停更新"}：${workspaces[0].message}`
        : workspaces
            .map(
              (entry) =>
                `${entry.role === "read" ? "读取内容" : "沉淀工作区"}${entry.status === "failed" ? "更新失败：" : entry.status === "paused" ? "暂停更新：" : ""}${entry.message}`
            )
            .join("；")
  return { idKey: item.idKey, status, message, workspaces }
}

async function listFromState(state: KnowledgeBaseState | null): Promise<KnowledgeBaseListResult> {
  const knowledgeBases = await Promise.all(
    (state?.knowledgeBases ?? []).map(async (item): Promise<KnowledgeBaseListItem> => {
      const workspaces = await Promise.all(
        item.workspaces.map(async (entry) => ({
          ...entry,
          localPath: knowledgeDirectory(item.idKey, entry.role),
          localValid: await isValidKnowledgeDirectory(item.idKey, entry.role),
          inUse:
            entry.role === "write" &&
            isKnowledgeDirectoryInUse(knowledgeDirectory(item.idKey, entry.role)),
          syncing: syncingId === item.idKey && syncingRole === entry.role
        }))
      )
      const read = workspaces.find((entry) => entry.role === "read")!
      return {
        ...item,
        workspaces,
        previewRevision: previewRevisions.get(item.idKey) ?? 0,
        localPath: read.localPath,
        localValid: read.localValid
      }
    })
  )
  return {
    ready: state !== null,
    knowledgeBases,
    refreshing,
    syncingIds: syncingId ? [syncingId] : [],
    writeSyncingIds: syncingId && syncingRole === "write" ? [syncingId] : [],
    queryError
  }
}

export async function listKnowledgeBases(): Promise<KnowledgeBaseListResult> {
  return listFromState(await readKnowledgeState())
}

export async function refreshKnowledgeBases(): Promise<KnowledgeBaseListResult> {
  if (refreshing || syncingId) return listKnowledgeBases()
  refreshing = true
  try {
    let state = await readKnowledgeState()
    try {
      const items = await queryCloudKnowledgeBases()
      state = mergeCloudKnowledgeState(state, items)
      await writeKnowledgeState(state)
      queryError = null
    } catch (error) {
      queryError = errorMessage(error)
      console.warn(`[knowledge_manage] ${queryError}，保留本地配置`)
    }
    for (const item of state?.knowledgeBases ?? []) {
      if (item.visibility !== "visible") continue
      syncingId = item.idKey
      try {
        await syncStateItem(item)
      } finally {
        syncingId = null
      }
    }
  } finally {
    refreshing = false
  }
  return listKnowledgeBases()
}

export async function syncKnowledgeBase(idKey: string): Promise<KnowledgeBaseSyncResult> {
  const normalizedId = typeof idKey === "string" ? idKey.trim() : ""
  if (!normalizedId) throw new Error("知识库 idKey 不能为空")
  if (refreshing || syncingId) throw new Error("知识库同步正在进行，请稍后重试")
  syncingId = normalizedId
  try {
    const state = await readKnowledgeState()
    const item = state?.knowledgeBases.find((entry) => entry.idKey === normalizedId)
    if (!item) throw new Error("知识库配置不存在")
    if (item.visibility !== "visible") throw new Error("该知识库当前不可见，不能同步")
    return await syncStateItem(item)
  } finally {
    syncingId = null
  }
}

export async function resolveProjectKnowledgeBases(
  ids: readonly string[]
): Promise<Array<{ name: string; path: string }>> {
  const id = ids[0]?.trim()
  if (!id) return []
  const state = await readKnowledgeState()
  const item = state?.knowledgeBases.find((entry) => entry.idKey === id)
  if (
    item?.workspaces.find((entry) => entry.role === "read")?.status !== "success" ||
    !(await isValidKnowledgeDirectory(id, "read"))
  )
    return []
  return [{ name: item.name, path: knowledgeDirectory(id, "read") }]
}

export async function resolveKnowledgeDepositionPath(ids: readonly string[]): Promise<string> {
  const id = ids[0]?.trim()
  if (!id) throw new Error("请先在项目设置中配置知识库")
  const item = (await readKnowledgeState())?.knowledgeBases.find((entry) => entry.idKey === id)
  if (!item || !(await isValidKnowledgeDirectory(id, "write"))) {
    throw new Error("知识沉淀工作区不可用，请前往公共系统约束 Tab 下载或处理")
  }
  const path = knowledgeDirectory(id, "write")
  if (isKnowledgeDirectorySyncing(path)) throw new Error("知识库正在同步，请稍后再发起沉淀会话")
  return path
}

export async function prepareKnowledgeDeposition(
  ids: readonly string[]
): Promise<KnowledgeDepositionWorkspace> {
  const path = await resolveKnowledgeDepositionPath(ids)
  const dirty = await knowledgeWorkspaceHasChanges(path)
  return {
    path,
    ...(dirty ? { warning: "知识沉淀工作区存在未提交的变更，本次会话将继续使用该工作区" } : {})
  }
}

export async function assertSelectableKnowledgeBaseIds(
  ids: unknown,
  preservedIds: readonly string[] = []
): Promise<string[]> {
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.length > 1 || ids.some((id) => typeof id !== "string"))
    throw new Error("一期项目最多选择一个知识库")
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (normalized.length === 0 || normalized.every((id) => preservedIds.includes(id)))
    return normalized
  const selected = (await readKnowledgeState())?.knowledgeBases.find(
    (item) => item.idKey === normalized[0]
  )
  if (
    !selected ||
    selected.visibility !== "visible" ||
    selected.workspaces.find((entry) => entry.role === "read")?.status !== "success" ||
    !(await isValidKnowledgeDirectory(selected.idKey, "read"))
  ) {
    throw new Error("所选知识库当前不可用，请刷新知识库列表后重试")
  }
  return normalized
}

export function refreshKnowledgeBasesInBackground(): void {
  void refreshKnowledgeBases().catch((error) =>
    console.warn(`[knowledge_manage] 配置刷新失败：${errorMessage(error)}`)
  )
}

export function startKnowledgeBaseManager(): void {
  if (refreshTimer) return
  refreshKnowledgeBasesInBackground()
  refreshTimer = setInterval(refreshKnowledgeBasesInBackground, REFRESH_INTERVAL_MS)
  refreshTimer.unref?.()
}

export function stopKnowledgeBaseManager(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}
