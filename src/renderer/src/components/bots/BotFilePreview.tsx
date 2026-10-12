import { botApi } from "@/lib/bot-api"
import {
  botMessageAttachment,
  sameBotMessageAttachment,
  type BotMessageAttachment
} from "../../../../shared/bot-message-attachments"
import { lazy, Suspense, useEffect, useState, type ComponentPropsWithoutRef } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileQuestion,
  Loader2,
  RotateCw,
  X
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { CodeViewer } from "@/components/tabs/CodeViewer"
import { ImageViewer } from "@/components/tabs/ImageViewer"
import { MediaViewer } from "@/components/tabs/MediaViewer"
import { HtmlPreview } from "@/components/chat/previews/HtmlPreview"
import MarkdownPreview from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { loadBotFile } from "@/lib/bot-file-transfer"
import { botFileLabel } from "@/lib/bot-file-label"
import { downloadBotFile } from "@/lib/bot-file-download"
import type { BotFilePreview as Preview } from "../../../../shared/bot-file-preview"
import { BotTablePreview } from "./BotTablePreview"
import { botTableText } from "../../../../shared/bot-table-preview"
import {
  botPeerMessageImage,
  botPeerMessageImages,
  type BotPeerMessageImage
} from "../../../../shared/bot-peer-images"
import { BotPeerImages } from "./BotPeerImages"

const BotPdfPreview = lazy(() =>
  import("./BotPdfPreview").then((module) => ({ default: module.BotPdfPreview }))
)

function FileView({
  preview,
  url,
  navigateTable,
  media,
  close,
  navigateMedia,
  download
}: {
  preview: Preview
  url: string | null
  navigateTable(sheet: number, rowOffset: number, columnOffset: number): void
  media?: BotPeerMessageImage
  close(): void
  navigateMedia?: (direction: -1 | 1) => void
  download(): void
}) {
  const name = preview.artifact.name
  if (preview.kind === "presentation" && url)
    return (
      <>
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          保存布局预览 · 可下载并编辑 PowerPoint 原件，Office 显示可能因字体有所差异。
        </p>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-5">
          <img
            className="max-h-full max-w-full rounded-md border shadow-sm"
            src={url}
            alt={`第 ${preview.presentation.page + 1} 页幻灯片`}
          />
        </div>
      </>
    )
  if (preview.kind === "table")
    return (
      <BotTablePreview
        key={`${preview.table.sheet}:${preview.table.rowOffset}:${preview.table.columnOffset}`}
        table={preview.table}
        navigate={navigateTable}
      />
    )
  if (preview.kind === "image" && url) {
    if (media)
      return (
        <ImageViewer
          key={url}
          filePath={name}
          sourceUrl={url}
          presentation="lightbox"
          onBackdropClick={close}
          onNavigate={navigateMedia}
        />
      )
    return (
      <>
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          静态预览 · 原图 {preview.image.originalWidth} × {preview.image.originalHeight} ·
          保存可获取原文件
        </p>
        <ImageViewer filePath={name} sourceUrl={url} />
      </>
    )
  }
  if (preview.kind === "pdf" && url)
    return (
      <Suspense
        fallback={
          <p role="status" className="p-5 text-sm text-muted-foreground">
            正在打开 PDF…
          </p>
        }
      >
        <BotPdfPreview sourceUrl={url} onDownload={download} />
      </Suspense>
    )
  if ((preview.kind === "video" || preview.kind === "audio") && url)
    return (
      <MediaViewer
        filePath={name}
        sourceUrl={url}
        mediaType={preview.kind}
        mimeType={preview.mime}
      />
    )
  if ("page" in preview) {
    if (preview.kind === "html" && preview.page.offset === 0 && !preview.page.hasMore)
      return <HtmlPreview content={preview.page.text} path={name} fillHeight />
    if (preview.kind === "markdown")
      return (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <MarkdownPreview content={preview.page.text} path={name} showHeader={false} />
        </div>
      )
    return (
      <>
        {preview.kind === "document" && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground">
            正文预览；完整排版和内嵌图片请保存原文件查看。
          </p>
        )}
        {preview.kind === "html" && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground">
            文件较长，分页显示原文。保存原文件可查看完整页面。
          </p>
        )}
        <CodeViewer filePath={name} content={preview.page.text} />
      </>
    )
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
      <FileQuestion size={36} strokeWidth={1.25} />
      <p>此格式暂不支持预览，可保存原文件查看。</p>
    </div>
  )
}

export function BotFilePreview({
  id,
  conversationId,
  showDownloads,
  close,
  onCloseAutoFocus,
  media,
  mediaGroup,
  selectMedia,
  expectedArtifact
}: {
  id: string
  conversationId: string
  showDownloads?: () => void
  close(): void
  onCloseAutoFocus?: ComponentPropsWithoutRef<typeof DialogContent>["onCloseAutoFocus"]
  /** Opt in only from an already scoped, immutable image gallery descriptor. */
  media?: BotPeerMessageImage
  mediaGroup?: BotPeerMessageImage[]
  /** Bound by the already projected message, not a caller-supplied display filename. */
  expectedArtifact?: BotMessageAttachment
  selectMedia?: (id: string) => void
}) {
  const [loaded, setLoaded] = useState<{
    key: string
    resourceKey: string
    preview: Preview | null
    url: string | null
    error: string | null
  } | null>(null)
  const [loadProgress, setLoadProgress] = useState<{ key: string; value: number } | null>(null)
  const [pages, setPages] = useState([0]),
    [retry, setRetry] = useState(0)
  const [sheet, setSheet] = useState(0)
  const [columnOffset, setColumnOffset] = useState(0)
  const offset = pages.at(-1)!
  const mediaIdentity = media ? JSON.stringify(media) : null
  const artifactIdentity = expectedArtifact ? JSON.stringify(expectedArtifact) : null
  const resourceKey = JSON.stringify([id, conversationId, mediaIdentity, artifactIdentity])
  const key = JSON.stringify([
    id,
    conversationId,
    offset,
    retry,
    sheet,
    columnOffset,
    mediaIdentity,
    artifactIdentity
  ])
  const current = loaded?.key === key ? loaded : null
  const loading = current === null,
    preview = current?.preview ?? null,
    url = current?.url ?? null,
    error = current?.error ?? null
  const progress = loadProgress?.key === key ? loadProgress.value : 0
  // Keep verified file metadata while a page loads, never its old pixels or text.
  // A different artifact/gallery descriptor cannot inherit this metadata.
  const retained = loading && loaded?.resourceKey === resourceKey ? loaded.preview : null
  const artifact = preview?.artifact ?? retained?.artifact
  const presentation =
    preview?.kind === "presentation"
      ? preview.presentation
      : retained?.kind === "presentation"
        ? retained.presentation
        : null
  const parsedGroup = botPeerMessageImages.safeParse(mediaGroup)
  const group =
    media &&
    parsedGroup.success &&
    parsedGroup.data.some((image) => image.id === id && JSON.stringify(image) === mediaIdentity)
      ? parsedGroup.data
      : []
  const index = group.findIndex((image) => image.id === id)
  const navigateMedia =
    group.length > 1 && selectMedia
      ? (direction: -1 | 1) =>
          selectMedia(group[(index + direction + group.length) % group.length].id)
      : undefined
  useEffect(() => {
    const abort = new AbortController(),
      requestId = crypto.randomUUID()
    let ownedUrl: string | null = null
    const load = async () => {
      const result = await botApi.filePreview({
        id,
        conversationId,
        requestId,
        offset,
        sheet,
        columnOffset
      })
      abort.signal.throwIfAborted()
      if (result.artifact.id !== id || result.artifact.conversationId !== conversationId)
        throw new Error("预览文件身份不一致")
      if (
        artifactIdentity &&
        !sameBotMessageAttachment(
          result.artifact,
          botMessageAttachment.parse(JSON.parse(artifactIdentity))
        )
      )
        throw new Error("附件身份或版本已变化，请重新选择")
      if (mediaIdentity) {
        const expected = botPeerMessageImage.parse(JSON.parse(mediaIdentity))
        if (
          expected.id !== id ||
          result.kind !== "image" ||
          result.artifact.sha256 !== expected.sha256 ||
          result.artifact.name !== expected.name ||
          result.artifact.mime !== expected.mime ||
          result.artifact.size !== expected.size ||
          result.image.base64.length > Math.ceil((1024 * 1024) / 3) * 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image.base64)
        )
          throw new Error("图片身份或预览内容已变化，请重新选择")
      }
      if (result.kind === "presentation") {
        const page = result.presentation
        if (
          page.page !== offset ||
          page.pageCount < 1 ||
          page.pageCount > 20 ||
          page.page >= page.pageCount ||
          page.width !== 960 ||
          page.height !== 540 ||
          page.base64.length > 1_400_000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(page.base64)
        )
          throw new Error("幻灯片预览数据无效")
        const bytes = Uint8Array.from(atob(page.base64), (character) => character.charCodeAt(0))
        ownedUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
      } else if (result.kind === "image") {
        const binary = atob(result.image.base64)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        if (mediaIdentity && bytes.byteLength > 1024 * 1024) throw new Error("图片预览超出允许大小")
        ownedUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }))
      } else if (result.kind === "audio" || result.kind === "video" || result.kind === "pdf") {
        const file = await loadBotFile(
          id,
          (input) => botApi.fileChunk(input),
          abort.signal,
          (value) => {
            if (!abort.signal.aborted) setLoadProgress({ key, value })
          }
        )
        if (
          file.artifact.sha256 !== result.artifact.sha256 ||
          file.artifact.conversationId !== conversationId
        )
          throw new Error("预览文件版本不一致")
        if (result.kind === "pdf" && !(await file.blob.slice(0, 1024).text()).includes("%PDF-"))
          throw new Error("文件不是有效的 PDF")
        abort.signal.throwIfAborted()
        ownedUrl = URL.createObjectURL(file.blob.slice(0, file.blob.size, result.mime))
      }
      abort.signal.throwIfAborted()
      setLoaded({ key, resourceKey, preview: result, url: ownedUrl, error: null })
    }
    void load().catch((failure) => {
      if (ownedUrl) URL.revokeObjectURL(ownedUrl)
      if (!abort.signal.aborted)
        setLoaded({
          key,
          resourceKey,
          preview: null,
          url: null,
          error: failure instanceof Error ? failure.message : "文件预览失败"
        })
    })
    return () => {
      abort.abort(new Error("预览已关闭"))
      if (ownedUrl) URL.revokeObjectURL(ownedUrl)
      void botApi.cancelFilePreview({ conversationId, requestId }).catch(() => {})
    }
  }, [
    id,
    conversationId,
    offset,
    key,
    resourceKey,
    sheet,
    columnOffset,
    mediaIdentity,
    artifactIdentity
  ])
  const page = preview && "page" in preview ? preview.page : null
  const table = preview?.kind === "table" ? preview.table : null
  const copyLabel = table ? "复制本页表格" : "复制本页文本"
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        data-media-preview={media ? "true" : undefined}
        style={media ? { width: "100vw", borderRadius: 0 } : undefined}
        className={
          media
            ? "left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-black/85 p-0 text-white shadow-none backdrop-blur-sm data-[state=open]:animate-none data-[state=closed]:animate-none sm:max-w-none sm:rounded-none [&>button:last-child]:hidden"
            : "flex h-[min(82vh,850px)] max-w-[min(1100px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        }
      >
        {media ? (
          <>
            <DialogTitle className="sr-only">
              {media.alt || media.name}
              {group.length > 1 ? ` · ${index + 1}/${group.length}` : ""}
            </DialogTitle>
            <DialogDescription className="sr-only">
              图片静态预览；保存可获取原文件。点击放大，拖动查看，按 Escape 关闭。
            </DialogDescription>
            <div className="absolute right-4 top-4 z-10 flex gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-10 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white focus-visible:ring-white motion-reduce:transition-none"
                aria-label="保存原文件"
                title="保存原文件"
                disabled={loading || Boolean(error) || !preview}
                onClick={() => void downloadBotFile(id, preview?.artifact, showDownloads)}
              >
                <Download size={19} />
              </Button>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-10 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white focus-visible:ring-white motion-reduce:transition-none"
                  aria-label="Close"
                  title="关闭预览"
                >
                  <X size={21} />
                </Button>
              </DialogClose>
            </div>
          </>
        ) : (
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle className="truncate">{artifact?.name ?? "文件预览"}</DialogTitle>
                <DialogDescription className="mt-1 text-xs">
                  {artifact ? botFileLabel(artifact) : "正在读取文件"}
                </DialogDescription>
              </div>
              <div className="flex shrink-0 gap-1">
                {(page || table) && !loading && !error && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={copyLabel}
                    aria-label={copyLabel}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(page?.text ?? botTableText(table!.rows))
                        .then(() => toast.success(table ? "已复制本页表格" : "已复制本页文本"))
                        .catch(() => toast.error("复制失败"))
                    }
                  >
                    <Copy size={15} />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!artifact}
                  onClick={() => void downloadBotFile(id, artifact, showDownloads)}
                >
                  <Download size={15} />
                  保存原文件
                </Button>
              </div>
            </div>
          </DialogHeader>
        )}
        <div
          className={
            media
              ? "flex min-h-0 flex-1 flex-col px-4 pb-4 pt-20 sm:px-12"
              : "flex min-h-0 flex-1 flex-col"
          }
          onErrorCapture={() =>
            setLoaded((previous) =>
              previous?.key === key
                ? { ...previous, error: "此文件无法预览，请保存原文件查看" }
                : previous
            )
          }
        >
          {loading ? (
            <div
              className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 size={18} className="animate-spin" />
              {progress ? `正在读取 ${progress}%` : "正在准备预览"}
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-5">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                <RotateCw size={14} />
                重新加载
              </Button>
            </div>
          ) : (
            preview && (
              <FileView
                preview={preview}
                url={url}
                media={media}
                navigateMedia={navigateMedia}
                close={close}
                download={() => void downloadBotFile(id, preview.artifact, showDownloads)}
                navigateTable={(nextSheet, nextRow, nextColumn) => {
                  setSheet(nextSheet)
                  setColumnOffset(nextColumn)
                  setPages([nextRow])
                }}
              />
            )
          )}
        </div>
        {media && (
          <p className="shrink-0 px-6 pb-6 text-center text-sm leading-6 text-white/80 [overflow-wrap:anywhere]">
            {media.alt || media.name}
            {group.length > 1 ? ` · ${index + 1}/${group.length}` : ""}
          </p>
        )}
        {media && group.length > 1 && (
          <div className="flex shrink-0 justify-center pb-2">
            <BotPeerImages
              images={group}
              conversationId={conversationId}
              presentation="filmstrip"
              label="图片缩略图"
              currentId={id}
              select={selectMedia}
            />
          </div>
        )}
        {presentation && !error && (
          <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              第 {offset + 1} / {presentation.pageCount} 页
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-label="上一张幻灯片"
                // Keep paging focus while unavailable, including the first/last page.
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                aria-disabled={loading || offset === 0}
                onKeyDown={(event) => {
                  if ((loading || offset === 0) && (event.key === "Enter" || event.key === " "))
                    event.preventDefault()
                }}
                onClick={() => {
                  if (!loading && offset > 0) setPages([offset - 1])
                }}
              >
                <ChevronLeft size={16} />
                上一页
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="下一张幻灯片"
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                aria-disabled={loading || offset + 1 >= presentation.pageCount}
                onKeyDown={(event) => {
                  if (
                    (loading || offset + 1 >= presentation.pageCount) &&
                    (event.key === "Enter" || event.key === " ")
                  )
                    event.preventDefault()
                }}
                onClick={() => {
                  if (!loading && offset + 1 < presentation.pageCount) setPages([offset + 1])
                }}
              >
                下一页
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        )}
        {page && !loading && !error && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              {page.totalCharacters
                ? `${page.offset + 1}–${Math.min(page.offset + page.text.length, page.totalCharacters)} / ${page.totalCharacters} 字符`
                : "空文件"}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-label="上一页文本"
                disabled={pages.length <= 1}
                onClick={() => setPages((value) => value.slice(0, -1))}
              >
                <ChevronLeft size={16} />
                上一页
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="下一页文本"
                disabled={page.nextOffset === null}
                onClick={() => {
                  if (page.nextOffset !== null) setPages((value) => [...value, page.nextOffset!])
                }}
              >
                下一页
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
