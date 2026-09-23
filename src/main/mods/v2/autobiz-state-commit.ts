import { createHash } from "node:crypto"
import { AUTOBIZ_KANBAN_COMMIT, withPinnedAutobiz } from "./autobiz-source"
import { AUTOBIZ_STATE_COMMIT_PYTHON } from "./autobiz-state-commit-python"
import { AutobizStateJournal, type AutobizCommitEvidence } from "./autobiz-state-journal"
import { runAutobizTransitionProcess } from "./autobiz-transition-process"
import type { AutobizCheckpointTransition } from "./autobiz-validation"

export interface AutobizCommitInput {
  workspace: string
  feature: string
  from: string
  to: string
  expectedStateFingerprint: string
  idempotencyKey: string
  /** Host retry/ledger reconciliation may inspect an existing commit, never create one. */
  requireCommittedReceipt?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  verifyEvidence?(): Promise<void>
}

function evidenceFromReady(value: unknown, operationId: string): AutobizCommitEvidence {
  if (!value || typeof value !== "object") throw Error("AUTOBIZ_PROTOCOL_INVALID")
  const ready = value as Record<string, unknown>
  const evidence = ready.evidence as AutobizCommitEvidence
  if (ready.operationId !== operationId || !evidence) throw Error("AUTOBIZ_PROTOCOL_INVALID")
  for (const name of ["before", "after", "identities", "beforeContent", "afterContent"] as const) {
    if (
      !Array.isArray(evidence[name]) ||
      evidence[name].length !== 2 ||
      evidence[name].some((item) => typeof item !== "string")
    )
      throw Error("AUTOBIZ_PROTOCOL_INVALID")
  }
  for (const phase of ["before", "after"] as const) {
    for (let index = 0; index < 2; index++) {
      const data = Buffer.from(evidence[`${phase}Content`][index], "base64")
      if (
        data.length > 262144 ||
        createHash("sha256").update(data).digest("hex") !== evidence[phase][index]
      )
        throw Error("AUTOBIZ_PROTOCOL_INVALID")
    }
  }
  return evidence
}

/** Only the host calls this helper; journal paths are never plugin arguments. */
export async function commitAutobizState(
  input: AutobizCommitInput
): Promise<AutobizCheckpointTransition> {
  let journal: AutobizStateJournal | undefined
  let prepared: AutobizCommitEvidence | undefined
  let acknowledged = false
  const rejected = (reason: string): AutobizCheckpointTransition => ({
    applied: false,
    duplicate: false,
    feature: input.feature,
    from: input.from,
    to: input.to,
    stateFingerprint: "",
    status: reason.includes("AUTOBIZ_COMMIT_UNKNOWN") ? "unknown" : "not-applied",
    operationId:
      /AUTOBIZ_COMMIT_UNKNOWN:([a-f0-9]{64})(?:\b|:)/.exec(reason)?.[1] ?? journal?.operationId,
    reason
  })
  try {
    input.signal?.throwIfAborted()
    journal = new AutobizStateJournal(
      input.workspace,
      JSON.stringify([input.feature, input.from, input.to, AUTOBIZ_KANBAN_COMMIT]),
      input.idempotencyKey
    )
    const activeJournal = journal
    const receipt = journal.receipt()
    if (input.requireCommittedReceipt && !receipt) throw Error("AUTOBIZ_RECEIPT_REQUIRED")
    const stdout = await withPinnedAutobiz(input.signal, (source) =>
      runAutobizTransitionProcess({
        command: process.env.CMB_AUTOBIZ_PYTHON || "python",
        args: [
          "-I",
          "-B",
          "-X",
          "utf8",
          "-c",
          AUTOBIZ_STATE_COMMIT_PYTHON,
          source,
          input.workspace,
          input.feature,
          input.from,
          input.to,
          input.expectedStateFingerprint,
          activeJournal.operationId,
          JSON.stringify(receipt ? { after: receipt.after, identities: receipt.identities } : null),
          activeJournal.root
        ],
        cwd: source,
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? 120_000,
        operationId: activeJournal.operationId,
        verifyEvidence:
          input.verifyEvidence ??
          (async () => {
            input.signal?.throwIfAborted()
          }),
        prepare: (message) => {
          prepared = evidenceFromReady(message, activeJournal.operationId)
          if (prepared.before[0] !== input.expectedStateFingerprint)
            throw Error("AUTOBIZ_STATE_CHANGED")
          activeJournal.begin(prepared)
          acknowledged = true
        },
        written: (message) => {
          const value = message as Record<string, unknown>
          if (
            !prepared ||
            value.stateFingerprint !== prepared.after[0] ||
            value.markdownFingerprint !== prepared.after[1]
          )
            throw Error("AUTOBIZ_PROTOCOL_INVALID")
          activeJournal.commit()
        },
        uncertain: () => activeJournal.unknown()
      })
    )
    input.signal?.throwIfAborted()
    const result = JSON.parse(stdout) as AutobizCheckpointTransition
    if (
      result.operationId !== journal.operationId ||
      result.feature !== input.feature ||
      result.from !== input.from ||
      result.to !== input.to
    )
      throw Error("AUTOBIZ_PROTOCOL_INVALID")
    if (
      result.applied &&
      (!prepared ||
        result.stateFingerprint !== prepared.after[0] ||
        result.markdownFingerprint !== prepared.after[1])
    )
      throw Error("AUTOBIZ_PROTOCOL_INVALID")
    if (
      result.duplicate &&
      (!receipt ||
        result.stateFingerprint !== receipt.after[0] ||
        result.markdownFingerprint !== receipt.after[1])
    )
      throw Error("AUTOBIZ_PROTOCOL_INVALID")
    if (acknowledged && !result.applied) {
      journal.unknown()
      return rejected(
        `AUTOBIZ_COMMIT_UNKNOWN:${journal.operationId}:${result.reason ?? "missing result"}`
      )
    }
    return result
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 4000) : String(error)
    if (acknowledged) {
      try {
        journal?.unknown()
      } catch {
        /* Keep the durable intent, never attempt rollback. */
      }
      return rejected(`AUTOBIZ_COMMIT_UNKNOWN:${journal?.operationId}:${reason}`)
    }
    if (input.signal?.aborted && !reason.includes("AUTOBIZ_COMMIT_UNKNOWN")) throw error
    return rejected(reason)
  } finally {
    journal?.close()
  }
}
