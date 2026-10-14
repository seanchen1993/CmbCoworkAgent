import { expect, it, vi } from "vitest"
import { FunctionDesktopBroker } from "./desktop-broker"
import type { DesktopRequest } from "../../../shared/mods/v2/desktop-actions"

function fixture() {
  const requests: DesktopRequest[] = [],
    written = vi.fn()
  const broker = new FunctionDesktopBroker(written),
    controller = new AbortController()
  let live = true
  const scope = {
    threadId: "t",
    pluginId: "plugin",
    sessionId: "s",
    signal: controller.signal,
    assertLive: () => {
      if (!live) throw Error("binding changed")
    }
  }
  broker.attach("t", "owner", 1, (request) => requests.push(request))
  const answer = (
    selection: { text: string; requestId?: string } | null = null,
    present = true
  ) => {
    const { threadId, owner, requestId } = requests.at(-1)!
    broker.respond(1, { threadId, owner, requestId, present, revision: 7, selection })
  }
  const prepare = async () => {
    const preparing = broker.capture(scope)
    answer()
    return preparing
  }
  return {
    broker,
    scope,
    controller,
    requests,
    written,
    answer,
    prepare,
    revoke: () => {
      live = false
    }
  }
}
it("copies only after the actual sender commits the one-shot private request", async () => {
  const f = fixture(),
    access = await f.prepare()
  const copied = access.copy({ text: "actual text", surface: "desktop" }, f.scope.signal)
  const request = f.requests.at(-1)!
  expect(request).not.toHaveProperty("text")
  expect(() => f.broker.commitCopy(2, "t", "owner", request.requestId, true)).toThrow("OWNER")
  expect(f.written).not.toHaveBeenCalled()
  f.broker.commitCopy(1, "t", "owner", request.requestId, true)
  expect(await copied).toEqual({ isCopied: true })
  expect(f.written).toHaveBeenCalledExactlyOnceWith("actual text")
  expect(() => f.broker.commitCopy(1, "t", "owner", request.requestId, true)).toThrow("OWNER")
})
it("refuses unsupported and hidden surfaces without touching the clipboard", async () => {
  const f = fixture(),
    access = await f.prepare()
  expect(await access.copy({ text: "remote", surface: "mobile" }, f.scope.signal)).toEqual({
    isCopied: false,
    reason: "no-surface"
  })
  const copied = access.copy({ text: "hidden", surface: "desktop" }, f.scope.signal)
  f.broker.commitCopy(1, "t", "owner", f.requests.at(-1)!.requestId, false)
  expect(await copied).toEqual({ isCopied: false, reason: "no-surface" })
  expect(f.written).not.toHaveBeenCalled()
})
it("native clipboard failure is a real no-clipboard receipt", async () => {
  const f = fixture(),
    access = await f.prepare()
  f.written.mockImplementation(() => {
    throw Error("clipboard unavailable")
  })
  const copied = access.copy({ text: "text", surface: "desktop" }, f.scope.signal)
  f.broker.commitCopy(1, "t", "owner", f.requests.at(-1)!.requestId, true)
  expect(await copied).toEqual({ isCopied: false, reason: "no-clipboard" })
})
it.each(["cancel", "binding", "detach"])(
  "%s before the native write causes zero clipboard effects",
  async (kind) => {
    const f = fixture(),
      access = await f.prepare()
    const copied = access.copy({ text: "late", surface: "desktop" }, f.scope.signal)
    const rejected = expect(copied).rejects.toThrow()
    const request = f.requests.at(-1)!
    if (kind === "cancel") f.controller.abort()
    else if (kind === "binding") f.revoke()
    else f.broker.detach("t", "owner", 1)
    try {
      f.broker.commitCopy(1, "t", "owner", request.requestId, true)
    } catch {
      /* An expired owner cannot write. */
    }
    await rejected
    expect(f.written).not.toHaveBeenCalled()
  }
)
it("a captured operation cannot migrate to a replacement renderer", async () => {
  const f = fixture(),
    access = await f.prepare()
  f.broker.attach("t", "replacement", 1, (request) => f.requests.push(request))
  await expect(access.copy({ text: "late", surface: "desktop" }, f.scope.signal)).rejects.toThrow(
    "OWNER"
  )
  expect(f.requests).toHaveLength(1)
  expect(f.written).not.toHaveBeenCalled()
})
it("aborting the original execution retires a pending call with its own signal", async () => {
  const f = fixture(),
    access = await f.prepare(),
    call = new AbortController()
  const copied = access.copy({ text: "late", surface: "desktop" }, call.signal)
  const rejected = expect(copied).rejects.toThrow("CANCELLED")
  const request = f.requests.at(-1)!
  f.controller.abort()
  expect(() => f.broker.commitCopy(1, "t", "owner", request.requestId, true)).toThrow("OWNER")
  await rejected
  expect(f.written).not.toHaveBeenCalled()
})
it("reads only the authenticated visible selection and keeps the old clear revision private", async () => {
  const f = fixture(),
    access = await f.prepare()
  const selected = access.selection(f.scope.signal)
  f.answer({ text: "chosen", requestId: "actual-row" })
  expect(await selected).toEqual({ text: "chosen", requestId: "actual-row" })
  const clearing = access.clearSelection(f.scope.signal)
  expect(f.requests.at(-1)).toMatchObject({ kind: "clear-selection", revision: 7 })
  f.answer()
  await clearing
  const empty = access.selection(f.scope.signal)
  f.answer(null)
  expect(await empty).toBeUndefined()
})
it("missing UI is a normal empty result and never synthesizes a drawing or clipboard success", async () => {
  const f = fixture()
  f.broker.close()
  const access = await f.broker.capture(f.scope)
  expect(await access.selection(f.scope.signal)).toBeUndefined()
  expect(await access.copy({ text: "x", surface: "desktop" }, f.scope.signal)).toEqual({
    isCopied: false,
    reason: "no-surface"
  })
  expect(f.requests).toHaveLength(0)
})
it("cancelled command cleanup only forgets its original private selection revision", async () => {
  const f = fixture(),
    access = await f.prepare()
  f.controller.abort()
  const clear = access.clearSelection(f.scope.signal)
  expect(f.requests.at(-1)).toMatchObject({ kind: "clear-selection", revision: 7 })
  f.answer()
  await clear
  await expect(access.selection(f.scope.signal)).rejects.toThrow()
  expect(f.written).not.toHaveBeenCalled()
})
