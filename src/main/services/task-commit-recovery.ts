import path from "node:path"
import { getDb } from "../db"
import { recoverTaskBoundCommitIndex, type TaskCommitCandidate } from "./task-bound-git-commit"

const key = (scope: string) =>
  process.platform === "win32" ? path.resolve(scope).toLowerCase() : path.resolve(scope)

// Retain this record across a task deletion. A later authorized commit in the
// same checkout can recover an orphaned Git lock using its physical identity.
export function rememberTaskCommitIndex(
  threadId: string,
  scope: string,
  candidate: TaskCommitCandidate
): void {
  if (!candidate.indexRecovery) return
  getDb().run(
    `INSERT INTO task_commit_pending_indexes(worktree,thread_id,sha,branch,recovery)
    VALUES(?,?,?,?,?)`,
    [key(scope), threadId, candidate.sha, candidate.branch, JSON.stringify(candidate.indexRecovery)]
  )
}

export function forgetTaskCommitIndex(
  scope: string,
  candidate: Pick<TaskCommitCandidate, "sha" | "indexRecovery">
): void {
  if (!candidate.indexRecovery) return
  getDb().run("DELETE FROM task_commit_pending_indexes WHERE worktree=? AND sha=? AND recovery=?", [
    key(scope),
    candidate.sha,
    JSON.stringify(candidate.indexRecovery)
  ])
}

export async function recoverPendingTaskIndex(scope: string): Promise<string | null> {
  const row = getDb().exec(
    "SELECT sha,branch,recovery FROM task_commit_pending_indexes WHERE worktree=?",
    [key(scope)]
  )[0]?.values[0]
  if (!row) return null
  const [sha, branch, json] = row.map(String)
  const indexRecovery = JSON.parse(json)
  const outcome = await recoverTaskBoundCommitIndex(scope, sha, indexRecovery, branch)
  if (outcome.ok || outcome.cleared) forgetTaskCommitIndex(scope, { sha, indexRecovery })
  return outcome.ok ? null : `请核对上次提交 ${sha}。${outcome.reason ?? ""}`
}
