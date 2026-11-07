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
    desktopPresent: vi.fn(
      async (
        _report: import("../../../shared/mods/v2/presentation").FunctionPresentationReport
      ) => {}
    ),
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
      querySelectorAll: () => [],
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
    vi.fn((run: FrameRequestCallback) => {
      queueMicrotask(() => run(0))
      return 1
    })
  )
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  const presentation = new FunctionPresentation("thread", "owner", () => null, ready)
  presentations.push(presentation)
  return {
    presentation,
    mods,
    notify: (scope = "feedback") => {
      for (const listener of listeners) listener({ threadId: "thread", scope })
    }
  }
}

const snapshot = (text: string): FunctionPresentationSnapshot => ({
  entries: [{ id: text, plugin: "test", kind: "status", text }]
})

it("publishes every completed feedback read under a sustained update stream", async () => {
  const f = fixture()
  let pending = deferred<FunctionPresentationSnapshot>()
  f.mods.desktopFeedback.mockImplementation(() => pending.promise)
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  await settle()
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 20; j++) f.notify()
    expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(i + 1)
    const completing = pending
    pending = deferred<FunctionPresentationSnapshot>()
    completing.resolve(snapshot(String(i)))
    await settle()
    expect(f.presentation.snapshot.entries[0]?.text).toBe(String(i))
  }
  f.presentation.close()
  pending.resolve(snapshot("closed"))
  await settle()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(101)
})

it("clears and rejects in-flight feedback when the source retires", async () => {
  const f = fixture()
  const pending = deferred<FunctionPresentationSnapshot>()
  f.mods.desktopFeedback.mockImplementationOnce(() => pending.promise)
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  f.notify("source-retiring:1")
  f.mods.desktopFeedback.mockResolvedValue(snapshot("replacement"))
  pending.resolve(snapshot("retired"))
  await vi.waitFor(() => expect(f.presentation.snapshot.entries[0]?.text).toBe("replacement"))
})

it("does not reread feedback for repeated card or message rendering", async () => {
  const f = fixture()
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 100; i++) {
    f.notify("placed")
    f.notify("site-presentations:AssistantMessage")
    f.notify("cards")
  }
  await Promise.resolve()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
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

it("waits for actual presentation ACKs so continuous reads cannot starve native reports", async () => {
  const f = fixture()
  const publisher = new FunctionPresentationPublisher()
  let pending = deferred<NativePresentationBinding>()
  const present = vi.fn()
  const binding = (): NativePresentationBinding => ({
    entries: [{ id: "toast", kind: "toast", plugin: "test", text: "status" }],
    signal: new AbortController().signal,
    assertLive: () => {},
    present,
    pause: () => {}
  })
  f.mods.desktopFeedback.mockImplementation(() => publisher.publish(() => pending.promise))
  let ack = deferred<void>()
  f.mods.desktopPresent.mockImplementation(async (report) => {
    await ack.promise
    publisher.report(report)
  })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  await settle()
  for (let i = 0; i < 100; i++) {
    f.notify()
    const completing = pending
    pending = deferred<NativePresentationBinding>()
    completing.resolve(binding())
    await settle()
    expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(i + 1)
    expect(f.mods.desktopPresent).toHaveBeenCalledTimes(i + 1)
    ack.resolve()
    ack = deferred<void>()
    await settle()
    expect(present).toHaveBeenCalledTimes(i + 1)
    expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(i + 2)
  }
  f.presentation.close()
  publisher.close()
  pending.resolve(binding())
  await settle()
})

it("acknowledges hidden surfaces without waiting for a suspended animation frame", async () => {
  const f = fixture()
  Object.assign(document, { visibilityState: "hidden" })
  f.mods.desktopFeedback.mockResolvedValue({ receipt: "hidden", entries: [] })
  await vi.waitFor(() => expect(f.mods.desktopPresent).toHaveBeenCalledTimes(1))
  f.notify()
  await vi.waitFor(() => expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(2))
})

it("does not loop on a failed presentation ACK and retries on later content", async () => {
  const f = fixture()
  f.mods.desktopFeedback.mockResolvedValue({ receipt: "current", entries: [] })
  f.mods.desktopPresent.mockRejectedValueOnce(Error("IPC_UNAVAILABLE"))
  await vi.waitFor(() => expect(f.mods.desktopPresent).toHaveBeenCalledTimes(1))
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
  f.notify()
  await vi.waitFor(() => expect(f.mods.desktopPresent).toHaveBeenCalledTimes(2))
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(2)
})

it("owner rejection while reporting pauses until explicit rebind", async () => {
  const f = fixture()
  f.mods.desktopFeedback.mockResolvedValue({ receipt: "retired", entries: snapshot("old").entries })
  f.mods.desktopPresent.mockRejectedValueOnce(Error("MODS_DESKTOP_OWNER"))
  await vi.waitFor(() => expect(f.mods.desktopPresent).toHaveBeenCalledTimes(1))
  expect(f.presentation.snapshot.entries).toEqual([])
  f.notify()
  await Promise.resolve()
  expect(f.mods.desktopFeedback).toHaveBeenCalledTimes(1)
  f.presentation.rebind(Promise.resolve())
  await vi.waitFor(() => expect(f.mods.desktopPresent).toHaveBeenCalledTimes(2))
})
