import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { FUNCTION_AUDIO_RENDERER } from "./audio-renderer"

type BufferShape = { duration: number; length: number; numberOfChannels: number }
type Reply = { ok: boolean; value?: Record<string, unknown>; code?: string }
type Utterance = { voice?: { name: string }; onstart?: (() => void) | null;
  onend?: (() => void) | null; onerror?: (() => void) | null }
function harness(buffer: BufferShape = { duration: 1, length: 16000, numberOfChannels: 1 }) {
  const sources: Array<{ started: boolean; stopped: boolean; disconnected: boolean;
    buffer?: BufferShape; loop: boolean; onended?: (() => void) | null }> = []
  const gains: Array<{ gain: { value: number }; disconnected: boolean }> = []
  const spoken: Utterance[] = []
  const voices = [
    { name: "Remote", default: true, localService: false },
    { name: "Local default", default: true, localService: true },
    { name: "Local explicit", default: false, localService: true }
  ]
  const speech = { speaking: false, pending: false, cancels: 0,
    getVoices: () => voices,
    speak: (utterance: Utterance) => { speech.speaking = true; spoken.push(utterance) },
    cancel: () => { speech.cancels++; speech.speaking = false; spoken.at(-1)?.onerror?.() } }
  let decode = () => Promise.resolve(buffer)
  let closed = false
  class Context {
    state = "suspended"
    destination = {}
    decodeAudioData() { return decode() }
    async resume() { this.state = "running" }
    async close() { this.state = "closed"; closed = true }
    createBufferSource() {
      const source = { started: false, stopped: false, disconnected: false,
        buffer: undefined as BufferShape | undefined, loop: false,
        onended: undefined as (() => void) | null | undefined,
        connect: () => {}, disconnect: () => { source.disconnected = true },
        start: () => { source.started = true }, stop: () => { source.stopped = true } }
      sources.push(source)
      return source
    }
    createGain() {
      const gain = { gain: { value: 1 }, disconnected: false,
        connect: () => {}, disconnect: () => { gain.disconnected = true } }
      gains.push(gain)
      return gain
    }
  }
  const sandbox = { AudioContext: Context, speechSynthesis: speech,
    SpeechSynthesisUtterance: class { constructor(readonly text: string) {} },
    atob: (text: string) => Buffer.from(text, "base64").toString("binary"),
    performance, setTimeout }
  const ready = runInNewContext(FUNCTION_AUDIO_RENDERER, sandbox)
  expect(ready).toMatchObject({ ready: true, nodeExposed: false })
  const api = (sandbox as typeof sandbox & {
    __modsAudioRenderer: { call(method: string, input?: object): Promise<Reply> }
  }).__modsAudioRenderer
  const clip = (id: number, gain = 1, shouldLoop = false) => api.call("prepareClip", {
    id, base64: Buffer.from([1]).toString("base64"), mime: "audio/wav", gain, shouldLoop
  })
  return { api, clip, sources, gains, speech, spoken, voices,
    setDecode: (value: () => Promise<BufferShape>) => { decode = value }, closed: () => closed }
}

it("fixed renderer installs independent source/gain graphs and only ended resolves a single play", async () => {
  const f = harness()
  await f.clip(1, 0)
  await f.clip(2, 4, true)
  expect(await f.api.call("startClip", { id: 1 })).toMatchObject({ ok: true, value: { started: true } })
  await f.api.call("startClip", { id: 2 })
  expect(f.gains.map(gain => gain.gain.value)).toEqual([0, 4])
  expect(f.sources.map(source => source.loop)).toEqual([false, true])
  const done = f.api.call("wait", { id: 1 })
  f.sources[0].onended!()
  expect(await done).toMatchObject({ ok: true, value: { kind: "ended" } })
  const loop = f.api.call("wait", { id: 2 })
  expect(await f.api.call("stop", { id: 2 })).toMatchObject({ ok: true, value: { stopped: true } })
  expect(await loop).toMatchObject({ ok: true, value: { kind: "stopped" } })
  expect(f.sources.every(source => source.disconnected)).toBe(true)
  expect(f.gains.every(gain => gain.disconnected)).toBe(true)
  await f.api.call("forget", { id: 1 })
  await f.api.call("forget", { id: 2 })
  expect(await f.api.call("close")).toMatchObject({ ok: true, value: { closed: true } })
  expect(f.closed()).toBe(true)
})

it("stop during decode retains a tombstone and cannot start after the decode finishes", async () => {
  const f = harness()
  let resolve!: (value: BufferShape) => void
  f.setDecode(() => new Promise(done => { resolve = done }))
  const preparing = f.clip(1)
  const stopping = f.api.call("stop", { id: 1 })
  let acknowledged = false
  void stopping.then(() => { acknowledged = true })
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  resolve({ duration: 1, length: 16000, numberOfChannels: 1 })
  expect(await preparing).toMatchObject({ ok: true, value: { stopped: true } })
  expect(await stopping).toMatchObject({ ok: true, value: { stopped: true } })
  expect(await f.api.call("startClip", { id: 1 })).toMatchObject({ ok: true, value: { stopped: true } })
  expect(f.sources).toHaveLength(0)
  await f.api.call("forget", { id: 1 })
  await f.api.call("close")
})

it("checks actual decoded duration and cumulative byte facts before source creation", async () => {
  const tooLong = harness({ duration: 120.01, length: 1, numberOfChannels: 1 })
  expect(await tooLong.clip(1)).toMatchObject({ ok: false, code: "MODS_AUDIO_DURATION_LIMIT" })
  expect(tooLong.sources).toHaveLength(0)
  await tooLong.api.call("close")
  const f = harness({ duration: 1, length: 8 * 1024 * 1024, numberOfChannels: 1 })
  expect((await f.clip(1)).ok).toBe(true)
  expect((await f.clip(2)).ok).toBe(true)
  expect(await f.clip(3)).toMatchObject({ ok: false, code: "MODS_AUDIO_DECODED_LIMIT" })
  await f.api.call("stop", { id: 1 })
  expect((await f.clip(4)).ok).toBe(true)
  expect(await f.api.call("close")).toMatchObject({ ok: true, value: { closed: true } })
})

it("uses local voices and requires real start and end before speech completion", async () => {
  const f = harness()
  expect(await f.api.call("prepareSpeech", { id: 1, text: "Plain text" })).toMatchObject({ ok: true })
  const started = f.api.call("startSpeech", { id: 1 })
  for (let tick = 0; tick < 8 && !f.spoken.length; tick++) await Promise.resolve()
  expect(f.spoken[0].voice?.name).toBe("Local default")
  f.spoken[0].onstart!()
  expect(await started).toMatchObject({ ok: true, value: { started: true } })
  const done = f.api.call("wait", { id: 1 })
  f.speech.speaking = false
  f.spoken[0].onend!()
  expect(await done).toMatchObject({ ok: true, value: { kind: "ended" } })
  expect(await f.api.call("prepareSpeech", { id: 2, text: "Remote rejected", voice: "Remote" }))
    .toMatchObject({ ok: false, code: "MODS_AUDIO_VOICE_UNAVAILABLE" })
  await f.api.call("close")
})

it("stopping accepted speech before onstart prevents a later start callback from becoming success", async () => {
  const f = harness()
  await f.api.call("prepareSpeech", { id: 1, text: "Stop pending", voice: "Local explicit" })
  const started = f.api.call("startSpeech", { id: 1 })
  for (let tick = 0; tick < 8 && !f.spoken.length; tick++) await Promise.resolve()
  const lateStart = f.spoken[0].onstart!
  expect(await f.api.call("stop", { id: 1 })).toMatchObject({ ok: true, value: { stopped: true } })
  lateStart()
  expect(await started).toMatchObject({ ok: true, value: { started: false } })
  expect(await f.api.call("wait", { id: 1 })).toMatchObject({ ok: true, value: { kind: "stopped" } })
  expect(f.speech.cancels).toBe(1)
  await f.api.call("close")
})
