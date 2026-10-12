import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { botApi } from "@/lib/bot-api"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgePendingBot,
  inspectPendingBot,
  rememberPendingBot,
  type PendingBotRecord,
  type PendingBotSave
} from "@/lib/bot-editor-pending"
import { botProfileTitleSchema } from "../../../../shared/bot-profile-line"
import { BotDomainError, type CoworkBot } from "../../../../shared/bot-types"
import { BotDialogContent } from "./BotDialog"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

import "./bot-profile-inline.css"

const definitive = new Set([
  "invalid_input",
  "revision_conflict",
  "not_found",
  "nonce_conflict",
  "bot_busy"
])
type ProfileField = "name" | "title"
interface EditorProps {
  bot: CoworkBot
  dataEpoch: string
  field: ProfileField
  onExit(restoreFocus?: boolean): void
  className?: string
}

/** Identity changes use the advanced editor's existing durable request key and receipt. */
export function BotProfileInlineEditor({
  bot: providedBot,
  dataEpoch,
  field,
  onExit,
  className
}: EditorProps) {
  const [editingEpoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const supportsMutationEpoch = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  // Polling may deliver a new revision while the user edits. Keep the original CAS base.
  const [bot] = useState(providedBot)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(false)
  const owner = useRef({ alive: true, busy: false, finished: false })
  const [initialRecord] = useState(() => inspectPendingBot(bot.id, editingEpoch))
  const [blocked, setBlocked] = useState<PendingBotRecord | null>(() =>
    initialRecord.kind === "empty" || initialRecord.kind === "valid" ? null : initialRecord
  )
  const [request, setRequest] = useState<PendingBotSave | null>(() =>
    initialRecord.kind === "valid" ? initialRecord.input : null
  )
  const acknowledged = useRef<{
    input: PendingBotSave
    rejected?: BotErrorNotice
  } | null>(null)
  const [draft, setDraft] = useState(bot[field] ?? "")
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<BotErrorNotice | null>(null)
  const [showFeedback, setShowFeedback] = useState(Boolean(request || blocked))
  const currentEpoch = () => useBotWorkspaceStore.getState().snapshot?.dataEpoch === editingEpoch
  const live = () => owner.current.alive && currentEpoch()
  useLayoutEffect(() => {
    const current = owner.current
    current.alive = true
    if (!request && !blocked) {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    }
    return () => {
      current.alive = false
    }
    // This keyed editor owns one fixed draft and stored identity until it exits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const notice = (error: unknown, message?: string) => {
    if (!live()) return
    const safe = botErrorNotice(error)
    setFeedback(message ? { ...safe, message: `${message}\n${safe.message}` } : safe)
    setShowFeedback(true)
  }
  const finish = async (saved: { input: PendingBotSave; rejected?: BotErrorNotice }) => {
    // An exact receipt from the replaced database must remain available for review.
    if (!currentEpoch()) return
    if (!acknowledgePendingBot(saved.input, editingEpoch)) {
      notice(
        new Error("本机保存记录尚未清除"),
        "后台已确认原请求，本机记录尚未清除。重试只核对已完成记录。"
      )
      return
    }
    if (!live()) return
    if (saved.rejected) {
      acknowledged.current = null
      setRequest(null)
      setFeedback(saved.rejected)
      setShowFeedback(true)
      return
    }
    try {
      await useBotWorkspaceStore.getState().refresh()
    } catch (error) {
      notice(error, "Bot 已保存，列表同步失败。重试只重新读取列表。")
      return
    }
    if (live()) onExit(restoreFocus.current)
  }
  const save = async (input: PendingBotSave) => {
    if (owner.current.busy || authorityRetired || !supportsMutationEpoch || !live()) return
    if (input.id !== bot.id || input.revision === undefined) {
      notice(new Error("保存记录不属于此 Bot，请在原设置中核对。"))
      return
    }
    owner.current.busy = true
    setBusy(true)
    try {
      if (acknowledged.current) {
        await finish(acknowledged.current)
        return
      }
      try {
        rememberPendingBot(input, editingEpoch)
      } catch (error) {
        const current = inspectPendingBot(bot.id, editingEpoch)
        if (live()) {
          if (current.kind === "valid") setRequest(current.input)
          else if (current.kind !== "empty") setBlocked(current)
        }
        notice(error)
        return
      }
      if (live()) setRequest(input)
      try {
        if (!live()) return
        await botApi.update(input)
        acknowledged.current = { input }
        await finish(acknowledged.current)
      } catch (error) {
        if (
          error instanceof BotDomainError &&
          (error.code === "data_epoch" || error.code === "workspace_replaced")
        ) {
          if (live()) {
            setAuthorityRetired(true)
            notice(
              error,
              "工作区数据已恢复，原保存记录已保留。请关闭后重新打开，核对或归档原记录。"
            )
          }
          return
        }
        if (error instanceof BotDomainError && definitive.has(error.code)) {
          acknowledged.current = { input, rejected: botErrorNotice(error) }
          await finish(acknowledged.current)
        } else notice(error, "保存结果尚未确认。重试将核对同一次请求。")
      }
    } finally {
      owner.current.busy = false
      if (owner.current.alive) setBusy(false)
    }
  }
  const commit = (raw: string) => {
    if (
      !live() ||
      authorityRetired ||
      !supportsMutationEpoch ||
      owner.current.finished ||
      request ||
      blocked
    )
      return
    owner.current.finished = true
    // Check before trimming: boundary line separators must not silently disappear.
    const valid =
      field === "title"
        ? botProfileTitleSchema.safeParse(raw).success
        : raw.length <= 100 && !/[\r\n\u2028\u2029\0]/.test(raw)
    if (!valid) {
      notice(
        new BotDomainError(
          "invalid_input",
          field === "title"
            ? "标签必须为单行文本，最多 200 字符。"
            : "名称必须为单行文本，最多 100 字符。"
        )
      )
      return
    }
    const value = raw.trim()
    if ((field === "name" && !value) || value === (bot[field] ?? "")) {
      onExit(restoreFocus.current)
      return
    }
    const input: PendingBotSave = {
      nonce: crypto.randomUUID(),
      expectedDataEpoch: editingEpoch,
      id: bot.id,
      revision: bot.revision,
      name: field === "name" ? value : bot.name,
      title: field === "title" ? value : (bot.title ?? ""),
      instructions: bot.instructions,
      modelRef: bot.modelRef,
      workspacePath: bot.workspacePath,
      connectorIds: bot.connectorIds ?? [],
      harnessBinding: bot.harnessBinding ?? null,
      avatarShape: bot.avatarShape ?? null,
      avatarColor: bot.avatarColor ?? null
    }
    void save(input)
  }
  const cannotEdit =
    busy ||
    authorityRetired ||
    !supportsMutationEpoch ||
    dataEpoch !== editingEpoch ||
    Boolean(request) ||
    Boolean(blocked) ||
    owner.current.finished
  return (
    <>
      <span className={`bot-profile-inline-input-wrap ${className ?? ""}`} data-field={field}>
        <input
          ref={inputRef}
          className="bot-profile-inline-input"
          aria-label={field === "name" ? "编辑 Bot 名称" : "编辑 Bot 标签"}
          autoComplete="off"
          spellCheck={false}
          maxLength={field === "name" ? 100 : 200}
          value={draft}
          disabled={cannotEdit}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Escape") {
              event.preventDefault()
              owner.current.finished = true
              onExit(true)
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              restoreFocus.current = true
              event.currentTarget.blur()
            }
          }}
        />
        {busy && <LoaderCircle size={13} className="animate-spin" aria-label="正在保存" />}
      </span>
      <Dialog
        open={showFeedback}
        onOpenChange={(open) => {
          if (!open) onExit(true)
        }}
      >
        <BotDialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{request ? "核对 Bot 保存结果" : "Bot 资料"}</DialogTitle>
            <DialogDescription>{bot.name}</DialogDescription>
          </DialogHeader>
          {!supportsMutationEpoch && (
            <p role="alert" className="text-sm text-destructive">
              请先重启最新后台，再保存 Bot 修改。
            </p>
          )}
          {blocked && (
            <BotPendingSaveRecovery
              record={blocked}
              id={bot.id}
              dataEpoch={editingEpoch}
              onRepaired={() => onExit(true)}
            />
          )}
          {request && !feedback && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              有一次保存尚未确认。核对原请求后才能继续编辑，关闭窗口会保留这条记录。
            </p>
          )}
          {feedback && <BotErrorNoticeBody notice={feedback} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onExit(true)}>
              关闭
            </Button>
            {request && !blocked && (
              <Button
                disabled={
                  busy || authorityRetired || !supportsMutationEpoch || dataEpoch !== editingEpoch
                }
                onClick={() => void save(request)}
              >
                {busy ? "正在核对…" : "核对原请求"}
              </Button>
            )}
          </div>
        </BotDialogContent>
      </Dialog>
    </>
  )
}

/** Inspector identity occupies the same line in display and edit modes. */
export function BotProfileInlineField({
  bot,
  dataEpoch,
  field,
  enabled = true
}: Omit<EditorProps, "onExit"> & { enabled?: boolean }) {
  const [editing, setEditing] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const exit = (focus = false) => {
    setEditing(false)
    if (focus)
      requestAnimationFrame(() => {
        if (alive.current && document.activeElement === document.body)
          trigger.current?.focus({ preventScroll: true })
      })
  }
  const value = bot[field] ?? ""
  return editing ? (
    <BotProfileInlineEditor bot={bot} dataEpoch={dataEpoch} field={field} onExit={exit} />
  ) : (
    <button
      ref={trigger}
      type="button"
      className={`bot-profile-inline-value ${field === "title" ? "bot-profile-inline-label" : ""}`}
      disabled={!enabled}
      aria-label={field === "name" ? `修改 ${bot.name} 的名称` : "修改 Bot 标签"}
      title={value || "添加标签"}
      onClick={() => setEditing(true)}
    >
      {value || "添加标签"}
    </button>
  )
}
