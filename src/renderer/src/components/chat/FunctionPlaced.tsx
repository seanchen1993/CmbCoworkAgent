import { useCallback, useEffect, useRef, useState } from "react"
import type { FunctionPlacedEntry } from "../../../../shared/mods/v2/placed"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionUiElement
} from "../../../../shared/mods/v2/ui"
import type { ModJson } from "../../../../shared/mods/types"
import { useFunctionDesktopOwner } from "../../lib/function-desktop-owner"
import { useModsChatCurrent } from "../../lib/mods-chat-scope"
import { flowDraftId } from "../../lib/flow-draft-id"
import { FunctionSiteContent } from "./FunctionSite"

export function FunctionPlacedRows({
  threadId,
  rows
}: {
  threadId: string
  rows: readonly FunctionPlacedEntry[]
}): React.JSX.Element | null {
  const binding = useFunctionDesktopOwner(threadId)
  if (!binding) return null
  return (
    <>
      {rows.map((row) => (
        <FunctionPlacedRow
          key={`${row.requestId}:${binding.revision}`}
          threadId={threadId}
          entry={row}
          owner={binding.owner}
          binding={binding.revision}
        />
      ))}
    </>
  )
}

function FunctionPlacedRow({
  threadId,
  entry,
  owner,
  binding
}: {
  threadId: string
  entry: FunctionPlacedEntry
  owner: string
  binding: number
}): React.JSX.Element {
  const current = useModsChatCurrent(threadId)
  const [snapshot, setSnapshot] = useState<FunctionPaneSnapshot | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [lease] = useState(() => flowDraftId("claw"))
  const live = useRef(false)
  const pending = useRef(false)
  const closing = useRef(false)
  const queued = useRef(false)
  const serial = useRef(0)
  const latest = useRef({ current, entry, owner, binding })
  latest.current = { current, entry, owner, binding }
  const refresh = useCallback(() => {
    if (pending.current) {
      queued.current = true
      return
    }
    if (!live.current || !latest.current.current()) return
    const request = ++serial.current,
      captured = latest.current
    void window.api.mods.placedRead(threadId, owner, entry.requestId, lease).then(
      (drawing) => {
        if (
          live.current &&
          request === serial.current &&
          latest.current.binding === captured.binding &&
          latest.current.current()
        ) {
          setSnapshot(drawing)
          setError("")
        }
      },
      () => {
        if (live.current && request === serial.current) {
          setSnapshot(null)
          setError("这张插件卡片已失效或暂时无法绘制。")
        }
      }
    )
  }, [threadId, owner, entry.requestId, lease])
  useEffect(() => {
    live.current = true
    setSnapshot(null)
    refresh()
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && event.scope === "placed") refresh()
    })
    return () => {
      live.current = false
      serial.current++
      stop()
      void window.api.mods.placedRelease(threadId, owner, entry.requestId, lease).catch(() => {})
    }
  }, [threadId, owner, entry.requestId, lease, binding, refresh])
  const act = async (
    node: FunctionUiElement | undefined,
    kind: FunctionUiAction["kind"],
    value?: ModJson
  ) => {
    if (
      pending.current ||
      !snapshot ||
      !node ||
      node.type === "engine" ||
      node.type === "fragment" ||
      !node.press ||
      !live.current ||
      !current()
    )
      return
    pending.current = true
    setBusy(true)
    try {
      await window.api.mods.placedAct(threadId, owner, entry.requestId, lease, {
        pane: snapshot.key,
        generation: snapshot.generation,
        intentId: flowDraftId("claw"),
        plugin: node.press.plugin,
        handle: node.press.handle,
        kind,
        ...(value === undefined ? {} : { value })
      })
    } catch {
      if (live.current) setError("操作未完成，请重新读取卡片后再试。")
    } finally {
      pending.current = false
      queued.current = false
      if (live.current) {
        setBusy(false)
        refresh()
      }
    }
  }
  const dismiss = async () => {
    if (closing.current || !live.current || !current()) return
    closing.current = true
    setBusy(true)
    try {
      await window.api.mods.placedDismiss(threadId, owner, entry.requestId)
    } catch {
      if (live.current) setError("卡片已变化，请重新读取后关闭。")
    } finally {
      closing.current = false
      if (live.current) setBusy(pending.current)
    }
  }
  return (
    <section
      data-function-placed={entry.requestId}
      data-function-placed-lease={snapshot ? lease : undefined}
      data-function-placed-generation={snapshot?.generation}
      aria-label={`${entry.plugin} 插件卡片`}
      className="my-3 min-w-0 rounded-lg border border-border bg-background"
      style={{ position: "relative", isolation: "isolate", contain: "layout paint" }}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 break-all">{entry.plugin} · 插件卡片</span>
        <button
          type="button"
          aria-label="关闭插件卡片"
          onClick={() => void dismiss()}
          className="shrink-0 rounded px-2 py-1 hover:bg-muted"
        >
          关闭
        </button>
      </div>
      <div className="min-w-0 overflow-auto p-3" aria-busy={busy || !snapshot}>
        {error && (
          <div role="alert" className="mb-2 text-xs text-muted-foreground">
            {error}
            <button type="button" disabled={busy} onClick={refresh} className="ml-2 underline">
              重新读取
            </button>
          </div>
        )}
        {!snapshot && !error && <p className="text-xs text-muted-foreground">正在绘制插件卡片…</p>}
        <FunctionSiteContent
          snapshot={snapshot}
          fallback={null}
          busy={busy}
          act={act}
          threadId={threadId}
          owner={entry.requestId}
          refresh={refresh}
          isCurrent={() => live.current && current()}
        />
      </div>
    </section>
  )
}
