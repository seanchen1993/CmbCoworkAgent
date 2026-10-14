import { expect, it } from "vitest"
import type { Message } from "../types"
import { mergeSchedulerTurnMessageSnapshot } from "./scheduler-message-snapshot"
import { areMessageRenderFieldsEqual } from "./message-render-stability"

it("retains the native source through a live scheduler prefix and ordinary completion snapshots", () => {
  const origin = { kind: "plugin" as const, name: "actual", asUser: true as const }
  const human: Message = {
    id: "human",
    role: "user",
    content: "actual text",
    prompt_origin: origin,
    created_at: new Date(1)
  }
  const live = mergeSchedulerTurnMessageSnapshot([], [human])
  const final = mergeSchedulerTurnMessageSnapshot(live.messages, [
    { id: "human", role: "user", content: "actual text" },
    { id: "answer", role: "assistant", content: "done" }
  ])
  expect(final.messages[0].prompt_origin).toEqual(origin)
  expect(final.messages[0].content).toBe("actual text")
  expect(final.messages[1].prompt_origin).toBeUndefined()
})

it("updates an already mounted bubble when a durable source arrives after its initial contents", () => {
  const message: Message = { id: "human", role: "user", content: "words", created_at: new Date(1) }
  const source = { kind: "plugin" as const, name: "actual" }
  expect(areMessageRenderFieldsEqual(message, { ...message, prompt_origin: source })).toBe(false)
  expect(
    areMessageRenderFieldsEqual(
      { ...message, prompt_origin: source },
      {
        ...message,
        prompt_origin: { ...source }
      }
    )
  ).toBe(true)
  expect(
    areMessageRenderFieldsEqual(
      { ...message, prompt_origin: source },
      {
        ...message,
        prompt_origin: { ...source, name: "another" }
      }
    )
  ).toBe(false)
})
