import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "@/components/bots/BotDialog"
import { BotErrorNoticeBody } from "@/components/bots/BotErrorNoticeBody"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { formatAttachmentBytes } from "@/components/bots/upstream/grok-composer-draft"
import {
  BOT_ARTIFACT_DOWNLOAD_PAGE,
  BOT_ARTIFACT_DOWNLOAD_HISTORY,
  BOT_ARTIFACT_DOWNLOAD_PENDING,
  type BotArtifactDownloadJob,
  type BotArtifactDownloadPage
} from "../../../../shared/bot-artifact-downloads"
import type { BotArtifactDownloadClient } from "../../lib/bot-artifact-download-client"
import type {
  BotDownloadStartIntent,
  BotDownloadStartRecord
} from "../../lib/bot-artifact-download-starts"
import {
  botDownloadActions,
  botDownloadPercent,
  botDownloadStateLabel,
  botDownloadsAreActive,
  isBotDownloadRevisionConflict,
  projectBotDownloadPage,
  sameBotDownloadSource,
  verifyBotDownloadJob,
  verifyBotDownloadPage,
  type BotDownloadAction
} from "../../lib/bot-artifact-download-view"

export interface BotDownloadsProps {
  client: BotArtifactDownloadClient
  dataEpoch: string
  conversationId?: string
  /** Feed the existing useBotViewVisibility result; hidden views never poll. */
  visible: boolean
  close(): void
}
const actionLabels: Record<BotDownloadAction, string> = {
  pause: "暂停",
  resume: "继续保存",
  cancel: "取消保存",
  reveal: "打开文件夹",
  forget: "移除记录"
}
const actionIcons = {
  pause: Pause,
  resume: Play,
  cancel: X,
  reveal: FolderOpen,
  forget: Trash2
}
const PAGE_COUNT_LIMIT = Math.ceil(
  (BOT_ARTIFACT_DOWNLOAD_HISTORY + BOT_ARTIFACT_DOWNLOAD_PENDING) / BOT_ARTIFACT_DOWNLOAD_PAGE
)

export function BotDownloads(props: BotDownloadsProps) {
  return (
    <DownloadScope
      key={JSON.stringify([props.dataEpoch, props.conversationId ?? null])}
      {...props}
    />
  )
}
function DownloadScope({ client, dataEpoch, conversationId, visible, close }: BotDownloadsProps) {
  const [cursors, setCursors] = useState<string[]>([])
  const [reload, setReload] = useState(0)
  const [loaded, setLoaded] = useState<{
    key: string
    page: BotArtifactDownloadPage
  } | null>(null)
  const latestPage = useRef<typeof loaded>(null)
  const [readError, setReadError] = useState<BotErrorNotice | null>(null)
  const [actionError, setActionError] = useState<BotErrorNotice | null>(null)
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null)
  const [confirmation, setConfirmation] = useState<{
    job: BotArtifactDownloadJob
    action: "cancel" | "forget"
  } | null>(null)
  const [starts, setStarts] = useState<BotDownloadStartRecord>(client.starts.inspect)
  const [acceptedStart, setAcceptedStart] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const observedRead = useRef(0)
  const focus = useRef<{
    owned: boolean
    frame: number
    restore: {
      id: string
      action?: BotDownloadAction
      index: number
      generation: number
      minimumRead: number
    } | null
  }>({ owned: false, frame: 0, restore: null })
  const owner = useRef({
    active: false,
    operation: 0,
    reading: 0,
    executing: false
  })
  const confirm = useRef<HTMLButtonElement>(null)
  const before = cursors.at(-1)
  const key = JSON.stringify([conversationId ?? null, before ?? null, reload])
  const page = loaded?.key === key ? loaded.page : null
  const sourceStarts =
    starts.kind === "valid"
      ? starts.items.filter(
          (intent) => !conversationId || intent.source.conversationId === conversationId
        )
      : []
  useLayoutEffect(() => {
    const current = owner.current
    const restoration = focus.current
    const release = (event: Event) => {
      // The initiating pointer event occurs before act() captures ownership.
      // Any later pointer interaction relinquishes the pending restoration.
      if (event.type === "pointerdown") {
        restoration.owned = false
        return
      }
      if (event.type === "focusin" && event.target === document.body) return
      if (event.target instanceof Node && !root.current?.contains(event.target))
        restoration.owned = false
    }
    const blur = () => {
      restoration.owned = false
    }
    document.addEventListener("pointerdown", release, true)
    document.addEventListener("focusin", release, true)
    window.addEventListener("blur", blur)
    current.active = true
    return () => {
      current.active = false
      current.operation++
      current.reading++
      cancelAnimationFrame(restoration.frame)
      document.removeEventListener("pointerdown", release, true)
      document.removeEventListener("focusin", release, true)
      window.removeEventListener("blur", blur)
    }
  }, [])
  useLayoutEffect(() => {
    const restoration = focus.current,
      request = restoration.restore
    if (
      !request ||
      confirmation !== null ||
      pending !== null ||
      !page ||
      !visible ||
      observedRead.current < request.minimumRead
    )
      return
    restoration.restore = null
    if (!restoration.owned || owner.current.operation !== request.generation) return
    cancelAnimationFrame(restoration.frame)
    restoration.frame = requestAnimationFrame(() => {
      restoration.frame = 0
      if (
        !owner.current.active ||
        !restoration.owned ||
        owner.current.operation !== request.generation
      )
        return
      // Radix traps focus on its content when a focused child is removed.
      // That automatic container focus is not a new user-selected target.
      if (
        document.activeElement !== document.body &&
        document.activeElement !== root.current &&
        document.activeElement?.isConnected
      )
        return
      const buttons = root.current?.querySelectorAll<HTMLButtonElement>(
        "[data-download-primary-action]"
      )
      const same = Array.from(buttons ?? []).find(
        (button) => button.dataset.downloadPrimaryAction === request.id
      )
      const previousAction = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>("[data-download-action]") ?? []
      ).find(
        (button) =>
          button.dataset.downloadActionJob === request.id &&
          button.dataset.downloadAction === request.action
      )
      const next =
        previousAction ??
        same ??
        buttons?.[Math.min(request.index, buttons.length - 1)] ??
        root.current?.querySelector<HTMLButtonElement>("[data-download-refresh]")
      if (next && !next.disabled) next.focus({ preventScroll: true })
    })
  }, [page, pending, visible, confirmation])
  const invalidate = useCallback(() => {
    owner.current.reading++
    setStarts(client.starts.inspect())
    setReload((value) => value + 1)
  }, [client])
  useEffect(() => client.subscribe(invalidate), [client, invalidate])
  useEffect(() => {
    if (confirmation) confirm.current?.focus({ preventScroll: true })
  }, [confirmation])
  useEffect(() => {
    if (!visible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const sequence = ++owner.current.reading
      try {
        const result = verifyBotDownloadPage(
          await client.api.page({
            before,
            conversationId,
            limit: BOT_ARTIFACT_DOWNLOAD_PAGE
          }),
          conversationId
        )
        if (disposed || !owner.current.active || sequence !== owner.current.reading) return
        // Validate against the current page before entering a React updater,
        // so a corrupt receipt becomes an inline read error, not a render crash.
        const current = latestPage.current
        const next = {
          key,
          page: projectBotDownloadPage(current?.key === key ? current.page : null, result)
        }
        latestPage.current = next
        observedRead.current = sequence
        setLoaded(next)
        setReadError(null)
        const record = client.starts.inspect()
        if (record.kind === "valid") {
          for (const intent of record.items) {
            const job = result.items.find(
              (candidate) =>
                candidate.id === intent.nonce &&
                sameBotDownloadSource(candidate.source, intent.source)
            )
            if (job) {
              try {
                client.starts.forget(intent)
              } catch {
                setAcceptedStart(intent.nonce)
                setActionError({
                  message: "保存任务已接收，但本机请求记录未能清理。可只重试清理记录。"
                })
              }
            }
          }
        }
        const nextStarts = client.starts.inspect()
        setStarts(nextStarts)
        if (botDownloadsAreActive(result)) timer = setTimeout(() => void read(), 1000)
      } catch (error) {
        if (!disposed && owner.current.active && sequence === owner.current.reading)
          setReadError(botErrorNotice(error, "下载列表读取失败"))
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [client, before, conversationId, key, visible])
  function dismissConfirmation() {
    if (!confirmation) return
    const instance = owner.current
    focus.current.owned = !!root.current?.contains(document.activeElement)
    focus.current.restore = {
      id: confirmation.job.id,
      action: confirmation.action,
      index: Math.max(0, page?.items.findIndex((item) => item.id === confirmation.job.id) ?? 0),
      generation: instance.operation,
      minimumRead: 0
    }
    setConfirmation(null)
  }
  async function checkStart(intent: BotDownloadStartIntent, cleanupOnly: boolean) {
    const instance = owner.current
    if (!instance.active || instance.executing) return
    const token = ++instance.operation
    instance.executing = true
    setPending({ id: intent.nonce, action: cleanupOnly ? "cleanup" : "start" })
    setActionError(null)
    try {
      if (cleanupOnly) client.starts.forget(intent)
      else {
        const result = await client.checkStart(intent)
        if (instance.active && instance.operation === token && result.cleanupFailed) {
          setAcceptedStart(intent.nonce)
          setActionError({
            message: "保存任务已接收，但本机请求记录未能清理。可只重试清理记录。"
          })
        }
      }
      if (instance.active && instance.operation === token) invalidate()
    } catch (error) {
      if (instance.active && instance.operation === token) {
        setActionError(
          botErrorNotice(
            error,
            cleanupOnly ? "本机请求记录尚未清理" : "保存请求尚未确认，请核对原请求"
          )
        )
        setStarts(client.starts.inspect())
      }
    } finally {
      instance.executing = false
      if (instance.active && instance.operation === token) setPending(null)
    }
  }
  async function act(job: BotArtifactDownloadJob, action: BotDownloadAction) {
    const instance = owner.current
    if (!instance.active || instance.executing) return
    const token = ++instance.operation
    focus.current.owned = !!root.current?.contains(document.activeElement)
    focus.current.restore = null
    instance.executing = true
    setPending({ id: job.id, action })
    setActionError(null)
    setConfirmation(null)
    let refreshed = false
    try {
      const input = { id: job.id, revision: job.revision }
      if (action === "forget" || action === "reveal") await client.api[action](input)
      else verifyBotDownloadJob(await client.api[action](input), job)
      if (instance.active && instance.operation === token) {
        invalidate()
        refreshed = true
      }
    } catch (error) {
      if (instance.active && instance.operation === token) {
        setActionError(
          isBotDownloadRevisionConflict(error)
            ? { message: "任务状态已更新，列表刷新后请重新选择操作。" }
            : botErrorNotice(error, "操作回执尚未确认，请刷新列表后核对。")
        )
        if (isBotDownloadRevisionConflict(error)) {
          invalidate()
          refreshed = true
        }
      }
    } finally {
      instance.executing = false
      if (instance.active && instance.operation === token) {
        focus.current.restore = {
          id: job.id,
          action,
          index: Math.max(0, page?.items.findIndex((item) => item.id === job.id) ?? 0),
          generation: token,
          minimumRead: refreshed ? instance.reading : 0
        }
        setPending(null)
      }
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
        ref={root}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onEscapeKeyDown={(event) => {
          if (confirmation) {
            event.preventDefault()
            dismissConfirmation()
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Download className="size-4" />
            下载与保存
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-5">
            保存为新文件；已有同名文件不会覆盖。关闭此页后，已接收的保存任务继续在后台运行。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {starts.kind === "unreadable" && (
            <div role="alert" className="space-y-2 rounded-xl border p-3">
              <p className="text-xs leading-5 text-muted-foreground">
                本机保存请求记录暂不可读取。原请求保留，新保存尚未提交；已有后台任务不受影响。
              </p>
              <Button size="sm" variant="outline" onClick={invalidate}>
                重新读取请求记录
              </Button>
            </div>
          )}
          {starts.kind === "corrupt" && (
            <CorruptStartRecord
              key={starts.raw}
              raw={starts.raw}
              client={client}
              changed={invalidate}
            />
          )}
          {!!sourceStarts.length && (
            <section aria-label="待核对保存请求" className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">待核对的保存请求</h3>
              {sourceStarts.map((intent) => {
                const known =
                  acceptedStart === intent.nonce ||
                  !!page?.items.some(
                    (job) =>
                      job.id === intent.nonce && sameBotDownloadSource(job.source, intent.source)
                  )
                return (
                  <div
                    key={intent.nonce}
                    className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
                  >
                    <File className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={intent.name}>
                        {intent.name}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {known
                          ? "保存任务已接收，只需清理本机请求记录。"
                          : intent.source.dataEpoch !== dataEpoch
                            ? "来源数据已更新，此处只核对原请求。"
                            : "返回结果尚未确认；继续核对同一请求。"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending !== null || !visible}
                      onClick={() => void checkStart(intent, known)}
                    >
                      {pending?.id === intent.nonce
                        ? "正在核对…"
                        : known
                          ? "清理请求记录"
                          : "核对保存请求"}
                    </Button>
                  </div>
                )
              })}
            </section>
          )}
          {readError && (
            <div role="alert" className="rounded-xl border border-destructive/25 p-3">
              <BotErrorNoticeBody notice={readError}>
                <Button size="sm" variant="outline" onClick={invalidate}>
                  重新读取
                </Button>
              </BotErrorNoticeBody>
            </div>
          )}
          {actionError && (
            <div role="alert" className="rounded-xl border border-destructive/25 p-3">
              <BotErrorNoticeBody notice={actionError}>
                <Button size="sm" variant="outline" onClick={invalidate}>
                  刷新列表
                </Button>
              </BotErrorNoticeBody>
            </div>
          )}
          {!page && !readError && (
            <p
              role="status"
              className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"
            >
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              读取下载列表…
            </p>
          )}
          {page?.items.length === 0 && (
            <div className="py-10 text-center">
              <Download className="mx-auto mb-3 size-7 text-muted-foreground/60" />
              <p className="text-sm font-medium">{before ? "此页暂无记录" : "暂无保存任务"}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                从对话附件或文件与成果中选择保存，任务会显示在这里。
              </p>
            </div>
          )}
          <ol className="space-y-2" aria-label="下载任务列表">
            {page?.items.map((job) => (
              <li
                key={job.id}
                data-download-job={job.id}
                className="rounded-xl border border-border/70 bg-muted/20 p-3"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/60 text-muted-foreground">
                    {job.state === "completed" ? (
                      <Check className="size-4" />
                    ) : (
                      <File className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium" title={job.name}>
                      {job.name}
                    </p>
                    <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                      {botDownloadStateLabel(job)} · {formatAttachmentBytes(job.bytes)} /{" "}
                      {formatAttachmentBytes(job.total)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    {botDownloadActions(job).map((action, index) => {
                      const Icon = actionIcons[action]
                      return (
                        <Button
                          key={action}
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg"
                          title={actionLabels[action]}
                          aria-label={`${actionLabels[action]} ${job.name}`}
                          data-download-primary-action={index === 0 ? job.id : undefined}
                          data-download-action={action}
                          data-download-action-job={job.id}
                          disabled={pending !== null || !visible}
                          onClick={() =>
                            action === "cancel" || action === "forget"
                              ? setConfirmation({ job, action })
                              : void act(job, action)
                          }
                        >
                          {pending?.id === job.id && pending.action === action ? (
                            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                          ) : (
                            <Icon className="size-3.5" />
                          )}
                        </Button>
                      )
                    })}
                  </div>
                </div>
                {["downloading", "paused", "verifying", "publishing"].includes(job.state) && (
                  <div
                    role="progressbar"
                    aria-label={`保存进度 ${job.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={botDownloadPercent(job)}
                    className="mt-3 h-1 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      style={{ width: `${botDownloadPercent(job)}%` }}
                      className="h-full rounded-full bg-foreground/65 transition-[width] duration-200 motion-reduce:transition-none"
                    />
                  </div>
                )}
                {job.error && (
                  <div className="mt-2">
                    <BotErrorNoticeBody
                      notice={{
                        message: job.error,
                        diagnostic: job.diagnostic
                      }}
                      hint={
                        job.state === "failed"
                          ? "请返回文件与成果，重新选择保存为新文件。"
                          : job.diagnostic?.code === "download_publish_unavailable"
                            ? "此位置暂不支持安全发布文件。可重试原任务，或取消后选择其他位置另存。"
                            : undefined
                      }
                    />
                  </div>
                )}
                {confirmation?.job.id === job.id && (
                  <section
                    aria-label="确认下载操作"
                    className="mt-3 space-y-2 rounded-lg bg-background/60 p-3"
                  >
                    <p className="text-xs leading-5 text-muted-foreground">
                      {confirmation.action === "forget"
                        ? "只移除下载记录，已保存的文件会保留。"
                        : "取消这项保存任务并清理其未完成数据；已保存的文件不会删除。"}
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={dismissConfirmation}>
                        返回
                      </Button>
                      <Button
                        ref={confirm}
                        size="sm"
                        variant="destructive"
                        disabled={pending !== null || !visible}
                        onClick={() => void act(confirmation.job, confirmation.action)}
                      >
                        确认
                        {confirmation.action === "forget" ? "移除记录" : "取消保存"}
                      </Button>
                    </div>
                  </section>
                )}
              </li>
            ))}
          </ol>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {page ? `${page.total} 项记录 · 第 ${cursors.length + 1} 页` : "下载列表"}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="刷新下载列表"
              data-download-refresh
              title="刷新"
              disabled={pending !== null || !visible}
              onClick={invalidate}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上一页下载"
              disabled={!cursors.length || pending !== null || !visible}
              onClick={() => {
                owner.current.reading++
                setCursors((value) => value.slice(0, -1))
                setReadError(null)
              }}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="下一页下载"
              disabled={
                !page?.nextCursor ||
                pending !== null ||
                !visible ||
                cursors.length + 1 >= PAGE_COUNT_LIMIT
              }
              onClick={() => {
                if (page?.nextCursor) {
                  owner.current.reading++
                  setCursors((value) => [...value, page.nextCursor!])
                  setReadError(null)
                }
              }}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={close}>
              关闭
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function CorruptStartRecord({
  raw,
  client,
  changed
}: {
  raw: string
  client: BotArtifactDownloadClient
  changed(): void
}) {
  const [exported, setExported] = useState(false),
    [saved, setSaved] = useState(false)
  const [error, setError] = useState<BotErrorNotice | null>(null)
  const download = useRef<{
    url: string
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  useEffect(() => {
    return () => {
      if (download.current) {
        clearTimeout(download.current.timer)
        URL.revokeObjectURL(download.current.url)
        download.current = null
      }
    }
  }, [])
  function exportRaw() {
    if (download.current) {
      clearTimeout(download.current.timer)
      URL.revokeObjectURL(download.current.url)
    }
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "CMBDevClaw-save-request-original.json"
    anchor.click()
    download.current = {
      url,
      timer: setTimeout(() => {
        URL.revokeObjectURL(url)
        download.current = null
      }, 30_000)
    }
    setExported(true)
  }
  function repair() {
    if (!exported || !saved) return
    try {
      if (!client.starts.discardCorrupt(raw)) {
        changed()
        return
      }
      changed()
    } catch (failure) {
      setError(botErrorNotice(failure, "原始请求记录仍保留"))
    }
  }
  return (
    <section aria-label="修复保存请求记录" className="space-y-2 rounded-xl border p-3">
      <p className="text-xs leading-5 text-muted-foreground">
        本机保存请求记录已损坏，暂不能发起新保存。已有后台任务不受影响；先导出原始记录，再明确确认清理。不会删除后台任务或已保存文件。
      </p>
      <Button size="sm" variant="outline" onClick={exportRaw}>
        导出原始请求记录
      </Button>
      <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <input
          type="checkbox"
          checked={saved}
          disabled={!exported}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-1"
        />
        已保存原始记录的备份
      </label>
      <Button size="sm" variant="outline" disabled={!exported || !saved} onClick={repair}>
        确认清理损坏记录
      </Button>
      {error && <BotErrorNoticeBody notice={error} />}
    </section>
  )
}
