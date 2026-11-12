const LEANSTAR_GATEWAY_URL = import.meta.env.VITE_LEANSTAR_REVIEW_GATEWAY_URL?.trim() || ""
export type ProductRequirement = {
  id?: string | number
  code: string
  title: string
  status?: string
  priority?: string
  owner?: string | { id?: string; name?: string }
  ownerSapId?: string
  ownerName?: string
  createTime?: string
  updateTime?: string
  updatedAt?: string
  functionList?: ProductRequirementFunction[]
  functionRequirements?: ProductRequirementFunction[]
}

export type ProductRequirementFunction = {
  id?: string
  code: string
  title: string
  status?: string
  priority?: string
}

export type ImplementationDetail = {
  id?: string
  frCode?: string
  subFrCode?: string
  title: string
  implementDevopsOrgId?: string
  frStatus?: string
  subFrStatus?: string
  projectCode?: string
  frOwner?: string
  priority?: string
}

// /detail 接口返回的“需求整体详情”。规格未列举具体字段，仅给出用途，故以宽松索引签名承载。
export type RequirementDetail = {
  code?: string
  title?: string
  description?: string
  [key: string]: unknown
}

export type RequirementDocumentContent = {
  code?: string
  title?: string
  type?: string
  requirementVersion?: string | null
  digitalProductId?: string
  digitalProductName?: string
  documentTextContent?: string
  zhaohuDocId?: string | null
  prType?: string
  frType?: string | null
  richComponents?: RichComponent[]
}

export type RichComponent = {
  id: string
  resourceName: string
  resourceVersion?: string | null
  type?: string
}

// 实施功能（subFr）的唯一标识，优先 subFrCode，回退 frCode。
export function getDetailCode(detail?: ImplementationDetail): string {
  return detail?.subFrCode || detail?.frCode || detail?.id || ""
}

export type NamespaceTreeNode = {
  devopsOrgId: string
  pathName: string
  pathId: string
  orgLevel?: string
  isOrgLeaf?: boolean
  namespaceId?: string
  namespaceEnabled?: boolean
  namespaceType?: string
  memberType?: string
  roleCode?: string
  selected?: boolean
  expandable?: boolean
  accessible?: boolean
  inaccessibleReason?: string
  children?: NamespaceTreeNode[]
}

type PageResponse<T> = {
  content?: T[]
  total?: number
  totalElements?: number
}

type ApiPageResponse<T> = PageResponse<T> & {
  body?: PageResponse<T>
}

type ApiDetailResponse = {
  returnCode?: string
  errorMsg?: string
  body?: RequirementDetail | null
}

type ApiDocumentContentResponse = {
  returnCode?: string
  errorMsg?: string | null
  body?: RequirementDocumentContent | null
}

type DeliveryRequirementsResponse = {
  returnCode?: string
  errorMsg?: string | null
  body?: PageResponse<ProductRequirement>
}

type MultimodalComponentResponse = {
  returnCode?: string
  errorMsg?: string | null
  body?: Array<{ componentId: string; parsedSuccess?: boolean; parsedText?: string }>
}

type NamespaceTreeResponse = {
  namespaceTreeList?: NamespaceTreeNode[]
}

function leanstarApiError(code: string, message?: string | null): Error & { code: string } {
  return Object.assign(new Error(message || `Leanstar 请求失败：${code}`), { code })
}

async function getToken(): Promise<string> {
  const result = await window.api.requirements.getToken()
  if (!result.success || !result.token.trim()) {
    throw new Error(result.error || "请先配置 Leanstar Access Token")
  }
  return result.token.trim()
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken()
  if (!LEANSTAR_GATEWAY_URL) throw new Error("未配置 Leanstar 网关地址")
  const response = await fetch(`${LEANSTAR_GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Ls-Access-Token": token,
      ...(init.headers || {})
    }
  })

  if (!response.ok) {
    const message = await response.text().catch(() => "")
    throw new Error(`Leanstar 请求失败（${response.status}）：${message || response.statusText}`)
  }
  return (await response.json()) as T
}

async function requestFile(path: string, body: unknown): Promise<Blob> {
  const token = await getToken()
  if (!LEANSTAR_GATEWAY_URL) throw new Error("未配置 Leanstar 网关地址")
  const response = await fetch(`${LEANSTAR_GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Ls-Access-Token": token },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`下载富文本资源失败（${response.status}）`)
  const contentType = response.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    const result = (await response.json()) as { returnCode?: string; errorMsg?: string }
    throw leanstarApiError(result.returnCode || "UNKNOWN", result.errorMsg || "下载富文本资源失败")
  }
  return response.blob()
}

export const leanstarRequirementsApi = {
  listProductRequirements(
    domainId: string,
    domainType: string
  ): Promise<PageResponse<ProductRequirement>> {
    return request<ApiPageResponse<ProductRequirement>>(
      "/api/requirement/product-requirements/page",
      {
        method: "POST",
        body: JSON.stringify({
          pageIndex: 1,
          pageSize: 15,
          domain: { id: domainId, type: domainType }
        })
      }
    ).then((result) => result.body ?? result)
  },

  listDeliveryRequirements(
    implementGroupDevopsOrgId: string
  ): Promise<PageResponse<ProductRequirement>> {
    return request<DeliveryRequirementsResponse>("/api/delivery/requirements", {
      method: "POST",
      body: JSON.stringify({
        implementGroupDevopsOrgId,
        category: "BY_REQUIREMENT",
        page: 0,
        size: 15
      })
    }).then((result) => {
      if (result.returnCode && result.returnCode !== "SUC0000") {
        throw new Error(result.errorMsg || `查询需求列表失败：${result.returnCode}`)
      }
      const page = result.body ?? { content: [], total: 0 }
      return { ...page, total: page.totalElements ?? page.total ?? 0 }
    })
  },

  getImplementationDetail(code: string): Promise<{ subFrs?: ImplementationDetail[] }> {
    return request<{ subFrs?: ImplementationDetail[] }>(
      `/api/requirement/product-requirements/${encodeURIComponent(code)}/impl-detail`,
      { method: "GET" }
    )
  },

  // 第三步：需求整体详情
  getRequirementDetail(code: string): Promise<RequirementDetail | null> {
    return request<RequirementDetail | ApiDetailResponse>(
      `/api/requirement/product-requirements/${encodeURIComponent(code)}/detail`,
      { method: "GET" }
    ).then((result) => {
      if (result && typeof result === "object" && "returnCode" in result) {
        const response = result as ApiDetailResponse
        if (response.returnCode && response.returnCode !== "SUC0000") {
          throw leanstarApiError(response.returnCode, response.errorMsg)
        }
        return response.body ?? null
      }
      return result as RequirementDetail
    })
  },

  getRequirementDocumentContent(code: string): Promise<RequirementDocumentContent | null> {
    return request<ApiDocumentContentResponse>(
      `/api/requirement/document-content/${encodeURIComponent(code)}`,
      { method: "GET" }
    ).then((result) => {
      if (result.returnCode && result.returnCode !== "SUC0000") {
        throw leanstarApiError(result.returnCode, result.errorMsg)
      }
      return result.body ?? null
    })
  },

  downloadRichComponent(component: RichComponent, requirementCode: string): Promise<Blob> {
    return requestFile("/api/requirement/download-zhaohu-doc-component", {
      componentId: component.id,
      resourceName: component.resourceName,
      requirementCode
    })
  },

  getMultimodalComponentDescriptions(components: RichComponent[]): Promise<Map<string, string>> {
    const typeMap: Record<string, string> = {
      IMAGE: "IMAGE",
      MIND: "MIND",
      MIND_MAP: "MIND",
      思维导图: "MIND",
      FLOW_CHART: "FLOW_CHART",
      FLOWCHART: "FLOW_CHART",
      流程图: "FLOW_CHART",
      图片: "IMAGE"
    }
    const supported = components
      .map((component) => ({
        componentId: component.id,
        componentType: typeMap[(component.type || "").toUpperCase()],
        version: component.resourceVersion || undefined
      }))
      .filter((component) => Boolean(component.componentType))
    if (!supported.length) return Promise.resolve(new Map())
    return request<MultimodalComponentResponse>(
      "/api/requirement/document-content/multimodal-component",
      { method: "POST", body: JSON.stringify({ components: supported }) }
    ).then((result) => {
      if (result.returnCode && result.returnCode !== "SUC0000") {
        throw leanstarApiError(result.returnCode, result.errorMsg)
      }
      return new Map(
        (result.body ?? [])
          .filter((item) => item.parsedSuccess && item.parsedText)
          .map((item) => [item.componentId, item.parsedText || ""])
      )
    })
  },

  getNamespaceTree(): Promise<NamespaceTreeResponse> {
    return request<NamespaceTreeResponse>("/api/leanstar/namespaces/tree", {
      method: "GET"
    })
  }
}
