import type { PersistedWorkflowRun, WorkflowAgentStateRecord } from "./types"
import type { WorkflowRunStore } from "./run-store"

/** The original store's in-memory mutations, shared with isolated engine workers.
 * Persistence and lease authority belong to the host of this state. */
export function createWorkflowRunState(
  initial: PersistedWorkflowRun
): Pick<WorkflowRunStore, "state" | "update" | "appendJournal" | "upsertAgent"> {
  // Copy every container/record that the store mutates. Avoid a JSON round-trip:
  // a compatible legacy resume can carry up to 128 MiB of inline journal data,
  // and stringify+parse here would synchronously duplicate it on Electron main.
  // Nested args/result/structured values are execution payloads and are treated
  // as immutable; store mutations replace their owning record instead of editing
  // those values in place.
  const state: PersistedWorkflowRun = {
    ...initial,
    phases: [...initial.phases],
    agents: initial.agents.map((record) => ({ ...record })),
    worktrees: initial.worktrees?.map((record) => ({ ...record })),
    logs: [...initial.logs],
    journal: initial.journal.map((entry) => ({ ...entry })),
    stats: { ...initial.stats }
  }
  // O(1) indexes that mirror the persisted arrays, so a large run (up to 1000
  // agents) does not pay O(n²) for the per-agent state upserts and journal
  // appends. Seeded from the initial state (non-empty on resume).
  const agentsByIndex = new Map<number, WorkflowAgentStateRecord>(
    state.agents.map((record) => [record.index, record])
  )
  let maxJournalIndex = state.journal.reduce((max, entry) => Math.max(max, entry.index), -1)
  return {
    state,
    update(mutator) {
      const agents = state.agents
      mutator(state)
      if (agents !== state.agents) {
        agentsByIndex.clear()
        for (const record of state.agents) agentsByIndex.set(record.index, record)
      }
    },
    appendJournal(entry) {
      // Common case: lexical call indexes are monotonic, so an append keeps the array sorted with no
      // scan/sort (the engine replays order-independently BY HASH via availableByHash, so array order
      // is only cosmetic). Match an existing slot by index AND hash: replace ONLY when the SAME call
      // re-runs (idempotent rewrite). A DIFFERENT hash landing on an existing index — a concurrent
      // pipeline() reorder, or some agents left un-journaled (failure/fallback) shifting the live
      // callSeq onto a cached index — must NOT overwrite that index: replay is by hash, so an
      // overwrite would drop the OTHER call's cached result from availableByHash and force it to
      // re-run on the next resume (re-applying non-idempotent file edits). So APPEND it instead —
      // both hashes stay replayable; an unreferenced one just lingers harmlessly.
      if (entry.index > maxJournalIndex) {
        state.journal.push(entry)
        maxJournalIndex = entry.index
      } else {
        const existingIndex = state.journal.findIndex(
          (journalEntry) => journalEntry.index === entry.index && journalEntry.hash === entry.hash
        )
        if (existingIndex >= 0) {
          state.journal[existingIndex] = entry
        } else {
          // New index, OR a different hash at an existing index (never overwrite — see above).
          state.journal.push(entry)
          state.journal.sort((a, b) => a.index - b.index)
        }
      }
    },
    upsertAgent(record) {
      // O(1) by-index upsert (mirrors run.agents, which the renderer/file read).
      const existing = agentsByIndex.get(record.index)
      if (existing) {
        existing.status = record.status
        existing.error = record.error
        existing.outputTokens = record.outputTokens
        if (record.promptPreview !== undefined) existing.promptPreview = record.promptPreview
        if (record.resultPreview !== undefined) existing.resultPreview = record.resultPreview
        if (record.toolStreamKey !== undefined) existing.toolStreamKey = record.toolStreamKey
        if (record.status !== "running") existing.endedAt = new Date().toISOString()
      } else {
        const created: WorkflowAgentStateRecord = {
          index: record.index,
          label: record.label,
          phase: record.phase,
          status: record.status,
          error: record.error,
          outputTokens: record.outputTokens,
          promptPreview: record.promptPreview,
          resultPreview: record.resultPreview,
          toolStreamKey: record.toolStreamKey,
          startedAt: new Date().toISOString(),
          endedAt: record.status !== "running" ? new Date().toISOString() : undefined
        }
        state.agents.push(created)
        agentsByIndex.set(record.index, created)
      }
    }
  }
}
