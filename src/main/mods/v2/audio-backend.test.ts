import { afterEach, beforeEach, expect, it, vi } from "vitest"

type Reply = { ok: boolean; value?: Record<string, unknown>; code?: string }
type FakeWindow = {
  destroyed: boolean
  destroy(): void
  emit(name: string): void
  webContents: { emit(name: string): void }
}
const mock = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  calls: [] as Array<{ method: string; input: Record<string, unknown>; window: FakeWindow }>,
  waits: new Map<number, { resolve(value: Reply): void; promise: Promise<Reply> }>(),
  ready: undefined as Promise<void> | undefined,
  hook: undefined as ((method: string, input: Record<string, unknown>, window: FakeWindow) => Reply | Promise<Reply> | undefined) | undefined
}))
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  class Window extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => {},
      executeJavaScript: (code: string): Promise<Reply | { ready: boolean; nodeExposed: boolean }> => {
        if (!code.startsWith("globalThis.__modsAudioRenderer.call("))
          return Promise.resolve({ ready: true, nodeExposed: false })
        const [method, input] = JSON.parse("[" + code.slice("globalThis.__modsAudioRenderer.call(".length, -1) + "]") as [string, Record<string, unknown>]
        mock.calls.push({ method, input, window: this })
        const special = mock.hook?.(method, input, this)
        if (special !== undefined) return Promise.resolve(special)
        const id = Number(input.id)
        if (method === "wait") {
          let resolve!: (value: Reply) => void
          const promise = new Promise<Reply>(done => { resolve = done })
          mock.waits.set(id, { resolve, promise })
          return promise
        }
        if (method === "stop") {
          mock.waits.get(id)?.resolve({ ok: true, value: { kind: "stopped" } })
          return Promise.resolve({ ok: true, value: { stopped: true } })
        }
        if (method === "forget") return Promise.resolve({ ok: true, value: { forgotten: true } })
        if (method === "close") return Promise.resolve({ ok: true, value: { closed: true } })
        if (method.startsWith("start")) return Promise.resolve({ ok: true, value: { started: true } })
        return Promise.resolve({ ok: true, value: { prepared: true } })
      }
    })
    constructor() { super(); mock.windows.push(this) }
    loadURL(): Promise<void> { return Promise.resolve() }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.webContents.emit("destroyed")
      this.emit("closed")
    }
  }
  return {
    app: Object.assign(new EventEmitter(), { whenReady: () => mock.ready ?? Promise.resolve() }),
    BrowserWindow: Window,
    session: { fromPartition: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
      webRequest: { onBeforeRequest: () => {} }
    }) }
  }
})
import { FunctionAudioBackend } from "./audio-backend"

const backends: FunctionAudioBackend[] = []
function backend() { const value = new FunctionAudioBackend(); backends.push(value); return value }
function context() {
  const controller = new AbortController()
  const assertLive = vi.fn()
  return { controller, signal: controller.signal, assertLive }
}
function hold<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function ticks(predicate: () => boolean) {
  for (let index = 0; index < 80 && !predicate(); index++) await Promise.resolve()
  expect(predicate()).toBe(true)
}
function end(id: number) { mock.waits.get(id)!.resolve({ ok: true, value: { kind: "ended" } }) }
beforeEach(() => {
  mock.windows.length = 0
  mock.calls.length = 0
  mock.waits.clear()
  mock.ready = undefined
  mock.hook = undefined
})
afterEach(async () => {
  mock.hook = undefined
  await Promise.allSettled(backends.splice(0).map(value => value.close()))
  vi.useRealTimers()
})

it("creates no window until called, then preserves independent gain and byte snapshots", async () => {
  const b = backend()
  expect(mock.windows).toHaveLength(0)
  const bytes = Uint8Array.from([1, 2, 3])
  const first = b.play({ bytes, mime: "audio/wav", gain: 0 }, context())
  bytes[0] = 99
  const second = b.play({ bytes: Uint8Array.from([4]), mime: "audio/wav", gain: 4 }, context())
  await Promise.all([first.started, second.started])
  await ticks(() => mock.waits.size === 2)
  const prepared = mock.calls.filter(call => call.method === "prepareClip")
  expect(prepared.map(call => call.input.gain)).toEqual([0, 4])
  expect(Buffer.from(String(prepared[0].input.base64), "base64")).toEqual(Buffer.from([1, 2, 3]))
  expect(mock.windows).toHaveLength(1)
  end(1)
  end(2)
  await expect(first.done).resolves.toBe("ended")
  await expect(second.done).resolves.toBe("ended")
  expect(b.stats).toMatchObject({ operations: 0, encodedBytes: 0, window: false })
  expect(mock.windows[0].destroyed).toBe(true)
})

it("stop before window readiness cannot start later and waits for cleanup", async () => {
  const ready = hold<void>()
  mock.ready = ready.promise
  const b = backend()
  const job = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", shouldLoop: true }, context())
  const stopped = job.stop()
  let acknowledged = false
  void stopped.then(() => { acknowledged = true })
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  ready.resolve()
  await stopped
  await expect(job.done).resolves.toBe("stopped")
  await expect(job.started).rejects.toThrow("MODS_AUDIO_STOPPED")
  expect(mock.calls.some(call => call.method === "startClip")).toBe(false)
  expect(b.stats.operations).toBe(0)
})

it("stop during decode returns only after the actual stop acknowledgement", async () => {
  const decode = hold<Reply>()
  const ack = hold<Reply>()
  mock.hook = method => method === "prepareClip" ? decode.promise : method === "stop" ? ack.promise : undefined
  const b = backend()
  const job = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, context())
  await ticks(() => mock.calls.some(call => call.method === "prepareClip"))
  const stopping = job.stop()
  let finished = false
  void stopping.then(() => { finished = true })
  decode.resolve({ ok: true, value: { stopped: true } })
  await ticks(() => mock.calls.some(call => call.method === "stop"))
  expect(finished).toBe(false)
  expect(mock.calls.some(call => call.method === "startClip")).toBe(false)
  ack.resolve({ ok: true, value: { stopped: true } })
  await stopping
  await expect(job.done).resolves.toBe("stopped")
  expect(b.stats.operations).toBe(0)
})

it("a parent abort preserves the exact reason after stop and forget, including undefined guard errors", async () => {
  const c = context()
  const b = backend()
  const job = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", shouldLoop: true }, c)
  await job.started
  await ticks(() => mock.waits.has(1))
  const reason = Error("actual parent cancellation")
  c.controller.abort(reason)
  await expect(job.done).rejects.toBe(reason)
  expect(mock.calls.map(call => call.method)).toContain("forget")
  expect(b.stats.operations).toBe(0)
  const c2 = context()
  mock.hook = method => {
    if (method === "forget") c2.assertLive.mockImplementation(() => { throw undefined })
    return undefined
  }
  const next = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, c2)
  await next.started
  await ticks(() => mock.waits.has(2))
  end(2)
  await expect(next.done).rejects.toBeUndefined()
})

it("queues speech and removing a waiting item does not cancel another utterance", async () => {
  const b = backend()
  const first = b.speak({ text: "First" }, context())
  const removed = b.speak({ text: "Removed" }, context())
  const last = b.speak({ text: "Last", voice: "Installed local voice" }, context())
  await first.started
  await removed.stop()
  await expect(removed.done).rejects.toThrow("MODS_AUDIO_STOPPED")
  expect(mock.calls.filter(call => call.method === "startSpeech")).toHaveLength(1)
  await ticks(() => mock.waits.has(1))
  end(1)
  await expect(first.done).resolves.toEqual({ via: "system" })
  await last.started
  await ticks(() => mock.waits.has(3))
  end(3)
  await expect(last.done).resolves.toEqual({ via: "system" })
  expect(mock.calls.filter(call => call.method === "prepareSpeech").map(call => call.input.text)).toEqual(["First", "Last"])
  expect(b.stats).toMatchObject({ operations: 0, queuedSpeech: 0, window: false })
})

it("cancelling the active speech item leaves the next queued item able to start", async () => {
  const b = backend()
  const first = b.speak({ text: "Cancel current" }, context())
  const next = b.speak({ text: "Keep next" }, context())
  await first.started
  await first.stop()
  await expect(first.done).rejects.toThrow("MODS_AUDIO_STOPPED")
  await next.started
  await ticks(() => mock.waits.has(2))
  end(2)
  await expect(next.done).resolves.toEqual({ via: "system" })
})

it("a missing voice and a failed stop acknowledgement cannot produce success", async () => {
  const b = backend()
  mock.hook = method => method === "prepareSpeech" ? { ok: false, code: "MODS_AUDIO_VOICE_UNAVAILABLE" } : undefined
  const speech = b.speak({ text: "No voice", voice: "Missing voice" }, context())
  await expect(speech.done).rejects.toThrow("MODS_AUDIO_VOICE_UNAVAILABLE")
  mock.hook = undefined
  const job = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", shouldLoop: true }, context())
  await job.started
  mock.hook = method => method === "stop" ? { ok: true, value: { stopped: false } } : undefined
  await expect(job.stop()).rejects.toThrow("MODS_AUDIO_STOP_UNCONFIRMED")
  await expect(job.done).rejects.toThrow("MODS_AUDIO_STOP_UNCONFIRMED")
  expect(mock.windows.every(window => window.destroyed)).toBe(true)
})

it("renderer loss rejects running and queued work and old callbacks cannot destroy a replacement", async () => {
  const b = backend()
  const clip = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", shouldLoop: true }, context())
  const speech = b.speak({ text: "Active" }, context())
  const queued = b.speak({ text: "Queued" }, context())
  await Promise.all([clip.started, speech.started])
  await ticks(() => mock.waits.has(1))
  const retained = mock.waits.get(1)!
  const old = mock.windows[0]
  old.webContents.emit("render-process-gone")
  await Promise.all([expect(clip.done).rejects.toThrow("MODS_AUDIO_BACKEND_LOST"),
    expect(speech.done).rejects.toThrow("MODS_AUDIO_BACKEND_LOST"),
    expect(queued.done).rejects.toThrow("MODS_AUDIO_BACKEND_LOST")])
  const fresh = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, context())
  await fresh.started
  await ticks(() => mock.waits.has(4))
  retained.resolve({ ok: true, value: { kind: "ended" } })
  old.emit("closed")
  expect(mock.windows[1].destroyed).toBe(false)
  end(4)
  await expect(fresh.done).resolves.toBe("ended")
})

it("counts opening and cleaning clips against count and encoded-byte limits", async () => {
  const ready = hold<void>()
  mock.ready = ready.promise
  const b = backend()
  const big = new Uint8Array(4 * 1024 * 1024)
  const jobs = Array.from({ length: 4 }, () => b.play({ bytes: big, mime: "audio/wav" }, context()))
  expect(() => b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, context())).toThrow("MODS_AUDIO_RESOURCE_LIMIT")
  const stops = jobs.map(job => job.stop())
  expect(b.stats.encodedBytes).toBe(16 * 1024 * 1024)
  ready.resolve()
  await Promise.all(stops)
  const small = Array.from({ length: 8 }, () => b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", shouldLoop: true }, context()))
  expect(() => b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, context())).toThrow("MODS_AUDIO_RESOURCE_LIMIT")
  await Promise.all(small.map(job => job.stop()))
  expect(b.stats.operations).toBe(0)
})

it("rejects invalid arguments and closing retires the service without replay", async () => {
  const b = backend()
  for (const gain of [-1, 4.1, Infinity, NaN])
    expect(() => b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", gain }, context())).toThrow("MODS_AUDIO_ARGUMENTS")
  expect(() => b.play({ bytes: new Uint8Array(4 * 1024 * 1024 + 1), mime: "audio/wav" }, context())).toThrow("MODS_AUDIO_BYTES_LIMIT")
  expect(() => b.speak({ text: "x".repeat(4097) }, context())).toThrow("MODS_AUDIO_SPEECH_ARGUMENTS")
  const job = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav", shouldLoop: true }, context())
  await job.started
  await b.close()
  await expect(job.done).rejects.toThrow("MODS_AUDIO_CLOSED")
  expect(() => b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, context())).toThrow("MODS_AUDIO_CLOSED")
  expect(b.stats).toMatchObject({ operations: 0, window: false, closed: true })
})

it("permission withdrawal after actual start ACK still cleans and rejects", async () => {
  const c = context()
  const reason = Error("original owner expired")
  mock.hook = method => {
    if (method === "startClip") c.assertLive.mockImplementation(() => { throw reason })
    return undefined
  }
  const b = backend()
  const job = b.play({ bytes: Uint8Array.of(1), mime: "audio/wav" }, c)
  await expect(job.done).rejects.toBe(reason)
  await expect(job.started).rejects.toBe(reason)
  expect(mock.calls.map(call => call.method)).toContain("stop")
  expect(b.stats.operations).toBe(0)
})
