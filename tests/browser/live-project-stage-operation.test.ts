import { expect, it } from "vitest"
import { selectLiveStageOperation } from "../support/live-project-stage-operation"

it("selects the newly prepared stage from either public operation order", () => {
  const baseline = { stageId: "baseline", expectedVersion: 1, status: "transitioned" }
  const definition = { stageId: "definition", expectedVersion: 2, status: "prepared" }
  for (const operations of [
    [definition, baseline],
    [baseline, definition]
  ])
    expect(selectLiveStageOperation(operations, "definition", 2)).toBe(definition)
})

it("does not reuse a historical attempt for the same stage", () => {
  const old = { stageId: "definition", expectedVersion: 2, status: "failed" }
  const current = { stageId: "definition", expectedVersion: 3, status: "started" }
  expect(selectLiveStageOperation([current, old], "definition", 3)).toBe(current)
  expect(() => selectLiveStageOperation([old], "definition", 3)).toThrow(
    "LIVE_STAGE_OPERATION_NOT_UNIQUE"
  )
})

it("fails closed on ambiguous or terminal operations instead of starting another stage", () => {
  const operation = { stageId: "definition", expectedVersion: 2, status: "prepared" }
  expect(() => selectLiveStageOperation([operation, { ...operation }], "definition", 2)).toThrow(
    "LIVE_STAGE_OPERATION_NOT_UNIQUE"
  )
  expect(() =>
    selectLiveStageOperation([{ ...operation, status: "transitioned" }], "definition", 2)
  ).toThrow("LIVE_STAGE_OPERATION_NOT_UNIQUE")
})

it("binds a retry to its new operation identity while retaining same-version failed history", () => {
  const old = { operationId: "old", stageId: "definition", expectedVersion: 2, status: "failed" }
  const current = { ...old, operationId: "new", status: "prepared" }
  expect(selectLiveStageOperation([old, current], "definition", 2, ["old"])).toBe(current)
  expect(() => selectLiveStageOperation([current], "definition", 2, ["new"])).toThrow(
    "LIVE_STAGE_OPERATION_NOT_UNIQUE"
  )
})
