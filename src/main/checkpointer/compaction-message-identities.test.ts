import { HumanMessage, RemoveMessage } from "@langchain/core/messages"
import { expect, it } from "vitest"
import { prepareCompactionMessageIdentities } from "./compaction-message-identities"

it("uses the original SDK to fill a missing ID once while retaining the shared event reference", () => {
  const summary = new HumanMessage({ content: "actual summary",
    additional_kwargs: { lc_source: "summarization", privatePayload: { retained: true } } })
  const event = { summaryMessage: summary }, payload = summary.additional_kwargs
  expect(summary.id).toBeUndefined()
  const messages = prepareCompactionMessageIdentities([summary])
  expect(messages[0]).toBe(summary)
  expect(Object.isFrozen(messages)).toBe(true)
  expect(summary.id).toEqual(expect.any(String))
  expect(summary.lc_kwargs.id).toBe(summary.id)
  expect(event.summaryMessage).toBe(summary)
  expect(summary.additional_kwargs).toBe(payload)
  const id = summary.id
  prepareCompactionMessageIdentities(messages)
  expect(summary.id).toBe(id)
})

it("preserves the exact RemoveAll behavior for existing duplicate IDs and native payload", () => {
  const first = new HumanMessage({ id: "same-provider-id", content: "first",
    additional_kwargs: { function_row: { retained: true } } })
  const second = new HumanMessage({ id: "same-provider-id", content: "second" })
  const before = [first, second].map(message => message.toDict())
  const prepared = prepareCompactionMessageIdentities([first, second])
  expect(prepared).toHaveLength(2)
  expect(prepared[0]).toBe(first)
  expect(prepared[1]).toBe(second)
  expect(prepared.map(message => message.toDict())).toEqual(before)
})

it("rejects message removal controls and untyped inputs before mutating a legitimate message", () => {
  const summary = new HumanMessage("unchanged")
  for (const bad of [null, {}, [summary, {}], [summary, new RemoveMessage({ id: "__remove_all__" })],
    [summary, new RemoveMessage({ id: "remove-original" })]])
    expect(() => prepareCompactionMessageIdentities(bad)).toThrow("COMPACTION_BOUNDARY")
  expect(summary.id).toBeUndefined()
})
