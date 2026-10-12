import { botApi } from "@/lib/bot-api"
import { useEffect, useRef, useState } from "react"
import { ArrowLeft, History, Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useAppStore } from "@/lib/store"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgeContextImport,
  readPendingContextImport,
  rememberContextImport,
  selectableBotContextMessages
} from "@/lib/bot-context-import"
import {
  BOT_CONTEXT_MAX_CHARACTERS,
  BOT_CONTEXT_MAX_MESSAGES,
  botContextDraft,
  type BotContextDraft,
  type BotContextImport as ImportInput
} from "../../../../shared/bot-context-import"
import type { BotMessage, CoworkBot } from "../../../../shared/bot-types"

type Selection = BotContextDraft["messages"][number]
const definiteErrors = new Set(["invalid_input", "not_found", "nonce_conflict", "bot_deleted"])

export function BotImportedContext({ message }: { message: BotMessage }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = message.importedContext
  if (!source) return null
  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const original = await window.api.threads.get(source.threadId)
      if (!original) throw new Error("原任务已删除或不可用，导入的快照仍可查看。")
      useAppStore.getState().addThreadSummary(original)
      await useAppStore.getState().selectThread(original.thread_id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "原任务打开失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-sm font-medium">
        {source.title} · {source.messageIds.length} 条记录
      </summary>
      <p className="text-xs text-muted-foreground">
        用户选择的历史快照，原任务的后续修改不会自动同步。
      </p>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
        {message.text}
      </pre>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void open()}>
        {busy ? "正在打开…" : "打开原任务"}
      </Button>
    </details>
  )
}

/** Import only explicitly checked text. Reading an old task never opens its tools or files. */
export function BotContextImport({
  bot,
  close,
  onImported
}: {
  bot: CoworkBot
  close(): void
  onImported(conversationId: string, messageId: string): void
}) {
  const epoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(epoch)
  const restored = epoch !== editingEpoch
  const [pending, setPending] = useState(() => readPendingContextImport(bot.id, epoch))
  const [source, setSource] = useState<BotContextDraft["source"] | null>(
    pending?.draft.source ?? null
  )
  const [items, setItems] = useState<Selection[]>(pending?.draft.messages ?? [])
  const [selected, setSelected] = useState<Selection[]>(pending?.draft.messages ?? [])
  const [cursor, setCursor] = useState<{ beforeOrdinal: number; beforeMessageId: string } | null>(
    null
  )
  const [omitted, setOmitted] = useState(0)
  const [query, setQuery] = useState("")
  const [directoryPage, setDirectoryPage] = useState(0)
  const [directoryLoading, setDirectoryLoading] = useState(!pending)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef({ sequence: 0 }),
    saving = useRef(false),
    alive = useRef(true)
  const threads = useAppStore((state) => state.threads)
  const more = useAppStore((state) => state.threadDirectoryHasMore)
  const loadingMore = useAppStore((state) => state.threadDirectoryLoadingMore)
  const matchingThreads = threads.filter((thread) =>
    (thread.title || thread.thread_id).toLowerCase().includes(query.trim().toLowerCase())
  )
  const visiblePage = Math.min(
    directoryPage,
    Math.max(0, Math.ceil(matchingThreads.length / 40) - 1)
  )
  useEffect(() => {
    alive.current = true
    const fence = request.current
    if (!pending)
      void useAppStore
        .getState()
        .loadThreads()
        .catch((failure) => {
          if (alive.current)
            setError(failure instanceof Error ? failure.message : "任务列表读取失败")
        })
        .finally(() => {
          if (alive.current) setDirectoryLoading(false)
        })
    return () => {
      alive.current = false
      ++fence.sequence
    }
    // The selection is a snapshot; directory refreshes must not replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const read = async (target: BotContextDraft["source"], before?: typeof cursor) => {
    const generation = ++request.current.sequence
    setLoading(true)
    setError(null)
    try {
      const page = await window.api.threads.getMessagesPage(target.threadId, {
        limit: 40,
        byteBudget: 256_000,
        ...(before ?? {})
      })
      if (generation !== request.current.sequence) return
      const candidates = selectableBotContextMessages(page.messages, page.truncatedMessageIds)
      setItems(candidates)
      setOmitted(page.messages.length - candidates.length)
      setCursor(
        page.hasMore && page.beforeOrdinal !== null && page.beforeMessageId !== null
          ? { beforeOrdinal: page.beforeOrdinal, beforeMessageId: page.beforeMessageId }
          : null
      )
      if (!page.messages.length)
        setError("此任务暂无可导入的文字。旧版任务可先打开原任务加载历史记录，再返回选择。")
    } catch (failure) {
      if (generation === request.current.sequence)
        setError(failure instanceof Error ? failure.message : "任务记录读取失败")
    } finally {
      if (generation === request.current.sequence) setLoading(false)
    }
  }
  const choose = (target: BotContextDraft["source"]) => {
    setSource(target)
    setItems([])
    setSelected([])
    setCursor(null)
    void read(target)
  }
  const draft = source
    ? {
        source,
        messages: [...selected].sort(
          (a, b) => (a.ordinal ?? a.createdAt ?? 0) - (b.ordinal ?? b.createdAt ?? 0)
        )
      }
    : null
  const validation = botContextDraft.safeParse(draft)
  const characters = selected.reduce((sum, item) => sum + item.text.length, 0)
  const submit = async () => {
    if (saving.current || restored || (!pending && !validation.success)) return
    const input: ImportInput = pending ?? {
      nonce: crypto.randomUUID(),
      botId: bot.id,
      draft: validation.data!
    }
    try {
      rememberContextImport(input, epoch)
    } catch (failure) {
      setError((failure as Error).message)
      return
    }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const receipt = await botApi.importThreadContext(input)
      acknowledgeContextImport(input, epoch)
      if (!alive.current) return
      setPending(null)
      onImported(receipt.conversationId, receipt.messageId)
    } catch (failure) {
      if (!alive.current) return
      if (definiteErrors.has((failure as { code?: string })?.code ?? "")) {
        acknowledgeContextImport(input, epoch)
        setPending(null)
        setError(failure instanceof Error ? failure.message : "导入未成功")
      } else {
        setPending(input)
        setError("尚未收到导入结果。重试会核对同一次请求，不会重复添加记录。")
      }
    } finally {
      saving.current = false
      if (alive.current) setBusy(false)
    }
  }
  const locked = busy || Boolean(pending) || restored
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={18} /> 导入已有任务记录
          </DialogTitle>
          <DialogDescription>
            为 {bot.name}{" "}
            选择参考文字。只保存勾选内容，不启动任务，不继承旧任务的工具、附件或操作授权。
          </DialogDescription>
        </DialogHeader>
        {restored && (
          <p role="alert" className="text-sm text-destructive">
            工作区数据已恢复，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {pending && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            有一次导入尚未确认，请重试核对。
          </p>
        )}
        {!source ? (
          <div className="min-h-0 space-y-3 overflow-auto">
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-3 text-muted-foreground"
              />
              <Input
                aria-label="筛选已有任务"
                className="pl-9"
                placeholder="按任务名称筛选已加载的记录"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setDirectoryPage(0)
                }}
              />
            </div>
            <div className="space-y-1" aria-label="已有任务">
              {matchingThreads.slice(visiblePage * 40, (visiblePage + 1) * 40).map((thread) => (
                <button
                  key={thread.thread_id}
                  disabled={locked}
                  className="flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-3 text-left transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    choose({
                      threadId: thread.thread_id,
                      title: (thread.title || "未命名任务").slice(0, 200)
                    })
                  }
                >
                  <History size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {thread.title || "未命名任务"}
                  </span>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {new Date(thread.updated_at).toLocaleDateString()}
                  </time>
                </button>
              ))}
            </div>
            {directoryLoading && (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取任务列表…
              </p>
            )}
            {!matchingThreads.length && !directoryLoading && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {query ? "已加载的任务中没有匹配项。" : "暂无已加载的任务记录。"}
              </p>
            )}
            {matchingThreads.length > 40 && (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!visiblePage}
                  onClick={() => setDirectoryPage(visiblePage - 1)}
                >
                  上一页任务
                </Button>
                <span>
                  第 {visiblePage + 1} / {Math.ceil(matchingThreads.length / 40)} 页
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(visiblePage + 1) * 40 >= matchingThreads.length}
                  onClick={() => setDirectoryPage(visiblePage + 1)}
                >
                  下一页任务
                </Button>
              </div>
            )}
            {more && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() =>
                  void useAppStore
                    .getState()
                    .loadMoreThreads()
                    .catch((failure) =>
                      setError(failure instanceof Error ? failure.message : "读取失败")
                    )
                }
              >
                {loadingMore ? "正在加载…" : "加载更多任务"}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b pb-3">
              <Button
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                aria-label="重新选择任务"
                disabled={locked}
                onClick={() => {
                  ++request.current.sequence
                  setSource(null)
                  setLoading(false)
                  setError(null)
                  setSelected([])
                }}
              >
                <ArrowLeft size={16} />
              </Button>
              <h3 className="truncate text-sm font-medium">{source.title}</h3>
            </div>
            <div className="min-h-0 space-y-3 overflow-auto pr-1" aria-label="可选择的历史文字">
              {loading && (
                <p
                  role="status"
                  className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
                >
                  <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
                  正在读取记录…
                </p>
              )}
              {!loading &&
                items.map((item) => {
                  const checked = selected.some((value) => value.id === item.id)
                  return (
                    <label
                      key={item.id}
                      className="block cursor-pointer rounded-xl border bg-muted/15 p-3 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5"
                    >
                      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          aria-label={`选择${item.role === "user" ? "用户" : "助手"}记录 ${item.text.slice(0, 50)}`}
                          disabled={
                            locked || (!checked && selected.length >= BOT_CONTEXT_MAX_MESSAGES)
                          }
                          checked={checked}
                          onChange={(event) =>
                            setSelected((values) =>
                              event.target.checked
                                ? [...values, item]
                                : values.filter((value) => value.id !== item.id)
                            )
                          }
                        />
                        <span>{item.role === "user" ? "用户" : "助手"}</span>
                        {item.createdAt !== undefined && (
                          <time>{new Date(item.createdAt).toLocaleString()}</time>
                        )}
                      </div>
                      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                        {item.text}
                      </pre>
                    </label>
                  )
                })}
              {omitted > 0 && (
                <p className="text-xs text-muted-foreground">
                  本页 {omitted} 条工具、非文字或过长记录未列入，可在原任务查看。
                </p>
              )}
              {cursor && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || loading}
                  onClick={() => void read(source, cursor)}
                >
                  查看更早记录（保留已选）
                </Button>
              )}
              {selected.length > 0 && (
                <details className="rounded-lg border p-3 text-sm">
                  <summary className="cursor-pointer">
                    预览全部已选文字（{selected.length} 条）
                  </summary>
                  <div className="mt-3 space-y-4">
                    {draft?.messages.map((item) => (
                      <div key={item.id}>
                        <p className="mb-1 text-xs text-muted-foreground">
                          {item.role === "user" ? "用户" : "助手"}
                        </p>
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                          {item.text}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <div className="space-y-3 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                已选 {selected.length} / {BOT_CONTEXT_MAX_MESSAGES} 条 ·{" "}
                {characters.toLocaleString()} / {BOT_CONTEXT_MAX_CHARACTERS.toLocaleString()}{" "}
                字符。保存为当前快照，原任务修改不会自动同步。
              </p>
              {selected.length > 0 && !validation.success && (
                <p role="alert" className="text-xs text-destructive">
                  {validation.error.issues[0]?.message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={close}>
                  取消
                </Button>
                <Button
                  disabled={busy || restored || (!pending && (!validation.success || loading))}
                  onClick={() => void submit()}
                >
                  {busy && (
                    <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                  )}
                  {busy ? "导入中…" : pending ? "重试核对导入" : "确认导入选中记录"}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
