import { afterEach, describe, expect, it, vi } from "vitest"
import { EditorNavigationBroker, type EditorNavigationRequest } from "./platform-editor-navigation"
import type { DeveloperEditorEvent } from "../../../shared/mods/v2/developer-editor"

const brokers: EditorNavigationBroker[] = []
afterEach(() => {
  brokers.splice(0).forEach((broker) => broker.invalidate())
  vi.useRealTimers()
})
function fixture() {
  const events: DeveloperEditorEvent[] = []
  const abort = new AbortController()
  let sender: number | undefined = 7
  let now = 100
  let current = true
  const launchExternal = vi.fn(async () => ({ mode: "workspace+file+line" }))
  const broker = new EditorNavigationBroker(
    () => sender,
    (_sender, event) => events.push(event),
    () => now
  )
  brokers.push(broker)
  const retained: AbortController[] = []
  const leaseClose = vi.fn()
  const request: EditorNavigationRequest = {
    owner: {},
    signal: abort.signal,
    text: "safe source",
    fingerprint: "fingerprint",
    intent: {
      threadId: "thread",
      workspace: "/work",
      scopeKey: "birth",
      path: "source.ts",
      line: 1,
      column: 2,
      externalAvailable: true,
      source: { provider: "author", digest: "digest", generation: "one" }
    },
    verify: vi.fn(async () => {
      if (!current) throw Error("STALE_SOURCE")
    }),
    assertCurrent: () => {
      if (!current) throw Error("STALE_SOURCE")
    },
    launchExternal,
    retain: vi.fn(async () => {
      const controller = new AbortController()
      retained.push(controller)
      return {
        signal: controller.signal,
        verify: async () => {
          if (!current) throw Error("STALE_SOURCE")
        },
        assertCurrent: () => {
          if (!current) throw Error("STALE_SOURCE")
        },
        launchExternal,
        close: () => {
          if (!controller.signal.aborted) {
            leaseClose()
            controller.abort()
          }
        }
      }
    })
  }
  const open = async () => {
    const result = broker.open(request)
    await vi.waitFor(() => expect(events.some((event) => event.kind === "offer")).toBe(true))
    const event = events.find((event) => event.kind === "offer")!
    if (event.kind !== "offer") throw Error("NO_OFFER")
    return { result, id: event.intent.id }
  }
  return {
    broker,
    events,
    request,
    abort,
    launchExternal,
    retained,
    leaseClose,
    open,
    change: () => {
      current = false
    },
    expire: () => {
      now += 30000
    },
    replaceWindow: () => {
      sender = 8
    }
  }
}
describe("native editor navigation receipts", () => {
  it("sends no file text in discovery, requires an exact loaded target, and launches IDE only once", async () => {
    const f = fixture(),
      { result, id } = await f.open()
    expect(JSON.stringify(f.events)).not.toContain("safe source")
    await expect(f.broker.launchExternal(7, id)).rejects.toThrow("EXTERNAL_INTENT_INVALID")
    const frame = await f.broker.accept(7, id)
    expect(frame.text).toBe("safe source")
    await expect(
      f.broker.acknowledge(7, {
        id,
        fingerprint: frame.fingerprint,
        status: "preview-loaded",
        line: 1,
        column: 1
      })
    ).rejects.toThrow("TARGET_NOT_CONFIRMED")
    await f.broker.acknowledge(7, {
      id,
      fingerprint: frame.fingerprint,
      status: "preview-loaded",
      line: 1,
      column: 2
    })
    await expect(result).resolves.toEqual({ status: "preview-loaded", line: 1, column: 2 })
    await expect(f.broker.launchExternal(7, id)).resolves.toEqual({
      status: "external-launch-requested",
      display: "unknown",
      mode: "workspace+file+line"
    })
    await expect(f.broker.launchExternal(7, id)).rejects.toThrow("EXTERNAL_INTENT_INVALID")
    expect(f.launchExternal).toHaveBeenCalledTimes(1)
  })
  it("refuses another sender without retiring the original intent", async () => {
    const f = fixture(),
      { id } = await f.open()
    await expect(f.broker.accept(8, id)).rejects.toThrow("STALE")
    await expect(f.broker.accept(7, id)).resolves.toHaveProperty("id", id)
  })
  it.each(["source", "ttl", "window", "abort", "owner"])(
    "does not replay a retired %s intent",
    async (kind) => {
      const f = fixture(),
        { result, id } = await f.open()
      if (kind === "source") f.change()
      if (kind === "ttl") f.expire()
      if (kind === "window") f.replaceWindow()
      if (kind === "abort") f.abort.abort()
      if (kind === "owner") f.broker.retireOwner(f.request.owner)
      await expect(f.broker.accept(7, id)).rejects.toThrow()
      f.broker.invalidate()
      await expect(result).resolves.toEqual({ status: "unknown" })
      expect(f.launchExternal).not.toHaveBeenCalled()
    }
  )
  it("does not acknowledge bytes after source revocation", async () => {
    const f = fixture(),
      { result, id } = await f.open()
    await f.broker.accept(7, id)
    f.change()
    await expect(
      f.broker.acknowledge(7, {
        id,
        fingerprint: "fingerprint",
        status: "preview-loaded",
        line: 1,
        column: 2
      })
    ).rejects.toThrow("STALE_SOURCE")
    await expect(result).resolves.toEqual({ status: "unknown" })
  })
  it("rejects pending acceptance when verification crosses the handshake TTL", async () => {
    const f = fixture(),
      { result, id } = await f.open()
    f.request.verify = async () => {
      f.expire()
    }
    await expect(f.broker.accept(7, id)).rejects.toThrow("EXPIRED")
    await expect(result).resolves.toEqual({ status: "unknown" })
    expect(f.launchExternal).not.toHaveBeenCalled()
  })
  it("keeps a loaded snapshot beyond 31s and after the original RPC abort, until explicit close", async () => {
    vi.useFakeTimers()
    const f = fixture(),
      { result, id } = await f.open()
    await f.broker.accept(7, id)
    await f.broker.acknowledge(7, {
      id,
      fingerprint: "fingerprint",
      status: "preview-loaded",
      line: 1,
      column: 2
    })
    await expect(result).resolves.toMatchObject({ status: "preview-loaded" })
    f.abort.abort()
    f.expire()
    f.expire()
    await vi.advanceTimersByTimeAsync(31000)
    expect(f.events.some((event) => event.kind === "retire" && event.id === id)).toBe(false)
    await expect(f.broker.launchExternal(7, id)).resolves.toMatchObject({
      status: "external-launch-requested",
      display: "unknown"
    })
    await expect(f.broker.accept(7, id)).rejects.toThrow("ALREADY_ACCEPTED")
    await expect(
      f.broker.acknowledge(7, {
        id,
        fingerprint: "fingerprint",
        status: "preview-loaded",
        line: 1,
        column: 2
      })
    ).rejects.toThrow("RECEIPT_INVALID")
    f.broker.close(7, id)
    expect(f.leaseClose).toHaveBeenCalledTimes(1)
  })
  it("rechecks retained source after loaded, and closes that lease instead of launching", async () => {
    const f = fixture(),
      { id } = await f.open()
    await f.broker.accept(7, id)
    await f.broker.acknowledge(7, {
      id,
      fingerprint: "fingerprint",
      status: "preview-loaded",
      line: 1,
      column: 2
    })
    f.change()
    await expect(f.broker.launchExternal(7, id)).rejects.toThrow("STALE_SOURCE")
    expect(f.launchExternal).not.toHaveBeenCalled()
    expect(f.leaseClose).toHaveBeenCalledTimes(1)
  })
  it.each(["close", "source", "ttl"])(
    "closes late retained lease when %s interrupts ACK validation",
    async (kind) => {
      const f = fixture(),
        { result, id } = await f.open()
      await f.broker.accept(7, id)
      const capture = f.request.retain!
      let release!: () => void, entered!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      f.request.retain = async () => {
        const lease = await capture()
        entered()
        await gate
        return lease
      }
      const pending = f.broker.acknowledge(7, {
        id,
        fingerprint: "fingerprint",
        status: "preview-loaded",
        line: 1,
        column: 2
      })
      const rejected = expect(pending).rejects.toThrow()
      await ready
      await expect(
        f.broker.acknowledge(7, {
          id,
          fingerprint: "fingerprint",
          status: "preview-loaded",
          line: 1,
          column: 2
        })
      ).rejects.toThrow("RECEIPT_INVALID")
      if (kind === "close") f.broker.close(7, id)
      if (kind === "source") f.change()
      if (kind === "ttl") f.expire()
      release()
      await rejected
      await expect(result).resolves.toEqual({ status: "unknown" })
      expect(f.leaseClose).toHaveBeenCalledTimes(1)
      expect(f.launchExternal).not.toHaveBeenCalled()
    }
  )
  it("retires the prior active lease on a new offer and retires retained lifetime on revoke", async () => {
    const f = fixture(),
      { id } = await f.open()
    await f.broker.accept(7, id)
    await f.broker.acknowledge(7, {
      id,
      fingerprint: "fingerprint",
      status: "preview-loaded",
      line: 1,
      column: 2
    })
    const next = f.broker.open(f.request)
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.kind === "offer")).toHaveLength(2)
    )
    expect(f.leaseClose).toHaveBeenCalledTimes(1)
    f.broker.invalidate()
    await expect(next).resolves.toEqual({ status: "unknown" })
  })
  it("expires an unaccepted offer without creating a retained lease", async () => {
    vi.useFakeTimers()
    const f = fixture(),
      { result, id } = await f.open()
    await vi.advanceTimersByTimeAsync(31000)
    await expect(result).resolves.toEqual({ status: "unknown" })
    expect(f.request.retain).not.toHaveBeenCalled()
    await expect(f.broker.accept(7, id)).rejects.toThrow("STALE")
  })
  it("retires a loaded snapshot when retained runtime lifetime is aborted", async () => {
    const f = fixture(),
      { id } = await f.open()
    await f.broker.accept(7, id)
    await f.broker.acknowledge(7, {
      id,
      fingerprint: "fingerprint",
      status: "preview-loaded",
      line: 1,
      column: 2
    })
    f.retained[0].abort()
    expect(f.events.some((event) => event.kind === "retire" && event.id === id)).toBe(true)
    await expect(f.broker.launchExternal(7, id)).rejects.toThrow("STALE")
  })
  it("retiring another thread leaves the current window's preview intent intact", async () => {
    const f = fixture(),
      events: DeveloperEditorEvent[] = []
    const broker = new EditorNavigationBroker(
      (thread) => (thread === "one" ? 7 : 8),
      (_sender, event) => events.push(event)
    )
    brokers.push(broker)
    const one = broker.open({ ...f.request, intent: { ...f.request.intent, threadId: "one" } })
    const two = broker.open({ ...f.request, intent: { ...f.request.intent, threadId: "two" } })
    await vi.waitFor(() => expect(events.filter((event) => event.kind === "offer")).toHaveLength(2))
    broker.invalidateThread("one")
    await expect(one).resolves.toEqual({ status: "unknown" })
    const second = events.find(
      (event) => event.kind === "offer" && event.intent.threadId === "two"
    )!
    if (second.kind !== "offer") throw Error("NO_OFFER")
    const frame = await broker.accept(8, second.intent.id)
    await broker.acknowledge(8, {
      id: frame.id,
      fingerprint: frame.fingerprint,
      status: "preview-loaded",
      line: 1,
      column: 2
    })
    await expect(two).resolves.toEqual({ status: "preview-loaded", line: 1, column: 2 })
    expect(events.some((event) => event.kind === "retire" && event.id === frame.id)).toBe(false)
  })
})
