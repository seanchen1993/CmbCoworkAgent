import { useBotPrivateMemoryMutation } from "@/lib/use-bot-private-memory-mutation"
import { BotPrivateMemoryRecovery } from "./BotPrivateMemoryRecovery"
import { botApi } from "@/lib/bot-api"
import { BotModelUsage } from "./BotModelUsage"
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { ChevronDown, FileText, Loader2, Pencil, RotateCcw, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import type { BotMemory, BotMessage } from "../../../../shared/bot-types"
import {
  BOT_SHARED_MEMORY_TEXT_LIMIT,
  type BotMemoryPolicy,
  type BotMemoryRetryInput
} from "../../../../shared/bot-memory"
import { pendingMemoryRetryStore } from "@/lib/bot-memory-pending"
import { useBotEpochOperation } from "@/lib/use-bot-epoch-operation"
import { BotDomainError } from "../../../../shared/bot-types"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

interface MemoryCardProps {
  memory: BotMemory
  reload(): Promise<void>
  close(): void
  actions?: {
    save(text: string, revision: number): Promise<boolean>
    remove(revision: number): Promise<boolean>
    session: { fieldsDisabled: boolean }
    shared?: boolean
  }
}
export function MemoryCard(props: MemoryCardProps) {
  return props.actions ? (
    <MemoryCardView {...props} actions={props.actions} />
  ) : (
    <PrivateMemoryCard {...props} />
  )
}
function PrivateMemoryCard(props: MemoryCardProps) {
  const session = useBotPrivateMemoryMutation(props.memory.botId, async (_receipt, live) => {
    if (!live()) return
    await props.reload()
  })
  return (
    <>
      <BotPrivateMemoryRecovery session={session} />
      <MemoryCardView
        {...props}
        actions={{
          shared: false,
          session,
          save: (text, revision) => session.saveMemory({ id: props.memory.id, revision, text }),
          remove: (revision) => session.removeMemory(props.memory.id, revision)
        }}
      />
    </>
  )
}
function MemoryCardView({
  memory,
  close,
  actions
}: MemoryCardProps & { actions: NonNullable<MemoryCardProps["actions"]> }) {
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(memory.text)
  const [revision, setRevision] = useState(memory.revision)
  const [expanded, setExpanded] = useState(false),
    [evidence, setEvidence] = useState<BotMessage[]>([])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const currentDataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const support = useBotWorkspaceStore((state) =>
    Boolean(
      state.host?.capabilities?.includes("mutation-data-epoch-v2") &&
      state.host.capabilities.includes("memory-mutation-epoch")
    )
  )
  const [dataEpoch] = useState(currentDataEpoch)
  const [retired, setRetired] = useState(false)
  const locked = useRef(false),
    lifetime = useRef({ mounted: false, generation: 0 })
  useLayoutEffect(() => {
    const owner = lifetime.current
    owner.mounted = true
    owner.generation++
    return () => {
      owner.mounted = false
      owner.generation++
    }
  }, [])
  const currentEpoch = useCallback(
    () => Boolean(dataEpoch) && useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch,
    [dataEpoch]
  )
  const live = useCallback(() => lifetime.current.mounted && currentEpoch(), [currentEpoch])
  const restored = retired || currentDataEpoch !== dataEpoch
  const disabled = busy || restored || !support || !dataEpoch || actions.session.fieldsDisabled
  const act = async (operation: () => Promise<unknown>) => {
    if (!live() || disabled || locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    const generation = lifetime.current.generation
    const mounted = () => lifetime.current.mounted && lifetime.current.generation === generation
    const active = () => mounted() && currentEpoch()
    try {
      const completed = await operation()
      if (!active()) return
      if (completed === true) setEditing(false)
    } catch (failure) {
      if (active()) {
        if ((failure as { code?: string })?.code === "data_epoch") setRetired(true)
        setError(failure instanceof Error ? failure.message : "操作失败")
      }
    } finally {
      locked.current = false
      if (mounted()) setBusy(false)
    }
  }
  const sources = useMemo(() => memory.evidence ?? [], [memory.evidence])
  useEffect(() => {
    if (!expanded || !sources.length || restored || !dataEpoch) return
    let alive = true
    setEvidence([])
    void Promise.all(
      sources.map((source) =>
        botApi.message({ conversationId: source.conversationId, id: source.messageId })
      )
    )
      .then((items) => {
        if (alive && live()) setEvidence(items)
      })
      .catch(() => {
        if (alive && live()) setError("来源暂时无法读取，请稍后重试")
      })
    return () => {
      alive = false
    }
  }, [expanded, sources, restored, dataEpoch, live])
  return (
    <article className="space-y-3 rounded-xl border bg-background p-4" aria-label="记忆条目">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {memory.origin === "synthesized" ? <Sparkles size={13} /> : <FileText size={13} />}
          <span>
            {memory.origin === "synthesized"
              ? "自动整理 · 模型核验"
              : "显式记忆 · 自动整理不会修改"}
          </span>
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="编辑记忆"
              disabled={disabled}
              onClick={() => {
                setText(memory.text)
                setRevision(memory.revision)
                setError(null)
                setEditing(true)
              }}
            >
              <Pencil size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="删除记忆"
              disabled={disabled}
              onClick={() =>
                actions.shared !== false
                  ? setConfirmDelete(memory.revision)
                  : void act(() => actions.remove(memory.revision))
              }
            >
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>
      {confirmDelete && actions.shared !== false && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-3">
          <p className="text-xs">
            删除后，此范围内的所有 Bot 都无法再检索这条共享记忆。已发送到对话中的内容仍保留。
          </p>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setConfirmDelete(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => void act(() => actions.remove(confirmDelete!))}
            >
              确认删除共享记忆
            </Button>
          </div>
        </div>
      )}
      {editing ? (
        <div className="space-y-2">
          <textarea
            className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            aria-label="编辑记忆内容"
            value={text}
            maxLength={actions.shared !== false ? BOT_SHARED_MEMORY_TEXT_LIMIT : 16000}
            onChange={(event) => setText(event.target.value)}
            disabled={disabled}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">保存后按你的修订保留，自动整理不会覆盖。</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={disabled || !text.trim()}
              onClick={() => void act(() => actions.save(text, revision))}
            >
              {busy && <Loader2 size={13} className="animate-spin" />}保存修订
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{memory.text}</p>
      )}
      {!!sources.length && (
        <div className="border-t pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-0 text-xs text-muted-foreground"
            aria-expanded={expanded}
            disabled={restored}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown size={13} className={expanded ? "rotate-180" : ""} />
            {sources.length} 条{memory.origin === "explicit" ? "原始任务来源" : "任务依据"}
          </Button>
          {expanded && (
            <div className="mt-2 space-y-2">
              {!evidence.length && !error && (
                <p className="text-xs text-muted-foreground">正在读取依据…</p>
              )}
              {evidence.map((message) => (
                <div key={message.id} className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs">
                  <p className="text-muted-foreground">
                    {new Date(message.createdAt).toLocaleString()}
                  </p>
                  <p className="line-clamp-4 whitespace-pre-wrap break-words">{message.text}</p>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    disabled={restored}
                    onClick={() => {
                      if (!live()) return
                      useBotWorkspaceStore.setState({
                        navigation: {
                          conversationId: message.conversationId,
                          messageId: message.id
                        }
                      })
                      close()
                    }}
                  >
                    定位对话
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {(restored || !support || !dataEpoch) && (
        <p role="alert" className="text-xs text-muted-foreground">
          {restored
            ? "工作区数据已恢复，请关闭后重新打开核对记忆。"
            : "请更新 Bot 后台后修改记忆，原内容保持不变。"}
        </p>
      )}
      {error && !restored && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  )
}

const outcomes: Record<string, string> = {
  queued: "已加入整理队列",
  running: "正在整理任务经验",
  committed: "最近整理已完成",
  "no-work": "最近任务没有需要新增的记忆",
  failed: "整理暂未完成，原有记忆已保留",
  "invalid-output": "整理结果未通过检查，原有记忆已保留",
  rejected: "核验未通过，原有记忆已保留",
  interrupted: "整理曾中断，原有记忆已保留",
  "context-limit": "内容超出模型上下文，请调整模型后重试",
  budget: "输出额度已用尽，额度恢复后自动重试",
  restored: "已恢复备份，后续任务将继续积累经验"
}
export function BotMemoryPanel({
  botId,
  memories,
  reload,
  close
}: {
  botId: string
  memories: BotMemory[]
  reload(): Promise<void>
  close(): void
}) {
  const [newText, setNewText] = useState("")
  const memoryMutation = useBotPrivateMemoryMutation(botId, async (receipt, live) => {
    if (!live()) return
    await reload()
    if (live() && receipt.input.operation === "save" && !receipt.input.request.id) setNewText("")
  })
  const viewVisible = useBotViewVisibility()
  const support = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("memory-synthesis") ?? false
  )
  const scopedPolicy = useBotWorkspaceStore((state) =>
    Boolean(
      state.host?.capabilities?.includes("mutation-data-epoch-v2") &&
      state.host.capabilities.includes("memory-mutation-epoch")
    )
  )
  const [policy, setPolicy] = useState<BotMemoryPolicy | null>(null)
  const [toggleBusy, setToggleBusy] = useState(false),
    [readError, setReadError] = useState<string | null>(null)
  const reading = useRef(0),
    locked = useRef(false),
    mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const operation = useBotEpochOperation<BotMemoryRetryInput, BotMemoryPolicy>({
    scope: `memory-retry:${botId}`,
    pending: {
      inspect: (epoch) => pendingMemoryRetryStore.inspect(botId, epoch),
      remember: pendingMemoryRetryStore.remember,
      acknowledge: pendingMemoryRetryStore.acknowledge,
      discard: (epoch, raw) => pendingMemoryRetryStore.discard(botId, epoch, raw)
    },
    matchesInput: (input) => input.botId === botId,
    verifies: (input, receipt) =>
      receipt.dataEpoch === input.dataEpoch &&
      receipt.revision === input.revision + 1 &&
      receipt.lastOutcome === "queued",
    change: botApi.retryMemory,
    definitiveErrors: [
      "invalid_input",
      "not_found",
      "revision_conflict",
      "nonce_conflict",
      "memory_disabled",
      "memory_running",
      "memory_queue_full"
    ],
    onConfirmed: async (_receipt, live) => {
      if (live()) await readCurrent(live)
    }
  })
  const { pending: pendingRetry, restored, epoch, isCurrent, refreshRecord, retire } = operation
  const busy = toggleBusy || operation.busy
  const error = restored ? null : operation.error || readError
  const readCurrent = useCallback(
    async (shouldApply: () => boolean) => {
      if (!shouldApply() || !isCurrent()) return
      const request = ++reading.current,
        next = await botApi.memoryPolicy(botId)
      if (!shouldApply() || !isCurrent() || request !== reading.current) return
      // The optional field belongs to an older Host, and must never be filled from the renderer.
      if (next.dataEpoch && next.dataEpoch !== epoch) {
        retire()
        throw new BotDomainError("data_epoch", "工作区数据已恢复，请重新打开记忆设置。")
      }
      setPolicy(next)
      refreshRecord()
      setReadError(next.dataEpoch ? null : "后台未提供数据版本，请更新 Bot 后台后再修改记忆设置。")
    },
    [botId, epoch, isCurrent, refreshRecord, retire]
  )
  useEffect(() => {
    if (!support || !viewVisible || busy || restored) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        await readCurrent(() => !disposed)
      } catch (failure) {
        if (!disposed && isCurrent())
          setReadError(failure instanceof Error ? failure.message : "记忆设置读取失败")
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 3000)
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [support, viewVisible, busy, restored, readCurrent, isCurrent])
  const revisionKey = policy ? JSON.stringify([policy.lastAttemptAt, policy.lastOutcome]) : null
  const reloadAfterPolicyChange = useEffectEvent(async () => {
    try {
      await reload()
    } catch {
      if (viewVisible && isCurrent()) setReadError("记忆读取失败")
    }
  })
  useEffect(() => {
    if (revisionKey && viewVisible && !restored && isCurrent()) void reloadAfterPolicyChange()
  }, [revisionKey, viewVisible, restored, isCurrent])
  const toggle = async (enabled: boolean) => {
    if (
      !scopedPolicy ||
      !policy?.dataEpoch ||
      policy.dataEpoch !== epoch ||
      locked.current ||
      operation.isSaving() ||
      operation.fieldsDisabled ||
      !isCurrent()
    )
      return
    locked.current = true
    ++reading.current
    setToggleBusy(true)
    setReadError(null)
    operation.clearError()
    try {
      const next = await botApi.setMemoryPolicy({
        botId,
        expectedDataEpoch: policy.dataEpoch,
        revision: policy.revision,
        enabled
      })
      if (!isCurrent()) return
      if (next.dataEpoch !== epoch) {
        retire()
        setReadError("工作区数据已恢复，请重新打开记忆设置。")
        return
      }
      if (next.enabled !== enabled || next.revision !== policy.revision + 1) {
        setReadError("记忆设置回执与原操作不一致，请重新读取设置。")
        return
      }
      setPolicy(next)
    } catch (failure) {
      if (isCurrent()) {
        if ((failure as { code?: string })?.code === "data_epoch") retire()
        setReadError(failure instanceof Error ? failure.message : "设置失败")
      }
    } finally {
      locked.current = false
      if (mounted.current) setToggleBusy(false)
    }
  }
  const retry = async () => {
    if (!policy?.dataEpoch || policy.dataEpoch !== epoch || locked.current) return
    ++reading.current
    await operation.save(() => ({
      botId,
      revision: policy.revision,
      dataEpoch: epoch,
      nonce: crypto.randomUUID()
    }))
  }
  const canRetry = Boolean(
    policy?.dataEpoch &&
    (pendingRetry ||
      operation.acknowledged ||
      (policy.enabled &&
        (policy.failed ||
          (!policy.pending &&
            ["failed", "invalid-output", "rejected", "interrupted", "context-limit"].includes(
              policy.lastOutcome ?? ""
            )))))
  )
  return (
    <div className="space-y-3">
      {support && (
        <div className="space-y-2 rounded-xl border bg-muted/25 p-4">
          <div className="flex items-center justify-between gap-4">
            <label
              htmlFor={`memory-auto-${botId}`}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <Sparkles size={15} />
              自动整理任务经验
            </label>
            <Switch
              id={`memory-auto-${botId}`}
              checked={policy?.enabled ?? false}
              aria-busy={toggleBusy}
              disabled={!scopedPolicy || !policy?.dataEpoch || busy || operation.fieldsDisabled}
              onCheckedChange={(value) => void toggle(value)}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            使用此 Bot
            配置的模型，从已完成的私聊任务中提炼并核验记忆。关闭后停止整理，已有记忆保留。
          </p>
          {!scopedPolicy && (
            <p className="text-xs text-muted-foreground">
              后台暂不支持工作区版本校验，请更新 Bot 后台后再修改自动整理设置。
            </p>
          )}
          {policy?.enabled && (
            <p className="text-xs text-muted-foreground" role="status">
              {policy.lastOutcome
                ? (outcomes[policy.lastOutcome] ?? "等待后续任务")
                : "完成任务后自动整理"}
              {policy.pending ? ` · ${policy.pending} 项待整理` : ""}
              {policy.failed ? ` · ${policy.failed} 项未完成` : ""}
            </p>
          )}
          {canRetry && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 rounded-lg"
              disabled={
                busy ||
                operation.saveDisabled ||
                (!pendingRetry && !operation.acknowledged && policy?.lastOutcome === "running")
              }
              onClick={() => void retry()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              {operation.acknowledged
                ? "同步已确认整理"
                : pendingRetry
                  ? "确认重试结果"
                  : "重试整理"}
            </Button>
          )}
          {restored && (
            <p role="alert" className="text-xs text-destructive">
              工作区数据已恢复，请重新打开记忆设置。原操作记录仍保留。
            </p>
          )}
          {operation.blocked && (
            <BotPendingSaveRecovery
              record={operation.record}
              dataEpoch={epoch}
              discard={operation.discard}
              onRepaired={operation.refreshRecord}
              operationLabel="重试"
            />
          )}
          {operation.acknowledged && (
            <p role="status" className="text-xs text-muted-foreground">
              整理请求已确认，重试只核对本机记录和当前整理状态。
            </p>
          )}
          <BotModelUsage value={policy?.usage} memory />
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {!memories.length && (
        <p className="py-5 text-center text-sm text-muted-foreground">
          还没有记忆。可以添加长期偏好，或在完成任务后查看整理结果。
        </p>
      )}
      <BotPrivateMemoryRecovery session={memoryMutation} />
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          reload={reload}
          close={close}
          actions={{
            shared: false,
            session: memoryMutation,
            save: (text, revision) => memoryMutation.saveMemory({ id: memory.id, revision, text }),
            remove: (revision) => memoryMutation.removeMemory(memory.id, revision)
          }}
        />
      ))}
      <form
        className="space-y-3 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (newText.trim()) void memoryMutation.saveMemory({ text: newText })
        }}
      >
        <h3 className="text-sm font-medium">添加记忆</h3>
        <textarea
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          aria-label="内容"
          rows={4}
          value={newText}
          onChange={(event) => setNewText(event.target.value)}
          placeholder="需要长期记住的事实或偏好"
          disabled={memoryMutation.fieldsDisabled}
          maxLength={16000}
        />
        <Button disabled={memoryMutation.fieldsDisabled || !newText.trim()}>
          {memoryMutation.busy ? "保存中…" : "保存"}
        </Button>
      </form>
    </div>
  )
}
