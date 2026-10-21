import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))

import {
  cancelUserInputsForThread,
  hasPendingUserInputForRuntimeThread,
  hasPendingUserInputForThread,
  requestUserInput
} from "./user-input"

describe("child runtime user-input visibility", () => {
  it.each(["parent__worker__reviewer", "parent__workflow__run__agent"])(
    "finds a child question on %s without matching sibling IDs",
    async (id) => {
      const result = requestUserInput({
        threadId: id,
        questions: [],
        allowDeferredRenderer: true
      }).catch(() => undefined)
      try {
        expect(hasPendingUserInputForThread("parent")).toBe(false)
        expect(hasPendingUserInputForRuntimeThread("parent")).toBe(true)
        expect(hasPendingUserInputForRuntimeThread("paren")).toBe(false)
        expect(hasPendingUserInputForRuntimeThread("parent2")).toBe(false)
      } finally {
        cancelUserInputsForThread(id, "test cleanup")
        await result
      }
      expect(hasPendingUserInputForRuntimeThread("parent")).toBe(false)
    }
  )
})
