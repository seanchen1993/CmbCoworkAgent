const LEANSTAR_GATEWAY_URL = import.meta.env.VITE_LEANSTAR_REVIEW_GATEWAY_URL?.trim() || ""
const USE_MOCK = import.meta.env.DEV || import.meta.env.VITE_LEANSTAR_REQUIREMENTS_MOCK === "true"

export type DigitalProduct = {
  id: string
  name: string
}

export type ProductRequirement = {
  code: string
  title: string
  status?: string
  priority?: string
  owner?: string
}

export type ImplementationDetail = {
  code: string
  title: string
  status?: string
}

type PageResponse<T> = {
  content?: T[]
  total?: number
}

const MOCK_PRODUCTS: DigitalProduct[] = [
  { id: "dp-wplus", name: "市场 W+ 数字产品" },
  { id: "dp-mobile-bank", name: "招商银行手机银行" },
  { id: "dp-credit", name: "信用卡数字服务" }
]

const MOCK_REQUIREMENTS: Record<string, ProductRequirement[]> = {
  "dp-wplus": [
    { code: "P2603-2406", title: "用户登录优化", status: "OPEN", priority: "HIGH", owner: "杨琪" },
    {
      code: "P2603-2412",
      title: "首页权益卡片改版",
      status: "OPEN",
      priority: "MEDIUM",
      owner: "李宁"
    }
  ],
  "dp-mobile-bank": [
    {
      code: "P2602-1031",
      title: "转账流程体验升级",
      status: "OPEN",
      priority: "HIGH",
      owner: "周敏"
    },
    { code: "P2602-1044", title: "消息中心整合", status: "DRAFT", priority: "LOW", owner: "王超" }
  ],
  "dp-credit": [
    {
      code: "P2601-0788",
      title: "账单分期引导优化",
      status: "OPEN",
      priority: "MEDIUM",
      owner: "陈晨"
    }
  ]
}

const MOCK_DETAILS: Record<string, ImplementationDetail[]> = {
  "P2603-2406": [
    { code: "FR2603-001", title: "短信验证码登录", status: "OPEN" },
    { code: "FR2603-002", title: "生物识别快捷登录", status: "OPEN" }
  ],
  "P2603-2412": [{ code: "FR2603-014", title: "权益卡片排序", status: "OPEN" }],
  "P2602-1031": [
    { code: "FR2602-088", title: "收款人智能搜索", status: "OPEN" },
    { code: "FR2602-089", title: "转账结果页优化", status: "OPEN" }
  ],
  "P2602-1044": [{ code: "FR2602-102", title: "消息分类筛选", status: "DRAFT" }],
  "P2601-0788": [{ code: "FR2601-037", title: "分期方案对比", status: "OPEN" }]
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

export const leanstarRequirementsApi = {
  listDigitalProducts(): Promise<PageResponse<DigitalProduct>> {
    if (USE_MOCK) return Promise.resolve({ content: MOCK_PRODUCTS, total: MOCK_PRODUCTS.length })
    return request<PageResponse<DigitalProduct>>("/api/requirement/digital-products/person/page", {
      method: "POST",
      body: JSON.stringify({ pageIndex: 1, pageSize: 50 })
    })
  },

  listProductRequirements(productId: string): Promise<PageResponse<ProductRequirement>> {
    if (USE_MOCK) {
      const content = MOCK_REQUIREMENTS[productId] ?? []
      return Promise.resolve({ content, total: content.length })
    }
    return request<PageResponse<ProductRequirement>>("/api/requirement/product-requirements/page", {
      method: "POST",
      body: JSON.stringify({
        pageIndex: 1,
        pageSize: 15,
        domain: { id: productId, type: "DIGITAL_PRODUCT" }
      })
    })
  },

  getImplementationDetail(code: string): Promise<{ subFrs?: ImplementationDetail[] }> {
    if (USE_MOCK) return Promise.resolve({ subFrs: MOCK_DETAILS[code] ?? [] })
    return request<{ subFrs?: ImplementationDetail[] }>(
      `/api/requirement/product-requirements/${encodeURIComponent(code)}/impl-detail`,
      { method: "GET" }
    )
  }
}
