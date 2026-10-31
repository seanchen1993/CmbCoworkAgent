import { useCallback, useEffect, useRef, useState } from "react"
import type {
  DesignImportProgress,
  DesignImportRequest,
  DesignImportResult
} from "../../../../shared/design-url-import"

export function useDesignUrlImport() {
  const [progress, setProgress] = useState<DesignImportProgress | null>(null)
  const [result, setResult] = useState<DesignImportResult | null>(null)
  const active = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.api.design.onUrlImportProgress?.((event) => {
      if (active.current === event.requestId) setProgress(event)
    })
    return () => {
      mounted.current = false
      unsubscribe?.()
      if (active.current) void window.api.design.cancelUrlImport(active.current).catch(() => {})
      active.current = null
    }
  }, [])
  const cancel = useCallback(() => {
    const id = active.current
    active.current = null
    if (id) {
      void window.api.design.cancelUrlImport(id).catch(() => {})
      setProgress({ requestId: id, stage: "cancelled", message: "页面还原已取消" })
    }
  }, [])
  const capture = useCallback(async (request: Omit<DesignImportRequest, "requestId">) => {
    if (active.current) return null
    const requestId = crypto.randomUUID()
    active.current = requestId
    setResult(null)
    setProgress({
      requestId,
      stage: "loading",
      message:
        request.source === "current-browser"
          ? "正在读取内置浏览器当前页面"
          : "使用内置浏览器登录态打开网页"
    })
    let next: DesignImportResult
    try {
      next = await window.api.design.importFromUrl({ ...request, requestId })
    } catch (error) {
      if (active.current === requestId) active.current = null
      throw error
    }
    if (!mounted.current || active.current !== requestId) {
      if (next.success) await window.api.design.finishUrlImport(requestId, false)
      return null
    }
    setResult(next)
    return next
  }, [])
  const finish = useCallback(async (requestId: string, keep: boolean) => {
    const accepted = await window.api.design.finishUrlImport(requestId, keep)
    if (keep && !accepted) throw new Error("页面还原任务已过期，请重新抓取")
    if (active.current === requestId) active.current = null
  }, [])
  return {
    progress,
    result,
    capture,
    cancel,
    finish,
    fail: (message: string) => {
      if (mounted.current)
        setResult((previous) => ({
          success: false,
          requestId: previous?.requestId ?? "",
          status: "failed",
          warnings: previous?.warnings ?? [],
          error: message
        }))
    },
    isCurrent: (id: string) => mounted.current && active.current === id,
    reset: () => {
      if (!active.current) {
        setResult(null)
        setProgress(null)
      }
    }
  }
}
