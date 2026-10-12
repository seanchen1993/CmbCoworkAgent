import { botApi } from "@/lib/bot-api"
import { downloadBotFile } from "@/lib/bot-file-download"
import { uploadBotFile } from "@/lib/bot-file-transfer"
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { Download, File, Plus, Loader2, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type { BotArtifact } from "../../../../shared/bot-types"
import type { BotFileDeleteInput } from "../../../../shared/bot-file-lifecycle"
import { BOT_ATTACHMENT_COUNT, botFileByteLimit } from "../../../../shared/bot-files"
import { botFileLabel } from "@/lib/bot-file-label"
import { BotFilePreview } from "./BotFilePreview"
import { botViewAddress } from "@/lib/bot-thread-view"
import type { BotAttachmentPickerHandle } from "@/lib/use-bot-composer-files"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { createBoundedLatestTaskQueue } from "../harness-board/bounded-latest-task-queue"

import type {
  BotAcceptedFileJob,
  BotFileBatchCompletion,
  BotLocalFileBatch
} from "@/lib/bot-new-chat-draft"
type UploadJob = {
  file: File
  nonce: string
  localId?: string
  batchId?: string
}
interface LocalBatchLane {
  batch: BotLocalFileBatch
  jobs: UploadJob[]
  accepted: readonly BotAcceptedFileJob[]
  confirmed: BotFileBatchCompletion["confirmed"][number][]
  complete(result: BotFileBatchCompletion): void
  finished: boolean
}

export const BotAttachmentPicker = forwardRef<
  BotAttachmentPickerHandle,
  {
    conversationId: string
    disabled: boolean
    trigger?: boolean
    ready?(picker: BotAttachmentPickerHandle): void
  }
>(function BotAttachmentPicker({ conversationId, disabled, trigger = true, ready }, ref) {
  const input = useRef<HTMLInputElement>(null)
  const localBatch = useRef<LocalBatchLane | null>(null)
  const controller = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<{
    name: string
    percent: number
  } | null>(null)
  const [retry, setRetry] = useState<UploadJob[]>([])
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  useLayoutEffect(
    () => () => controller.current?.abort(new Error("附件上传已取消")),
    [conversationId, dataEpoch]
  )
  const busy = useBotWorkspaceStore((state) => Boolean(state.uploading[conversationId]))
  const attachments = useBotWorkspaceStore((state) => state.drafts[conversationId]?.attachments)
  const upload = async (jobs: UploadJob[]) => {
    if (!jobs.length || disabled || useBotWorkspaceStore.getState().uploading[conversationId])
      return
    const uploadEpoch = useBotWorkspaceStore.getState().snapshot?.dataEpoch
    if (!uploadEpoch || uploadEpoch !== dataEpoch) {
      toast.error("工作区尚未就绪，请重新打开后添加附件")
      return
    }
    const abort = new AbortController()
    controller.current = abort
    useBotWorkspaceStore.getState().setUploading(conversationId, true)
    setRetry([])
    const lane =
      jobs[0]?.batchId && localBatch.current?.batch.batchId === jobs[0].batchId
        ? localBatch.current
        : null
    const currentBatch = () => {
      const state = useBotWorkspaceStore.getState()
      return (
        !lane ||
        (localBatch.current === lane &&
          state.host?.hostId === lane.batch.adoption.hostId &&
          state.snapshot?.dataEpoch === lane.batch.adoption.dataEpoch &&
          state.selected === conversationId &&
          state.viewportLease?.generation === lane.batch.targetViewportGeneration)
      )
    }
    let index = 0
    try {
      if (
        jobs.length +
          (useBotWorkspaceStore.getState().drafts[conversationId]?.attachments.length ?? 0) >
        BOT_ATTACHMENT_COUNT
      )
        throw new Error("每条消息最多 6 个附件")
      for (const { file } of jobs)
        if (file.size > botFileByteLimit(file.name, file.type))
          throw new Error(`${file.name} 超过限制：普通文件 25 MiB，视频 200 MiB`)
      for (; index < jobs.length; index++) {
        const { file, nonce, localId } = jobs[index]
        abort.signal.throwIfAborted()
        setProgress({ name: file.name, percent: 0 })
        const artifact = await uploadBotFile(
          botApi,
          botViewAddress(conversationId).conversationId,
          file,
          nonce,
          abort.signal,
          (percent) => {
            if (!abort.signal.aborted) setProgress({ name: file.name, percent })
          }
        )
        abort.signal.throwIfAborted()
        const state = useBotWorkspaceStore.getState()
        if (
          controller.current !== abort ||
          state.snapshot?.dataEpoch !== uploadEpoch ||
          !currentBatch()
        )
          throw new Error("附件目标已切换，本次上传不会添加到其他对话")
        const existing = state.drafts[conversationId]?.attachments ?? []
        if (!existing.some((item) => item.path === artifact.id))
          state.attachments(conversationId, [
            ...existing,
            { path: artifact.id, name: artifact.name, size: artifact.size }
          ])
        if (
          lane &&
          localId &&
          !lane.confirmed.some((item) => item.localId === localId && item.nonce === nonce)
        )
          lane.confirmed.push({ localId, nonce, artifact })
      }
    } catch (error) {
      if (!abort.signal.aborted && currentBatch()) {
        setRetry(jobs.slice(index))
        toast.error(error instanceof Error ? error.message : "上传失败，可重试")
      }
    } finally {
      try {
        if (lane) {
          const remaining = lane.accepted.filter(
            (job) =>
              !lane.confirmed.some(
                (item) => item.localId === job.localId && item.nonce === job.nonce
              )
          )
          const completion: BotFileBatchCompletion = {
            confirmed: [...lane.confirmed],
            remaining,
            state: !currentBatch()
              ? "retired"
              : abort.signal.aborted
                ? "cancelled"
                : index === jobs.length
                  ? "complete"
                  : "retry"
          }
          lane.finished = completion.state !== "retry"
          try {
            lane.complete(completion)
          } finally {
            if (lane.finished) {
              lane.jobs = []
              lane.batch = { ...lane.batch, files: [] }
              lane.complete = () => {}
            }
          }
        }
      } finally {
        if (controller.current === abort) {
          // A restored workspace can already own a new upload for the same view.
          // Only this controller in its captured epoch may release shared busy state.
          const state = useBotWorkspaceStore.getState()
          if (state.snapshot?.dataEpoch === uploadEpoch) state.setUploading(conversationId, false)
          controller.current = null
          setProgress(null)
        }
        if (input.current) input.current.value = ""
      }
    }
  }
  const stageFiles = (files: File[]) => {
    if (!files.length) return
    if (disabled || useBotWorkspaceStore.getState().uploading[conversationId]) {
      toast.error("请等待当前发送或上传完成后再添加附件")
      return
    }
    if (retry.length) {
      toast.error("请先重试或移除未完成的附件")
      return
    }
    const existingCount =
      useBotWorkspaceStore.getState().drafts[conversationId]?.attachments.length ?? 0
    if (files.length + existingCount > BOT_ATTACHMENT_COUNT) {
      toast.error("每条消息最多 6 个附件，请减少文件后重试")
      return
    }
    const tooLarge = files.find((file) => file.size > botFileByteLimit(file.name, file.type))
    if (tooLarge) {
      toast.error(`${tooLarge.name} 超过限制：普通文件 25 MiB，视频 200 MiB`)
      return
    }
    void upload(files.map((file) => ({ file, nonce: crypto.randomUUID() })))
  }
  const openPicker = () => {
    const state = useBotWorkspaceStore.getState()
    if (
      disabled ||
      busy ||
      retry.length ||
      !dataEpoch ||
      state.snapshot?.dataEpoch !== dataEpoch ||
      (state.selected !== null && state.selected !== conversationId)
    )
      return
    input.current?.click()
  }
  const acceptLocalBatch: BotAttachmentPickerHandle["acceptLocalBatch"] = (batch, complete) => {
    const previous = localBatch.current
    const state = useBotWorkspaceStore.getState(),
      adoption = batch.adoption
    if (
      state.host?.hostId !== adoption.hostId ||
      state.snapshot?.dataEpoch !== adoption.dataEpoch ||
      state.selected !== conversationId ||
      state.viewportLease?.generation !== batch.targetViewportGeneration
    )
      return { kind: "rejected", reason: "附件目标已切换，原文件已保留" }
    if (previous?.batch.batchId === batch.batchId) {
      if (
        previous.batch.adoption.openNonce !== batch.adoption.openNonce ||
        previous.batch.adoption.sourceRevision !== batch.adoption.sourceRevision ||
        previous.batch.adoption.targetViewId !== adoption.targetViewId ||
        previous.batch.adoption.targetDraftRevision !== adoption.targetDraftRevision
      )
        return { kind: "rejected", reason: "附件转交记录不匹配，原文件已保留" }
      return { kind: "accepted", jobs: previous.accepted }
    }
    if (
      disabled ||
      retry.length ||
      (previous && !previous.finished) ||
      !batch.files.length ||
      adoption.targetViewId !== conversationId ||
      state.selected !== conversationId ||
      state.host?.hostId !== adoption.hostId ||
      state.snapshot?.dataEpoch !== adoption.dataEpoch ||
      state.viewportLease?.generation !== batch.targetViewportGeneration ||
      state.drafts[conversationId]?.revision !== adoption.targetDraftRevision ||
      state.pending[conversationId] ||
      state.sending[conversationId] ||
      state.uploading[conversationId]
    )
      return {
        kind: "rejected",
        reason: "对话状态已变化，正文与本次附件均已保留，请核对后再继续"
      }
    if (
      batch.files.length + (state.drafts[conversationId]?.attachments.length ?? 0) >
        BOT_ATTACHMENT_COUNT ||
      new Set(batch.files.map((file) => file.localId)).size !== batch.files.length ||
      batch.files.some(
        (item) =>
          item.file.name !== item.name ||
          item.file.type !== item.mime ||
          item.file.size !== item.size ||
          item.size > botFileByteLimit(item.name, item.mime)
      )
    )
      return { kind: "rejected", reason: "附件不符合要求，原文件已保留" }
    const jobs = batch.files.map((item) => ({
      file: item.file,
      nonce: crypto.randomUUID(),
      localId: item.localId,
      batchId: batch.batchId
    }))
    const accepted = jobs.map((job) => ({
      localId: job.localId,
      nonce: job.nonce
    }))
    localBatch.current = {
      batch,
      jobs,
      accepted,
      confirmed: [],
      complete,
      finished: false
    }
    void upload(jobs)
    return { kind: "accepted", jobs: accepted }
  }
  const handle = { stageFiles, openPicker, acceptLocalBatch }
  useImperativeHandle(ref, () => handle)
  useLayoutEffect(() => {
    ready?.(handle)
  })
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          stageFiles(files)
        }}
      />
      {trigger && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="bot-attachment-button"
          aria-label="添加附件"
          title="最多 6 个附件；普通文件 25 MiB，视频 200 MiB"
          disabled={disabled || busy}
          onClick={openPicker}
        >
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Plus size={20} />}
        </Button>
      )}
      {(progress || retry.length > 0 || Boolean(attachments?.length)) && (
        <div className="bot-composer-files">
          {(progress || retry.length > 0) && (
            <div className="flex basis-full items-center gap-2 text-xs" role="status">
              <span className="max-w-52 truncate text-muted-foreground">
                {progress
                  ? `${progress.name} · ${progress.percent}%`
                  : `${retry.length} 个附件上传未完成`}
              </span>
              {progress ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => controller.current?.abort(new Error("附件上传已取消"))}
                >
                  取消上传
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void upload(retry)}
                  >
                    重试上传
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      for (const item of retry) void botApi.cancelUpload(item.nonce).catch(() => {})
                      setRetry([])
                      const lane = localBatch.current
                      if (lane && retry.some((job) => job.batchId === lane.batch.batchId)) {
                        lane.finished = true
                        lane.complete({
                          confirmed: [...lane.confirmed],
                          remaining: [],
                          state: "cancelled"
                        })
                        lane.jobs = []
                        lane.batch = { ...lane.batch, files: [] }
                        lane.complete = () => {}
                      }
                    }}
                  >
                    移除
                  </Button>
                </>
              )}
            </div>
          )}
          {Boolean(attachments?.length) && (
            <div className="flex flex-wrap gap-1.5">
              {attachments?.map((file) => (
                <span
                  key={file.path}
                  className="flex max-w-52 items-center gap-1 rounded-md border px-2 py-1 text-xs"
                >
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${file.name}`}
                    disabled={disabled || busy}
                    onClick={() =>
                      useBotWorkspaceStore.getState().attachments(
                        conversationId,
                        (attachments ?? []).filter((item) => item.path !== file.path)
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
})

export function BotFiles({
  conversationId,
  close,
  showDownloads,
  inline = false,
  active = true
}: {
  conversationId: string
  showDownloads?: () => void
  active?: boolean
} & ({ inline: true; close?: never } | { inline?: false; close(): void })) {
  const cursor = useBotWorkspaceStore((state) => state.snapshot?.cursor)
  const canDelete = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("file-lifecycle")
  )
  const supportsScopedDelete = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("file-delete-epoch") ?? false
  )
  const selectedView = useBotWorkspaceStore((state) => state.selected)
  const selectedAttachments = useBotWorkspaceStore((state) =>
    state.selected ? state.drafts[state.selected]?.attachments : undefined
  )
  const [removing, setRemoving] = useState<BotFileDeleteInput | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const cancelRead = useRef<(() => void) | null>(null)
  const [files, setFiles] = useState<BotArtifact[]>([]),
    [error, setError] = useState<string | null>(null)
  const visible = useBotViewVisibility()
  const dataEpoch = useBotWorkspaceStore((state) =>
    state.snapshot ? (state.snapshot.dataEpoch ?? "initial") : null
  )
  const enabled = active && visible && !preview
  const owner = useRef({ active: false, conversationId, dataEpoch })
  const reads = useRef<{
    lastStarted: number
    timer?: ReturnType<typeof setTimeout>
  }>({ lastStarted: -Infinity })
  // Reuse Cmb's keyed latest-work queue: one active read and one latest request.
  // Visibility and committed deletes advance its generation before old results apply.
  const [queue] = useState(() =>
    createBoundedLatestTaskQueue<string, { conversationId: string; dataEpoch: string }>(
      1,
      async (scope, context) => {
        const current = () => {
          const snapshot = useBotWorkspaceStore.getState().snapshot
          return (
            context.isCurrent() &&
            owner.current.active &&
            owner.current.conversationId === scope.conversationId &&
            owner.current.dataEpoch === scope.dataEpoch &&
            Boolean(snapshot && (snapshot.dataEpoch ?? "initial") === scope.dataEpoch)
          )
        }
        if (!current()) return
        reads.current.lastStarted = performance.now()
        setLoading(true)
        try {
          const value = await botApi.artifacts(scope.conversationId)
          if (current()) {
            setFiles(value)
            setReadError(null)
            setLoading(false)
          }
        } catch (failure) {
          if (current()) {
            setReadError(failure instanceof Error ? failure.message : "文件读取失败，可重试")
            setLoading(false)
          }
        }
      }
    )
  )
  useLayoutEffect(() => {
    const state = reads.current
    const retire = () => {
      clearTimeout(state.timer)
      state.timer = undefined
      queue.cancelPending()
    }
    owner.current = { active: enabled, conversationId, dataEpoch }
    state.lastStarted = -Infinity
    cancelRead.current = retire
    return () => {
      owner.current.active = false
      retire()
      if (cancelRead.current === retire) cancelRead.current = null
    }
  }, [conversationId, dataEpoch, enabled, queue])
  const requestRead = useCallback(
    (immediate = false) => {
      if (!enabled || !dataEpoch) return
      const state = reads.current
      if (immediate) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      if (state.timer) return
      const enqueue = () => {
        state.timer = undefined
        if (owner.current.active) queue.enqueue("files", { conversationId, dataEpoch })
      }
      const delay = immediate ? 0 : Math.max(0, 2000 - (performance.now() - state.lastStarted))
      if (delay) state.timer = setTimeout(enqueue, delay)
      else enqueue()
    },
    [conversationId, dataEpoch, enabled, queue]
  )
  const previousRetry = useRef(retry)
  useEffect(() => {
    const immediate = previousRetry.current !== retry
    previousRetry.current = retry
    requestRead(immediate)
  }, [cursor, retry, requestRead])
  const remove = async (file: BotArtifact) => {
    if (
      !removing ||
      removing.id !== file.id ||
      removing.sha256 !== file.sha256 ||
      deleting ||
      !supportsScopedDelete
    )
      return
    // Preserve exactly what the human confirmed; never substitute the ACK's
    // current workspace, file metadata or target into this immutable request.
    const request = { ...removing }
    const currentEpoch = () => {
      const snapshot = useBotWorkspaceStore.getState().snapshot
      return Boolean(snapshot && (snapshot.dataEpoch ?? "initial") === request.expectedDataEpoch)
    }
    const sameView = () =>
      owner.current.conversationId === request.conversationId &&
      owner.current.dataEpoch === request.expectedDataEpoch
    if (!owner.current.active || !sameView() || !currentEpoch()) return
    setDeleting(true)
    setError(null)
    try {
      await botApi.deleteFile(request)
      if (!currentEpoch()) return
      // A list requested before this receipt cannot restore the deleted row.
      // A same-epoch accepted deletion remains valid after switching chats;
      // only its still-current local view may receive presentation updates.
      if (sameView() && owner.current.active) {
        cancelRead.current?.()
        setFiles((items) => items.filter((item) => item.id !== request.id))
        setRemoving(null)
        setRetry((value) => value + 1)
      }
      const state = useBotWorkspaceStore.getState()
      for (const [view, draft] of Object.entries(state.drafts))
        if (
          botViewAddress(view).conversationId === request.conversationId &&
          draft.attachments.some((item) => item.path === request.id)
        )
          state.attachments(
            view,
            draft.attachments.filter((item) => item.path !== request.id)
          )
      await state.refresh()
    } catch (failure) {
      if (sameView() && owner.current.active && currentEpoch())
        setError(failure instanceof Error ? failure.message : "删除未确认，可重试")
    } finally {
      if (sameView() && currentEpoch()) setDeleting(false)
    }
  }

  const attach = (file: BotArtifact) => {
    const state = useBotWorkspaceStore.getState(),
      view = state.selected
    if (
      !owner.current.active ||
      !dataEpoch ||
      !state.snapshot ||
      (state.snapshot.dataEpoch ?? "initial") !== dataEpoch ||
      !view ||
      view !== selectedView ||
      botViewAddress(view).conversationId !== conversationId ||
      file.conversationId !== conversationId ||
      state.uploading[view] ||
      deleting
    )
      return
    const existing = state.drafts[view]?.attachments ?? []
    if (existing.some((item) => item.path === file.id)) return
    if (existing.length >= BOT_ATTACHMENT_COUNT) {
      toast.error(`每条消息最多 ${BOT_ATTACHMENT_COUNT} 个附件`)
      return
    }
    // Select the immutable original into the existing composer draft. Sending
    // still uses the normal task/attachment authorization; no bytes are copied.
    state.attachments(view, [...existing, { path: file.id, name: file.name, size: file.size }])
    close?.()
  }

  const contents = (
    <>
      {readError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-sm text-destructive"
        >
          <span>{readError}</span>
          <Button
            size="sm"
            variant="outline"
            aria-label="重试读取文件"
            disabled={loading}
            onClick={() => {
              setLoading(true)
              setRetry((value) => value + 1)
            }}
          >
            {loading ? "正在重试…" : "重试读取文件"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && !files.length && (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          正在读取文件…
        </p>
      )}
      {!loading && !files.length && !error && !readError && (
        <div className="py-10 text-center">
          <File size={28} className="mx-auto mb-4 text-muted-foreground/60" />
          <p className="text-sm font-medium">暂无文件</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            对话中的附件和 Bot 交付的文件会显示在这里。
          </p>
        </div>
      )}
      {files.map((file) => (
        <div key={file.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <File size={18} />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="max-w-full truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
              aria-label={`预览 ${file.name}`}
              onClick={() => setPreview(file.id)}
            >
              {file.name}
            </button>
            <p className="text-xs text-muted-foreground">
              {botFileLabel(file)} · {new Date(file.createdAt).toLocaleString()}
            </p>
          </div>
          {selectedView && botViewAddress(selectedView).conversationId === conversationId && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`将 ${file.name} 添加到消息`}
              title={
                selectedAttachments?.some((item) => item.path === file.id)
                  ? "已添加到当前消息"
                  : "添加到消息"
              }
              disabled={deleting || selectedAttachments?.some((item) => item.path === file.id)}
              onClick={() => attach(file)}
            >
              <Plus size={15} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`保存 ${file.name}`}
            onClick={() => void downloadBotFile(file.id, file, showDownloads)}
          >
            <Download size={15} />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`删除文件 ${file.name}`}
              disabled={deleting || !supportsScopedDelete}
              title={!supportsScopedDelete ? "请更新 Bot 后台后删除文件" : undefined}
              onClick={() => {
                const snapshot = useBotWorkspaceStore.getState().snapshot
                if (
                  !supportsScopedDelete ||
                  !owner.current.active ||
                  !snapshot ||
                  !dataEpoch ||
                  (snapshot.dataEpoch ?? "initial") !== dataEpoch
                )
                  return
                setError(null)
                setRemoving({
                  id: file.id,
                  nonce: crypto.randomUUID(),
                  conversationId,
                  sha256: file.sha256,
                  expectedDataEpoch: dataEpoch
                })
              }}
            >
              <Trash2 size={15} />
            </Button>
          )}
          {removing?.id === file.id && (
            <div className="w-full rounded-md bg-muted/50 p-3 text-sm">
              <p>删除后，本对话将无法再打开此文件。其他对话的文件和项目原文件会保留。</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deleting}
                  onClick={() => setRemoving(null)}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => void remove(file)}
                >
                  {deleting ? "正在删除…" : "确认删除文件"}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  )
  return (
    <>
      {inline ? (
        <div className="space-y-3 p-5">{contents}</div>
      ) : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) close?.()
          }}
        >
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>文件与成果</DialogTitle>
              <DialogDescription>本对话上传的资料和 Bot 交付的文件。</DialogDescription>
            </DialogHeader>
            {contents}
          </DialogContent>
        </Dialog>
      )}

      {preview && (
        <BotFilePreview
          showDownloads={showDownloads}
          key={preview}
          id={preview}
          conversationId={conversationId}
          close={() => setPreview(null)}
        />
      )}
    </>
  )
}
