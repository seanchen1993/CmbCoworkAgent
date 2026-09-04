const LEANSTAR_GATEWAY_URL = import.meta.env.VITE_LEANSTAR_REVIEW_GATEWAY_URL?.trim() || ""
const USE_MOCK = import.meta.env.DEV || import.meta.env.VITE_LEANSTAR_REQUIREMENTS_MOCK === "true"

export type DigitalProduct = {
  id: string
  name: string
}

export type ProductRequirement = {
  id?: string
  code: string
  title: string
  status?: string
  priority?: string
  owner?: string
  functionList?: ProductRequirementFunction[]
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
}

type ApiPageResponse<T> = PageResponse<T> & {
  body?: PageResponse<T>
}

type NamespaceTreeResponse = {
  namespaceTreeList?: NamespaceTreeNode[]
}

const MOCK_PRODUCTS: DigitalProduct[] = [
  { id: "dp-wplus", name: "Mock 数字产品 A" },
  { id: "dp-mobile-bank", name: "Mock 数字产品 B" },
  { id: "dp-credit", name: "Mock 数字产品 C" }
]

const MOCK_REQUIREMENTS: Record<string, ProductRequirement[]> = {
  "org-wplus": [
    {
      code: "P2603-2406",
      title: "Mock 需求 A-1",
      status: "OPEN",
      priority: "HIGH",
      owner: "Mock 负责人 1"
    },
    {
      code: "P2603-2412",
      title: "Mock 需求 A-2",
      status: "OPEN",
      priority: "MEDIUM",
      owner: "Mock 负责人 2"
    }
  ],
  "org-mobile": [
    {
      code: "P2602-1031",
      title: "Mock 需求 B-1",
      status: "OPEN",
      priority: "HIGH",
      owner: "Mock 负责人 3"
    },
    {
      code: "P2602-1044",
      title: "Mock 需求 B-2",
      status: "DRAFT",
      priority: "LOW",
      owner: "Mock 负责人 4"
    }
  ],
  "org-credit": [
    {
      code: "P2601-0788",
      title: "Mock 需求 C-1",
      status: "OPEN",
      priority: "MEDIUM",
      owner: "Mock 负责人 5"
    }
  ]
}

const MOCK_DETAILS: Record<string, ImplementationDetail[]> = {
  "P2603-2406": [
    {
      frCode: "FR2603",
      subFrCode: "FR2603-001",
      title: "Mock 功能 A-1-1",
      implementDevopsOrgId: "org-wplus",
      frStatus: "OPEN",
      subFrStatus: "OPEN",
      projectCode: "PJ-2603-001",
      frOwner: "Mock 负责人 1",
      priority: "HIGH"
    },
    {
      frCode: "FR2603",
      subFrCode: "FR2603-002",
      title: "Mock 功能 A-1-2",
      implementDevopsOrgId: "org-wplus",
      frStatus: "OPEN",
      subFrStatus: "OPEN",
      projectCode: "PJ-2603-002",
      frOwner: "Mock 负责人 2",
      priority: "MEDIUM"
    }
  ],
  "P2603-2412": [
    {
      frCode: "FR2603",
      subFrCode: "FR2603-014",
      title: "Mock 功能 A-2-1",
      implementDevopsOrgId: "org-wplus",
      frStatus: "OPEN",
      subFrStatus: "OPEN",
      projectCode: "PJ-2603-014",
      frOwner: "Mock 负责人 2",
      priority: "MEDIUM"
    }
  ],
  "P2602-1031": [
    {
      frCode: "FR2602",
      subFrCode: "FR2602-088",
      title: "Mock 功能 B-1-1",
      implementDevopsOrgId: "org-mobile",
      frStatus: "OPEN",
      subFrStatus: "OPEN",
      projectCode: "PJ-2602-088",
      frOwner: "Mock 负责人 3",
      priority: "HIGH"
    },
    {
      frCode: "FR2602",
      subFrCode: "FR2602-089",
      title: "Mock 功能 B-1-2",
      implementDevopsOrgId: "org-mobile",
      frStatus: "OPEN",
      subFrStatus: "OPEN",
      projectCode: "PJ-2602-089",
      frOwner: "Mock 负责人 4",
      priority: "MEDIUM"
    }
  ],
  "P2602-1044": [
    {
      frCode: "FR2602",
      subFrCode: "FR2602-102",
      title: "Mock 功能 B-2-1",
      implementDevopsOrgId: "org-mobile",
      frStatus: "DRAFT",
      subFrStatus: "DRAFT",
      projectCode: "PJ-2602-102",
      frOwner: "Mock 负责人 4",
      priority: "LOW"
    }
  ],
  "P2601-0788": [
    {
      frCode: "FR2601",
      subFrCode: "FR2601-037",
      title: "Mock 功能 C-1-1",
      implementDevopsOrgId: "org-credit",
      frStatus: "OPEN",
      subFrStatus: "OPEN",
      projectCode: "PJ-2601-037",
      frOwner: "Mock 负责人 5",
      priority: "MEDIUM"
    }
  ]
}

const MOCK_REQUIREMENT_DETAIL: Record<string, RequirementDetail> = {
  "P2603-2406": { code: "P2603-2406", title: "Mock 需求 A-1" },
  "P2603-2412": { code: "P2603-2412", title: "Mock 需求 A-2" },
  "P2602-1031": { code: "P2602-1031", title: "Mock 需求 B-1" },
  "P2602-1044": { code: "P2602-1044", title: "Mock 需求 B-2" },
  "P2601-0788": { code: "P2601-0788", title: "Mock 需求 C-1" }
}

const MOCK_NAMESPACE_TREE: NamespaceTreeNode[] = [
  {
    devopsOrgId: "org-cmb",
    pathName: "Mock 银行",
    pathId: "cmb",
    orgLevel: "总行",
    isOrgLeaf: false,
    namespaceId: "",
    expandable: true,
    accessible: true,
    children: [
      {
        devopsOrgId: "org-it",
        pathName: "Mock 银行/Mock 总行/Mock 技术部",
        pathId: "cmb/it",
        orgLevel: "部门",
        isOrgLeaf: false,
        namespaceId: "",
        expandable: true,
        accessible: true,
        children: [
          {
            devopsOrgId: "org-wplus",
            pathName: "Mock 银行/Mock 总行/Mock 技术部/Mock 开发组 A",
            pathId: "cmb/it/wplus",
            orgLevel: "组",
            isOrgLeaf: true,
            namespaceId: "ns-wplus",
            namespaceEnabled: true,
            namespaceType: "IT_GROUP",
            memberType: "OWN",
            roleCode: "MEMBER",
            accessible: true
          },
          {
            devopsOrgId: "org-cloud",
            pathName: "Mock 银行/Mock 总行/Mock 技术部/Mock 开发组 B（无权限）",
            pathId: "cmb/it/cloud",
            orgLevel: "组",
            isOrgLeaf: true,
            namespaceId: "ns-cloud",
            namespaceEnabled: true,
            namespaceType: "IT_GROUP",
            memberType: "OWN",
            roleCode: "MEMBER",
            accessible: false,
            inaccessibleReason: "UNAUTHORIZED"
          }
        ]
      },
      {
        devopsOrgId: "org-retail",
        pathName: "Mock 银行/Mock 总行/Mock 业务部",
        pathId: "cmb/retail",
        orgLevel: "部门",
        isOrgLeaf: false,
        namespaceId: "",
        expandable: true,
        accessible: true,
        children: [
          {
            devopsOrgId: "org-mobile",
            pathName: "Mock 银行/Mock 总行/Mock 业务部/Mock 开发组 C",
            pathId: "cmb/retail/mobile",
            orgLevel: "组",
            isOrgLeaf: true,
            namespaceId: "ns-mobile",
            namespaceEnabled: true,
            namespaceType: "IT_GROUP",
            memberType: "OWN",
            roleCode: "MEMBER",
            accessible: true
          },
          {
            devopsOrgId: "org-credit",
            pathName: "Mock 银行/Mock 总行/Mock 业务部/Mock 开发组 D",
            pathId: "cmb/retail/credit",
            orgLevel: "组",
            isOrgLeaf: true,
            namespaceId: "ns-credit",
            namespaceEnabled: true,
            namespaceType: "IT_GROUP",
            memberType: "OWN",
            roleCode: "MEMBER",
            accessible: true
          }
        ]
      }
    ]
  }
]

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

export const leanstarRequirementsApi = {
  listDigitalProducts(): Promise<PageResponse<DigitalProduct>> {
    if (USE_MOCK) return Promise.resolve({ content: MOCK_PRODUCTS, total: MOCK_PRODUCTS.length })
    return request<PageResponse<DigitalProduct>>("/api/requirement/digital-products/person/page", {
      method: "POST",
      body: JSON.stringify({ pageIndex: 1, pageSize: 50 })
    })
  },

  listProductRequirements(
    domainId: string,
    domainType: string
  ): Promise<PageResponse<ProductRequirement>> {
    if (USE_MOCK) {
      const content = MOCK_REQUIREMENTS[domainId] ?? []
      return Promise.resolve({ content, total: content.length })
    }
    return request<ApiPageResponse<ProductRequirement>>("/api/requirement/product-requirements/page", {
      method: "POST",
      body: JSON.stringify({
        pageIndex: 1,
        pageSize: 15,
        domain: { id: domainId, type: domainType }
      })
    }).then((result) => result.body ?? result)
  },

  getImplementationDetail(code: string): Promise<{ subFrs?: ImplementationDetail[] }> {
    if (USE_MOCK) return Promise.resolve({ subFrs: MOCK_DETAILS[code] ?? [] })
    return request<{ subFrs?: ImplementationDetail[] }>(
      `/api/requirement/product-requirements/${encodeURIComponent(code)}/impl-detail`,
      { method: "GET" }
    )
  },

  // 第三步：需求整体详情
  getRequirementDetail(code: string): Promise<RequirementDetail> {
    if (USE_MOCK) return Promise.resolve(MOCK_REQUIREMENT_DETAIL[code] ?? {})
    return request<RequirementDetail>(
      `/api/requirement/product-requirements/${encodeURIComponent(code)}/detail`,
      { method: "GET" }
    )
  },

  getNamespaceTree(): Promise<NamespaceTreeResponse> {
    if (USE_MOCK) return Promise.resolve({ namespaceTreeList: MOCK_NAMESPACE_TREE })
    return request<NamespaceTreeResponse>("/api/leanstar/namespaces/tree", {
      method: "GET"
    })
  }
}
