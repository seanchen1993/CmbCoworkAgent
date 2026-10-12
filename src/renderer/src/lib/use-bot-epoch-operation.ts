import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import type { ProtectedSaveRecord } from "./bot-protected-save-pending"

interface EpochRequest {
  dataEpoch: string
  nonce: string
}
interface PendingOperation<Input> {
  inspect(epoch: string): ProtectedSaveRecord<Input>
  remember(input: Input): void
  acknowledge(input: Input): boolean
  discard(epoch: string, raw: string): boolean
}
interface Options<Input extends EpochRequest, Receipt> {
  scope: string
  pending: PendingOperation<Input>
  matchesInput(input: Input): boolean
  verifies(input: Input, receipt: Receipt): boolean
  change(input: Input): Promise<Receipt>
  definitiveErrors: readonly string[]
  /** Follow-up is read-only. Check the supplied lease before each read and after its await. */
  onConfirmed(receipt: Receipt, live: () => boolean): Promise<void>
}
interface ConfirmedOperation<Input, Receipt> {
  input: Input
  receipt?: Receipt
  rejected?: string
}

/** Shared original-nonce lifecycle for operations whose receipts are not a settings View. */
export function useBotEpochOperation<Input extends EpochRequest, Receipt>(
  options: Options<Input, Receipt>
) {
  const currentDataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [scope] = useState(() => ({ identity: options.scope, epoch: currentDataEpoch }))
  const config = useRef(options)
  config.current = options
  const owner = useRef({ mounted: false, generation: 0, saving: false })
  useLayoutEffect(() => {
    const life = owner.current
    life.mounted = true
    ++life.generation
    return () => {
      life.mounted = false
      ++life.generation
    }
  }, [])
  const current = useCallback(
    () =>
      config.current.scope === scope.identity &&
      (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === scope.epoch,
    [scope]
  )
  const isCurrent = useCallback(() => owner.current.mounted && current(), [current])
  const [record, setRecord] = useState(() => options.pending.inspect(scope.epoch))
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false),
    [retired, setRetired] = useState(false)
  const confirmed = useRef<ConfirmedOperation<Input, Receipt> | null>(null)
  const inspect = useCallback(() => config.current.pending.inspect(scope.epoch), [scope])
  const refreshRecord = useCallback(() => {
    if (owner.current.mounted && current()) setRecord(inspect())
  }, [current, inspect])
  const retire = useCallback(() => {
    if (owner.current.mounted && current()) setRetired(true)
  }, [current])
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const restored = retired || scope.epoch !== currentDataEpoch || options.scope !== scope.identity
  const save = async (draft?: () => Input): Promise<boolean> => {
    const generation = owner.current.generation,
      mounted = () => owner.current.mounted && owner.current.generation === generation,
      live = () => mounted() && current()
    if (!supported || !live() || owner.current.saving || blocked || restored) return false
    owner.current.saving = true
    setBusy(true)
    setError(null)
    const finish = async (ack: ConfirmedOperation<Input, Receipt>) => {
      if (!current()) return false
      if (!config.current.pending.acknowledge(ack.input)) {
        if (live()) setError("操作结果已确认，本机记录尚未清除。重试只核对已完成记录。")
        return false
      }
      if (!live()) return false
      if (ack.rejected) {
        confirmed.current = null
        setAcknowledged(false)
        setRecord(inspect())
        setError(ack.rejected)
        return false
      }
      if (ack.receipt === undefined) return false
      try {
        await config.current.onConfirmed(ack.receipt, live)
        if (!live()) return false
        confirmed.current = null
        setAcknowledged(false)
        setRecord(inspect())
        return true
      } catch (failure) {
        if (live()) {
          if ((failure as { code?: string })?.code === "data_epoch") {
            setRetired(true)
            setError("工作区数据已恢复，请重新打开核对原操作。")
          } else setError("操作结果已确认，当前状态读取失败。重试只同步状态。")
        }
        return false
      }
    }
    try {
      if (confirmed.current) return await finish(confirmed.current)
      const present = inspect()
      if (present.kind !== "valid" && present.kind !== "empty") {
        setRecord(present)
        return false
      }
      if (present.kind === "valid" && !pending) {
        setRecord(present)
        setError("有一次操作尚未确认，请先核对原请求。")
        return false
      }
      const input = present.kind === "valid" ? present.input : draft?.()
      if (
        !input ||
        input.dataEpoch !== scope.epoch ||
        !config.current.matchesInput(input) ||
        !live()
      )
        return false
      config.current.pending.remember(input)
      if (!live()) return false
      setRecord(inspect())
      let receipt: Receipt
      try {
        receipt = await config.current.change(input)
      } catch (failure) {
        if (!current()) return false
        const code = (failure as { code?: string })?.code
        if (code === "data_epoch") {
          if (live()) {
            setRetired(true)
            setError("工作区数据已恢复，请重新打开核对。原操作记录仍保留。")
          }
          return false
        }
        if (!code || !config.current.definitiveErrors.includes(code)) {
          if (live())
            setError(
              failure instanceof Error ? failure.message : "操作结果尚未确认，请核对原请求。"
            )
          return false
        }
        const ack = {
          input,
          rejected: failure instanceof Error ? failure.message : "原操作已被拒绝"
        }
        if (live()) {
          confirmed.current = ack
          setAcknowledged(true)
        }
        return await finish(ack)
      }
      if (!config.current.verifies(input, receipt)) {
        if (live()) setError("操作回执与原请求不一致，原记录仍保留。请核对原操作。")
        return false
      }
      if (!current()) return false
      const ack = { input, receipt }
      if (live()) {
        confirmed.current = ack
        setAcknowledged(true)
      }
      return await finish(ack)
    } catch (failure) {
      if (live()) {
        setRecord(inspect())
        setError(
          failure instanceof Error ? failure.message : "无法保留操作记录，本次修改尚未提交。"
        )
      }
      return false
    } finally {
      owner.current.saving = false
      if (mounted()) setBusy(false)
    }
  }
  return {
    pending,
    record,
    epoch: scope.epoch,
    busy,
    error: error || (!supported ? "请更新并重启 Bot 后台后再修改。" : null),
    acknowledged,
    restored,
    blocked,
    save,
    refreshRecord,
    isSaving: () => owner.current.saving,
    isCurrent,
    retire,
    clearError: () => setError(null),
    discard: (raw: string) =>
      owner.current.mounted && current() && config.current.pending.discard(scope.epoch, raw),
    fieldsDisabled: !supported || busy || restored || acknowledged || record.kind !== "empty",
    saveDisabled: !supported || busy || restored || blocked
  }
}
