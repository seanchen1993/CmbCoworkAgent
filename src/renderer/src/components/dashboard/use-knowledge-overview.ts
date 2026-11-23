import { useEffect, useState } from "react"
import type {
  KnowledgeProjectStats,
  KnowledgeRecentConstraintFiles
} from "../../../../shared/dashboard-knowledge-overview"
import type { TimeRange } from "./use-dashboard"
import { useKnowledgeDetails } from "./use-knowledge-details"

const loadAccumulation = (rooms: string[]) =>
  window.api.dashboard.knowledgeAccumulation({ upperOrgLv1: rooms })

export function useKnowledgeOverview(
  enabled: boolean,
  range: TimeRange,
  rooms: string[],
  refreshKey: number,
  createdInRangeOnly = false
) {
  const accumulation = useKnowledgeDetails(
    enabled,
    rooms,
    "dashboard:knowledgeAccumulation",
    loadAccumulation,
    refreshKey
  )
  const [projects, setProjects] = useState<KnowledgeProjectStats | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [recentConstraintFiles, setRecentConstraintFiles] =
    useState<KnowledgeRecentConstraintFiles | null>(null)
  const [recentConstraintFilesLoading, setRecentConstraintFilesLoading] = useState(false)
  const [recentConstraintFilesError, setRecentConstraintFilesError] = useState<string | null>(null)

  const projectRangeKey = createdInRangeOnly ? JSON.stringify(range) : "null"
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async (): Promise<void> => {
      setProjectsLoading(true)
      setProjects(null)
      setProjectsError(null)
      try {
        const result = await window.api.dashboard.knowledgeProjectStats(
          JSON.parse(projectRangeKey),
          {
            upperOrgLv1: rooms,
            createdInRangeOnly
          }
        )
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
  }, [enabled, projectRangeKey, createdInRangeOnly, rooms, refreshKey])

  // Rolling 30-day metric is independent of the top date selector.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async (): Promise<void> => {
      setRecentConstraintFilesLoading(true)
      setRecentConstraintFiles(null)
      setRecentConstraintFilesError(null)
      try {
        const result = await window.api.dashboard.knowledgeRecentConstraintFiles({
          upperOrgLv1: rooms
        })
        if (cancelled || result.cancelled) return
        if (!result.success || !result.data)
          throw new Error(result.error ?? "获取近期约束文件统计失败")
        setRecentConstraintFiles(result.data)
      } catch (error) {
        if (!cancelled)
          setRecentConstraintFilesError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setRecentConstraintFilesLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      void window.api.dashboard
        .cancelRequests(["dashboard:knowledgeRecentConstraintFiles"])
        .catch(() => undefined)
    }
  }, [enabled, rooms, refreshKey])

  return {
    accumulation: accumulation.data,
    accumulationLoading: accumulation.loading,
    accumulationError: accumulation.error,
    retryAccumulation: accumulation.retry,
    projects,
    projectsLoading,
    projectsError,
    recentConstraintFiles,
    recentConstraintFilesLoading,
    recentConstraintFilesError
  }
}
