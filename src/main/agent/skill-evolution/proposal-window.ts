import {
  getThreadActiveSkillsRow,
  upsertThreadActiveSkills,
  type ThreadActiveSkillsRow
} from "../../services/adoption-index"

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
 *
 * The maps are a cache in front of `thread_active_skills` in the adoption
 * index. Persistence is not optional bookkeeping: a thread routinely spans an
 * app restart (work stops for the night, resumes next morning), and with an
 * in-memory-only set every generation between the restart and the next
 * SKILL.md read lost its attribution and was misfiled as vibecoding.
 */
const threadActiveSkills = new Map<string, string[]>()
const threadActiveSkillSource = new Map<string, string[]>()
/**
 * Threads we already know have no stored set. Without this, every attribution
 * sync on a skill-less thread re-queries sqlite, and sync runs on the streaming
 * hot path (once per `values` snapshot that carries skillsMetadata). A negative
 * result stays valid for the process: rows only appear through
 * `rememberActiveSkills`, which drops the thread from this set as it writes.
 */
const threadsWithoutStoredSkills = new Set<string>()

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Write through to the adoption index, keeping the in-memory cache authoritative.
 *
 * `persist: false` keeps the set in memory only. Used for sub-agent threads,
 * whose ids are minted per run (`…__wf_<runId>_a<n>`) and never resumed — a row
 * for one would be read back by nobody and would still be re-serialized on
 * every snapshot, because sql.js exports the whole database on each save. After
 * a restart such a thread resolves through the parent chain instead, which is
 * what gets persisted.
 */
function rememberActiveSkills(
  threadId: string,
  skills: string[],
  skillSource: string[],
  persist = true
): void {
  // Attribution re-syncs on every skill hit, and a long turn re-publishes the
  // same set many times — only touch the index when something actually changed.
  const cached = threadActiveSkills.get(threadId)
  const unchanged =
    cached !== undefined &&
    sameList(cached, skills) &&
    sameList(threadActiveSkillSource.get(threadId) ?? [], skillSource)
  if (unchanged) return
  // Evict oldest if the size cap would be exceeded (Map preserves insertion order).
  if (cached === undefined && threadActiveSkills.size >= MAX_ACTIVE_SKILL_THREADS) {
    const oldest = threadActiveSkills.keys().next().value
    if (oldest !== undefined) {
      threadActiveSkills.delete(oldest)
      threadActiveSkillSource.delete(oldest)
    }
  }
  threadActiveSkills.set(threadId, skills)
  threadActiveSkillSource.set(threadId, skillSource)
  // Cleared even when we don't persist: the lookup checks this set first, so a
  // stale negative entry would hide the in-memory set we just wrote.
  threadsWithoutStoredSkills.delete(threadId)
  if (!persist) return
  try {
    upsertThreadActiveSkills(threadId, skills, skillSource)
  } catch {
    // Attribution must never break a turn; the in-memory set still works for
    // this process, it just won't survive a restart.
  }
}

/**
 * Cache-then-index lookup. An eviction or a restart empties the map, so a miss
 * has to consult the index before concluding the thread has no active skill.
 */
function loadActiveSkills(threadId: string): { skills: string[]; skillSource: string[] } {
  if (!threadId || threadsWithoutStoredSkills.has(threadId)) {
    return { skills: [], skillSource: [] }
  }
  const cached = threadActiveSkills.get(threadId)
  if (cached) return { skills: cached, skillSource: threadActiveSkillSource.get(threadId) ?? [] }
  let stored: ThreadActiveSkillsRow | null = null
  try {
    stored = getThreadActiveSkillsRow(threadId)
  } catch {
    stored = null
  }
  if (!stored) {
    if (threadsWithoutStoredSkills.size >= MAX_ACTIVE_SKILL_THREADS) {
      const oldest = threadsWithoutStoredSkills.values().next().value
      if (oldest !== undefined) threadsWithoutStoredSkills.delete(oldest)
    }
    threadsWithoutStoredSkills.add(threadId)
    return { skills: [], skillSource: [] }
  }
  // Warm the cache without re-writing the row we just read.
  threadActiveSkills.set(threadId, stored.skills)
  threadActiveSkillSource.set(threadId, stored.skillSource)
  return { skills: stored.skills, skillSource: stored.skillSource }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

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
        parts.push(
          `Tools used (${turn.toolCallCount}): ${buildToolCallSummary(turn.toolCallNames)}`
        )
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
export function setThreadActiveSkills(
  threadId: string,
  skills: string[],
  skillSource: string[] = [],
  options: { persist?: boolean } = {}
): void {
  if (!threadId) return
  const normalized = dedupe(skills)
  if (normalized.length === 0) return
  rememberActiveSkills(threadId, normalized, dedupe(skillSource), options.persist ?? true)
}

/**
 * Add skills to a thread's active set without superseding what is already
 * there. Used when a sub-agent contributes skills to a thread it does not own:
 * a Task sub-agent shares the parent's filesystem backend, so its generated
 * code is recorded against the *parent* thread and has to be attributed there —
 * but the parent may be running its own skill at the same time, and a
 * supersede would silently drop it.
 */
export function mergeThreadActiveSkills(
  threadId: string,
  skills: string[],
  skillSource: string[] = []
): void {
  if (!threadId) return
  const incoming = dedupe(skills)
  if (incoming.length === 0) return
  const current = loadActiveSkills(threadId)
  const mergedSkills = dedupe([...current.skills, ...incoming])
  const mergedSource = dedupe([...current.skillSource, ...skillSource])
  // Nothing new to record — skip the write so a chatty sub-agent doesn't churn
  // the index on every stream chunk.
  if (
    mergedSkills.length === current.skills.length &&
    mergedSource.length === current.skillSource.length
  ) {
    return
  }
  rememberActiveSkills(threadId, mergedSkills, mergedSource)
}

/** The thread's currently-active skills (empty if none used yet). */
export function getThreadActiveSkills(threadId: string): string[] {
  return [...loadActiveSkills(threadId).skills]
}

/** Source map for the thread's currently-active skills. */
export function getThreadActiveSkillSource(threadId: string): string[] {
  return [...loadActiveSkills(threadId).skillSource]
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
