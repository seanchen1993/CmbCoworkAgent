import type { AgentTrace } from "../trace/types"
import { getSkillEvalAssistantText } from "./assistant-text"

export interface SkillEvalWindowTurn {
  traceId: string
  threadId: string
  startedAt: string
  endedAt: string
  usedSkills: string[]
  userMessage?: string
  assistantText?: string
  outcome?: string
}

interface StoredSkillEvalWindowTurn extends SkillEvalWindowTurn {
  skillContextNames: string[]
  awaitingSkillNames: string[]
  skillTaskIdsByRawName: Record<string, string>
}

export interface SkillEvalWindowContext {
  skillTaskId: string
  skillTaskTraceIndex: number
  contextTraceIds: string[]
  skillEvalTraceIds: string[]
  contextTraceCount: number
  skillEvalTraceCount: number
}

export interface SkillEvalWindowAppendResult {
  usedSkills: string[]
  contextSkillNames: string[]
  evalSkillNames: string[]
  inheritedContext: boolean
}

const MAX_WINDOW_TURNS = 12
const MAX_CONTEXT_AGE_MS = 30 * 60 * 1000
const MAX_THREADS_IN_WINDOW = 200
const TOPIC_SWITCH_PATTERN =
  /(换个话题|换一个|另一个问题|另外|不相关|先不|不用了|取消|算了|重新开始|新问题|顺便问|我想问|我现在想)/
const NEW_TASK_PATTERN =
  /(帮我|请帮我|查询|搜索|生成|写一个|改一下|解释一下|为什么|怎么|如何|能不能|可不可以)/
const ANSWER_MARKER_PATTERN =
  /(是的|不是|可以|不可以|对|不对|确认|按|用|选|选择|继续|上面|刚才|这个|那个|第[一二三四五六七八九十0-9]|补充|信息|范围|时间|日期|账号|路径|部门|版本|名称|数量|原因|需求|如下)/
const STRUCTURED_ANSWER_PATTERN = /(\d{2,}|[，,].+[，,]|[。.]|[:：].{4,})/
const USER_INPUT_REQUEST_PATTERN =
  /(请|麻烦|需要|还需要|缺少|补充|提供|确认|选择|输入|说明|告知|发我|上传|填一下|给我).{0,24}(补充|提供|确认|选择|输入|说明|告知|信息|材料|参数|范围|时间|日期|账号|路径|名称|版本|文件|截图|内容)|(.{0,16}(是否|哪一个|哪个|哪些|什么|多少|几|何时|什么时候).{0,40}[?？])/
const COMPLETION_PATTERN = /(已完成|处理完成|生成完成|执行完成|已经完成|结果如下|总结如下)/

const skillEvalWindows = new Map<string, StoredSkillEvalWindowTurn[]>()

function cloneTurn(turn: StoredSkillEvalWindowTurn): StoredSkillEvalWindowTurn {
  return {
    ...turn,
    usedSkills: [...turn.usedSkills],
    skillContextNames: [...turn.skillContextNames],
    awaitingSkillNames: [...turn.awaitingSkillNames],
    skillTaskIdsByRawName: { ...turn.skillTaskIdsByRawName }
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function skillTaskKey(threadId: string, rawSkillName: string, traceId: string): string {
  return [threadId, rawSkillName, traceId].map((part) => encodeURIComponent(part)).join(":")
}

function buildSkillTaskIds(
  threadId: string,
  traceId: string,
  skillContextNames: string[],
  inheritedSkillNames: string[],
  existing: StoredSkillEvalWindowTurn[]
): Record<string, string> {
  const inherited = new Set(inheritedSkillNames)
  const taskIds: Record<string, string> = {}
  const lastTurn = existing[existing.length - 1]
  for (const rawSkillName of uniqueStrings(skillContextNames)) {
    const inheritedTaskId = lastTurn?.skillTaskIdsByRawName?.[rawSkillName]
    taskIds[rawSkillName] =
      inherited.has(rawSkillName) && inheritedTaskId
        ? inheritedTaskId
        : skillTaskKey(threadId, rawSkillName, traceId)
  }
  return taskIds
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function timestampMs(value: string): number {
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

function isWithinContextAge(turn: StoredSkillEvalWindowTurn, referenceMs: number): boolean {
  if (referenceMs <= 0) return true
  const endedMs = timestampMs(turn.endedAt || turn.startedAt)
  if (endedMs <= 0) return true
  return Math.abs(referenceMs - endedMs) <= MAX_CONTEXT_AGE_MS
}

function asksUserForMoreInput(text: string | undefined, outcome: string | undefined): boolean {
  const normalized = normalizeText(text)
  if (!normalized || outcome === "error" || outcome === "cancelled") return false
  if (COMPLETION_PATTERN.test(normalized) && !USER_INPUT_REQUEST_PATTERN.test(normalized)) {
    return false
  }
  return USER_INPUT_REQUEST_PATTERN.test(normalized)
}

function isLikelyAnswerToPendingQuestion(userMessage: string | undefined): boolean {
  const normalized = normalizeText(userMessage)
  if (!normalized) return false
  if (TOPIC_SWITCH_PATTERN.test(normalized)) return false
  const hasAnswerMarker = ANSWER_MARKER_PATTERN.test(normalized)
  const asksQuestion = /[?？]/.test(normalized)
  if (asksQuestion && !hasAnswerMarker) return false
  if (NEW_TASK_PATTERN.test(normalized) && !hasAnswerMarker) return false
  if (hasAnswerMarker) return true
  if (
    (userMessage?.includes("\n") || STRUCTURED_ANSWER_PATTERN.test(normalized)) &&
    !asksQuestion
  ) {
    return true
  }
  return normalized.length <= 120 && !asksQuestion
}

function findPendingAnswerContext(
  turns: StoredSkillEvalWindowTurn[],
  referenceMs: number,
  userMessage: string | undefined
): string[] {
  if (!isLikelyAnswerToPendingQuestion(userMessage)) return []

  const lastTurn = turns[turns.length - 1]
  if (!lastTurn || !isWithinContextAge(lastTurn, referenceMs)) return []
  return lastTurn.awaitingSkillNames.length > 0 ? [...lastTurn.awaitingSkillNames] : []
}

function pruneWindow(
  turns: StoredSkillEvalWindowTurn[],
  referenceMs: number
): StoredSkillEvalWindowTurn[] {
  const recentTurns = turns.filter((turn) => isWithinContextAge(turn, referenceMs))
  return recentTurns.slice(-MAX_WINDOW_TURNS).map(cloneTurn)
}

function rememberThreadWindow(threadId: string, turns: StoredSkillEvalWindowTurn[]): void {
  if (skillEvalWindows.has(threadId)) skillEvalWindows.delete(threadId)
  skillEvalWindows.set(threadId, turns)

  while (skillEvalWindows.size > MAX_THREADS_IN_WINDOW) {
    const oldestKey = skillEvalWindows.keys().next().value
    if (!oldestKey) break
    skillEvalWindows.delete(oldestKey)
  }
}

export function getSkillEvalWindowAssistantText(trace: AgentTrace): string {
  return getSkillEvalAssistantText(trace)
}

export function appendSkillEvalWindowTurn(turn: SkillEvalWindowTurn): SkillEvalWindowAppendResult {
  const existing = skillEvalWindows.get(turn.threadId) ?? []
  const referenceMs = timestampMs(turn.endedAt || turn.startedAt)
  const usedSkills = uniqueStrings(turn.usedSkills)
  const pendingSkillNames = findPendingAnswerContext(existing, referenceMs, turn.userMessage)
  const pendingSkillNameSet = new Set(pendingSkillNames)
  // Explicit skill prompts can still be continuations when the marker is carried into a follow-up.
  const inheritedSkillNames =
    usedSkills.length > 0
      ? usedSkills.filter((rawSkillName) => pendingSkillNameSet.has(rawSkillName))
      : pendingSkillNames
  const skillContextNames = usedSkills.length > 0 ? usedSkills : inheritedSkillNames
  const skillTaskIdsByRawName = buildSkillTaskIds(
    turn.threadId,
    turn.traceId,
    skillContextNames,
    inheritedSkillNames,
    existing
  )
  const awaitingSkillNames = asksUserForMoreInput(turn.assistantText, turn.outcome)
    ? skillContextNames
    : []
  const nextTurn: StoredSkillEvalWindowTurn = {
    ...turn,
    usedSkills,
    skillContextNames: uniqueStrings(skillContextNames),
    awaitingSkillNames: uniqueStrings(awaitingSkillNames),
    skillTaskIdsByRawName
  }

  rememberThreadWindow(turn.threadId, pruneWindow([...existing, nextTurn], referenceMs))

  return {
    usedSkills,
    contextSkillNames: [...nextTurn.skillContextNames],
    evalSkillNames: [...nextTurn.skillContextNames],
    inheritedContext: usedSkills.length === 0 && nextTurn.skillContextNames.length > 0
  }
}

export function snapshotSkillEvalWindow(threadId: string): SkillEvalWindowTurn[] {
  return (skillEvalWindows.get(threadId) ?? []).map((turn) => ({
    traceId: turn.traceId,
    threadId: turn.threadId,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    usedSkills: [...turn.usedSkills],
    userMessage: turn.userMessage,
    assistantText: turn.assistantText,
    outcome: turn.outcome
  }))
}

export function resetSkillEvalWindow(threadId: string): void {
  skillEvalWindows.delete(threadId)
}

function buildWindowContextForSkill(
  turns: StoredSkillEvalWindowTurn[],
  rawSkillName: string
): SkillEvalWindowContext {
  const contextTraceIds: string[] = []
  const skillEvalTraceIds: string[] = []
  let skillTaskId = ""

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const turnTaskId = turn.skillTaskIdsByRawName[rawSkillName]
    if (!turnTaskId) {
      if (contextTraceIds.length > 0 || skillEvalTraceIds.length > 0) break
      continue
    }
    if (!skillTaskId) skillTaskId = turnTaskId
    if (turnTaskId !== skillTaskId) break

    contextTraceIds.push(turn.traceId)
    skillEvalTraceIds.push(turn.traceId)
  }

  const orderedContextTraceIds = uniqueStrings(contextTraceIds.reverse())
  const orderedSkillEvalTraceIds = uniqueStrings(skillEvalTraceIds.reverse())
  const effectiveSkillTaskId =
    skillTaskId ||
    skillTaskKey(turns[0]?.threadId ?? "", rawSkillName, orderedSkillEvalTraceIds[0] ?? "")

  return {
    skillTaskId: effectiveSkillTaskId,
    skillTaskTraceIndex: Math.max(0, orderedSkillEvalTraceIds.length - 1),
    contextTraceIds: orderedContextTraceIds,
    skillEvalTraceIds: orderedSkillEvalTraceIds,
    contextTraceCount: orderedContextTraceIds.length,
    skillEvalTraceCount: orderedSkillEvalTraceIds.length
  }
}

export function getSkillEvalWindowContextByRawName(
  threadId: string,
  rawSkillNames: string[]
): Record<string, SkillEvalWindowContext> {
  const turns = skillEvalWindows.get(threadId) ?? []
  const result: Record<string, SkillEvalWindowContext> = {}
  for (const rawSkillName of uniqueStrings(rawSkillNames)) {
    result[rawSkillName] = buildWindowContextForSkill(turns, rawSkillName)
  }
  return result
}
