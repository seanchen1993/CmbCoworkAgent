/** Read-only evidence from the original native action store, after physical stage settlement. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { FlowStore } from "../../src/main/mods/flows/store"
import { projectActionPhaseId } from "../../src/main/harness-board/project-runtime/action-flow"

const record = (value: unknown): Record<string, unknown> => {
  assert(value && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}

/** The existing FlowStore revalidates its original private facts; this adapter cannot write. */
export function originalMutationCheckReceipt(
  home: string,
  input: {
    workspace: string
    threadId: string
    operationId: string
    actionId: string
  }
) {
  const db = new DatabaseSync(join(home, "mods-control.sqlite"), { readOnly: true })
  try {
    const store = new FlowStore({
      getSetting(key, fallback = "") {
        const row = db.prepare("SELECT value FROM mods_meta WHERE key = ?").get(key)
        return typeof row?.value === "string" ? row.value : fallback
      },
      setSetting() {
        throw Error("READ_ONLY_ACCEPTANCE_EVIDENCE")
      }
    })
    const runs = store
      .runs(input.workspace, input.threadId)
      .filter((run) => run.flow.definition.id === projectActionPhaseId(input.operationId, "checks"))
    assert.equal(runs.length, 1, "Original settled Host check flow required")
    const run = runs[0]
    assert(["complete", "failed"].includes(run.status) && Number.isFinite(run.finishedAt))
    const attempt = run.attempts.filter((attempt) => attempt.stepId === input.actionId).at(-1)
    assert(
      attempt &&
        ["passed", "failed"].includes(attempt.status) &&
        !attempt.invalidated &&
        !Object.hasOwn(attempt, "reusedFrom")
    )
    const fact = store.actionResult(input.workspace, input.threadId, run.id, attempt.executionId)
    assert(fact && fact.provider.plugin === "test-verification" && fact.provider.actionId === "e2e")
    return { runId: run.id, attempt, fact }
  } finally {
    db.close()
  }
}

export function originalMutationTestReceipt(
  home: string,
  threadId: string,
  selection: {
    runId: string
    executionId?: string
  }
) {
  const db = new DatabaseSync(join(home, "mods-control.sqlite"), { readOnly: true })
  try {
    const rows = db.prepare("SELECT namespace,key,value FROM mods_function_state").all()
    const bindings = rows.filter((row) => {
      if (!String(row.namespace).startsWith('["native.workflow-actions/v1",')) return false
      const scope = JSON.parse(String(row.namespace)) as unknown[]
      return (
        scope[0] === "native.workflow-actions/v1" &&
        scope[2] === threadId &&
        scope[4] === selection.runId &&
        String(row.key).startsWith("step:")
      )
    })
    const matched = bindings
      .map((row) => ({
        scope: JSON.parse(String(row.namespace)) as string[],
        binding: record(JSON.parse(String(row.value)))
      }))
      .filter(
        ({ binding }) => !selection.executionId || binding.executionId === selection.executionId
      )
    assert.equal(matched.length, 1, "Select one actual immutable native action binding")
    const { scope, binding } = matched[0]
    const executionId = String(binding.executionId)
    assert(
      executionId && executionId !== "undefined",
      "Original immutable execution identity required"
    )
    const provider = record(binding.provider)
    assert.equal(provider.plugin, "test-verification")
    assert.equal(provider.actionId, "execute-e2e")
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex")
    const requestKey =
      "flow:" + hash([provider.pluginId, selection.runId, binding.stepId, executionId])
    const namespace = JSON.stringify(["native.platform/v1", scope[1], threadId, scope[3]])
    const key = "action:" + hash([provider.plugin, requestKey])
    const savedRows = rows.filter((row) => row.namespace === namespace && row.key === key)
    assert.equal(
      savedRows.length,
      1,
      "The immutable binding must join its original platform receipt"
    )
    const saved = record(JSON.parse(String(savedRows[0].value)))
    assert.equal(saved.providerDigest, provider.digest)
    const receipt = record(saved.result)
    assert.equal(
      receipt.status,
      "succeeded",
      "The original platform invocation physically returned"
    )
    const value = record(receipt.value)
    const output = record(value.output)
    assert.equal(output.runner, "node-test/v1")
    assert.equal(output.executionId, executionId)
    assert.equal(output.operationId === undefined, false)
    const counts = record(output.counts) as {
      total: number
      passed: number
      failed: number
      skipped: number
    }
    return { binding, receipt, status: value.status, output, counts }
  } finally {
    db.close()
  }
}
