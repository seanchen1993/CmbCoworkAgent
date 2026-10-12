import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Copy, Eye, EyeOff, KeyRound, RefreshCw, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgePendingWebhook,
  inspectPendingWebhook,
  discardPendingWebhook,
  rememberPendingWebhook
} from "@/lib/bot-webhook-pending"
import type { BotRoutine } from "../../../../shared/bot-types"
import type {
  BotWebhookChange,
  BotWebhookChanged,
  BotWebhookView
} from "../../../../shared/bot-webhooks"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

export function BotWebhook({ routine, close }: { routine: BotRoutine; close(): void }) {
  const viewVisible = useBotViewVisibility()
  const address = { botId: routine.botId, routineId: routine.id }
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [editingEpoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const restored = authorityRetired || editingEpoch !== dataEpoch
  const [record, setRecord] = useState(() => inspectPendingWebhook(address, editingEpoch))
  const acknowledged = useRef<{
    input: BotWebhookChange
    result?: BotWebhookChanged
    rejected?: string
  } | null>(null)
  const pending = record.kind === "valid" ? record.input : (acknowledged.current?.input ?? null)
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const refreshRecord = () => setRecord(inspectPendingWebhook(address, editingEpoch))
  const [value, setValue] = useState<BotWebhookView | null>(null)
  const [secret, setSecret] = useState<{ key: string; revision: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const [confirmation, setConfirmation] = useState<"rotate" | "revoke" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const alive = useRef(true),
    locked = useRef(false)
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
  const live = () => alive.current && currentEpoch()
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (restored) {
      acknowledged.current = null
      setSecret(null)
      setVisible(false)
    }
  }, [restored])
  useEffect(() => {
    if (!viewVisible || busy || restored) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const next = await botApi.webhook({ botId: routine.botId, routineId: routine.id })
        if (!disposed) {
          setValue(next)
          setSecret((previous) =>
            next.enabled && next.revision === previous?.revision ? previous : null
          )
          setReadError(null)
        }
      } catch (failure) {
        if (!disposed)
          setReadError(failure instanceof Error ? failure.message : "Webhook 状态读取失败")
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 5000)
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [routine.botId, routine.id, busy, restored, retry, viewVisible])
  const change = async (operation: "rotate" | "revoke") => {
    if (locked.current || blocked || !supported || !live() || !value) return
    locked.current = true
    const request = pending ?? {
      ...address,
      nonce: crypto.randomUUID(),
      expectedDataEpoch: editingEpoch,
      revision: value.revision,
      operation
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (!acknowledged.current) rememberPendingWebhook(request, editingEpoch)
      refreshRecord()
      let receipt = acknowledged.current
      if (!receipt) {
        try {
          receipt = { input: request, result: await botApi.changeWebhook(request) }
        } catch (failure) {
          const code = (failure as { code?: string } | null)?.code
          if (code === "data_epoch") {
            if (live()) {
              setAuthorityRetired(true)
              setError("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。")
            }
            return
          }
          if (
            !code ||
            ![
              "invalid_input",
              "not_found",
              "revision_conflict",
              "nonce_conflict",
              "webhook_schedule"
            ].includes(code)
          )
            throw failure
          receipt = {
            input: request,
            rejected: failure instanceof Error ? failure.message : "密钥操作被拒绝"
          }
        }
      }
      if (!currentEpoch()) return
      acknowledged.current = receipt
      if (live() && receipt.result) {
        const result = receipt.result
        setVisible(false)
        setSecret(result.key ? { key: result.key, revision: result.state.revision } : null)
        setValue((previous) => (previous ? { ...previous, ...result.state } : null))
        setNotice(
          request.operation === "revoke"
            ? "密钥已撤销，新的调用将被拒绝。"
            : result.key
              ? "新密钥已生效，请现在复制保存。"
              : "上次替换已确认。密钥只在生成时显示；如未保存，请再次替换。"
        )
      }
      if (!acknowledgePendingWebhook(request, editingEpoch)) {
        if (live()) setError("密钥操作结果已确认，本机记录尚未清除。重试只核对原记录。")
        return
      }
      if (!live()) return
      acknowledged.current = null
      refreshRecord()
      setConfirmation(null)
      if (receipt.rejected) setError(receipt.rejected)
    } catch (failure) {
      if (live()) {
        refreshRecord()
        setError(failure instanceof Error ? failure.message : "结果尚未确认，请核对原操作")
      }
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const restart = async () => {
    if (locked.current || !live()) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await botApi.restartWebhook(address)
      if (live()) setValue(next)
    } catch (failure) {
      if (live()) setError(failure instanceof Error ? failure.message : "启动失败")
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const copy = async (text: string, label: string) => {
    if (!live()) return
    try {
      await navigator.clipboard.writeText(text)
      if (live()) setNotice(`${label}已复制`)
    } catch {
      if (live()) setError("复制失败，请手动选择对应字段")
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Webhook size={18} />
            Webhook · {routine.name}
          </DialogTitle>
          <DialogDescription>由本机程序发送事件，触发这个例程。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {blocked && (
            <BotPendingSaveRecovery
              record={record}
              dataEpoch={editingEpoch}
              operationLabel="密钥操作"
              discard={(raw) => discardPendingWebhook(address, editingEpoch, raw)}
              onRepaired={() => {
                acknowledged.current = null
                refreshRecord()
                setError(null)
                setConfirmation(null)
              }}
            />
          )}
          {!supported && (
            <p role="alert" className="text-xs text-muted-foreground">
              当前 Bot 后台不支持恢复保护，请更新并重新连接后操作。
            </p>
          )}
          {restored && (
            <p role="alert" className="text-sm text-destructive">
              数据已恢复，请关闭后重新打开此窗口。
            </p>
          )}
          {(error || readError) && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <span>{error || readError}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRetry((n) => n + 1)}
                disabled={busy || restored}
              >
                刷新
              </Button>
            </div>
          )}
          {!value && !error && !readError && (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              正在读取触发配置…
            </p>
          )}
          {value && (
            <>
              <div className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
                <strong className="font-medium text-foreground">
                  {value.enabled
                    ? value.routineEnabled
                      ? "触发已启用"
                      : "例程已暂停"
                    : "触发未启用"}
                </strong>
                <p>地址仅供本机调用。窗口关闭后仍可接收；电脑关机或休眠时无法接收。</p>
                <p>HTTP 200 表示事件已接收，处理结果请查看 Bot 对话或例程记录。</p>
              </div>
              {value.listenerError && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 text-sm text-destructive"
                >
                  <span>{value.listenerError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || restored}
                    onClick={() => void restart()}
                  >
                    <RefreshCw size={14} />
                    重试启动
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="bot-webhook-url" className="text-xs font-medium">
                  POST 地址
                </label>
                <div className="flex gap-2">
                  <Input
                    id="bot-webhook-url"
                    value={value.url ?? "监听服务未启动"}
                    readOnly
                    className="font-mono text-xs"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="复制 Webhook 地址"
                    disabled={restored || !value.url}
                    onClick={() => value.url && void copy(value.url, "地址")}
                  >
                    <Copy size={15} />
                  </Button>
                </div>
              </div>
              {!restored && secret && value.revision === secret.revision && (
                <section
                  className="space-y-3 rounded-xl border border-border/70 p-4"
                  aria-label="新 Webhook 密钥"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">新密钥</h3>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={visible ? "隐藏 Webhook 密钥" : "显示 Webhook 密钥"}
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                    </Button>
                  </div>
                  <Input
                    type={visible ? "text" : "password"}
                    value={secret.key}
                    readOnly
                    aria-label="Webhook 密钥"
                    autoComplete="off"
                    className="font-mono text-xs"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copy(secret.key, "密钥")}
                    >
                      <Copy size={14} />
                      复制密钥
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copy(`Authorization: Bearer ${secret.key}`, "请求头")}
                    >
                      <Copy size={14} />
                      复制完整请求头
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    密钥仅在生成时显示，关闭后无法再次查看。请保存在调用方的凭据配置中。
                  </p>
                </section>
              )}
              <div className="space-y-1 text-xs leading-5 text-muted-foreground">
                <p>请求头：Authorization: Bearer &lt;密钥&gt;</p>
                <p>每次事件须提供 Idempotency-Key；重试沿用原值和正文，不会重复创建任务。</p>
                {value.eventPolicy && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p>最新状态模式 · 来源批次：{value.eventPolicy.sourceEpoch}</p>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                      {JSON.stringify(
                        {
                          entityKey: "order-123",
                          sourceEpoch: value.eventPolicy.sourceEpoch,
                          sequence: 1,
                          payload: { status: "approved" }
                        },
                        null,
                        2
                      )}
                    </pre>
                    <p>
                      同一对象使用递增安全整数序号。旧序号只记录、不派发；同版本内容不同会被拒绝。切换来源批次需编辑例程。外部更新使用目标系统的版本条件，已发出且结果未知的操作会阻塞后续状态。
                    </p>
                  </div>
                )}
                <p>
                  正文使用 JSON，最多 32 KiB；展开后最多 32,000 字符。每例程最多 60 次/分钟、20
                  项待处理任务；限流时返回 429，请稍后重试。
                </p>
              </div>
              {value.lastAcceptedAt && (
                <p className="text-xs text-muted-foreground">
                  最近接收：{new Date(value.lastAcceptedAt).toLocaleString()}
                </p>
              )}
              {pending ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    上次操作的结果尚未确认，请核对原操作后再修改。
                  </p>
                  <Button
                    size="sm"
                    disabled={busy || blocked || restored || !supported}
                    onClick={() => void change(pending.operation)}
                  >
                    核对原操作
                  </Button>
                </div>
              ) : confirmation ? (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm">
                    {confirmation === "rotate"
                      ? "替换后旧密钥立即失效，调用方需要改用新密钥。"
                      : "撤销后停止接收新事件，已经接收的任务会保留。"}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={confirmation === "revoke" ? "destructive" : "default"}
                      disabled={busy || blocked || restored || !supported}
                      onClick={() => void change(confirmation)}
                    >
                      {confirmation === "rotate" ? "确认替换密钥" : "确认撤销密钥"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmation(null)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy || blocked || restored || !supported}
                    onClick={() =>
                      value.enabled ? setConfirmation("rotate") : void change("rotate")
                    }
                  >
                    <KeyRound size={14} />
                    {value.enabled ? "替换密钥" : "生成密钥并启用"}
                  </Button>
                  {value.enabled && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || blocked || restored || !supported}
                      onClick={() => setConfirmation("revoke")}
                    >
                      撤销密钥
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {notice && (
            <p role="status" className="text-xs text-muted-foreground">
              {notice}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
