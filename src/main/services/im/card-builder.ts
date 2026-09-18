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

/**
 * InnerKV.title 最多显示 9 个字符，超出客户端截断。
 *
 * `value` is a list of InnerContent objects, never a list of bare strings. The
 * field is typed only as `List` in the spec, so the shape has to be read off
 * the worked example — and getting it wrong is not a degraded row, it is a
 * blank card: the client abandons the whole component array and renders an
 * empty bubble, while the send API still answers code=0 with a message id.
 * Every card here carries a kv, so that silently cost us all five of them.
 */
function kvComponent(pairs: ReadonlyArray<{ title: string; value: string }>): CardComponent {
  return {
    type: "kv",
    list: pairs.map((pair) => ({
      title: kvTitle(pair.title),
      value: [{ content: pair.value }]
    }))
  }
}

/**
 * The client renders key and value flush against each other, so the separator
 * has to live in the key — 「已答题要」 is what a bare key looks like. The spec's
 * own example writes `"title": "时间："`, colon included, which is the same
 * convention arrived at from the other direction.
 *
 * Applied here rather than at the four call sites so a new row cannot forget
 * it. Headers reach this from model output, so a key that already ends in a
 * colon keeps the one it has instead of collecting a second.
 */
function kvTitle(title: string): string {
  return /[：:]$/u.test(title) ? title : `${title}：`
}

/**
 * The kv key naming where a card came from.
 *
 * Not 「会话」: the value is a reply prefix, and those name their own kind —
 * 「会话：重构登录」, 「收件箱」, 「特性：xxx」. Pairing them with 「会话」 read as
 * 「会话 会话：重构登录」 for threads and was simply wrong for the other two.
 * 「来源」 is the one key that stays true for every prefix shape.
 */
const KV_SOURCE_TITLE = "来源"

export interface ApprovalCardInput {
  /** Where this gate came from — the reader must never have to guess. */
  targetLabel: string
  operation: string
  detail: string
  tag: string
  allowedDecisions: ReadonlyArray<"approve" | "reject">
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
      { title: KV_SOURCE_TITLE, value: input.targetLabel },
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
      { title: KV_SOURCE_TITLE, value: input.targetLabel },
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
}

/** listSelector selectModel: 1-自定义选项 2-会话人员 3-搜索 */
const LIST_SELECT_CUSTOM_OPTIONS = 1

/**
 * multiSubmit: 0-单次（默认） 1-不限次数。
 *
 * Unlimited on purpose. The desktop refuses a submit for reasons the client
 * cannot see — a question left blank, the request already answered from the
 * desktop, remote answering switched off — and it says so in a message rather
 * than by replacing the card. Under the default the form is spent by that
 * first attempt, so the one reader who most needs it, the one who missed a
 * question, would be left with a dead form and only the short code.
 *
 * Safe once a submit succeeds, too: the session is gone by then, so a second
 * press is told the request is no longer waiting, and the form has already
 * been replaced by its answered card.
 *
 * 备注写的是「PC客户端支持」。A mobile client that ignores this keeps the form
 * single-use, which is what we have today — the short code stays printed under
 * every card either way.
 */
const MULTI_SUBMIT_UNLIMITED = 1

/**
 * The form's component id.
 *
 * `update-custom-card` does not whitelist `interactive`, so partUpdate is the
 * only way a live form can ever be changed in place, and it addresses
 * components by this id. An id cannot be added to a card that was already
 * sent, so it goes on every form now rather than on the first one that needs
 * it. Fixed rather than derived: ids need only be unique within one message,
 * and a question card carries exactly one form.
 */
const FORM_COMPONENT_ID = "interaction-form"

/**
 * The free-text box holds prose, so it opens taller than one line. Both sets
 * are sent because they are exclusive by platform: iOS reads only fixLine,
 * everything else only minLine/maxLine. Range is 1-10.
 */
const OTHER_INPUT_MIN_LINE = 2
const OTHER_INPUT_MAX_LINE = 6
const OTHER_INPUT_FIX_LINE = 3

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
    kvComponent([{ title: KV_SOURCE_TITLE, value: input.targetLabel }])
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
    // The client caps this box at 1000 characters, where the typed
    // `其他 <回答>` path accepts 4000. An answer longer than the box holds
    // belongs in a message, and the short code under the card still takes it.
    controls.push({
      subType: "inputBox",
      title: `${question.header} · 其他`,
      promptText: "以上选项都不合适时填写",
      feedbackKey: `${question.key}${QUESTION_OTHER_SUFFIX}`,
      required: false,
      minLine: OTHER_INPUT_MIN_LINE,
      maxLine: OTHER_INPUT_MAX_LINE,
      fixLine: OTHER_INPUT_FIX_LINE
    })
  }

  if (controls.length > 0) {
    components.push({
      type: "interactive",
      id: FORM_COMPONENT_ID,
      inputControlArray: controls,
      submitStatus: 0,
      multiSubmit: MULTI_SUBMIT_UNLIMITED,
      submitButton: {
        submitText: "提交",
        actionLink: cardReceiptActionLink(input.tag)
      }
    })
  }

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
    kvComponent([{ title: KV_SOURCE_TITLE, value: input.targetLabel }])
  ]
  if (input.answers.length > 0) {
    components.push(
      kvComponent(input.answers.map((entry) => ({ title: entry.header, value: entry.answer })))
    )
  }
  return components
}

/** The card title for each kind, so an expired card still names what it was. */
const CARD_TITLE: Record<ImCardInteractionKind, string> = {
  approval: "需要批准",
  user_input: "需要你的选择",
  target_bind: "切换会话"
}

/** Marks a card whose request is gone — a click from deep in the history. */
export function buildExpiredCard(
  kind: ImCardInteractionKind,
  targetLabel: string
): CardComponent[] {
  return [
    titleComponent(CARD_TITLE[kind] ?? CARD_TITLE.approval),
    statusComponent("已失效", STATUS_STYLE.black),
    kvComponent([{ title: KV_SOURCE_TITLE, value: targetLabel }]),
    contentComponent(["该请求已经结束，这张卡片不再接受操作。"], 1)
  ]
}

/**
 * 「跟随特性配置」 as an explicit option rather than an empty value.
 *
 * The typed path expresses it by omitting the word, but a form cannot show an
 * absence — and an option whose value is the empty string is the one shape a
 * receipt cannot distinguish from 「nothing selected」. So the default is a real
 * value the resolver maps back to omission.
 */
export const TARGET_BIND_MODE_INHERIT = "inherit"

/** feedbackKey for the two controls on a target-bind card. */
export const TARGET_BIND_TARGET_KEY = "target"
export const TARGET_BIND_MODE_KEY = "mode"

export interface TargetBindCardTarget {
  /** 1-based, and the same number the text list prints. */
  index: number
  label: string
  /** 「普通会话」「项目会话」「特性，可创建新会话」 */
  kindLabel: string
}

export interface TargetBindCardInput {
  /** What the conversation is bound to right now, for the reader's bearings. */
  currentLabel: string
  targets: ReadonlyArray<TargetBindCardTarget>
  /** Offered only when the list contains something that creates a session. */
  modeChoices: ReadonlyArray<{ label: string; value: string }>
  tag: string
}

/**
 * The numbered list from `/会话`, as a form.
 *
 * The option values are the same 1-based indexes the text list prints, so a
 * submit and a typed `/绑定 <编号>` reach the identical selection-context
 * lookup. Nothing here can name a target the list did not already authorize.
 */
export function buildTargetBindCard(input: TargetBindCardInput): CardComponent[] {
  const components: CardComponent[] = [
    titleComponent(CARD_TITLE.target_bind),
    statusComponent("待选择", STATUS_STYLE.orange),
    kvComponent([{ title: "当前", value: input.currentLabel }])
  ]

  const controls: CardComponent[] = [
    {
      subType: "listSelector",
      title: "切换到",
      promptText: "选择一个会话或特性",
      feedbackKey: TARGET_BIND_TARGET_KEY,
      required: true,
      selectModel: LIST_SELECT_CUSTOM_OPTIONS,
      isMultiple: false,
      optionArray: input.targets.map((target) => ({
        text: `${target.index}. ${target.label}（${target.kindLabel}）`,
        value: String(target.index)
      }))
    }
  ]

  // Only when something in the list can create a session. On an existing
  // session a mode word is refused by the typed path, and offering a control
  // whose every use is an error is worse than not offering it.
  if (input.modeChoices.length > 0) {
    controls.push({
      subType: "listSelector",
      title: "新建会话模式",
      promptText: "仅在特性下新建会话时生效，已有会话请忽略",
      feedbackKey: TARGET_BIND_MODE_KEY,
      required: false,
      selectModel: LIST_SELECT_CUSTOM_OPTIONS,
      isMultiple: false,
      optionArray: input.modeChoices.map((choice) => ({
        text: choice.label,
        value: choice.value
      }))
    })
  }

  components.push({
    type: "interactive",
    id: FORM_COMPONENT_ID,
    inputControlArray: controls,
    submitStatus: 0,
    multiSubmit: MULTI_SUBMIT_UNLIMITED,
    submitButton: {
      submitText: "切换",
      actionLink: cardReceiptActionLink(input.tag)
    }
  })

  return components
}

export interface BoundCardInput {
  /** Where the conversation ended up — the same label the text reply names. */
  targetLabel: string
  outcome: string
  detail?: string
}

/** The terminal card that replaces a live target list once something bound. */
export function buildBoundCard(input: BoundCardInput): CardComponent[] {
  const components: CardComponent[] = [
    titleComponent(CARD_TITLE.target_bind),
    statusComponent(input.outcome, STATUS_STYLE.green),
    kvComponent([{ title: "当前", value: input.targetLabel }])
  ]
  if (input.detail) {
    components.push(contentComponent([input.detail], 1))
  }
  return components
}

export { BUTTON_STATUS_DISABLED, BUTTON_STATUS_SELECTED }
