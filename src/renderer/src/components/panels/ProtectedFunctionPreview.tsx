import { useEffect, useRef, useState } from "react"
import { FileText, X } from "lucide-react"
import type { FunctionMarkdownProtectedPreview } from "../../../../shared/mods/v2/markdown-links"
import type { ProtectedFunctionPreviewRequest } from "../../lib/protected-function-preview"
import { Button } from "../ui/button"

/** A native protected text snapshot. No file path, workspace reader, media or reload action. */
export function ProtectedFunctionPreview({ request, onClose }: {
  request: ProtectedFunctionPreviewRequest
  onClose(): void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<{
    key: string
    value: FunctionMarkdownProtectedPreview
  } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const key = `${request.threadId}:${request.preview.receipt}`
  const current = useRef(key)
  current.current = key
  useEffect(() => {
    let live = true
    let closed = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    setSnapshot(null)
    const close = () => {
      if (!live || closed || current.current !== key) return
      closed = true
      clearTimeout(timeout)
      setSnapshot(null)
      onCloseRef.current()
    }
    const read = async () => {
      try {
        // The open event is only an address. Display comes from this actual native receipt.
        const safe = await window.api.mods.markdownPreview(request.threadId, request.preview.receipt)
        if (!live || closed || current.current !== key) return
        if (!safe || safe.receipt !== request.preview.receipt) return close()
        setSnapshot({ key, value: safe })
        timeout = setTimeout(() => { void read() }, 1000)
      } catch { close() }
    }
    const stop = window.api.mods.onMarkdownPreviewInvalidated((event) => {
      if (event.threadId === request.threadId && event.receipt === request.preview.receipt) close()
    })
    void read()
    return () => {
      live = false
      clearTimeout(timeout)
      stop()
      void window.api.mods.markdownPreviewClose(request.threadId, request.preview.receipt)
        .catch(() => {})
    }
  }, [key, request.threadId, request.preview.receipt])
  const visible = snapshot?.key === key ? snapshot.value : null
  return <section data-function-protected-preview
    className="flex min-h-0 flex-1 flex-col bg-background-elevated">
    <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{visible?.title ?? "正在读取受保护预览"}</p>
        <p className="text-xs text-muted-foreground">只读快照 · 已经过内容保护</p>
      </div>
      <Button size="icon" variant="ghost" aria-label="关闭受保护预览" onClick={onClose}>
        <X className="size-4" />
      </Button>
    </div>
    {visible ? <pre data-function-protected-preview-content
      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6">
      {visible.text}
    </pre> : <p role="status" className="p-4 text-sm text-muted-foreground">正在验证当前组件和读取权限…</p>}
  </section>
}
