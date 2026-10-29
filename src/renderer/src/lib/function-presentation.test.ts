import { afterEach, expect, it, vi } from "vitest"
import type { FunctionPresentationSnapshot } from "../../../shared/mods/v2/presentation"
import { FunctionPresentation, readFunctionPresentation } from "./function-presentation"
import {
  FunctionPresentationPublisher,
  type NativePresentationBinding
} from "../../../main/mods/v2/presentation-broker"

const presentations: FunctionPresentation[] = []
afterEach(() => {
  for (const presentation of presentations.splice(0)) presentation.close()
  vi.unstubAllGlobals()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(ready = Promise.resolve()) {
  const listeners = new Set<(event: { threadId: string; scope?: string }) => void>()
  const mods = {
    desktopFeedback: vi.fn(async (): Promise<FunctionPresentationSnapshot> => ({ entries: [] })),
    onCardsChanged: (listener: (event: { threadId: string; scope?: string }) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  vi.stubGlobal("window", Object.assign(new EventTarget(), { api: { mods } }))
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      body: {},
      visibilityState: "visible"
    })
  )
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
  )
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  const presentation = new FunctionPresentation("thread", "owner", () => null, ready)
  presentations.push(presentation)
  return {
    presentation,
    mods,
    notify: () => {
      for (const listener of listeners) listener({ threadId: "thread", scope: "feedback" })
    }
  }
}

const snapshot = (text: string): FunctionPresentationSnapshot => ({
  entries: [{ id: text, plugin: "test", kind: "status", text }]
})

it("coalesces concurrent card notifications and publishes the latest feedback", async () => {
  const f = fixture()
  const first = deferred<FunctionPresentationSnapshot>()
  f.mods.desktopFeedback.mockImplementationOnce(() => first.promise)
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 30; i++) f.notify()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
  f.mods.desktopFeedback.mockResolvedValue(snapshot("latest"))
  first.resolve(snapshot("obsolete"))
  await vi.waitFor(() => expect(f.presentation.snapshot.entries[0]?.text).toBe("latest"))
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(2)
})

it("does not invoke feedback when an old attach settles after close or replacement", async () => {
  const ready = deferred<void>()
  const f = fixture(ready.promise)
  const replacement = new FunctionPresentation("thread", "new-owner", () => null, Promise.resolve())
  presentations.push(replacement)
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  ready.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
  expect(readFunctionPresentation("thread").owner).toBe("new-owner")
})

it("pauses a rejected owner until an explicit attach rebind completes", async () => {
  const f = fixture()
  f.mods.desktopFeedback.mockRejectedValue(
    Error("Error invoking remote method 'mods:desktop-feedback': Error: MODS_DESKTOP_OWNER")
  )
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 30; i++) f.notify()
  await Promise.resolve()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
  const attached = deferred<void>()
  f.mods.desktopFeedback.mockResolvedValue(snapshot("rebound"))
  f.presentation.rebind(attached.promise)
  await Promise.resolve()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
  attached.resolve()
  await vi.waitFor(() => expect(f.presentation.snapshot.entries[0]?.text).toBe("rebound"))
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(2)
})

it("keeps transient feedback failures recoverable on a later notification", async () => {
  const f = fixture()
  f.mods.desktopFeedback.mockRejectedValueOnce(Error("MODS_DEVELOPMENT_APPLYING"))
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  f.mods.desktopFeedback.mockResolvedValue(snapshot("active"))
  f.notify()
  await vi.waitFor(() => expect(f.presentation.snapshot.entries[0]?.text).toBe("active"))
})

it("serializes the real publisher so notification bursts cannot reject its old revision", async () => {
  const f = fixture()
  const publisher = new FunctionPresentationPublisher()
  const first = deferred<NativePresentationBinding>()
  const binding = (text: string): NativePresentationBinding => ({
    entries: snapshot(text).entries,
    signal: new AbortController().signal,
    assertLive: () => {},
    present: () => {},
    pause: () => {}
  })
  const read = vi.fn(async () => binding("latest")).mockImplementationOnce(() => first.promise)
  const feedback = vi.fn(() => publisher.publish(read))
  f.mods.desktopFeedback.mockImplementation(feedback)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 30; i++) f.notify()
  first.resolve(binding("old"))
  await vi.waitFor(() => expect(f.presentation.snapshot.entries[0]?.text).toBe("latest"))
  expect(feedback).toHaveBeenCalledTimes(2)
  expect(await Promise.all(feedback.mock.results.map((result) => result.value))).toHaveLength(2)
  f.notify()
  await vi.waitFor(() => expect(feedback).toHaveBeenCalledTimes(3))
  publisher.close()
})

it("an old bind's owner rejection cannot pause the newly attached bind", async () => {
  const f = fixture()
  const old = deferred<FunctionPresentationSnapshot>()
  f.mods.desktopFeedback.mockImplementationOnce(() => old.promise)
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  f.mods.desktopFeedback.mockResolvedValue(snapshot("new-bind"))
  f.presentation.rebind(Promise.resolve())
  old.reject(Error("MODS_DESKTOP_OWNER"))
  await vi.waitFor(() => expect(f.presentation.snapshot.entries[0]?.text).toBe("new-bind"))
  f.notify()
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(3))
})
