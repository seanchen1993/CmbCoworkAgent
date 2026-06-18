import type { IpcMain } from "electron"
import { getUserInfo, upsertUserInfoConfig, type UserInfoConfig } from "../storage"
import type {
  TaskCardItem,
  TaskCardsListResult,
  TaskCardsQuery
} from "../../shared/task-card-types"
import { normalizeTaskCardsPayload } from "../../shared/task-card-types"

const DEFAULT_TASK_CARDS_ENDPOINT =
  "https://devops-kanban.paas.cmbchina.cn/api-market/v2/rest/tasks/by-assignee"
const TASK_CARDS_CACHE_TTL_MS = 90_000
const TASK_CARDS_TIMEOUT_MS = 15_000
const TASK_CARDS_CACHE_LIMIT = 8
const TASK_CARDS_MAX_PAGES = 10
const TASK_CARDS_TOTAL_TIMEOUT_MS = 45_000
const TASK_CARDS_ERROR_BODY_LOG_LIMIT = 800
const SENSITIVE_RESPONSE_HEADERS = new Set(["authorization", "proxy-authorization", "set-cookie"])

type TaskCardsHttpMethod = "GET" | "POST"

interface TaskCardsRequestResult extends TaskCardsListResult {
  httpStatus?: number
  requestMethod?: TaskCardsHttpMethod
  methodFallbackUsed?: boolean
}

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
// The desktop app has one signed-in user per process; share an in-flight refresh
// so parallel task-card loads do not stampede the login-info endpoint.
let taskCardsLoginRefreshPromise: Promise<UserInfoConfig | null> | null = null

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

function getLoginInfoEndpoint(): string {
  const viteEnv = (import.meta.env ?? {}) as Record<string, string | undefined>
  const configured = viteEnv.VITE_LOGIN_INFO_ENDPOINT?.trim() || process.env.CMB_LOGIN_INFO_ENDPOINT
  if (configured?.trim()) return configured.trim()

  const loginPt = viteEnv.VITE_LOGIN_PT?.trim() || process.env.VITE_LOGIN_PT?.trim()
  if (!loginPt) {
    throw new Error("未配置登录环境，无法刷新任务卡登录凭据")
  }
  return `https://archguardservice.paas.${loginPt}.cn/cowork/login-info`
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

function createHttpsLoginInfoUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (url.protocol !== "https:") {
    throw new Error("登录凭据刷新接口必须使用 HTTPS")
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
    headers[key] = SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase()) ? "<redacted>" : value
  })
  return headers
}

function truncateForLog(value: string): string {
  if (value.length <= TASK_CARDS_ERROR_BODY_LOG_LIMIT) return value
  return `${value.slice(0, TASK_CARDS_ERROR_BODY_LOG_LIMIT)}...<truncated>`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
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
  options?: {
    loginRequired?: boolean
    httpStatus?: number
    requestMethod?: TaskCardsHttpMethod
    methodFallbackUsed?: boolean
  }
): TaskCardsRequestResult {
  return {
    success: false,
    cards: [],
    total: 0,
    pageSize: query.pageSize,
    pageNum: query.pageNum,
    error,
    ...(options?.loginRequired ? { loginRequired: true } : {}),
    ...(options?.httpStatus !== undefined ? { httpStatus: options.httpStatus } : {}),
    ...(options?.requestMethod !== undefined ? { requestMethod: options.requestMethod } : {}),
    ...(options?.methodFallbackUsed !== undefined
      ? { methodFallbackUsed: options.methodFallbackUsed }
      : {})
  }
}

function stripRequestMetadata(result: TaskCardsRequestResult): TaskCardsListResult {
  const {
    httpStatus: _httpStatus,
    requestMethod: _requestMethod,
    methodFallbackUsed: _methodFallbackUsed,
    ...publicResult
  } = result
  return publicResult
}

function isUnauthorizedResult(result: TaskCardsRequestResult): boolean {
  return result.httpStatus === 401
}

function shouldRetryUnauthorizedWithGet(result: TaskCardsRequestResult): boolean {
  return (
    isUnauthorizedResult(result) && result.requestMethod === "POST" && !result.methodFallbackUsed
  )
}

function loginExpiredResult(query: NormalizedTaskCardsQuery): TaskCardsRequestResult {
  return emptyResult(query, "登录凭据已过期，请重新登录后再选择任务卡片", {
    loginRequired: true
  })
}

function getTaskCardsUserKey(userInfo: UserInfoConfig): string {
  return userInfo.ystId || userInfo.sapId || "current-user"
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

function mergeRefreshedUserInfo(
  current: UserInfoConfig,
  body: Record<string, unknown>
): UserInfoConfig {
  const nextAccessToken = readString(body, "ystAccessToken")
  if (!nextAccessToken) {
    throw new Error("登录凭据刷新响应缺少 ystAccessToken")
  }

  return {
    ...current,
    sapId: readString(body, "sapId") || current.sapId,
    ystId: readString(body, "ystId") || current.ystId,
    userName: readString(body, "userName") || current.userName,
    originOrgId: readString(body, "originOrgId") || current.originOrgId,
    orgName: readString(body, "orgName") || current.orgName,
    pathName: readString(body, "pathName") || current.pathName,
    originPathId: readString(body, "originPathId") || current.originPathId,
    ystRefreshToken: readString(body, "ystRefreshToken") || current.ystRefreshToken,
    ystIdToken: readString(body, "ystIdToken") || current.ystIdToken,
    ystCode: readString(body, "ystCode") || current.ystCode,
    ystAccessToken: nextAccessToken
  }
}

async function requestTaskCardsLoginRefresh(
  userInfo: UserInfoConfig
): Promise<UserInfoConfig | null> {
  const refreshToken = userInfo.ystRefreshToken?.trim()
  const ystCode = userInfo.ystCode?.trim()
  if (!refreshToken && !ystCode) {
    console.warn("[TaskCards] token-refresh:missing-refresh-token")
    return null
  }

  const requestId = nextTaskCardsRequestId()
  const url = createHttpsLoginInfoUrl(getLoginInfoEndpoint())
  const headers: Record<string, string> = {}
  if (refreshToken) headers.ystRefreshToken = refreshToken
  if (ystCode) headers.ystCode = ystCode

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TASK_CARDS_TIMEOUT_MS)

  try {
    const startedAt = Date.now()
    console.info("[TaskCards] token-refresh:start", {
      requestId,
      url: url.toString(),
      headers: {
        ystRefreshToken: refreshToken ? "<redacted>" : undefined,
        ystCode: ystCode ? "<redacted>" : undefined
      }
    })

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    })
    console.info("[TaskCards] token-refresh:response", {
      requestId,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - startedAt,
      headers: getTaskCardsResponseHeaders(response)
    })

    if (!response.ok) {
      const responseText = await response.text().catch(() => "")
      console.warn("[TaskCards] token-refresh:failed", {
        requestId,
        status: response.status,
        statusText: response.statusText,
        bodyPreview: responseText ? truncateForLog(responseText) : ""
      })
      return null
    }

    const payload = asRecord(await response.json())
    if (!payload) {
      throw new Error("登录凭据刷新响应格式异常")
    }

    const returnCode = readString(payload, "returnCode")
    if (returnCode !== "SUC0000") {
      console.warn("[TaskCards] token-refresh:business-failed", {
        requestId,
        returnCode,
        error: readString(payload, "errorMsg")
      })
      return null
    }

    const body = asRecord(payload.body)
    if (!body) {
      throw new Error("登录凭据刷新响应缺少 body")
    }

    const nextUserInfo = mergeRefreshedUserInfo(userInfo, body)
    upsertUserInfoConfig(nextUserInfo)
    return nextUserInfo
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError"
    console.warn("[TaskCards] token-refresh:error", {
      requestId,
      aborted,
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function refreshTaskCardsLogin(userInfo: UserInfoConfig): Promise<UserInfoConfig | null> {
  if (!taskCardsLoginRefreshPromise) {
    taskCardsLoginRefreshPromise = requestTaskCardsLoginRefresh(userInfo).finally(() => {
      taskCardsLoginRefreshPromise = null
    })
  }
  return taskCardsLoginRefreshPromise
}

async function fetchTaskCardsPage(
  endpoint: string,
  accessToken: string,
  query: NormalizedTaskCardsQuery,
  options?: { preferredMethod?: TaskCardsHttpMethod }
): Promise<TaskCardsRequestResult> {
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
    const preferredMethod = options?.preferredMethod || "POST"
    let responseMethod: TaskCardsHttpMethod = preferredMethod
    let response = await requestTaskCards(preferredMethod)
    let methodFallbackUsed = false
    if (preferredMethod === "POST" && response.status === 405) {
      methodFallbackUsed = true
      responseMethod = "GET"
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
      return emptyResult(query, `任务卡接口请求失败：HTTP ${response.status}${methodHint}`, {
        httpStatus: response.status,
        loginRequired: response.status === 401,
        requestMethod: responseMethod,
        methodFallbackUsed
      })
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
  query: NormalizedTaskCardsQuery,
  options?: { preferredMethod?: TaskCardsHttpMethod }
): Promise<TaskCardsRequestResult> {
  const firstPage = await fetchTaskCardsPage(endpoint, accessToken, query, options)
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
    const nextPage = await fetchTaskCardsPage(
      endpoint,
      accessToken,
      {
        ...query,
        pageNum
      },
      options
    )
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
  if (!userInfo || !accessToken) {
    return emptyResult(query, "未获取到登录凭据，请先登录后再选择任务卡片", {
      loginRequired: true
    })
  }

  const endpoint = getTaskCardsEndpoint()
  let cacheUserKey = getTaskCardsUserKey(userInfo)
  let cacheKey = buildCacheKey(query, cacheUserKey, endpoint)
  if (!query.forceRefresh) {
    const cached = readCache(cacheKey)
    if (cached) return cached
  }

  try {
    let result = await fetchAllTaskCards(endpoint, accessToken, query)
    if (isUnauthorizedResult(result)) {
      taskCardsCache.clear()
      console.warn("[TaskCards] request:unauthorized-refresh-token", {
        endpoint,
        userKey: cacheUserKey
      })

      const refreshedUserInfo = await refreshTaskCardsLogin(userInfo)
      const refreshedAccessToken = refreshedUserInfo?.ystAccessToken?.trim()
      if (!refreshedUserInfo || !refreshedAccessToken) {
        return loginExpiredResult(query)
      }

      cacheUserKey = getTaskCardsUserKey(refreshedUserInfo)
      cacheKey = buildCacheKey(query, cacheUserKey, endpoint)
      result = await fetchAllTaskCards(endpoint, refreshedAccessToken, query)
      if (shouldRetryUnauthorizedWithGet(result)) {
        console.warn("[TaskCards] request:unauthorized-get-fallback", {
          endpoint,
          userKey: cacheUserKey
        })
        result = await fetchAllTaskCards(endpoint, refreshedAccessToken, query, {
          preferredMethod: "GET"
        })
      }
      if (isUnauthorizedResult(result)) {
        return loginExpiredResult(query)
      }
    }

    const publicResult = stripRequestMetadata(result)
    if (result.success) {
      writeCache(cacheKey, publicResult)
    }

    return publicResult
  } catch (error) {
    return emptyResult(query, error instanceof Error ? error.message : "任务卡接口请求异常")
  }
}

export function registerTaskCardHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("taskCards:list", async (_event, query?: TaskCardsQuery) => {
    return listCurrentUserTaskCards(query)
  })
}
