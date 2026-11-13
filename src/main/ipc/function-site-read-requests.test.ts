import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import { FunctionSiteReadRequests } from "./function-site-read-requests"

const namespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const documentIds = (requests: FunctionSiteReadRequests, owner: ReturnType<typeof sender>) => {
  const namespace = requests.documentNamespace(owner)
  return (sequence: number) => `${namespace}:${sequence}`
}
function sender() {
  return Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false
  }) as unknown as Parameters<FunctionSiteReadRequests["run"]>[0] & EventEmitter
}

it("rejects an old document's late read before it can bind a reused main frame", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  await requests.run(owner, id(1), async () => "old document")
  owner.emit("did-start-navigation", {}, "same-url-reload", false, true)
  owner.emit("did-frame-navigate", {}, "same-url-reload", 200, "OK", true)
  const next = documentIds(requests, owner)
  await expect(requests.run(owner, id(2), async () => "late old document")).rejects.toThrow(
    "MODS_DISPLAY_READ_CANCELLED"
  )
  await expect(requests.run(owner, next(1), async () => "new document")).resolves.toBe(
    "new document"
  )
})

it.each(["before-commit", "after-commit"])(
  "accepts a fresh private preload handshake %s without commit ordering assumptions",
  async (order) => {
    const requests = new FunctionSiteReadRequests(),
      owner = sender()
    const oldId = documentIds(requests, owner)
    await requests.run(owner, oldId(1), async () => undefined)
    owner.emit("did-start-navigation", {}, "same-url-reload", false, true)
    if (order === "after-commit") owner.emit("did-frame-navigate", {}, "url", 200, "OK", true)
    const nextId = documentIds(requests, owner)
    if (order === "before-commit") owner.emit("did-frame-navigate", {}, "url", 200, "OK", true)
    await expect(requests.run(owner, oldId(2), async () => "old")).rejects.toThrow(
      "MODS_DISPLAY_READ_CANCELLED"
    )
    await expect(requests.run(owner, nextId(1), async () => "fresh")).resolves.toBe("fresh")
  }
)

it("keeps a prevented or failed navigation's surviving preload usable without resetting ABA", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  await requests.run(owner, id(1), async () => "before navigation")
  owner.emit("did-start-navigation", {}, "prevented-or-failed-url", false, true)
  owner.emit("did-fail-load", {}, -3, "ERR_ABORTED")
  await expect(requests.run(owner, id(1), async () => "reused")).rejects.toThrow(
    "MODS_DISPLAY_READ_ID_REUSED"
  )
  await expect(requests.run(owner, id(2), async () => "surviving document")).resolves.toBe(
    "surviving document"
  )
})

it("isolates an old preload's first lazy handshake after navigation start from the new preload", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  owner.emit("did-start-navigation", {}, "url", false, true)
  const old = documentIds(requests, owner)
  await requests.run(owner, old(1), async () => "old first read")
  const next = documentIds(requests, owner)
  owner.emit("did-frame-navigate", {}, "url", 200, "OK", true)
  await expect(requests.run(owner, old(2), async () => "old late read")).rejects.toThrow(
    "MODS_DISPLAY_READ_CANCELLED"
  )
  await expect(requests.run(owner, next(1), async () => "new first read")).resolves.toBe(
    "new first read"
  )
})

it("keeps the native frame's physical budget through preload handshakes and old cleanup", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  const gates = Array.from({ length: 16 }, () => Promise.withResolvers<void>())
  const pending = gates.map((gate, index) =>
    expect(requests.run(owner, id(index + 1), () => gate.promise)).rejects.toThrow(
      "MODS_DISPLAY_READ_CANCELLED"
    )
  )
  owner.emit("did-start-navigation", {}, "reload", false, true)
  const next = documentIds(requests, owner)
  await expect(requests.run(owner, next(1), async () => "unbounded")).rejects.toThrow(
    "MODS_DISPLAY_READ_LIMIT"
  )
  gates[0].resolve()
  await pending[0]
  const nextGate = Promise.withResolvers<void>()
  let signal!: AbortSignal
  const live = requests.run(owner, next(2), async (value) => {
    signal = value!
    await nextGate.promise
  })
  requests.cancel(owner, id(1))
  expect(signal.aborted).toBe(false)
  await expect(requests.run(owner, next(3), async () => "only one slot was freed")).rejects.toThrow(
    "MODS_DISPLAY_READ_LIMIT"
  )
  for (const gate of gates) gate.resolve()
  await Promise.all(pending)
  expect(signal.aborted).toBe(false)
  nextGate.resolve()
  await live
  await expect(requests.run(owner, next(4), async () => "after physical settlement")).resolves.toBe(
    "after physical settlement"
  )
})

it("cancels only the requesting native sender and current frame", async () => {
  const requests = new FunctionSiteReadRequests(),
    first = sender(),
    other = sender()
  const id = documentIds(requests, first)
  const gate = Promise.withResolvers<string>()
  let signal!: AbortSignal
  const pending = requests.run(first, id(1), async (value) => {
    signal = value!
    return gate.promise
  })
  requests.cancel(other, id(1))
  expect(signal.aborted).toBe(false)
  const frame = first.mainFrame
  Object.assign(first, { mainFrame: {} })
  requests.cancel(first, id(1))
  expect(signal.aborted).toBe(false)
  Object.assign(first, { mainFrame: frame })
  requests.cancel(first, id(1))
  expect(signal.aborted).toBe(true)
  const assertion = expect(pending).rejects.toThrow("MODS_DISPLAY_READ_CANCELLED")
  gate.resolve("old")
  await assertion
})

it("rejects same-frame request ID reuse and leaves newer operations live after late cancellation", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  await requests.run(owner, id(1), async () => "first")
  await expect(requests.run(owner, id(1), async () => "reused")).rejects.toThrow(
    "MODS_DISPLAY_READ_ID_REUSED"
  )
  const gate = Promise.withResolvers<void>()
  let current!: AbortSignal
  const next = requests.run(owner, id(2), async (signal) => {
    current = signal!
    await gate.promise
  })
  requests.cancel(owner, id(1))
  expect(current.aborted).toBe(false)
  gate.resolve()
  await next
})

it("keeps current reads live through native subframe navigation notifications", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  const gate = Promise.withResolvers<void>()
  let signal!: AbortSignal
  const pending = requests.run(owner, id(1), async (value) => {
    signal = value!
    await gate.promise
  })
  owner.emit("did-start-navigation", { isMainFrame: false })
  owner.emit("did-start-navigation", {}, "subframe", false, false)
  owner.emit("did-frame-navigate", { isMainFrame: false })
  owner.emit("did-frame-navigate", {}, "subframe", 200, "OK", false)
  expect(signal.aborted).toBe(false)
  gate.resolve()
  await pending
})

it("retires navigation work without letting old cleanup erase the new frame's requests", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  const oldGate = Promise.withResolvers<void>(),
    nextGate = Promise.withResolvers<void>()
  let oldSignal!: AbortSignal, nextSignal!: AbortSignal
  const old = requests.run(owner, id(1), async (signal) => {
    oldSignal = signal!
    await oldGate.promise
  })
  const oldAssertion = expect(old).rejects.toThrow("MODS_DISPLAY_READ_CANCELLED")
  owner.emit?.("did-start-navigation", {}, "url", false, true)
  expect(oldSignal.aborted).toBe(true)
  owner.emit("did-frame-navigate", {}, "url", 200, "OK", true)
  const nextId = documentIds(requests, owner)(1)
  const next = requests.run(owner, nextId, async (signal) => {
    nextSignal = signal!
    await nextGate.promise
  })
  oldGate.resolve()
  await oldAssertion
  requests.cancel(owner, id(1))
  expect(nextSignal.aborted).toBe(false)
  requests.cancel(owner, nextId)
  expect(nextSignal.aborted).toBe(true)
  const nextAssertion = expect(next).rejects.toThrow("MODS_DISPLAY_READ_CANCELLED")
  nextGate.resolve()
  await nextAssertion
})

it("keeps abort-ignoring physical operations bounded until actual completion", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender(),
    gate = Promise.withResolvers<void>()
  const id = documentIds(requests, owner)
  const pending = Array.from({ length: 16 }, (_, index) => {
    const promise = requests.run(owner, id(index + 1), async () => {
      await gate.promise
    })
    requests.cancel(owner, id(index + 1))
    return expect(promise).rejects.toThrow("MODS_DISPLAY_READ_CANCELLED")
  })
  const work = vi.fn(async () => undefined)
  await expect(requests.run(owner, id(17), work)).rejects.toThrow("MODS_DISPLAY_READ_LIMIT")
  expect(work).not.toHaveBeenCalled()
  gate.resolve()
  await Promise.all(pending)
  await requests.run(owner, id(18), work)
  expect(work).toHaveBeenCalledOnce()
})

it("bounds the total physical work retained across rapid frame retirements", async () => {
  const requests = new FunctionSiteReadRequests(),
    gate = Promise.withResolvers<void>()
  const retained: Promise<void>[] = []
  for (let generation = 0; generation < 2; generation++) {
    const owner = sender()
    const id = documentIds(requests, owner)
    for (let index = 1; index <= 16; index++) {
      const pending = requests.run(owner, id(index), async () => {
        await gate.promise
      })
      retained.push(expect(pending).rejects.toThrow("MODS_DISPLAY_READ_CANCELLED"))
    }
    owner.emit?.("destroyed")
  }
  const nextOwner = sender(),
    nextId = documentIds(requests, nextOwner)(1)
  await expect(requests.run(nextOwner, nextId, async () => undefined)).rejects.toThrow(
    "MODS_DISPLAY_READ_LIMIT"
  )
  gate.resolve()
  await Promise.all(retained)
  await expect(
    requests.run(nextOwner, documentIds(requests, nextOwner)(2), async () => "next")
  ).resolves.toBe("next")
})

it("counts legacy calls in the same total physical budget", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender(),
    gate = Promise.withResolvers<void>()
  const id = documentIds(requests, owner)
  const legacy = Array.from({ length: 32 }, () =>
    requests.run(owner, undefined, () => gate.promise)
  )
  await expect(requests.run(owner, id(1), async () => undefined)).rejects.toThrow(
    "MODS_DISPLAY_READ_LIMIT"
  )
  await expect(requests.run(owner, undefined, async () => undefined)).rejects.toThrow(
    "MODS_DISPLAY_READ_LIMIT"
  )
  gate.resolve()
  await Promise.all(legacy)
})

it("waits for cancellation cleanup before returning its physical capacity", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender()
  const id = documentIds(requests, owner)
  const gate = Promise.withResolvers<void>(),
    cleanupGate = Promise.withResolvers<void>()
  let cleanupStarted = false,
    settled = false
  const pending = requests.run(
    owner,
    id(1),
    async () => gate.promise,
    async () => {
      cleanupStarted = true
      await cleanupGate.promise
    }
  )
  const assertion = expect(pending).rejects.toThrow("MODS_DISPLAY_READ_CANCELLED")
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  requests.cancel(owner, id(1))
  gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  expect(cleanupStarted).toBe(true)
  expect(settled).toBe(false)
  cleanupGate.resolve()
  await assertion
})

it("rejects malformed IDs and keeps legacy peers on their existing host path", async () => {
  const requests = new FunctionSiteReadRequests(),
    owner = sender(),
    work = vi.fn(async () => "legacy")
  for (const value of [null, "", "other", `${namespace}:0`, `${namespace}:9007199254740992`])
    await expect(requests.run(owner, value, work)).rejects.toThrow("MODS_DISPLAY_READ_ID_INVALID")
  expect(work).not.toHaveBeenCalled()
  await expect(requests.run(owner, undefined, work)).resolves.toBe("legacy")
})
