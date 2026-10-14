import { expect, it } from "vitest"
import { FunctionPromptBroker } from "./prompt-broker"
import { applyPromptEdit, cumulativePromptEdit } from "../../../shared/mods/v2/prompt-edit"
import type { PromptEditRequest } from "../../../shared/mods/v2/prompt-composer"

function fixture() {
  const broker = new FunctionPromptBroker()
  broker.attach("t", "private", 1, () => {
    /* This suite tests the authenticated edit ingress. */
  })
  const request = (sequence = 1): PromptEditRequest => ({
    threadId: "t",
    owner: "private",
    sequence,
    input: cumulativePromptEdit({ text: "", cursor: 0 }, { text: "typed", cursor: 5 })
  })
  return { broker, request }
}
it("authenticates the actual sender and owner before the editing host runs", async () => {
  const f = fixture()
  let calls = 0
  const run = async () => {
    calls++
    return { text: "", cursor: 0 }
  }
  await expect(f.broker.edit(2, f.request(), run)).rejects.toThrow("MODS_PROMPT_EDITOR_OWNER")
  await expect(f.broker.edit(1, { ...f.request(), owner: "fake" }, run)).rejects.toThrow(
    "MODS_PROMPT_EDITOR_OWNER"
  )
  expect(calls).toBe(0)
})
it("invalid input consumes neither a sequence nor an editing scope", async () => {
  const f = fixture()
  await expect(
    f.broker.edit(
      1,
      { ...f.request(), input: { ...f.request().input, start: -1 } },
      async (input) => applyPromptEdit(input)
    )
  ).rejects.toThrow("MODS_PROMPT_EDIT_INPUT")
  expect(await f.broker.edit(1, f.request(), async (input) => applyPromptEdit(input))).toEqual({
    text: "typed",
    cursor: 5
  })
  await expect(
    f.broker.edit(1, f.request(), async (input) => applyPromptEdit(input))
  ).rejects.toThrow("MODS_PROMPT_EDIT_STALE")
})
it("rejects a superseded late reply without deleting the next owner request", async () => {
  const f = fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const first = f.broker.edit(1, f.request(), async (input) => {
    entered.resolve()
    await release.promise
    return applyPromptEdit(input)
  })
  const rejected = expect(first).rejects.toThrow("MODS_PROMPT_EDIT_SUPERSEDED")
  await entered.promise
  const second = await f.broker.edit(1, f.request(2), async (input) => applyPromptEdit(input))
  release.resolve()
  await rejected
  expect(second).toEqual({ text: "typed", cursor: 5 })
  expect(await f.broker.edit(1, f.request(3), async (input) => applyPromptEdit(input))).toEqual(
    second
  )
})
it.each(["detach", "destroy", "cancel"])("a real %s invalidates pending edits", async (end) => {
  const f = fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const first = f.broker.edit(1, f.request(), async (input) => {
    entered.resolve()
    await release.promise
    return applyPromptEdit(input)
  })
  const rejected = expect(first).rejects.toThrow(
    end === "cancel" ? "MODS_PROMPT_EDIT_CANCELLED" : "MODS_PROMPT_NO_COMPOSER"
  )
  await entered.promise
  if (end === "detach") f.broker.detach("t", "private", 1)
  else if (end === "destroy") f.broker.closeSender(1)
  else f.broker.cancelEdit(1, "t", "private", 1)
  release.resolve()
  await rejected
})
it("another sender cannot cancel work even with the current private token", async () => {
  const f = fixture()
  expect(() => f.broker.cancelEdit(2, "t", "private", 1)).toThrow("MODS_PROMPT_EDITOR_OWNER")
  expect(await f.broker.edit(1, f.request(), async (input) => applyPromptEdit(input))).toEqual({
    text: "typed",
    cursor: 5
  })
})
it("private metadata and malformed host results are rejected", async () => {
  const f = fixture()
  await expect(
    f.broker.edit(1, { ...f.request(), authority: "forged" } as PromptEditRequest, async (input) =>
      applyPromptEdit(input)
    )
  ).rejects.toThrow("MODS_PROMPT_EDIT_REQUEST")
  await expect(
    f.broker.edit(1, f.request(), async () => ({ text: "", cursor: 5 }))
  ).rejects.toThrow("MODS_PROMPT_EDIT_RESULT")
})
it("keeps the actual resulting caret private from the guest's native edit facts", async () => {
  const f = fixture()
  const request = { ...f.request(), nativeCursor: 1 }
  let privateCursor: number | undefined
  const result = await f.broker.edit(1, request, async (input, _signal, _guard, cursor) => {
    privateCursor = cursor
    expect(Object.keys(input)).not.toContain("nativeCursor")
    return { ...applyPromptEdit(input), cursor: cursor! }
  })
  expect(privateCursor).toBe(1)
  expect(result).toEqual({ text: "typed", cursor: 1 })
  await expect(
    f.broker.edit(1, { ...f.request(2), nativeCursor: 6 }, async (input) => applyPromptEdit(input))
  ).rejects.toThrow("MODS_PROMPT_EDIT_REQUEST")
})
