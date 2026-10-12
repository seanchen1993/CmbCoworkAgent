import { botApi } from "@/lib/bot-api"
import { useLayoutEffect, useRef, useState } from "react"
import { MessageSquarePlus, Send, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotRunAddress } from "../../../../shared/bot-run-history"
import type { BotRunStatus } from "../../../../shared/bot-types"
import type {
  BotWorkflowControl,
  BotWorkflowControlReceipt
} from "../../../../shared/bot-workflow-control"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgePendingWorkflowControl,
  inspectPendingWorkflowControl,
  discardPendingWorkflowControl,
  rememberPendingWorkflowControl
} from "@/lib/bot-workflow-pending"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

/** Controls act on the selected durable task, never on the conversation's next run. */
export function BotWorkflowControls({
  address,
  revision,
  status,
  changed
}: {
  address: BotRunAddress
  revision: number
  status: BotRunStatus
  changed(): void
}) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [editingEpoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const restored = authorityRetired || editingEpoch !== dataEpoch
  const [record, setRecord] = useState(() => inspectPendingWorkflowControl(address, editingEpoch))
  const acknowledged = useRef<{
    input: BotWorkflowControl
    result?: BotWorkflowControlReceipt
    rejected?: string
  } | null>(null)
  const pending = record.kind === "valid" ? record.input : (acknowledged.current?.input ?? null)
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const refreshRecord = () => setRecord(inspectPendingWorkflowControl(address, editingEpoch))
  const [draft, setDraft] = useState(pending?.operation === "message" ? pending.text : "")
  const [action, setAction] = useState<"message" | "cancel" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const alive = useRef(true)
  const locked = useRef(false)
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
  const live = () => alive.current && currentEpoch()
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const running = status === "running" || status === "waiting_input"
  const submit = async () => {
    if (locked.current || blocked || !supported || !live() || (!action && !pending)) return
    const request = pending ?? {
      ...address,
      revision,
      nonce: crypto.randomUUID(),
      expectedDataEpoch: editingEpoch,
      ...(action === "message"
        ? { operation: "message" as const, text: draft.trim() }
        : { operation: "cancel" as const })
    }
    locked.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (!acknowledged.current) rememberPendingWorkflowControl(request, editingEpoch)
      refreshRecord()
      let receipt = acknowledged.current
      if (!receipt) {
        try {
          receipt = { input: request, result: await botApi.workflowControl(request) }
        } catch (cause) {
          const code =
            cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""
          if (code === "data_epoch") {
            if (live()) {
              setAuthorityRetired(true)
              setError("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。")
            }
            return
          }
          if (
            ![
              "revision_conflict",
              "workflow_child_inactive",
              "workflow_child_scope",
              "steering_scope",
              "stale_lease",
              "review_required",
              "invalid_input",
              "not_found",
              "nonce_conflict"
            ].includes(code)
          )
            throw cause
          receipt = {
            input: request,
            rejected: cause instanceof Error ? cause.message : "子任务操作被拒绝"
          }
        }
      }
      if (!currentEpoch()) return
      acknowledged.current = receipt
      if (!acknowledgePendingWorkflowControl(request, editingEpoch)) {
        if (live()) setError("子任务操作结果已确认，本机记录尚未清除。重试只核对原记录。")
        return
      }
      if (!live()) return
      refreshRecord()
      if (receipt.rejected) {
        changed()
        acknowledged.current = null
        setError(receipt.rejected)
        return
      }
      setAction(null)
      if (request.operation === "message") setDraft("")
      setNotice(
        request.operation === "message"
          ? "补充要求已送达此子任务，将在下一次执行前处理。"
          : receipt.result?.status === "cancelled"
            ? "子任务已停止。"
            : "停止请求已送达，正在等待已开始操作的回执。"
      )
      changed()
      acknowledged.current = null
    } catch (cause) {
      if (live()) {
        refreshRecord()
        setError(
          acknowledged.current
            ? "子任务操作结果已确认，状态同步失败。重试只核对原记录。"
            : cause instanceof Error
              ? cause.message
              : "结果未确认，请重试原请求"
        )
      }
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  if (!running && status !== "queued" && !pending && !blocked && !notice && !error) return null
  return (
    <section className="space-y-3 rounded-xl border border-border/70 p-3" aria-label="子任务操作">
      {blocked && (
        <BotPendingSaveRecovery
          record={record}
          dataEpoch={editingEpoch}
          operationLabel="子任务操作"
          discard={(raw) => discardPendingWorkflowControl(address, editingEpoch, raw)}
          onRepaired={() => {
            acknowledged.current = null
            refreshRecord()
            setError(null)
          }}
        />
      )}
      {!supported && (
        <p role="alert" className="text-xs text-muted-foreground">
          当前 Bot 后台不支持恢复保护，请更新并重新连接后操作。
        </p>
      )}
      {restored && (
        <p role="alert" className="text-xs text-destructive">
          数据已恢复，请关闭后重新打开任务记录。
        </p>
      )}
      {pending && !restored && (
        <p className="text-xs text-muted-foreground">
          上次操作的结果尚未确认，请核对原请求，避免重复提交。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {running && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || blocked || !!pending || restored || !supported}
            onClick={() => {
              setAction("message")
              setNotice(null)
            }}
          >
            <MessageSquarePlus size={14} />
            补充要求
          </Button>
        )}
        {(running || status === "queued") && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || blocked || !!pending || restored || !supported}
            onClick={() => {
              setAction("cancel")
              setNotice(null)
            }}
          >
            <Square size={13} />
            停止子任务
          </Button>
        )}
      </div>
      {(action === "message" || pending?.operation === "message") && (
        <textarea
          className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          aria-label="给此子任务补充要求"
          placeholder="补充约束、修正方向或提供缺失信息…"
          rows={3}
          maxLength={32_000}
          value={draft}
          disabled={busy || blocked || !!pending || restored || !supported}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {(action === "cancel" || pending?.operation === "cancel") && (
        <p className="text-xs text-muted-foreground">
          停止此子任务。已完成的操作和工作区会保留，其他子任务继续执行。
        </p>
      )}
      {(action || pending) && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={(pending?.operation ?? action) === "cancel" ? "destructive" : "default"}
            disabled={
              busy ||
              blocked ||
              restored ||
              !supported ||
              (!pending && action === "message" && !draft.trim())
            }
            onClick={() => void submit()}
          >
            {action === "message" && <Send size={13} />}
            {busy
              ? "正在处理…"
              : pending
                ? "重试原请求"
                : action === "message"
                  ? "发送补充要求"
                  : "确认停止"}
          </Button>
          {!pending && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAction(null)
                setError(null)
              }}
            >
              取消
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
