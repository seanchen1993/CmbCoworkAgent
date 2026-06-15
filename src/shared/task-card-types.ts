export interface TaskCardsQuery {
  includeArchived?: boolean
  pageSize?: number
  pageNum?: number
  forceRefresh?: boolean
}

export interface TaskCardItem {
  taskKey: string
  taskName: string
  spaceKey?: string
  taskTypeCode?: string
  taskTypeName?: string
  taskGroupId?: string
  taskGroupKey?: string
  taskGroupName?: string
  taskGroupCategory?: string
  taskGroupArchived?: boolean
  boardId?: string
  boardName?: string
  boardType?: string
  columnId?: string
  columnName?: string
  columnFullName?: string
  priority?: string
  startDate?: string
  dueDate?: string
  manDay?: number
  progressRatio?: number
  archived?: boolean
  updatedTime?: string
  relatedFeatureKey?: string
  relatedProjectNumber?: string
  relatedRequirementKey?: string
  projectBatchNumber?: string
  relatedFeatureTaskKey?: string
  relatedParentTaskKey?: string
  codeReviewTaskRelatedTaskKey?: string
  concernTaskRelatedTaskKey?: string
  tags?: string[]
}

export interface TaskCardsListResult {
  success: boolean
  cards: TaskCardItem[]
  total: number
  pageSize: number
  pageNum: number
  error?: string
  loginRequired?: boolean
  fromCache?: boolean
}

const MIN_AUTO_MATCH_TASK_KEY_LENGTH = 6

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function preferredTextMatchesTaskKey(
  preferredText: string | undefined,
  taskKey: string
): boolean {
  const preferred = (preferredText || "").trim()
  const key = taskKey.trim()
  if (preferred.length === 0 || key.length < MIN_AUTO_MATCH_TASK_KEY_LENGTH) return false

  const pattern = new RegExp(`(^|[^a-zA-Z0-9])${escapeRegExp(key)}(?=$|[^a-zA-Z0-9])`, "i")
  return pattern.test(preferred)
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

function readBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  return typeof raw[key] === "boolean" ? raw[key] : undefined
}

function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
  const value = raw[key]
  if (!Array.isArray(value)) return undefined
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
  return items.length > 0 ? items : undefined
}

export function normalizeTaskCardItem(value: unknown): TaskCardItem | null {
  const raw = asRecord(value)
  if (!raw) return null

  const taskKey = readString(raw, "taskKey")
  if (!taskKey) return null

  return {
    taskKey,
    taskName: readString(raw, "taskName") || taskKey,
    ...(readString(raw, "spaceKey") ? { spaceKey: readString(raw, "spaceKey") } : {}),
    ...(readString(raw, "taskTypeCode") ? { taskTypeCode: readString(raw, "taskTypeCode") } : {}),
    ...(readString(raw, "taskTypeName") ? { taskTypeName: readString(raw, "taskTypeName") } : {}),
    ...(readString(raw, "taskGroupId") ? { taskGroupId: readString(raw, "taskGroupId") } : {}),
    ...(readString(raw, "taskGroupKey") ? { taskGroupKey: readString(raw, "taskGroupKey") } : {}),
    ...(readString(raw, "taskGroupName")
      ? { taskGroupName: readString(raw, "taskGroupName") }
      : {}),
    ...(readString(raw, "taskGroupCategory")
      ? { taskGroupCategory: readString(raw, "taskGroupCategory") }
      : {}),
    ...(readBoolean(raw, "taskGroupArchived") !== undefined
      ? { taskGroupArchived: readBoolean(raw, "taskGroupArchived") }
      : {}),
    ...(readString(raw, "boardId") ? { boardId: readString(raw, "boardId") } : {}),
    ...(readString(raw, "boardName") ? { boardName: readString(raw, "boardName") } : {}),
    ...(readString(raw, "boardType") ? { boardType: readString(raw, "boardType") } : {}),
    ...(readString(raw, "columnId") ? { columnId: readString(raw, "columnId") } : {}),
    ...(readString(raw, "columnName") ? { columnName: readString(raw, "columnName") } : {}),
    ...(readString(raw, "columnFullName")
      ? { columnFullName: readString(raw, "columnFullName") }
      : {}),
    ...(readString(raw, "priority") ? { priority: readString(raw, "priority") } : {}),
    ...(readString(raw, "startDate") ? { startDate: readString(raw, "startDate") } : {}),
    ...(readString(raw, "dueDate") ? { dueDate: readString(raw, "dueDate") } : {}),
    ...(readNumber(raw, "manDay") !== undefined ? { manDay: readNumber(raw, "manDay") } : {}),
    ...(readNumber(raw, "progressRatio") !== undefined
      ? { progressRatio: readNumber(raw, "progressRatio") }
      : {}),
    ...(readBoolean(raw, "archived") !== undefined
      ? { archived: readBoolean(raw, "archived") }
      : {}),
    ...(readString(raw, "updatedTime") ? { updatedTime: readString(raw, "updatedTime") } : {}),
    ...(readString(raw, "relatedFeatureKey")
      ? { relatedFeatureKey: readString(raw, "relatedFeatureKey") }
      : {}),
    ...(readString(raw, "relatedProjectNumber")
      ? { relatedProjectNumber: readString(raw, "relatedProjectNumber") }
      : {}),
    ...(readString(raw, "relatedRequirementKey")
      ? { relatedRequirementKey: readString(raw, "relatedRequirementKey") }
      : {}),
    ...(readString(raw, "projectBatchNumber")
      ? { projectBatchNumber: readString(raw, "projectBatchNumber") }
      : {}),
    ...(readString(raw, "relatedFeatureTaskKey")
      ? { relatedFeatureTaskKey: readString(raw, "relatedFeatureTaskKey") }
      : {}),
    ...(readString(raw, "relatedParentTaskKey")
      ? { relatedParentTaskKey: readString(raw, "relatedParentTaskKey") }
      : {}),
    ...(readString(raw, "codeReviewTaskRelatedTaskKey")
      ? { codeReviewTaskRelatedTaskKey: readString(raw, "codeReviewTaskRelatedTaskKey") }
      : {}),
    ...(readString(raw, "concernTaskRelatedTaskKey")
      ? { concernTaskRelatedTaskKey: readString(raw, "concernTaskRelatedTaskKey") }
      : {}),
    ...(readStringArray(raw, "tags") ? { tags: readStringArray(raw, "tags") } : {})
  }
}

export function normalizeTaskCardsPayload(
  payload: unknown,
  fallback: { pageSize: number; pageNum: number }
): TaskCardsListResult {
  const raw = asRecord(payload)
  if (!raw) {
    return {
      success: false,
      cards: [],
      total: 0,
      pageSize: fallback.pageSize,
      pageNum: fallback.pageNum,
      error: "任务卡接口响应格式异常"
    }
  }

  const returnCode = readString(raw, "returnCode")
  if (returnCode && returnCode !== "SUC0000") {
    return {
      success: false,
      cards: [],
      total: 0,
      pageSize: fallback.pageSize,
      pageNum: fallback.pageNum,
      error: readString(raw, "errorMsg") || `任务卡接口返回失败：${returnCode}`
    }
  }

  const body = asRecord(raw.body)
  if (!body) {
    return {
      success: false,
      cards: [],
      total: 0,
      pageSize: fallback.pageSize,
      pageNum: fallback.pageNum,
      error: "任务卡接口缺少 body"
    }
  }

  const list = Array.isArray(body.list) ? body.list : []
  const cards = list
    .map(normalizeTaskCardItem)
    .filter((item): item is TaskCardItem => Boolean(item))

  return {
    success: true,
    cards,
    total: readNumber(body, "total") ?? cards.length,
    pageSize: readNumber(body, "pageSize") ?? fallback.pageSize,
    pageNum: readNumber(body, "pageNum") ?? fallback.pageNum
  }
}
