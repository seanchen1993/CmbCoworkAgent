import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { CodeViewer } from "@/components/tabs/CodeViewer"
import {
  nextJsonPreviewCaret,
  type JsonDisplayRow,
  type JsonPreviewRequest,
  type JsonPreviewResponse
} from "@/lib/bot-json-preview"
import JsonPreviewWorker from "./bot-json-preview.worker?worker"

function JsonTree({ rows, onToggle }: { rows: JsonDisplayRow[]; onToggle: (id: string) => void }) {
  const list = useRef<VirtuosoHandle>(null)
  const carets = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<string | null>(null)

  const onCaretKeyDown = (event: KeyboardEvent, index: number) => {
    if (
      event.key !== "Tab" ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    const pending = pendingFocus.current
    const pendingIndex = pending ? rows.findIndex((row) => row.id === pending) : -1
    const next = nextJsonPreviewCaret(
      rows,
      pendingIndex >= 0 ? pendingIndex : index,
      event.shiftKey ? -1 : 1
    )
    if (next < 0) return
    event.preventDefault()
    const id = rows[next].id
    const focus = () => {
      if (pendingFocus.current !== id) return
      const button = carets.current.get(id)
      if (button) {
        pendingFocus.current = null
        button.focus({ preventScroll: true })
      }
    }
    pendingFocus.current = id
    // Mounted carets can focus immediately; do not lose rapid Tab repeats while scrolling.
    focus()
    list.current?.scrollIntoView({ index: next, done: focus })
  }

  return (
    <div className="bot-json-preview" role="region" aria-label="JSON 内容">
      <Virtuoso
        ref={list}
        className="bot-json-scroll"
        tabIndex={-1}
        data={rows}
        defaultItemHeight={22}
        computeItemKey={(_index, row) => row.id}
        itemContent={(index, row) => {
          if (row.kind === "more") {
            return (
              <div
                className="bot-json-row bot-json-summary"
                style={{ paddingInlineStart: row.depth * 17 + 16 }}
              >
                … 还有 {row.hiddenCount.toLocaleString()} 个条目
              </div>
            )
          }
          const container = row.kind === "container"
          return (
            <div className="bot-json-row" style={{ paddingInlineStart: row.depth * 17 }}>
              <span className="bot-json-guides" style={{ width: row.depth * 17 }} aria-hidden />
              {container && row.childCount > 0 ? (
                <button
                  type="button"
                  className="bot-json-caret"
                  aria-expanded={row.isExpanded}
                  aria-label={`${row.isExpanded ? "折叠" : "展开"} ${row.name ?? "根节点"}`}
                  ref={(button) => {
                    if (button) {
                      carets.current.set(row.id, button)
                      if (pendingFocus.current === row.id) {
                        pendingFocus.current = null
                        button.focus({ preventScroll: true })
                      }
                    } else carets.current.delete(row.id)
                  }}
                  onClick={() => onToggle(row.id)}
                  onKeyDown={(event) => onCaretKeyDown(event, index)}
                >
                  {row.isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </button>
              ) : (
                <span className="bot-json-caret" aria-hidden />
              )}
              <span className="bot-json-text">
                {row.name !== null && (
                  <>
                    <span className="bot-json-key">{row.name}</span>
                    <span className="bot-json-colon">: </span>
                  </>
                )}
                {container ? (
                  <span className="bot-json-summary">
                    {row.isArray ? `[${row.childCount} 个条目]` : `{${row.childCount} 个键}`}
                  </span>
                ) : (
                  <span className={`bot-json-${row.valueKind}`}>{row.text}</span>
                )}
              </span>
            </div>
          )
        }}
      />
    </div>
  )
}

export function BotJsonFilePreview({ content, filePath }: { content: string; filePath: string }) {
  const worker = useRef<Worker | null>(null)
  const [preview, setPreview] = useState<{ content: string; result: JsonPreviewResponse } | null>(
    null
  )
  useEffect(() => {
    let active = true
    const created = new JsonPreviewWorker({ name: "bot-json-preview" })
    worker.current = created
    created.onmessage = (event: MessageEvent<JsonPreviewResponse>) => {
      if (active) setPreview({ content, result: event.data })
    }
    created.onerror = created.onmessageerror = () => {
      if (active) setPreview({ content, result: { status: "source" } })
      created.terminate()
      if (worker.current === created) worker.current = null
    }
    const request: JsonPreviewRequest = { type: "parse", content }
    created.postMessage(request)
    return () => {
      active = false
      created.terminate()
      if (worker.current === created) worker.current = null
    }
  }, [content])
  if (preview?.content !== content) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
        role="status"
        aria-label="正在读取 JSON"
      >
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  }
  return preview.result.status === "tree" ? (
    <JsonTree
      rows={preview.result.rows}
      onToggle={(id) => {
        const request: JsonPreviewRequest = { type: "toggle", id }
        worker.current?.postMessage(request)
      }}
    />
  ) : (
    <CodeViewer content={content} filePath={filePath} />
  )
}
