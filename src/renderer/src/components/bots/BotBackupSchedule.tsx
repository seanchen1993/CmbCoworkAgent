import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useCallback, useEffect, useRef, useState } from "react"
import { Clock3, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { pendingBackupScheduleStore } from "@/lib/bot-backup-pending"
import { useBotEpochOperation } from "@/lib/use-bot-epoch-operation"
import { BotDomainError } from "../../../../shared/bot-types"
import type {
  BotBackupScheduleChange,
  BotBackupScheduleState,
  BotBackupScheduleView
} from "../../../../shared/bot-backup-schedule"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

export function BotBackupSchedule({ disabled, onBackup }: { disabled: boolean; onBackup(): void }) {
  const viewVisible = useBotViewVisibility()
  const [value, setValue] = useState<BotBackupScheduleView | null>(null)
  const [draft, setDraft] = useState<{
    revision: number
    enabled: boolean
    hours: string
    submitted: boolean
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const reading = useRef(0),
    lastBackup = useRef<string | null>(null),
    observer = useRef(onBackup)
  observer.current = onBackup
  const operation = useBotEpochOperation<BotBackupScheduleChange, BotBackupScheduleState>({
    scope: "backup-schedule",
    pending: pendingBackupScheduleStore,
    matchesInput: () => true,
    verifies: (input, receipt) =>
      receipt.revision === input.revision + 1 &&
      receipt.enabled === input.enabled &&
      receipt.intervalHours === input.intervalHours,
    change: botApi.changeBackupSchedule,
    definitiveErrors: ["invalid_input", "revision_conflict", "nonce_conflict", "not_found"],
    onConfirmed: async (_receipt, live) => {
      if (live()) await readCurrent(live)
    }
  })
  const { busy, pending, restored, epoch, isCurrent, refreshRecord, retire } = operation
  const readCurrent = useCallback(
    async (shouldApply: () => boolean) => {
      if (!isCurrent() || !shouldApply()) return
      const request = ++reading.current,
        next = await botApi.backupSchedule()
      if (request !== reading.current || !isCurrent() || !shouldApply()) return
      if (next.dataEpoch !== epoch) {
        retire()
        throw new BotDomainError("data_epoch", "工作区数据已恢复，请重新打开备份配置。")
      }
      setValue(next)
      refreshRecord()
      setLoadError(null)
      if (next.lastBackup && next.lastBackup.id !== lastBackup.current) {
        lastBackup.current = next.lastBackup.id
        observer.current()
      }
    },
    [epoch, isCurrent, refreshRecord, retire]
  )
  useEffect(() => {
    if (!viewVisible || disabled || busy || restored) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        await readCurrent(() => !disposed)
      } catch (failure) {
        if (!disposed && isCurrent())
          setLoadError(failure instanceof Error ? failure.message : "配置读取失败")
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 5000)
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [disabled, busy, restored, readCurrent, reload, viewVisible, isCurrent])
  const activeDraft =
    draft &&
    (!draft.submitted ||
      operation.record.kind !== "empty" ||
      operation.acknowledged ||
      draft.revision === value?.revision)
      ? draft
      : null
  const enabled = pending?.enabled ?? activeDraft?.enabled ?? value?.enabled ?? false
  const hours = String(pending?.intervalHours ?? activeDraft?.hours ?? value?.intervalHours ?? 24)
  const edit = (next: { enabled?: boolean; hours?: string }) => {
    if (!value || operation.fieldsDisabled || disabled) return
    setDraft({
      revision: activeDraft?.revision ?? value.revision,
      enabled,
      hours,
      submitted: false,
      ...next
    })
    setNotice(null)
    operation.clearError()
  }
  async function save() {
    if (disabled || !value?.available) return
    ++reading.current
    setNotice(null)
    if (activeDraft) setDraft({ ...activeDraft, submitted: true })
    const accepted = await operation.save(() => ({
      nonce: crypto.randomUUID(),
      dataEpoch: epoch,
      revision: activeDraft?.revision ?? value.revision,
      enabled,
      intervalHours: Number(hours)
    }))
    if (accepted && isCurrent()) {
      setDraft(null)
      setNotice("保存操作已确认。正在复制的备份会继续完成。")
    }
  }
  const validHours = /^\d+$/.test(hours) && Number(hours) >= 1 && Number(hours) <= 168
  const controlsDisabled = disabled || operation.fieldsDisabled || !value?.available
  const error = restored ? null : operation.error || loadError
  return (
    <section aria-label="定时备份" className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Clock3 className="size-4 text-muted-foreground" />
          定时备份
        </div>
        <Switch
          aria-label="启用定时备份"
          checked={enabled}
          disabled={controlsDisabled}
          onCheckedChange={(next) => {
            edit({ enabled: next })
          }}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>每</span>
        <Input
          aria-label="备份间隔（小时）"
          className="h-7 w-16 text-center"
          type="number"
          min={1}
          max={168}
          value={hours}
          disabled={controlsDisabled}
          onChange={(event) => {
            edit({ hours: event.target.value })
          }}
        />
        <span>小时备份一次</span>
        <Button
          className="ml-auto"
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            operation.saveDisabled ||
            !value?.available ||
            (!pending && !operation.acknowledged && (!activeDraft || !validHours))
          }
          onClick={() => void save()}
        >
          {busy ? (
            <LoaderCircle className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
          ) : null}
          {operation.acknowledged ? "同步已确认配置" : pending ? "确认上次配置" : "保存配置"}
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {value?.running
          ? "正在后台备份…"
          : !value
            ? "正在读取配置…"
            : !value.available
              ? "后台备份服务尚未就绪"
              : value.enabled
                ? `${value.error ? "下次重试" : "下次备份"}：${new Date(value.retryAt ?? value.nextAt ?? Date.now()).toLocaleString()}`
                : "关闭界面后仍可按时备份；电脑和 Bot 后台需保持运行。"}
      </p>
      {restored && (
        <p role="alert" className="text-xs text-destructive">
          工作区数据已恢复，请重新打开备份配置。原操作记录仍保留。
        </p>
      )}
      {operation.blocked && (
        <BotPendingSaveRecovery
          record={operation.record}
          dataEpoch={epoch}
          discard={operation.discard}
          onRepaired={operation.refreshRecord}
        />
      )}
      {operation.acknowledged && (
        <p role="status" className="text-xs text-muted-foreground">
          操作结果已确认，重试只核对本机记录和当前配置。
        </p>
      )}
      {pending && (
        <p className="text-xs text-muted-foreground">上次配置尚未确认，请使用原操作核对结果。</p>
      )}
      {value?.lastBackup && (
        <p className="text-xs text-muted-foreground">
          最近完成：{new Date(value.lastBackup.createdAt).toLocaleString()}
        </p>
      )}
      {!restored && (error || value?.error) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-xs text-destructive"
        >
          <span>{error || value?.error}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => {
              operation.clearError()
              setLoadError(null)
              setReload((n) => n + 1)
            }}
          >
            刷新
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  )
}
