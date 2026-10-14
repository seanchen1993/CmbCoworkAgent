// Standalone installed-Electron harness deliberately uses a CommonJS entry.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session } = require("electron")
const assert = require("node:assert/strict")
const { writeFileSync } = require("node:fs")
const { join, resolve } = require("node:path")
const { performance } = require("node:perf_hooks")
/* eslint-enable @typescript-eslint/no-require-imports */

function argument(name) {
  const prefix = "--" + name + "="
  const values = process.argv.filter(value => value.startsWith(prefix))
  if (values.length !== 1 || !values[0].slice(prefix.length)) throw Error("AUDIO_BACKEND_ARGUMENT")
  return resolve(values[0].slice(prefix.length))
}
const isolated = argument("audio-backend-root")
const resultPath = argument("audio-backend-result")
const bundle = argument("audio-backend-bundle")
app.setPath("userData", join(isolated, "electron"))
app.setPath("sessionData", join(isolated, "electron"))
app.setAppLogsPath(join(isolated, "logs"))
app.commandLine.appendSwitch("disable-background-networking")
app.commandLine.appendSwitch("disable-component-update")
// The parent bundles the actual two production leaves, never the business app or a mock player.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FunctionAudioBackend } = require(bundle)
const evidence = { kind: "actual-production-audio-backend", complete: false,
  sdkImplemented: false, hardwareAudibilityVerified: false, autoplayOverride: false,
  phases: [], failures: [], cleanup: [], surfaceFacts: [] }
const jobs = new Set()
const foreignWindows = new Set()
const observerPromises = new Map()
const observerFailures = []
let backend
let foreignHttp = 0
const started = performance.now()

const graphObserver = String.raw`
(() => {
  const gains = [], sources = [], utterances = [];
  const gainFactory = AudioContext.prototype.createGain;
  const sourceFactory = AudioContext.prototype.createBufferSource;
  const speak = speechSynthesis.speak;
  AudioContext.prototype.createGain = function(...args) {
    const gain = Reflect.apply(gainFactory, this, args);
    const analyser = this.createAnalyser();
    const silentMonitor = Reflect.apply(gainFactory, this, []);
    silentMonitor.gain.value = 0;
    analyser.fftSize = 1024;
    gain.connect(analyser);
    analyser.connect(silentMonitor);
    silentMonitor.connect(this.destination);
    gains.push({ gain, analyser });
    return gain;
  };
  AudioContext.prototype.createBufferSource = function(...args) {
    const source = Reflect.apply(sourceFactory, this, args);
    const start = source.start, stop = source.stop;
    const entry = { source, context: this, starts: 0, stops: 0, startAt: 0 };
    source.start = function(...values) {
      const value = Reflect.apply(start, this, values);
      entry.starts++; entry.startAt = entry.context.currentTime;
      return value;
    };
    source.stop = function(...values) {
      const value = Reflect.apply(stop, this, values);
      entry.stops++; return value;
    };
    sources.push(entry);
    return source;
  };
  speechSynthesis.speak = function(utterance) {
    utterances.push({ voice: utterance.voice?.name ?? null, local: utterance.voice?.localService === true });
    return Reflect.apply(speak, this, [utterance]);
  };
  Object.defineProperty(globalThis, "__audioObserved", { value: {
    read: () => ({
      nodeExposed: typeof globalThis.process !== "undefined",
      gains: gains.map(({gain,analyser}) => {
        const values = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(values);
        return { value: gain.gain.value,
          rms: Math.sqrt(values.reduce((sum,value) => sum + value * value,0) / values.length) };
      }),
      sources: sources.map(entry => ({ loop: entry.source.loop, starts: entry.starts,
        stops: entry.stops, duration: entry.source.buffer?.duration ?? null,
        elapsed: entry.context.currentTime - entry.startAt, state: entry.context.state })),
      utterances
    })
  } });
  return { installed: true };
})()
`
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-finish-load", () => {
    const pending = contents.executeJavaScript(graphObserver)
    observerPromises.set(contents.id, pending)
    void pending.catch(error => observerFailures.push(reason("graph-observer", error)))
  })
})

function reason(phase, error) {
  return { phase, name: error instanceof Error ? error.name : "NON_ERROR", undefined: error === undefined,
    code: error && typeof error === "object" && typeof error.code === "string" &&
      /^[A-Z_0-9]{1,80}$/.test(error.code) ? error.code : null }
}
function wav(seconds = 0.35) {
  const rate = 16000
  const frames = Math.round(seconds * rate)
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write("RIFF", 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36)
  bytes.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index++)
    bytes.writeInt16LE(Math.round(1600 * Math.sin(440 * Math.PI * index / rate)), 44 + index * 2)
  return bytes
}
function observe(job) {
  jobs.add(job)
  void job.done.then(() => jobs.delete(job), () => jobs.delete(job))
  return job
}
const delay = ms => new Promise(done => setTimeout(done, ms))
async function bounded(actual, ms) {
  let timer
  try {
    return await Promise.race([actual, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error("AUDIO_BACKEND_PHASE_TIMEOUT"),
        { code: "AUDIO_BACKEND_PHASE_TIMEOUT" })), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function phase(label, run) {
  const controller = new AbortController()
  const context = { signal: controller.signal, assertLive: () => controller.signal.throwIfAborted() }
  const row = { phase: label, ok: false, elapsedMs: 0 }
  const began = performance.now()
  try { await bounded(run(context), 25000); row.ok = true }
  catch (error) { evidence.failures.push(reason(label, error)) }
  finally {
    controller.abort(Error("Audio experiment phase retired"))
    const settled = await Promise.allSettled([...jobs].map(job => job.stop()))
    for (const result of settled) if (result.status === "rejected") {
      row.ok = false
      evidence.failures.push(reason(label + "-cleanup", result.reason))
    }
    row.elapsedMs = performance.now() - began
    evidence.phases.push(row)
  }
}
async function graph() {
  const windows = BrowserWindow.getAllWindows().filter(window => !foreignWindows.has(window))
  assert.equal(windows.length, 1)
  const window = windows[0]
  const prefs = window.webContents.getLastWebPreferences()
  const surface = { shown: window.isVisible(), sandbox: prefs.sandbox === true,
    contextIsolation: prefs.contextIsolation === true, nodeIntegration: prefs.nodeIntegration === true }
  evidence.surfaceFacts.push(surface)
  assert.deepEqual(surface, { shown: false, sandbox: true, contextIsolation: true, nodeIntegration: false })
  const installed = await observerPromises.get(window.webContents.id)
  assert.equal(installed?.installed, true)
  const result = await window.webContents.executeJavaScript("globalThis.__audioObserved.read()")
  assert.equal(result.nodeExposed, false)
  return result
}
async function cleanup(label, run) {
  try { await run(); evidence.cleanup.push({ phase: label, ok: true }) }
  catch (error) { evidence.cleanup.push({ ...reason(label, error), ok: false }) }
}

async function main() {
  try {
    await app.whenReady()
    backend = new FunctionAudioBackend()
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    await phase("actual-natural-ended", async context => {
      const job = observe(backend.play({ bytes: wav(), mime: "audio/wav", gain: 1 }, context))
      const began = performance.now()
      await job.started
      const actual = await graph()
      assert.equal(actual.sources.length, 1)
      assert.equal(actual.sources[0].starts, 1)
      assert.equal(actual.sources[0].state, "running")
      assert.equal(await job.done, "ended")
      assert(performance.now() - began >= 300)
      assert.equal(backend.stats.window, false)
    })
    await phase("actual-gain-parallel-loop-stop", async context => {
      const quiet = observe(backend.play({ bytes: wav(), mime: "audio/wav", gain: 0, shouldLoop: true }, context))
      const loud = observe(backend.play({ bytes: wav(), mime: "audio/wav", gain: 4, shouldLoop: true }, context))
      await Promise.all([quiet.started, loud.started])
      await delay(850)
      const before = await graph()
      assert.equal(backend.stats.operations, 2)
      assert.deepEqual(before.gains.map(gain => gain.value), [0, 4])
      assert(before.gains[0].rms < 0.000001)
      assert(before.gains[1].rms > 0.03)
      assert(before.sources.every(source => source.loop && source.starts === 1 &&
        source.state === "running" && source.elapsed >= source.duration * 2))
      await loud.stop()
      assert.equal(await loud.done, "stopped")
      await delay(600)
      const after = await graph()
      assert.equal(after.sources[1].stops, 1)
      assert.equal(after.sources[1].starts, 1)
      assert(after.gains[1].rms < 0.000001)
      evidence.actualGain = { values: before.gains.map(gain => gain.value),
        rms: before.gains.map(gain => gain.rms), stoppedRms: after.gains[1].rms,
        loopProgressSeconds: before.sources.map(source => source.elapsed) }
      await quiet.stop()
      assert.equal(await quiet.done, "stopped")
      assert.equal(backend.stats.window, false)
    })
    await phase("actual-parent-cancel-cleanup", async context => {
      const parent = new AbortController()
      const combined = { signal: AbortSignal.any([parent.signal, context.signal]),
        assertLive: () => { context.assertLive(); parent.signal.throwIfAborted() } }
      const job = observe(backend.play({ bytes: wav(), mime: "audio/wav", shouldLoop: true }, combined))
      await job.started
      const error = Error("Actual audio parent cancellation")
      parent.abort(error)
      await assert.rejects(job.done, reason => reason === error)
      assert.equal(backend.stats.operations, 0)
      assert.equal(backend.stats.window, false)
    })
    await phase("actual-local-speech-queue", async context => {
      const first = observe(backend.speak({ text: "Audio backend first." }, context))
      const second = observe(backend.speak({ text: "Audio backend second." }, context))
      let secondStarted = false
      void second.started.then(() => { secondStarted = true }, () => {})
      await first.started
      assert.equal(secondStarted, false)
      const before = await graph()
      assert.equal(before.utterances.length, 1)
      assert.equal(before.utterances[0].local, true)
      assert.deepEqual(await first.done, { via: "system" })
      await second.started
      const after = await graph()
      assert.equal(after.utterances.length, 2)
      assert(after.utterances.every(utterance => utterance.local === true))
      evidence.voices = after.utterances.map(utterance => utterance.voice)
      assert.deepEqual(await second.done, { via: "system" })
      assert.equal(backend.stats.window, false)
    })
    await phase("actual-speech-cancel-next-and-foreign", async context => {
      const current = observe(backend.speak({ text: "Audio backend cancellation. ".repeat(15) }, context))
      const next = observe(backend.speak({ text: "Audio backend kept next." }, context))
      await current.started
      const foreignSession = session.fromPartition("audio-backend-foreign-speech")
      foreignSession.setPermissionRequestHandler((_sender, _permission, done) => done(false))
      foreignSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] },
        (_details, done) => { foreignHttp++; done({ cancel: true }) })
      const foreign = new BrowserWindow({ show: false, width: 100, height: 100,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          backgroundThrottling: false, session: foreignSession } })
      foreignWindows.add(foreign)
      foreign.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
      await foreign.loadURL("about:blank")
      await foreign.webContents.executeJavaScript(String.raw`
        (async () => {
          const deadline = performance.now() + 4000;
          let voice;
          do {
            voice = speechSynthesis.getVoices().find(voice => voice.localService && voice.default);
            if (voice) break;
            await new Promise(done => setTimeout(done,20));
          } while (performance.now() < deadline);
          if (!voice) throw Error("AUDIO_FOREIGN_LOCAL_VOICE_MISSING");
          let resolve;
          const done = new Promise(end => { resolve = end; });
          const state = { began: false, ended: false, failed: false };
          const utterance = new SpeechSynthesisUtterance("Audio backend foreign speech remains independent. ".repeat(3));
          utterance.voice = voice;
          utterance.onstart = () => { state.began = true; };
          utterance.onend = () => { state.ended = true; resolve(state); };
          utterance.onerror = () => { state.failed = true; resolve(state); };
          Object.defineProperty(globalThis,"__foreignAudio",{value:{done,state}});
          speechSynthesis.speak(utterance);
          return { accepted: true };
        })()
      `)
      const before = await foreign.webContents.executeJavaScript("globalThis.__foreignAudio.state")
      await current.stop()
      await assert.rejects(current.done, { code: "MODS_AUDIO_STOPPED" })
      await next.started
      assert.deepEqual(await next.done, { via: "system" })
      const outside = await bounded(foreign.webContents.executeJavaScript("globalThis.__foreignAudio.done"), 20000)
      assert.deepEqual(outside, { began: true, ended: true, failed: false })
      evidence.foreignSpeech = { beganBeforeBackendStop: before.began, ...outside }
      foreign.destroy()
      foreignWindows.delete(foreign)
    })
    await phase("actual-invalid-media-and-voice", async context => {
      const corrupt = observe(backend.play({ bytes: Buffer.from([1, 2, 3]), mime: "audio/wav" }, context))
      await assert.rejects(corrupt.done, { code: "MODS_AUDIO_DECODE" })
      const long = observe(backend.play({ bytes: wav(121), mime: "audio/wav" }, context))
      await assert.rejects(long.done, { code: "MODS_AUDIO_DURATION_LIMIT" })
      const missing = observe(backend.speak({ text: "Missing voice", voice: "__MODS_AUDIO_MISSING_LOCAL_VOICE__" }, context))
      await assert.rejects(missing.done, { code: "MODS_AUDIO_VOICE_UNAVAILABLE" })
      assert.equal(backend.stats.operations, 0)
      assert.equal(backend.stats.window, false)
    })
    await phase("actual-close-retires-backend", async context => {
      const job = observe(backend.play({ bytes: wav(), mime: "audio/wav", shouldLoop: true }, context))
      await job.started
      await backend.close()
      await assert.rejects(job.done, { code: "MODS_AUDIO_CLOSED" })
      assert.throws(() => backend.play({ bytes: wav(), mime: "audio/wav" }, context), { code: "MODS_AUDIO_CLOSED" })
      assert.equal(backend.stats.operations, 0)
      assert.equal(backend.stats.window, false)
    })
  } catch (error) { evidence.failures.push(reason("main", error)) }
  finally {
    await cleanup("actual-jobs-stop", async () => {
      const results = await Promise.allSettled([...jobs].map(job => job.stop()))
      for (const result of results) if (result.status === "rejected") throw result.reason
    })
    await cleanup("production-backend-close", async () => { await backend?.close() })
    await cleanup("foreign-windows-close", async () => {
      for (const window of foreignWindows) if (!window.isDestroyed()) window.destroy()
      foreignWindows.clear()
    })
    evidence.observationFailures = observerFailures
    observerPromises.clear()
    evidence.httpAttempts = (backend?.stats.networkAttempts ?? 0) + foreignHttp
    evidence.windowsRemaining = BrowserWindow.getAllWindows().length
    evidence.elapsedMs = performance.now() - started
    evidence.complete = evidence.phases.length === 7 && evidence.phases.every(row => row.ok) &&
      evidence.failures.length === 0 && evidence.cleanup.every(row => row.ok) &&
      observerFailures.length === 0 && evidence.httpAttempts === 0 && evidence.windowsRemaining === 0 &&
      app.getPath("userData") === join(isolated, "electron")
    try { writeFileSync(resultPath, JSON.stringify(evidence, null, 2) + "\n") }
    catch (error) { evidence.complete = false; console.error(JSON.stringify(reason("evidence-write", error))) }
    process.exitCode = evidence.complete ? 0 : 1
    app.quit()
  }
}
main().catch(error => { console.error(JSON.stringify(reason("unexpected", error))); app.exit(1) })
