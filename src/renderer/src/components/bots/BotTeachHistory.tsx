import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useRef, useState } from "react"
import { Download, Film, Loader2, Play, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { loadBotTeachVideo } from "@/lib/bot-teach-video"
import type { BotTeachSession } from "../../../../shared/bot-teach"

const phases: Record<BotTeachSession["phase"], string> = {
  recording: "正在录制",
  paused: "已暂停",
  finalizing: "正在保存",
  queued: "等待学习",
  learning: "正在学习",
  ready: "已生成技能",
  failed: "学习未完成",
  interrupted: "录制中断",
  discarded: "已删除"
}

export function BotTeachHistory({
  botId,
  close,
  onCloseAutoFocus
}: {
  botId: string
  close(): void
  onCloseAutoFocus?(event: Event): void
}) {
  const [items, setItems] = useState<BotTeachSession[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const load = useRef<AbortController | null>(null)
  const objectUrl = useRef<string | null>(null)
  const refresh = useCallback(
    async (before?: string) => {
      setLoading(true)
      setError(null)
      try {
        const page = await botApi.teachHistory({ botId, ...(before ? { before } : {}) })
        if (alive.current) {
          setItems((old) =>
            before
              ? [...old, ...page.items.filter((item) => !old.some((value) => value.id === item.id))]
              : page.items
          )
          setCursor(page.nextCursor)
        }
      } catch (failure) {
        if (alive.current) setError(failure instanceof Error ? failure.message : "记录加载失败")
      } finally {
        if (alive.current) setLoading(false)
      }
    },
    [botId]
  )
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      load.current?.abort()
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [refresh])
  const preview = async (session: BotTeachSession) => {
    load.current?.abort()
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    setUrl(null)
    setSelected(session.id)
    setProgress(0)
    setError(null)
    const controller = new AbortController()
    load.current = controller
    try {
      const blob = await loadBotTeachVideo(
        session,
        (input) => botApi.teachVideoChunk(input),
        controller.signal,
        setProgress
      )
      if (controller.signal.aborted || !alive.current) return
      objectUrl.current = URL.createObjectURL(blob)
      setUrl(objectUrl.current)
    } catch (failure) {
      if (!controller.signal.aborted && alive.current)
        setError(failure instanceof Error ? failure.message : "录像加载失败")
    } finally {
      if (!controller.signal.aborted && alive.current) setProgress(null)
    }
  }
  const remove = async (session: BotTeachSession) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await botApi.teachDelete({ id: session.id, revision: session.revision })
      if (!alive.current) return
      if (selected === session.id) {
        load.current?.abort()
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
        objectUrl.current = null
        setUrl(null)
        setSelected(null)
        setProgress(null)
      }
      setRemoving(null)
      await refresh()
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "删除失败")
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>示范记录</DialogTitle>
          <DialogDescription>
            回看或导出浏览器示范。录制保留至手动删除，存储上限 2
            GB；删除录制会保留已生成的技能和试跑记录。
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || busy}
            onClick={() => {
              setRemoving(null)
              void refresh()
            }}
          >
            <RefreshCw size={14} />
            刷新记录
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          {selected && (
            <div className="overflow-hidden rounded-xl border bg-muted/30">
              {url ? (
                <video
                  key={url}
                  aria-label="示范录像"
                  src={url}
                  controls
                  preload="metadata"
                  className="aspect-video w-full object-contain"
                />
              ) : (
                <div
                  className="flex aspect-video items-center justify-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  {progress !== null ? (
                    <>
                      <Loader2 size={18} className="animate-spin" /> 正在加载录像 {progress}%
                    </>
                  ) : (
                    "录像未能加载，请重试"
                  )}
                </div>
              )}
              {url && (
                <div className="flex justify-end border-t p-2">
                  <Button asChild size="sm" variant="ghost">
                    <a href={url} download={`示范-${selected}.webm`}>
                      <Download size={14} /> 导出录像
                    </a>
                  </Button>
                </div>
              )}
            </div>
          )}
          {!loading && !items.length && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Film className="mx-auto mb-3" size={24} />
              暂无示范记录
            </div>
          )}
          {items.map((session) => (
            <div
              key={session.id}
              className={`rounded-xl border p-3 ${selected === session.id ? "border-primary/40 bg-primary/5" : ""}`}
            >
              <div className="flex items-center gap-3">
                <Film size={18} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {new Date(session.startedAt).toLocaleString()}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {phases[session.phase]} · {session.eventCount} 次操作
                    {session.video ? ` · ${(session.video.size / 1024 ** 2).toFixed(1)} MB` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!session.video}
                  onClick={() => void preview(session)}
                >
                  <Play size={14} /> 回看
                </Button>
                {["ready", "failed", "interrupted"].includes(session.phase) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`删除示范 ${session.id}`}
                    disabled={busy}
                    onClick={() => setRemoving(session.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
              {session.error && (
                <p className="mt-2 text-xs text-muted-foreground">{session.error}</p>
              )}
              {removing === session.id && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <p className="text-xs">删除这次录像和学习画面？此操作无法撤销。</p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRemoving(null)}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void remove(session)}
                    >
                      {busy && <Loader2 size={13} className="animate-spin" />}确认删除
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {loading && (
            <p className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              正在读取记录
            </p>
          )}
          {cursor && (
            <Button
              className="w-full"
              variant="ghost"
              disabled={loading}
              onClick={() => void refresh(cursor)}
            >
              加载更早记录
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
