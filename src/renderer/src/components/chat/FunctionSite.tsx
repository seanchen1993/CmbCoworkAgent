import { useModsChatScope, useModsChatReady, useModsChatLoadError, useModsChatCurrent,
  useModsChatPresentationCache } from "../../lib/mods-chat-scope"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import type { ModJson, ModObject } from "../../../../shared/mods/types"
import { isModSiteChangeScope } from "../../../../shared/mods/types"
import {
  functionQuestionPresentation,
  functionSiteDefault,
  validateFunctionSiteTree,
  type FunctionUiSite
} from "../../../../shared/mods/v2/sites"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionUiElement
} from "../../../../shared/mods/v2/ui"
import { pressFunctionHotkey } from "../../lib/function-ui-hotkey"
import { openClawRecovery } from "../../lib/claw-sidebar"
import { Element } from "./FunctionPanes"
import { FunctionClient } from "./FunctionClient"
import { paneFocusElement } from "../../lib/function-pane-focus"
import { functionFocusTargets } from "../../../../shared/mods/v2/focus"
import { FunctionSiteLifetime, type FunctionSiteTicket } from "../../lib/function-site-lifecycle"
import { functionSiteQueue } from "../../lib/function-site-queue"
import { isFunctionSiteInViewport } from "../../lib/function-site-visibility"
import { retainsFunctionSitePresentation } from "../../lib/function-site-transition"
import { FunctionSiteRecovery, functionSiteErrorCode,
  isTransientFunctionSiteError } from "../../lib/function-site-recovery"
import { validateFunctionNativeContent } from "../../../../shared/mods/v2/engine"
import { functionInlineLabel, functionInlineTree, functionNativeHint,
  functionNativeProps } from "../../lib/function-native-content"
import { functionSitePresentationKey } from "../../lib/function-site-presentation"

const DEFAULT_SITE_CLASS_NAME =
  "mx-auto w-full max-w-3xl overflow-auto text-xs text-muted-foreground"

/** Neutral geometry only: never render or measure the unverified native fallback. */
function FunctionSitePending({ component, slow = false }: {
  component: FunctionUiSite
  slow?: boolean
}): React.JSX.Element | null {
  const message = ["UserMessage", "AssistantMessage", "CommandOutput"].includes(component)
  // Optional decorations should not introduce bars or layout rows while they are unknown.
  if (!message && !slow) return null
  return (
    <div data-function-site-pending className={message
      ? `space-y-2 py-1${component === "UserMessage" ? " w-40 max-w-full" : ""}` : undefined}
      aria-label="正在读取内容">
      {message && <div aria-hidden="true" className="space-y-2">
        <div className="h-3 w-3/4 rounded bg-muted" />
        <div className="h-3 w-1/2 rounded bg-muted" />
      </div>}
      {slow && <p role="status" aria-live="polite" className="mt-2">内容加载较慢，请稍候…</p>}
    </div>
  )
}

type Act = (
  node: FunctionUiElement | undefined,
  kind: FunctionUiAction["kind"],
  value?: ModJson
) => Promise<void>

export function FunctionSiteContent({
  snapshot,
  fallback,
  busy,
  act,
  threadId,
  refresh,
  renderNative,
  inactive = false,
  component,
  expectedRequestId,
  owner,
  isCurrent
}: {
  snapshot: FunctionPaneSnapshot | null
  fallback: ReactNode
  busy: boolean
  act: Act
  threadId?: string
  refresh?(): void
  renderNative?(props: ModObject): ReactNode
  inactive?: boolean
  component?: FunctionUiSite
  expectedRequestId?: string
  owner?: string
  isCurrent?(): boolean
}): ReactNode {
  if (!snapshot) return inactive ? fallback : null
  validateFunctionSiteTree(snapshot.tree)
  const native = snapshot.nativeContent
  if (native) {
    try { validateFunctionNativeContent(native, component, expectedRequestId) }
    catch { return null }
  }
  if (native && ((component && native.component !== component) ||
    (expectedRequestId && native.requestId !== expectedRequestId))) return null
  const renderEngine = (ref: number): ReactNode => {
    if (!native) return null
    const entry = native.entries.find((item) => item.ref === ref) ??
      native.entries.find((item) => item.ref === 0)
    if (!entry) return null
    if (renderNative) return renderNative(entry.props)
    if (native.nativeUnchanged) return fallback
    if (native.component === "Pane") return null
    return <Element node={functionSiteDefault(native.component, entry.props)} busy={false}
      act={async () => {}} />
  }
  return <Element node={snapshot.tree} busy={busy} act={act} renderEngine={renderEngine}
    markdown={threadId && owner ? { threadId, address: { kind: "site", owner,
      pane: snapshot.key, generation: snapshot.generation }, links: snapshot.markdownLinks ?? [],
      refresh, isCurrent } : undefined} renderClient={(node) => {
    const client = snapshot.clients?.find((c) =>
      c.plugin === node.client?.plugin && c.element === node.props.key)
    return client && threadId ? <FunctionClient key={client.id} threadId={threadId}
      pane={snapshot.key} node={node} snapshot={client} refresh={() => refresh?.()}
      isCurrent={isCurrent}
      render={(tree, pending, clientAct, markdown) => <Element node={tree} busy={busy || pending}
        act={clientAct} markdown={markdown} retainFocusWhileBusy />} /> : null
  }} />
}

/** A mounted desktop slot. The main process issues its drawing owner token. */
export function FunctionSite(props: Parameters<typeof FunctionSiteSurface>[0]): React.JSX.Element {
  const enabled = useModsChatScope(props.threadId)
  const ready = useModsChatReady(props.threadId)
  const loadError = useModsChatLoadError(props.threadId)
  const isCurrent = useModsChatCurrent(props.threadId)
  const blockRevokedInteraction = (event: SyntheticEvent) => {
    if (isCurrent()) return
    event.preventDefault()
    event.stopPropagation()
  }
  return !ready ? <section data-function-site={props.component} aria-busy={!loadError || undefined}
    className={props.className ?? DEFAULT_SITE_CLASS_NAME}>
      {loadError ? <p role="alert" className="text-destructive">
        {loadError.error}
        {loadError.retry && <button type="button" className="ml-2 underline"
          onClick={loadError.retry}>重试读取</button>}
      </p> : <FunctionSitePending component={props.component} />}
    </section> : enabled ? (
    <FunctionSiteSurface key={JSON.stringify([props.threadId, props.component,
      props.messageId, props.expectedRequestId, props.presentationId])} {...props} />
  ) : (
    <section
      data-function-site={props.component}
      className={props.className ?? DEFAULT_SITE_CLASS_NAME}
      style={props.component === "AbovePrompt" ? { maxHeight: 192 } : undefined}
      onClickCapture={blockRevokedInteraction}
      onKeyDownCapture={blockRevokedInteraction}
      onSubmitCapture={blockRevokedInteraction}
    >
      {props.fallback}
    </section>
  )
}

function FunctionSiteSurface({
  threadId,
  component,
  messageId,
  presentationId,
  expectedRequestId,
  facts,
  fallback,
  renderNative,
  onHint,
  onCustom,
  onExpansion,
  onQuestions,
  onModeLabel,
  className
}: {
  threadId: string
  component: FunctionUiSite
  messageId?: string
  /** Stable renderer row identity; never submitted as a host message authority. */
  presentationId?: string
  expectedRequestId?: string
  facts: ModObject
  fallback?: ReactNode
  renderNative?(props: ModObject): ReactNode
  onHint?(text: string | null): void
  onCustom?(custom: boolean): void
  onExpansion?(expanded: boolean): void
  onQuestions?(questions: FunctionPaneSnapshot["nativeQuestions"] | null): void
  onModeLabel?(label: ReactNode): void
  className?: string
}): React.JSX.Element {
  const [frame, setFrame] = useState<{
    snapshot: FunctionPaneSnapshot
    ticket: FunctionSiteTicket
    inputKey: string
    inputRevision: number
    owner: string
    presentationCurrent?: () => boolean
  } | null>(null)
  const [inactive, setInactive] = useState<{ ticket: FunctionSiteTicket; inputKey: string; inputRevision: number } | null>(null)
  const [error, setError] = useState("")
  const [failureCode, setFailureCode] = useState("")
  const [reading, setReading] = useState(false)
  const [showReading, setShowReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [geometry, setGeometry] = useState({ bodyColumns: 80, maxRows: 8, offset: 0 })
  const section = useRef<HTMLElement>(null)
  const presentationCache = useModsChatPresentationCache(threadId)
  const ownerRef = useRef<string | null>(null)
  const redrawPresentation = useRef<{
    frame: NonNullable<typeof frame>; revision: number; inputKey: string
  } | null>(null)
  const input = component === "AbovePrompt" ? { ...facts, ...geometry } : facts
  const inputKey = JSON.stringify(input)
  const presentationKey = functionSitePresentationKey(threadId, component,
    presentationId ?? messageId, inputKey, typeof window === "undefined" ? 0 : window.innerWidth)
  const presentationIdentity = presentationId ?? messageId
  const presentationRow = presentationIdentity
    ? JSON.stringify([component, presentationIdentity]) : undefined
  const presentationKeyRef = useRef(presentationKey)
  presentationKeyRef.current = presentationKey
  const presentationInput = useRef({ inputKey, key: presentationKey })
  if (presentationInput.current.inputKey !== inputKey) {
    // A -> B -> A must not resurrect A's cached data before its new protected read.
    // Revoke synchronously without notifying other React components during render.
    presentationCache?.invalidateKey(presentationInput.current.key, false, presentationRow)
  }
  presentationInput.current = { inputKey, key: presentationKey }
  const cachedPresentation = presentationCache?.read(presentationKey) ?? null
  const [, setPresentationRevision] = useState(0)
  const cachedSection = useRef<HTMLDivElement>(null)
  const [cachedGeometry, setCachedGeometry] = useState<{ presentation: object; width: number } | null>(null)
  // A pending first read may finish for an earlier assistant prefix. Any intervening
  // replacement (including A -> B -> A) irreversibly ends that prefix lineage.
  const prefixLineage = useRef({ key: inputKey, epoch: 0 })
  if (prefixLineage.current.key !== inputKey) {
    const append = component === "AssistantMessage" &&
      retainsFunctionSitePresentation(component, prefixLineage.current.key, input)
    prefixLineage.current = { key: inputKey, epoch: prefixLineage.current.epoch + (append ? 0 : 1) }
  }
  const pendingPrefix = useRef<{ key: string; epoch: number } | null>(null)
  const rendererRef = useRef(renderNative)
  rendererRef.current = renderNative
  // A -> B -> A still needs a fresh protected read; equal facts do not revive old callbacks.
  const inputVersion = useRef({ key: inputKey, revision: 0 })
  if (inputVersion.current.key !== inputKey) {
    inputVersion.current = { key: inputKey, revision: inputVersion.current.revision + 1 }
    // A facts change ends the redraw-only exemption. Ordinary progress must independently
    // satisfy its own narrow rule; returning to an older input never restores its revision.
    redrawPresentation.current = null
  }
  const inputRevision = inputVersion.current.revision
  const lastInputRevision = useRef(inputRevision)
  const frameRef = useRef(frame)
  frameRef.current = frame
  const [, setRedrawRevision] = useState(0)
  const nativePresentation = useRef<{
    frame: NonNullable<typeof frame>
    renderNative: typeof renderNative
  } | null>(null)
  // A nativeUnchanged delegate without renderNative would otherwise use the caller's
  // latest raw fallback. Retained presentations may only render captured protected props.
  const canRetain = Boolean(renderNative || fallback === undefined)
  const canRetainRef = useRef(canRetain)
  canRetainRef.current = canRetain
  const snapshot = frame?.ticket.current() && frame.owner === ownerRef.current &&
    (frame.inputRevision === inputRevision || (canRetain &&
      (!renderNative || nativePresentation.current?.frame === frame) &&
      (redrawPresentation.current?.frame === frame
        ? redrawPresentation.current.revision === inputRevision && redrawPresentation.current.inputKey === inputKey
        : retainsFunctionSitePresentation(component, frame.inputKey, input))))
    ? frame.snapshot : null
  // Keep the renderer actually committed with this protected frame, including local expansion
  // state. During a progress read, a new caller closure can contain unprotected input/results.
  useLayoutEffect(() => {
    if (snapshot && frame && frame.ticket.current() && frame.inputRevision === inputRevision)
      nativePresentation.current = { frame, renderNative }
  }, [snapshot, frame, inputRevision, renderNative])
  const presentationRenderer = frame?.inputRevision === inputRevision ? renderNative :
    nativePresentation.current?.frame === frame ? nativePresentation.current.renderNative : undefined
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const inputRef = useRef(input)
  inputRef.current = input
  const refreshRef = useRef<() => void>(() => {})
  const inputRefreshRef = useRef<() => void>(() => {})
  const retryRef = useRef<() => void>(() => {})
  const live = useRef(false)
  const lifetimeRef = useRef<FunctionSiteLifetime | null>(null)
  const applyingFocus = useRef(false)
  const pending = useRef(0)
  useLayoutEffect(() => {
    if (snapshot || !presentationCache || !cachedPresentation) return
    const changed = () => {
      if (!cachedPresentation.current()) setPresentationRevision((revision) => revision + 1)
    }
    const stop = presentationCache.subscribe(changed)
    const expiry = setTimeout(changed, Math.max(0, cachedPresentation.expiresAt - Date.now()) + 1)
    if (!cachedPresentation.current()) changed()
    return () => { stop(); clearTimeout(expiry) }
  }, [snapshot, presentationCache, cachedPresentation])
  useLayoutEffect(() => {
    const node = cachedSection.current
    const presentation = cachedPresentation?.presentation
    if (!node || !presentation || snapshot) return
    const measure = () => {
      const width = node.getBoundingClientRect().width
      setCachedGeometry((previous) => previous?.presentation === presentation && previous.width === width
        ? previous : { presentation, width })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => observer.disconnect()
  }, [snapshot, cachedPresentation?.presentation])
  useLayoutEffect(() => () => {
    // Measure and copy only when virtualization removes the row, never on every token.
    // Layout cleanup still owns the DOM and precedes closing its drawing lifetime.
    const current = frameRef.current
    const node = section.current
    if (!presentationCache || !current?.ticket.current() || !current.presentationCurrent ||
      current.owner !== ownerRef.current || current.inputRevision !== inputVersion.current.revision ||
      !canRetainRef.current || !node) return
    const range = document.createRange()
    range.selectNodeContents(node)
    const bounds = range.getBoundingClientRect()
    presentationCache.save(presentationKeyRef.current, component, current.snapshot,
      bounds.height, current.presentationCurrent, bounds.width)
  }, [presentationCache, component])
  useEffect(() => {
    if (!reading) {
      setShowReading(false)
      return
    }
    // The first protected paint uses a stable skeleton, not a repeated refresh announcement.
    // Genuine slow reads remain observable without replacing the skeleton's geometry.
    const timer = setTimeout(() => setShowReading(true), 5000)
    return () => clearTimeout(timer)
  }, [reading])
  const hint = component === "PromptHint" && snapshot ?
    functionNativeHint(snapshot.tree, snapshot.nativeContent) : null
  const isInactive = Boolean(inactive?.inputRevision === inputRevision && inactive.ticket.current())
  const inlineMode = component === "SessionMode" && snapshot && functionInlineTree(snapshot.tree)
  const modeLabel = useMemo(() => {
    if (component !== "SessionMode") return null
    const label = (presentation: ModObject): ReactNode =>
      Array.isArray(presentation.modes) && presentation.modes.every((mode) => typeof mode === "string") ?
        presentation.modes.join(" & ") : null
    if (snapshot) return functionInlineTree(snapshot.tree) ?
      functionInlineLabel(snapshot.tree, snapshot.nativeContent, label) :
      label(functionNativeProps(snapshot.nativeContent, 0) ?? {})
    return isInactive ? label(inputRef.current) : null
  }, [component, snapshot, isInactive, inputKey])
  const composerHint = component === "PromptHint" ? snapshot ?
    hint ?? String(functionNativeProps(snapshot.nativeContent, 0)?.hint ?? "") :
    isInactive ? String(inputRef.current.hint ?? "") : "" : null
  useEffect(() => {
    onModeLabel?.(modeLabel)
    return () => onModeLabel?.(null)
  }, [modeLabel, onModeLabel])
  useEffect(() => {
    let questions: FunctionPaneSnapshot["nativeQuestions"] | null = null
    if (
      frame?.ticket.current() &&
      frame.snapshot.nativeFallback &&
      frame.snapshot.nativeQuestions
    ) {
      try {
        questions = functionQuestionPresentation(
          inputRef.current.questions,
          frame.snapshot.nativeQuestions
        )
      } catch {
        /* Invalid or obsolete presentation cannot change the native dialog. */
      }
    }
    onQuestions?.(questions)
    return () => onQuestions?.(null)
  }, [onQuestions, frame, inputKey])
  useEffect(() => {
    onExpansion?.(
      Boolean(
        frame?.ticket.current() && frame.snapshot.nativeFallback && frame.snapshot.nativeExpansion
      )
    )
    return () => onExpansion?.(false)
  }, [onExpansion, frame])
  useEffect(() => {
    onCustom?.(Boolean(frame?.ticket.current() && !frame.snapshot.nativeFallback))
    return () => onCustom?.(false)
  }, [onCustom, frame])
  useEffect(() => {
    onHint?.(composerHint)
    return () => onHint?.("")
  }, [composerHint, onHint])

  useEffect(() => {
    const node = section.current
    if (component !== "AbovePrompt" || !node) return
    const measure = (): void => {
      // Measure the allocated slot, not its content-dependent border/scrollbar interior.
      // Clearing an obsolete drawing can remove its frame; clientWidth then changes and
      // invalidates the replacement again, creating an endless empty/render resize loop.
      const bodyColumns = Math.max(1, Math.min(1000,
        Math.floor(node.getBoundingClientRect().width / 8)))
      const maxRows = Math.max(1, Math.min(12, Math.floor(window.innerHeight / 48)))
      setGeometry((old) =>
        old.bodyColumns === bodyColumns && old.maxRows === maxRows
          ? old
          : { ...old, bodyColumns, maxRows }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    window.addEventListener("resize", measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [component])

  useEffect(() => {
    live.current = true
    const lifetime = new FunctionSiteLifetime()
    lifetimeRef.current = lifetime
    let stopped = false
    let owner: string | null = null
    let queued = false
    let running: object | null = null
    let sourceRetiring = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const recovery = new FunctionSiteRecovery()
    let lastSourceGeneration = -1
    let lastRetiringGeneration = -1
    const hidden = (): boolean => typeof document !== "undefined" && document.hidden
    const cancelTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const releaseOwner = (): void => {
      const previous = owner
      owner = null
      ownerRef.current = null
      if (previous) void window.api.mods.siteUnmount(threadId, previous).catch(() => {})
    }
    const invalidate = (): void => {
      cancelTimer()
      lifetime.invalidate()
      redrawPresentation.current = null
      setFrame(null)
      setInactive(null)
    }
    const schedule = (delay = 0): void => {
      if (stopped || sourceRetiring) return
      queued = true
      if (running || hidden() || timer !== undefined) return
      const ticket = lifetime.capture()
      timer = setTimeout(() => {
        timer = undefined
        if (!ticket.current() || stopped || hidden()) return
        queued = false
        void refresh()
      }, delay)
    }
    const refresh = async (): Promise<void> => {
      if (stopped || hidden() || sourceRetiring) return
      if (running) { queued = true; return }
      const attempt = {}
      running = attempt
      recovery.started(Date.now())
      setReading(true)
      setError("")
      setFailureCode("")
      const ticket = lifetime.capture()
      const capturedInput = inputRef.current
      const capturedInputKey = JSON.stringify(capturedInput)
      const capturedInputRevision = inputVersion.current.revision
      const capturedEpoch = prefixLineage.current.epoch
      const capturedRenderer = rendererRef.current
      const presentationCurrent = presentationCache?.capture(component, presentationKeyRef.current, presentationRow)
      pendingPrefix.current = { key: capturedInputKey, epoch: capturedEpoch }
      const current = (): boolean => running === attempt && ticket.current() && !hidden() && !sourceRetiring && (
        (capturedInputRevision === inputVersion.current.revision &&
          capturedInputKey === JSON.stringify(inputRef.current)) ||
        (component === "AssistantMessage" && canRetainRef.current &&
          capturedEpoch === prefixLineage.current.epoch &&
          retainsFunctionSitePresentation(component, capturedInputKey, inputRef.current)))
      let retryDelay: number | undefined
      const remount = (): void => {
        // Retirement can race with a committed source replacement. Revoke the old
        // drawing and authority, then spend the same finite budget as lifecycle errors.
        presentationCache?.invalidateKey(presentationKeyRef.current, true, presentationRow)
        invalidate()
        releaseOwner()
        const delay = recovery.failed(true)
        if (delay !== undefined) {
          queued = true
          retryDelay = delay
        } else {
          setError("当前界面暂不可用，请重新读取。")
        }
      }
      // Read geometry only for cold admission, never for each appended token/redraw.
      const queuePriority = ["AbovePrompt", "PromptHint", "SessionMode", "Spinner", "AskUserQuestion"]
        .includes(component) ? "interactive" :
        !owner && isFunctionSiteInViewport(section.current) ? "visible" : "ordinary"
      try {
        // Keep admission and its first drawing in one fair queue job. Requeueing a mounted
        // owner behind every other cold mount needlessly delayed the first readable message.
        // Both IPC calls retain their original host checks; stale mounts are still released.
        const drawing = await functionSiteQueue.run(current, async () => {
          if (!owner) {
            const outcome = await window.api.mods.siteMountOutcome(
              threadId, component, messageId, expectedRequestId)
            if (!current()) {
              if (outcome.state === "mounted")
                void window.api.mods.siteUnmount(threadId, outcome.owner).catch(() => {})
              return
            }
            if (outcome.state === "inactive") {
              recovery.reset()
              setInactive({ ticket, inputKey: capturedInputKey, inputRevision: capturedInputRevision })
              setFrame(null)
              setError("")
              return
            }
            if (outcome.state === "retired") {
              remount()
              return
            }
            owner = outcome.owner
            ownerRef.current = owner
          }
          const capturedOwner = owner
          const result = await window.api.mods.siteRender(threadId, capturedOwner, capturedInput)
          return { capturedOwner, result }
        }, queuePriority)
        if (!drawing) return
        const { capturedOwner, result } = drawing
        if (!current() || owner !== capturedOwner) return
        if (result) {
          validateFunctionSiteTree(result.tree)
          validateFunctionNativeContent(result.nativeContent, component, expectedRequestId)
          recovery.reset()
          const nextFrame = { snapshot: result, ticket, inputKey: capturedInputKey,
            inputRevision: capturedInputRevision, owner: capturedOwner!, presentationCurrent }
          // Capture the delegate paired with this read, never a later raw-input closure.
          nativePresentation.current = { frame: nextFrame, renderNative: capturedRenderer }
          setFrame(nextFrame)
          setInactive(null)
          setError("")
        } else {
          remount()
        }
      } catch (cause) {
        if (current()) {
          const code = functionSiteErrorCode(cause)
          setFailureCode(code ?? "")
          if (code === "MODS_UI_QUESTION_STALE" || code === "MODS_SCOPE_CHANGED" ||
            code === "MODS_CALL_SCOPE_CHANGED") {
            invalidate()
            releaseOwner()
            queued = false
            recovery.failed(false)
            setError("界面或提问已更新，请使用当前内容。")
          } else if (isTransientFunctionSiteError(cause)) {
            // A turn authority can expire while this thread-scoped site remains valid.
            // A fresh IPC read obtains fresh authority; no old operation is resumed.
            if (code !== "MODS_RUNTIME_INSTANCE_EXPIRED") {
              invalidate()
              releaseOwner()
            } else {
              const previous = frameRef.current
              const currentRedraw = canRetainRef.current && previous?.ticket.current() &&
                previous.owner === owner && redrawPresentation.current?.frame === previous &&
                redrawPresentation.current.revision === capturedInputRevision &&
                redrawPresentation.current.inputKey === capturedInputKey
              if (!currentRedraw && (!canRetainRef.current || !previous?.ticket.current() ||
                previous.owner !== owner || previous.inputKey === capturedInputKey ||
                !retainsFunctionSitePresentation(component, previous.inputKey, capturedInput))) invalidate()
            }
            const delay = recovery.failed(true)
            if (delay !== undefined) {
              // Bounded autonomous retries; external updates never replenish this budget.
              queued = true
              retryDelay = delay
            } else {
              setError("显示暂时未更新，请重试。重新读取不会重复执行操作。")
            }
          } else {
            recovery.failed(false)
            setError(["MODS_RUNTIME_LOST", "MODS_HOST_TIMEOUT", "MODS_HOST_EXITED", "MODS_CONFIG_RELOAD_STOPPED"].includes(code ?? "")
              ? "组件运行已停止或响应超时。未完成操作的结果需要核对；请查看恢复选项，明确重新加载组件。"
              : code === "MODS_UI_SITE_CLIENT_UNSUPPORTED"
              ? "此灵件暂时无法在这里显示。"
              : "灵件显示更新失败，请重试。")
          }
        }
      } finally {
        // A retired read still occupies its queue slot until physical completion, but its
        // continuation cannot clear the new source's prefix, pending state or retry timer.
        if (running === attempt) {
          pendingPrefix.current = null
          running = null
          if (!stopped) {
            if (queued) schedule(retryDelay ?? recovery.notificationDelay(Date.now()))
            setReading(!hidden() && (queued || timer !== undefined))
          }
        }
      }
    }
    const update = (): void => schedule(recovery.notificationDelay(Date.now()))
    const reset = (): void => {
      sourceRetiring = false
      invalidate()
      releaseOwner()
      recovery.reset()
      setError("")
      update()
    }
    refreshRef.current = update
    inputRefreshRef.current = () => {
      // Progress may keep only the prior protected presentation, with all old-input
      // actions blocked. Replacements revoke it immediately. Both reuse the slot owner.
      const previous = frameRef.current
      const pending = pendingPrefix.current
      const firstPrefix = !previous && component === "AssistantMessage" && canRetainRef.current &&
        pending && pending.epoch === prefixLineage.current.epoch &&
        retainsFunctionSitePresentation(component, pending.key, inputRef.current)
      if (!firstPrefix && (!canRetainRef.current || !previous?.ticket.current() || previous.owner !== owner ||
        !retainsFunctionSitePresentation(component, previous.inputKey, inputRef.current))) invalidate()
      setError("")
      update()
    }
    retryRef.current = reset
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && event.scope?.startsWith("site-presentations:")) {
        // The scope cache is synchronously revoked even when no drawing owner exists.
        // Existing live drawings receive their original owner-specific notification.
        return
      }
      if (event.threadId === threadId && isModSiteChangeScope(event.scope)) {
        if ([`site:${owner}`, `site-redraw:${owner}`, `site-invalidated:${owner}`].includes(event.scope))
          presentationCache?.invalidateKey(presentationKeyRef.current, true, presentationRow)
        if (event.scope === `site-redraw:${owner}`) {
          // A redraw is a new protected presentation, not an append-only input update.
          // Even a compatible pending prefix must not publish across that revision.
          prefixLineage.current.epoch++
          const previous = frameRef.current
          const currentRevision = inputVersion.current.revision
          const currentInputKey = JSON.stringify(inputRef.current)
          const eligible = canRetainRef.current &&
            previous?.ticket.current() && previous.owner === owner &&
            nativePresentation.current?.frame === previous &&
            ((previous.inputRevision === currentRevision && previous.inputKey === currentInputKey) ||
              (redrawPresentation.current?.frame === previous &&
                redrawPresentation.current.revision === currentRevision &&
                redrawPresentation.current.inputKey === currentInputKey) ||
              retainsFunctionSitePresentation(component, previous.inputKey, inputRef.current))
          if (eligible && previous) {
            const revision = ++inputVersion.current.revision
            // This is a new drawing revision, not a facts change. Do not route it through
            // the facts-effect invalidation; queued/ongoing reads still use this revision.
            lastInputRevision.current = revision
            redrawPresentation.current = { frame: previous, revision, inputKey: currentInputKey }
            setRedrawRevision(revision)
          } else invalidate()
          update()
        }
        if (event.scope === `site-invalidated:${owner}`) {
          invalidate()
          update()
        }
        if (event.scope === `site:${owner}`) update()
        return
      }
      if (event.threadId === threadId && event.scope?.startsWith("source-retiring:")) {
        const generation = Number(event.scope.slice("source-retiring:".length))
        if (!Number.isSafeInteger(generation) || generation < lastSourceGeneration ||
          generation <= lastRetiringGeneration) return
        lastRetiringGeneration = generation
        sourceRetiring = true
        queued = false
        invalidate()
        releaseOwner()
        pendingPrefix.current = null
        setReading(false)
        return
      }
      if (event.threadId === threadId && event.scope?.startsWith("source-replaced:")) {
        const generation = Number(event.scope.slice("source-replaced:".length))
        if (!Number.isSafeInteger(generation) || generation <= Math.max(lastSourceGeneration, lastRetiringGeneration)) return
        lastSourceGeneration = generation
        sourceRetiring = false
        // Detach only the renderer continuation. The queue keeps the old physical job.
        running = null
        pendingPrefix.current = null
        // A committed replacement has already retired the old owner. Mount directly instead
        // of spending a protected read and retry backoff discovering that its receipt is gone.
        reset()
        return
      }
      if (event.threadId === threadId && event.scope !== "panes" && event.scope !== "records" && event.scope !== "cards" && event.scope !== "feedback") {
        // Unknown/global changes keep their original fail-closed read path.
        sourceRetiring = false
        // Revoke publication immediately, while coalescing notification-driven reads.
        invalidate()
        update()
      }
    })
    const visibility = (): void => {
      if (hidden()) {
        // Visibility is not an authorization change. Pause work without discarding a
        // still-current drawing; actual input/configuration notifications revoke it below.
        queued = queued || Boolean(running)
        cancelTimer()
        setReading(false)
      } else if (queued) update()
    }
    const stopConfiguration = window.api.mods.onConfigurationChanged((event) => {
      if (event?.scope !== "schema") reset()
    })
    window.addEventListener("mods:configuration-changed", reset)
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility)
    update()
    return () => {
      stopped = true
      cancelTimer()
      live.current = false
      lifetime.close()
      releaseOwner()
      refreshRef.current = () => {}
      inputRefreshRef.current = () => {}
      retryRef.current = () => {}
      stop()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", reset)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility)
    }
  }, [threadId, component, messageId, expectedRequestId, presentationCache, presentationRow])
  useEffect(() => {
    if (lastInputRevision.current === inputRevision) return
    lastInputRevision.current = inputRevision
    inputRefreshRef.current()
  }, [inputKey, inputRevision])

  const act: Act = async (node, kind, value) => {
    const pane = snapshotRef.current
    const owner = ownerRef.current
    if (!pane || !owner || document.hidden || !frame?.ticket.current() ||
      frame.inputRevision !== inputVersion.current.revision ||
      frame.inputKey !== JSON.stringify(inputRef.current)) return
    const ticket = lifetimeRef.current?.capture()
    if (!ticket) return
    pending.current++
    if (!["change", "focus", "scroll"].includes(kind)) setBusy(true)
    try {
      const result = await window.api.mods.siteAct(threadId, owner, {
        pane: pane.key,
        generation: pane.generation,
        plugin: node && node.type !== "engine" && node.type !== "fragment" ? node.press?.plugin ?? pane.plugin : pane.plugin,
        handle: node && node.type !== "engine" && node.type !== "fragment" ? node.press?.handle ?? 0 : 0,
        intentId: crypto.randomUUID(),
        kind,
        ...(value === undefined ? {} : { value })
      })
      if (!ticket.current() || ownerRef.current !== owner ||
        frame.inputRevision !== inputVersion.current.revision ||
      frame.inputKey !== JSON.stringify(inputRef.current)) return
      if (document.hidden) {
        if (kind !== "change") refreshRef.current()
        return
      }
      if (
        kind === "focus" &&
        result?.focused &&
        section.current &&
        document.activeElement === section.current &&
        snapshotRef.current?.generation === pane.generation
      ) {
        const control = paneFocusElement(section.current, result.target)
        if (control && !control.matches(":disabled")) {
          applyingFocus.current = true
          try {
            control.focus({ preventScroll: true })
          } finally {
            applyingFocus.current = false
          }
        }
      }
      if (kind !== "change") refreshRef.current()
    } catch {
      if (ticket.current() && ownerRef.current === owner &&
        frame.inputRevision === inputVersion.current.revision &&
        frame.inputKey === JSON.stringify(inputRef.current)) {
        if (!document.hidden) setError("界面已更新或操作未完成，请在当前界面重试。")
        refreshRef.current()
      }
    } finally {
      pending.current--
      if (live.current && pending.current === 0) setBusy(false)
    }
  }

  const blockStaleInteraction = (event: React.SyntheticEvent): void => {
    const currentInactive = inactive?.ticket.current() &&
      inactive.inputRevision === inputVersion.current.revision
    const currentFrame = frame?.ticket.current() &&
      frame.inputRevision === inputVersion.current.revision
    if (document.hidden || (!currentInactive && !currentFrame)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const blockCachedInteraction = (event: SyntheticEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <section
      ref={section}
      data-function-hotkey-scope={component === "AbovePrompt" ? true : undefined}
      data-function-plugin={snapshot?.plugin}
      onKeyDown={component === "AbovePrompt" ? event => { pressFunctionHotkey(event) } : undefined}
      data-function-site={component}
      aria-busy={reading || (!snapshot && !isInactive && !error) || undefined}
      data-function-request-id={
        component === "AskUserQuestion"
          ? expectedRequestId
          : typeof facts.tool_use_id === "string"
            ? facts.tool_use_id
            : typeof facts.requestId === "string"
              ? facts.requestId
              : undefined
      }
      tabIndex={
        component === "AbovePrompt" && snapshot && functionFocusTargets(snapshot).length
          ? 0
          : undefined
      }
      className={className ?? DEFAULT_SITE_CLASS_NAME}
      style={component === "AbovePrompt" ? { maxHeight: geometry.maxRows * 24 } : undefined}
      onFocus={(event) => {
        if (
          component === "AbovePrompt" &&
          event.target === event.currentTarget &&
          !applyingFocus.current
        )
          void act(undefined, "focus", { focused: true })
      }}
      onBlur={(event) => {
        if (
          component !== "AbovePrompt" ||
          (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        )
          return
        void act(undefined, "focus", { focused: false })
      }}
      onScroll={(event) => {
        if (component !== "AbovePrompt") return
        const offset = Math.max(0, Math.min(100000, Math.floor(event.currentTarget.scrollTop / 24)))
        setGeometry((old) => (old.offset === offset ? old : { ...old, offset }))
      }}
      onWheel={(event) => {
        if (component !== "AbovePrompt") return
        const clamp = (n: number): number => Math.max(-100000, Math.min(100000, n))
        void act(undefined, "scroll", {
          deltaX: clamp(event.deltaX),
          deltaY: clamp(event.deltaY),
          top: clamp(event.currentTarget.scrollTop),
          left: clamp(event.currentTarget.scrollLeft)
        })
      }}
    >
      {!(onHint && hint !== null) && !inlineMode && (
        <div className="contents" inert={Boolean(snapshot && frame?.inputRevision !== inputRevision)}
          onClickCapture={blockStaleInteraction} onKeyDownCapture={blockStaleInteraction}
          onSubmitCapture={blockStaleInteraction}
          aria-disabled={snapshot && frame?.inputRevision !== inputRevision ? true : undefined}>
        <FunctionSiteContent snapshot={snapshot} fallback={fallback}
          busy={busy || Boolean(snapshot && frame?.inputRevision !== inputRevision)} act={act}
          threadId={threadId} refresh={() => refreshRef.current()} renderNative={presentationRenderer}
          inactive={isInactive}
          component={component} expectedRequestId={expectedRequestId}
          owner={ownerRef.current ?? undefined}
          isCurrent={() => Boolean(frame?.ticket.current() &&
            frame.inputRevision === inputVersion.current.revision &&
        frame.inputKey === JSON.stringify(inputRef.current))} />
        </div>
      )}
      {!snapshot && !isInactive && !error && (cachedPresentation?.current() ?
        <div ref={cachedSection} data-function-site-cached inert aria-disabled="true"
          style={cachedGeometry?.presentation === cachedPresentation.presentation &&
            Math.abs(cachedGeometry.width - cachedPresentation.presentation.width) < 1
            ? { minHeight: cachedPresentation.presentation.height } : undefined}
          onClickCapture={blockCachedInteraction} onKeyDownCapture={blockCachedInteraction}
          onSubmitCapture={blockCachedInteraction} onInputCapture={blockCachedInteraction}
          onChangeCapture={blockCachedInteraction}>
          <Element node={cachedPresentation.presentation.tree} busy act={async () => {}}
            renderEngine={(ref) => {
              const native = cachedPresentation.presentation.nativeContent
              const props = functionNativeProps(native, ref)
              if (!props) return null
              if (renderNative) return renderNative(props)
              return native?.nativeUnchanged ? null :
                <Element node={functionSiteDefault(component, props)} busy act={async () => {}} />
            }} />
        </div> : <FunctionSitePending component={component} slow={reading && showReading} />)}
      {error && (
        <div role="alert" className="text-destructive">
          <span>{error}</span>
          {["MODS_RUNTIME_LOST", "MODS_HOST_TIMEOUT", "MODS_HOST_EXITED", "MODS_CONFIG_RELOAD_STOPPED"].includes(failureCode)
            ? <button type="button" className="ml-2 underline"
                onClick={() => openClawRecovery(threadId)}>查看恢复选项</button>
            : <button type="button" className="ml-2 underline" disabled={reading}
                onClick={() => retryRef.current()}>重新读取界面</button>}
          {failureCode && <details className="text-xs"><summary>技术信息</summary>{failureCode}</details>}
        </div>
      )}
    </section>
  )
}
