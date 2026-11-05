import {
  normalizeRoomName,
  resolveKnowledgeCommitRateScope
} from "./dashboard-knowledge-commit-rate"
import type { DashboardKnowledgeCommitRateUnavailableReason } from "../../shared/dashboard-knowledge-commit-rate"
import type {
  KnowledgeAccumulationData,
  KnowledgeAccumulationTotals,
  KnowledgeDistributionItem,
  KnowledgeProjectStats,
  KnowledgeSection
} from "../../shared/dashboard-knowledge-overview"
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"

export function resolveKnowledgeOverviewScope(
  input: Parameters<typeof resolveKnowledgeCommitRateScope>[0],
  getRoomIds: () => Map<string, string>
): { orgIds: string[] | null; unavailableReason?: DashboardKnowledgeCommitRateUnavailableReason } {
  const scope = resolveKnowledgeCommitRateScope(input)
  if (scope.kind === "allRooms") return { orgIds: null }
  if (scope.kind === "unavailable" && scope.reason !== "multipleRooms") {
    return { orgIds: [], unavailableReason: scope.reason }
  }
  const rooms = scope.kind === "room" ? [scope.roomName] : input.requestedRooms
  if (rooms.includes(input.unclassifiedRoom)) {
    return { orgIds: [], unavailableReason: "unclassified" }
  }
  const mapping = getRoomIds()
  const ids = rooms.map((room) => mapping.get(normalizeRoomName(room)))
  if (ids.some((id) => !id)) return { orgIds: [], unavailableReason: "roomNotMapped" }
  return { orgIds: [...new Set(ids as string[])] }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("知识沉淀接口返回了无效的数量")
  }
  return value
}

export function parseKnowledgeTotals(value: unknown): KnowledgeAccumulationTotals {
  const data = record(value)
  return {
    totalNum: count(data.totalNum),
    abandonedNum: count(data.abandonedNum),
    activeNum: count(data.activeNum)
  }
}

export function parseKnowledgeDistribution(value: unknown): KnowledgeDistributionItem[] {
  if (!Array.isArray(value)) throw new Error("知识沉淀分布接口未返回数组")
  const items = new Map<string, number>()
  for (const item of value) {
    const row = record(item)
    if (row.name != null && typeof row.name !== "string") {
      throw new Error("知识沉淀分布接口返回了无效的名称")
    }
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "未归属"
    items.set(name, (items.get(name) ?? 0) + count(row.value))
  }
  return [...items]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
}

export function emptyKnowledgeAccumulation(): KnowledgeAccumulationData {
  return { totals: null, users: null, orgs: null, systems: null, errors: {} }
}

export async function fetchKnowledgeAccumulation(
  baseUrl: string,
  orgIds: string[] | null,
  signal?: AbortSignal,
  request: typeof fetch = fetch
): Promise<KnowledgeAccumulationData> {
  if (signal?.aborted) throw new DashboardRequestCancelledError()
  if (!baseUrl) throw new Error("未配置知识沉淀接口地址（VITE_KNOWLEDGE_OVERVIEW_BASE_URL）")
  const result = emptyKnowledgeAccumulation()
  const endpoints: Array<[KnowledgeSection, string]> = [
    ["totals", "accumulate"],
    ["users", "user-distribution"],
    ["orgs", "org-distribution"],
    ["systems", "system-distribution"]
  ]
  // Two concurrent requests keep a room switch from bursting all four calls at once.
  let next = 0
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < endpoints.length) {
        if (signal?.aborted) throw new DashboardRequestCancelledError()
        const [section, path] = endpoints[next++]
        const timeout = AbortSignal.timeout(10_000)
        try {
          const response = await request(`${baseUrl.replace(/\/+$/, "")}/knowledge/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgIds }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
          })
          if (!response.ok) throw new Error(`知识沉淀接口返回 HTTP ${response.status}`)
          const raw: unknown = await response.json()
          if (section === "totals") result.totals = parseKnowledgeTotals(raw)
          else result[section] = parseKnowledgeDistribution(raw)
        } catch (error) {
          if (signal?.aborted) throw new DashboardRequestCancelledError()
          result.errors[section] = timeout.aborted
            ? "知识沉淀接口响应超时"
            : error instanceof Error
              ? error.message
              : String(error)
        }
      }
    })
  )
  if (signal?.aborted) throw new DashboardRequestCancelledError()
  return result
}

/** Only aggregate indexed counters; neither query retrieves project lists or raw traces. */
export function buildKnowledgeProjectQueries(
  snapshotFilters: Record<string, unknown>[],
  readFilters: Record<string, unknown>[]
): Record<string, unknown>[] {
  const projects = { cardinality: { field: "properties.projectId", precision_threshold: 40000 } }
  return [
    {
      size: 0,
      track_total_hits: false,
      query: { bool: { filter: snapshotFilters } },
      aggs: {
        projects,
        loaded: {
          filter: { term: { "properties.systemConstraintEverLoadedSuccessfully": true } },
          aggs: { projects }
        }
      }
    },
    {
      size: 0,
      track_total_hits: false,
      query: { bool: { filter: readFilters } },
      aggs: {
        projects: {
          cardinality: { field: "properties.harnessProjectId", precision_threshold: 40000 }
        },
        reads: { sum: { field: "properties.successfulReadCount" } }
      }
    }
  ]
}

export function parseKnowledgeProjectStats(
  snapshot: unknown,
  reads: unknown
): KnowledgeProjectStats {
  const s = record(record(snapshot).aggregations)
  const r = record(record(reads).aggregations)
  return {
    projectCount: count(record(s.projects).value),
    loadedProjectCount: count(record(record(s.loaded).projects).value),
    readProjectCount: count(record(r.projects).value),
    successfulReadCount: count(record(r.reads).value)
  }
}
