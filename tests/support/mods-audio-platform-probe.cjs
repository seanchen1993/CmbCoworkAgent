// Standalone Electron entry runs as CommonJS without the product build.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session } = require("electron")
const { writeFileSync } = require("node:fs")
const { join, resolve } = require("node:path")
const { performance } = require("node:perf_hooks")
/* eslint-enable @typescript-eslint/no-require-imports */

function argument(name) {
  const prefix = "--" + name + "="
  const values = process.argv.filter(value => value.startsWith(prefix))
  if (values.length !== 1 || !values[0].slice(prefix.length))
    throw Error("AUDIO_PROBE_ARGUMENT")
  return resolve(values[0].slice(prefix.length))
}
const isolated = argument("audio-probe-root")
const resultPath = argument("audio-probe-result")
app.setPath("userData", join(isolated, "electron"))
app.setPath("sessionData", join(isolated, "electron"))
app.setPath("logs", join(isolated, "logs"))
app.commandLine.appendSwitch("disable-background-networking")
app.commandLine.appendSwitch("disable-component-update")
const started = performance.now()
const evidence = {
  kind: "actual-electron-audio-platform",
  complete: false,
  sdkImplemented: false,
  hardwareAudibilityVerified: false,
  autoplayOverride: false,
  httpAttempts: 0,
  renderer: null,
  failures: [],
  cleanup: []
}
let window

function reason(phase, error) {
  return { phase, name: error instanceof Error ? error.name : "NON_ERROR",
    undefined: error === undefined }
}

function wav() {
  const sampleRate = 16_000, frames = 5600
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write("RIFF", 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36)
  bytes.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index++)
    bytes.writeInt16LE(Math.round(Math.sin(index * Math.PI * 440 / sampleRate) * 1600),
      44 + index * 2)
  return bytes.toString("base64")
}

async function rendererProbe(base64) {
  const result = { phases: [], failures: [], cleanup: [], voices: [], hidden: document.hidden,
    nodeExposed: typeof globalThis.process !== "undefined", autoplayOverride: false }
  const audio = []
  let context
  let blobUrl
  let utterance
  const fail = code => { throw Object.assign(new Error(code), { probeCode: code }) }
  const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds))
  const metadata = (phase, error) => ({ phase,
    code: typeof error?.probeCode === "string" ? error.probeCode : "PLATFORM_EXCEPTION",
    name: error instanceof Error ? error.name : "NON_ERROR",
    undefined: error === undefined })
  async function phase(name, operation) {
    const begin = performance.now()
    try {
      const facts = await operation()
      result.phases.push({ phase: name, ok: true, elapsedMs: performance.now() - begin, ...facts })
    } catch (error) {
      const failure = metadata(name, error)
      result.failures.push(failure)
      result.phases.push({ ...failure, ok: false, elapsedMs: performance.now() - begin })
    }
  }
  async function cleanup(name, operation) {
    try { await operation(); result.cleanup.push({ phase: name, ok: true }) }
    catch (error) { result.cleanup.push({ ...metadata(name, error), ok: false }) }
  }
  async function until(read, accepts, milliseconds, code) {
    const deadline = performance.now() + milliseconds
    while (performance.now() < deadline) {
      const value = read()
      if (accepts(value)) return value
      await pause(20)
    }
    fail(code)
  }
  async function within(promise, milliseconds, code) {
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { probeCode: code })),
          milliseconds)
      })])
    } finally { clearTimeout(timer) }
  }
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
  try {
    await phase("pcm-decode", async () => {
      context = new AudioContext()
      const decoded = await within(context.decodeAudioData(bytes.buffer.slice(0)),
        10_000, "PCM_DECODE_TIMEOUT")
      if (decoded.numberOfChannels !== 1 || Math.abs(decoded.duration - 0.35) > 0.01)
        fail("PCM_DECODE_SHAPE")
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))
      return { channels: decoded.numberOfChannels, sampleRate: decoded.sampleRate,
        frames: decoded.length, durationMs: decoded.duration * 1000 }
    })
    await phase("single-natural-ended", async () => {
      if (!blobUrl) fail("PCM_SOURCE_UNAVAILABLE")
      const player = new Audio(blobUrl)
      audio.push(player)
      let playing = false, ended = false, mediaError = 0
      player.addEventListener("playing", () => { playing = true })
      player.addEventListener("ended", () => { ended = true })
      player.addEventListener("error", () => { mediaError = player.error?.code ?? -1 })
      try {
        await within(player.play(), 10_000, "PLAY_START_TIMEOUT")
        await until(() => ({ playing, ended, mediaError }), value => value.ended || value.mediaError,
          10_000, "PLAY_END_TIMEOUT")
        if (mediaError) fail("MEDIA_ERROR_" + mediaError)
        if (!playing || !ended || player.currentTime < 0.3) fail("PLAY_END_UNCONFIRMED")
        return { playing, ended, currentTimeMs: player.currentTime * 1000,
          durationMs: player.duration * 1000 }
      } finally { player.pause() }
    })
    await phase("loop-progress-and-stop", async () => {
      if (!blobUrl) fail("PCM_SOURCE_UNAVAILABLE")
      const player = new Audio(blobUrl)
      audio.push(player)
      player.loop = true
      let playing = false, mediaError = 0, wraps = 0, last = 0
      let stopRequested = false, resumed = false
      player.addEventListener("playing", () => {
        playing = true
        if (stopRequested && !player.paused) resumed = true
      })
      player.addEventListener("error", () => { mediaError = player.error?.code ?? -1 })
      try {
        await within(player.play(), 10_000, "LOOP_START_TIMEOUT")
        const begin = performance.now()
        await until(() => {
          const current = player.currentTime
          if (current + 0.05 < last) wraps++
          last = current
          return { duration: player.duration, progress: wraps * player.duration + current,
            elapsed: performance.now() - begin }
        }, value => {
          if (mediaError) fail("MEDIA_ERROR_" + mediaError)
          return playing && Number.isFinite(value.duration) && wraps >= 2 &&
            value.progress >= 2 * value.duration && value.elapsed >= 2 * value.duration * 1000
        }, 10_000, "LOOP_PROGRESS_TIMEOUT")
        player.pause()
        stopRequested = true
        const stopped = player.currentTime
        await pause(Math.ceil(player.duration * 1500))
        if (!player.paused || Math.abs(player.currentTime - stopped) > 0.015 || resumed)
          fail("LOOP_STOP_UNCONFIRMED")
        return { playing, wraps, progressMs: (wraps * player.duration + stopped) * 1000,
          paused: player.paused, resumed: false }
      } finally { player.pause() }
    })
    await phase("local-default-voices", async () => {
      if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined")
        fail("SYSTEM_SPEECH_API_UNAVAILABLE")
      const voices = await until(() => speechSynthesis.getVoices(), value => value.length > 0,
        4000, "SYSTEM_VOICES_UNAVAILABLE")
      result.voices = voices.map(voice => ({ name: voice.name, lang: voice.lang,
        localService: voice.localService, default: voice.default }))
      const voice = voices.find(candidate => candidate.default && candidate.localService)
      if (!voice) fail("LOCAL_DEFAULT_VOICE_UNAVAILABLE")
      return { count: voices.length, localDefault: voice.name }
    })
    await phase("system-speech-ended", async () => {
      if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined")
        fail("SYSTEM_SPEECH_API_UNAVAILABLE")
      const voice = speechSynthesis.getVoices().find(candidate => candidate.default && candidate.localService)
      if (!voice) fail("LOCAL_DEFAULT_VOICE_UNAVAILABLE")
      utterance = new SpeechSynthesisUtterance("Audio platform probe.")
      utterance.voice = voice
      let began = false, ended = false, errorCode
      const known = ["not-allowed", "network", "synthesis-unavailable", "synthesis-failed",
        "voice-unavailable", "language-unavailable", "canceled", "interrupted", "audio-busy",
        "audio-hardware", "text-too-long", "invalid-argument"]
      utterance.onstart = () => { began = true }
      utterance.onend = () => { ended = true }
      utterance.onerror = event => {
        errorCode = known.includes(event.error) ? event.error : "other"
      }
      try {
        speechSynthesis.speak(utterance)
        await until(() => ({ began, ended, errorCode }), value => value.ended || value.errorCode,
          15_000, "SYSTEM_SPEECH_END_TIMEOUT")
        if (errorCode) fail("SYSTEM_SPEECH_" + errorCode.toUpperCase().replaceAll("-", "_"))
        if (!began || !ended) fail("SYSTEM_SPEECH_END_UNCONFIRMED")
        return { began, ended, localDefault: voice.name, via: "system" }
      } finally { speechSynthesis.cancel() }
    })
  } finally {
    for (const [index, player] of audio.entries()) await cleanup("audio-" + index, async () => {
      player.pause()
      player.removeAttribute("src")
      player.load()
      if (!player.paused) fail("AUDIO_CLEANUP_UNCONFIRMED")
    })
    await cleanup("speech-cancel", async () => {
      if (typeof speechSynthesis !== "undefined") {
        speechSynthesis.cancel()
        await until(() => speechSynthesis.speaking || speechSynthesis.pending, value => !value,
          1000, "SPEECH_CLEANUP_UNCONFIRMED")
      }
      if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null
    })
    await cleanup("audio-context-close", async () => {
      if (context && context.state !== "closed")
        await within(context.close(), 1000, "CONTEXT_CLEANUP_TIMEOUT")
      if (context && context.state !== "closed") fail("CONTEXT_CLEANUP_UNCONFIRMED")
    })
    await cleanup("blob-revoke", async () => { if (blobUrl) URL.revokeObjectURL(blobUrl) })
  }
  result.complete = result.failures.length === 0 && result.cleanup.every(row => row.ok) &&
    result.nodeExposed === false
  return result
}

async function main() {
  try {
    await app.whenReady()
    const probeSession = session.fromPartition("audio-platform-probe")
    probeSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    probeSession.webRequest.onBeforeRequest({ urls: [
      "http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"
    ] }, (_details, callback) => {
      evidence.httpAttempts++
      callback({ cancel: true })
    })
    window = new BrowserWindow({ show: false, width: 200, height: 100,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, spellcheck: false, session: probeSession } })
    const preferences = window.webContents.getLastWebPreferences()
    evidence.sandbox = preferences.sandbox === true
    evidence.contextIsolation = preferences.contextIsolation === true
    evidence.nodeIntegration = preferences.nodeIntegration === true
    evidence.userDataIsolated = app.getPath("userData") === join(isolated, "electron")
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    await window.loadURL("about:blank")
    evidence.windowShown = window.isVisible()
    evidence.renderer = await window.webContents.executeJavaScript(
      "(" + rendererProbe.toString() + ")(" + JSON.stringify(wav()) + ")"
    )
    if (evidence.renderer.complete !== true)
      evidence.failures.push({ phase: "renderer-platform", name: "PLATFORM_PHASE_FAILED" })
  } catch (error) {
    evidence.failures.push(reason("main", error))
  } finally {
    try {
      if (window && !window.isDestroyed()) window.destroy()
      evidence.windowDestroyed = !window || window.isDestroyed()
      evidence.cleanup.push({ phase: "window-destroy", ok: evidence.windowDestroyed })
    } catch (error) {
      evidence.cleanup.push({ ...reason("window-destroy", error), ok: false })
    }
    evidence.elapsedMs = performance.now() - started
    evidence.complete = evidence.renderer?.complete === true && evidence.httpAttempts === 0 &&
      evidence.failures.length === 0 && evidence.cleanup.every(row => row.ok) &&
      evidence.windowShown === false && evidence.sandbox && evidence.contextIsolation &&
      !evidence.nodeIntegration && evidence.userDataIsolated
    try {
      writeFileSync(resultPath, JSON.stringify(evidence, null, 2) + "\n")
    } catch (error) {
      evidence.complete = false
      console.error(JSON.stringify(reason("platform-result-write", error)))
    }
    process.exitCode = evidence.complete ? 0 : 1
    app.quit()
  }
}

main().catch(error => {
  console.error(JSON.stringify(reason("unexpected-main", error)))
  app.exit(1)
})
