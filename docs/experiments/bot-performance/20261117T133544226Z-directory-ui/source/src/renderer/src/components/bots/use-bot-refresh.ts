import { useCallback, useEffect, useRef, useState } from "react"

/** One in-flight read, with one coalesced follow-up using the latest scope/callbacks. */
export function useBotRefresh<T>(
  key: string,
  read: () => Promise<T>,
  commit: (value: T) => void,
  fail: (cause: unknown) => void
) {
  const latest = useRef({ key, read, commit, fail })
  latest.current = { key, read, commit, fail }
  const pending = useRef<Promise<void> | null>(null),
    dirty = useRef(false),
    mounted = useRef(true)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      dirty.current = false
    }
  }, [])
  const refresh = useCallback(() => {
    dirty.current = true
    if (pending.current) return pending.current
    setLoading(true)
    pending.current = Promise.resolve()
      .then(async () => {
        while (dirty.current && mounted.current) {
          dirty.current = false
          const request = latest.current
          try {
            const value = await request.read()
            if (mounted.current && latest.current.key === request.key) request.commit(value)
          } catch (cause) {
            if (mounted.current && latest.current.key === request.key) request.fail(cause)
          }
        }
      })
      .finally(() => {
        pending.current = null
        if (mounted.current) setLoading(false)
      })
    return pending.current
  }, [])
  return { refresh, loading }
}
