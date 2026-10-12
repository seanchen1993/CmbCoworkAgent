import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import type { ProtectedSaveRecord } from "./bot-protected-save-pending"

interface SettingsIdentity {
  botId: string | null
  dataEpoch: string
  revision: number
}
interface PendingSettings<Input extends SettingsIdentity> {
  inspect(botId: Input["botId"], epoch: string): ProtectedSaveRecord<Input>
  remember(input: Input): void
  acknowledge(input: Input): boolean
  discard(botId: Input["botId"], epoch: string, raw: string): boolean
}
interface Options<Input extends SettingsIdentity, Result, Receipt> {
  botId: Input["botId"]
  pending: PendingSettings<Input>
  read(botId: Input["botId"]): Promise<Result>
  change(input: Input): Promise<Receipt>
  verifies(input: Input, receipt: Receipt): boolean
  /** Additional endpoint-specific definitive rejections; authority changes retain pending. */
  rejectedCodes?: readonly string[]
  retiredCodes?: readonly string[]
}

/** Settings share one exact pending/ACK lifecycle; only explicit current-scope reads update the form. */
export function useBotSettingsSave<
  Input extends SettingsIdentity & { nonce: string },
  Result extends SettingsIdentity,
  Receipt = Result
>(options: Options<Input, Result, Receipt>) {
  const currentDataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [scope] = useState(() => ({
    botId: options.botId,
    epoch: currentDataEpoch
  }))
  const config = useRef(options)
  config.current = options
  const [value, setValue] = useState<Result | null>(null)
  const [record, setRecord] = useState(() => options.pending.inspect(scope.botId, scope.epoch))
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false),
    [saved, setSaved] = useState(false)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const owner = useRef({ generation: 0, reading: 0, saving: false, mounted: true })
  const ack = useRef<{ input: Input; rejected?: string } | null>(null)
  useLayoutEffect(() => {
    const life = owner.current
    ++life.generation
    life.mounted = true
    return () => {
      life.mounted = false
      ++life.generation
      ++life.reading
    }
  }, [])
  const current = useCallback(
    () =>
      config.current.botId === scope.botId &&
      (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === scope.epoch,
    [scope]
  )
  const inspect = useCallback(
    () => config.current.pending.inspect(scope.botId, scope.epoch),
    [scope]
  )
  const refreshRecord = useCallback(() => {
    if (owner.current.mounted && current()) setRecord(inspect())
  }, [current, inspect])
  const load = useCallback(
    async (shouldApply: () => boolean = () => true) => {
      const generation = owner.current.generation,
        reading = ++owner.current.reading
      if (!owner.current.mounted || !current() || owner.current.saving || !shouldApply())
        return undefined
      try {
        const next = await config.current.read(scope.botId)
        if (
          !shouldApply() ||
          generation !== owner.current.generation ||
          reading !== owner.current.reading ||
          !current()
        )
          return undefined
        if (next.botId !== scope.botId || next.dataEpoch !== scope.epoch) {
          setAuthorityRetired(true)
          setError("工作区数据已恢复，请重新打开设置。原操作记录仍保留。")
          return undefined
        }
        setValue(next)
        setRecord(inspect())
        return next
      } catch (failure) {
        if (
          shouldApply() &&
          generation === owner.current.generation &&
          reading === owner.current.reading &&
          current()
        )
          setError(failure instanceof Error ? failure.message : "设置读取失败")
        return undefined
      }
    },
    [current, inspect, scope]
  )
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const restored =
    authorityRetired || scope.epoch !== currentDataEpoch || options.botId !== scope.botId
  const save = async (draft?: () => Input): Promise<boolean> => {
    const generation = owner.current.generation,
      mounted = () => owner.current.mounted && generation === owner.current.generation,
      live = () => mounted() && current()
    if (!supported || !value || owner.current.saving || restored || blocked || !live()) return false
    owner.current.saving = true
    ++owner.current.reading
    setBusy(true)
    setError(null)
    setSaved(false)
    const finish = async (receipt: { input: Input; rejected?: string }) => {
      if (!current()) return false
      if (!config.current.pending.acknowledge(receipt.input)) {
        if (live()) setError("操作结果已确认，本机记录尚未清除。重试只核对已完成记录。")
        return false
      }
      if (!live()) return false
      if (receipt.rejected) {
        ack.current = null
        setAcknowledged(false)
        setRecord(inspect())
        setError(receipt.rejected)
        return false
      }
      // A nonce replay returns the original receipt. Read current authority before enabling another edit.
      try {
        const next = await config.current.read(scope.botId)
        if (!live()) return false
        if (next.botId !== scope.botId || next.dataEpoch !== scope.epoch) {
          setAuthorityRetired(true)
          setError("工作区数据已恢复，请重新打开设置。")
          return false
        }
        setValue(next)
        setRecord(inspect())
        ack.current = null
        setAcknowledged(false)
        setSaved(true)
        return true
      } catch {
        if (live()) setError("设置已保存，当前结果读取失败。重试只重新读取设置。")
        return false
      }
    }
    try {
      if (ack.current) return await finish(ack.current)
      const present = inspect()
      if (present.kind !== "valid" && present.kind !== "empty") {
        if (live()) setRecord(present)
        return false
      }
      if (present.kind === "valid" && !pending) {
        setRecord(present)
        setError("有一次操作尚未确认，请先核对原请求。")
        return false
      }
      const input = present.kind === "valid" ? present.input : draft?.()
      if (!input || input.botId !== scope.botId || input.dataEpoch !== scope.epoch || !live())
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
        if (code === "data_epoch" || (code && config.current.retiredCodes?.includes(code))) {
          if (live()) {
            setAuthorityRetired(true)
            setError(
              code === "data_epoch"
                ? "工作区数据已恢复，请重新打开设置。原操作记录仍保留。"
                : "执行身份或权限已变化，请重新打开设置。原操作记录仍保留。"
            )
          }
          return false
        }
        if (
          !code ||
          ![
            "invalid_input",
            "not_found",
            "revision_conflict",
            "nonce_conflict",
            ...(config.current.rejectedCodes ?? [])
          ].includes(code)
        ) {
          if (live())
            setError(
              failure instanceof Error ? failure.message : "操作结果尚未确认，请核对原请求。"
            )
          return false
        }
        const confirmed = {
          input,
          rejected: failure instanceof Error ? failure.message : "原操作已被拒绝"
        }
        if (live()) {
          ack.current = confirmed
          setAcknowledged(true)
        }
        return await finish(confirmed)
      }
      if (!config.current.verifies(input, receipt)) {
        if (live()) setError("保存回执与原请求不一致，原记录仍保留。请核对原操作。")
        return false
      }
      if (!current()) return false
      const confirmed = { input }
      if (live()) {
        ack.current = confirmed
        setAcknowledged(true)
      }
      return await finish(confirmed)
    } catch (failure) {
      if (live())
        setError(
          failure instanceof Error ? failure.message : "操作记录无法保存，本次修改尚未提交。"
        )
      return false
    } finally {
      owner.current.saving = false
      if (mounted()) setBusy(false)
    }
  }
  return {
    value,
    record,
    pending,
    blocked,
    restored,
    busy,
    error: error || (!supported ? "请更新并重启 Bot 后台后再修改。" : null),
    saved,
    acknowledged,
    epoch: scope.epoch,
    load,
    save,
    refreshRecord,
    fieldsDisabled:
      !supported || busy || restored || record.kind !== "empty" || acknowledged || !value,
    saveDisabled: !supported || busy || restored || blocked || !value,
    clearError: () => setError(null),
    clearSaved: () => setSaved(false),
    discard: (raw: string) =>
      owner.current.mounted &&
      current() &&
      config.current.pending.discard(scope.botId, scope.epoch, raw)
  }
}
