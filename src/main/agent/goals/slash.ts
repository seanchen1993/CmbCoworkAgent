import { isGoalClearAlias, splitGoalTransportPayload } from "../../../shared/goal-slash"
import { parseSkillUseBlock } from "../skill-lifecycle/marker"
import { MAX_GOAL_TEXT_CHARS } from "./goal-manager"
import type { GoalContext } from "./types"

export type GoalSlashCommand =
  | { type: "none" }
  | { type: "invalid"; reason: string }
  | { type: "set"; text: string; displayText: string; context?: GoalContext }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }

const MAX_TRANSPORT_CONTEXT_CHARS = 260
const TRANSPORT_REQUIRES_GOAL_TEXT_REASON =
  "请写明 goal 目标/完成条件，例如：/goal 根据附件检查实现是否符合规格。附件和显式技能只作为本轮上下文，不会单独成为长期目标。"
const CONTROL_COMMAND_WITH_TRANSPORT_REASON =
  "附件和显式技能不会用于 /goal 控制命令。请先移除附件/技能，或改成 /goal <目标/完成条件>。"

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

function extractAttachmentNames(payload: string): string[] {
  return Array.from(payload.matchAll(/<attachment\b[^>]*\bfilename="([^"]+)"/gi))
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item))
}

function extractSkillName(payload: string): string | null {
  const match = payload.match(/<CMBDEVCLAW-SKILL-USE-V1>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i)
  return match?.[1]?.trim() || null
}

function buildTransportContextSummary(payload: string): string | null {
  const attachmentNames = extractAttachmentNames(payload)
  const skillName = extractSkillName(payload)
  const parts: string[] = []
  if (attachmentNames.length > 0) {
    parts.push(`附件：${attachmentNames.join("、")}`)
  }
  if (skillName) {
    parts.push(`显式技能：${skillName}`)
  }
  return parts.length > 0 ? truncate(parts.join("；"), MAX_TRANSPORT_CONTEXT_CHARS) : null
}

function buildGoalContext(payload: string): GoalContext | undefined {
  const parsed = parseSkillUseBlock(payload)
  if (!parsed) return undefined
  return {
    explicitSkill: {
      name: parsed.skillName,
      path: parsed.skillPath
    }
  }
}

function appendTransportContextSummary(goalText: string, payload: string): string {
  const context = buildTransportContextSummary(payload)
  if (!context) return goalText
  const summary = `启动上下文摘要：${context}`
  const withSummary = `${goalText}\n${summary}`
  return withSummary.length <= MAX_GOAL_TEXT_CHARS ? withSummary : goalText
}

export function extractGoalTransportPayload(input: string): string {
  return splitGoalTransportPayload(input).payload
}

export function parseGoalSlashCommand(input: string): GoalSlashCommand {
  const { commandText: trimmed, payload } = splitGoalTransportPayload(input)
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return { type: "none" }

  const afterCommand = trimmed.slice("/goal".length)

  const arg = afterCommand.trim()
  const lower = arg.toLowerCase()
  const context = payload ? buildGoalContext(payload) : undefined
  if (!arg) {
    return payload
      ? { type: "invalid", reason: TRANSPORT_REQUIRES_GOAL_TEXT_REASON }
      : { type: "status" }
  }
  if (
    payload &&
    (lower === "status" || lower === "pause" || lower === "resume" || isGoalClearAlias(lower))
  ) {
    return { type: "invalid", reason: CONTROL_COMMAND_WITH_TRANSPORT_REASON }
  }
  if (lower === "status") return { type: "status" }

  if (lower === "pause") return { type: "pause" }
  if (lower === "resume") return { type: "resume" }
  if (isGoalClearAlias(lower)) return { type: "clear" }

  return {
    type: "set",
    text: payload ? appendTransportContextSummary(arg, payload) : arg,
    displayText: arg,
    context
  }
}
