export interface SkillProposalWindowTurn {
  userMessage: string
  assistantText: string
  toolCallNames: string[]
  toolCallCount: number
  status: "success" | "error"
  errorMessage?: string
  usedSkills: string[]
  finishedAt: string
}

export interface SkillProposalWindowContext {
  turns: SkillProposalWindowTurn[]
  transcript: string
  toolCallNames: string[]
  toolCallCount: number
  toolCallSummary: string
  turnCount: number
  successCount: number
  errorCount: number
  usedSkills: string[]
}

const MAX_USER_MESSAGE_CHARS = 500
const MAX_ASSISTANT_TEXT_CHARS = 1200
const MAX_ERROR_CHARS = 300
const RECENT_SKILL_USAGE_LOOKBACK_TURNS = 5
const MAX_ACTIVE_SKILL_THREADS = 200

const proposalWindows = new Map<string, SkillProposalWindowTurn[]>()
const recentSkillUsageTurns = new Map<string, SkillProposalWindowTurn[]>()

/**
 * Sticky per-thread "active skills" for code-generation attribution.
 *
 * Policy: once a turn uses a skill, that skill stays active for the rest of the
 * thread and is attributed to all *subsequent* generated code — even in later
 * turns that don't re-read the SKILL.md — until a later turn uses a *different*
 * skill set, which then supersedes it. No turn-distance cap.
 *
 * This deliberately lives OUTSIDE `proposalWindows`: that window is reset
 * mid-thread by the skill-evolution session (`resetSkillProposalWindow`), which
 * would otherwise drop the active skill even though nothing superseded it. The
 * active-skill memory must survive those resets, so it has its own map and is
 * only cleared by an explicit thread-level reset / size-cap eviction.
 *
 * NOTE: this feeds ONLY the adoption context (code_gen / code_adopt → commit
 * 明细的关联 Skill and skill-sliced adoption rate). A trace's own `usedSkills`
 * is set separately from the current run's skills and is unaffected.
 */
const threadActiveSkills = new Map<string, string[]>()

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function cloneTurn(turn: SkillProposalWindowTurn): SkillProposalWindowTurn {
  return {
    ...turn,
    toolCallNames: [...turn.toolCallNames],
    usedSkills: [...turn.usedSkills]
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isSkillProposalWindowTurn(value: unknown): value is SkillProposalWindowTurn {
  if (!value || typeof value !== "object") return false
  const t = value as Record<string, unknown>
  return (
    typeof t.userMessage === "string" &&
    typeof t.assistantText === "string" &&
    isStringArray(t.toolCallNames) &&
    typeof t.toolCallCount === "number" &&
    (t.status === "success" || t.status === "error") &&
    (t.errorMessage === undefined || typeof t.errorMessage === "string") &&
    isStringArray(t.usedSkills) &&
    typeof t.finishedAt === "string"
  )
}

/** Type-guard for SkillProposalWindowContext. Safe to use on untrusted IPC payloads. */
export function isSkillProposalWindowContext(value: unknown): value is SkillProposalWindowContext {
  if (!value || typeof value !== "object") return false
  const c = value as Record<string, unknown>
  return (
    Array.isArray(c.turns) &&
    c.turns.every(isSkillProposalWindowTurn) &&
    typeof c.transcript === "string" &&
    isStringArray(c.toolCallNames) &&
    typeof c.toolCallCount === "number" &&
    typeof c.toolCallSummary === "string" &&
    typeof c.turnCount === "number" &&
    typeof c.successCount === "number" &&
    typeof c.errorCount === "number" &&
    isStringArray(c.usedSkills)
  )
}

function buildTranscript(turns: SkillProposalWindowTurn[]): string {
  return turns
    .map((turn, index) => {
      const header = `Turn ${index + 1} [${turn.status}]`
      const parts = [
        header,
        `User request:\n${clip(turn.userMessage, MAX_USER_MESSAGE_CHARS) || "(empty)"}`,
        `Assistant response:\n${clip(turn.assistantText, MAX_ASSISTANT_TEXT_CHARS) || "(empty)"}`
      ]

      if (turn.toolCallNames.length > 0) {
        parts.push(`Tools used (${turn.toolCallCount}): ${buildToolCallSummary(turn.toolCallNames)}`)
      }

      if (turn.errorMessage) {
        parts.push(`Error:\n${clip(turn.errorMessage, MAX_ERROR_CHARS)}`)
      }

      if (turn.usedSkills.length > 0) {
        parts.push(`Used skills during turn: ${turn.usedSkills.join(", ")}`)
      }

      return parts.join("\n")
    })
    .join("\n\n")
}

export function buildToolCallSummary(toolCallNames: string[]): string {
  if (toolCallNames.length === 0) return "(none)"

  const counts = new Map<string, number>()
  for (const name of toolCallNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .map(([name, count]) => `${name} x${count}`)
    .join(", ")
}

export function appendSkillProposalWindowTurn(
  threadId: string,
  turn: SkillProposalWindowTurn
): void {
  const clonedTurn = cloneTurn(turn)
  const next = proposalWindows.get(threadId) ?? []
  next.push(clonedTurn)
  proposalWindows.set(threadId, next)

  const recent = recentSkillUsageTurns.get(threadId) ?? []
  recent.push(clonedTurn)
  recentSkillUsageTurns.set(threadId, recent.slice(-RECENT_SKILL_USAGE_LOOKBACK_TURNS))
}

export function snapshotSkillProposalWindow(threadId: string): SkillProposalWindowTurn[] {
  return (proposalWindows.get(threadId) ?? []).map(cloneTurn)
}

export function resetSkillProposalWindow(threadId: string): void {
  proposalWindows.delete(threadId)
}

export function getRecentSkillUsageNames(threadId: string): string[] {
  return Array.from(
    new Set((recentSkillUsageTurns.get(threadId) ?? []).flatMap((turn) => turn.usedSkills))
  )
}

/**
 * Record the skills the current turn used as the thread's active skill set,
 * superseding any previously-active set. No-op for an empty set so a skill-less
 * turn never clears the sticky attribution. See `threadActiveSkills`.
 */
export function setThreadActiveSkills(threadId: string, skills: string[]): void {
  if (!threadId) return
  const normalized = Array.from(new Set(skills.filter(Boolean)))
  if (normalized.length === 0) return
  // Evict oldest if the size cap would be exceeded (Map preserves insertion order).
  if (!threadActiveSkills.has(threadId) && threadActiveSkills.size >= MAX_ACTIVE_SKILL_THREADS) {
    const oldest = threadActiveSkills.keys().next().value
    if (oldest !== undefined) threadActiveSkills.delete(oldest)
  }
  threadActiveSkills.set(threadId, normalized)
}

/** The thread's currently-active skills (empty if none used yet). */
export function getThreadActiveSkills(threadId: string): string[] {
  return [...(threadActiveSkills.get(threadId) ?? [])]
}

export function buildSkillProposalWindowContext(
  turns: SkillProposalWindowTurn[]
): SkillProposalWindowContext {
  const clonedTurns = turns.map(cloneTurn)
  const toolCallNames = clonedTurns.flatMap((turn) => turn.toolCallNames)
  const usedSkills = Array.from(new Set(clonedTurns.flatMap((turn) => turn.usedSkills)))

  return {
    turns: clonedTurns,
    transcript: buildTranscript(clonedTurns),
    toolCallNames,
    toolCallCount: clonedTurns.reduce((sum, turn) => sum + turn.toolCallCount, 0),
    toolCallSummary: buildToolCallSummary(toolCallNames),
    turnCount: clonedTurns.length,
    successCount: clonedTurns.filter((turn) => turn.status === "success").length,
    errorCount: clonedTurns.filter((turn) => turn.status === "error").length,
    usedSkills
  }
}
