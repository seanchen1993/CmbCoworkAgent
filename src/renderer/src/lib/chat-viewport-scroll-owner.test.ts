import { expect, it, vi } from "vitest"
import type { VirtuosoHandle } from "react-virtuoso"
import { claimChatViewportScrollOwner, canOwnDetachedChatViewport,
  hasChatViewportScrollOwner, subscribeChatViewportScrollOwners } from "../components/chat/chat-viewport-scroll-owner"
import { acquireChatExternalScrollAnchor } from "../components/chat/chat-external-scroll-anchor"

const viewport = () => new EventTarget() as HTMLElement

it("keeps per-viewport search and restoration priority ahead of detached reading", () => {
  const first = viewport(), other = viewport()
  const read = claimChatViewportScrollOwner(first, "detached")
  expect(canOwnDetachedChatViewport(first)).toBe(true)
  for (const kind of ["search", "session-restore", "history-restore"] as const) {
    const owner = claimChatViewportScrollOwner(first, kind)
    expect(canOwnDetachedChatViewport(first)).toBe(false)
    expect(canOwnDetachedChatViewport(other)).toBe(true)
    owner.release()
  }
  expect(canOwnDetachedChatViewport(first)).toBe(true)
  read.release()
})

it("an old release never clears a newer owner of the same kind or publishes an idle handoff", () => {
  const view = viewport(), changed = vi.fn()
  const stop = subscribeChatViewportScrollOwners(view, changed)
  const first = claimChatViewportScrollOwner(view, "session-restore")
  const second = claimChatViewportScrollOwner(view, "session-restore")
  expect(first.current()).toBe(false)
  expect(first.release()).toBe(false)
  expect(hasChatViewportScrollOwner(view, "session-restore")).toBe(true)
  expect(changed.mock.calls).toEqual([["session-restore", true], ["session-restore", true]])
  second.release(); second.release()
  expect(changed.mock.calls.at(-1)).toEqual(["session-restore", false])
  expect(changed).toHaveBeenCalledTimes(3)
  stop()
})

it("retains overlapping native tokens and captures the original handle for every cleanup", () => {
  const view = viewport(), original = { setExternalScrollAnchor: vi.fn() }
  const replacement = { setExternalScrollAnchor: vi.fn() }
  const releaseFirst = acquireChatExternalScrollAnchor(original as unknown as VirtuosoHandle,
    view, "session-restore")
  const releaseSecond = acquireChatExternalScrollAnchor(original as unknown as VirtuosoHandle,
    view, "history-restore")
  releaseFirst()
  expect(canOwnDetachedChatViewport(view)).toBe(false)
  expect(replacement.setExternalScrollAnchor).not.toHaveBeenCalled()
  releaseSecond(); releaseSecond()
  expect(canOwnDetachedChatViewport(view)).toBe(true)
  const calls = original.setExternalScrollAnchor.mock.calls.map(([value]) => value)
  expect(calls).toHaveLength(4)
  expect(calls[0].owner).toBe(calls[2].owner)
  expect(calls[1].owner).toBe(calls[3].owner)
  expect(calls[0].owner).not.toBe(calls[1].owner)
})

it("does not leave logical restoration ownership when native acquisition fails", () => {
  const view = viewport(), handle = { setExternalScrollAnchor: () => { throw Error("disposed handle") } }
  expect(() => acquireChatExternalScrollAnchor(handle as unknown as VirtuosoHandle,
    view, "session-restore")).toThrow("disposed handle")
  expect(canOwnDetachedChatViewport(view)).toBe(true)
})

it("isolates observer exceptions during claim and releases the captured native token despite failed geometry", () => {
  const view = viewport(), handle = { setExternalScrollAnchor: vi.fn() }
  const stop = subscribeChatViewportScrollOwners(view, () => { throw Error("geometry observer failed") })
  let release: () => void = () => {}
  expect(() => { release = acquireChatExternalScrollAnchor(handle as unknown as VirtuosoHandle,
    view, "session-restore") }).not.toThrow()
  expect(() => release()).not.toThrow()
  expect(handle.setExternalScrollAnchor.mock.calls.map(([value]) => value.active)).toEqual([true, false])
  expect(canOwnDetachedChatViewport(view)).toBe(true)
  stop()
})

it("preserves a reentrant replacement owner and handle when a preceding release observer throws", () => {
  const view = viewport(), oldHandle = { setExternalScrollAnchor: vi.fn() }
  const newHandle = { setExternalScrollAnchor: vi.fn() }
  let replacement: (() => void) | undefined
  const stopFirst = subscribeChatViewportScrollOwners(view, (_kind, active) => {
    if (!active) throw Error("old geometry failed")
  })
  const stopSecond = subscribeChatViewportScrollOwners(view, (kind, active) => {
    if (kind === "history-restore" && !active && !replacement)
      replacement = acquireChatExternalScrollAnchor(newHandle as unknown as VirtuosoHandle, view, "history-restore")
  })
  const release = acquireChatExternalScrollAnchor(oldHandle as unknown as VirtuosoHandle, view, "history-restore")
  expect(() => release()).not.toThrow()
  expect(oldHandle.setExternalScrollAnchor.mock.calls.at(-1)?.[0].active).toBe(false)
  expect(newHandle.setExternalScrollAnchor.mock.calls.map(([value]) => value.active)).toEqual([true])
  expect(hasChatViewportScrollOwner(view, "history-restore")).toBe(true)
  stopFirst(); stopSecond(); replacement?.()
})

it("rolls back a partially acquired native token and keeps the original native error", () => {
  const view = viewport(), failure = Error("original native failure")
  const handle = { setExternalScrollAnchor: vi.fn(({ active }) => {
    if (active) throw failure
    throw Error("cleanup failed")
  }) }
  expect(() => acquireChatExternalScrollAnchor(handle as unknown as VirtuosoHandle,
    view, "session-restore")).toThrow(failure)
  expect(handle.setExternalScrollAnchor.mock.calls.map(([value]) => value.active)).toEqual([true, false])
  expect(canOwnDetachedChatViewport(view)).toBe(true)
})
