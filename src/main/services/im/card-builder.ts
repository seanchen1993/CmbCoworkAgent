import type { ImCardInteractionKind } from "../../../shared/im-gateway-contract"

/**
 * Builds Zhaohu custom-card component arrays.
 *
 * Everything here is pure: it turns an approval or a question set into the
 * platform's component JSON and nothing else. The gateway forwards the array
 * verbatim, so a new component shape never needs a gateway release — and a
 * mistake here can only produce a card that fails to render, never a decision
 * that bypasses a gate.
 *
 * Card text is deliberately duplicated from the text notification rather than
 * replacing it. The card can fail to send (platform error, an old client that
 * does not know a component); the text and its short code must still stand on
 * their own, because an approval waits forever and has no other way out.
 */

/** 状态组件 style: 1-blue 2-red 3-green 4-orange 5-black */
const STATUS_STYLE = { blue: 1, red: 2, green: 3, orange: 4, black: 5 } as const

/** 按钮 action: 1-跳转 2-回传 3-卡片交互 */
const BUTTON_ACTION_FEEDBACK = 2

/** exclusionOperate style: 1-有帮助无帮助 2-接受拒绝 */
const EXCLUSION_STYLE_ACCEPT_REJECT = 2

/** CommonOperate status: 0-普通 1-选中 2-不可点击 */
const BUTTON_STATUS_NORMAL = 0
const BUTTON_STATUS_SELECTED = 1
const BUTTON_STATUS_DISABLED = 2

export type CardComponent = Record<string, unknown>

/**
 * 卡片交互链接规则:
 * zhclient:///?actionCode=XXX&actionParams=UrlEncode(Base64(params))
 * actionCode 9 是「发送回执」，也是 interactive 提交按钮唯一支持的取值。
 */
export function cardReceiptActionLink(tag: string): { url: string } {
  const params = Buffer.from(JSON.stringify({ tag }), "utf8").toString("base64")
  return { url: `zhclient:///?actionCode=9&actionParams=${encodeURIComponent(params)}` }
}

function titleComponent(content: string): CardComponent {
  return { type: "title", content }
}

function statusComponent(content: string, style: number): CardComponent {
  return { type: "status", content, style }
}

/** 内容组件的每行最多 100 行，超出由客户端截断。 */
function contentComponent(lines: ReadonlyArray<string>, model = 0): CardComponent {
  return {
    type: "content",
    model,
    list: lines.map((line) => ({ content: line }))
  }
}

/** InnerKV.title 最多显示 9 个字符，超出客户端截断。 */
function kvComponent(pairs: ReadonlyArray<{ title: string; value: string }>): CardComponent {
  return {
    type: "kv",
    list: pairs.map((pair) => ({ title: pair.title, value: [pair.value] }))
  }
}

function separatorComponent(): CardComponent {
  return { type: "separate" }
}

export interface ApprovalCardInput {
  /** Where this gate came from — the reader must never have to guess. */
  targetLabel: string
  operation: string
  detail: string
  tag: string
  allowedDecisions: ReadonlyArray<"approve" | "reject">
  fallbackCommands: string
}

/**
 * The card carries the same information as the text notice, including which
 * session is asking. A card fired by a scheduler reminder can reach someone
 * bound to a different session entirely, and approving a file write without
 * knowing which task asked is exactly the failure the text prefix prevents.
 */
export function buildApprovalCard(input: ApprovalCardInput): CardComponent[] {
  const buttons: CardComponent[] = []
  if (input.allowedDecisions.includes("approve")) {
    buttons.push({
      content: "一次性批准",
      action: BUTTON_ACTION_FEEDBACK,
      tag: `${input.tag}:approve`,
      style: 1,
      status: BUTTON_STATUS_NORMAL,
      disable: 0
    })
  }
  if (input.allowedDecisions.includes("reject")) {
    buttons.push({
      content: "拒绝",
      action: BUTTON_ACTION_FEEDBACK,
      tag: `${input.tag}:reject`,
      style: 2,
      status: BUTTON_STATUS_NORMAL,
      disable: 0
    })
  }

  const components: CardComponent[] = [
    titleComponent("需要批准"),
    statusComponent("待处理", STATUS_STYLE.orange),
    kvComponent([
      { title: "会话", value: input.targetLabel },
      { title: "操作", value: input.operation }
    ]),
    contentComponent(input.detail.split("\n").filter((line) => line.length > 0))
  ]
  if (buttons.length > 0) {
    components.push({
      type: "exclusionOperate",
      style: EXCLUSION_STYLE_ACCEPT_REJECT,
      list: buttons
    })
  }
  components.push(separatorComponent())
  components.push(contentComponent([`按钮失效时可回复：${input.fallbackCommands}`], 1))
  return components
}

export interface ResolvedCardInput {
  targetLabel: string
  operation: string
  /** 已批准 / 已拒绝 / 已在桌面处理 / 已取消 */
  outcome: string
  outcomeStyle: "approved" | "rejected" | "neutral"
  detail?: string
}

/**
 * The terminal card that replaces a live one.
 *
 * update-custom-card accepts only the static component set — `interactive` is
 * not in its whitelist — so a resolved form cannot keep its inputs. Rebuilding
 * as a static card is the only supported path, not a workaround.
 */
export function buildResolvedCard(input: ResolvedCardInput): CardComponent[] {
  const style =
    input.outcomeStyle === "approved"
      ? STATUS_STYLE.green
      : input.outcomeStyle === "rejected"
        ? STATUS_STYLE.red
        : STATUS_STYLE.black
  const components: CardComponent[] = [
    titleComponent("需要批准"),
    statusComponent(input.outcome, style),
    kvComponent([
      { title: "会话", value: input.targetLabel },
      { title: "操作", value: input.operation }
    ])
  ]
  if (input.detail) {
    components.push(contentComponent(input.detail.split("\n").filter((line) => line.length > 0)))
  }
  return components
}

export interface QuestionCardQuestion {
  /** Stable within one card; becomes the control's feedbackKey. */
  key: string
  header: string
  question: string
  options: ReadonlyArray<{ label: string; description?: string }>
  /** True once answered by short code — rendered read-only, never resubmitted. */
  answered?: boolean
  answeredLabel?: string
}

export interface QuestionCardInput {
  targetLabel: string
  questions: ReadonlyArray<QuestionCardQuestion>
  tag: string
  fallbackCommand: string
}

/** listSelector selectModel: 1-自定义选项 2-会话人员 3-搜索 */
const LIST_SELECT_CUSTOM_OPTIONS = 1

/**
 * The free-text control mirrors the text channel's `其他 <回答>` escape: every
 * question there accepts one, so a form without it would be strictly weaker
 * than the short code it is meant to replace.
 */
export const QUESTION_OTHER_SUFFIX = "__other"

export function buildQuestionCard(input: QuestionCardInput): CardComponent[] {
  const unanswered = input.questions.filter((question) => !question.answered)
  const components: CardComponent[] = [
    titleComponent("需要你的选择"),
    statusComponent("待回答", STATUS_STYLE.orange),
    kvComponent([{ title: "会话", value: input.targetLabel }])
  ]

  const answered = input.questions.filter((question) => question.answered)
  if (answered.length > 0) {
    components.push(
      kvComponent(
        answered.map((question) => ({
          title: question.header,
          value: question.answeredLabel ?? "已回答"
        }))
      )
    )
  }

  const controls: CardComponent[] = []
  for (const question of unanswered) {
    controls.push({
      subType: "listSelector",
      title: question.header,
      promptText: question.question,
      feedbackKey: question.key,
      required: false,
      selectModel: LIST_SELECT_CUSTOM_OPTIONS,
      isMultiple: false,
      optionArray: question.options.map((option, index) => ({
        text: option.description ? `${option.label}（${option.description}）` : option.label,
        value: String(index)
      }))
    })
    controls.push({
      subType: "inputBox",
      title: `${question.header} · 其他`,
      promptText: "以上选项都不合适时填写",
      feedbackKey: `${question.key}${QUESTION_OTHER_SUFFIX}`,
      required: false
    })
  }

  if (controls.length > 0) {
    components.push({
      type: "interactive",
      inputControlArray: controls,
      submitStatus: 0,
      submitButton: {
        submitText: "提交",
        actionLink: cardReceiptActionLink(input.tag)
      }
    })
  }

  components.push(separatorComponent())
  components.push(contentComponent([`也可以回复：${input.fallbackCommand}`], 1))
  return components
}

export interface AnsweredCardInput {
  targetLabel: string
  answers: ReadonlyArray<{ header: string; answer: string }>
  outcome: string
}

export function buildAnsweredCard(input: AnsweredCardInput): CardComponent[] {
  const components: CardComponent[] = [
    titleComponent("需要你的选择"),
    statusComponent(input.outcome, STATUS_STYLE.green),
    kvComponent([{ title: "会话", value: input.targetLabel }])
  ]
  if (input.answers.length > 0) {
    components.push(
      kvComponent(input.answers.map((entry) => ({ title: entry.header, value: entry.answer })))
    )
  }
  return components
}

/** Marks a card whose request is gone — a click from deep in the history. */
export function buildExpiredCard(
  kind: ImCardInteractionKind,
  targetLabel: string
): CardComponent[] {
  return [
    titleComponent(kind === "approval" ? "需要批准" : "需要你的选择"),
    statusComponent("已失效", STATUS_STYLE.black),
    kvComponent([{ title: "会话", value: targetLabel }]),
    contentComponent(["该请求已经结束，这张卡片不再接受操作。"], 1)
  ]
}

export { BUTTON_STATUS_DISABLED, BUTTON_STATUS_SELECTED }
