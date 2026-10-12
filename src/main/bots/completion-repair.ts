import { createHash } from "node:crypto"
import { HumanMessage } from "@langchain/core/messages"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"

export const BOT_MAX_COMPLETION_REPAIRS = 3
const PREFIX = "completion-repair:"
type Repair =
  | { kind: "teach"; recordingId: string; invocation: string }
  | { kind: "delivery"; reason: string; invocation: string }
  | { kind: "group"; invocation: string }

/** Continue the existing graph, with the existing writer/lease/steering fence.
 * Receipts bound the total across restarts; replay adds the same graph message.
 * No new execution capability, external retry or fabricated success is granted. */
export function botCompletionRepair(store: BotStore, lease: BotRunLease, repair: Repair) {
  const identity = createHash("sha256").update(JSON.stringify(repair)).digest("hex")
  const attempt = store.toolOnce(lease, `${PREFIX}${identity}`, repair, () => {
    const prefix = `tool:${lease.runId}:${PREFIX}`
    const count = Number(
      store.db.exec("SELECT count(*) FROM bot_receipts WHERE nonce>=? AND nonce<?", [
        prefix,
        `${prefix}\uffff`
      ])[0]?.values[0]?.[0] ?? 0
    )
    if (count >= BOT_MAX_COMPLETION_REPAIRS)
      throw new BotDomainError(
        "completion_repair_limit",
        repair.kind === "teach"
          ? "示范学习仍未保存技能，已保留录制和学习记录，请核对模型响应后重新学习。"
          : repair.kind === "group"
            ? "群聊回复尚未发布，已保留执行记录，请重试或接手处理。"
            : "交付补正仍未完成，已保留文件和核验记录，请核对后继续。"
      )
    return count + 1
  })
  const task =
    repair.kind === "teach"
      ? `The assigned recording ${repair.recordingId} has no saved skill. An acknowledgement does not complete learning. Use read_demonstration on this exact recording, starting at offset=0 if not yet read, and follow its returned nextOffset until null. Read receipts from this run remain valid. Then call save_taught_skill with the observed workflow and concrete outcome checks. Never invent visual observations or mark untested behavior verified. Do not execute demonstrated actions. If a real limitation prevents learning, explain it or ask the user rather than claiming a skill was saved.`
      : repair.kind === "group"
        ? 'The room has NOT received a reply from this turn. Plain assistant output is private scratch space, not a delivered group message. Use send_group_message to publish the result relevant to the room, or call it with exactly "(pass)" if you have nothing new to add. Never publish private one-on-one context, memory or internal reasoning. Reuse completed work; do not repeat completed external actions. Then finish with a short assistant message.'
        : `Delivery is incomplete: ${repair.reason}\nCheck every required output against the current accepted user instructions and original sources, including files published before the latest instructions. Reuse valid completed work; call deliver_file for the actual corrected or unchanged originals that need current verification. Do not bypass verification, fabricate results, or repeat completed external actions.`
  return new HumanMessage({
    id: `${repair.kind === "group" ? "bot-group-completion-repair" : "bot-completion-repair"}:${lease.runId}:${identity}`,
    content: `[Task completion check ${attempt}/${BOT_MAX_COMPLETION_REPAIRS}] Tool permissions, approval boundaries and model budgets remain unchanged.\n${task}`
  })
}
