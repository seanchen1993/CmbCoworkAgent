import { useEffect, useState } from "react"

interface DetailResult<T> {
  success: boolean
  data?: T
  error?: string
  cancelled?: boolean
}

export function useKnowledgeDetails<T>(
  open: boolean,
  rooms: string[],
  family: string,
  request: (rooms: string[]) => Promise<DetailResult<T>>
) {
  const [retryKey, setRetryKey] = useState(0)
  const key = JSON.stringify([rooms, retryKey])
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null } | null>(
    null
  )
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.resolve()
      .then(() => (cancelled ? undefined : request(rooms)))
      .then((result) => {
        if (cancelled || !result) return
        if (result.cancelled) throw new Error("查询已取消，请重试")
        if (!result.success || !result.data) throw new Error(result.error ?? "明细加载失败")
        setState({ key, data: result.data, error: null })
      })
      .catch((reason) => {
        if (!cancelled)
          setState({
            key,
            data: null,
            error: reason instanceof Error ? reason.message : String(reason)
          })
      })
    return () => {
      cancelled = true
      void window.api.dashboard.cancelRequests([family]).catch(() => undefined)
    }
  }, [open, rooms, family, request, key])
  const current = state?.key === key ? state : null
  return {
    data: current?.data ?? null,
    loading: open && !current,
    error: current?.error ?? null,
    retry: () => setRetryKey((n) => n + 1)
  }
}
