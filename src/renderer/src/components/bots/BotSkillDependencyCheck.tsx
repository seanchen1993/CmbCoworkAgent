import { useCallback, useEffect, useRef, useState } from "react"
import { CheckCircle2, CircleHelp, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useBotTrackedWork } from "@/lib/use-bot-tracked-work"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  pendingSkillDependencyStore,
  isDefinitiveSkillDependencyError
} from "@/lib/bot-skill-dependency-pending"
import type { BotSkill } from "../../../../shared/bot-types"
import {
  botSkillDependencyReceipt,
  type BotSkillDependencyCheckResult,
  type BotSkillDependencyView
} from "../../../../shared/bot-skill-dependencies"
import type { SkillDependencyCheck } from "../../../../shared/skill-dependencies"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

const stateLabel = {
  satisfied: "已满足",
  missing: "有缺失",
  unverified: "未核验"
}
const reasonLabel: Record<BotSkillDependencyCheckResult["reason"], string> = {
  observed: "已确认",
  not_found: "未找到",
  version_too_old: "版本不足",
  platform_mismatch: "系统不匹配",
  unsupported: "此项不能自动核验",
  permission_denied: "未获许可",
  environment_unavailable: "执行环境未就绪",
  probe_failed: "探测未完成",
  probe_output_invalid: "结果无法确认",
  command_exit_unconfirmed: "命令退出待确认",
  not_checked: "尚未检查",
  stale_skill: "技能版本已变化",
  stale_environment: "执行环境或许可已变化",
  expired: "检查记录已过期",
  interrupted: "检查未完成",
  superseded: "已有后续检查"
}
function checkLabel(value: SkillDependencyCheck): string {
  switch (value.kind) {
    case "executable":
      return value.minimumVersion ? `${value.name} ≥ ${value.minimumVersion}` : value.name
    case "any-executable":
      return value.names.join(" / ")
    case "environment":
      return `${value.name} 是否提供`
    case "file":
      return `${value.path}${value.type === "directory" ? "（目录）" : ""}`
    case "platform":
      return value.platforms
        .map((item) => ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[item])
        .join(" / ")
    case "unsupported":
      return value.label
  }
}
export function BotSkillDependencyCheck({
  skill,
  disabled = false
}: {
  skill: BotSkill
  disabled?: boolean
}) {
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-dependencies") ?? false
  )
  const historySupported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-dependency-history") ?? false
  )
  const readable = supported || historySupported
  const hostId = useBotWorkspaceStore((state) => state.host?.hostId ?? "offline")
  const mutationSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const epoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(epoch)
  const [record, setRecord] = useState(() =>
    pendingSkillDependencyStore.inspect(skill.botId, skill.id, editingEpoch)
  )
  const pending = record.kind === "valid" ? record.input : null
  const [loadedView, setLoadedView] = useState<{
    hostId: string
    botId: string
    id: string
    version: number
    value: BotSkillDependencyView
  } | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const alive = useRef(false),
    generation = useRef(0),
    locked = useRef(false)
  const retired = editingEpoch !== epoch
  const view =
    readable &&
    !retired &&
    loadedView?.hostId === hostId &&
    loadedView.botId === skill.botId &&
    loadedView.id === skill.id &&
    loadedView.version === skill.version
      ? loadedView.value
      : null
  const tracked = pending?.receipt?.runId ?? view?.history[0]?.receipt.runId
  // Track this task's status, not every snapshot/cursor or another Bot's work.
  const trackedState = useBotTrackedWork(
    tracked ? { kind: "run", botId: skill.botId, runId: tracked } : undefined
  )
  const legacyRunStatus = useBotWorkspaceStore((state) =>
    tracked
      ? (state.snapshot?.runs.find((item) => item.id === tracked)?.status ?? "absent")
      : "none"
  )
  const runStatus = trackedState.supported
    ? trackedState.value
      ? (trackedState.value.run?.status ?? "absent")
      : "loading"
    : legacyRunStatus
  const stopReading = useCallback(() => {
    alive.current = false
    generation.current++
  }, [])
  useEffect(() => {
    alive.current = true
    return stopReading
  }, [stopReading])
  const live = useCallback(
    (ticket: number) =>
      alive.current &&
      generation.current === ticket &&
      (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch,
    [editingEpoch]
  )
  const { botId, id, version } = skill
  const refresh = useCallback(
    async (ticket: number) => {
      const next = await botApi.skillDependencies({ botId, id, version })
      if (!live(ticket)) return
      setLoadedView({ hostId, botId, id, version, value: next })
      setError(null)
      const current = pendingSkillDependencyStore.inspect(botId, id, editingEpoch)
      if (current.kind === "valid" && current.input.receipt) {
        if (!pendingSkillDependencyStore.complete(current.input))
          throw new Error("检查任务已确认；本机记录未清理，请恢复存储后同步结果。")
      }
      setRecord(pendingSkillDependencyStore.inspect(botId, id, editingEpoch))
    },
    [botId, id, version, editingEpoch, hostId, live]
  )
  useEffect(() => {
    const ticket = ++generation.current
    if (!readable || retired) {
      setBusy(false)
      return
    }
    void refresh(ticket).catch((failure) => {
      if (live(ticket)) setError(failure instanceof Error ? failure.message : "读取依赖检查失败")
    })
  }, [readable, retired, runStatus, hostId, refresh, live])
  useEffect(() => {
    const expiresAt = view?.history.find((item) => item.current)?.report?.expiresAt
    if (!expiresAt) return
    const timer = setTimeout(
      () =>
        setLoadedView((previous) =>
          previous
            ? {
                ...previous,
                value: {
                  ...previous.value,
                  history: previous.value.history.map((item) =>
                    item.current && item.report && item.report.expiresAt <= Date.now()
                      ? { ...item, current: false, reason: "expired" }
                      : item
                  )
                }
              }
            : null
        ),
      Math.max(0, expiresAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [view])
  const act = async () => {
    if (locked.current || retired || !readable || (!supported && !pending?.receipt)) return
    locked.current = true
    setBusy(true)
    setError(null)
    const ticket = ++generation.current
    try {
      let current = pendingSkillDependencyStore.inspect(botId, id, editingEpoch)
      if (current.kind !== "valid" && current.kind !== "empty")
        throw new Error("请先核对本机原检查记录。")
      if (current.kind === "empty") {
        if (!mutationSupport || disabled || !skill.enabled) return
        pendingSkillDependencyStore.remember({
          nonce: crypto.randomUUID(),
          expectedDataEpoch: editingEpoch,
          skill: { botId, id, version }
        })
        current = pendingSkillDependencyStore.inspect(skill.botId, skill.id, editingEpoch)
      }
      if (current.kind !== "valid") throw new Error("检查记录无法读取，本次操作尚未提交。")
      setRecord(current)
      if (!current.input.receipt) {
        if (!supported) throw new Error("当前后台不提供可执行依赖检查，原检查记录已保留。")
        let receipt
        try {
          receipt = botSkillDependencyReceipt.parse(
            await botApi.checkSkillDependencies(current.input.request)
          )
        } catch (failure) {
          if (isDefinitiveSkillDependencyError(failure))
            pendingSkillDependencyStore.complete(current.input)
          throw failure
        }
        // Persist the ACK even if the card closed while its request was in flight.
        pendingSkillDependencyStore.accept(current.input.request, receipt)
      }
      if (live(ticket)) await refresh(ticket)
    } catch (failure) {
      if (live(ticket))
        setError(failure instanceof Error ? failure.message : "检查结果未确认，请核对原请求。")
    } finally {
      locked.current = false
      if (
        alive.current &&
        (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
      ) {
        setBusy(false)
        setRecord(pendingSkillDependencyStore.inspect(skill.botId, skill.id, editingEpoch))
      }
    }
  }
  if (!readable) return null
  const latest = view?.history[0],
    current = view?.history.find((item) => item.current)
  const report = current?.report
  const status = report?.status ?? "unverified"
  const blocked = record.kind !== "valid" && record.kind !== "empty"
  const unfinished =
    latest &&
    ["queued", "running", "waiting_input", "cancelling", "needs_review"].includes(latest.status)
  const Icon = status === "satisfied" ? CheckCircle2 : status === "missing" ? XCircle : CircleHelp
  return (
    <section
      aria-label={`技能依赖 ${skill.name}`}
      className="mt-3 space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <ShieldCheck size={14} />
          运行依赖 · 版本 {skill.version}
        </span>
        <span
          className={`flex items-center gap-1.5 ${status === "missing" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
        >
          <Icon size={13} />
          {stateLabel[status]}
        </span>
      </div>
      {view && (view.declaration.state !== "structured" || !view.declaration.checks.length) && (
        <p className="leading-5 text-muted-foreground">
          此版本没有完整的结构化依赖声明，不能确认运行要求已满足。兼容性说明仍需人工核对。
        </p>
      )}
      {latest && !latest.current && latest.reason && (
        <p className="text-muted-foreground">{reasonLabel[latest.reason]}；原检查记录保留。</p>
      )}
      {report && (
        <p className="text-muted-foreground">
          {report.environment.target.label} ·{" "}
          {new Date(report.checkedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
          })}{" "}
          检查；环境或许可变化后需重查。
        </p>
      )}
      {!!view?.declaration.checks.length && (
        <details className="leading-5">
          <summary className="cursor-pointer text-muted-foreground">
            {view.declaration.checks.length} 项声明
          </summary>
          <ul className="mt-2 space-y-1">
            {view.declaration.checks.map((entry) => {
              const checked = report?.checks.find((item) => item.id === entry.id)
              return (
                <li key={entry.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">{checkLabel(entry)}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {checked ? reasonLabel[checked.reason] : "未核验"}
                    {checked?.observedVersion ? ` · ${checked.observedVersion}` : ""}
                  </span>
                </li>
              )
            })}
          </ul>
        </details>
      )}
      {blocked && (
        <BotPendingSaveRecovery
          record={record}
          dataEpoch={editingEpoch}
          operationLabel="依赖检查"
          discard={(raw) =>
            pendingSkillDependencyStore.discard(skill.botId, skill.id, editingEpoch, raw)
          }
          onRepaired={() => {
            setRecord(pendingSkillDependencyStore.inspect(skill.botId, skill.id, editingEpoch))
            setError(null)
          }}
        />
      )}
      {retired && (
        <p role="alert" className="text-muted-foreground">
          数据已恢复，请重新打开技能面板核对原记录。
        </p>
      )}
      {pending && (
        <p className="text-muted-foreground">
          {pending.receipt
            ? "后台已收到检查，同步时只读取原任务。"
            : "提交结果待确认，重试将核对原请求。"}
          使用版本 {pending.request.skill.version}。
        </p>
      )}
      {unfinished && (
        <p role="status" className="text-muted-foreground">
          {latest.status === "needs_review"
            ? "检查需要人工核对，详情在 Bot 对话中。"
            : "检查任务已提交，进展与审批显示在 Bot 对话中。"}
        </p>
      )}
      {!supported && (
        <p role="status" className="text-muted-foreground">
          当前后台不提供可执行依赖检查；原声明、检查记录和已确认结果仍可查看。
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={
            busy ||
            retired ||
            blocked ||
            (!supported && !pending?.receipt) ||
            (!pending && (disabled || !mutationSupport || !skill.enabled || !!unfinished))
          }
          onClick={() => void act()}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {pending?.receipt ? "同步检查结果" : pending ? "核对原检查" : "检查依赖"}
        </Button>
        <span className="text-muted-foreground">不会安装依赖或执行技能</span>
      </div>
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
