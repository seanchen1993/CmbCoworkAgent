import { BotError } from "../../shared/bots/contracts"
import type {
  BotWorkConversationLink,
  BotWorkConversationRef
} from "../../shared/bots/conversation"

export type LocalWorkConversationRef = Extract<BotWorkConversationRef, { kind: "local_thread" }>
export interface WorkConversationRecord extends BotWorkConversationLink {
  ref: LocalWorkConversationRef
  operationId: string
  fingerprint: string
}
export function localWorkConversationRef(value: BotWorkConversationRef): LocalWorkConversationRef {
  if (value?.kind !== "local_thread")
    throw new BotError(
      "UNSUPPORTED_HOST",
      "当前仅支持关联本机对话；项目与云端会话尚未开放，不会改为本机执行。"
    )
  const { incarnation } = value
  if (
    typeof value.threadId !== "string" ||
    !value.threadId ||
    value.threadId.length > 256 ||
    !incarnation ||
    (incarnation.token !== null &&
      (typeof incarnation.token !== "string" ||
        !incarnation.token ||
        incarnation.token.length > 4096)) ||
    !Number.isSafeInteger(incarnation.legacyCreatedAt) ||
    incarnation.legacyCreatedAt < 0
  )
    throw new BotError("INVALID_INPUT", "会话身份无效，请重新打开原对话。")
  return {
    kind: "local_thread",
    threadId: value.threadId,
    incarnation: { token: incarnation.token, legacyCreatedAt: incarnation.legacyCreatedAt }
  }
}
export function readWorkConversationRecord(
  raw: unknown,
  threadId: string
): WorkConversationRecord | undefined {
  if (raw == null) return undefined
  try {
    if (typeof raw !== "string" || raw.length > 8192) throw 0
    const v = JSON.parse(raw),
      ref = localWorkConversationRef(v.ref)
    if (
      ref.threadId !== threadId ||
      !["existing", "created"].includes(v.origin) ||
      !["preparing", "bound", "detaching", "detached"].includes(v.state) ||
      typeof v.operationId !== "string" ||
      !v.operationId ||
      !/^[a-f0-9]{64}$/.test(v.fingerprint)
    )
      throw 0
    return {
      ref,
      origin: v.origin,
      state: v.state,
      operationId: v.operationId,
      fingerprint: v.fingerprint
    }
  } catch {
    throw new BotError("CONFLICT", "任务关联记录不一致，已停止以保护原会话。")
  }
}
