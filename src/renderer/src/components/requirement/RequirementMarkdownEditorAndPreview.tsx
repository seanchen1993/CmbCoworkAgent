import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Pencil } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { readRequirementWorkspaceTextFile } from "@/lib/requirement-workspace-text"
import { RequirementMarkdownEditor } from "./RequirementMarkdownEditor"

const MAX_PREVIEW_IMAGE_REQUESTS = 24
const MAX_PREVIEW_HTML_REQUESTS = 8
const MAX_PREVIEW_CACHE_ENTRIES = 32

export function RequirementMarkdownEditorAndPreview({
  requirementId,
  title,
  filePath,
  threadId,
  reloadToken,
  scrollToBottomToken = 0,
  onEditingChange,
  onOpenAttachment
}: {
  requirementId: string
  title: string
  filePath: string
  threadId: string | null
  reloadToken: number
  scrollToBottomToken?: number
  onEditingChange?: (editing: boolean) => void
  onOpenAttachment?: (filePath: string) => void
}): React.JSX.Element {
  const resourceKey = `${threadId ?? ""}\u0000${filePath}\u0000${reloadToken}`
  const [loaded, setLoaded] = useState<{
    key: string
    content: string
    error: string | null
  } | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const current = loaded?.key === resourceKey ? loaded : null
  const content = current?.content ?? ""
  const error = current?.error ?? null
  const loading = current === null
  const editing = editingKey === resourceKey
  const previewImageCacheRef = useRef(new Map<string, Promise<string | null>>())
  const previewHtmlCacheRef = useRef(new Map<string, Promise<string | null>>())
  const previewRequestCountRef = useRef({ images: 0, html: 0 })
  const previewBlobUrlsRef = useRef(new Set<string>())
  const previewScopeRef = useRef("")
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const lastScrolledTokenRef = useRef(0)
  const previewScope = `${requirementId}\u0000${filePath}\u0000${reloadToken}`

  const ensurePreviewScope = useCallback((): void => {
    if (previewScopeRef.current === previewScope) return
    previewScopeRef.current = previewScope
    for (const url of previewBlobUrlsRef.current) URL.revokeObjectURL(url)
    previewBlobUrlsRef.current.clear()
    previewImageCacheRef.current.clear()
    previewHtmlCacheRef.current.clear()
    previewRequestCountRef.current = { images: 0, html: 0 }
  }, [previewScope])

  useEffect(
    () => () => {
      for (const url of previewBlobUrlsRef.current) URL.revokeObjectURL(url)
      previewBlobUrlsRef.current.clear()
    },
    []
  )

  const readPreviewImage = useCallback(
    (resolvedPath: string): Promise<string | null> => {
      ensurePreviewScope()
      const cache = previewImageCacheRef.current
      const cached = cache.get(resolvedPath)
      if (cached) return cached
      if (previewRequestCountRef.current.images >= MAX_PREVIEW_IMAGE_REQUESTS) {
        return Promise.resolve(null)
      }
      previewRequestCountRef.current.images += 1
      const requestScope = previewScopeRef.current
      const pending = window.api.requirements
        .readPrdImage({ reqId: requirementId, filePath: resolvedPath })
        .then((result) => {
          if (previewScopeRef.current !== requestScope) return null
          if (!result.success || !result.bytes || !result.mimeType) return null
          const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }))
          previewBlobUrlsRef.current.add(url)
          return url
        })
        .catch(() => null)
      if (cache.size >= MAX_PREVIEW_CACHE_ENTRIES) cache.delete(cache.keys().next().value ?? "")
      cache.set(resolvedPath, pending)
      return pending
    },
    [ensurePreviewScope, requirementId]
  )

  const readPreviewHtml = useCallback(
    (resolvedPath: string): Promise<string | null> => {
      ensurePreviewScope()
      const cache = previewHtmlCacheRef.current
      const cached = cache.get(resolvedPath)
      if (cached) return cached
      if (previewRequestCountRef.current.html >= MAX_PREVIEW_HTML_REQUESTS) {
        return Promise.resolve(null)
      }
      previewRequestCountRef.current.html += 1
      const pending = window.api.requirements
        .readPrdHtml({ reqId: requirementId, filePath: resolvedPath })
        .then((result) => (result.success ? (result.content ?? null) : null))
        .catch(() => null)
      if (cache.size >= MAX_PREVIEW_CACHE_ENTRIES) cache.delete(cache.keys().next().value ?? "")
      cache.set(resolvedPath, pending)
      return pending
    },
    [ensurePreviewScope, requirementId]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!threadId) {
        if (!cancelled)
          setLoaded({
            key: resourceKey,
            content: "",
            error: "当前需求尚未关联任务，无法读取 PRD 文件"
          })
        return
      }
      const result = await readRequirementWorkspaceTextFile(threadId, filePath, {
        lanePrefix: "requirement-markdown-editor"
      })
      if (cancelled) return
      setLoaded({
        key: resourceKey,
        content: result.success ? (result.content ?? "") : "",
        error: result.success ? null : result.error || "PRD 文件加载失败"
      })
    })()
    return () => {
      cancelled = true
    }
  }, [filePath, resourceKey, threadId])

  useEffect(() => {
    onEditingChange?.(false)
  }, [onEditingChange, resourceKey])

  useEffect(() => {
    if (!current || scrollToBottomToken <= lastScrolledTokenRef.current) return
    lastScrolledTokenRef.current = scrollToBottomToken
    let timer: number | null = null
    const frame = requestAnimationFrame(() => {
      const scrollToBottom = (): void => {
        const container = previewScrollRef.current
        if (container) container.scrollTop = container.scrollHeight
      }
      scrollToBottom()
      timer = window.setTimeout(scrollToBottom, 200)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [current, scrollToBottomToken])

  if (editing) {
    return (
      <RequirementMarkdownEditor
        requirementId={requirementId}
        title={title}
        filePath={filePath}
        content={content}
        onSaved={(nextContent) => {
          setLoaded({ key: resourceKey, content: nextContent, error: null })
          setEditingKey(null)
          onEditingChange?.(false)
        }}
        onCancel={() => {
          setEditingKey(null)
          onEditingChange?.(false)
        }}
      />
    )
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-white transition-colors duration-200 hover:border-primary/70">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-slate-100/80 px-3.5">
        <span className="text-xs font-semibold text-foreground/75">MD 预览</span>
        <span
          className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground/80"
          title={filePath}
        >
          {filePath.replace(/^\/+/, "")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-primary hover:text-primary"
          disabled={loading || Boolean(error)}
          onClick={() => {
            setEditingKey(resourceKey)
            onEditingChange?.(true)
          }}
        >
          <Pencil className="size-3" />
          可编辑
        </Button>
      </header>
      <div ref={previewScrollRef} className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取 PRD
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive">
            {error}
          </div>
        ) : (
          <MarkdownPreview
            content={content}
            path={filePath}
            showHeader={false}
            showModeToggle={false}
            whiteBackground
            className="min-h-full"
            readBinaryFile={readPreviewImage}
            readHtmlFile={readPreviewHtml}
            onOpenLocalFile={onOpenAttachment}
          />
        )}
      </div>
    </section>
  )
}
