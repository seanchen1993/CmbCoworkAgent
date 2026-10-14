import { expect, it } from "vitest"
import { captureCurrentRunMessageQueueOwnerData, clearCurrentRunMessageQueue,
  setCurrentRunMessageQueueOwner } from "./current-run-message-queue"

it("captures the actual opaque queue identity and rejects equal-token ABA", () => {
  const threadId = "mention-owner-data-aba"
  setCurrentRunMessageQueueOwner(threadId, "actual")
  const original = captureCurrentRunMessageQueueOwnerData(threadId, "actual")
  original()
  setCurrentRunMessageQueueOwner(threadId, "successor")
  setCurrentRunMessageQueueOwner(threadId, "actual")
  expect(() => original()).toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
  const current = captureCurrentRunMessageQueueOwnerData(threadId, "actual")
  current()
  clearCurrentRunMessageQueue(threadId, "actual")
  expect(() => current()).toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
})
it("does not accept a public token without its real owner", () => {
  expect(() => captureCurrentRunMessageQueueOwnerData("unknown-mention", "same"))
    .toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
})
