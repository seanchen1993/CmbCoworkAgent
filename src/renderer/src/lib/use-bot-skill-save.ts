import { useLayoutEffect, useRef, useState } from "react"
import { botApi } from "./bot-api"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { pendingSkillSaveStore, isDefinitiveSkillSaveError } from "./bot-skill-save-pending"
import type { BotPendingSkillSave } from "../../../shared/bot-skill-save"
import type { BotSkill } from "../../../shared/bot-types"

export type SkillSaveFields = Omit<BotPendingSkillSave, "nonce" | "botId" | "expectedDataEpoch">
interface AcknowledgedSave {
  input: BotPendingSkillSave
  saved?: BotSkill
  rejected?: string
}

/** Shared by creation, revision and enabled state; an unknown toggle never becomes its inverse. */
export function useBotSkillSave(
  botId: string,
  id: string | undefined,
  onSaved: () => Promise<void>
) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore((state) =>
    Boolean(
      state.host?.capabilities?.includes("skill-save-receipts") &&
      state.host.capabilities.includes("mutation-data-epoch-v2")
    )
  )
  const [epoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const [record, setRecord] = useState(() => pendingSkillSaveStore.inspect(botId, id, epoch))
  const [acknowledged, setAcknowledged] = useState<AcknowledgedSave | null>(null)
  const acknowledgedRef = useRef<AcknowledgedSave | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const lifecycle = useRef({ generation: 0 }),
    inFlight = useRef(false)
  useLayoutEffect(() => {
    const fence = lifecycle.current
    ++fence.generation
    return () => {
      ++fence.generation
    }
  }, [])
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "valid" && record.kind !== "empty"
  const restored = authorityRetired || epoch !== dataEpoch
  const finish = async (
    ack: AcknowledgedSave,
    live: () => boolean,
    currentEpoch: () => boolean
  ): Promise<boolean> => {
    // A reply from before a restore belongs to the retired operation record.
    // Leave it available for explicit review; it cannot settle the current UI.
    if (!currentEpoch()) return false
    if (!pendingSkillSaveStore.acknowledge(ack.input, epoch)) {
      if (live()) setError("保存结果已确认，本机操作记录尚未清除。重试只核对已完成记录。")
      return false
    }
    if (ack.rejected) {
      if (live()) {
        acknowledgedRef.current = null
        setAcknowledged(null)
        setRecord(pendingSkillSaveStore.inspect(botId, id, epoch))
        setError(ack.rejected)
      }
      return false
    }
    if (!live()) return false
    try {
      await onSaved()
    } catch {
      if (live()) setError("技能已保存，列表同步失败。重试只重新读取列表。")
      return false
    }
    if (!live()) return false
    acknowledgedRef.current = null
    setAcknowledged(null)
    setRecord(pendingSkillSaveStore.inspect(botId, id, epoch))
    return true
  }
  const save = async (fields?: SkillSaveFields): Promise<boolean> => {
    if (inFlight.current || restored || !supported || blocked) return false
    const operation = lifecycle.current.generation
    const mounted = () => lifecycle.current.generation === operation
    const currentEpoch = () =>
      (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === epoch
    const live = () => mounted() && currentEpoch()
    if (!live()) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      if (acknowledgedRef.current) return await finish(acknowledgedRef.current, live, currentEpoch)
      const current = pendingSkillSaveStore.inspect(botId, id, epoch)
      if (current.kind !== "empty" && current.kind !== "valid") {
        if (live()) setRecord(current)
        return false
      }
      const input =
        current.kind === "valid"
          ? current.input
          : fields
            ? {
                ...fields,
                botId,
                expectedDataEpoch: epoch,
                nonce: crypto.randomUUID()
              }
            : null
      if (!input || input.id !== id || !live()) return false
      pendingSkillSaveStore.remember(input, epoch)
      if (!live()) return false
      setRecord(pendingSkillSaveStore.inspect(botId, id, epoch))
      let saved: BotSkill
      try {
        saved = await botApi.saveSkill(input)
      } catch (failure) {
        const code = (failure as { code?: unknown } | null)?.code
        if (code === "data_epoch" || code === "workspace_replaced") {
          if (live()) {
            setAuthorityRetired(true)
            setError("工作区数据已恢复，原保存记录已保留。请关闭后重新打开，核对或归档原记录。")
          }
          return false
        }
        if (!isDefinitiveSkillSaveError(failure)) {
          if (live()) setError("尚未收到保存结果。重试会核对同一次保存，原内容和版本保持不变。")
          return false
        }
        const ack = {
          input,
          rejected: failure instanceof Error ? failure.message : "技能保存被拒绝"
        }
        if (!currentEpoch()) return false
        if (live()) {
          acknowledgedRef.current = ack
          setAcknowledged(ack)
        }
        return await finish(ack, live, currentEpoch)
      }
      if (
        saved.botId !== input.botId ||
        (input.id && saved.id !== input.id) ||
        !saved.id ||
        saved.version !== (input.version ?? 0) + 1 ||
        saved.name !== input.name ||
        saved.instructions !== input.instructions ||
        saved.enabled !== input.enabled
      ) {
        if (live()) setError("保存回执与原请求不一致，原记录仍保留。请重试核对。")
        return false
      }
      if (!currentEpoch()) return false
      const ack = { input, saved }
      if (live()) {
        acknowledgedRef.current = ack
        setAcknowledged(ack)
      }
      return await finish(ack, live, currentEpoch)
    } catch (failure) {
      if (live())
        setError(
          failure instanceof Error ? failure.message : "无法保留保存记录，本次修改尚未提交。"
        )
      return false
    } finally {
      inFlight.current = false
      // Restore may keep this card mounted. Release its busy presentation while
      // still withholding old-scope errors, receipts and list callbacks.
      if (mounted()) setBusy(false)
    }
  }
  const refreshRecord = () => setRecord(pendingSkillSaveStore.inspect(botId, id, epoch))
  return {
    save,
    pending,
    record,
    epoch,
    busy,
    error,
    acknowledged: Boolean(acknowledged),
    blocked,
    restored,
    supported,
    refreshRecord,
    fieldsDisabled:
      busy || restored || !supported || record.kind !== "empty" || Boolean(acknowledged),
    blocksOtherActions: busy || restored || record.kind !== "empty" || Boolean(acknowledged),
    actionsDisabled:
      busy || restored || !supported || record.kind !== "empty" || Boolean(acknowledged),
    discard: (raw: string) => pendingSkillSaveStore.discard(botId, id, epoch, raw)
  }
}
export type BotSkillSaveSession = ReturnType<typeof useBotSkillSave>
