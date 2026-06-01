import { v4 as uuid } from "uuid"
import { RUNTIME_RESTORED_GOAL_PAUSE_NOTICE } from "../../../shared/goal-events"
import { getDb, saveToDisk } from "../../db"
import {
  EMPTY_GOAL_LEDGER,
  RUNTIME_RESTORED_ACTIVE_GOAL_REASON,
  type GoalContext,
  type GoalLedger,
  type GoalStatus,
  type GoalStore,
  type ThreadGoal
} from "./types"

interface GoalRow {
  thread_id: string
  goal_id: string
  active_window_id: string | null
  objective: string
  completion_condition: string | null
  context_json: string | null
  status: string
  turns_used: number
  max_turns: number
  last_verdict: string | null
  last_reason: string | null
  paused_reason: string | null
  consecutive_parse_failures: number
  ledger_json: string | null
  created_at: number
  updated_at: number
}

const MAX_LEDGER_ITEMS = 30
const MAX_LEDGER_ITEM_CHARS = 600
const MAX_LEDGER_SECTION_CHARS = 4_000
const MAX_GOAL_CONTEXT_SUMMARY_CHARS = 300

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 40) return `${text.slice(0, maxChars)}...`
  const headChars = Math.floor(maxChars * 0.65)
  const tailChars = Math.floor(maxChars * 0.25)
  return `${text.slice(0, headChars)}...(truncated ${text.length - headChars - tailChars} chars)...${text.slice(-tailChars)}`
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized = value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .map((item) => truncateMiddle(item, MAX_LEDGER_ITEM_CHARS))
    .slice(-MAX_LEDGER_ITEMS)

  const selected: string[] = []
  let used = 0
  for (let i = normalized.length - 1; i >= 0; i--) {
    const item = normalized[i]
    const nextUsed = used + item.length + 1
    if (selected.length > 0 && nextUsed > MAX_LEDGER_SECTION_CHARS) break
    selected.push(item)
    used = nextUsed
  }
  return selected.reverse()
}

export function normalizeGoalLedger(value: unknown): GoalLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_GOAL_LEDGER }
  const record = value as Record<string, unknown>
  return {
    progress: normalizeStringArray(record.progress),
    evidence: normalizeStringArray(record.evidence),
    blockers: normalizeStringArray(record.blockers)
  }
}

export function parseGoalLedger(raw: string | null | undefined): GoalLedger {
  if (!raw) return { ...EMPTY_GOAL_LEDGER }
  try {
    return normalizeGoalLedger(JSON.parse(raw))
  } catch {
    return { ...EMPTY_GOAL_LEDGER }
  }
}

function normalizeGoalContext(value: unknown): GoalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const context: GoalContext = {}

  const transportSummary =
    typeof record.transportSummary === "string" ? record.transportSummary.trim() : ""
  if (transportSummary) {
    context.transportSummary = truncateMiddle(
      transportSummary,
      MAX_GOAL_CONTEXT_SUMMARY_CHARS
    )
  }

  const explicitSkill = record.explicitSkill
  if (explicitSkill && typeof explicitSkill === "object" && !Array.isArray(explicitSkill)) {
    const skillRecord = explicitSkill as Record<string, unknown>
    const name = typeof skillRecord.name === "string" ? skillRecord.name.trim() : ""
    const path = typeof skillRecord.path === "string" ? skillRecord.path.trim() : ""
    if (name && path) context.explicitSkill = { name, path }
  }

  return context
}

export function parseGoalContext(raw: string | null | undefined): GoalContext {
  if (!raw) return {}
  try {
    return normalizeGoalContext(JSON.parse(raw))
  } catch {
    return {}
  }
}

function rowToGoal(row: GoalRow): ThreadGoal {
  const status: GoalStatus =
    row.status === "active" || row.status === "complete" ? row.status : "paused"
  return {
    threadId: row.thread_id,
    goalId: row.goal_id,
    activeWindowId: String(row.active_window_id || row.goal_id || uuid()),
    objective: row.objective,
    completionCondition: row.completion_condition || row.objective,
    context: parseGoalContext(row.context_json),
    status,
    turnsUsed: Number(row.turns_used || 0),
    maxTurns: Number(row.max_turns || 15),
    lastVerdict: row.last_verdict,
    lastReason: row.last_reason,
    pausedReason: row.paused_reason,
    consecutiveParseFailures: Number(row.consecutive_parse_failures || 0),
    ledger: parseGoalLedger(row.ledger_json),
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || Date.now())
  }
}

export class SqlGoalStore implements GoalStore {
  pauseActiveGoalsForRuntimeRestore(
    reason = RUNTIME_RESTORED_ACTIVE_GOAL_REASON,
    now = Date.now()
  ): number {
    const db = getDb()
    const activeRows =
      db.exec("SELECT thread_id, goal_id, active_window_id FROM thread_goals WHERE status = 'active'")?.[0]
        ?.values ?? []
    if (activeRows.length <= 0) return 0
    db.run(
      `
        UPDATE thread_goals
        SET status = 'paused',
            paused_reason = ?,
            updated_at = ?
        WHERE status = 'active'
      `,
      [reason, now]
    )
    for (const row of activeRows) {
      const threadId = String(row[0] ?? "").trim()
      if (!threadId) continue
      const goalId = row[1] == null ? null : String(row[1])
      const activeWindowId = row[2] == null ? null : String(row[2])
      db.run(
        "INSERT INTO thread_goal_events (thread_id, goal_id, active_window_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
        [threadId, goalId, activeWindowId, RUNTIME_RESTORED_GOAL_PAUSE_NOTICE, now]
      )
    }
    saveToDisk()
    return activeRows.length
  }

  get(threadId: string): ThreadGoal | null {
    const db = getDb()
    const stmt = db.prepare("SELECT * FROM thread_goals WHERE thread_id = ?")
    stmt.bind([threadId])
    try {
      if (!stmt.step()) return null
      return rowToGoal(stmt.getAsObject() as unknown as GoalRow)
    } finally {
      stmt.free()
    }
  }

  upsert(goal: ThreadGoal): ThreadGoal {
    const db = getDb()
    db.run(
      `
        INSERT INTO thread_goals (
          thread_id, goal_id, active_window_id, objective, completion_condition, context_json, status,
          turns_used, max_turns, last_verdict, last_reason, paused_reason,
          consecutive_parse_failures, ledger_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          active_window_id = excluded.active_window_id,
          objective = excluded.objective,
          completion_condition = excluded.completion_condition,
          context_json = excluded.context_json,
          status = excluded.status,
          turns_used = excluded.turns_used,
          max_turns = excluded.max_turns,
          last_verdict = excluded.last_verdict,
          last_reason = excluded.last_reason,
          paused_reason = excluded.paused_reason,
          consecutive_parse_failures = excluded.consecutive_parse_failures,
          ledger_json = excluded.ledger_json,
          created_at = CASE
            WHEN thread_goals.goal_id != excluded.goal_id THEN excluded.created_at
            WHEN thread_goals.status != 'active'
              AND excluded.status = 'active'
              AND excluded.turns_used = 0 THEN excluded.created_at
            WHEN thread_goals.status = 'active'
              AND excluded.status = 'active'
              AND excluded.turns_used = 0
              AND excluded.updated_at > thread_goals.updated_at THEN excluded.created_at
            ELSE thread_goals.created_at
          END,
          updated_at = excluded.updated_at
      `,
      [
        goal.threadId,
        goal.goalId,
        goal.activeWindowId,
        goal.objective,
        goal.completionCondition,
        JSON.stringify(normalizeGoalContext(goal.context)),
        goal.status,
        goal.turnsUsed,
        goal.maxTurns,
        goal.lastVerdict,
        goal.lastReason,
        goal.pausedReason,
        goal.consecutiveParseFailures,
        JSON.stringify(normalizeGoalLedger(goal.ledger)),
        goal.createdAt,
        goal.updatedAt
      ]
    )
    saveToDisk()
    return this.get(goal.threadId) ?? goal
  }

  delete(threadId: string): void {
    getDb().run("DELETE FROM thread_goals WHERE thread_id = ?", [threadId])
    saveToDisk()
  }
}

export class InMemoryGoalStore implements GoalStore {
  private readonly goals = new Map<string, ThreadGoal>()

  pauseActiveGoalsForRuntimeRestore(
    reason = RUNTIME_RESTORED_ACTIVE_GOAL_REASON,
    now = Date.now()
  ): number {
    let count = 0
    for (const [threadId, goal] of this.goals) {
      if (goal.status !== "active") continue
      count += 1
      this.goals.set(
        threadId,
        cloneGoal({
          ...goal,
          status: "paused",
          pausedReason: reason,
          updatedAt: now
        })
      )
    }
    return count
  }

  get(threadId: string): ThreadGoal | null {
    const goal = this.goals.get(threadId)
    return goal ? cloneGoal(goal) : null
  }

  upsert(goal: ThreadGoal): ThreadGoal {
    const normalized = {
      ...goal,
      context: normalizeGoalContext(goal.context),
      ledger: normalizeGoalLedger(goal.ledger)
    }
    this.goals.set(goal.threadId, cloneGoal(normalized))
    return cloneGoal(normalized)
  }

  delete(threadId: string): void {
    this.goals.delete(threadId)
  }
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    ...goal,
    context: normalizeGoalContext(goal.context),
    ledger: {
      progress: [...goal.ledger.progress],
      evidence: [...goal.ledger.evidence],
      blockers: [...goal.ledger.blockers]
    }
  }
}

export function deriveCompletionCondition(text: string): string {
  const trimmed = text.trim()
  const label =
    /(?:^|\n)\s*(?:完成条件|完成标准|验证方法|验证|验收标准|验收条件|done when|verification|validation|acceptance criteria)\s*[：:]/i
  const match = label.exec(trimmed)
  if (!match) return trimmed

  const rest = trimmed.slice(match.index + match[0].length).trim()
  const boundary = rest.search(
    /\n\s*(?:stop if|scope|constraints?|停止条件|停止|范围|约束)\s*[：:]/i
  )
  const condition = (boundary >= 0 ? rest.slice(0, boundary) : rest).trim()
  return condition || trimmed
}

export function createNewGoal(params: {
  threadId: string
  text: string
  maxTurns: number
  context?: GoalContext
  now?: number
}): ThreadGoal {
  const now = params.now ?? Date.now()
  const text = params.text.trim()
  return {
    threadId: params.threadId,
    goalId: uuid(),
    activeWindowId: uuid(),
    objective: text,
    completionCondition: deriveCompletionCondition(text),
    context: normalizeGoalContext(params.context),
    status: "active",
    turnsUsed: 0,
    maxTurns: params.maxTurns,
    lastVerdict: null,
    lastReason: null,
    pausedReason: null,
    consecutiveParseFailures: 0,
    ledger: { ...EMPTY_GOAL_LEDGER },
    createdAt: now,
    updatedAt: now
  }
}
