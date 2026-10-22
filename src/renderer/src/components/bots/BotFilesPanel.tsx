import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Download,
  File,
  Folder,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Share2
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import { botLibraryGroups } from "@/lib/bot-library-view"
import type { BotClient, BotDefinition, BotFilePage } from "../../../../shared/bots/contracts"

const relativeId = (path: string) => path.replace(/^\/+/, "")
const message = (error: unknown) => (error instanceof Error ? error.message : "文件操作失败")
export function BotFilesPanel({
  bot,
  peers,
  client,
  group,
  conversationThreadId,
  refreshKey = ""
}: {
  bot: BotDefinition
  peers: BotDefinition[]
  client: BotClient
  group?: { id: string; name: string }
  conversationThreadId?: string
  refreshKey?: string
}) {
  const threadId = conversationThreadId ?? (group ? `group-${group.id}-${bot.id}` : bot.threadId)
  const [page, setPage] = useState<BotFilePage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [cursor, setCursor] = useState<string>()
  const [sharing, setSharing] = useState<string | null>(null)
  const [target, setTarget] = useState("")
  const [mutating, setMutating] = useState(false)
  const scan = useRef<string | null>(null),
    mutation = useRef(false)
  // This is a file library, not a directory browser. Keep the bounded scan/paging protocol.
  const files = page?.files.filter((file) => !file.is_dir) ?? []
  const groups = useMemo(() => botLibraryGroups(page?.files ?? []), [page])
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    void (async () => {
      if (!group) await client.open(bot.id)
      const next = await client.listFiles(bot.id, cursor, group?.id)
      if (disposed) {
        if (next.cursor) await client.cancelFileList(next.cursor)
        return
      }
      scan.current = next.cursor
      setPage(next)
    })()
      .catch((cause) => {
        if (!disposed) setError(message(cause))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [bot.id, group?.id, client, cursor, revision])
  useEffect(
    () => () => {
      if (scan.current) void client.cancelFileList(scan.current).catch(() => {})
    },
    [client]
  )
  const refresh = useCallback(async () => {
    const previousScan = scan.current
    scan.current = null
    if (previousScan) await client.cancelFileList(previousScan)
    setCursor(undefined)
    setRevision((value) => value + 1)
  }, [client])
  const previousRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return
    previousRefreshKey.current = refreshKey
    void refresh().catch((cause) => setError(message(cause)))
  }, [refreshKey, refresh])
  const mutate = async (run: () => Promise<unknown>) => {
    if (mutation.current) return
    mutation.current = true
    setMutating(true)
    try {
      await run()
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      mutation.current = false
      setMutating(false)
    }
  }
  return (
    <section className="bot-files-panel">
      <div className="bot-files-toolbar">
        <span>最近修改</span>
        <div className="flex gap-1">
          <button
            className="bot-icon-button"
            aria-label="刷新资料"
            disabled={loading}
            onClick={() => void refresh().catch((cause) => toast.error(message(cause)))}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="bot-icon-button"
            aria-label="添加资料"
            disabled={mutating || bot.archived}
            onClick={() =>
              void mutate(async () => {
                await client.importFiles(bot.id, group?.id)
                await refresh()
              })
            }
          >
            <Plus size={17} />
          </button>
        </div>
      </div>
      {loading && (
        <div className="flex justify-center py-5">
          <Loader2 className="animate-spin" size={18} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!loading && page && files.length === 0 && (
        <div className="bot-files-empty">
          <Folder size={27} strokeWidth={1.4} />
          <p>
            {page.cursor ? (
              "这一页没有文件，请继续查看下一页。"
            ) : (
              <>
                添加工作资料，或让 Bot 创建文件。
                <br />
                它的工作成果也会出现在这里。
              </>
            )}
          </p>
        </div>
      )}
      <div className="bot-file-list">
        {groups.map(({ label, files: entries }) => (
          <section className="bot-library-group" key={label} aria-label={label}>
            <h3>{label}</h3>
            {entries.map(({ file, timeLabel }) => (
              <div key={file.path} className="bot-file-row">
                <button
                  className="bot-file-name"
                  title={file.path}
                  onClick={() =>
                    emitOpenResourcePreview({
                      threadId,
                      filePath: relativeId(file.path),
                      workspacePathKind: "relative"
                    })
                  }
                >
                  <File size={20} strokeWidth={1.4} aria-hidden="true" />
                  <span className="bot-library-file-label">
                    <span>{file.path.split(/[\\/]/).pop() || relativeId(file.path)}</span>
                    {timeLabel && (
                      <time
                        dateTime={file.modified_at}
                        title={`修改于 ${new Date(file.modified_at!).toLocaleString()}`}
                      >
                        {timeLabel}
                      </time>
                    )}
                  </span>
                </button>
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="bot-icon-button" aria-label={`${file.path}的操作`}>
                      <MoreHorizontal size={16} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    data-bot-popup
                    align="end"
                    className="bot-workspace-menu w-44 rounded-xl p-1.5"
                  >
                    <button
                      className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent w-full"
                      onClick={() =>
                        void mutate(() =>
                          client.exportFile(bot.id, relativeId(file.path), group?.id)
                        )
                      }
                    >
                      <Download size={14} />
                      保存到本机
                    </button>
                    <button
                      className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent w-full"
                      onClick={() => {
                        setTarget("")
                        setSharing(relativeId(file.path))
                      }}
                    >
                      <Share2 size={14} />
                      分享给 Bot
                    </button>
                  </PopoverContent>
                </Popover>
              </div>
            ))}
          </section>
        ))}
      </div>
      {page?.cursor && (
        <button
          className="bot-files-next"
          disabled={loading}
          onClick={() => setCursor(page.cursor!)}
        >
          下一页
        </button>
      )}
      {sharing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !mutating) setSharing(null)
          }}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>分享资料</DialogTitle>
              <DialogDescription>
                将此文件的副本加入所选 Bot 的工作资料。后续修改不会自动同步。
              </DialogDescription>
            </DialogHeader>
            <label className="bot-field">
              接收 Bot
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                <option value="">选择 Bot</option>
                {peers
                  .filter(
                    (peer) => (group || peer.id !== bot.id) && !peer.archived && !peer.deleting
                  )
                  .map((peer) => (
                    <option key={peer.id} value={peer.id}>
                      {peer.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="bot-browser-control justify-center"
              disabled={!target || mutating}
              onClick={() =>
                void mutate(async () => {
                  await client.shareFile(bot.id, sharing, target, group?.id)
                  setSharing(null)
                  toast.success("资料已分享")
                })
              }
            >
              分享文件副本
            </button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
