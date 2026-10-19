import { expect, it } from "vitest"
import { isCreatorBudgetError, readCreatorBudgetErrorCode } from "./creator-model-accounting"

it("retains the exact local native budget/scope code through SDK causes", () => {
  for (const code of [
    "DEVELOPMENT_MODEL_ATTEMPT_BUDGET",
    "DEVELOPMENT_SCOPE_CHANGED",
    "DEVELOPMENT_MODEL_COST_UNSUPPORTED"
  ]) {
    expect(readCreatorBudgetErrorCode(new Error("SDK wrapper", { cause: new Error(code) }))).toBe(
      code
    )
    expect(isCreatorBudgetError(new Error(code))).toBe(true)
  }
})

it("does not mistake remote HTTP codes, copied data or substring prose for local billing authority", () => {
  expect(
    readCreatorBudgetErrorCode(
      Object.assign(new Error("DEVELOPMENT_MODEL_ATTEMPT_BUDGET"), { status: 502 })
    )
  ).toBeUndefined()
  expect(
    readCreatorBudgetErrorCode({ message: "DEVELOPMENT_MODEL_ATTEMPT_BUDGET" })
  ).toBeUndefined()
  expect(
    readCreatorBudgetErrorCode(new Error("remote says DEVELOPMENT_MODEL_ATTEMPT_BUDGET"))
  ).toBeUndefined()
  const error = new Error("cycle")
  Object.defineProperty(error, "cause", { value: error })
  expect(isCreatorBudgetError(error)).toBe(false)
})
