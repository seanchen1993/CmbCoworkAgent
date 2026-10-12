import { useBotSkillSave } from "@/lib/use-bot-skill-save"
import { BotSkillSaveStatus } from "./BotSkillSaveStatus"
import { BotSkillDependencyCheck } from "./BotSkillDependencyCheck"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { botApi } from "@/lib/bot-api"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { CalendarClock, Check, ChevronDown, FileText, Loader2, Pencil, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { BotSkill } from "../../../../shared/bot-types"
import type { BotSkillTrial } from "../../../../shared/bot-teach"
import type { BotLibrarySkill } from "../../../../shared/bot-skill-library"
import { BotPublishSkillButton } from "./BotPublishSkillButton"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotRoutineForm } from "./BotRoutineForm"
import {
  acknowledgePendingTrial,
  inspectPendingTrial,
  discardPendingTrial,
  rememberPendingTrial
} from "@/lib/bot-skill-trial-pending"
import type { BotSkillTrialInput } from "../../../../shared/bot-skill-trial"
import { BotSkillDeleteButton } from "./BotSkillDeletion"

export function BotSkillCard({
  skill,
  trials,
  sharing,
  revealSteps = false,
  footer,
  reload
}: {
  skill: BotSkill
  trials: BotSkillTrial[]
  sharing?: { published?: BotLibrarySkill }
  revealSteps?: boolean
  footer?: ReactNode
  reload(): Promise<void>
}) {
  const privateSkill = !skill.scope || skill.scope === "bot"
  const editable = privateSkill || skill.userEditable === true
  const skillSave = useBotSkillSave(skill.botId, skill.id, reload)
  const deletionSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("private-skill-deletion") ?? false
  )
  const trialSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-trials") ?? false
  )
  const reviewSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-trial-review-epoch") ?? false
  )
  const mutationSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(dataEpoch)
  const restored = authorityRetired || dataEpoch !== editingEpoch
  const [trialRecord, setTrialRecord] = useState(() =>
    inspectPendingTrial(skill.botId, skill.id, editingEpoch)
  )
  const pending = trialRecord.kind === "valid" ? trialRecord.input : null
  const trialBlocked = trialRecord.kind !== "empty" && trialRecord.kind !== "valid"
  const acknowledgedTrial = useRef<{
    input: BotSkillTrialInput
    rejected?: unknown
  } | null>(null)
  const refreshTrialRecord = () =>
    setTrialRecord(inspectPendingTrial(skill.botId, skill.id, editingEpoch))
  const [mode, setMode] = useState<"view" | "edit" | "trial">(
    skillSave.pending ? "edit" : pending ? "trial" : "view"
  )
  const [editVersion, setEditVersion] = useState(skillSave.pending?.version ?? skill.version)
  const staleEdit = !skillSave.pending && !skillSave.acknowledged && editVersion !== skill.version
  const [stepsOpen, setStepsOpen] = useState(revealSteps)
  useEffect(() => {
    if (revealSteps) setStepsOpen(true)
  }, [revealSteps])
  const routineSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-skills") ?? false
  )
  const [trialVersion, setTrialVersion] = useState(pending?.version ?? skill.version)
  const staleTrial = !pending && trialVersion !== skill.version
  const [routineSkill, setRoutineSkill] = useState<BotSkill | null>(null)
  const [savingRoutine, setSavingRoutine] = useState(false)
  const [name, setName] = useState(skillSave.pending?.name ?? skill.name),
    [instructions, setInstructions] = useState(
      skillSave.pending?.instructions ?? skill.instructions
    )
  const [inputs, setInputs] = useState(pending?.inputs ?? ""),
    [criteria, setCriteria] = useState(pending?.criteria ?? "")
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const alive = useRef(true),
    locked = useRef(false)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
  const live = () => alive.current && currentEpoch()
  const act = async (operation: () => Promise<unknown>) => {
    if (!live() || locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      if (!live()) return
      setMode("view")
      await reload()
    } catch (failure) {
      if (live()) setError(failure instanceof Error ? failure.message : "操作失败")
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const reviewTrial = async (id: string, verdict: "passed" | "failed") => {
    if (!reviewSupport) throw new Error("请更新 Bot 后台后验收技能试跑。原试跑结果保持不变。")
    if (restored || !currentEpoch())
      throw new Error("工作区数据已恢复，请重新打开技能面板并核对当前试跑结果。")
    try {
      await botApi.reviewSkillTrial({
        expectedDataEpoch: editingEpoch,
        id,
        verdict,
        note: notes[id]
      })
    } catch (failure) {
      if ((failure as { code?: string } | null)?.code === "data_epoch" && live())
        setAuthorityRetired(true)
      throw failure
    }
  }
  const startTrial = async () => {
    if (!mutationSupport && !acknowledgedTrial.current)
      throw new Error("请更新 Bot 后台后试跑技能。原记录保持不变。")
    if (editable && skillSave.blocksOtherActions) throw new Error("请先核对尚未确认的技能保存")
    if (!currentEpoch() || restored) throw new Error("数据已恢复，请关闭后重新打开技能面板")
    const record = inspectPendingTrial(skill.botId, skill.id, editingEpoch)
    if (record.kind !== "empty" && record.kind !== "valid") {
      setTrialRecord(record)
      throw new Error("请先核对并归档本机试跑记录。")
    }
    if (staleTrial && record.kind !== "valid" && !acknowledgedTrial.current)
      throw new Error("技能已更新，请确认当前版本后试跑")
    const input =
      acknowledgedTrial.current?.input ??
      (record.kind === "valid"
        ? record.input
        : {
            nonce: crypto.randomUUID(),
            expectedDataEpoch: editingEpoch,
            botId: skill.botId,
            skillId: skill.id,
            version: trialVersion,
            inputs,
            criteria
          })
    try {
      if (!acknowledgedTrial.current) rememberPendingTrial(input, editingEpoch)
      if (!live()) return
      refreshTrialRecord()
    } catch (failure) {
      refreshTrialRecord()
      throw failure
    }
    let receipt = acknowledgedTrial.current
    if (!receipt) {
      try {
        await botApi.trialSkill(input)
        receipt = { input }
      } catch (failure) {
        const code = (failure as { code?: string } | null)?.code
        if (code === "data_epoch") {
          if (live()) setAuthorityRetired(true)
          throw new Error("工作区数据已恢复，请重新打开技能面板。原试跑记录仍保留，需核对原结果。")
        }
        if (
          !code ||
          ![
            "invalid_input",
            "revision_conflict",
            "not_found",
            "skill_changed",
            "skill_unavailable",
            "skill_catalog_unavailable",
            "nonce_conflict"
          ].includes(code)
        )
          throw failure
        receipt = { input, rejected: failure }
      }
    }
    if (!currentEpoch()) return
    acknowledgedTrial.current = receipt
    if (!acknowledgePendingTrial(input, editingEpoch))
      throw new Error("试跑结果已确认，本机记录尚未清除。重试只核对此条记录。")
    acknowledgedTrial.current = null
    if (live()) refreshTrialRecord()
    if (receipt.rejected) throw receipt.rejected
  }
  return (
    <article
      id={`bot-skill-${skill.id}`}
      tabIndex={-1}
      className="rounded-2xl border border-border/60 bg-muted/15 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
          <FileText size={19} strokeWidth={1.6} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{skill.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            版本 {skill.version} · {skill.verified ? "有通过的试跑记录" : "尚未通过试跑"}
            {!skill.enabled && " · 此 Bot 已停用"}
          </p>
        </div>
        {(editable || trialSupport) && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy ||
              trialBlocked ||
              (editable && skillSave.blocksOtherActions) ||
              (!skill.enabled && !pending)
            }
            onClick={() => {
              if (!pending) setTrialVersion(skill.version)
              setMode(mode === "trial" ? "view" : "trial")
            }}
          >
            <Play size={13} /> {pending ? "核对试跑" : "试跑"}
          </Button>
        )}
      </div>
      {editable && (
        <details className="mt-3 rounded-xl bg-muted/20 px-3 py-2">
          <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            管理技能
            <ChevronDown size={13} aria-hidden="true" />
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size={privateSkill ? "icon" : "sm"}
              variant="ghost"
              className={privateSkill ? "size-8" : undefined}
              aria-label={`修订技能 ${skill.name}`}
              disabled={
                busy ||
                skillSave.busy ||
                skillSave.restored ||
                !skillSave.supported ||
                skillSave.blocked
              }
              onClick={() => {
                if (skillSave.pending || skillSave.acknowledged) {
                  setMode("edit")
                  return
                }
                setEditVersion(skill.version)
                setName(skill.name)
                setInstructions(skill.instructions)
                setMode("edit")
              }}
            >
              <Pencil size={14} /> {!privateSkill && "修订技能"}
            </Button>
            {privateSkill && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || skillSave.actionsDisabled}
                onClick={() =>
                  void skillSave.save({
                    id: skill.id,
                    version: skill.version,
                    name: skill.name,
                    instructions: skill.instructions,
                    enabled: !skill.enabled
                  })
                }
              >
                {skill.enabled ? "停用" : "启用"}
              </Button>
            )}
            {deletionSupport && privateSkill && (
              <BotSkillDeleteButton
                skill={skill}
                disabled={busy || restored || skillSave.blocksOtherActions}
                onBusyChange={(next) => {
                  locked.current = next
                  setBusy(next)
                }}
                reload={reload}
              />
            )}
            {mode === "view" &&
              !skillSave.blocksOtherActions &&
              routineSupport &&
              skill.enabled &&
              skill.verified && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRoutineSkill(skill)}
                >
                  <CalendarClock size={14} /> 设为例程
                </Button>
              )}
          </div>
          {mode === "view" && !skillSave.blocksOtherActions && sharing && (
            <BotPublishSkillButton skill={skill} published={sharing.published} reload={reload} />
          )}
        </details>
      )}
      {editable && <BotSkillSaveStatus session={skillSave} retry={mode !== "edit"} />}
      {trialBlocked && (
        <BotPendingSaveRecovery
          record={trialRecord}
          dataEpoch={editingEpoch}
          operationLabel="试跑"
          discard={(raw) => discardPendingTrial(skill.botId, skill.id, editingEpoch, raw)}
          onRepaired={() => {
            acknowledgedTrial.current = null
            refreshTrialRecord()
            setError(null)
          }}
        />
      )}

      {!editable && mode === "view" && routineSupport && skill.enabled && skill.verified && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() => setRoutineSkill(skill)}
        >
          <CalendarClock size={14} /> 设为例程
        </Button>
      )}
      <Dialog
        open={routineSkill !== null}
        onOpenChange={(open) => {
          if (!open && !savingRoutine) setRoutineSkill(null)
        }}
      >
        <DialogContent className="bot-editor-dialog bot-routine-dialog w-[calc(100%-2rem)] max-w-xl gap-0 p-0">
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-12 text-left">
            <DialogTitle>将技能设为例程</DialogTitle>
            <DialogDescription>
              设置每次任务的输入要求和运行计划，后续使用已确认的技能版本。
            </DialogDescription>
          </DialogHeader>
          {routineSkill && (
            <BotRoutineForm
              dialog
              botId={skill.botId}
              initialSkill={routineSkill}
              skills={[skill]}
              idempotent
              onBusyChange={setSavingRoutine}
              onCancel={() => setRoutineSkill(null)}
              onSaved={() => {
                setRoutineSkill(null)
                void reload().catch((failure) =>
                  setError(failure instanceof Error ? failure.message : "读取技能失败")
                )
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {!!skill.resourceCount && (
        <p className="mt-2 text-xs text-muted-foreground">
          包含 {skill.resourceCount} 个附属文件，Bot 可按需阅读资料和使用脚本。
        </p>
      )}
      {skill.compatibility && (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          运行要求：{skill.compatibility}
        </p>
      )}
      {mode === "trial" && (
        <BotSkillDependencyCheck
          skill={skill}
          disabled={busy || skillSave.blocksOtherActions || restored}
        />
      )}
      {mode === "view" && (
        <details
          className="mt-3 text-sm"
          open={stepsOpen}
          onToggle={(event) => setStepsOpen(event.currentTarget.open)}
        >
          <summary className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
            <ChevronDown size={13} />
            <span>查看技能步骤</span>
            <span>与运行依赖</span>
          </summary>
          {stepsOpen && (
            <BotSkillDependencyCheck
              skill={skill}
              disabled={busy || skillSave.blocksOtherActions || restored}
            />
          )}
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
            {skill.instructions}
          </pre>
        </details>
      )}
      {mode === "edit" && editable && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void skillSave
              .save({
                id: skill.id,
                version: editVersion,
                name,
                instructions,
                enabled: skill.enabled,
                ...(skill.scope === "user" ? { scope: "user" as const } : {})
              })
              .then((saved) => {
                if (saved) setMode("view")
              })
          }}
        >
          <Input
            aria-label="技能名称"
            disabled={skillSave.fieldsDisabled}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
          <textarea
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="技能步骤"
            disabled={skillSave.fieldsDisabled}
            value={instructions}
            rows={10}
            maxLength={64000}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {skill.scope === "user"
              ? "修改会同步到所有 Bot；已有任务和例程需确认新版本，试跑记录保留。"
              : "保存为新版本，已有试跑和验收记录继续保留。"}
          </p>
          {staleEdit && (
            <p role="alert" className="text-xs text-destructive">
              技能已更新，请取消后重新编辑当前版本。
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                busy ||
                skillSave.busy ||
                skillSave.restored ||
                !skillSave.supported ||
                skillSave.blocked ||
                (!skillSave.pending &&
                  !skillSave.acknowledged &&
                  (staleEdit || !name.trim() || !instructions.trim()))
              }
            >
              {skillSave.busy
                ? "保存中…"
                : skillSave.acknowledged
                  ? "同步保存结果"
                  : skillSave.pending
                    ? "重试核对保存"
                    : "保存新版本"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>
              取消
            </Button>
          </div>
        </form>
      )}
      {mode === "trial" && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(startTrial)
          }}
        >
          <label className="block space-y-1.5 text-xs">
            <span>本次输入</span>
            <textarea
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              aria-label="本次输入"
              value={inputs}
              disabled={busy || trialBlocked || !!pending || restored}
              rows={3}
              maxLength={8000}
              placeholder="换一组真实输入，检查步骤能否复用"
              onChange={(event) => setInputs(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-xs">
            <span>验收条件</span>
            <textarea
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              aria-label="验收条件"
              value={criteria}
              disabled={busy || trialBlocked || !!pending || restored}
              rows={2}
              maxLength={8000}
              placeholder="写明应得到什么结果、如何核对"
              onChange={(event) => setCriteria(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            试跑使用版本 {pending?.version ?? trialVersion}
            ，进展和操作审批显示在 Bot 对话中。
          </p>
          {!mutationSupport && (
            <p role="status" className="text-xs text-muted-foreground">
              请更新 Bot 后台后试跑技能。原记录保持不变。
            </p>
          )}
          {pending && (
            <p role="status" className="text-xs text-muted-foreground">
              正在核对已提交的试跑。重试使用原输入和版本，不会新建第二次任务。
            </p>
          )}
          {staleTrial && (
            <p role="alert" className="text-xs text-destructive">
              技能已更新，请取消后重新打开试跑，确认当前步骤。
            </p>
          )}
          {restored && (
            <p role="alert" className="text-xs text-destructive">
              数据已恢复，请关闭后重新打开技能面板。
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                busy ||
                (!mutationSupport && !acknowledgedTrial.current) ||
                trialBlocked ||
                (editable && skillSave.blocksOtherActions) ||
                restored ||
                staleTrial ||
                !inputs.trim() ||
                !criteria.trim()
              }
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {pending ? "重试核对试跑" : "开始试跑"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>
              取消
            </Button>
          </div>
        </form>
      )}
      {trials.length > 0 && (
        <details className="mt-3 border-t border-border/60 pt-3">
          <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            试跑记录 · {trials.length}
            <ChevronDown size={13} aria-hidden="true" />
          </summary>
          <div className="mt-3 space-y-2">
            {trials.slice(0, 5).map((trial) => (
              <details key={trial.id} className="rounded-lg border border-border/60 p-2.5 text-xs">
                <summary className="cursor-pointer">
                  版本 {trial.version} ·{" "}
                  {trial.verdict === "passed"
                    ? "试跑通过"
                    : trial.verdict === "failed"
                      ? "试跑未通过"
                      : trial.runStatus === "succeeded"
                        ? "等待验收"
                        : ["failed", "cancelled"].includes(trial.runStatus)
                          ? "执行未完成"
                          : "正在试跑"}
                </summary>
                <dl className="mt-3 space-y-2 whitespace-pre-wrap break-words">
                  <dt className="text-muted-foreground">输入</dt>
                  <dd>{trial.inputs}</dd>
                  <dt className="text-muted-foreground">验收条件</dt>
                  <dd>{trial.criteria}</dd>
                  <dt className="text-muted-foreground">结果</dt>
                  <dd>{trial.error || trial.result || "可在对话中查看进展"}</dd>
                  {trial.note && (
                    <>
                      <dt className="text-muted-foreground">验收记录</dt>
                      <dd>{trial.note}</dd>
                    </>
                  )}
                </dl>
                {trial.verdict === "pending" &&
                  ["succeeded", "failed", "cancelled"].includes(trial.runStatus) && (
                    <div className="mt-3 space-y-2">
                      {!reviewSupport && (
                        <p className="text-muted-foreground">
                          请更新 Bot 后台后验收技能试跑。原试跑结果保持不变。
                        </p>
                      )}
                      {restored && (
                        <p className="text-muted-foreground">
                          工作区数据已恢复，请重新打开技能面板并核对当前试跑结果。
                        </p>
                      )}
                      <textarea
                        className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        aria-label="试跑验收依据"
                        value={notes[trial.id] ?? ""}
                        maxLength={8000}
                        rows={2}
                        placeholder="填写实际核对结果或需要修订的问题"
                        onChange={(event) => setNotes({ ...notes, [trial.id]: event.target.value })}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            !reviewSupport ||
                            restored ||
                            trial.runStatus !== "succeeded" ||
                            !notes[trial.id]?.trim()
                          }
                          onClick={() => void act(() => reviewTrial(trial.id, "passed"))}
                        >
                          <Check size={13} />
                          通过
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || !reviewSupport || restored || !notes[trial.id]?.trim()}
                          onClick={() => void act(() => reviewTrial(trial.id, "failed"))}
                        >
                          <X size={13} />
                          需修订
                        </Button>
                      </div>
                    </div>
                  )}
              </details>
            ))}
          </div>
        </details>
      )}
      {footer}
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  )
}
