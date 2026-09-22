export function register(on) {
  on("command.run", { command: "cmb-pinned" }, ($, e, next) =>
    next({ ...e, command: "cmb-redirected" })
  )
  on("command.run", { command: "cmb-pinned-omitted" }, ($, e, next) => next({ args: "rewritten" }))
  on("turn.step", { model: "cmb-transform" }, async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) yield { ...chunk, text: chunk.text.toUpperCase() }
    return { ...(await stream.result), answer: "terminal-value" }
  })
  on("turn.step", { model: "cmb-delegate" }, async function* ($, e, next) {
    return yield* next(e)
  })
  on("turn.step", { model: "cmb-stream-fail" }, async function* ($, e, next) {
    for await (const chunk of next(e)) {
      yield { ...chunk, text: "wrapped-" + chunk.text }
      throw Error("failed-after-first")
    }
  })
  on("turn.step", { model: "cmb-stream-double" }, async function* ($, e, next) {
    yield* next(e)
    return yield* next(e)
  })
  on("turn.step", { model: "cmb-stream-throw-before" }, async function* () {
    throw Error("before-stream")
  })
  on("turn.step", { model: "cmb-stream-catch" }, async function* () {
    throw Error("before-stream-catch")
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })
  on("command.run", { command: "cmb-order" }, async ($, e, next) => {
    const r = await next({ ...e, args: e.args + "A" })
    return { text: "A(" + r.text + ")" }
  })
  on("command.run", { command: "cmb-order" }, async ($, e, next) => {
    const r = await next({ ...e, args: e.args + "B" })
    return { text: "B(" + r.text + ")" }
  })
  on("command.run", { command: "cmb-double" }, async ($, e, next) => {
    const a = await next(e)
    const b = await next(e)
    return { text: a.text + "," + b.text }
  })
  on("command.run", { command: "cmb-throw-before" }, () => {
    throw new Error("probe-before")
  })
  on("command.run", { command: "cmb-throw-after" }, async ($, e, next) => {
    await next(e)
    throw new Error("probe-after")
  })
  on("command.run", { command: "cmb-catch" }, () => {
    throw new Error("probe-catch")
  }).catch(() => ({ text: "REFUSED_BY_CATCH" }))
  on("command.run", { command: "cmb-short" }, () => ({ text: "SHORT" }))
  on("command.run", { command: "cmb-trace" }, async ($, e, next) => {
    const r = await next(e)
    return {
      text: JSON.stringify({
        text: r.text,
        entries: next.trace.length,
        origin: next.origin,
        aborted: next.signal.aborted
      })
    }
  })
  on("command.run", { command: "cmb-downstream-error" }, async ($, e, next) => next(e))
  on("command.run", { command: "cmb-catch-replay" }, async ($, e, next) => {
    await next(e)
    throw new Error("recover-after")
  }).catch(async ($, e, next) => {
    const a = await next(e)
    const b = await next(e)
    return { text: `${next.called}:${next.error.kind}:${a.text}:${b.text}` }
  })
  on("command.run", { command: "cmb-catch-once" }, () => {
    throw new Error("recover-before")
  }).catch(async ($, e, next) => {
    const a = await next(e)
    const b = await next(e)
    return { text: `${next.called}:${next.error.kind}:${a.text}:${b.text}` }
  })
  on("command.run", { command: "cmb-undefined-after" }, async ($, e, next) => {
    await next(e)
  })
  on("command.run", { command: "cmb-undefined-before" }, () => undefined)
  on("command.*", { command: "cmb-pattern" }, async ($, e, next) => ({
    text: `${next.event}:${next.is("command.*", e)}:${next.is("!tool.*", e)}`
  }))
}
