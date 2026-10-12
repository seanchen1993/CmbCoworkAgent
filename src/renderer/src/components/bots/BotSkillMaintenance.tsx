import { useCallback, useEffect, useRef, useState } from "react"
import { Archive, ChevronDown, Loader2, Pin, RotateCcw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  BOT_SKILL_MAINTENANCE_CAPABILITY,
  type BotSkillMaintenanceChange,
  type BotSkillMaintenancePolicyInput,
  type BotSkillMaintenanceResult,
  type BotSkillMaintenanceRun,
  type BotSkillMaintenanceView
} from "../../../../shared/bot-skill-maintenance"

type Command =
  | { kind: "change"; input: BotSkillMaintenanceChange }
  | { kind: "policy"; input: BotSkillMaintenancePolicyInput }
  | { kind: "run"; input: BotSkillMaintenanceRun }

export function BotSkillMaintenancePanel({
  botId,
  reload
}: {
  botId: string
  reload(): Promise<void>
}) {
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_SKILL_MAINTENANCE_CAPABILITY) ?? false
  )
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const cursor = useBotWorkspaceStore((state) => state.snapshot?.cursor ?? 0)
  const observedCursor = useRef(cursor)
  const [view, setView] = useState<BotSkillMaintenanceView | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Command | null>(null)
  const [checkResult, setCheckResult] = useState<BotSkillMaintenanceResult | null>(null)
  const [after, setAfter] = useState<string | undefined>()
  const alive = useRef(false),
    locked = useRef(false),
    generation = useRef(0)
  const current = useRef({ botId, dataEpoch })
  current.current = { botId, dataEpoch }
  useEffect(() => {
    setAfter(undefined)
    setPending(null)
    setCheckResult(null)
  }, [botId, dataEpoch])
  const load = useCallback(async () => {
    const version = ++generation.current
    const live = () =>
      alive.current &&
      version === generation.current &&
      current.current.botId === botId &&
      current.current.dataEpoch === dataEpoch
    try {
      const result = await botApi.skillMaintenance({ botId, expectedDataEpoch: dataEpoch, after })
      if (live()) {
        setView(result)
        setError(null)
      }
    } catch (failure) {
      if (live()) setError(failure instanceof Error ? failure.message : "技能维护信息读取失败")
      throw failure
    }
  }, [botId, dataEpoch, after])
  useEffect(() => {
    alive.current = true
    setView(null)
    setError(null)
    // load projects only the newest request's error; event reads end the Promise here.
    if (supported) void load().catch(() => undefined)
    return () => {
      alive.current = false
    }
  }, [supported, botId, dataEpoch, load])
  // Reuse workspace updates rather than starting another polling timer. A
  // Host sweep, task completion or another window can change the protection
  // and archive state while this panel stays open. Preserve unresolved commands.
  useEffect(() => {
    if (!supported || !open || busy || pending || observedCursor.current === cursor) return
    observedCursor.current = cursor
    void load().catch(() => undefined)
  }, [supported, open, busy, pending, cursor, load])
  const execute = async (command: Command) => {
    if (
      locked.current ||
      command.input.botId !== current.current.botId ||
      command.input.expectedDataEpoch !== current.current.dataEpoch
    )
      return
    locked.current = true
    setBusy(true)
    setError(null)
    setPending(command)
    let acknowledged = false
    let result: BotSkillMaintenanceResult | undefined
    try {
      if (command.kind === "change") await botApi.changeSkillMaintenance(command.input)
      else if (command.kind === "policy") await botApi.configureSkillMaintenance(command.input)
      else result = await botApi.runSkillMaintenance(command.input)
      acknowledged = true
      if (
        !alive.current ||
        command.input.botId !== current.current.botId ||
        command.input.expectedDataEpoch !== current.current.dataEpoch
      )
        return
      await load()
      if (
        !alive.current ||
        command.input.botId !== current.current.botId ||
        command.input.expectedDataEpoch !== current.current.dataEpoch
      )
        return
      setPending(null)
      if (result) setCheckResult(result)
      if (alive.current) await reload()
    } catch (failure) {
      if (
        alive.current &&
        command.input.botId === current.current.botId &&
        command.input.expectedDataEpoch === current.current.dataEpoch
      ) {
        const code = (failure as { code?: string } | null)?.code
        if (
          [
            "revision_conflict",
            "skill_protected",
            "skill_scope",
            "data_epoch",
            "invalid_input"
          ].includes(code ?? "")
        )
          setPending(null)
        setError(
          `${acknowledged ? "已完成，刷新失败：" : ""}${failure instanceof Error ? failure.message : "操作失败"}`
        )
      }
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  if (!supported) return null
  const address = () => ({ botId, expectedDataEpoch: dataEpoch, nonce: crypto.randomUUID() })
  return (
    <section className="rounded-xl border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          if (!open) void load().catch(() => undefined)
        }}
      >
        <ShieldCheck size={15} className="text-muted-foreground" />
        <span className="flex-1 font-medium">技能维护</span>
        <span className="text-xs text-muted-foreground">
          {pending?.kind === "policy"
            ? "设置等待确认"
            : view?.policy.enabled
              ? "自动检查已开启"
              : "手动管理"}
        </span>
        <ChevronDown
          size={14}
          className={`text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            仅维护你选择的私有技能。固定保留、未完成任务和例程引用的技能受到保护；归档后可恢复，历史版本和共享副本保留。
          </p>
          {view && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={pending?.kind === "policy" ? pending.input.enabled : view.policy.enabled}
                  disabled={busy || !!pending}
                  onChange={(event) =>
                    void execute({
                      kind: "policy",
                      input: {
                        ...address(),
                        revision: view.policy.revision,
                        enabled: event.target.checked,
                        staleAfterDays: view.policy.staleAfterDays,
                        archiveAfterDays: view.policy.archiveAfterDays
                      }
                    })
                  }
                />
                空闲时自动检查：{view.policy.staleAfterDays} 天未使用提醒，
                {view.policy.archiveAfterDays} 天未使用归档
              </label>
              <div className="divide-y">
                {view.entries.map((entry) => (
                  <div
                    key={entry.skillId}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={entry.name}>
                        {entry.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {entry.archived
                          ? "已归档"
                          : entry.pinned
                            ? "固定保留"
                            : entry.stale
                              ? "建议检查"
                              : entry.managed
                                ? "纳入维护"
                                : "手动管理"}{" "}
                        · 使用 {entry.useCount} 次
                        {entry.lastUsedAt
                          ? ` · 最近 ${new Date(entry.lastUsedAt).toLocaleDateString()}`
                          : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={busy || !!pending}
                      onClick={() =>
                        void execute({
                          kind: "change",
                          input: {
                            ...address(),
                            skillId: entry.skillId,
                            version: entry.version,
                            revision: entry.revision,
                            action: entry.pinned ? "unpin" : "pin"
                          }
                        })
                      }
                      aria-label={`${entry.pinned ? "取消固定" : "固定保留"} ${entry.name}`}
                    >
                      <Pin size={12} className={entry.pinned ? "fill-current" : ""} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={busy || !!pending || entry.archived}
                      onClick={() =>
                        void execute({
                          kind: "change",
                          input: {
                            ...address(),
                            skillId: entry.skillId,
                            version: entry.version,
                            revision: entry.revision,
                            action: entry.managed ? "unmanage" : "manage"
                          }
                        })
                      }
                    >
                      {entry.managed ? "取消维护" : "纳入维护"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      title={
                        entry.archived
                          ? "恢复到技能列表"
                          : (entry.protectedReason ?? "归档后可恢复")
                      }
                      disabled={busy || !!pending || (!entry.archived && !!entry.protectedReason)}
                      onClick={() =>
                        void execute({
                          kind: "change",
                          input: {
                            ...address(),
                            skillId: entry.skillId,
                            version: entry.version,
                            revision: entry.revision,
                            action: entry.archived ? "restore" : "archive"
                          }
                        })
                      }
                    >
                      {entry.archived ? <RotateCcw size={12} /> : <Archive size={12} />}
                      {entry.archived ? "恢复" : "归档"}
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                {after && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    disabled={busy || !!pending}
                    onClick={() => setAfter(undefined)}
                  >
                    返回首页
                  </Button>
                )}
                {view.next && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    disabled={busy || !!pending}
                    onClick={() => setAfter(view.next!)}
                  >
                    更多技能
                  </Button>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy || !!pending}
                onClick={() => void execute({ kind: "run", input: address() })}
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {checkResult?.hasMore ? "继续检查" : "立即检查"}
              </Button>
              {view.policy.lastRunAt && (
                <span className="ml-2 text-[11px] text-muted-foreground">
                  上次检查 {new Date(view.policy.lastRunAt).toLocaleString()}
                </span>
              )}
              {checkResult && (
                <p role="status" className="text-[11px] text-muted-foreground">
                  本次归档 {checkResult.archivedIds.length} 项
                  {checkResult.hasMore ? "，还有技能待检查" : "，检查完成"}
                </p>
              )}
            </>
          )}
          {pending && !busy && (
            <Button size="sm" variant="outline" onClick={() => void execute(pending)}>
              核对原操作结果
            </Button>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  if (after) setAfter(undefined)
                  else void load().catch(() => undefined)
                }}
              >
                刷新当前列表
              </Button>
            </div>
          )}
          {!view && !error && <p className="text-xs text-muted-foreground">正在读取…</p>}
        </div>
      )}
    </section>
  )
}
