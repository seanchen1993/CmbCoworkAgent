import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import type {
  PlatformSurfaceAddress,
  PlatformSurfaceCatalog,
  PlatformSurfaceEntry,
  PlatformSurfaceFrame
} from "../../../../shared/mods/v2/platform-surfaces"
import type {
  PlatformBehaviorCatalog,
  PlatformBehaviorPreview
} from "../../../../shared/mods/v2/platform-behaviors"
import type { FunctionUiAction, FunctionUiElement } from "../../../../shared/mods/v2/ui"
import { validateFunctionTree } from "../../../../shared/mods/v2/ui"
import type { ModJson } from "../../../../shared/mods/types"
import { Element } from "../chat/FunctionPanes"
import { windowPresentation } from "../../lib/window-presentation"
import { functionSiteErrorCode } from "../../lib/function-site-recovery"
import type { PlatformUiApi } from "../../../../shared/mods/v2/platform-ui-api"

export type PlatformWorkspaceApi = PlatformUiApi
interface OpenFrame {
  openId: string
  threadId: string
  address: PlatformSurfaceAddress
  value: PlatformSurfaceFrame
  rail: boolean
}

interface FrameRead {
  frame: OpenFrame
  epoch: number
  running: boolean
  dirty: boolean
  staleRetries: number
  interactive: boolean
  promise: Promise<void>
}

class SurfaceBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Independent overlay: the parent keeps its original chat tree mounted throughout page use. */
export function PlatformWorkspace({
  threadId,
  active: requestedActive,
  api: supplied
}: {
  threadId: string
  active: boolean
  api?: PlatformWorkspaceApi
}): React.JSX.Element | null {
  const [presentable, setPresentable] = useState(() =>
    windowPresentation.isPresentable(document.visibilityState !== "hidden")
  )
  useEffect(() => {
    if (!requestedActive) return
    const changed = () =>
      setPresentable(windowPresentation.isPresentable(document.visibilityState !== "hidden"))
    const stop = windowPresentation.subscribe(changed)
    document.addEventListener("visibilitychange", changed)
    changed()
    return () => {
      stop()
      document.removeEventListener("visibilitychange", changed)
    }
  }, [requestedActive])
  const active = requestedActive && presentable
  const api = supplied ?? (window.api.mods as unknown as PlatformWorkspaceApi)
  const scope = useRef({ threadId, active, epoch: 0 })
  if (scope.current.threadId !== threadId || scope.current.active !== active)
    scope.current = { threadId, active, epoch: scope.current.epoch + 1 }
  const epoch = scope.current.epoch
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const current = useCallback(
    () =>
      mounted.current &&
      scope.current.threadId === threadId &&
      scope.current.active &&
      scope.current.epoch === epoch,
    [threadId, epoch]
  )
  const [catalog, setCatalog] = useState<{ threadId: string; value: PlatformSurfaceCatalog }>()
  const [behaviors, setBehaviors] = useState<{ threadId: string; value: PlatformBehaviorCatalog }>()
  const [frame, setFrame] = useState<OpenFrame>()
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState<FrameRead>()
  const actionPending = useRef(new Set<string>())
  const [error, setError] = useState("")
  const [showBehaviors, setShowBehaviors] = useState(false)
  const [cleanup, setCleanup] = useState<{ threadId: string; address: PlatformSurfaceAddress }>()
  const request = useRef(0)
  const invalidateRequests = useCallback(() => {
    request.current++
  }, [])
  const frameRef = useRef(frame)
  frameRef.current = frame
  const frameRead = useRef<FrameRead | undefined>(undefined)
  const retirements = useRef(new Map<string, Promise<void>>())
  const retireFrame = useCallback(
    (previous: OpenFrame): Promise<void> => {
      if (
        frameRef.current?.openId === previous.openId &&
        frameRef.current.threadId === previous.threadId
      )
        frameRef.current = undefined
      const key = JSON.stringify([previous.threadId, previous.openId])
      const existing = retirements.current.get(key)
      if (existing) return existing
      const closing = api.platformSurfaceClose(previous.threadId, previous.address).catch(() => {
        setCleanup({ threadId: previous.threadId, address: previous.address })
        if (scope.current.threadId === previous.threadId)
          setError("页面清理尚未确认，可停用页面后核对状态")
        console.warn("[PlatformSurface] Page cleanup unconfirmed", {
          threadId: previous.threadId,
          surface: previous.address.key
        })
      })
      if (retirements.current.size >= 64)
        retirements.current.delete(retirements.current.keys().next().value!)
      retirements.current.set(key, closing)
      return closing
    },
    [api]
  )
  useEffect(
    () => () => {
      const previous = frameRef.current
      if (previous?.threadId === threadId) void retireFrame(previous)
    },
    [threadId, requestedActive, retireFrame]
  )
  useEffect(() => {
    setBusy(false)
    setError("")
    setFrame(undefined)
    setShowBehaviors(false)
  }, [threadId, requestedActive])
  useEffect(() => {
    if (active) setBusy(false)
  }, [active])
  const refreshFrame = useRef<() => Promise<void>>(async () => {})
  const refresh = useCallback(async () => {
    const ticket = ++request.current
    try {
      const [surfaces, behavior] = await Promise.all([
        api.platformSurfaceList(threadId),
        api.platformBehaviorList(threadId)
      ])
      if (!current() || ticket !== request.current) return
      setCatalog({ threadId, value: surfaces })
      setBehaviors({ threadId, value: behavior })
      setError("")
      await refreshFrame.current()
    } catch {
      if (current() && ticket === request.current) setError("扩展暂时不可用，聊天仍可继续")
    }
  }, [api, threadId, current])
  useEffect(() => {
    if (!active) return
    let running = false,
      dirty = false,
      live = true
    const schedule = () => {
      dirty = true
      if (running) return
      running = true
      void (async () => {
        try {
          while (dirty && live) {
            dirty = false
            await refresh()
          }
        } finally {
          running = false
        }
      })()
    }
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && (event.scope === "panes" || event.scope === undefined))
        schedule()
    })
    const platformStop = window.api.mods.onPlatformChanged?.((event) => {
      if (event.threadId === threadId) schedule()
    })
    const configuration = window.api.mods.onConfigurationChanged(schedule)
    window.addEventListener("mods:configuration-changed", schedule)
    schedule()
    return () => {
      live = false
      invalidateRequests()
      stop()
      platformStop?.()
      configuration()
      window.removeEventListener("mods:configuration-changed", schedule)
    }
  }, [active, threadId, refresh, invalidateRequests])
  const rows = catalog?.threadId === threadId ? catalog.value : undefined
  const policy = behaviors?.threadId === threadId ? behaviors.value : undefined
  const shown = active && frame?.threadId === threadId ? frame : undefined
  refreshFrame.current = () => {
    const opened = frameRef.current
    if (
      !opened ||
      opened.threadId !== threadId ||
      !current() ||
      retirements.current.has(JSON.stringify([opened.threadId, opened.openId]))
    )
      return Promise.resolve()
    let job = frameRead.current
    if (
      !job ||
      job.frame.openId !== opened.openId ||
      job.frame.address !== opened.address ||
      job.epoch !== epoch
    ) {
      job = {
        frame: opened,
        epoch,
        running: false,
        dirty: false,
        staleRetries: 0,
        interactive: true,
        promise: Promise.resolve()
      }
      frameRead.current = job
    }
    job.dirty = true
    const actionKey = JSON.stringify([threadId, epoch, opened.openId])
    if (actionPending.current.has(actionKey)) return Promise.resolve()
    if (job.running) return job.promise
    const pending = job
    const owns = () =>
      current() &&
      frameRead.current === pending &&
      frameRef.current?.openId === opened.openId &&
      frameRef.current.address === opened.address &&
      !retirements.current.has(JSON.stringify([opened.threadId, opened.openId]))
    pending.running = true
    pending.promise = (async () => {
      // Leave React effects before synchronously publishing the interaction barrier.
      await Promise.resolve()
      if (!owns() || actionPending.current.has(actionKey)) return
      // The old controls must actually be disabled before native commit can retire them.
      pending.interactive = false
      flushSync(() => setReading(pending))
      // One active read and one dirty bit coalesce notifications and action-result reads.
      while (pending.dirty && owns()) {
        pending.dirty = false
        pending.interactive = false
        try {
          const value = await api.platformSurfaceRead(threadId, opened.address)
          if (!owns()) return
          if (value.openId !== opened.value.openId) throw new Error("MODS_PLATFORM_SURFACE_STALE")
          pending.staleRetries = 0
          pending.interactive = true
          setError((before) =>
            before === "页面更新尚未完成，请稍后核对；没有自动重试操作" ? "" : before
          )
          flushSync(() => {
            setFrame((before) =>
              owns() && before?.openId === opened.openId && before.address === opened.address
                ? { ...before, value }
                : before
            )
          })
        } catch (cause) {
          if (!owns()) return
          if (functionSiteErrorCode(cause) === "MODS_UI_DRAWING_STALE") {
            // Notifications cannot replenish autonomous retry credit; a valid frame can.
            if (pending.staleRetries < 2) {
              pending.staleRetries++
              pending.dirty = true
            }
          } else {
            void retireFrame(opened)
            setFrame((before) => (before?.openId === opened.openId ? undefined : before))
            setError("页面授权或版本已变化，已返回聊天")
            return
          }
        }
      }
    })().finally(() => {
      if (frameRead.current === pending) pending.running = false
      if (mounted.current && (pending.interactive || !owns()))
        flushSync(() => setReading((before) => (before === pending ? undefined : before)))
      else if (owns()) setError("页面更新尚未完成，请稍后核对；没有自动重试操作")
    })
    return pending.promise
  }
  const closePage = useCallback(() => {
    if (shown) void retireFrame(shown)
    setFrame(undefined)
    setShowBehaviors(false)
  }, [shown, retireFrame])
  useEffect(() => {
    if (active) return
    const previous = frameRef.current
    if (!previous) return
    setFrame(undefined)
    void retireFrame(previous)
  }, [active, retireFrame])
  useEffect(() => {
    if (!shown && !showBehaviors) return
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closePage()
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [shown, showBehaviors, closePage])
  const open = async (entry: PlatformSurfaceEntry) => {
    if (!rows || busy || !current()) return
    if (shown?.address.key === entry.key) {
      await refreshFrame.current()
      return
    }
    setBusy(true)
    setError("")
    const address = { key: entry.key, revision: rows.revision }
    const openId = crypto.randomUUID()
    try {
      if (shown && shown.address.key !== entry.key) {
        await retireFrame(shown)
        if (!current()) return
        setFrame(undefined)
      }
      const value = await api.platformSurfaceOpen(threadId, address, openId)
      const ownedAddress = { ...address, openId: value.openId }
      if (!current()) {
        void retireFrame({
          openId,
          threadId,
          address: ownedAddress,
          value,
          rail: entry.placement === "sidebar"
        })
        return
      }
      setFrame({
        openId,
        threadId,
        address: ownedAddress,
        value,
        rail: entry.placement === "sidebar"
      })
      setShowBehaviors(false)
    } catch {
      if (current()) {
        setCleanup({ threadId, address })
        setError("页面未打开，请核对授权与运行状态")
      }
    } finally {
      if (current()) setBusy(false)
    }
  }
  const disable = async () => {
    if (!shown || busy || !current()) return
    setBusy(true)
    try {
      await api.platformSurfaceDisable(threadId, shown.address)
      if (current() && frameRef.current?.openId === shown.openId) {
        setFrame((before) => (before?.openId === shown.openId ? undefined : before))
        await refresh()
      }
    } catch {
      if (current() && frameRef.current?.openId === shown.openId)
        setError("停用未完成，请到灵件设置核对授权")
    } finally {
      if (current()) setBusy(false)
    }
  }
  const act = async (
    node: FunctionUiElement | undefined,
    kind: FunctionUiAction["kind"],
    value?: ModJson
  ) => {
    if (!shown?.value.pane || busy || !current()) return
    const actionKey = JSON.stringify([threadId, epoch, shown.openId])
    if (actionPending.current.has(actionKey)) return
    const pane = shown.value.pane
    const read = frameRead.current
    if (read?.frame.openId === shown.openId && (read.running || !read.interactive)) return
    if (!node || node.type === "engine" || node.type === "fragment" || !node.press) return
    actionPending.current.add(actionKey)
    setBusy(true)
    let succeeded = false
    try {
      await api.platformSurfaceAct(threadId, shown.address, {
        pane: pane.key,
        generation: pane.generation,
        intentId: crypto.randomUUID(),
        plugin: node.press.plugin,
        handle: node.press.handle,
        kind,
        ...(value === undefined ? {} : { value })
      })
      succeeded = true
    } catch {
      if (current()) setError("操作未完成，请核对结果；没有自动重试")
    } finally {
      actionPending.current.delete(actionKey)
      if (current()) {
        if (!frameRef.current || frameRef.current.openId === shown.openId) setBusy(false)
        if (frameRef.current?.openId === shown.openId && (succeeded || frameRead.current?.dirty))
          await refreshFrame.current()
      }
    }
  }
  if (!active || (!rows?.entries.length && !policy?.bindings.length && !error)) return null
  const button = (entry: PlatformSurfaceEntry) => (
    <span key={entry.key} className="inline-flex shrink-0 items-center">
      <button
        key={entry.key}
        disabled={busy || !entry.enabled}
        title={entry.description}
        className="rounded px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
        onClick={() => void open(entry)}
      >
        {entry.title}
      </button>
      {!entry.enabled && rows && (
        <button
          className="rounded border px-2 py-1 text-xs"
          onClick={() => {
            void api
              .platformSurfaceEnable(threadId, { key: entry.key, revision: rows.revision })
              .then(refresh, () => {
                if (current()) setError("页面尚不能恢复，请核对授权及清理状态")
              })
          }}
        >
          恢复
        </button>
      )}
    </span>
  )
  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-platform-workspace={threadId}>
      <nav
        aria-label="扩展工作区"
        className="pointer-events-auto absolute left-2 right-2 top-1 flex items-center gap-1 overflow-x-auto whitespace-nowrap rounded border bg-background/95 p-1 shadow-sm"
      >
        {rows?.entries
          .filter((entry) =>
            ["page", "navigation", "toolbar", "settings"].includes(entry.placement)
          )
          .map(button)}
        {Boolean(policy?.bindings.length) && (
          <button
            className="rounded px-2 py-1 text-sm hover:bg-muted"
            onClick={() => {
              closePage()
              setShowBehaviors(true)
            }}
          >
            行为设置
          </button>
        )}
        {(shown || showBehaviors) && (
          <button className="ml-auto rounded border px-2 py-1 text-sm" onClick={closePage}>
            返回聊天
          </button>
        )}
      </nav>
      {rows?.entries.some((entry) => entry.placement === "sidebar") && (
        <aside
          aria-label="扩展侧栏"
          className="pointer-events-auto absolute right-2 top-12 flex max-h-32 max-w-40 flex-col items-start gap-1 overflow-auto rounded border bg-background p-2 shadow"
        >
          {rows.entries.filter((entry) => entry.placement === "sidebar").map(button)}
        </aside>
      )}
      {error && (
        <div
          role="alert"
          className="pointer-events-auto absolute left-2 top-12 flex gap-2 rounded border bg-background p-2 text-sm"
        >
          {error}
          {reading &&
            reading.frame.openId === shown?.openId &&
            !reading.running &&
            !reading.interactive && (
              <button onClick={() => void refreshFrame.current()}>重新读取页面</button>
            )}
          {cleanup?.threadId === threadId && (
            <button
              onClick={() => {
                void api.platformSurfaceDisable(threadId, cleanup.address).then(
                  () => {
                    if (current()) {
                      setCleanup(undefined)
                      setError("")
                      void refresh()
                    }
                  },
                  () => {
                    if (current()) setError("清理仍未确认，请保留任务记录并到灵件设置停用")
                  }
                )
              }}
            >
              停用页面并核对清理
            </button>
          )}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {(shown || showBehaviors) && (
        <section
          role="region"
          aria-label={shown?.value.entry.title ?? "行为设置"}
          className={`pointer-events-auto absolute bottom-0 top-11 overflow-y-auto border bg-background p-5 ${shown?.rail ? "right-0 w-96 max-w-full" : "inset-x-0"}`}
        >
          {showBehaviors && policy ? (
            <PlatformBehaviorSettings
              key={threadId}
              api={api}
              threadId={threadId}
              catalog={policy}
              refresh={refresh}
              current={current}
            />
          ) : (
            shown && (
              <>
                <header className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="break-words text-xl font-semibold">{shown.value.entry.title}</h2>
                    <p className="text-sm text-muted-foreground">
                      {shown.value.entry.ref.provider}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={closePage} className="rounded border px-3 py-1">
                      关闭
                    </button>
                    <button onClick={() => void disable()} className="rounded border px-3 py-1">
                      停用此页面
                    </button>
                  </div>
                </header>
                <SurfaceBoundary
                  key={`${shown.address.key}:${shown.value.openId}`}
                  fallback={<p role="alert">此页面显示失败，可关闭或停用后继续聊天。</p>}
                >
                  <PlatformDrawing
                    frame={shown.value}
                    busy={busy || reading?.frame.openId === shown.openId}
                    keepFormDraftEditable={!busy && reading?.frame.openId === shown.openId}
                    act={act}
                  />
                </SurfaceBoundary>
              </>
            )
          )}
        </section>
      )}
    </div>
  )
}

function PlatformDrawing({
  frame,
  busy,
  keepFormDraftEditable,
  act
}: {
  frame: PlatformSurfaceFrame
  busy: boolean
  keepFormDraftEditable: boolean
  act(
    node: FunctionUiElement | undefined,
    kind: FunctionUiAction["kind"],
    value?: ModJson
  ): Promise<void>
}) {
  if (!frame.pane) return <p>页面尚无内容，请核对灵件的绘制处理程序。</p>
  validateFunctionTree(frame.pane.tree)
  return (
    <Element
      node={frame.pane.tree}
      busy={busy}
      act={act}
      keepFormDraftEditable={keepFormDraftEditable}
    />
  )
}

function PlatformBehaviorSettings({
  api,
  threadId,
  catalog,
  refresh,
  current
}: {
  api: PlatformWorkspaceApi
  threadId: string
  catalog: PlatformBehaviorCatalog
  refresh(): Promise<void>
  current(): boolean
}) {
  const [selected, setSelected] = useState(catalog.active),
    [preview, setPreview] = useState<PlatformBehaviorPreview>()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const run = async (work: () => Promise<unknown>) => {
    if (busy || !current()) return
    setBusy(true)
    setError("")
    try {
      await work()
      if (current()) await refresh()
    } catch {
      if (current()) setError("配置已变化或操作未完成，请重新预览")
    } finally {
      if (current()) setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">业务行为设置</h2>
      <p className="text-sm text-muted-foreground">
        当前接通输入建议与通知呈现。预览不会执行灵件；明确应用后才参与真实处理。
      </p>
      {catalog.bindings.map((binding) => (
        <label key={binding.key} className="flex items-start gap-2 rounded border p-3">
          <input
            type="checkbox"
            disabled={busy || !binding.available}
            checked={selected.includes(binding.key)}
            onChange={(event) => {
              setSelected((values) =>
                event.target.checked
                  ? [...values, binding.key]
                  : values.filter((key) => key !== binding.key)
              )
              setPreview(undefined)
            }}
          />
          <span>
            {binding.title}
            <small className="block text-muted-foreground">
              {binding.point} · {binding.phase} · {binding.key}
            </small>
          </span>
        </label>
      ))}
      <div className="flex gap-2">
        <button
          disabled={busy}
          className="rounded border px-3 py-2"
          onClick={() =>
            void run(async () => {
              const value = await api.platformBehaviorPreview(threadId, selected)
              if (current()) setPreview(value)
            })
          }
        >
          预览顺序与影响
        </button>
        <button
          disabled={busy}
          className="rounded border px-3 py-2"
          onClick={() => void run(() => api.platformBehaviorDisable(threadId))}
        >
          停用全部并恢复原实现
        </button>
      </div>
      {preview && (
        <div className="space-y-2 rounded border p-3">
          <p>执行顺序：{preview.order.join(" → ") || "原实现"}</p>
          {[...preview.conflicts, ...preview.missing].map((message, i) => (
            <p role="alert" key={i}>
              {message}
            </p>
          ))}
          <button
            disabled={busy || !preview.canApply || preview.revision !== catalog.revision}
            className="rounded border px-3 py-2"
            onClick={() =>
              void run(async () => {
                await api.platformBehaviorApply(threadId, preview.previewId, preview.revision)
                if (current()) setPreview(undefined)
              })
            }
          >
            确认应用
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
