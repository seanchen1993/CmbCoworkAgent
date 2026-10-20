import { BotError } from "../../shared/bots/contracts"
import { botIdentifier } from "../../shared/bots/validation"
import type {
  BotMockEvent,
  BotMockSource,
  CreateBotMockBinding
} from "../../shared/bots/mock-channel"

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new BotError("INVALID_INPUT", "模拟渠道参数包含不支持字段")
  return input as Record<string, unknown>
}
function text(input: unknown, max: number): string {
  if (typeof input !== "string" || !input.trim() || input.length > max || input.includes("\0"))
    throw new BotError("INVALID_INPUT", "模拟渠道文字无效")
  return input.trim()
}
function ids(input: unknown, max: number): string[] {
  if (!Array.isArray(input) || input.length > max || new Set(input).size !== input.length)
    throw new BotError("INVALID_INPUT", "模拟渠道身份列表无效")
  return input.map(botIdentifier)
}
export function assertBotMockText(input: string): void {
  // Transport markup is not an attachment/skill grant, including when pasted from the desktop.
  if (
    /<(?:user_attachment|attached_files?|file_attachment|skill|builtin_browser|bot-message-reply)\b|\[\[skill:|<\/?(?:cmb|devclaw)[-_]/i.test(
      input
    )
  )
    throw new BotError("INVALID_INPUT", "模拟渠道仅支持普通文字，尚不支持附件、技能和本机资源引用")
}
export function parseBotMockBinding(input: unknown): CreateBotMockBinding {
  const v = object(input, [
    "simulation",
    "botId",
    "operationId",
    "kind",
    "channelKey",
    "label",
    "allowedSenderIds"
  ])
  if (v.simulation !== true || (v.kind !== "dm" && v.kind !== "group"))
    throw new BotError("INVALID_INPUT", "这不是有效模拟绑定")
  const allowed = ids(v.allowedSenderIds, 20).sort()
  if (!allowed.length || (v.kind === "dm" && allowed.length !== 1))
    throw new BotError("INVALID_INPUT", "个人绑定只允许一个模拟身份；群绑定需明确允许成员")
  return {
    simulation: true,
    botId: botIdentifier(v.botId),
    operationId: botIdentifier(v.operationId),
    kind: v.kind,
    channelKey: botIdentifier(v.channelKey),
    label: text(v.label, 100),
    allowedSenderIds: allowed
  }
}
export function parseBotMockEvent(input: unknown): BotMockEvent {
  const v = object(input, [
    "simulation",
    "bindingId",
    "eventId",
    "messageId",
    "senderId",
    "text",
    "mentionsBotIds",
    "replyToMessageId"
  ])
  if (v.simulation !== true) throw new BotError("INVALID_INPUT", "这不是模拟渠道事件")
  const content = text(v.text, 30000)
  assertBotMockText(content)
  return {
    simulation: true,
    bindingId: botIdentifier(v.bindingId),
    eventId: botIdentifier(v.eventId),
    messageId: botIdentifier(v.messageId),
    senderId: botIdentifier(v.senderId),
    text: content,
    mentionsBotIds: ids(v.mentionsBotIds, 20).sort(),
    ...(v.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: botIdentifier(v.replyToMessageId) })
  }
}
export function parseBotMockSource(input: unknown): BotMockSource {
  const v = object(input, [
    "bindingId",
    "grantVersion",
    "conversationId",
    "audienceKey",
    "eventId",
    "messageId",
    "senderId"
  ])
  if (!Number.isSafeInteger(v.grantVersion) || Number(v.grantVersion) < 1)
    throw new BotError("CONFLICT", "模拟来源版本无效")
  const bindingId = botIdentifier(v.bindingId)
  if (v.audienceKey !== `mock:${bindingId}`) throw new BotError("CONFLICT", "模拟来源受众不一致")
  return {
    bindingId,
    grantVersion: Number(v.grantVersion),
    conversationId: botIdentifier(v.conversationId),
    audienceKey: v.audienceKey,
    eventId: botIdentifier(v.eventId),
    messageId: botIdentifier(v.messageId),
    senderId: botIdentifier(v.senderId)
  }
}
