import { useCallback, useEffect, useRef, useState } from "react"
import { getDesignSessionClient } from "./session-client"
import type {
  DesignTweakCommand,
  DesignTweaksState,
  TweakValues
} from "../../../../shared/design-tweaks"

export function useDesignTweaks(
  sessionId: string | null,
  state: DesignTweaksState | null | undefined,
  runId?: string
) {
  const scopeKey = `${sessionId}:${runId ?? "artifact"}`
  const [overlay, setOverlay] = useState<{ scope: string; values: TweakValues }>({
    scope: scopeKey,
    values: {}
  })
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const job = useRef<{
    scope: string
    id: string | null
    runId?: string
    values: TweakValues
    timer?: ReturnType<typeof setTimeout>
    pending?: Promise<void>
  }>({ scope: scopeKey, id: sessionId, runId, values: {} })
  const flush = useCallback((): Promise<void> => {
    const task = job.current
    if (task.timer) clearTimeout(task.timer)
    task.timer = undefined
    if (!task.id) return Promise.resolve()
    if (task.pending) return task.pending
    const pending = (async () => {
      while (Object.keys(task.values).length) {
        for (const [key, value] of Object.entries(task.values)) {
          try {
            await getDesignSessionClient().tweak(task.id!, {
              scope: task.runId ? "draft" : "artifact",
              runId: task.runId,
              baseRevision: 0,
              operation: "set",
              key,
              value
            })
            if (task.values[key] === value) {
              delete task.values[key]
              setOverlay((old) => {
                if (old.scope !== task.scope || old.values[key] !== value) return old
                const values = { ...old.values }
                delete values[key]
                return { ...old, values }
              })
            }
            if (task === job.current) setFailure({ scope: task.scope, message: "" })
          } catch (cause) {
            if (task === job.current)
              setFailure({
                scope: task.scope,
                message: cause instanceof Error ? cause.message : String(cause)
              })
            throw cause
          }
        }
      }
    })()
    task.pending = pending
    void pending
      .finally(() => {
        if (task.pending === pending) task.pending = undefined
      })
      .catch(() => undefined)
    return pending
  }, [])
  useEffect(() => {
    job.current = { scope: scopeKey, id: sessionId, runId, values: {} }
    return () => {
      void flush().catch(() => undefined)
    }
  }, [scopeKey, sessionId, runId, flush])

  const change = useCallback(
    (key: string, value: TweakValues[string]) => {
      const task = job.current
      task.values[key] = value
      setOverlay((old) => ({
        scope: scopeKey,
        values: { ...(old.scope === scopeKey ? old.values : {}), [key]: value }
      }))
      if (task.timer) clearTimeout(task.timer)
      task.timer = setTimeout(() => {
        void flush().catch(() => undefined)
      }, 200)
    },
    [scopeKey, flush]
  )
  const command = useCallback(
    async (operation: DesignTweakCommand["operation"], key?: string) => {
      await flush()
      if (!sessionId) return
      try {
        await getDesignSessionClient().tweak(sessionId, {
          scope: runId ? "draft" : "artifact",
          runId,
          baseRevision: 0,
          operation,
          key
        })
        setFailure({ scope: scopeKey, message: "" })
      } catch (cause) {
        setFailure({
          scope: scopeKey,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    },
    [flush, sessionId, runId, scopeKey]
  )
  const values = overlay.scope === scopeKey ? overlay.values : {}
  const optimistic =
    state && Object.keys(values).length
      ? { ...state, overrides: { ...state.overrides, ...values }, revision: state.revision + 1 }
      : state
  return {
    state: optimistic ?? null,
    change,
    command,
    flush,
    error: failure?.scope === scopeKey ? failure.message : "",
    unsaved: !!Object.keys(values).length
  }
}
