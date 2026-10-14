import { expect, it } from "vitest"
import { FunctionPromptBroker, type FunctionPromptScope } from "./prompt-broker"
import {
  fillPromptSnapshot,
  type PromptComposerRequest,
  type PromptComposerSnapshot
} from "../../../shared/mods/v2/prompt-composer"

function fixture() {
  const broker = new FunctionPromptBroker()
  const controller = new AbortController()
  let live = true
  const scope: FunctionPromptScope = {
    threadId: "t",
    pluginId: "p",
    sessionId: "s",
    signal: controller.signal,
    assertLive: () => {
      if (!live) throw Error("revoked")
    }
  }
  const requests: PromptComposerRequest[] = []
  let snapshot: PromptComposerSnapshot = { text: "old", cursor: 1, revision: 1 }
  const attach = (owner = "owner") =>
    broker.attach("t", owner, 1, (request) => requests.push(request))
  const answer = (request = requests.at(-1)!, sender = 1) => {
    if (request.kind === "fill")
      broker.authorize(sender, request.requestId, request.threadId, request.owner)
    const status =
      request.kind === "fill" && request.expectedRevision !== snapshot.revision ? "conflict" : "ok"
    if (request.kind === "fill" && status === "ok")
      snapshot = {
        ...fillPromptSnapshot(snapshot, request.text!, request.mode!),
        revision: snapshot.revision + 1
      }
    broker.respond(sender, { ...request, ...snapshot, status })
  }
  attach()
  return {
    broker,
    scope,
    controller,
    requests,
    attach,
    answer,
    revoke: () => {
      live = false
    },
    edit: () => {
      snapshot = { ...snapshot, text: "user edit", revision: snapshot.revision + 1 }
    }
  }
}
it("pins the original read version and refuses a user edit without overwriting", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.answer()
  expect(await reading).toEqual({ text: "old", cursor: 1 })
  f.edit()
  const fill = f.broker.fill(f.scope, { text: "plugin" })
  f.answer()
  expect(await fill).toEqual({ isFilled: false, text: "user edit", cursor: 1 })
  expect(f.requests.at(-1)?.expectedRevision).toBe(1)
})
it("captures a suggestion's renderer before hooks and requires an authorized real acknowledgement", async () => {
  const f = fixture(), preparing = f.broker.prepareSuggestion(f.scope)
  f.answer()
  const offer = await preparing
  const result = offer({ text: "next" }, f.scope.signal)
  const request = f.requests.at(-1)!
  expect(request).toMatchObject({ kind: "suggest", expectedRevision: 1 })
  expect(f.broker.authorize(1, request.requestId, "t", "owner")).toBe(true)
  f.broker.respond(1, { ...request, text: "", cursor: 0, revision: 1, status: "ok", isShown: true })
  expect(await result).toEqual({ isShown: true })
})
it("a suggestion cannot migrate to a newly mounted renderer after its hook awaited", async () => {
  const f = fixture(), preparing = f.broker.prepareSuggestion(f.scope)
  f.answer()
  const offer = await preparing
  f.attach("replacement")
  expect(await offer({ text: "late" }, f.scope.signal)).toEqual({ isShown: false })
  expect(f.requests).toHaveLength(1)
})
it("does not accept an unauthorized suggestion success", async () => {
  const f = fixture(), preparing = f.broker.prepareSuggestion(f.scope)
  f.answer()
  const offer = await preparing
  const result = offer({ text: "next" }, f.scope.signal)
  const rejected = expect(result).rejects.toThrow("MODS_PROMPT_RESPONSE_INVALID")
  f.broker.respond(1, { ...f.requests.at(-1)!, text: "", cursor: 0, revision: 1, status: "ok", isShown: true })
  await rejected
})
it("a dialog preparation keeps its private revision even when text is hidden", async () => {
  const f = fixture(), preparing = f.broker.prepareSuggestion(f.scope)
  f.broker.respond(1, { ...f.requests.at(-1)!, text: "", cursor: 0, revision: 19, status: "dialog" })
  const offer = await preparing
  const result = offer({ text: "next" }, f.scope.signal)
  const request = f.requests.at(-1)!
  expect(request.expectedRevision).toBe(19)
  expect(f.broker.authorize(1, request.requestId, "t", "owner")).toBe(true)
  f.broker.respond(1, { ...request, text: "", cursor: 0, revision: 21, status: "ok", isShown: false })
  expect(await result).toEqual({ isShown: false })
})
it("an unprimed fill reads and CAS applies in two separate requests", async () => {
  const f = fixture(),
    fill = f.broker.fill(f.scope, { text: "!", mode: "insert" })
  expect(f.requests.at(-1)?.kind).toBe("read")
  f.answer()
  await Promise.resolve()
  expect(f.requests.at(-1)?.kind).toBe("fill")
  f.answer()
  expect(await fill).toEqual({ isFilled: true, text: "o!ld", cursor: 2 })
})
it("does not reuse a read across composer owner changes", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.answer()
  await reading
  f.attach("other")
  expect(await f.broker.fill(f.scope, { text: "new" })).toMatchObject({
    isFilled: false,
    refusal: "no_composer"
  })
  expect(f.requests).toHaveLength(1)
})
it("empty reads without a composer cannot authorize a subsequently mounted draft", async () => {
  const f = fixture()
  f.broker.detach("t", "owner", 1)
  expect(await f.broker.read(f.scope)).toEqual({ text: "", cursor: 0 })
  f.attach("new")
  expect(await f.broker.fill(f.scope, { text: "overwrite" })).toEqual({
    isFilled: false,
    refusal: "no_composer",
    text: "",
    cursor: 0
  })
  expect(f.requests).toHaveLength(0)
})
it("captures before a fill hook and never refreshes the CAS lease through a peek", async () => {
  const f = fixture(),
    preparing = f.broker.prepareFill(f.scope)
  f.answer()
  await preparing
  f.edit()
  const peeking = f.broker.peek(f.scope)
  f.answer()
  expect(await peeking).toMatchObject({ text: "user edit" })
  await f.broker.prepareFill(f.scope)
  const filling = f.broker.fill(f.scope, { text: "late hook" })
  expect(f.requests.at(-1)?.expectedRevision).toBe(1)
  f.answer()
  expect(await filling).toMatchObject({ isFilled: false, text: "user edit" })
})
it("rejects cancellation, late publication, and wrong renderer replies", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.answer(f.requests[0], 99)
  f.controller.abort()
  await expect(reading).rejects.toThrow("MODS_CANCELLED")
  f.answer()
  await expect(f.broker.fill(f.scope, { text: "new" })).rejects.toThrow()
})
it("rechecks authority on a reply and on a new request", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.revoke()
  f.answer()
  await expect(reading).rejects.toThrow("revoked")
  await expect(f.broker.fill(f.scope, { text: "new" })).rejects.toThrow("revoked")
  expect(f.requests).toHaveLength(1)
})
it("clears pending calls when the host session is closed", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.broker.closeSession("s")
  await expect(reading).rejects.toThrow("MODS_CANCELLED")
  f.broker.close()
})
it("a composer unmount during read returns an empty box and blocks an old owner write", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.broker.detach("t", "owner", 1)
  expect(await reading).toEqual({ text: "", cursor: 0 })
  f.attach("next")
  expect(await f.broker.fill(f.scope, { text: "old session" })).toMatchObject({
    isFilled: false,
    refusal: "no_composer"
  })
})
it("sender cleanup preserves old read tombstones and never removes another sender", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.answer()
  await reading
  const otherRequests: PromptComposerRequest[] = []
  f.broker.attach("other-thread", "other-owner", 2, (request) => otherRequests.push(request))
  f.broker.closeSender(1)
  f.broker.attach("t", "new-owner", 2, (request) => otherRequests.push(request))
  expect(await f.broker.fill(f.scope, { text: "stale" })).toMatchObject({
    isFilled: false,
    refusal: "no_composer"
  })
  const otherScope = { ...f.scope, threadId: "other-thread", sessionId: "other-session" }
  const otherRead = f.broker.read(otherScope)
  const request = otherRequests.at(-1)!
  f.broker.respond(2, { ...request, status: "ok", text: "still live", cursor: 10, revision: 1 })
  expect(await otherRead).toEqual({ text: "still live", cursor: 10 })
  f.broker.close()
})
it("requires a live one-shot precommit permit and rejects permits after cancellation", async () => {
  const f = fixture(),
    reading = f.broker.read(f.scope)
  f.answer()
  await reading
  const filling = f.broker.fill(f.scope, { text: "new" })
  const request = f.requests.at(-1)!
  expect(f.broker.authorize(99, request.requestId, "t", "owner")).toBe(false)
  f.controller.abort()
  expect(f.broker.authorize(1, request.requestId, "t", "owner")).toBe(false)
  await expect(filling).rejects.toThrow("MODS_CANCELLED")
})
it("returns only official refusal literals and validates untrusted cursor data", async () => {
  const f = fixture()
  const fill = f.broker.fill(f.scope, { text: "new" })
  f.broker.respond(1, { ...f.requests.at(-1)!, status: "dialog", text: "", cursor: 0, revision: 0 })
  expect(await fill).toEqual({ isFilled: false, refusal: "dialog", text: "", cursor: 0 })
  const reading = f.broker.read(f.scope)
  f.broker.respond(1, { ...f.requests.at(-1)!, status: "ok", text: "a", cursor: 2, revision: 1 })
  await expect(reading).rejects.toThrow("RESPONSE_INVALID")
})
