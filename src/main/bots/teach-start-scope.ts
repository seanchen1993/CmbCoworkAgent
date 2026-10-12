import type { BotTeachStartInput } from "../../shared/bot-teach"
import { BotDomainError } from "../../shared/bot-types"
import * as v from "./validation"

/** Canonicalize only original target identities, never screenshots or viewer-relative authority. */
export function parseBotTeachStart(input: BotTeachStartInput): BotTeachStartInput {
  v.record(input)
  const target = v.record(input.target)
  if (target.taskRunId !== undefined)
    throw new BotDomainError("teach_scope", "请在 Bot 的工作电脑中示范，不能录制子任务电脑")
  const backend =
    v.optionalChoice(target.backend, "示范电脑类型", ["browser", "windows-native"]) ?? undefined
  const control = v.optionalChoice(target.control, "浏览器控制状态", ["bot", "human", "handoff"])
  if (!control || control === "handoff")
    throw new BotDomainError("teach_scope", "请等待录制目标就绪")
  if (target.botId !== input.botId) throw new BotDomainError("teach_scope", "录制目标不属于此 Bot")
  if (input.skillScope !== undefined && input.skillScope !== "user")
    throw new BotDomainError("teach_scope", "技能保存范围无效")
  return {
    ...(input.skillScope === undefined ? {} : { skillScope: "user" as const }),
    expectedDataEpoch:
      input.expectedDataEpoch === undefined
        ? "initial"
        : v.text(input.expectedDataEpoch, "工作区版本", 160),
    botId: v.identifier(input.botId),
    conversationId: v.identifier(input.conversationId),
    ...(input.conversationRevision === undefined
      ? {}
      : {
          conversationRevision: v.integer(input.conversationRevision, "对话版本", 1)
        }),
    ...(input.threadRootId === undefined ? {} : { threadRootId: v.identifier(input.threadRootId) }),
    nonce: v.identifier(input.nonce),
    target: {
      ...(backend === undefined ? {} : { backend }),
      botId: v.identifier(target.botId),
      generation: v.identifier(target.generation),
      controlEpoch: v.integer(target.controlEpoch, "控制版本"),
      control,
      viewId: v.identifier(target.viewId)
    }
  }
}
