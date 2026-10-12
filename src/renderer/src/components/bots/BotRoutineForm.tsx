import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BOT_EVENT_STATE_CAPABILITY } from "../../../../shared/bot-event-state"
import { botApi } from "@/lib/bot-api"
import { useLayoutEffect, useId, useRef, useState } from "react"
import { CalendarClock, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  routineScheduleDraft,
  saveRoutineSchedule,
  type RoutineScheduleDraft
} from "@/lib/bot-routine-draft"
import type { BotRoutine, BotSkill, BotSkillSummary } from "../../../../shared/bot-types"
import type { BotSkillReference } from "../../../../shared/bot-skill-references"
import type { BotSaveRoutineInput } from "../../../../shared/bot-routines"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgePendingRoutine,
  isDefinitiveRoutineSaveError,
  inspectPendingRoutine,
  discardPendingRoutine,
  rememberPendingRoutine
} from "@/lib/bot-routine-pending"

const fieldClass =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
const schedules = [
  ["daily", "每天"],
  ["weekdays", "工作日（周一至周五）"],
  ["weekly", "每周"],
  ["monthly", "每月"],
  ["hourly", "每小时"],
  ["interval", "固定间隔"],
  ["once", "仅一次"],
  ["cron", "自定义日历计划"],
  ["event", "事件触发"]
] as const

/** A polling update never replaces a draft. Saves use the version the user actually reviewed. */
export function BotRoutineForm({
  botId,
  routine,
  latest,
  skills = [],
  initialSkill,
  full = false,
  dialog = false,
  idempotent,
  recoveryId,
  onPendingCleared,
  onSaved,
  onBusyChange,
  onCancel
}: {
  botId: string
  routine?: BotRoutine
  latest?: BotRoutine
  skills?: BotSkillSummary[]
  initialSkill?: BotSkill
  full?: boolean
  dialog?: boolean
  idempotent: boolean
  recoveryId?: string
  onPendingCleared?(): void
  onSaved(): void
  onBusyChange?(busy: boolean): void
  onCancel?(): void
}) {
  const id = useId()
  const eventStateSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_EVENT_STATE_CAPABILITY) ?? false
  )
  const targetId = routine?.id ?? recoveryId
  const skillSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-skills") ?? false
  )
  const readinessSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-readiness-state") ?? false
  )
  const mutationSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(dataEpoch)
  const restored = authorityRetired || dataEpoch !== editingEpoch
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
  const live = () => mounted.current && currentEpoch()
  const [record, setRecord] = useState(() =>
    idempotent ? inspectPendingRoutine(botId, targetId, editingEpoch) : { kind: "empty" as const }
  )
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const pendingSave = record.kind === "valid" ? record.input : null
  const acknowledged = useRef<{ input: BotSaveRoutineInput; rejected?: string } | null>(null)
  const refreshRecord = () => setRecord(inspectPendingRoutine(botId, targetId, editingEpoch))
  const initial = pendingSave ?? routine
  const [base, setBase] = useState(routine)
  const [name, setName] = useState(
    initial?.name ?? (initialSkill ? `${initialSkill.name}例程`.slice(0, 100) : "")
  )
  const [prompt, setPrompt] = useState(
    initial?.prompt ??
      (initialSkill ? `按技能「${initialSkill.name}」执行任务，核对并交付结果。` : "")
  )
  const [selectedSkills, setSelectedSkills] = useState<BotSkillReference[]>(
    () =>
      pendingSave?.skills?.map((selection) => ({
        ...selection,
        name:
          skills.find((item) => item.id === selection.id)?.name ??
          routine?.skillReferences?.find((item) => item.id === selection.id)?.name ??
          selection.id
      })) ??
      routine?.skillReferences ??
      (!pendingSave && initialSkill
        ? [{ botId, id: initialSkill.id, version: initialSkill.version, name: initialSkill.name }]
        : [])
  )
  const unavailableSkills = selectedSkills.filter(
    (reference) =>
      !skills.some(
        (skill) =>
          skill.id === reference.id &&
          skill.version === reference.version &&
          skill.enabled &&
          skill.verified
      )
  )
  const [enabled, setEnabled] = useState(
    pendingSave
      ? pendingSave.enabled
      : readinessSupport && routine?.effectiveState === "needs_setup"
        ? false
        : (initial?.enabled ?? true)
  )
  const [desiredEnabled, setDesiredEnabled] = useState(
    initial?.desiredEnabled ?? initial?.enabled ?? true
  )
  const [timezone, setTimezone] = useState(
    initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  )
  const [schedule, setSchedule] = useState(() => routineScheduleDraft(initial?.schedule))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<BotSaveRoutineInput | null>(pendingSave)
  const inFlight = useRef(false)
  const fieldsDisabled = busy || restored || blocked || Boolean(recoveryId) || Boolean(uncertain)
  const selectableSkills = skills.filter(
    (skill) =>
      skill.enabled && skill.verified && !selectedSkills.some((item) => item.id === skill.id)
  )
  const stale = Boolean(base && latest?.revision !== base.revision)
  const change = <K extends keyof RoutineScheduleDraft>(key: K, value: RoutineScheduleDraft[K]) =>
    setSchedule((draft) => ({ ...draft, [key]: value }))
  const reload = () => {
    if (!latest) return
    setBase(latest)
    setName(latest.name)
    setPrompt(latest.prompt)
    setEnabled(readinessSupport && latest.effectiveState === "needs_setup" ? false : latest.enabled)
    setDesiredEnabled(latest.desiredEnabled ?? latest.enabled)
    setTimezone(latest.timezone)
    setSchedule(routineScheduleDraft(latest.schedule))
    setSelectedSkills(latest.skillReferences ?? [])
    setFailure(null)
  }
  const submit = async () => {
    if (
      !live() ||
      (!mutationSupport && !acknowledged.current) ||
      inFlight.current ||
      restored ||
      blocked ||
      (Boolean(recoveryId) && !uncertain && !acknowledged.current) ||
      (!uncertain && (stale || (!base && full)))
    )
      return
    let input: BotSaveRoutineInput
    try {
      input = acknowledged.current?.input ??
        uncertain ?? {
          ...(idempotent ? { nonce: crypto.randomUUID() } : {}),
          expectedDataEpoch: editingEpoch,
          botId,
          ...(base ? { id: base.id, revision: base.revision } : {}),
          name: name.trim(),
          prompt,
          enabled,
          ...(readinessSupport ? { desiredEnabled } : {}),
          timezone: timezone.trim(),
          schedule: saveRoutineSchedule(schedule, base?.schedule),
          ...(skillSupport
            ? { skills: selectedSkills.map(({ botId, id, version }) => ({ botId, id, version })) }
            : {})
        }
      if (!live()) return
      if (input.nonce && !acknowledged.current) rememberPendingRoutine(input, editingEpoch)
      if (input.nonce) refreshRecord()
    } catch (error) {
      if (idempotent) refreshRecord()
      setFailure(error instanceof Error ? error.message : "请检查例程设置")
      return
    }
    if (!live()) return
    inFlight.current = true
    setBusy(true)
    onBusyChange?.(true)
    setFailure(null)
    let saved = false
    try {
      let receipt = acknowledged.current
      if (!receipt) {
        try {
          await botApi.saveRoutine(input)
          receipt = { input }
        } catch (error) {
          if (!currentEpoch()) return
          if ((error as { code?: string })?.code === "data_epoch") {
            if (live()) {
              setAuthorityRetired(true)
              setUncertain(input)
              setFailure("工作区数据已恢复，请重新打开例程。原保存记录仍保留，需核对原结果。")
            }
            return
          }
          if (!input.nonce || isDefinitiveRoutineSaveError(error)) {
            receipt = { input, rejected: error instanceof Error ? error.message : "例程保存失败" }
          } else {
            if (live()) {
              setUncertain(input)
              setFailure("尚未收到保存结果。重试会核对同一次保存，不会重复创建。")
            }
            return
          }
        }
      }
      if (!currentEpoch()) return
      acknowledged.current = receipt
      if (input.nonce && !acknowledgePendingRoutine(input, editingEpoch)) {
        if (live()) {
          setUncertain(input)
          refreshRecord()
          setFailure("保存结果已确认，本机记录尚未清除。重试只核对此条记录。")
        }
        return
      }
      acknowledged.current = null
      if (!live()) return
      if (input.nonce) refreshRecord()
      onPendingCleared?.()
      setUncertain(null)
      if (receipt.rejected) {
        setFailure(receipt.rejected)
        return
      }
      saved = true
      if (!base) {
        setName("")
        setPrompt("")
        setSelectedSkills([])
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setBusy(false)
        onBusyChange?.(false)
      }
    }
    if (saved && live()) onSaved()
  }
  if (recoveryId && record.kind === "empty" && !acknowledged.current) return null
  return (
    <form
      aria-label={recoveryId ? "核对原例程保存" : base ? "编辑例程" : "添加例程"}
      className="bot-routine-form space-y-4"
      data-dialog={dialog || undefined}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="bot-routine-form-body space-y-4">
        {blocked && (
          <BotPendingSaveRecovery
            record={record}
            dataEpoch={editingEpoch}
            operationLabel="例程保存"
            discard={(raw) => discardPendingRoutine(botId, targetId, editingEpoch, raw)}
            onRepaired={() => {
              acknowledged.current = null
              refreshRecord()
              setUncertain(null)
              setFailure(null)
              onPendingCleared?.()
            }}
          />
        )}
        {!base && !dialog && (
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <CalendarClock size={16} className="text-muted-foreground" />
            {recoveryId ? "核对原例程保存" : "添加例程"}
          </h3>
        )}
        {!mutationSupport && (
          <p role="status" className="text-sm text-muted-foreground">
            请更新 Bot 后台后保存例程；本机草稿和原记录保持不变。
          </p>
        )}
        {restored && (
          <p role="alert" className="text-sm text-destructive">
            工作区数据已恢复，请关闭后重新打开例程。
          </p>
        )}
        {stale && !uncertain && (
          <div role="status" className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <p>
              {latest
                ? "例程已更新，当前草稿已保留。载入最新版本后再修改。"
                : "此例程已被删除，无法保存当前修改。"}
            </p>
            {latest && (
              <Button type="button" size="sm" variant="outline" onClick={reload} disabled={busy}>
                载入最新版本，替换草稿
              </Button>
            )}
          </div>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        {uncertain && !failure && (
          <p role="status" className="text-sm text-muted-foreground">
            有一次保存尚未确认。请重试核对；已发送的请求不会因关闭窗口而撤销。
          </p>
        )}
        <fieldset disabled={fieldsDisabled} className="space-y-4 disabled:opacity-70">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              名称
            </label>
            <Input
              id={`${id}-name`}
              maxLength={100}
              required
              value={name}
              placeholder="例如：工作日项目巡检"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-prompt`} className="text-sm font-medium">
              内容
            </label>
            <textarea
              id={`${id}-prompt`}
              className={`${fieldClass} min-h-28 resize-y`}
              rows={4}
              maxLength={64_000}
              required
              value={prompt}
              placeholder="说明每次执行的工作、要求和验收方式"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          {skillSupport && (
            <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
              <div className="text-sm font-medium">执行技能</div>
              {selectedSkills.map((reference) => (
                <div
                  key={reference.id}
                  className="flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
                >
                  <span className="min-w-0 break-words">
                    {reference.name}{" "}
                    <span className="text-xs text-muted-foreground">
                      · 版本 {reference.version}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    aria-label={`移除技能 ${reference.name}`}
                    onClick={() =>
                      setSelectedSkills((items) => items.filter((item) => item.id !== reference.id))
                    }
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
              {selectedSkills.length < 6 && (
                <Select
                  disabled={fieldsDisabled || selectableSkills.length === 0}
                  value=""
                  onValueChange={(value) => {
                    const skill = selectableSkills.find((item) => item.id === value)
                    if (skill?.enabled && skill.verified)
                      setSelectedSkills((items) => [
                        ...items,
                        { botId, id: skill.id, version: skill.version, name: skill.name }
                      ])
                  }}
                >
                  <SelectTrigger aria-label="选择已验收技能" className="rounded-lg bg-background">
                    <SelectValue
                      placeholder={
                        selectableSkills.length ? "选择已验收技能（可选）" : "暂无可选的已验收技能"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="bot-routine-select">
                    {selectableSkills.map((skill) => (
                      <SelectItem key={skill.id} value={skill.id}>
                        {skill.name} · 版本 {skill.version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                绑定已通过试跑验收的版本。技能更新或停用后例程暂停，需重新选择并确认；运行时仍按原有规则审批。
              </p>
              {unavailableSkills.length > 0 && (
                <p role="status" className="text-xs text-destructive">
                  所选技能版本已变化、停用或未经验收。请移除后选择已验收版本，或保持例程暂停。
                </p>
              )}
            </div>
          )}
          <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
            <div className="space-y-1.5 text-sm">
              <label htmlFor={`${id}-frequency`} className="font-medium">
                执行频率
              </label>
              <Select
                disabled={fieldsDisabled}
                value={schedule.kind}
                onValueChange={(value) => change("kind", value as RoutineScheduleDraft["kind"])}
              >
                <SelectTrigger id={`${id}-frequency`} className="rounded-lg bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bot-routine-select">
                  {schedules.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {schedule.kind === "interval" ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm">每</span>
                  <Input
                    aria-label="执行间隔"
                    className="w-28"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={schedule.amount}
                    onChange={(event) => change("amount", event.target.value)}
                  />
                  <Select
                    disabled={fieldsDisabled}
                    value={schedule.unit}
                    onValueChange={(value) => change("unit", value as RoutineScheduleDraft["unit"])}
                  >
                    <SelectTrigger aria-label="间隔单位" className="rounded-lg bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bot-routine-select">
                      <SelectItem value="minutes">分钟</SelectItem>
                      <SelectItem value="hours">小时</SelectItem>
                      <SelectItem value="days">天</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  修改间隔后重新计时；仅修改内容会保留原运行时间。
                </p>
              </>
            ) : schedule.kind === "once" ? (
              <label className="block space-y-1.5 text-sm">
                <span>
                  运行时间（当前电脑时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}）
                </span>
                <Input
                  aria-label="运行时间"
                  type="datetime-local"
                  step="1"
                  required
                  value={schedule.at}
                  onChange={(event) => change("at", event.target.value)}
                />
              </label>
            ) : schedule.kind === "event" ? (
              <>
                <Input
                  aria-label="事件主题"
                  required
                  maxLength={160}
                  placeholder="例如：build.failed"
                  value={schedule.topic}
                  onChange={(event) => change("topic", event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  接入的系统发送该主题时触发；保存例程不会自动接入外部系统。
                </p>
                {(eventStateSupport || schedule.eventMode === "latest-state") && (
                  <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
                    <label className="block space-y-1.5 text-sm">
                      <span>事件处理方式</span>
                      <Select
                        disabled={fieldsDisabled || !eventStateSupport}
                        value={schedule.eventMode}
                        onValueChange={(value) =>
                          change("eventMode", value as RoutineScheduleDraft["eventMode"])
                        }
                      >
                        <SelectTrigger aria-label="事件处理方式">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bot-routine-select">
                          <SelectItem value="every-event">每次事件都执行</SelectItem>
                          <SelectItem value="latest-state">只处理对象的最新状态</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    {schedule.eventMode === "latest-state" && (
                      <>
                        <label className="block space-y-1.5 text-sm">
                          <span>来源批次</span>
                          <Input
                            aria-label="事件来源批次"
                            value={schedule.sourceEpoch}
                            required
                            maxLength={160}
                            disabled={!eventStateSupport}
                            placeholder="例如：orders-v1"
                            onChange={(event) => change("sourceEpoch", event.target.value)}
                          />
                        </label>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          调用方须提供对象标识和递增序号。新状态会停止旧状态的新操作；已发出的操作先核对结果，再执行新状态。外部系统的原子更新还需版本条件写入。
                        </p>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : schedule.kind === "cron" ? (
              <>
                <Input
                  aria-label="Cron 表达式"
                  required
                  maxLength={200}
                  className="font-mono"
                  value={schedule.expression}
                  onChange={(event) => change("expression", event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  五段依次为：分钟、小时、日期、月份、星期。例如 0 9 * * 1-5。
                </p>
              </>
            ) : schedule.kind === "hourly" ? (
              <label className="flex items-center gap-2 text-sm">
                每小时第
                <Input
                  aria-label="每小时分钟"
                  className="w-24"
                  type="number"
                  min="0"
                  max="59"
                  required
                  value={schedule.minute}
                  onChange={(event) => change("minute", event.target.value)}
                />
                分钟
              </label>
            ) : (
              <div className="flex gap-2">
                <Input
                  aria-label="执行时间"
                  type="time"
                  required
                  value={schedule.time}
                  onChange={(event) => change("time", event.target.value)}
                />
                {schedule.kind === "weekly" && (
                  <Select
                    disabled={fieldsDisabled}
                    value={schedule.day}
                    onValueChange={(value) => change("day", value)}
                  >
                    <SelectTrigger aria-label="星期" className="rounded-lg bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bot-routine-select">
                      {["日", "一", "二", "三", "四", "五", "六"].map((label, index) => (
                        <SelectItem key={index} value={String(index)}>
                          周{label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {schedule.kind === "monthly" && (
                  <label className="flex shrink-0 items-center gap-2 text-sm">
                    每月
                    <Input
                      aria-label="每月日期"
                      className="w-20"
                      type="number"
                      min="1"
                      max="31"
                      required
                      value={schedule.monthDay}
                      onChange={(event) => change("monthDay", event.target.value)}
                    />
                    日
                  </label>
                )}
              </div>
            )}
            {schedule.kind === "monthly" && (
              <p className="text-xs text-muted-foreground">没有所选日期的月份将跳过。</p>
            )}
            {!["once", "interval", "event"].includes(schedule.kind) && (
              <label className="block space-y-1.5 text-sm">
                <span>时区</span>
                <Input
                  required
                  maxLength={100}
                  value={timezone}
                  placeholder="Asia/Shanghai"
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </label>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border px-3 py-3">
            <div className="space-y-1">
              <label htmlFor={`${id}-enabled`} className="text-sm font-medium">
                启用自动运行
              </label>
              <p className="text-xs text-muted-foreground">
                {readinessSupport &&
                desiredEnabled &&
                !enabled &&
                (base?.activationRequired || !base)
                  ? unavailableSkills.length
                    ? "已保留启用意愿。请先验收所选技能，再明确启用。"
                    : "已保留启用意愿，需由你确认后启用。"
                  : "关闭后保留例程，暂停自动触发。"}
              </p>
              {readinessSupport &&
                desiredEnabled &&
                !enabled &&
                (base?.activationRequired || !base) && (
                  <button
                    type="button"
                    disabled={fieldsDisabled}
                    className="text-xs underline underline-offset-4 disabled:opacity-60"
                    onClick={() => setDesiredEnabled(false)}
                  >
                    设为暂停
                  </button>
                )}
            </div>
            <Switch
              id={`${id}-enabled`}
              disabled={fieldsDisabled}
              checked={enabled}
              onCheckedChange={(value) => {
                setEnabled(value)
                setDesiredEnabled(value)
              }}
            />
          </div>
        </fieldset>
      </div>
      <div className="bot-routine-form-footer flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button
          disabled={
            busy ||
            (!mutationSupport && !acknowledged.current) ||
            restored ||
            blocked ||
            (Boolean(recoveryId) && !uncertain) ||
            (!uncertain &&
              (stale ||
                (!base && full) ||
                !name.trim() ||
                !prompt.trim() ||
                (skillSupport && enabled && unavailableSkills.length > 0)))
          }
        >
          {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
          {busy ? "保存中…" : uncertain ? "重试核对保存" : base ? "保存修改" : "保存"}
        </Button>
      </div>
    </form>
  )
}
