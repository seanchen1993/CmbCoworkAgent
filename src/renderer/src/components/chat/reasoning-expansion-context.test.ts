import { describe, expect, it } from "vitest"
import {
  advanceReasoningExpansion,
  rememberReasoningExpansion,
  ReasoningExpansionStore,
  type ReasoningExpansionState
} from "./reasoning-expansion-context"

const initial: ReasoningExpansionState = {
  open: false,
  autoOpened: false,
  autoCollapsed: false
}

describe("reasoning expansion preserves the existing one-shot lifecycle", () => {
  it("opens the first reasoning snapshot and leaves subsequent tokens unchanged", () => {
    const opened = advanceReasoningExpansion(initial, true, true, false)
    expect(opened).toEqual({ open: true, autoOpened: true, autoCollapsed: false })
    for (let token = 0; token < 10000; token++) {
      expect(advanceReasoningExpansion(opened, true, true, false)).toBe(opened)
    }
  })

  it("collapses when an answer starts even after the user explicitly reopened thinking", () => {
    const opened = advanceReasoningExpansion(initial, true, true, false)
    const manuallyClosed = { ...opened, open: false }
    expect(advanceReasoningExpansion(manuallyClosed, true, true, false)).toBe(manuallyClosed)
    const manuallyReopened = { ...manuallyClosed, open: true }
    const answered = advanceReasoningExpansion(manuallyReopened, true, true, true)
    expect(answered).toEqual({ open: false, autoOpened: true, autoCollapsed: true })
  })

  it("does not collapse a manual expansion again after the answer has started", () => {
    const answered = advanceReasoningExpansion(initial, true, true, true)
    const manuallyOpened = { ...answered, open: true }
    expect(advanceReasoningExpansion(manuallyOpened, true, true, true)).toBe(manuallyOpened)
    expect(advanceReasoningExpansion(manuallyOpened, true, false, true)).toBe(manuallyOpened)
  })

  it("applies open and collapse together when the first frame includes reasoning and body", () => {
    expect(advanceReasoningExpansion(initial, true, true, true)).toEqual({
      open: false,
      autoOpened: true,
      autoCollapsed: true
    })
  })

  it("retains a completed reasoning-only message and the state of historical messages", () => {
    const opened = advanceReasoningExpansion(initial, true, true, false)
    expect(advanceReasoningExpansion(opened, true, false, false)).toBe(opened)
    expect(advanceReasoningExpansion(initial, true, false, false)).toBe(initial)
    expect(advanceReasoningExpansion(initial, false, true, false)).toBe(initial)
  })

  it("does not reapply either automatic action to restored virtual-row state", () => {
    const closed = { open: false, autoOpened: true, autoCollapsed: false }
    expect(advanceReasoningExpansion(closed, true, true, false)).toBe(closed)
    const reopened = { open: true, autoOpened: true, autoCollapsed: true }
    expect(advanceReasoningExpansion(reopened, true, true, true)).toBe(reopened)
  })

  it("catches up the answer phase when a reasoning row completes while unmounted", () => {
    const opened = advanceReasoningExpansion(initial, true, true, false)
    const completed = advanceReasoningExpansion(opened, true, false, true)
    expect(completed).toEqual({ open: false, autoOpened: true, autoCollapsed: true })
    const manuallyReopened = { ...completed, open: true }
    expect(advanceReasoningExpansion(manuallyReopened, true, false, true)).toBe(manuallyReopened)
  })

  it("does not auto-collapse a manually expanded historical answer", () => {
    const historical = { ...initial, open: true }
    expect(advanceReasoningExpansion(historical, true, false, true)).toBe(historical)
  })

  it("bounds retained choices and keeps recently used messages across history paging", () => {
    const choices = new ReasoningExpansionStore()
    for (let message = 0; message < 500; message++) {
      rememberReasoningExpansion(choices, String(message), initial)
    }
    const expanded = { ...initial, open: true }
    rememberReasoningExpansion(choices, "0", expanded)
    rememberReasoningExpansion(choices, "500", initial)
    expect(choices.size).toBe(500)
    expect(choices.get("0")?.state).toBe(expanded)
    expect(choices.has("1")).toBe(false)
    for (let message = 501; message < 10000; message++) {
      rememberReasoningExpansion(choices, String(message), initial)
    }
    expect(choices.size).toBe(500)
    expect(choices.has("9499")).toBe(false)
    expect(choices.get("9500")?.state).toBe(initial)
  })

  it("rejects stale writes after discard and preserves unrelated history", () => {
    const choices = new ReasoningExpansionStore()
    const answered = advanceReasoningExpansion(initial, true, true, true)
    const historical = { ...initial, open: true }
    rememberReasoningExpansion(choices, "one:assistant:retry", answered)
    rememberReasoningExpansion(choices, "one:assistant:history", historical)
    rememberReasoningExpansion(choices, "two:assistant:retry", historical)
    choices.discardMessages("one", new Set(["retry"]), 1)
    expect(choices.has("one:assistant:retry")).toBe(false)
    // An old Virtuoso closure can commit old body props before the replacement arrives.
    rememberReasoningExpansion(choices, "one:assistant:retry", answered, 0, 0)
    expect(choices.has("one:assistant:retry")).toBe(false)
    const retried = advanceReasoningExpansion(initial, true, true, false)
    rememberReasoningExpansion(choices, "one:assistant:retry", retried, 1, 1)
    rememberReasoningExpansion(choices, "one:assistant:retry", answered, 0, 0)
    expect(choices.get("one:assistant:retry")).toEqual({ generation: 1, state: retried })
    expect(choices.get("one:assistant:history")?.state).toBe(historical)
    expect(choices.get("two:assistant:retry")?.state).toBe(historical)
  })
})
