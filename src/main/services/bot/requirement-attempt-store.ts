import { createHash } from "node:crypto"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import {
  validatePartnerRun,
  type PartnerRequirementRun,
  type RequirementOutcome
} from "./requirement-execution-types"

export interface StoredRequirementAttempt {
  threadId: string
  state: "reserved" | "running" | "result_ready" | "settled"
  outcome: RequirementOutcome | null
  text: string | null
}
function fingerprint(run: PartnerRequirementRun) {
  const {
    status: _status,
    leaseExpiresAt: _expiry,
    memoryScope,
    ...identity
  } = validatePartnerRun(run)
  // V6 local receipts predate this field. Explicit legacy 'group' must retain
  // their exact fingerprint; new expert attempts remain distinct.
  return createHash("sha256")
    .update(JSON.stringify(memoryScope === "bot" ? { ...identity, memoryScope } : identity))
    .digest("hex")
}

/** Durable local at-most-one admission. A reserved/running record after a crash
 * is deliberately not replayable. No credentials/paths/private history stored.
 * Not a distributed exactly-once guarantee for tools (this profile has none). */
export class PartnerRequirementAttemptStore {
  constructor(private readonly db: NativeSqliteAdapter) {
    db.run(`CREATE TABLE IF NOT EXISTS bot_requirement_attempts (
      space_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      identity_hash TEXT NOT NULL, thread_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      state TEXT NOT NULL, outcome TEXT, result_text TEXT,
      PRIMARY KEY(space_id,run_id), UNIQUE(space_id,attempt_id)
    )`)
  }
  get(run: PartnerRequirementRun): StoredRequirementAttempt | null {
    const value = validatePartnerRun(run)
    const s = this.db.prepare(
      "SELECT * FROM bot_requirement_attempts WHERE space_id=? AND run_id=?"
    )
    s.bind([value.spaceId, value.id])
    try {
      if (!s.step()) return null
      const r = s.getAsObject()
      if (r.identity_hash !== fingerprint(value) || r.attempt_id !== value.attemptId)
        throw new Error("PARTNER_ATTEMPT_CHANGED")
      if (
        typeof r.thread_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.thread_id) ||
        typeof r.input_hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(r.input_hash) ||
        !["reserved", "running", "result_ready", "settled"].includes(String(r.state)) ||
        (["reserved", "running"].includes(String(r.state))
          ? r.outcome !== null || r.result_text !== null
          : !["succeeded", "failed"].includes(String(r.outcome)) ||
            typeof r.result_text !== "string" ||
            !r.result_text.trim() ||
            r.result_text.length > 16_384)
      )
        throw new Error("PARTNER_ATTEMPT_STORE_INVALID")
      return {
        threadId: r.thread_id,
        state: r.state as StoredRequirementAttempt["state"],
        outcome: r.outcome as RequirementOutcome | null,
        text: r.result_text as string | null
      }
    } finally {
      s.free()
    }
  }
  reserve(run: PartnerRequirementRun, threadId: string, inputHash: string): boolean {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(threadId) || !/^[a-f0-9]{64}$/.test(inputHash))
      throw new Error("PARTNER_ATTEMPT_INPUT_INVALID")
    let transaction = false
    try {
      this.db.run("BEGIN IMMEDIATE")
      transaction = true
      const old = this.get(run)
      if (!old)
        this.db.run(
          `INSERT INTO bot_requirement_attempts
        (space_id,run_id,attempt_id,identity_hash,thread_id,input_hash,state) VALUES(?,?,?,?,?,?,'reserved')`,
          [run.spaceId, run.id, run.attemptId, fingerprint(run), threadId, inputHash]
        )
      this.db.run("COMMIT")
      transaction = false
      return !old
    } finally {
      if (transaction) this.db.run("ROLLBACK")
    }
  }
  markRunning(run: PartnerRequirementRun): void {
    this.update(run, "reserved", "running", null, null)
  }
  saveResult(run: PartnerRequirementRun, outcome: RequirementOutcome, text: string): void {
    if (!["succeeded", "failed"].includes(outcome) || !text.trim() || text.length > 16_384)
      throw new Error("PARTNER_RESULT_INVALID")
    this.update(run, "running", "result_ready", outcome, text)
  }
  markSettled(run: PartnerRequirementRun): void {
    const old = this.get(run)
    if (old?.state === "settled") return
    if (!old || old.state !== "result_ready") throw new Error("PARTNER_ATTEMPT_STATE_INVALID")
    this.update(run, "result_ready", "settled", old.outcome, old.text)
  }
  private update(
    run: PartnerRequirementRun,
    from: string,
    to: string,
    outcome: RequirementOutcome | null,
    text: string | null
  ) {
    const old = this.get(run)
    if (!old || old.state !== from) throw new Error("PARTNER_ATTEMPT_STATE_INVALID")
    this.db.run(
      `UPDATE bot_requirement_attempts SET state=?,outcome=?,result_text=?
      WHERE space_id=? AND run_id=? AND identity_hash=? AND state=?`,
      [to, outcome, text, run.spaceId, run.id, fingerprint(run), from]
    )
    if (this.db.exec("SELECT changes()")[0].values[0][0] !== 1)
      throw new Error("PARTNER_ATTEMPT_STATE_INVALID")
  }
}
