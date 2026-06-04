import type { DownloadedItemFile, MarketApiResponse, MarketItem } from "./market"
import { toast } from "sonner"

interface OrgSkillVersion {
  id: number
  skillId: number
  name: string
  allowBrowserAccess: boolean
  updatedAt: string
}

interface OrgSkillManager {
  name: string
  userId: string
  ystId: string
  openId: string
  department: string
}

interface OrgSkillSystem {
  id: string
  name: string
}

export interface OrgSkillLabel {
  labelId: string
  labelName: string
}

interface OrgSkillApiItem {
  id: number
  slug: string
  name: string
  description: string
  icon: string
  sourceOrigin: string
  sourceOriginName: string
  manager: OrgSkillManager
  belongsToSystems: OrgSkillSystem[]
  labels: OrgSkillLabel[]
  category: string
  isDuplicated: boolean | null
  versions: OrgSkillVersion[]
  createdAt: string
  updateAt?: string
  updatedAt: string
  isSubscribe: boolean
  subscriptionCount: number
  downloadCount?: number | null
}

interface OrgSkillPageBody {
  total?: number | null
  list?: OrgSkillApiItem[] | null
  pageNum?: number | null
  pageSize?: number | null
  size?: number | null
  startRow?: number | null
  endRow?: number | null
  pages?: number | null
  prePage?: number | null
  nextPage?: number | null
  isFirstPage?: boolean | null
  isLastPage?: boolean | null
  hasPreviousPage?: boolean | null
  hasNextPage?: boolean | null
  navigatePages?: number | null
  navigatepageNums?: number[] | null
  navigateFirstPage?: number | null
  navigateLastPage?: number | null
}

interface NormalizedOrgSkillPageBody {
  total: number
  list: OrgSkillApiItem[]
  pageNum: number
  pageSize: number
  pages: number
  hasPreviousPage: boolean
  hasNextPage: boolean
}

interface OrgSkillPageResponse {
  returnCode: string
  errorMsg?: string | null
  body: OrgSkillPageBody | null
}

interface OrgSkillLabelsResponse {
  returnCode: string
  errorMsg?: string | null
  body: OrgSkillLabel[] | null
}

const MOCK_ORG_SKILL_ITEMS: OrgSkillApiItem[] = [
  {
    id: 10001,
    slug: "org-policy-helper",
    name: "制度问答助手",
    description: "聚合组织内部公开制度与流程说明，帮助用户快速定位适用条款、办理路径和注意事项。",
    icon: "",
    sourceOrigin: "ORG",
    sourceOriginName: "组织发布",
    manager: {
      name: "Mock 管理员",
      userId: "mock-user-001",
      ystId: "mock001",
      openId: "MOCK_OPEN_ID_001",
      department: "第一/第二/示例组织/知识运营组"
    },
    belongsToSystems: [{ id: "MOCK.SYS.01", name: "示例技能平台" }],
    labels: [{ labelId: "mock-label-policy", labelName: "制度规范" }],
    category: "SHARE",
    isDuplicated: null,
    versions: [
      {
        id: 20001,
        skillId: 10001,
        name: "V2.1.0",
        allowBrowserAccess: false,
        updatedAt: "2026-05-10T09:30:00.000+08:00"
      }
    ],
    createdAt: "2026-05-10T09:30:00.000+08:00",
    updatedAt: "2026-05-10T09:30:00.000+08:00",
    isSubscribe: false,
    subscriptionCount: 12,
    downloadCount: null
  },
  {
    id: 10002,
    slug: "org-process-planner",
    name: "流程办理助手",
    description: "面向组织内部协作场景的流程规划技能，可输出步骤、材料、角色和风险提醒。",
    icon: "",
    sourceOrigin: "ORG",
    sourceOriginName: "组织发布",
    manager: {
      name: "Mock 管理员",
      userId: "mock-user-002",
      ystId: "mock002",
      openId: "MOCK_OPEN_ID_002",
      department: "示例组织/流程协同组"
    },
    belongsToSystems: [{ id: "MOCK.SYS.01", name: "示例技能平台" }],
    labels: [{ labelId: "mock-label-process", labelName: "流程协同" }],
    category: "SHARE",
    isDuplicated: null,
    versions: [
      {
        id: 20002,
        skillId: 10002,
        name: "V1.4.2",
        allowBrowserAccess: false,
        updatedAt: "2026-05-11T14:15:00.000+08:00"
      }
    ],
    createdAt: "2026-05-11T14:15:00.000+08:00",
    updatedAt: "2026-05-11T14:15:00.000+08:00",
    isSubscribe: false,
    subscriptionCount: 8,
    downloadCount: null
  }
]

const ORG_SKILL_GATEWAY_URL = String(
  import.meta.env.VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL ||
    "http://open-assistant-hub-gateway.paasoa.cmbchina.cn"
).replace(/\/+$/, "")

const ORG_SKILL_ENDPOINTS = {
  page: (pageNum: number, pageSize: number, labelIds: string[] = [], keyword = "") => {
    const labelIdsParam = labelIds
      .map((id) => id.trim())
      .filter(Boolean)
      .map(encodeURIComponent)
      .join(",")
    const normalizedKeyword = keyword.trim()
    const queryParts = [`pageNum=${pageNum}`, `pageSize=${pageSize}`, `queryAll=true`, 'queryType=null']
    if (labelIdsParam) queryParts.push(`labelIds=${labelIdsParam}`)
    if (normalizedKeyword) queryParts.push(`keyword=${encodeURIComponent(normalizedKeyword)}`)
    return `${ORG_SKILL_GATEWAY_URL}/gw/mgr/open-api/skill/page?${queryParts.join("&")}`
  },
  labels: `${ORG_SKILL_GATEWAY_URL}/gw/mgr/open-api/skill/labels`,
  download: (skillId: number, versionId: number) =>
    `${ORG_SKILL_GATEWAY_URL}/gw/mgr/open-api/skill/document/download?skillId=${skillId}&versionId=${versionId}`
}

function normalizeOrgSkillVersionName(version?: string): string {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
}

function getLatestOrgSkillVersion(item: OrgSkillApiItem): OrgSkillVersion | undefined {
  return item.versions?.[0]
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const parsed = toFiniteNumber(value)
  if (parsed === null || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = toFiniteNumber(value)
  if (parsed === null || parsed < 0) return fallback
  return Math.trunc(parsed)
}

function assertOrgSkillPageSuccess(data: OrgSkillPageResponse): void {
  if (data.returnCode !== "SUC0000") {
    const message = data.errorMsg || "组织级技能列表加载失败"
    if (data.returnCode === "SCG1005") {
      toast.error(message)
    }
    throw new Error(message)
  }
}

function normalizeOrgSkillPageBody(
  data: OrgSkillPageResponse,
  fallbackPageNum: number,
  fallbackPageSize: number
): NormalizedOrgSkillPageBody {
  assertOrgSkillPageSuccess(data)

  const pageNumFallback = toPositiveInteger(fallbackPageNum, 1)
  const pageSizeFallback = toPositiveInteger(fallbackPageSize, 10)
  const emptyBody: NormalizedOrgSkillPageBody = {
    total: 0,
    list: [],
    pageNum: pageNumFallback,
    pageSize: pageSizeFallback,
    pages: 1,
    hasNextPage: false,
    hasPreviousPage: pageNumFallback > 1
  }

  if (!data.body || typeof data.body !== "object") {
    return emptyBody
  }

  const rawBody = data.body as Record<string, unknown>
  const rawList = rawBody.list
  if (!Array.isArray(rawList)) {
    if (rawList == null) return emptyBody
    throw new Error("组织级技能列表响应 body.list 格式不正确")
  }

  const list = rawList as OrgSkillApiItem[]
  const pageSize = toPositiveInteger(rawBody.pageSize, pageSizeFallback)
  const pageNum = toPositiveInteger(rawBody.pageNum, pageNumFallback)
  const total = toNonNegativeInteger(rawBody.total, list.length)
  const derivedPages = Math.max(1, Math.ceil(total / pageSize))
  const pages = toPositiveInteger(rawBody.pages, derivedPages)
  const hasNextPage =
    typeof rawBody.hasNextPage === "boolean" ? rawBody.hasNextPage : pageNum < pages
  const hasPreviousPage =
    typeof rawBody.hasPreviousPage === "boolean" ? rawBody.hasPreviousPage : pageNum > 1

  return {
    total,
    list,
    pageNum,
    pageSize,
    pages,
    hasNextPage,
    hasPreviousPage
  }
}

function assertOrgSkillLabelsResponse(data: OrgSkillLabelsResponse): void {
  if (data.returnCode !== "SUC0000") {
    throw new Error(data.errorMsg || "组织级技能分类加载失败")
  }

  if (!Array.isArray(data.body)) {
    throw new Error("组织级技能分类响应 body 格式不正确")
  }
}

function toMarketResponse(
  data: OrgSkillPageResponse,
  fallbackPageNum = 1,
  fallbackPageSize = 10
): MarketApiResponse {
  const body = normalizeOrgSkillPageBody(data, fallbackPageNum, fallbackPageSize)

  return {
    success: true,
    data: body.list.map(mapOrgSkillItem),
    pageNum: body.pageNum,
    pageSize: body.pageSize,
    total: body.total,
    pages: body.pages,
    hasNextPage: body.hasNextPage,
    hasPreviousPage: body.hasPreviousPage
  }
}

export function getMockOrgSkillMarketResponse(
  pageNum = 1,
  pageSize = 10,
  labelIds: string[] = [],
  keyword = ""
): MarketApiResponse {
  const selectedLabelIds = new Set(labelIds.map((id) => id.trim()).filter(Boolean))
  const normalizedKeyword = keyword.trim().toLowerCase()
  const labelFilteredItems =
    selectedLabelIds.size === 0
      ? MOCK_ORG_SKILL_ITEMS
      : MOCK_ORG_SKILL_ITEMS.filter((item) =>
          item.labels?.some((label) => selectedLabelIds.has(label.labelId))
        )
  const filteredItems = normalizedKeyword
    ? labelFilteredItems.filter(
        (item) =>
          item.slug.toLowerCase().includes(normalizedKeyword) ||
          item.name.toLowerCase().includes(normalizedKeyword) ||
          item.description.toLowerCase().includes(normalizedKeyword)
      )
    : labelFilteredItems
  const total = filteredItems.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const safePageNum = Math.min(Math.max(1, pageNum), pages)
  const start = (safePageNum - 1) * pageSize
  const list = filteredItems.slice(start, start + pageSize)
  const size = list.length
  const response: OrgSkillPageResponse = {
    returnCode: "SUC0000",
    errorMsg: null,
    body: {
      total,
      list,
      pageNum: safePageNum,
      pageSize,
      size,
      startRow: total === 0 ? 0 : start + 1,
      endRow: start + size,
      pages,
      prePage: safePageNum > 1 ? safePageNum - 1 : 0,
      nextPage: safePageNum < pages ? safePageNum + 1 : 0,
      isFirstPage: safePageNum === 1,
      isLastPage: safePageNum === pages,
      hasPreviousPage: safePageNum > 1,
      hasNextPage: safePageNum < pages,
      navigatePages: 8,
      navigatepageNums: Array.from({ length: Math.min(8, pages) }, (_, index) => index + 1),
      navigateFirstPage: 1,
      navigateLastPage: Math.min(8, pages)
    }
  }

  return toMarketResponse(response)
}

export function getMockOrgSkillLabels(): OrgSkillLabel[] {
  const labels = new Map<string, OrgSkillLabel>()
  for (const item of MOCK_ORG_SKILL_ITEMS) {
    for (const label of item.labels || []) {
      if (label.labelId && label.labelName) {
        labels.set(label.labelId, label)
      }
    }
  }
  return Array.from(labels.values())
}

function mapOrgSkillItem(item: OrgSkillApiItem): MarketItem {
  const latestVersion = getLatestOrgSkillVersion(item)
  const labelName = item.labels?.[0]?.labelName || item.category || "未分类"
  const updatedAt = item.updateAt || item.updatedAt || item.createdAt || new Date().toISOString()

  return {
    id: `org-skill-${item.id}`,
    type: "orgSkill",
    name: item.slug || item.name,
    chinese_name: item.name,
    description: item.description || "",
    filename: `${item.slug || item.name}.zip`,
    created_at: item.createdAt || updatedAt,
    updated_at: updatedAt,
    category: `组织级技能/${labelName}`,
    tag: item.sourceOriginName || item.sourceOrigin || undefined,
    featured: "",
    version: normalizeOrgSkillVersionName(latestVersion?.name),
    user_id: item.manager?.ystId || item.manager?.userId || undefined,
    guidance: item.description || "",
    orgSkillId: latestVersion?.skillId ?? item.id,
    orgSkillVersionId: latestVersion?.id,
    sourceOriginName: item.sourceOriginName,
    managerName: item.manager?.name,
    managerDepartment: item.manager?.department,
    subscriptionCount: item.subscriptionCount
  }
}

function getOrgSkillErrorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null

  const payload = body as Record<string, unknown>
  const candidates = [payload.errorMsg, payload.detail, payload.message, payload.error]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

async function readOrgSkillErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP error! status: ${response.status}`

  try {
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json")) {
      const data = await response.json()
      return getOrgSkillErrorMessageFromBody(data) || fallback
    }

    const text = await response.text()
    if (!text.trim()) return fallback

    try {
      const data = JSON.parse(text)
      return getOrgSkillErrorMessageFromBody(data) || text
    } catch {
      return text
    }
  } catch (error) {
    console.warn("[orgSkillMarketApi] Failed to parse error response:", error)
    return fallback
  }
}

async function throwOrgSkillError(response: Response): Promise<never> {
  const message = await readOrgSkillErrorMessage(response)
  throw new Error(message)
}

async function getYstIdToken(): Promise<string> {
  try {
    if (typeof window.api?.models?.getUserInfo !== "function") return ""
    const userInfo = await window.api.models.getUserInfo()
    return String(userInfo?.ystIdToken || "").trim()
  } catch (error) {
    console.warn("[orgSkillMarketApi] Failed to read ystIdToken:", error)
    return ""
  }
}

async function getOrgSkillAuthHeaders(): Promise<HeadersInit> {
  const token = await getYstIdToken()
  return token ? { Authorization: token } : {}
}

export const orgSkillMarketApi = {
  async getOrgSkills(
    pageNum = 1,
    pageSize = 10,
    labelIds: string[] = [],
    keyword = ""
  ): Promise<MarketApiResponse> {
    const response = await fetch(ORG_SKILL_ENDPOINTS.page(pageNum, pageSize, labelIds, keyword), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(await getOrgSkillAuthHeaders())
      }
    })

    if (!response.ok) {
      await throwOrgSkillError(response)
    }

    const data = (await response.json()) as OrgSkillPageResponse
    return toMarketResponse(data, pageNum, pageSize)
  },

  async getOrgSkillLabels(): Promise<OrgSkillLabel[]> {
    const response = await fetch(ORG_SKILL_ENDPOINTS.labels, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(await getOrgSkillAuthHeaders())
      }
    })

    if (!response.ok) {
      await throwOrgSkillError(response)
    }

    const data = (await response.json()) as OrgSkillLabelsResponse
    assertOrgSkillLabelsResponse(data)
    return data.body!
  },

  async fetchInstallFile(item: MarketItem): Promise<DownloadedItemFile> {
    const skillId = item.orgSkillId
    const versionId = item.orgSkillVersionId
    if (!skillId || !versionId) {
      throw new Error("组织级技能缺少 skillId 或 versionId，无法下载")
    }

    const response = await fetch(ORG_SKILL_ENDPOINTS.download(skillId, versionId), {
      method: "GET",
      headers: await getOrgSkillAuthHeaders()
    })

    if (!response.ok) {
      await throwOrgSkillError(response)
    }

    const blob = await response.blob()
    const contentDisposition = response.headers.get("Content-Disposition")
    const filename =
      contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/)?.[1] ||
      item.filename ||
      `${item.name}.zip`

    return { blob, filename: decodeURIComponent(filename.replace(/^"|"$/g, "")) }
  }
}
