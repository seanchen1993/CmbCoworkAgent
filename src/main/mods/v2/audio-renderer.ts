/** Fixed sandbox program. No plugin source, paths, URLs or authority enter this renderer. */
export const FUNCTION_AUDIO_RENDERER = String.raw`
(() => {
  const entries = new Map();
  const stopped = new Set();
  let context;
  let decodedBytes = 0;
  const fail = code => { throw Error(code); };
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const delay = ms => new Promise(done => setTimeout(done, ms));
  const release = entry => {
    if (entry.source) {
      entry.source.onended = null;
      entry.source.disconnect();
      entry.source = undefined;
    }
    if (entry.gain) { entry.gain.disconnect(); entry.gain = undefined; }
    if (entry.buffer) {
      decodedBytes -= entry.decodedBytes;
      entry.buffer = undefined;
      entry.decodedBytes = 0;
    }
  };
  const finish = (entry, kind) => {
    if (entry.terminal) return;
    entry.terminal = kind;
    release(entry);
    entry.done.resolve({ kind });
  };
  async function prepareClip(input) {
    if (entries.has(input.id)) fail("MODS_AUDIO_DUPLICATE");
    if (stopped.has(input.id)) return { stopped: true };
    const entry = { id: input.id, kind: "clip", done: deferred(), decodedBytes: 0,
      stopped: false, started: false, terminal: undefined };
    entries.set(input.id, entry);
    entry.preparing = (async () => {
      try {
        context ??= new AudioContext();
        const binary = atob(input.base64);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        let buffer;
        try { buffer = await context.decodeAudioData(bytes.buffer); }
        catch { fail("MODS_AUDIO_DECODE"); }
        if (entry.stopped || stopped.has(input.id)) return { stopped: true };
        const size = buffer.length * buffer.numberOfChannels * 4;
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 120)
          fail("MODS_AUDIO_DURATION_LIMIT");
        if (!Number.isSafeInteger(size) || size <= 0 || decodedBytes + size > 64 * 1024 * 1024)
          fail("MODS_AUDIO_DECODED_LIMIT");
        entry.buffer = buffer;
        entry.decodedBytes = size;
        decodedBytes += size;
        entry.gainValue = input.gain;
        entry.loop = input.shouldLoop;
        return { duration: buffer.duration, decodedBytes: size };
      } catch (error) {
        finish(entry, "failed");
        throw error;
      }
    })();
    return entry.preparing;
  }
  async function startClip(input) {
    const entry = entries.get(input.id);
    if (!entry || entry.kind !== "clip") fail("MODS_AUDIO_UNAVAILABLE");
    await entry.preparing;
    if (entry.stopped || stopped.has(input.id)) return { stopped: true };
    try { await context.resume(); } catch { fail("MODS_AUDIO_CONTEXT"); }
    if (entry.stopped || stopped.has(input.id)) return { stopped: true };
    if (context.state !== "running" || !entry.buffer) fail("MODS_AUDIO_CONTEXT");
    const source = context.createBufferSource();
    const gain = context.createGain();
    entry.source = source;
    entry.gain = gain;
    source.buffer = entry.buffer;
    source.loop = entry.loop;
    gain.gain.value = entry.gainValue;
    source.connect(gain);
    gain.connect(context.destination);
    source.onended = () => finish(entry, entry.stopped ? "stopped" : "ended");
    source.start();
    entry.started = true;
    return { started: true };
  }
  async function prepareSpeech(input) {
    if (entries.has(input.id)) fail("MODS_AUDIO_DUPLICATE");
    if (stopped.has(input.id)) return { stopped: true };
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance)
      fail("MODS_AUDIO_SYNTHESIZER_UNAVAILABLE");
    const entry = { id: input.id, kind: "speech", done: deferred(), began: deferred(),
      stopped: false, started: false, terminal: undefined };
    entries.set(input.id, entry);
    entry.preparing = (async () => {
      const deadline = performance.now() + 4000;
      let voices = [];
      do {
        if (entry.stopped || stopped.has(input.id)) return { stopped: true };
        voices = speechSynthesis.getVoices().filter(voice => voice.localService === true);
        if (voices.length) break;
        await delay(20);
      } while (performance.now() < deadline);
      const voice = input.voice === undefined
        ? voices.find(item => item.default) : voices.find(item => item.name === input.voice);
      if (!voice) fail("MODS_AUDIO_VOICE_UNAVAILABLE");
      const utterance = new SpeechSynthesisUtterance(input.text);
      utterance.voice = voice;
      entry.utterance = utterance;
      utterance.onstart = () => {
        if (entry.stopped || entry.terminal) return;
        entry.started = true;
        entry.began.resolve({ started: true });
      };
      utterance.onend = () => {
        if (entry.stopped) { finish(entry, "stopped"); return; }
        if (!entry.started) { finish(entry, "failed"); return; }
        finish(entry, "ended");
      };
      utterance.onerror = () => {
        entry.began.resolve({ started: false });
        finish(entry, entry.stopped ? "stopped" : "failed");
      };
      return { prepared: true };
    })();
    return entry.preparing;
  }
  async function startSpeech(input) {
    const entry = entries.get(input.id);
    if (!entry || entry.kind !== "speech") fail("MODS_AUDIO_UNAVAILABLE");
    await entry.preparing;
    if (entry.stopped || stopped.has(input.id)) return { stopped: true };
    speechSynthesis.speak(entry.utterance);
    return entry.began.promise;
  }
  async function stop(input) {
    stopped.add(input.id);
    const entry = entries.get(input.id);
    if (!entry) return { stopped: true };
    entry.stopped = true;
    if (entry.preparing) await entry.preparing.catch(() => {});
    if (entry.kind === "clip") {
      if (entry.source) entry.source.stop();
      // stop/disconnect are actual WebAudio operations, even if ended delivery is later.
      finish(entry, entry.terminal ?? "stopped");
    } else {
      if (!entry.terminal && entry.utterance && entry.started) speechSynthesis.cancel();
      // A speak request may be accepted before its onstart callback arrives.
      else if (!entry.terminal && entry.utterance) speechSynthesis.cancel();
      const deadline = performance.now() + 2000;
      while (speechSynthesis.speaking || speechSynthesis.pending) {
        if (performance.now() >= deadline) fail("MODS_AUDIO_STOP_UNCONFIRMED");
        await delay(20);
      }
      entry.began.resolve({ started: false });
      finish(entry, entry.terminal ?? "stopped");
      if (entry.utterance) {
        entry.utterance.onstart = null;
        entry.utterance.onend = null;
        entry.utterance.onerror = null;
        entry.utterance = undefined;
      }
    }
    return { stopped: true };
  }
  async function wait(input) {
    const entry = entries.get(input.id);
    if (!entry) fail("MODS_AUDIO_UNAVAILABLE");
    return entry.done.promise;
  }
  async function forget(input) {
    const entry = entries.get(input.id);
    if (entry && !entry.terminal) fail("MODS_AUDIO_CLEANUP_PENDING");
    entries.delete(input.id);
    stopped.delete(input.id);
    return { forgotten: true };
  }
  async function close() {
    for (const id of entries.keys()) { await stop({ id }); await forget({ id }); }
    stopped.clear();
    if (context) { await context.close(); context = undefined; }
    if (decodedBytes !== 0) fail("MODS_AUDIO_CLEANUP_PENDING");
    return { closed: true };
  }
  const methods = { prepareClip, startClip, prepareSpeech, startSpeech, stop, wait, forget, close };
  Object.defineProperty(globalThis, "__modsAudioRenderer", { value: Object.freeze({
    call: async (method, input) => {
      try {
        if (!Object.hasOwn(methods, method)) fail("MODS_AUDIO_METHOD");
        return { ok: true, value: await methods[method](input) };
      } catch (error) {
        const code = error instanceof Error && /^MODS_AUDIO_[A-Z_]+$/.test(error.message)
          ? error.message : "MODS_AUDIO_RENDERER_FAILED";
        return { ok: false, code };
      }
    }
  }) });
  return { ready: true, nodeExposed: typeof globalThis.process !== "undefined" };
})()
`
