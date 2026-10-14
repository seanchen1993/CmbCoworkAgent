import { expect, it, vi } from "vitest"
import { FunctionDesktopBroker } from "./desktop-broker"
import {
  FunctionPresentationPublisher,
  type NativePresentationBinding
} from "./presentation-broker"
import type { FunctionPresentationReport } from "../../../shared/mods/v2/presentation"

function fixture() {
  const controller = new AbortController()
  let live = true
  const binding: NativePresentationBinding = {
    entries: [{ id: "published", plugin: "one", kind: "toast", text: "safe", timeoutMs: 200 }],
    signal: controller.signal,
    assertLive: () => {
      if (!live) throw Error("MODS_SCOPE_CHANGED")
    },
    present: vi.fn(),
    pause: vi.fn()
  }
  const report = (
    receipt: string,
    patch: Partial<FunctionPresentationReport> = {}
  ): FunctionPresentationReport => ({
    threadId: "thread",
    owner: "owner",
    receipt,
    sequence: 1,
    present: true,
    panes: [],
    shown: ["published"],
    hovered: [],
    dismissed: [],
    ...patch
  })
  return {
    binding,
    controller,
    report,
    retire: () => {
      live = false
    }
  }
}
it("replaces publication id set and rejects deleted, status and invented ids", async () => {
  const p = new FunctionPresentationPublisher(),
    f = fixture()
  const first = await p.publish(async () => f.binding)
  p.report(f.report(first.receipt!))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  f.binding.entries = []
  const second = await p.publish(async () => f.binding)
  expect(f.binding.pause).toHaveBeenCalledTimes(1)
  p.report(f.report(first.receipt!, { sequence: 2, shown: [] }))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  expect(() => p.report(f.report(second.receipt!))).toThrow("PRESENTATION_ID")
  p.close()
})
it("duplicate or reversed sequence never changes current visibility", async () => {
  const p = new FunctionPresentationPublisher(),
    f = fixture()
  const first = await p.publish(async () => f.binding)
  p.report(f.report(first.receipt!, { sequence: 2 }))
  p.report(f.report(first.receipt!, { sequence: 2, shown: [] }))
  p.report(f.report(first.receipt!, { sequence: 1, shown: [] }))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  p.close()
})
it("reused owner string still retires its original native object and receipt", async () => {
  const broker = new FunctionDesktopBroker(() => {}),
    f = fixture()
  broker.attach("thread", "owner", 1, () => {})
  const first = await broker.feedback(1, "thread", "owner", async () => f.binding)
  broker.attach("thread", "owner", 1, () => {})
  const second = await broker.feedback(1, "thread", "owner", async () => f.binding)
  broker.present(1, f.report(first.receipt!, { shown: [], sequence: 5 }))
  expect(f.binding.present).not.toHaveBeenCalled()
  broker.present(1, f.report(second.receipt!))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  expect(() => broker.present(2, f.report(second.receipt!, { sequence: 3 }))).toThrow("OWNER")
  expect(() =>
    broker.present(1, f.report(second.receipt!, { threadId: "other", sequence: 3 }))
  ).toThrow("OWNER")
  broker.detach("thread", "owner", 1)
  expect(f.binding.pause).toHaveBeenCalledTimes(2)
})
it("retirement signal pauses immediately and old empty reports cannot affect replacement", async () => {
  const p = new FunctionPresentationPublisher(),
    f = fixture(),
    next = fixture()
  const first = await p.publish(async () => f.binding)
  f.controller.abort()
  expect(f.binding.pause).toHaveBeenCalledTimes(1)
  const second = await p.publish(async () => next.binding)
  p.report(f.report(first.receipt!, { shown: [] }))
  expect(next.binding.present).not.toHaveBeenCalled()
  p.report(f.report(second.receipt!))
  expect(next.binding.present).toHaveBeenCalledTimes(1)
  p.close()
})
it("late async publication cannot replace a newer receipt or resurrect a detached owner", async () => {
  const p = new FunctionPresentationPublisher(),
    f = fixture()
  let release!: (binding: NativePresentationBinding) => void
  const late = p.publish(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const rejected = expect(late).rejects.toThrow("OWNER")
  const current = await p.publish(async () => f.binding)
  release(f.binding)
  await rejected
  p.report(f.report(current.receipt!))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  p.close()
  await expect(p.publish(async () => f.binding)).rejects.toThrow("OWNER")
})
it("failed protection drops old publication and accepts no old ACK", async () => {
  const p = new FunctionPresentationPublisher(),
    f = fixture()
  const first = await p.publish(async () => f.binding)
  await expect(
    p.publish(async () => {
      throw Error("protection")
    })
  ).rejects.toThrow("protection")
  p.report(f.report(first.receipt!))
  expect(f.binding.present).not.toHaveBeenCalled()
  expect(f.binding.pause).toHaveBeenCalledTimes(1)
  p.close()
})

it("native hidden window blocks even an in-flight renderer shown ACK and pauses its sender", async () => {
  const broker = new FunctionDesktopBroker(() => {}),
    f = fixture()
  let visible = true
  broker.attach(
    "thread",
    "owner",
    1,
    () => {},
    () => visible
  )
  const publication = await broker.feedback(1, "thread", "owner", async () => f.binding)
  visible = false
  broker.pauseSender(1)
  broker.present(1, f.report(publication.receipt!))
  expect(f.binding.pause).toHaveBeenCalledTimes(1)
  expect(f.binding.present).toHaveBeenCalledWith(expect.objectContaining({ present: false }))
  broker.close()
})
it("actual desktop broker validates the original present fact before applying its visibility mask", async () => {
  const broker = new FunctionDesktopBroker(() => {}),
    f = fixture()
  broker.attach(
    "thread",
    "owner",
    1,
    () => {},
    () => true
  )
  const publication = await broker.feedback(1, "thread", "owner", async () => f.binding)
  expect(() =>
    broker.present(1, f.report(publication.receipt!, { present: "yes" as unknown as boolean }))
  ).toThrow()
  expect(f.binding.present).not.toHaveBeenCalled()
  broker.present(1, f.report(publication.receipt!))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  broker.close()
})
it("a void ACK ignored during a native publication barrier does not consume cancellation", async () => {
  const publisher = new FunctionPresentationPublisher(),
    f = fixture()
  const initial = await publisher.publish(async () => f.binding)
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const refreshing = publisher.publish(async () => {
    entered.resolve()
    await finish.promise
    return f.binding
  })
  await entered.promise
  expect(
    publisher.report(f.report(initial.receipt!, { shown: [], dismissed: ["published"] }))
  ).toBeUndefined()
  expect(f.binding.present).not.toHaveBeenCalled()
  finish.resolve()
  const current = await refreshing
  publisher.report(f.report(current.receipt!, { sequence: 2, shown: [], dismissed: ["published"] }))
  expect(f.binding.present).toHaveBeenCalledWith(
    expect.objectContaining({ dismissed: ["published"] })
  )
  publisher.close()
})
it.each([
  { sequence: 0 },
  { present: "yes" },
  { shown: Array(41).fill("published") },
  { hovered: ["published", "published"] },
  { clock: 999999 },
  { panes: [{ key: "p", generation: "g", isShown: true, isPlaced: false, isFocused: false }] }
])("rejects malformed layout without consuming its sequence %j", async (patch) => {
  const p = new FunctionPresentationPublisher(),
    f = fixture()
  const first = await p.publish(async () => f.binding)
  expect(() =>
    p.report(f.report(first.receipt!, patch as Partial<FunctionPresentationReport>))
  ).toThrow()
  expect(f.binding.present).not.toHaveBeenCalled()
  p.report(f.report(first.receipt!))
  expect(f.binding.present).toHaveBeenCalledTimes(1)
  p.close()
})
