import { expect, it, vi } from "vitest"
import { persistAcceptedComposerPrompt } from "./mods-prompt-admission"

it("requires the exact accepted durable text and treats an existing identical row as accepted", () => {
  const write = vi.fn()
  expect(() =>
    persistAcceptedComposerPrompt("id", "rewritten", write, () => ({
      role: "user",
      content: "original"
    }))
  ).toThrow("MODS_PROMPT_SUBMIT_PERSISTENCE")
  expect(() =>
    persistAcceptedComposerPrompt("id", "rewritten", write, () => ({
      role: "user",
      content: "rewritten"
    }))
  ).not.toThrow()
  expect(() => persistAcceptedComposerPrompt("id", "rewritten", write, () => undefined)).toThrow(
    "MODS_PROMPT_SUBMIT_PERSISTENCE"
  )
})

it("propagates storage failures before read/ack and rejects empty submissions", () => {
  const read = vi.fn()
  expect(() =>
    persistAcceptedComposerPrompt(
      "id",
      "text",
      () => {
        throw Error("database unavailable")
      },
      read
    )
  ).toThrow("database unavailable")
  expect(read).not.toHaveBeenCalled()
  const write = vi.fn()
  expect(() => persistAcceptedComposerPrompt("id", " ", write, read)).toThrow(
    "MODS_PROMPT_SUBMIT_EMPTY"
  )
  expect(write).not.toHaveBeenCalled()
})
