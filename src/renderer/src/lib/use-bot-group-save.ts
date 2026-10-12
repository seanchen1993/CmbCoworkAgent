import { useLayoutEffect, useRef, useState } from "react"
import { botApi } from "./bot-api"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import {
  pendingGroupStore,
  isDefinitiveGroupSaveError,
  type PendingGroupSave
} from "./bot-group-pending"
import type { BotConversation } from "../../../shared/bot-types"
export type GroupSaveFields =
  | Omit<Extract<PendingGroupSave, { id?: undefined }>, "nonce" | "expectedDataEpoch">
  | Omit<Extract<PendingGroupSave, { id: string }>, "nonce" | "expectedDataEpoch">
/** A detached immutable view of the original saved request; this grants no domain authority. */
type ReadonlyGroupRequest<T> = T extends PendingGroupSave
  ? Readonly<Omit<T, "members">> & { readonly members: readonly string[] }
  : never
export type BotGroupSaveRequest = ReadonlyGroupRequest<PendingGroupSave>
export interface BotGroupSaveOptions {
  /** Additional local UI ownership only; the Host and original data epoch remain authoritative. */
  isCurrent?(): boolean
  /** New protected requests only, after remember and before submission. Never invoked for replay. */
  prepared?(input: BotGroupSaveRequest): void
}
function requestView(input: PendingGroupSave): BotGroupSaveRequest {
  return Object.freeze({ ...input, members: Object.freeze([...input.members]) })
}
interface AcknowledgedGroupSave {
  input: PendingGroupSave
  saved?: BotConversation
  rejected?: string
}

/** The form and member pane share one exact pending record and cleanup-only acknowledged retry. */
export function useBotGroupSave(
  id: string | undefined,
  onSaved: (saved: BotConversation, input: BotGroupSaveRequest) => Promise<void>,
  options?: BotGroupSaveOptions
) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) =>
      (state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false) &&
      (!id || (state.host?.capabilities?.includes("group-update-receipts") ?? false))
  )
  const ports = useRef(options)
  useLayoutEffect(() => {
    ports.current = options
  }, [options])
  const uiCurrent = () => ports.current?.isCurrent?.() ?? true
  const [epoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const [record, setRecord] = useState(() => pendingGroupStore.inspect(id, epoch))
  const [acknowledged, setAcknowledged] = useState(false)
  const ackRef = useRef<AcknowledgedGroupSave | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const lifecycle = useRef({ generation: 0, mounted: false }),
    inFlight = useRef(false)
  useLayoutEffect(() => {
    const owner = lifecycle.current
    owner.mounted = true
    ++owner.generation
    return () => {
      owner.mounted = false
      ++owner.generation
    }
  }, [])
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const restored = authorityRetired || epoch !== dataEpoch
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === epoch
  const current = () => lifecycle.current.mounted && currentEpoch() && uiCurrent()
  const finish = async (
    ack: AcknowledgedGroupSave,
    live: () => boolean,
    currentEpoch: () => boolean
  ): Promise<boolean> => {
    if (!currentEpoch()) return false
    if (!pendingGroupStore.acknowledge(ack.input, epoch)) {
      if (live()) setError("保存结果已确认，本机操作记录尚未清除。重试只核对已完成记录。")
      return false
    }
    if (!live()) return false
    if (ack.rejected) {
      ackRef.current = null
      setAcknowledged(false)
      setRecord(pendingGroupStore.inspect(id, epoch))
      setError(ack.rejected)
      return false
    }
    if (!ack.saved) return false
    try {
      await onSaved(ack.saved, requestView(ack.input))
    } catch {
      if (live()) setError("群聊已保存，列表同步失败。重试只重新读取列表。")
      return false
    }
    if (!live()) return false
    ackRef.current = null
    setAcknowledged(false)
    setRecord(pendingGroupStore.inspect(id, epoch))
    return true
  }
  const save = async (fields?: GroupSaveFields): Promise<boolean> => {
    const operation = lifecycle.current.generation,
      mounted = () => lifecycle.current.mounted && lifecycle.current.generation === operation,
      live = () => mounted() && currentEpoch() && uiCurrent()
    if (inFlight.current || restored || !supported || blocked || !live()) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      if (ackRef.current) return await finish(ackRef.current, live, currentEpoch)
      const current = pendingGroupStore.inspect(id, epoch)
      if (current.kind !== "valid" && current.kind !== "empty") {
        if (live()) setRecord(current)
        return false
      }
      // A different editor may have submitted since this pane rendered. Show that original request before retrying it.
      if (current.kind === "valid" && !pending) {
        if (live()) {
          setRecord(current)
          setError("有一次群聊保存尚未确认，请先核对原请求。")
        }
        return false
      }
      const input: PendingGroupSave | null =
        current.kind === "valid"
          ? current.input
          : fields
            ? {
                ...fields,
                expectedDataEpoch: epoch,
                nonce: crypto.randomUUID()
              }
            : null
      if (!input || input.id !== id || !live()) return false
      pendingGroupStore.remember(input, epoch)
      if (!live()) return false
      setRecord(pendingGroupStore.inspect(id, epoch))
      if (current.kind === "empty") {
        ports.current?.prepared?.(requestView(input))
        if (!live()) return false
      }
      let saved: BotConversation
      try {
        saved =
          input.id !== undefined ? await botApi.updateGroup(input) : await botApi.createGroup(input)
      } catch (failure) {
        const code = (failure as { code?: string } | null)?.code
        if (code === "data_epoch" || code === "workspace_replaced") {
          if (live()) {
            setAuthorityRetired(true)
            setError("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。")
          }
          return false
        }
        if (!isDefinitiveGroupSaveError(failure)) {
          if (live()) setError("尚未收到保存结果。重试会核对同一次群聊保存，原内容和版本保持不变。")
          return false
        }
        const ack = {
          input,
          rejected: failure instanceof Error ? failure.message : "群聊保存被拒绝"
        }
        if (!currentEpoch()) return false
        if (live()) {
          ackRef.current = ack
          setAcknowledged(true)
        }
        return await finish(ack, live, currentEpoch)
      }
      // The backend normalizes description/name and stores membership as a sorted set; unchanged saves keep their revision.
      if (
        saved.kind !== "group" ||
        !saved.id ||
        (input.id && saved.id !== input.id) ||
        saved.name !== input.name.trim() ||
        (saved.description ?? "") !== input.description.trim() ||
        saved.members.length !== input.members.length ||
        new Set(saved.members).size !== input.members.length ||
        !saved.members.every((member) => input.members.includes(member)) ||
        (input.revision === undefined
          ? saved.revision !== 1
          : !(saved.revision === input.revision || saved.revision === input.revision + 1))
      ) {
        if (live()) setError("群聊保存回执与原请求不一致，原记录仍保留。请重试核对。")
        return false
      }
      if (!currentEpoch()) return false
      const ack = { input, saved }
      if (live()) {
        ackRef.current = ack
        setAcknowledged(true)
      }
      return await finish(ack, live, currentEpoch)
    } catch (failure) {
      if (live())
        setError(
          failure instanceof Error ? failure.message : "无法保留群聊保存记录，本次修改尚未提交。"
        )
      return false
    } finally {
      inFlight.current = false
      if (mounted()) setBusy(false)
    }
  }
  return {
    save,
    pending,
    record,
    epoch,
    blocked,
    restored,
    supported,
    busy,
    error,
    acknowledged,
    fieldsDisabled: busy || restored || !supported || record.kind !== "empty" || acknowledged,
    saveDisabled: busy || restored || !supported || blocked,
    clearError: () => {
      if (current()) setError(null)
    },
    refreshRecord: () => {
      if (current()) setRecord(pendingGroupStore.inspect(id, epoch))
    },
    isSaving: () => inFlight.current,
    discard: (raw: string) => current() && pendingGroupStore.discard(id, epoch, raw)
  }
}
export type BotGroupSaveSession = ReturnType<typeof useBotGroupSave>
