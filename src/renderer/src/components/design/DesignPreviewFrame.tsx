import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject
} from "react"
import {
  buildDesignFrameDocument,
  sanitizeDesignDraft,
  createDesignSectionPatch
} from "@/lib/design-progressive-preview"
import { effectiveTweaks, type DesignTweaksState } from "../../../../shared/design-tweaks"
import type { DesignDraftPreview } from "../../../../shared/design-progressive"
import { buildDesignHtmlPreviewDocument } from "@/lib/design-html-srcdoc"
import { createDesignLiveDelta } from "@/lib/design-live-patch"
import type { DesignAppliedPatch } from "../../../../shared/design-patch"

interface Props {
  appliedPatch?: DesignAppliedPatch | null
  artifactRevision?: number
  html: string
  draft?: DesignDraftPreview | null
  tweaks?: DesignTweaksState | null
  scopeId: string
  frameRef: MutableRefObject<HTMLIFrameElement | null>
  style: CSSProperties
  onLoad: (draft: boolean) => void
  initialScroll?: { x: number; y: number }
  onVisible: (runId: string, revision: number) => void
}

function createFrameLoad(html: string, draft?: DesignDraftPreview | null, artifactRevision = 0) {
  const instance = crypto.randomUUID()
  return {
    instance,
    initialHtml: html,
    document: buildDesignFrameDocument(html, instance, draft ?? undefined, artifactRevision),
    revision: draft?.revision ?? artifactRevision
  }
}

/** Drafts and local edits retain their browsing context; structural revisions reload explicitly. */
export function DesignPreviewFrame(props: Props) {
  const draftPath = props.draft?.draftPath
  const sourceHtml = props.html
  const [prepared, setPrepared] = useState<{ source: string; path: string; html: string } | null>(
    null
  )
  useEffect(() => {
    if (!draftPath) return
    let cancelled = false
    void buildDesignHtmlPreviewDocument({
      html: sourceHtml,
      htmlPath: draftPath,
      readTextFile: async (path) => {
        const result = await window.api.file.readText(path)
        return result.success ? (result.content ?? null) : null
      },
      readDataUrlFile: async (path) => {
        const result = await window.api.file.readDataUrl(path)
        return result.success ? (result.dataUrl ?? null) : null
      }
    })
      .then((html) => {
        if (!cancelled) setPrepared({ source: sourceHtml, path: draftPath, html })
      })
      .catch((error) => console.warn("[Design] Draft dependencies unavailable", error))
    return () => {
      cancelled = true
    }
  }, [sourceHtml, draftPath])
  const contextKey = props.draft
    ? `${props.scopeId}:draft:${props.draft.runId}`
    : `${props.scopeId}:final`
  const html =
    props.draft && prepared?.source === sourceHtml && prepared.path === draftPath
      ? prepared.html
      : props.html
  return <DesignPreviewContext key={contextKey} {...props} html={html} />
}

function DesignPreviewContext({
  html,
  draft,
  tweaks,
  frameRef,
  style,
  onLoad,
  onVisible,
  initialScroll,
  appliedPatch,
  artifactRevision = 0
}: Props) {
  const [tick, setTick] = useState(0)
  const [load, setLoad] = useState(() => createFrameLoad(html, draft, artifactRevision))
  const live = useRef({ html, revision: artifactRevision, ready: false })
  const [liveTick, setLiveTick] = useState(0)
  const livePending = useRef<{
    html: string
    revision: number
    timer: ReturnType<typeof setTimeout>
  } | null>(null)

  useEffect(() => {
    if (draft) return
    const listener = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.previewInstanceId !== load.instance
      )
        return
      if (
        event.data.type === "__design_live_applied" &&
        livePending.current &&
        event.data.revision === livePending.current.revision
      ) {
        clearTimeout(livePending.current.timer)
        live.current = {
          html: livePending.current.html,
          revision: livePending.current.revision,
          ready: true
        }
        livePending.current = null
        onVisible(String(event.data.patchId), event.data.revision)
        setLiveTick((v) => v + 1)
      } else if (event.data.type === "__design_live_resync") {
        if (livePending.current) clearTimeout(livePending.current.timer)
        livePending.current = null
        setLoad(createFrameLoad(html, null, artifactRevision))
      }
    }
    window.addEventListener("message", listener)
    return () => window.removeEventListener("message", listener)
  }, [draft, load.instance, frameRef, html, artifactRevision, onVisible])
  useEffect(
    () => () => {
      if (livePending.current) clearTimeout(livePending.current.timer)
    },
    []
  )
  useEffect(() => {
    if (
      draft ||
      !live.current.ready ||
      livePending.current ||
      (html === live.current.html && artifactRevision === live.current.revision)
    )
      return
    const delta =
      appliedPatch?.mode === "live" && artifactRevision !== live.current.revision
        ? createDesignLiveDelta(live.current.html, html)
        : null
    if (!delta) {
      const frame = requestAnimationFrame(() =>
        setLoad(createFrameLoad(html, null, artifactRevision))
      )
      return () => cancelAnimationFrame(frame)
    }
    const timer = setTimeout(() => {
      livePending.current = null
      setLoad(createFrameLoad(html, null, artifactRevision))
    }, 1200)
    livePending.current = { html, revision: artifactRevision, timer }
    frameRef.current?.contentWindow?.postMessage(
      {
        type: "__design_live_patch",
        previewInstanceId: load.instance,
        baseRevision: live.current.revision,
        revision: artifactRevision,
        patchId: appliedPatch?.id,
        delta
      },
      "*"
    )
    return undefined
  }, [html, draft, artifactRevision, appliedPatch, liveTick, load.instance, frameRef])
  const [failed, setFailed] = useState(false)
  const recoveries = useRef(0)
  const latest = useRef({ draft, tweaks, onVisible, html })
  useLayoutEffect(() => {
    latest.current = { draft, tweaks, onVisible, html }
  }, [draft, tweaks, onVisible, html])
  const applied = useRef<{ instance: string; revision: number; ready: boolean }>({
    instance: "",
    revision: 0,
    ready: false
  })
  const inFlight = useRef<{
    instance: string
    revision: number
    html: string
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const appliedHtml = useRef(html)
  const resync = useRef(false)

  useLayoutEffect(() => {
    live.current = { html: load.initialHtml, revision: load.revision, ready: false }
    applied.current = { instance: load.instance, revision: load.revision, ready: false }
    appliedHtml.current = load.initialHtml
    resync.current = false
    const listener = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.previewInstanceId !== load.instance
      )
        return
      const message = event.data
      if (
        message.type === "__design_preview_ready" ||
        message.type === "__design_preview_applied"
      ) {
        if (message.runId !== latest.current.draft?.runId) return
        applied.current = {
          instance: load.instance,
          revision: Math.max(applied.current.revision, message.revision),
          ready: true
        }
        if (inFlight.current && message.revision >= inFlight.current.revision) {
          appliedHtml.current = inFlight.current.html
          clearTimeout(inFlight.current.timer)
          inFlight.current = null
        }
        latest.current.onVisible(message.runId, message.revision)
        setTick((v) => v + 1)
      } else if (message.type === "__design_preview_resync") {
        if (inFlight.current) clearTimeout(inFlight.current.timer)
        inFlight.current = null
        resync.current = true
        setTick((v) => v + 1)
      }
    }
    window.addEventListener("message", listener)
    return () => {
      window.removeEventListener("message", listener)
      if (inFlight.current) clearTimeout(inFlight.current.timer)
      inFlight.current = null
    }
  }, [load, frameRef])

  useEffect(() => {
    if (
      !draft ||
      !applied.current.ready ||
      applied.current.instance !== load.instance ||
      inFlight.current ||
      (draft.revision <= applied.current.revision &&
        html === appliedHtml.current &&
        !resync.current)
    )
      return
    const patch = resync.current ? null : createDesignSectionPatch(appliedHtml.current, html)
    const message = {
      type: "__design_preview_update",
      previewInstanceId: load.instance,
      runId: draft.runId,
      baseRevision: resync.current ? null : applied.current.revision,
      revision: draft.revision,
      ...(patch ? { patch } : { html: sanitizeDesignDraft(html) }),
      keys: tweaks ? effectiveTweaks(tweaks) : {}
    }
    resync.current = false
    const timer = setTimeout(() => {
      inFlight.current = null
      // First recover through a full snapshot; a missing runtime is rebuilt after that.
      if (message.baseRevision === null) {
        if (recoveries.current >= 2) setFailed(true)
        else {
          recoveries.current++
          setLoad(createFrameLoad(latest.current.html, latest.current.draft))
        }
      } else {
        resync.current = true
        setTick((v) => v + 1)
      }
    }, 1000)
    inFlight.current = { instance: load.instance, revision: draft.revision, html, timer }
    frameRef.current?.contentWindow?.postMessage(message, "*")
  }, [draft, html, tweaks, tick, load, frameRef])

  useEffect(() => {
    if (!tweaks) return
    frameRef.current?.contentWindow?.postMessage(
      {
        type: "__design_set_tweak_keys",
        protocol: 2,
        previewInstanceId: load.instance,
        tweakRevision: tweaks.revision,
        keys: effectiveTweaks(tweaks)
      },
      "*"
    )
  }, [tweaks, tick, load, frameRef])

  return (
    <>
      <iframe
        ref={frameRef}
        key={load.instance}
        srcDoc={load.document}
        style={style}
        sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-downloads"
        title="Design Preview"
        onLoad={() => {
          if (!draft) {
            live.current = { html: load.initialHtml, revision: load.revision, ready: true }
            if (appliedPatch) onVisible(appliedPatch.id, load.revision)
            setLiveTick((v) => v + 1)
          }
          onLoad(!!draft)
          if (initialScroll)
            requestAnimationFrame(() => {
              const win = frameRef.current?.contentWindow
              if (win?.document.documentElement.dataset.designPreviewInstance === load.instance)
                win.scrollTo(initialScroll.x, initialScroll.y)
            })
          if (latest.current.tweaks)
            frameRef.current?.contentWindow?.postMessage(
              {
                type: "__design_set_tweak_keys",
                protocol: 2,
                previewInstanceId: load.instance,
                tweakRevision: latest.current.tweaks.revision,
                keys: effectiveTweaks(latest.current.tweaks)
              },
              "*"
            )
          if (draft) {
            // The initial ready event can race listener registration; a full snapshot repairs it.
            applied.current = { instance: load.instance, revision: load.revision, ready: true }
            latest.current.onVisible(draft.runId, load.revision)
            setTick((v) => v + 1)
          }
        }}
      />
      {failed && (
        <div
          role="alert"
          style={{
            position: "absolute",
            left: 16,
            bottom: 16,
            padding: 12,
            background: "white",
            border: "1px solid #ddd",
            borderRadius: 8
          }}
        >
          预览更新失败{" "}
          <button
            onClick={() => {
              recoveries.current = 0
              setFailed(false)
              setLoad(createFrameLoad(latest.current.html, latest.current.draft))
            }}
          >
            重新加载
          </button>
        </div>
      )}
    </>
  )
}
