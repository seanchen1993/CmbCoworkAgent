import { getUserInfo } from "../storage"
import { deriveUpperOrgLv1FromPath } from "../org-levels"
import type {
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchItem,
  HarnessEnterpriseProjectSearchResult
} from "../../shared/harness-board-types"

const ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE = 15
const ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS = 10000
const ENTERPRISE_PROJECT_SUCCESS_CODE = "SUC0000"

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

function isEnterpriseProjectQueryMockEnabled(): boolean {
  const value = (import.meta.env.VITE_ENTERPRISE_PROJECT_QUERY_MOCK as string | undefined)
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
