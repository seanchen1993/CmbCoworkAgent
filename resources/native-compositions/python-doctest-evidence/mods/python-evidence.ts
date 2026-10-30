// Native JSON fields remain subject to the existing field-by-field runtime checks.
type EvidenceRecord = Record<string, any>
/** Native pages sort hashed storage keys. Only the original fixed script's receipts.push order
 * establishes chronology; callers first verify that run's script SHA and exact action coverage. */
export function workflowReceiptOrder(actions: EvidenceRecord[], executionIds: string[]) {
  const byId = new Map<string, EvidenceRecord>(
    actions.map((action) => [action.executionId, action])
  )
  if (
    !Array.isArray(executionIds) ||
    byId.size !== actions.length ||
    executionIds.length !== actions.length ||
    new Set(executionIds).size !== executionIds.length ||
    executionIds.some((id) => !byId.has(id))
  )
    throw Error("AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE")
  return executionIds.map((id) => byId.get(id)!)
}

/** Receives the verified original workflow order, never native storage-key order. */
export function assertPythonTestCompilation(actions: EvidenceRecord[], record: EvidenceRecord) {
  const index = actions.indexOf(record)
  const taskKey = (ids: unknown) => (Array.isArray(ids) ? JSON.stringify([...ids].sort()) : null)
  const latest = actions
    .slice(0, index)
    .filter(
      (item) =>
        item.provider?.actionId === "execute-command" &&
        item.output?.phase === "compile" &&
        item.output.executionAdapter === "python-doctest/v1" &&
        item.output.workspaceRef === record.output.workspaceRef &&
        taskKey(item.output.taskIds) !== null &&
        taskKey(item.output.taskIds) === taskKey(record.output.taskIds)
    )
    .at(-1)
  const compiled = latest?.status === "succeeded" ? latest.output?.compilation : null
  if (
    !compiled ||
    compiled.mode !== "python-pycompile" ||
    compiled.passed !== true ||
    JSON.stringify(compiled.files) !== JSON.stringify(record.output.test.subjects) ||
    compiled.sourceFingerprint !== record.output.test.subjectFingerprint
  )
    throw Error("LEAN_COMPILE_TEST_SOURCE_CHANGED")
}
