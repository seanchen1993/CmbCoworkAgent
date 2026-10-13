import { useEffect, useState } from "react"
import type {
  KnowledgeAccumulationData,
  KnowledgeProjectStats
} from "../../../../shared/dashboard-knowledge-overview"
import type { TimeRange } from "./use-dashboard"

export function useKnowledgeOverview(
  enabled: boolean,
  range: TimeRange,
  rooms: string[],
  refreshKey: number
) {
  const [accumulation, setAccumulation] = useState<KnowledgeAccumulationData | null>(null)
  const [accumulationLoading, setAccumulationLoading] = useState(false)
  const [accumulationError, setAccumulationError] = useState<string | null>(null)
  const [projects, setProjects] = useState<KnowledgeProjectStats | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  // These four APIs do not accept dates. Date navigation must not repeat them.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async (): Promise<void> => {
      setAccumulationLoading(true)
      setAccumulation(null)
      setAccumulationError(null)
      try {
        const result = await window.api.dashboard.knowledgeAccumulation({ upperOrgLv1: rooms })
        if (cancelled || result.cancelled) return
        if (!result.success || !result.data) throw new Error(result.error ?? "获取知识沉淀数据失败")
        setAccumulation(result.data)
      } catch (error) {
        if (!cancelled) setAccumulationError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setAccumulationLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      void window.api.dashboard
        .cancelRequests(["dashboard:knowledgeAccumulation"])
        .catch(() => undefined)
    }
  }, [enabled, rooms, refreshKey])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async (): Promise<void> => {
      setProjectsLoading(true)
      setProjects(null)
      setProjectsError(null)
      try {
        const result = await window.api.dashboard.knowledgeProjectStats(range, {
          upperOrgLv1: rooms
        })
        if (cancelled || result.cancelled) return
        if (!result.success || !result.data) throw new Error(result.error ?? "获取系统约束统计失败")
        setProjects(result.data)
      } catch (error) {
        if (!cancelled) setProjectsError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setProjectsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      void window.api.dashboard
        .cancelRequests(["dashboard:knowledgeProjectStats"])
        .catch(() => undefined)
    }
  }, [enabled, range, rooms, refreshKey])

  return {
    accumulation,
    accumulationLoading,
    accumulationError,
    projects,
    projectsLoading,
    projectsError
  }
}
