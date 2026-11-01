import assert from "node:assert/strict"

/** Public operation lists are not an append-only sequence; bind to the prepared stage/version. */
export function selectLiveStageOperation<
  T extends { stageId: string; expectedVersion: number; status: string; operationId?: string }
>(
  operations: T[],
  stageId: string,
  expectedVersion: number,
  previousOperationIds: string[] = []
): T {
  const matches = operations.filter(
    (operation) =>
      operation.stageId === stageId &&
      operation.expectedVersion === expectedVersion &&
      ["prepared", "approved", "started", "succeeded"].includes(operation.status) &&
      (!operation.operationId || !previousOperationIds.includes(operation.operationId))
  )
  assert.equal(matches.length, 1, "LIVE_STAGE_OPERATION_NOT_UNIQUE")
  return matches[0]
}
