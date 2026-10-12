import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { createProtectedSavePending } from "@/lib/bot-protected-save-pending"
import { isDefinitiveSkillSaveError } from "@/lib/bot-skill-save-pending"
import { botSkillEnablement } from "../../../../shared/bot-skill-library"
import type { BotSkill } from "../../../../shared/bot-types"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

const prefix = (botId: string) => `bot-skill-enablement:${botId}:`
const key = (botId: string, id: string) => `${prefix(botId)}${id}`
const pending = createProtectedSavePending({
  record: z
    .object({ dataEpoch: z.string(), input: botSkillEnablement })
    .strict()
    .refine((value) => value.dataEpoch === value.input.expectedDataEpoch),
  input: botSkillEnablement,
  key: (input) => key(input.botId, input.id),
  maxCharacters: 4000,
  oversizeMessage: "启用状态记录过长，未提交修改。",
  storageMessage: "无法保存操作记录，未提交修改。"
})

/** Retries one exact toggle after a lost reply; it never inverts a stale card. */
export function BotSkillEnablement({
  skill,
  reload,
  recoveryOnly = false
}: {
  skill: BotSkill
  reload(): Promise<void>
  recoveryOnly?: boolean
}) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [epoch] = useState(dataEpoch)
  const [record, setRecord] = useState(() => pending.inspect(key(skill.botId, skill.id), epoch))
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  const lock = useRef(false),
    lifecycle = useRef({ generation: 0 })
  useLayoutEffect(() => {
    const fence = lifecycle.current
    ++fence.generation
    return () => {
      ++fence.generation
    }
  }, [])
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === epoch
  const refresh = () => setRecord(pending.inspect(key(skill.botId, skill.id), epoch))
  const toggle = async () => {
    if (lock.current || !currentEpoch()) return
    const generation = lifecycle.current.generation
    const mounted = () => lifecycle.current.generation === generation
    const live = () => mounted() && currentEpoch()
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      if (!settled) {
        const current = pending.inspect(key(skill.botId, skill.id), epoch)
        if (recoveryOnly && current.kind === "empty") return
        if (current.kind !== "valid" && current.kind !== "empty") {
          refresh()
          return
        }
        const input =
          current.kind === "valid"
            ? current.input
            : {
                nonce: crypto.randomUUID(),
                expectedDataEpoch: epoch,
                botId: skill.botId,
                id: skill.id,
                version: skill.version,
                revision: skill.enablementRevision ?? 0,
                enabled: !skill.enabled
              }
        pending.remember(input, epoch)
        refresh()
        try {
          const result = await botApi.setSkillEnabled(input)
          if (
            result.botId !== input.botId ||
            result.id !== input.id ||
            result.version !== input.version ||
            result.revision !== input.revision + 1 ||
            result.enabled !== input.enabled
          )
            throw new Error("后台回执与原请求不一致，请重试核对。")
        } catch (failure) {
          if (live() && isDefinitiveSkillSaveError(failure)) {
            pending.acknowledge(input, epoch)
            refresh()
          }
          throw failure
        }
        if (!live()) return
        if (!pending.acknowledge(input, epoch))
          throw new Error("状态已保存，本机记录尚未清除，请重试核对。")
        refresh()
        setSettled(true)
      }
      await reload()
      if (live()) setSettled(false)
    } catch (failure) {
      if (live())
        setError(failure instanceof Error ? failure.message : "尚未收到结果，请重试核对。")
    } finally {
      lock.current = false
      if (mounted()) setBusy(false)
    }
  }
  if (recoveryOnly && record.kind === "empty" && !settled) return null
  return (
    <div
      className={recoveryOnly ? "space-y-2 rounded-xl border border-border/70 p-3" : "space-y-2"}
      aria-label={recoveryOnly ? "已移除技能的待确认启用状态" : undefined}
    >
      {recoveryOnly && (
        <p className="text-xs text-muted-foreground">技能已从列表移除，请核对之前的启用操作。</p>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || dataEpoch !== epoch || !["empty", "valid"].includes(record.kind)}
        onClick={() => void toggle()}
      >
        {busy
          ? "保存中…"
          : settled
            ? "同步启用状态"
            : record.kind === "valid"
              ? "核对启用状态"
              : skill.enabled
                ? "对此 Bot 停用"
                : "对此 Bot 启用"}
      </Button>
      <BotPendingSaveRecovery
        record={record}
        dataEpoch={epoch}
        operationLabel="技能启用"
        discard={(raw) => pending.discard(key(skill.botId, skill.id), epoch, raw)}
        onRepaired={refresh}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Recover lost receipts even when a definition was removed while its toggle was pending. */
export function BotSkillEnablementRecovery({
  botId,
  activeIds,
  reload
}: {
  botId: string
  activeIds: string[]
  reload(): Promise<void>
}) {
  const identity = activeIds.join("\0")
  const inventory = useMemo(() => {
    try {
      if (localStorage.length > 4096)
        throw new Error("本机操作记录过多，请检查应用存储后重新打开。")
      const active = new Set(identity.split("\0")),
        ids: string[] = []
      for (let index = 0; index < localStorage.length; index++) {
        const entry = localStorage.key(index)
        if (!entry?.startsWith(prefix(botId))) continue
        const id = entry.slice(prefix(botId).length)
        if (id && !active.has(id)) ids.push(id)
        if (ids.length > 64) throw new Error("待核对技能开关过多，请先处理原请求。")
      }
      return { ids, error: null }
    } catch (error) {
      return { ids: [], error: error instanceof Error ? error.message : "无法读取技能启用记录。" }
    }
  }, [botId, identity])
  return (
    <>
      {inventory.error && (
        <p role="alert" className="text-xs text-destructive">
          {inventory.error}
        </p>
      )}
      {inventory.ids.map((id) => (
        <BotSkillEnablement
          key={id}
          recoveryOnly
          skill={{
            id,
            botId,
            name: "已移除技能",
            instructions: "",
            version: 1,
            enabled: false,
            verified: false,
            createdAt: 0,
            scope: "user"
          }}
          reload={reload}
        />
      ))}
    </>
  )
}
