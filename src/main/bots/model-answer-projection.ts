import type { BaseMessage } from "@langchain/core/messages"
import {
  collectLengthContinuationMessages,
  extractVisibleText,
  type TurnCompletionGateReport
} from "../agent/turn-completion-integrity"
import { extractVisibleReasoning } from "../../shared/model-reasoning"
import { BotDomainError } from "../../shared/bot-types"

const TAG_OPEN = "<think>",
  TAG_CLOSE = "</think>"
export interface BotModelAnswerPolicy {
  providerCharacters: number
  answerCharacters: number
  errorPrefix: string
  label: string
  reasoningLabel?: string
  mode?: "leading" | "strict"
}
// Match the existing Bot stream and persisted final-result bounds.
const TASK_ANSWER_POLICY: BotModelAnswerPolicy = {
  providerCharacters: 256_000,
  answerCharacters: 128_000,
  errorPrefix: "model_answer",
  label: "模型回复"
}

/** Reuses the greeting's incremental projection. Ordinary answers interpret
 * legacy tags only before the body begins; XML/code examples and trailing tag
 * prefixes inside the body remain literal. Provider messages/checkpoints are
 * never rewritten. Strict mode preserves the existing greeting contract. */
export class BotModelAnswerProjection {
  constructor(private readonly policy: BotModelAnswerPolicy = TASK_ANSWER_POLICY) {}
  private pending = ""
  private thinking = false
  private bodyStarted = false
  private typedLeadingBlock = false
  private reasoningSeparator = false
  private received = 0
  private answer = ""
  get text() {
    return this.answer
  }
  private get leading() {
    return this.policy.mode !== "strict"
  }

  push(content: unknown): boolean {
    this.preserveStructurallySeparatedBody(content)
    return this.pushText(extractVisibleText(content))
  }

  /** Cmb's configured adapter exposes provider-explicit reasoning metadata.
   * If it disagrees with a leading tag in the body, that tag is a literal
   * example, not the adapter's wrapper. Legacy inline-only providers still use
   * the bounded leading-prefix fallback; no global text replacement occurs. */
  pushMessage(message: {
    content: unknown
    additional_kwargs?: unknown
    lc_kwargs?: unknown
  }): boolean {
    this.preserveStructurallySeparatedBody(message.content)
    const text = extractVisibleText(message.content)
    if (this.leading && !this.thinking && !this.bodyStarted) {
      const probe = (this.pending + text).trimStart()
      const reasoning = extractVisibleReasoning(message, this.policy.providerCharacters)
        .replace(/^\s*<think>/i, "")
        .replace(/<\/think>\s*$/i, "")
      if (reasoning && probe.slice(0, TAG_OPEN.length).toLowerCase() === TAG_OPEN) {
        const inside = probe.slice(TAG_OPEN.length)
        const close = inside.toLowerCase().indexOf(TAG_CLOSE)
        const fragment = close < 0 ? inside : inside.slice(0, close)
        if (!reasoning.startsWith(fragment) && !fragment.startsWith(reasoning)) {
          this.beginBody()
        } else this.typedLeadingBlock = true
      }
    }
    return this.pushText(text)
  }

  private preserveStructurallySeparatedBody(content: unknown): void {
    if (
      this.leading &&
      !this.thinking &&
      !this.bodyStarted &&
      Array.isArray(content) &&
      content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          ["thinking", "reasoning", "redacted_thinking"].includes(block.type)
      )
    )
      this.beginBody()
  }

  private beginBody(): void {
    this.bodyStarted = true
    this.append(this.pending)
    this.pending = ""
  }

  private pushText(text: string): boolean {
    this.received += text.length
    if (this.received > this.policy.providerCharacters)
      throw new BotDomainError(
        `${this.policy.errorPrefix}_output_limit`,
        `${this.policy.label}超出生成上限`
      )
    const before = this.answer.length
    if (this.leading && this.bodyStarted) {
      this.append(text)
      return this.answer.length !== before
    }
    this.pending += text
    for (;;) {
      const lower = this.pending.toLowerCase()
      const open = lower.indexOf(TAG_OPEN),
        close = lower.indexOf(TAG_CLOSE)
      const at = open < 0 ? close : close < 0 ? open : Math.min(open, close)
      if (at >= 0) {
        const tag = at === open ? TAG_OPEN : TAG_CLOSE
        // Once ordinary body text starts, all later tag spellings are data.
        if (
          this.leading &&
          !this.thinking &&
          (this.pending.slice(0, at).trim() || tag === TAG_CLOSE)
        ) {
          this.beginBody()
          break
        }
        if ((tag === TAG_OPEN) === this.thinking)
          throw new BotDomainError(
            `${this.policy.errorPrefix}_reasoning_invalid`,
            `${this.policy.reasoningLabel ?? this.policy.label}的思考分段无效`
          )
        if (!this.thinking) this.append(this.pending.slice(0, at))
        this.thinking = tag === TAG_OPEN
        if (this.leading && !this.thinking) this.reasoningSeparator = true
        this.pending = this.pending.slice(at + tag.length)
        if (this.leading && !this.thinking && this.typedLeadingBlock) {
          this.beginBody()
          break
        }
        continue
      }
      let keep = 0
      for (const tag of [TAG_OPEN, TAG_CLOSE])
        for (let length = 1; length < tag.length; length++)
          if (lower.endsWith(tag.slice(0, length))) keep = Math.max(keep, length)
      const ready = this.pending.slice(0, this.pending.length - keep)
      if (this.leading && !this.thinking && ready.trim()) {
        this.beginBody()
        break
      }
      if (!this.thinking) this.append(ready)
      this.pending = keep ? this.pending.slice(-keep) : ""
      break
    }
    return this.answer.length !== before
  }

  finish(): string {
    if (this.thinking || (!this.leading && this.pending))
      throw new BotDomainError(
        `${this.policy.errorPrefix}_reasoning_incomplete`,
        `${this.policy.reasoningLabel ?? this.policy.label}的思考分段尚未完成`
      )
    // A bare '<' or '<thi' never formed a reasoning opening tag. At EOF it
    // remains valid literal body text rather than becoming a false failure.
    if (this.pending) this.beginBody()
    return this.answer
  }

  private append(text: string): void {
    // MiniMax's inline reasoning wrapper ends with a line separator. Once
    // that wrapper is removed, its separator is not part of the delivered
    // answer. Keep spaces/indentation and all ordinary/structured body bytes;
    // do not trim each delta or a length continuation's boundary.
    if (this.reasoningSeparator) {
      text = text.replace(/^[\r\n]+/, "")
      if (text) this.reasoningSeparator = false
    }
    if (this.answer.length + text.length > this.policy.answerCharacters)
      throw new BotDomainError(
        `${this.policy.errorPrefix}_output_limit`,
        `${this.policy.label}正文超出上限`
      )
    this.answer += text
  }
}

/** Project each provider turn independently, then join only durable length
 * continuations. Do not insert separators: the cut may be inside a word,
 * number, Markdown row or code fence. */
export function projectBotFinalAnswer(
  messages: readonly BaseMessage[],
  report: TurnCompletionGateReport | null | undefined,
  runId: string
): string {
  let content = ""
  for (const message of collectLengthContinuationMessages(messages, report, runId, runId)) {
    const projection = new BotModelAnswerProjection()
    projection.pushMessage(message)
    const fragment = projection.finish()
    if (content.length + fragment.length > TASK_ANSWER_POLICY.answerCharacters)
      throw new BotDomainError("model_answer_output_limit", "模型回复正文超出上限")
    content += fragment
  }
  return content
}
