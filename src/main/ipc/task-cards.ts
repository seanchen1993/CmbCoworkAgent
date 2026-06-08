import type { IpcMain } from "electron"
import { getUserInfo } from "../storage"
import type {
  TaskCardItem,
  TaskCardsListResult,
  TaskCardsQuery
} from "../../shared/task-card-types"
import { normalizeTaskCardsPayload } from "../../shared/task-card-types"

const DEFAULT_TASK_CARDS_ENDPOINT =
  "https://devops-kanban.paas.cmbchina.cn/api-market/api-market/v2/rest/tasks/by-assignee"
const TASK_CARDS_CACHE_TTL_MS = 90_000
const TASK_CARDS_TIMEOUT_MS = 15_000
const TASK_CARDS_CACHE_LIMIT = 8
const TASK_CARDS_MAX_PAGES = 10
const TASK_CARDS_TOTAL_TIMEOUT_MS = 45_000
const TASK_CARDS_ERROR_BODY_LOG_LIMIT = 800

const MOCK_TASK_CARDS: TaskCardItem[] = [
  {
    taskKey: "M10000749-9",
    taskName: "提交代码时自动获取当前用户任务卡片并支持快速选择",
    spaceKey: "CMB",
    taskTypeCode: "story",
    taskTypeName: "需求任务",
    taskGroupId: "384921",
    taskGroupKey: "REQ-202606",
    taskGroupName: "协同助手体验优化",
    taskGroupCategory: "项目需求",
    boardId: "kanban-frontend",
    boardName: "研发协同看板",
    boardType: "scrum",
    columnId: "doing",
    columnName: "开发中",
    columnFullName: "研发协同看板 / 迭代 2026.06 / 开发中",
    priority: "HIGH",
    startDate: "2026-06-01",
    dueDate: "2026-06-07",
    manDay: 2.5,
    progressRatio: 68,
    archived: false,
    updatedTime: "2026-06-04 09:38:12",
    relatedRequirementKey: "REQ-987654",
    relatedProjectNumber: "PRJ-2026-COWORK",
    projectBatchNumber: "202606A",
    tags: ["体验优化", "Git 提交"]
  },
  {
    taskKey: "Z990880",
    taskName: "修复提交说明为空时错误提示不聚焦的问题",
    spaceKey: "CMB",
    taskTypeCode: "bug",
    taskTypeName: "缺陷",
    taskGroupId: "384922",
    taskGroupKey: "BUG-202606",
    taskGroupName: "UAT 问题修复",
    taskGroupCategory: "缺陷处理",
    boardId: "kanban-frontend",
    boardName: "研发协同看板",
    boardType: "kanban",
    columnId: "testing",
    columnName: "联调中",
    columnFullName: "研发协同看板 / UAT 验证 / 联调中",
    priority: "MEDIUM",
    startDate: "2026-06-02",
    dueDate: "2026-06-05",
    manDay: 1,
    progressRatio: 35,
    archived: false,
    updatedTime: "2026-06-04 10:15:01",
    relatedFeatureKey: "FEAT-3350",
    tags: ["UAT", "提交流程"]
  },
  {
    taskKey: "M21AG691-24",
    taskName: "任务卡片下拉列表视觉验收：长标题、状态、优先级和截止日期完整展示",
    spaceKey: "CMB",
    taskTypeCode: "test",
    taskTypeName: "测试任务",
    taskGroupId: "384923",
    taskGroupKey: "QA-202606",
    taskGroupName: "自动提交能力验收",
    taskGroupCategory: "质量保障",
    boardId: "kanban-quality",
    boardName: "质量协作看板",
    boardType: "kanban",
    columnId: "review",
    columnName: "待验收",
    columnFullName: "质量协作看板 / 自动提交能力验收 / 待验收",
    priority: "LOW",
    startDate: "2026-06-03",
    dueDate: "2026-06-10",
    manDay: 0.5,
    progressRatio: 12,
    archived: false,
    updatedTime: "2026-06-04 11:02:43",
    relatedParentTaskKey: "M10000749-9",
    tags: ["视觉验收", "选择器"]
  },
  {
    taskKey: "CR1024001",
    taskName: "代码检视：任务卡接口 HTTPS、分页和缓存逻辑复核",
    spaceKey: "CMB",
    taskTypeCode: "codeReview",
    taskTypeName: "代码检视",
    taskGroupId: "384924",
    taskGroupKey: "CR-202606",
    taskGroupName: "提交链路代码检视",
    taskGroupCategory: "代码质量",
    boardId: "kanban-frontend",
    boardName: "研发协同看板",
    boardType: "scrum",
    columnId: "review",
    columnName: "评审中",
    columnFullName: "研发协同看板 / 迭代 2026.06 / 评审中",
    priority: "HIGH",
    startDate: "2026-06-04",
    dueDate: "2026-06-06",
    manDay: 0.75,
    progressRatio: 80,
    archived: false,
    updatedTime: "2026-06-04 13:20:19",
    codeReviewTaskRelatedTaskKey: "M10000749-9",
    tags: ["代码检视", "安全"]
  },
  {
    taskKey: "OPS882031",
    taskName: "补充任务卡接口异常兜底文案和重试入口",
    spaceKey: "CMB",
    taskTypeCode: "ops",
    taskTypeName: "运维支持",
    taskGroupId: "384925",
    taskGroupKey: "OPS-202606",
    taskGroupName: "生产可用性改进",
    taskGroupCategory: "运维需求",
    boardId: "kanban-ops",
    boardName: "运维协同看板",
    boardType: "kanban",
    columnId: "todo",
    columnName: "待处理",
    columnFullName: "运维协同看板 / 生产可用性改进 / 待处理",
    priority: "MEDIUM",
    startDate: "2026-06-04",
    dueDate: "2026-06-12",
    manDay: 1.5,
    progressRatio: 0,
    archived: false,
    updatedTime: "2026-06-04 14:06:58",
    concernTaskRelatedTaskKey: "Z990880",
    tags: ["异常处理", "可用性"]
  },
  {
    taskKey: "ARCH202505",
    taskName: "历史归档任务：旧版提交卡号输入框替换",
    spaceKey: "CMB",
    taskTypeCode: "story",
    taskTypeName: "需求任务",
    taskGroupId: "374001",
    taskGroupKey: "REQ-202505",
    taskGroupName: "历史提交能力改造",
    taskGroupCategory: "项目需求",
    taskGroupArchived: true,
    boardId: "kanban-history",
    boardName: "历史需求看板",
    boardType: "kanban",
    columnId: "done",
    columnName: "已完成",
    columnFullName: "历史需求看板 / 2025.05 / 已完成",
    priority: "LOW",
    startDate: "2025-05-11",
    dueDate: "2025-05-20",
    manDay: 1,
    progressRatio: 100,
    archived: true,
    updatedTime: "2025-05-20 18:22:10",
    relatedRequirementKey: "REQ-202505-018",
    tags: ["归档", "历史数据"]
  }
]

interface NormalizedTaskCardsQuery {
  includeArchived: boolean
  pageSize: number
  pageNum: number
  forceRefresh: boolean
}

interface TaskCardsCacheEntry {
  expiresAt: number
  result: TaskCardsListResult
}

const taskCardsCache = new Map<string, TaskCardsCacheEntry>()
let taskCardsRequestSequence = 0

function normalizeQuery(query?: TaskCardsQuery): NormalizedTaskCardsQuery {
  const pageSize =
    typeof query?.pageSize === "number" && Number.isFinite(query.pageSize)
      ? Math.min(1000, Math.max(1, Math.floor(query.pageSize)))
      : 1000
  const pageNum =
    typeof query?.pageNum === "number" && Number.isFinite(query.pageNum)
      ? Math.max(1, Math.floor(query.pageNum))
      : 1

  return {
    includeArchived: query?.includeArchived === true,
    pageSize,
    pageNum,
    forceRefresh: query?.forceRefresh === true
  }
}

function getTaskCardsEndpoint(): string {
  const viteEnv = (import.meta.env ?? {}) as Record<string, string | undefined>
  const configured = viteEnv.VITE_TASK_CARDS_ENDPOINT?.trim()
  return configured || process.env.CMB_TASK_CARDS_ENDPOINT || DEFAULT_TASK_CARDS_ENDPOINT
}

function isTaskCardsMockEnabled(): boolean {
  const viteEnv = (import.meta.env ?? {}) as Record<string, string | undefined>
  return viteEnv.VITE_TASK_CARDS_MOCK === "1" || process.env.CMB_TASK_CARDS_MOCK === "1"
}

function createHttpsTaskCardsUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (url.protocol !== "https:") {
    throw new Error("任务卡接口必须使用 HTTPS，已拒绝通过明文 HTTP 传输登录令牌")
  }
  return url
}

function nextTaskCardsRequestId(): string {
  taskCardsRequestSequence = (taskCardsRequestSequence + 1) % 100_000
  return `task-cards-${Date.now()}-${taskCardsRequestSequence}`
}

function getTaskCardsRequestHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer <redacted>",
    Accept: "application/json"
  }
}

function getTaskCardsResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

function truncateForLog(value: string): string {
  if (value.length <= TASK_CARDS_ERROR_BODY_LOG_LIMIT) return value
  return `${value.slice(0, TASK_CARDS_ERROR_BODY_LOG_LIMIT)}...<truncated>`
}

function buildCacheKey(query: NormalizedTaskCardsQuery, userKey: string, endpoint: string): string {
  return [
    endpoint,
    userKey,
    query.includeArchived ? "archived" : "active",
    query.pageSize,
    query.pageNum
  ].join("|")
}

function emptyResult(
  query: NormalizedTaskCardsQuery,
  error: string,
  options?: { loginRequired?: boolean }
): TaskCardsListResult {
  return {
    success: false,
    cards: [],
    total: 0,
    pageSize: query.pageSize,
    pageNum: query.pageNum,
    error,
    ...(options?.loginRequired ? { loginRequired: true } : {})
  }
}

function readCache(cacheKey: string): TaskCardsListResult | null {
  const entry = taskCardsCache.get(cacheKey)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    taskCardsCache.delete(cacheKey)
    return null
  }
  return {
    ...entry.result,
    fromCache: true
  }
}

function writeCache(cacheKey: string, result: TaskCardsListResult): void {
  if (taskCardsCache.has(cacheKey)) {
    taskCardsCache.delete(cacheKey)
  } else if (taskCardsCache.size >= TASK_CARDS_CACHE_LIMIT) {
    const oldestKey = taskCardsCache.keys().next().value
    if (oldestKey) taskCardsCache.delete(oldestKey)
  }

  taskCardsCache.set(cacheKey, {
    expiresAt: Date.now() + TASK_CARDS_CACHE_TTL_MS,
    result
  })
}

function createMockTaskCardsResult(query: NormalizedTaskCardsQuery): TaskCardsListResult {
  const visibleCards = query.includeArchived
    ? MOCK_TASK_CARDS
    : MOCK_TASK_CARDS.filter((card) => !card.archived && !card.taskGroupArchived)
  const startIndex = (query.pageNum - 1) * query.pageSize
  const list = visibleCards.slice(startIndex, startIndex + query.pageSize)

  return normalizeTaskCardsPayload(
    {
      returnCode: "SUC0000",
      errorMsg: "",
      body: {
        list,
        total: visibleCards.length,
        pageSize: query.pageSize,
        pageNum: query.pageNum
      }
    },
    {
      pageSize: query.pageSize,
      pageNum: query.pageNum
    }
  )
}

async function fetchTaskCardsPage(
  endpoint: string,
  accessToken: string,
  query: NormalizedTaskCardsQuery
): Promise<TaskCardsListResult> {
  const requestId = nextTaskCardsRequestId()
  const url = createHttpsTaskCardsUrl(endpoint)
  url.searchParams.set("pageSize", String(query.pageSize))
  url.searchParams.set("pageNum", String(query.pageNum))
  url.searchParams.set("includeArchived", query.includeArchived ? "true" : "false")

  const requestTaskCards = async (method: "GET" | "POST"): Promise<Response> => {
    const startedAt = Date.now()
    console.info("[TaskCards] request:start", {
      requestId,
      method,
      url: url.toString(),
      query: {
        pageSize: query.pageSize,
        pageNum: query.pageNum,
        includeArchived: query.includeArchived
      },
      headers: getTaskCardsRequestHeaders(),
      body: null
    })
    return fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    }).then((response) => {
      console.info("[TaskCards] request:response", {
        requestId,
        method,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
        headers: getTaskCardsResponseHeaders(response)
      })
      return response
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TASK_CARDS_TIMEOUT_MS)

  try {
    let response = await requestTaskCards("POST")
    let methodFallbackUsed = false
    if (response.status === 405) {
      methodFallbackUsed = true
      console.warn("[TaskCards] request:method-not-allowed-fallback", {
        requestId,
        fromMethod: "POST",
        toMethod: "GET",
        status: response.status,
        allow: response.headers.get("allow") || undefined
      })
      response = await requestTaskCards("GET")
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => "")
      console.warn("[TaskCards] request:failed", {
        requestId,
        status: response.status,
        statusText: response.statusText,
        methodFallbackUsed,
        headers: getTaskCardsResponseHeaders(response),
        bodyPreview: responseText ? truncateForLog(responseText) : ""
      })
      const methodHint =
        response.status === 405
          ? methodFallbackUsed
            ? "（POST/GET 均被当前网关拒绝，请确认接口路由允许的方法）"
            : "（当前网关不允许该请求方法）"
          : ""
      return emptyResult(query, `任务卡接口请求失败：HTTP ${response.status}${methodHint}`)
    }

    const payload = (await response.json()) as unknown
    const result = normalizeTaskCardsPayload(payload, {
      pageSize: query.pageSize,
      pageNum: query.pageNum
    })
    console.info("[TaskCards] request:parsed", {
      requestId,
      success: result.success,
      total: result.total,
      cards: result.cards.length,
      pageSize: result.pageSize,
      pageNum: result.pageNum,
      error: result.error
    })
    return result
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError"
    console.error("[TaskCards] request:error", {
      requestId,
      aborted,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    return emptyResult(
      query,
      error instanceof Error && !aborted
        ? error.message
        : aborted
          ? "任务卡接口请求超时"
          : "任务卡接口请求异常"
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchAllTaskCards(
  endpoint: string,
  accessToken: string,
  query: NormalizedTaskCardsQuery
): Promise<TaskCardsListResult> {
  const firstPage = await fetchTaskCardsPage(endpoint, accessToken, query)
  if (!firstPage.success) return firstPage

  const cards = [...firstPage.cards]
  const total = firstPage.total
  const pageSize = firstPage.pageSize || query.pageSize
  let pageNum = firstPage.pageNum || query.pageNum
  let lastPageCount = firstPage.cards.length
  const startedAt = Date.now()

  while (
    cards.length < total &&
    lastPageCount >= pageSize &&
    pageSize > 0 &&
    pageNum - query.pageNum + 1 < TASK_CARDS_MAX_PAGES
  ) {
    if (Date.now() - startedAt >= TASK_CARDS_TOTAL_TIMEOUT_MS) {
      return {
        ...firstPage,
        success: false,
        cards,
        total: Math.max(total, cards.length),
        pageNum: query.pageNum,
        error: "任务卡分页拉取超时，请稍后重试"
      }
    }

    pageNum += 1
    const nextPage = await fetchTaskCardsPage(endpoint, accessToken, {
      ...query,
      pageNum
    })
    if (!nextPage.success) return nextPage
    lastPageCount = nextPage.cards.length
    if (nextPage.cards.length === 0) break
    cards.push(...nextPage.cards)
  }

  return {
    ...firstPage,
    cards,
    total: Math.max(total, cards.length),
    pageNum: query.pageNum
  }
}

export async function listCurrentUserTaskCards(
  rawQuery?: TaskCardsQuery
): Promise<TaskCardsListResult> {
  const query = normalizeQuery(rawQuery)
  if (isTaskCardsMockEnabled()) {
    const cacheKey = buildCacheKey(query, "mock-user", "mock-task-cards")
    if (!query.forceRefresh) {
      const cached = readCache(cacheKey)
      if (cached) return cached
    }

    const result = createMockTaskCardsResult(query)
    if (result.success) {
      writeCache(cacheKey, result)
    }
    return result
  }

  const userInfo = getUserInfo()
  const accessToken = userInfo?.ystAccessToken?.trim()
  if (!accessToken) {
    return emptyResult(query, "未获取到登录凭据，请先登录后再选择任务卡片", {
      loginRequired: true
    })
  }

  const endpoint = getTaskCardsEndpoint()
  const userKey = userInfo?.ystId || userInfo?.sapId || "current-user"
  const cacheKey = buildCacheKey(query, userKey, endpoint)
  if (!query.forceRefresh) {
    const cached = readCache(cacheKey)
    if (cached) return cached
  }

  try {
    const result = await fetchAllTaskCards(endpoint, accessToken, query)

    if (result.success) {
      writeCache(cacheKey, result)
    }

    return result
  } catch (error) {
    return emptyResult(query, error instanceof Error ? error.message : "任务卡接口请求异常")
  }
}

export function registerTaskCardHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("taskCards:list", async (_event, query?: TaskCardsQuery) => {
    return listCurrentUserTaskCards(query)
  })
}
