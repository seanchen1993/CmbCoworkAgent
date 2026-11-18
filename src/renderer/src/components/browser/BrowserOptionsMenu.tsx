import {
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  Loader2,
  Minus,
  MoreVertical,
  Plus,
  RotateCcw,
  XCircle
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type {
  BrowserDownloadRecord,
  BrowserDownloadsChangedPayload
} from "../../../../shared/browser-types"

interface BrowserOptionsMenuProps {
  browserCreated: boolean
  zoomFactor: number
  onZoomChange: (zoomFactor: number) => void
}

export const BROWSER_ZOOM_STEP = 0.25
export const MIN_BROWSER_ZOOM_FACTOR = 0.25
export const MAX_BROWSER_ZOOM_FACTOR = 5
const BROWSER_DOWNLOAD_HISTORY_STORAGE_KEY = "browser-download-history-v1"

function readStoredDownloads(): BrowserDownloadsChangedPayload {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(BROWSER_DOWNLOAD_HISTORY_STORAGE_KEY) ?? "null"
    ) as Partial<BrowserDownloadsChangedPayload> | null
    return {
      records: Array.isArray(parsed?.records) ? (parsed.records as BrowserDownloadRecord[]) : [],
      hasUnreadCompleted: parsed?.hasUnreadCompleted === true
    }
  } catch {
    return { records: [], hasUnreadCompleted: false }
  }
}

function storeDownloads(snapshot: BrowserDownloadsChangedPayload): void {
  try {
    localStorage.setItem(
      BROWSER_DOWNLOAD_HISTORY_STORAGE_KEY,
      JSON.stringify({
        records: snapshot.records.slice(0, 100),
        hasUnreadCompleted: snapshot.hasUnreadCompleted
      })
    )
  } catch {
    // Download history persistence is best-effort; active downloads still work without it.
  }
}

function statusText(record: BrowserDownloadRecord): string {
  if (record.status === "completed") return "已完成"
  if (record.status === "cancelled") return "已取消"
  if (record.status === "interrupted") return "下载失败"
  return "下载中"
}

export function BrowserOptionsMenu({
  browserCreated,
  zoomFactor,
  onZoomChange
}: BrowserOptionsMenuProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyOpenRef = useRef(false)
  const [records, setRecords] = useState<BrowserDownloadRecord[]>([])
  const [downloadDirectory, setDownloadDirectory] = useState("")
  const [hasUnreadDownload, setHasUnreadDownload] = useState(false)
  const currentZoomFactor = zoomFactor || 1
  const browserZoomPercent = Math.round(currentZoomFactor * 100)
  const canZoomOut = browserCreated && currentZoomFactor > MIN_BROWSER_ZOOM_FACTOR
  const canZoomIn = browserCreated && currentZoomFactor < MAX_BROWSER_ZOOM_FACTOR

  useEffect(() => {
    const unsubscribe = window.api.browser.onDownloadsChanged((payload) => {
      setRecords(payload.records)
      setHasUnreadDownload(payload.hasUnreadCompleted && !historyOpenRef.current)
      storeDownloads({
        records: payload.records,
        hasUnreadCompleted: payload.hasUnreadCompleted && !historyOpenRef.current
      })
      if (payload.hasUnreadCompleted && historyOpenRef.current) {
        void window.api.browser.markDownloadsRead().then(storeDownloads)
      }
    })
    void Promise.all([
      window.api.browser.getDownloads(),
      window.api.browser.getDownloadDirectory()
    ]).then(async ([currentSnapshot, directory]) => {
      const storedSnapshot = readStoredDownloads()
      const currentIds = new Set(currentSnapshot.records.map((record) => record.id))
      const mergedSnapshot: BrowserDownloadsChangedPayload = {
        records: [
          ...currentSnapshot.records,
          ...storedSnapshot.records.filter((record) => !currentIds.has(record.id))
        ].slice(0, 100),
        hasUnreadCompleted: currentSnapshot.hasUnreadCompleted || storedSnapshot.hasUnreadCompleted
      }
      const restoredSnapshot = await window.api.browser.restoreDownloads(mergedSnapshot)
      setRecords(restoredSnapshot.records)
      setHasUnreadDownload(restoredSnapshot.hasUnreadCompleted)
      setDownloadDirectory(directory)
      storeDownloads(restoredSnapshot)
    })
    return unsubscribe
  }, [])

  const openDownloadHistory = (): void => {
    setMenuOpen(false)
    historyOpenRef.current = true
    setHistoryOpen(true)
    setHasUnreadDownload(false)
    void window.api.browser.markDownloadsRead().then(storeDownloads)
  }

  const handleHistoryOpenChange = (open: boolean): void => {
    historyOpenRef.current = open
    setHistoryOpen(open)
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
            aria-label="浏览器菜单"
            title="浏览器菜单"
          >
            <MoreVertical className="size-4" strokeWidth={1.8} />
            {hasUnreadDownload && (
              <span className="absolute bottom-0.5 right-0.5 size-2 rounded-full bg-emerald-500 ring-1 ring-background" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="left"
          sideOffset={8}
          avoidCollisions={false}
          className="w-64 rounded-lg border-border bg-background-elevated p-2 shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 px-1 py-1.5">
            <span className="text-sm font-medium text-foreground">缩放</span>
            <div className="inline-flex h-8 overflow-hidden rounded-md border border-border bg-muted/40">
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-muted disabled:opacity-40"
                aria-label="缩小"
                disabled={!canZoomOut}
                onClick={() => onZoomChange(currentZoomFactor - BROWSER_ZOOM_STEP)}
              >
                <Minus className="size-3.5" />
              </button>
              <div className="flex min-w-14 items-center justify-center border-x border-border px-2 text-sm tabular-nums">
                {browserZoomPercent}%
              </div>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-muted disabled:opacity-40"
                aria-label="放大"
                disabled={!canZoomIn}
                onClick={() => onZoomChange(currentZoomFactor + BROWSER_ZOOM_STEP)}
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
              aria-label="恢复默认缩放"
              disabled={!browserCreated || browserZoomPercent === 100}
              onClick={() => onZoomChange(1)}
            >
              <RotateCcw className="size-4" />
            </button>
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground hover:bg-muted"
            onClick={openDownloadHistory}
          >
            <span className="flex-1 text-left">下载历史</span>
            {records.some((record) => record.status === "progressing") && (
              <Loader2 className="size-3.5 animate-spin text-primary" />
            )}
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        </PopoverContent>
      </Popover>

      <Dialog open={historyOpen} onOpenChange={handleHistoryOpenChange}>
        <DialogContent className="flex max-h-[min(680px,80vh)] flex-col gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>下载历史</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-5 py-3">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <div
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={downloadDirectory}
            >
              下载文件保存到：{downloadDirectory || "系统下载文件夹"}
            </div>
            <button
              type="button"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="打开下载文件夹"
              aria-label="打开下载文件夹"
              onClick={() => void window.api.browser.openDownloadDirectory()}
            >
              <FolderOpen className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {records.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">暂无下载记录</div>
            ) : (
              records.map((record) => (
                <div
                  key={record.id}
                  className="flex items-start gap-3 rounded-lg px-3 py-3 hover:bg-muted/50"
                >
                  {record.status === "progressing" ? (
                    <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
                  ) : record.status === "completed" ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={record.fileName}>
                      {record.fileName}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{statusText(record)}</div>
                  </div>
                  {record.status === "completed" && (
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="在文件夹中显示"
                      onClick={() => void window.api.browser.showDownloadInFolder(record.id)}
                    >
                      <FolderOpen className="size-4" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
