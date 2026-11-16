import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { KnowledgeBaseListResult } from "../../../../shared/knowledge-base-types"

const POLL_INTERVAL_MS = 3_000

export function useKnowledgeBases(
  active: boolean,
  formatError: (error: unknown) => string
): {
  result: KnowledgeBaseListResult | null
  loading: boolean
  load: (refresh?: boolean) => Promise<void>
} {
  const [result, setResult] = useState<KnowledgeBaseListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const latestRequest = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const read = useCallback(
    async (refresh = false, silent = false): Promise<void> => {
      const request = ++latestRequest.current
      if (!silent) setLoading(true)
      try {
        const next = refresh
          ? await window.api.harnessBoard.refreshKnowledgeBases()
          : await window.api.harnessBoard.listKnowledgeBases()
        if (mounted.current && request === latestRequest.current) setResult(next)
        if (mounted.current && refresh) {
          if (next.queryError) toast.warning(next.queryError)
          else toast.success("知识库更新检查完成，请查看各知识库状态")
        }
      } catch (error) {
        if (mounted.current && !silent) toast.error(formatError(error))
      } finally {
        if (mounted.current && !silent) setLoading(false)
      }
    },
    [formatError]
  )

  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (silent = true): Promise<void> => {
      await read(false, silent)
      if (!stopped) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }
    void poll(false)
    return () => {
      stopped = true
      clearTimeout(timer)
      latestRequest.current += 1
    }
  }, [active, read])

  return { result, loading, load: read }
}
