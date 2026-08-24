import type { ImTargetSnapshot } from "./conversation-state"

const MAX_CONTEXT_LABEL_CHARACTERS = 120

function readableLabel(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, " ").trim() || fallback
  const points = Array.from(normalized)
  return points.length <= MAX_CONTEXT_LABEL_CHARACTERS
    ? normalized
    : `${points.slice(0, MAX_CONTEXT_LABEL_CHARACTERS - 1).join("")}…`
}

function withSwitchNotice(prefix: string, switched: boolean): string {
  return `${prefix}${switched ? "（切换前任务）" : ""}`
}

export function imInboxReplyPrefix(switched = false): string {
  return withSwitchNotice("【远程收件箱】", switched)
}

export function imThreadReplyPrefix(
  threadTitle: string | null | undefined,
  switched = false
): string {
  return withSwitchNotice(`【会话：${readableLabel(threadTitle, "未命名会话")}】`, switched)
}

export function imFeatureReplyPrefix(input: {
  projectName?: string | null
  projectId: string
  featureTitle?: string | null
  featureSlug: string
  threadTitle?: string | null
  switched?: boolean
}): string {
  const feature = `${readableLabel(input.projectName, input.projectId)} / ${readableLabel(
    input.featureTitle,
    input.featureSlug
  )}`
  const thread = input.threadTitle?.trim()
    ? `｜会话：${readableLabel(input.threadTitle, "未命名会话")}`
    : ""
  return withSwitchNotice(`【Feature：${feature}${thread}】`, input.switched === true)
}

export function imTargetReplyPrefix(
  target: ImTargetSnapshot,
  options: { switched?: boolean; threadTitle?: string | null } = {}
): string {
  const switched = options.switched === true
  if (target.kind === "inbox") return imInboxReplyPrefix(switched)
  if (target.kind === "thread") return imThreadReplyPrefix(target.title, switched)
  return imFeatureReplyPrefix({
    projectName: target.projectName,
    projectId: target.projectId,
    featureTitle: target.featureTitle,
    featureSlug: target.featureSlug,
    threadTitle: options.threadTitle,
    switched
  })
}
