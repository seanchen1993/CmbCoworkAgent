import type { ImTargetSnapshot } from "./conversation-state"
import { IM_DEFAULT_CHAT_LABEL } from "../../../shared/im-display"

const MAX_CONTEXT_LABEL_CHARACTERS = 120

function readableLabel(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, " ").trim() || fallback
  const points = Array.from(normalized)
  return points.length <= MAX_CONTEXT_LABEL_CHARACTERS
    ? normalized
    : `${points.slice(0, MAX_CONTEXT_LABEL_CHARACTERS - 1).join("")}…`
}

/**
 * Marks a reply whose target is not the currently bound one. Exported so
 * callers can react to it without re-deriving the comparison or matching on
 * prose.
 *
 * States the condition rather than a history: the only test is "this reply's
 * target is not the bound target", and nothing checks that anyone switched. A
 * scheduled inbox reminder finishing while its owner is bound elsewhere hits
 * this too, and the earlier wording told them about a switch they never made.
 */
export const SWITCHED_TARGET_MARK = "（非当前绑定会话）"

/** No numbered selections here: their context can expire before a push is read. */
export function buildImReplyContinuationHint(input: {
  switched: boolean
  kind: ImTargetSnapshot["kind"]
  threadTitle?: string | null
  requiresSelection?: boolean
  sessionCode?: string
}): string | undefined {
  if (!input.switched) return undefined
  const title = input.threadTitle?.replace(/\s+/gu, " ").trim()
  const command = input.sessionCode
    ? `/切换 @${input.sessionCode}`
    : input.kind === "inbox"
      ? "/默认"
      : input.kind === "thread" &&
          title &&
          Array.from(title).length <= MAX_CONTEXT_LABEL_CHARACTERS &&
          !input.requiresSelection
        ? `/切换 ${title}`
        : "/会话"
  return [
    "直接回复会发到当前绑定的会话，不会自动切换到此会话。",
    command === "/会话"
      ? "要继续此会话，请发送 /会话，选择对应会话并点击“切换”。"
      : `要继续此会话，请先单独发送：${command}`,
    "切换成功后再发送你的问题；/当前 可确认消息接收会话。"
  ].join("\n")
}

function withSwitchNotice(prefix: string, switched: boolean, continuationHint?: string): string {
  const header = `${prefix}${switched ? SWITCHED_TARGET_MARK : ""}`
  if (!switched || !continuationHint) return header
  return [header, "系统提示：", continuationHint, "", "──────────", "以下是该会话的回复："].join(
    "\n"
  )
}

export function imInboxReplyPrefix(switched = false, continuationHint?: string): string {
  return withSwitchNotice(`【${IM_DEFAULT_CHAT_LABEL}】`, switched, continuationHint)
}

export function imThreadReplyPrefix(
  threadTitle: string | null | undefined,
  switched = false,
  continuationHint?: string
): string {
  return withSwitchNotice(
    `【会话：${readableLabel(threadTitle, "未命名会话")}】`,
    switched,
    continuationHint
  )
}

export function imFeatureReplyPrefix(input: {
  projectName?: string | null
  projectId: string
  featureTitle?: string | null
  featureSlug: string
  threadTitle?: string | null
  switched?: boolean
  continuationHint?: string
}): string {
  const feature = `${readableLabel(input.projectName, input.projectId)} / ${readableLabel(
    input.featureTitle,
    input.featureSlug
  )}`
  const thread = input.threadTitle?.trim()
    ? `｜会话：${readableLabel(input.threadTitle, "未命名会话")}`
    : ""
  return withSwitchNotice(
    `【Feature：${feature}${thread}】`,
    input.switched === true,
    input.continuationHint
  )
}

export function imProjectModeReplyPrefix(input: {
  projectName: string
  featureName: string
  nodeName?: string | null
  nodeStatus?: string | null
  switched?: boolean
  continuationHint?: string
}): string {
  return [
    withSwitchNotice("【项目模式会话返回】", input.switched === true),
    `项目：【${readableLabel(input.projectName, "未知")}】`,
    `特性：【${readableLabel(input.featureName, "未知")}】`,
    `当前阶段：${readableLabel(input.nodeName, "未知")}`,
    `阶段状态：${readableLabel(input.nodeStatus, "未知")}`,
    ...(input.switched && input.continuationHint ? ["", "系统提示：", input.continuationHint] : []),
    "",
    "──────────",
    "以下是该会话的回复："
  ].join("\n")
}

export function imTargetReplyPrefix(
  target: ImTargetSnapshot,
  options: { switched?: boolean; threadTitle?: string | null; continuationHint?: string } = {}
): string {
  const switched = options.switched === true
  if (target.kind === "inbox") return imInboxReplyPrefix(switched, options.continuationHint)
  if (target.kind === "thread") {
    return imThreadReplyPrefix(
      options.threadTitle ?? target.title,
      switched,
      options.continuationHint
    )
  }
  return imFeatureReplyPrefix({
    projectName: target.projectName,
    projectId: target.projectId,
    featureTitle: target.featureTitle,
    featureSlug: target.featureSlug,
    threadTitle: options.threadTitle,
    switched,
    continuationHint: options.continuationHint
  })
}
