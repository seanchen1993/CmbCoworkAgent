import type { KnowledgeActiveFile } from "../../shared/dashboard-knowledge-overview"
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"

const ACTIVE_FIELDS = [
  "filePath",
  "fileName",
  "subProduct",
  "deployUnit",
  "lastCommitDate",
  "lastCommitUser",
  "roomId",
  "roomName"
] as const

export function parseKnowledgeActiveList(value: unknown): KnowledgeActiveFile[] {
  if (!Array.isArray(value)) throw new Error("活跃知识明细接口未返回数组")
  return value
    .map((item): KnowledgeActiveFile => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("活跃知识明细接口返回了无效记录")
      const row = {} as KnowledgeActiveFile
      for (const field of ACTIVE_FIELDS) {
        const text: unknown = item[field]
        if (text != null && typeof text !== "string")
          throw new Error("活跃知识明细接口返回了无效字段")
        row[field] = typeof text === "string" ? text.trim() : ""
      }
      if (!row.filePath) throw new Error("活跃知识明细缺少文件路径")
      return row
    })
    .sort(
      (a, b) =>
        b.lastCommitDate.localeCompare(a.lastCommitDate) || a.filePath.localeCompare(b.filePath)
    )
}

export async function fetchKnowledgeActiveList(
  baseUrl: string,
  orgIds: string[] | null,
  signal?: AbortSignal,
  request: typeof fetch = fetch
): Promise<KnowledgeActiveFile[]> {
  if (signal?.aborted) throw new DashboardRequestCancelledError()
  if (!baseUrl) throw new Error("未配置知识沉淀接口地址（VITE_KNOWLEDGE_OVERVIEW_BASE_URL）")
  const timeout = AbortSignal.timeout(10_000)
  try {
    const response = await request(`${baseUrl.replace(/\/+$/, "")}/knowledge/active-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgIds }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (!response.ok) throw new Error(`活跃知识明细接口返回 HTTP ${response.status}`)
    const raw: unknown = await response.json()
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    return parseKnowledgeActiveList(raw)
  } catch (error) {
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    if (timeout.aborted) throw new Error("活跃知识明细接口响应超时")
    throw error
  }
}
