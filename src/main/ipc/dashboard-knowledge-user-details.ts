import type { KnowledgeUserDetail } from "../../shared/dashboard-knowledge-overview"
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"

const COUNT_FIELDS = [
  "totalNum",
  "abandonedNum",
  "recentNum",
  "updateActiveNum",
  "readActiveNum"
] as const

export function parseKnowledgeUserDetails(value: unknown): KnowledgeUserDetail[] {
  if (!Array.isArray(value)) throw new Error("用户知识沉淀明细接口未返回数组")
  return value.map((item): KnowledgeUserDetail => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("用户知识沉淀明细接口返回了无效记录")
    const row = {} as KnowledgeUserDetail
    for (const field of ["userName", "roomName"] as const) {
      const text: unknown = item[field]
      if (text != null && typeof text !== "string")
        throw new Error(`用户知识沉淀明细接口返回了无效字段：${field}`)
      row[field] = typeof text === "string" ? text.trim() : ""
    }
    for (const field of COUNT_FIELDS) {
      const count: unknown = item[field]
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
        throw new Error(`用户知识沉淀明细接口返回了无效数量：${field}`)
      row[field] = count
    }
    return row
  })
}

export async function fetchKnowledgeUserDetailList(
  baseUrl: string,
  orgIds: string[] | null,
  signal?: AbortSignal,
  request: typeof fetch = fetch
): Promise<KnowledgeUserDetail[]> {
  if (signal?.aborted) throw new DashboardRequestCancelledError()
  if (!baseUrl) throw new Error("未配置知识沉淀接口地址（VITE_KNOWLEDGE_OVERVIEW_BASE_URL）")
  const timeout = AbortSignal.timeout(10_000)
  try {
    const response = await request(`${baseUrl.replace(/\/+$/, "")}/knowledge/user-detail-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgIds }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (!response.ok) throw new Error(`用户知识沉淀明细接口返回 HTTP ${response.status}`)
    const raw: unknown = await response.json()
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    return parseKnowledgeUserDetails(raw)
  } catch (error) {
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    if (timeout.aborted) throw new Error("用户知识沉淀明细接口响应超时")
    throw error
  }
}
