import { useEffect, useMemo, useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import type { PlatformSurfaceCatalog } from "../../../../shared/mods/v2/platform-surfaces"
import {
  assertSurfaceDevelopmentCurrent,
  captureSurfaceNavigationScope,
  exactSurfaceEntries,
  requestPlatformSurface,
  surfaceNavigationScopeCurrent
} from "../../lib/platform-surface-intent"

/** Existing, already approved source only. Discovery never activates or authorizes it. */
export function PluginSurfaceEntries(props: {
  threadId: string
  expectedWorkspace: string
  compiledDigest: string
  provider?: string
  developmentComponentId?: string
  disabled?: boolean
  isCurrent?: () => boolean
  onNavigate?: () => void
}) {
  const account = useAppStore((state) => state.accountRevision)
  const scope = useMemo(
    () => captureSurfaceNavigationScope(props.threadId, props.expectedWorkspace),
    [props.threadId, props.expectedWorkspace, account]
  )
  const latest = useRef(props)
  latest.current = props
  const generation = useRef(0)
  const mounted = useRef(false)
  const [catalog, setCatalog] = useState<PlatformSurfaceCatalog>()
  const [error, setError] = useState("")
  const [checking, setChecking] = useState(false)
  const [acting, setActing] = useState(false)
  const interactivePending = useRef(false)
  const busy = checking || acting
  const current = () =>
    !!scope &&
    mounted.current &&
    surfaceNavigationScopeCurrent(scope) &&
    latest.current.compiledDigest === props.compiledDigest &&
    latest.current.developmentComponentId === props.developmentComponentId &&
    latest.current.provider === props.provider &&
    (latest.current.isCurrent?.() ?? true)
  const load = async (prepare: boolean) => {
    if (!current()) return
    if (prepare) {
      if (interactivePending.current || latest.current.disabled) return
      interactivePending.current = true
      setActing(true)
    }
    const token = ++generation.current
    setError("")
    setChecking(true)
    try {
      if (props.developmentComponentId)
        await assertSurfaceDevelopmentCurrent(
          scope!,
          props.developmentComponentId,
          props.compiledDigest
        )
      if (!current() || token !== generation.current) return
      let value = await window.api.mods.platformSurfaceList(props.threadId)
      if (!current() || token !== generation.current) return
      if (prepare && value.canPrepare && !exactSurfaceEntries(value, props).length) {
        if (latest.current.disabled) return
        await window.api.mods.platformSurfacePrepare?.(props.threadId)
        if (!current() || token !== generation.current) return
        value = await window.api.mods.platformSurfaceList(props.threadId)
      }
      if (!current() || token !== generation.current) return
      exactSurfaceEntries(value, props)
      setCatalog(value)
    } catch (cause) {
      if (current() && token === generation.current) {
        setCatalog(undefined)
        setError(cause instanceof Error ? cause.message : "界面入口暂时不可用，请重新核对。")
      }
    } finally {
      if (mounted.current && token === generation.current) setChecking(false)
      if (prepare) {
        interactivePending.current = false
        if (mounted.current) setActing(false)
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    setCatalog(undefined)
    void load(false)
    const changed = () => {
      setCatalog(undefined)
      void load(false)
    }
    const stop = window.api.mods.onConfigurationChanged?.(changed)
    const stopPlatform = window.api.mods.onPlatformChanged?.((event) => {
      if (event.threadId === props.threadId) changed()
    })
    const stopTrial = props.developmentComponentId
      ? window.api.mods.development.onChanged?.((event) => {
          if (event.threadId === props.threadId) changed()
        })
      : undefined
    return () => {
      mounted.current = false
      generation.current++
      stop?.()
      stopPlatform?.()
      stopTrial?.()
    }
  }, [scope, props.provider, props.compiledDigest, props.developmentComponentId])
  let entries: ReturnType<typeof exactSurfaceEntries> = []
  try {
    if (catalog) entries = exactSurfaceEntries(catalog, props)
  } catch {
    /* load reports ambiguity */
  }
  const open = async (entryKey: string) => {
    if (interactivePending.current || latest.current.disabled || !current()) return
    interactivePending.current = true
    setActing(true)
    setError("")
    try {
      const revision = props.developmentComponentId
        ? await assertSurfaceDevelopmentCurrent(
            scope!,
            props.developmentComponentId,
            props.compiledDigest
          )
        : undefined
      const fresh = await window.api.mods.platformSurfaceList(props.threadId)
      if (!current() || latest.current.disabled) return
      const entry = exactSurfaceEntries(fresh, props).find((row) => row.key === entryKey)
      if (!entry) throw Error("插件界面或许可已变化，请重新核对。")
      requestPlatformSurface({
        ...scope!,
        provider: entry.ref.provider,
        compiledDigest: props.compiledDigest,
        surfaceId: entry.id,
        entryKey: entry.key,
        ...(props.developmentComponentId
          ? { developmentComponentId: props.developmentComponentId, developmentRevision: revision }
          : {})
      })
      latest.current.onNavigate?.()
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "无法打开插件界面。")
    } finally {
      interactivePending.current = false
      if (mounted.current) setActing(false)
    }
  }
  return (
    <section aria-label="插件界面入口" className="space-y-2 rounded border p-3 text-sm">
      <p className="font-medium">此插件提供的界面</p>
      {entries.map((entry) => (
        <button
          key={entry.key}
          disabled={busy || props.disabled}
          className="mr-2 rounded border px-3 py-1"
          onClick={() => void open(entry.key)}
        >
          打开{entry.title}
        </button>
      ))}
      {catalog?.canPrepare && (
        <button
          disabled={busy || props.disabled}
          className="rounded border px-3 py-1"
          onClick={() => void load(true)}
        >
          查找插件界面
        </button>
      )}
      {!busy && catalog && !catalog.canPrepare && !entries.length && (
        <p>此版本没有独立界面，可按上方使用方式在聊天中触发命令或规则。</p>
      )}
      {!!catalog?.errors.length && <p role="alert">{catalog.errors.join("；")}</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={() => void load(false)}>重新核对</button>
        </p>
      )}
      {busy && <p role="status">正在核对界面入口…</p>}
    </section>
  )
}
