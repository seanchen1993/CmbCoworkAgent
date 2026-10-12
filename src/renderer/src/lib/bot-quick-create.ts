import type { BotCreateInput, CoworkBot } from "../../../shared/bot-types"
import { BotDomainError } from "../../../shared/bot-types"
import type { BotViewportPositionLease } from "./bot-viewport-position"
import { botErrorNotice, type BotErrorNotice } from "./bot-error-notice"
import {
  createPendingBotStore,
  type PendingBotSave,
  type PendingBotRecord
} from "./bot-editor-pending"

export interface BotQuickCreateScope {
  hostId?: string
  dataEpoch: string | null
  selected: string | null
  lease: BotViewportPositionLease | null
  capabilities: readonly string[]
}
export type BotQuickCreateReceipt = { bot: CoworkBot; conversationId: string }
/** UI-only continuation, bound to the original protected create nonce and origin. */
export interface BotQuickCreateSelectionContinuation {
  openNonce: string
  sourceRevision: string
  /** Explicitly empty new-chat intent; omitted continuations retain draft-suppression behavior. */
  requestIntroduction?: boolean
  current(): boolean
  adopt(input: PendingBotSave, receipt: BotQuickCreateReceipt, origin: BotQuickCreateScope): boolean
  ready(receipt: BotQuickCreateReceipt): boolean
}
export interface BotQuickCreateState {
  busy: boolean
  phase: "idle" | "configure" | "uncertain" | "sync_failed" | "cleanup_failed" | "blocked" | "error"
  notice: BotErrorNotice | null
  record?: PendingBotRecord
}
export interface BotQuickCreatePorts {
  scope(): BotQuickCreateScope
  defaults(nonce: string): Omit<PendingBotSave, "nonce" | "id" | "revision" | "expectedDataEpoch">
  create(input: BotCreateInput): Promise<BotQuickCreateReceipt>
  refresh(preserveSelection?: boolean): Promise<void>
  select(id: string): void
  pending?: ReturnType<typeof createPendingBotStore>
  nonce?(): string
  validate?(receipt: BotQuickCreateReceipt): boolean
}
const rejected = new Set(["invalid_input", "bot_limit", "nonce_conflict"])
function sameScope(a: BotQuickCreateScope, b: BotQuickCreateScope) {
  return (
    a.hostId === b.hostId &&
    a.dataEpoch === b.dataEpoch &&
    a.selected === b.selected &&
    a.lease?.viewId === b.lease?.viewId &&
    a.lease?.generation === b.lease?.generation
  )
}
/** Reuse one durable create receipt, including explicitly requested first introduction. */
export function createBotQuickCreateController(ports: BotQuickCreatePorts) {
  const pending = ports.pending ?? createPendingBotStore()
  const listeners = new Set<() => void>()
  let selectionListener: ((id: string) => void) | undefined
  let state: BotQuickCreateState = { busy: false, phase: "idle", notice: null }
  let alive = true,
    locked = false
  let retiredEpoch: string | null = null
  // No mutation exists until the user confirms this visible creation choice.
  let configuring: {
    origin: BotQuickCreateScope
    continuation?: BotQuickCreateSelectionContinuation
    nameHint?: string
  } | null = null
  let selectionBinding: {
    nonce: string
    origin: BotQuickCreateScope
    continuation: BotQuickCreateSelectionContinuation
  } | null = null
  let acknowledged: {
    input: PendingBotSave
    receipt: BotQuickCreateReceipt | null
    origin: BotQuickCreateScope
    rejection?: BotErrorNotice
    continuation?: BotQuickCreateSelectionContinuation
    adoption?: "adopted" | "blocked"
  } | null = null
  function publish(next: BotQuickCreateState) {
    if (!alive) return
    state = next
    for (const listener of listeners) listener()
  }
  async function synchronize(saved: NonNullable<typeof acknowledged>) {
    if (ports.scope().dataEpoch !== saved.origin.dataEpoch) {
      acknowledged = null
      publish({
        busy: false,
        phase: "error",
        notice: {
          message: "工作区已切换，原创建记录已保留。请核对对应工作区后归档记录。"
        }
      })
      return
    }
    if (!pending.acknowledge(saved.input, saved.origin.dataEpoch!)) {
      publish({
        busy: false,
        phase: "cleanup_failed",
        notice: {
          message: saved.receipt
            ? "Bot 已创建，本机操作记录尚未清除。重试只核对已完成记录。"
            : "后台已拒绝创建，本机操作记录尚未清除。重试只核对已完成记录。"
        }
      })
      return
    }
    if (!saved.receipt) {
      acknowledged = null
      selectionBinding = null
      publish({
        busy: false,
        phase: "error",
        notice: saved.rejection ?? { message: "Bot 未创建" }
      })
      return
    }
    if (!alive) {
      acknowledged = null
      return
    }
    try {
      if (saved.continuation && !saved.adoption) {
        saved.adoption =
          saved.continuation.current() &&
          sameScope(saved.origin, ports.scope()) &&
          saved.continuation.adopt(saved.input, saved.receipt, saved.origin)
            ? "adopted"
            : "blocked"
      }
      await ports.refresh(Boolean(saved.continuation))
      if (alive && saved.continuation) {
        if (
          saved.adoption === "adopted" &&
          ports.validate?.(saved.receipt) !== false &&
          saved.continuation.ready(saved.receipt)
        )
          selectionListener?.(saved.receipt.conversationId)
      } else if (alive && sameScope(saved.origin, ports.scope())) {
        ports.select(saved.receipt.conversationId)
        selectionListener?.(saved.receipt.conversationId)
      }
      acknowledged = null
      selectionBinding = null
      publish({ busy: false, phase: "idle", notice: null })
    } catch (error) {
      publish({
        busy: false,
        phase: "sync_failed",
        notice: botErrorNotice(error, "Bot 已创建，列表同步失败。重试只重新读取列表。")
      })
    }
  }
  async function start(
    continuation?: BotQuickCreateSelectionContinuation,
    nameHint?: string,
    autoReviewEnabled?: boolean
  ) {
    if (!alive || locked) return
    locked = true
    try {
      if (acknowledged) {
        publish({ ...state, busy: true })
        await synchronize(acknowledged)
        return
      }
      const origin = ports.scope(),
        epoch = origin.dataEpoch
      if (epoch && epoch === retiredEpoch) {
        publish({
          busy: false,
          phase: "error",
          notice: {
            message: "工作区数据已恢复，原创建记录已保留。请重新打开后核对或归档原记录。"
          }
        })
        return
      }
      if (
        !epoch ||
        !origin.capabilities.includes("scoped-bot-create") ||
        !origin.capabilities.includes("mutation-data-epoch-v2")
      ) {
        publish({
          busy: false,
          phase: "error",
          notice: { message: "请先连接并重启最新后台，再创建 Bot。" }
        })
        return
      }
      const record = pending.inspect(undefined, epoch)
      if (record.kind !== "empty" && record.kind !== "valid") {
        publish({
          busy: false,
          phase: "blocked",
          notice: {
            message:
              record.kind === "obsolete"
                ? "有恢复前的创建记录。请核对原工作区并归档记录后，再发起新创建。"
                : "无法核对本机创建记录。请保留记录后修复，再发起新创建。"
          },
          record
        })
        return
      }
      if (
        record.kind === "empty" &&
        origin.capabilities.includes("bot-create-review-v1") &&
        autoReviewEnabled === undefined
      ) {
        configuring = { origin, continuation, nameHint }
        publish({ busy: false, phase: "configure", notice: null })
        return
      }
      configuring = null
      const nonce = ports.nonce?.() ?? crypto.randomUUID()
      const input: PendingBotSave =
        record.kind === "valid"
          ? record.input
          : {
              ...ports.defaults(nonce),
              ...(autoReviewEnabled === undefined ? {} : { autoReviewEnabled }),
              ...((!continuation || continuation.requestIntroduction === true) &&
              origin.capabilities.includes("bot-introduction-v1")
                ? { introduction: { language: "zh-CN" } }
                : {}),
              ...(nameHint !== undefined ? { name: nameHint } : {}),
              nonce,
              expectedDataEpoch: epoch
            }
      if (
        input.autoReviewEnabled !== undefined &&
        !origin.capabilities.includes("bot-create-review-v1")
      ) {
        publish({
          busy: false,
          phase: "error",
          notice: { message: "这次创建包含操作审核设置，请连接支持此功能的后台后核对原请求。" }
        })
        return
      }
      if (input.introduction && !origin.capabilities.includes("bot-introduction-v1")) {
        publish({
          busy: false,
          phase: "error",
          notice: { message: "这次创建包含首次介绍，请连接支持此功能的后台后核对原请求。" }
        })
        return
      }
      // Legacy unknown intents retain their exact payload. Never retrofit a field into its nonce hash.
      try {
        pending.remember(input, epoch)
      } catch (error) {
        publish({ busy: false, phase: "error", notice: botErrorNotice(error) })
        return
      }
      if (record.kind === "empty")
        selectionBinding = continuation ? { nonce: input.nonce, origin, continuation } : null
      const binding = selectionBinding?.nonce === input.nonce ? selectionBinding : null
      // A restored intent has no authority over a later local UI draft.
      const selection =
        binding?.continuation ??
        (continuation
          ? {
              ...continuation,
              current: () => false,
              adopt: () => false,
              ready: () => false
            }
          : undefined)
      const originalOrigin = binding?.origin ?? origin
      publish({ busy: true, phase: "uncertain", notice: null })
      try {
        if (ports.scope().dataEpoch !== epoch) {
          publish({
            busy: false,
            phase: "error",
            notice: {
              message: "工作区已切换，原创建记录已保留。本次创建尚未提交。"
            }
          })
          return
        }
        const receipt = await ports.create(input)
        if (!receipt?.bot?.id || !receipt.conversationId || receipt.bot.name !== input.name)
          throw new Error("创建结果不完整，请核对同一次请求")
        acknowledged = {
          input,
          receipt,
          origin: originalOrigin,
          continuation: selection
        }
        await synchronize(acknowledged)
      } catch (error) {
        if (
          error instanceof BotDomainError &&
          (error.code === "data_epoch" || error.code === "workspace_replaced")
        ) {
          retiredEpoch = epoch
          publish({
            busy: false,
            phase: "error",
            notice: {
              ...botErrorNotice(error),
              message: "工作区数据已恢复，原创建记录已保留。请重新打开后核对或归档原记录。"
            }
          })
          return
        }
        const definitive = error instanceof BotDomainError && rejected.has(error.code)
        if (definitive) {
          acknowledged = {
            input,
            receipt: null,
            origin: originalOrigin,
            continuation: selection,
            rejection: botErrorNotice(error, "Bot 未创建")
          }
          await synchronize(acknowledged)
          return
        }
        publish({
          busy: false,
          phase: "uncertain",
          notice: {
            ...botErrorNotice(error, "创建结果尚未确认"),
            message: "创建结果尚未确认。重试会核对同一次请求。"
          }
        })
      }
    } finally {
      locked = false
    }
  }
  function repair(expectedRaw: string): boolean {
    if (locked) return false
    const epoch = ports.scope().dataEpoch
    if (!epoch || !pending.discard(undefined, epoch, expectedRaw)) return false
    selectionBinding = null
    publish({ busy: false, phase: "idle", notice: null })
    return true
  }
  return {
    start,
    async confirmReview(enabled: boolean) {
      const choice = configuring
      if (!alive || locked || !choice) return
      if (!sameScope(choice.origin, ports.scope()) || choice.continuation?.current() === false) {
        configuring = null
        publish({
          busy: false,
          phase: "error",
          notice: { message: "当前聊天或工作区已变化，请重新发起创建。尚未创建 Bot。" }
        })
        return
      }
      await start(choice.continuation, choice.nameHint, enabled)
    },
    cancelReview() {
      if (locked || state.phase !== "configure") return
      configuring = null
      publish({ busy: false, phase: "idle", notice: null })
    },
    repair,
    onSelected(listener: ((id: string) => void) | undefined) {
      selectionListener = listener
      return () => {
        if (selectionListener === listener) selectionListener = undefined
      }
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    activate() {
      alive = true
    },
    dispose() {
      configuring = null
      alive = false
      selectionListener = undefined
      listeners.clear()
    }
  }
}
