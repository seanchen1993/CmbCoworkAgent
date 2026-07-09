import { getUserInfo } from "../storage"
import { deriveUpperOrgLv1FromPath } from "../org-levels"
import type {
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchItem,
  HarnessEnterpriseProjectSearchResult,
  HarnessProjectReviewInput,
  HarnessProjectReviewItem,
  HarnessProjectReviewResult
} from "../../shared/harness-board-types"
import { getHarnessLeanTokenConfig } from "./service"

const ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE = 15
const ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS = 10000
const ENTERPRISE_PROJECT_SUCCESS_CODE = "SUC0000"
const LEANSTAR_REVIEW_REQUEST_TIMEOUT_MS = 30000
const LEANSTAR_REVIEW_GATEWAY_URL = "http://leanstar-ai-gateway.paasuat.cmbchina.cn"

interface EnterpriseProjectQueryResponse {
  returnCode?: string
  errorMsg?: string | null
  body?:
    | {
        pageNum?: number
        pageSize?: number
        pages?: number
        total?: number
        data?: unknown[]
      }
    | unknown[]
}

interface LeanstarReviewSummaryResponse {
  reviewSummaries?: unknown[]
}

interface LeanstarReviewTypeResponse {
  data?: unknown[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim()
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function getThreeMonthsAgoDate(): string {
  const date = new Date()
  date.setMonth(date.getMonth() - 3)
  return formatDate(date)
}

function getEnterpriseProjectQueryUrl(): string {
  return (import.meta.env.VITE_ENTERPRISE_PROJECT_QUERY_URL as string | undefined)?.trim() || ""
}

function getEnterpriseProjectListUrl(): string {
  return (import.meta.env.VITE_ENTERPRISE_PROJECT_LIST as string | undefined)?.trim() || ""
}

function logHarnessHttpRequest(configKey: string, method: string, url: string, detail?: string): void {
  console.log(`[HarnessBoard] [${configKey}] Running${detail ? ` (${detail})` : ""}: ${method} ${url}`)
}

function isEnterpriseProjectQueryMockEnabled(): boolean {
  const value = (import.meta.env.VITE_ENTERPRISE_PROJECT_QUERY_MOCK as string | undefined)
    ?.trim()
    .toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function isProjectReviewEmptyMockEnabled(): boolean {
  const value = (import.meta.env.VITE_ENTERPRISE_PROJECT_REVIEW_MOCK_EMPTY as string | undefined)
    ?.trim()
    .toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function splitMainProduct(mainProduct: string): Pick<
  HarnessEnterpriseProjectSearchItem,
  "systemId" | "systemName"
> {
  if (mainProduct.length < 7) {
    return { systemId: "", systemName: "" }
  }
  return {
    systemId: mainProduct.slice(0, 7),
    systemName: mainProduct.slice(7).trim()
  }
}

function normalizeEnterpriseProjectItem(value: unknown): HarnessEnterpriseProjectSearchItem | null {
  if (!isObject(value)) return null

  const projectCode = normalizeText(value.prjCode)
  const projectName = normalizeText(value.prjName)
  if (!projectCode && !projectName) return null

  const mainProduct = normalizeText(value.mainProduct)
  return {
    projectCode,
    projectName,
    pm: normalizeText(value.pm),
    ...splitMainProduct(mainProduct)
  }
}

function normalizeEnterpriseProjectDetailItem(value: unknown): HarnessEnterpriseProjectDetailItem | null {
  const base = normalizeEnterpriseProjectItem(value)
  if (!base) return null
  if (!isObject(value)) return null

  return {
    ...base,
    status: normalizeText(value.status),
    phaseStatus: normalizeText(value.phaseStatus),
    baselineEndDate: normalizeText(value.baselineEndDate)
  }
}

function buildLeanstarReviewTypeMap(reviewTypes: unknown[]): Map<string, string> {
  const typeMap = new Map<string, string>()

  const traverse = (types: unknown[], parentDesc = ""): void => {
    for (const item of types) {
      if (!isObject(item)) continue
      const typeCode = normalizeText(item.type)
      const description = normalizeText(item.description)
      const subTypes = Array.isArray(item.subTypes) ? item.subTypes : []
      if (typeCode) {
        typeMap.set(typeCode, parentDesc ? `${parentDesc} - ${description}` : description)
      }
      if (subTypes.length > 0) {
        traverse(subTypes, description)
      }
    }
  }

  traverse(reviewTypes)
  return typeMap
}

function normalizeLeanstarReviewItem(
  value: unknown,
  typeMap: Map<string, string>
): HarnessProjectReviewItem | null {
  if (!isObject(value)) return null

  const title = normalizeText(value.title)
  const typeCode = normalizeText(value.type)
  const creator = normalizeText(value.creator)
  const creatorName = normalizeText(value.creatorName)
  const reviewMembers = Array.isArray(value.reviewMembers) ? value.reviewMembers : []
  const memberNames = reviewMembers
    .map((member) => isObject(member) ? normalizeText(member.name) : "")
    .filter(Boolean)

  return {
    title,
    type: typeMap.get(typeCode) || "其他",
    start_time: normalizeText(value.startTime),
    end_time: normalizeText(value.endTime),
    creator: `${creator} (${creatorName})`,
    members: memberNames.join(", ")
  }
}

function normalizeSearchResponse(
  response: EnterpriseProjectQueryResponse
): HarnessEnterpriseProjectSearchResult {
  if (response.returnCode !== ENTERPRISE_PROJECT_SUCCESS_CODE) {
    throw new Error(response.errorMsg || "找不到项目")
  }

  const body = isObject(response.body) ? response.body : undefined
  const rawData = Array.isArray(body?.data) ? body.data : []
  const projects = rawData
    .map((item) => normalizeEnterpriseProjectItem(item))
    .filter((item): item is HarnessEnterpriseProjectSearchItem => item !== null)
  const total = numberValue(body?.total)
  const pageNum = numberValue(body?.pageNum) || 1
  const pages = numberValue(body?.pages)

  return {
    projects,
    total,
    hasMore: total > projects.length || pages > pageNum
  }
}

function normalizeDetailResponse(
  response: EnterpriseProjectQueryResponse
): HarnessEnterpriseProjectDetailResult {
  if (response.returnCode !== ENTERPRISE_PROJECT_SUCCESS_CODE) {
    throw new Error(response.errorMsg || "找不到项目")
  }

  const rawData = Array.isArray(response.body) ? response.body : []
  const projects = rawData
    .map((item) => normalizeEnterpriseProjectDetailItem(item))
    .filter((item): item is HarnessEnterpriseProjectDetailItem => item !== null)

  return { projects }
}

function makeMockEnterpriseProjectSearchResult(): HarnessEnterpriseProjectSearchResult {
  return {
    total: 3,
    hasMore: false,
    projects: [
      {
        projectCode: "T26GIW81",
        projectName: "企业客户经营平台优化",
        pm: "张明",
        systemId: "LF39.18",
        systemName: "（C）WE运营管理平台"
      },
      {
        projectCode: "T26HXK02",
        projectName: "企业项目协同流程改造",
        pm: "李娜",
        systemId: "AB12.34",
        systemName: "（A）项目协同管理系统"
      },
      {
        projectCode: "T26KQ730",
        projectName: "企业服务中台能力建设",
        pm: "王磊",
        systemId: "CD56.78",
        systemName: "（B）企业服务中台"
      }
    ]
  }
}

function makeMockEnterpriseProjectDetailResult(
  prjCodeList: string[]
): HarnessEnterpriseProjectDetailResult {
  const details: HarnessEnterpriseProjectDetailItem[] = [
    {
      projectCode: "T26GIW81",
      projectName: "企业客户经营平台优化",
      pm: "张明",
      systemId: "LF39.18",
      systemName: "（C）WE运营管理平台",
      status: "任务_实施中",
      phaseStatus: "开发中",
      baselineEndDate: "2026-07-17"
    },
    {
      projectCode: "T26HXK02",
      projectName: "企业项目协同流程改造",
      pm: "李娜",
      systemId: "AB12.34",
      systemName: "（A）项目协同管理系统",
      status: "任务_实施中",
      phaseStatus: "联调中",
      baselineEndDate: "2026-08-05"
    }
  ]
  const requestedCodes = new Set(prjCodeList)
  return {
    projects: details.filter((project) => requestedCodes.has(project.projectCode))
  }
}

function makeMockProjectReviewResult(projectCode: string): HarnessProjectReviewResult {
  if (!projectCode) {
    return { tokenConfigured: true, reviews: [] }
  }

  return {
    tokenConfigured: true,
    reviews: [
      {
        title: `${projectCode} 需求方案评审`,
        type: "需求评审 - 方案评审",
        start_time: "2026-07-06 09:30:00",
        end_time: "2026-07-06 10:30:00",
        creator: "zhangming (张明)",
        members: "李娜, 王磊, 陈晨"
      },
      {
        title: `${projectCode} 技术设计评审`,
        type: "技术评审 - 详细设计评审",
        start_time: "2026-07-07 14:00:00",
        end_time: "2026-07-07 15:30:00",
        creator: "lina (李娜)",
        members: "张明, 王磊"
      },
      {
        title: `${projectCode} 投产准备评审`,
        type: "上线评审 - 投产准备评审",
        start_time: "2026-07-08 16:00:00",
        end_time: "2026-07-08 17:00:00",
        creator: "wanglei (王磊)",
        members: "张明, 李娜, 陈晨"
      },
      {
        title: `${projectCode} 安全合规评审`,
        type: "安全评审 - 合规检查",
        start_time: "2026-07-09 10:00:00",
        end_time: "2026-07-09 11:00:00",
        creator: "chenchen (陈晨)",
        members: "张明, 李娜"
      }
    ]
  }
}

export async function searchEnterpriseProjects(
  input: HarnessEnterpriseProjectSearchInput
): Promise<HarnessEnterpriseProjectSearchResult> {
  const keyword = normalizeText(input.keyword)
  const keywordField = input.field === "code" ? "prjCode" : "prjName"
  if (!keyword) {
    return { projects: [], total: 0, hasMore: false }
  }

  if (isEnterpriseProjectQueryMockEnabled()) {
    return makeMockEnterpriseProjectSearchResult()
  }

  const userInfo = getUserInfo()
  const roomName = deriveUpperOrgLv1FromPath(userInfo?.pathName)

  const queryUrl = getEnterpriseProjectQueryUrl()
  if (!queryUrl) {
    throw new Error("未配置项目查询地址")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)

  try {
    logHarnessHttpRequest(
      "enterprise_project_search",
      "POST",
      queryUrl,
      `${keywordField}=${keyword}, pageNum=1, pageSize=${ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE}`
    )
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        createDate: getThreeMonthsAgoDate(),
        [keywordField]: keyword,
        ...(roomName ? { roomName } : {}),
        pageNum: 1,
        pageSize: ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`项目查询失败`)
    }

    const json = (await response.json()) as EnterpriseProjectQueryResponse
    return normalizeSearchResponse(json)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("项目查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function getEnterpriseProjectDetails(
  input: HarnessEnterpriseProjectDetailInput
): Promise<HarnessEnterpriseProjectDetailResult> {
  const prjCodeList = Array.from(
    new Set(input.prjCodeList.map((code) => normalizeText(code)).filter(Boolean))
  )
  if (prjCodeList.length === 0) {
    return { projects: [] }
  }

  if (isEnterpriseProjectQueryMockEnabled()) {
    return makeMockEnterpriseProjectDetailResult(prjCodeList)
  }

  const queryUrl = getEnterpriseProjectListUrl()
  if (!queryUrl) {
    throw new Error("未配置项目详情查询地址")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)

  try {
    logHarnessHttpRequest(
      "enterprise_project_detail",
      "POST",
      queryUrl,
      `prjCodeList=${prjCodeList.join(",")}`
    )
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ prjCodeList }),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error("项目查询失败")
    }

    const json = (await response.json()) as EnterpriseProjectQueryResponse
    return normalizeDetailResponse(json)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("项目查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function getProjectReviews(
  input: HarnessProjectReviewInput
): Promise<HarnessProjectReviewResult> {
  const projectCode = normalizeText(input.projectCode)
  if (!projectCode) {
    return { tokenConfigured: true, reviews: [] }
  }

  if (isEnterpriseProjectQueryMockEnabled()) {
    if (isProjectReviewEmptyMockEnabled()) {
      return { tokenConfigured: true, reviews: [] }
    }
    return makeMockProjectReviewResult(projectCode)
  }

  const token = getHarnessLeanTokenConfig().leanToken.trim()
  if (!token) {
    return { tokenConfigured: false, reviews: [] }
  }

  const headers = {
    "Ls-Access-Token": token,
    "Content-Type": "application/json"
  }
  const summaryUrl = `${LEANSTAR_REVIEW_GATEWAY_URL}/api/review/summary/${encodeURIComponent(projectCode)}`
  const reviewTypesUrl = `${LEANSTAR_REVIEW_GATEWAY_URL}/api/review/review-types`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LEANSTAR_REVIEW_REQUEST_TIMEOUT_MS)

  try {
    const summarySearchParams = new URLSearchParams({ size: "999", page: "0" })
    logHarnessHttpRequest(
      "review_summary",
      "GET",
      `${summaryUrl}?${summarySearchParams.toString()}`,
      `projectCode=${projectCode}`
    )
    const summaryResponse = await fetch(`${summaryUrl}?${summarySearchParams.toString()}`, {
      method: "GET",
      headers,
      signal: controller.signal
    })
    if (summaryResponse.status === 401) {
      throw new Error("精益平台 token 认证失败")
    }
    if (!summaryResponse.ok) {
      throw new Error("项目评审查询失败")
    }

    logHarnessHttpRequest("review_types", "GET", reviewTypesUrl)
    const reviewTypesResponse = await fetch(reviewTypesUrl, {
      method: "GET",
      headers,
      signal: controller.signal
    })
    if (reviewTypesResponse.status === 401) {
      throw new Error("精益平台 token 认证失败")
    }
    if (!reviewTypesResponse.ok) {
      throw new Error("评审类型查询失败")
    }

    const summaryJson = (await summaryResponse.json()) as LeanstarReviewSummaryResponse
    const reviewTypesJson = (await reviewTypesResponse.json()) as LeanstarReviewTypeResponse
    const typeMap = buildLeanstarReviewTypeMap(
      Array.isArray(reviewTypesJson.data) ? reviewTypesJson.data : []
    )
    const reviews = (Array.isArray(summaryJson.reviewSummaries) ? summaryJson.reviewSummaries : [])
      .map((review) => normalizeLeanstarReviewItem(review, typeMap))
      .filter((review): review is HarnessProjectReviewItem => review !== null)

    return { tokenConfigured: true, reviews }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("项目评审查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
