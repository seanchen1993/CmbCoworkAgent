import { expect, it } from "vitest"
import { readFlowTaskDraft, setFlowTaskDraft } from "./flow-task-draft"

it("keeps flow drafts separate by chat and workspace, and clears only an explicit scope", () => {
  setFlowTaskDraft("a", "one", "first")
  setFlowTaskDraft("b", "one", "second")
  expect(readFlowTaskDraft("a", "two")).toBe("")
  expect(readFlowTaskDraft("a", "one")).toBe("first")
  setFlowTaskDraft("a", "one", "")
  expect(readFlowTaskDraft("a", "one")).toBe("")
  expect(readFlowTaskDraft("b", "one")).toBe("second")
})
