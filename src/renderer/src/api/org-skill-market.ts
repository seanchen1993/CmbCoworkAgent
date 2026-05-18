import type { DownloadedItemFile, MarketApiResponse, MarketItem } from "./market"

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

interface OrgSkillLabel {
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
  updatedAt: string
  isSubscribe: boolean
  subscriptionCount: number
  downloadCount?: number | null
}

interface OrgSkillPageResponse {
  returnCode: string
  errorMsg?: string | null
  body: {
    total: number
    list: OrgSkillApiItem[]
    pageNum: number
    pageSize: number
    size: number
    startRow: number
    endRow: number
    pages: number
    prePage: number
    nextPage: number
    isFirstPage: boolean
    isLastPage: boolean
    hasPreviousPage: boolean
    hasNextPage: boolean
    navigatePages: number
    navigatepageNums: number[]
    navigateFirstPage: number
    navigateLastPage: number
  }
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
      department: "示例组织/知识运营组"
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
  page: (pageNum: number, pageSize: number) =>
    `${ORG_SKILL_GATEWAY_URL}/gw/mgr/open-api/skill/page?pageNum=${pageNum}&pageSize=${pageSize}`,
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

function assertOrgSkillPageResponse(data: OrgSkillPageResponse): void {
  if (data.returnCode !== "SUC0000") {
    throw new Error(data.errorMsg || "组织级技能列表加载失败")
  }

  if (!data.body || typeof data.body !== "object") {
    throw new Error("组织级技能列表响应缺少 body")
  }

  if (!Array.isArray(data.body.list)) {
    throw new Error("组织级技能列表响应 body.list 格式不正确")
  }
}

function toMarketResponse(data: OrgSkillPageResponse): MarketApiResponse {
  assertOrgSkillPageResponse(data)

  const body = data.body
  const total = body.total
  const resolvedPageSize = body.pageSize
  const pages = body.pages || Math.max(1, Math.ceil(total / resolvedPageSize))

  return {
    success: true,
    data: body.list.map(mapOrgSkillItem),
    pageNum: body.pageNum,
    pageSize: resolvedPageSize,
    total,
    pages,
    hasNextPage: body.hasNextPage,
    hasPreviousPage: body.hasPreviousPage
  }
}

export function getMockOrgSkillMarketResponse(pageNum = 1, pageSize = 10): MarketApiResponse {
  const total = MOCK_ORG_SKILL_ITEMS.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const safePageNum = Math.min(Math.max(1, pageNum), pages)
  const start = (safePageNum - 1) * pageSize
  const list = MOCK_ORG_SKILL_ITEMS.slice(start, start + pageSize)
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

function mapOrgSkillItem(item: OrgSkillApiItem): MarketItem {
  const latestVersion = getLatestOrgSkillVersion(item)
  const labelName = item.labels?.[0]?.labelName || item.category || "未分类"
  const managerParts = [
    item.manager?.ystId || item.manager?.userId || "",
    item.manager?.name || "",
    item.manager?.department || ""
  ].filter(Boolean)

  return {
    id: `org-skill-${item.id}`,
    type: "orgSkill",
    name: item.slug || item.name,
    chinese_name: item.name,
    description: item.description || "",
    filename: `${item.slug || item.name}.zip`,
    created_at: item.createdAt || item.updatedAt || new Date().toISOString(),
    category: `组织级技能/${labelName}`,
    tag: item.sourceOriginName || item.sourceOrigin || undefined,
    featured: "",
    version: normalizeOrgSkillVersionName(latestVersion?.name),
    user_id: managerParts.join("-"),
    guidance: item.description || "",
    orgSkillId: latestVersion?.skillId ?? item.id,
    orgSkillVersionId: latestVersion?.id,
    sourceOriginName: item.sourceOriginName,
    managerName: item.manager?.name,
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
  async getOrgSkills(pageNum = 1, pageSize = 10): Promise<MarketApiResponse> {
    const response = await fetch(ORG_SKILL_ENDPOINTS.page(pageNum, pageSize), {
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
    return toMarketResponse(data)
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
