import { expect, it } from "vitest"
import { FunctionSessionInitializer } from "./session-initializer"

it("explicit restart allows approved effects but keeps caught failures sticky", () => {
  const init = new FunctionSessionInitializer("restart")
  expect(() => init.assertMethod("store.set")).not.toThrow()
  expect(() => init.assertMethod("process.spawn")).not.toThrow()
  expect(init.strict).toBe(true)
  init.record(Error("approved operation failed"))
  expect(() => init.activate()).toThrow("approved operation failed")
})

it("initialization cancellation aborts immediately and detaches once the runtime is active", () => {
  const parent = new AbortController(),
    runtime = new AbortController()
  const initial = new FunctionSessionInitializer("restart")
  initial.bindCancellation(parent.signal, (reason) => runtime.abort(reason))
  parent.abort(Error("owner lost"))
  expect(runtime.signal.aborted).toBe(true)
  const nextParent = new AbortController(),
    nextRuntime = new AbortController()
  const next = new FunctionSessionInitializer("restart")
  next.bindCancellation(nextParent.signal, (reason) => nextRuntime.abort(reason))
  next.activate()
  nextParent.abort()
  expect(nextRuntime.signal.aborted).toBe(false)
})

it("caught forbidden effects remain sticky and cannot be activated", () => {
  for (const method of [
    "store.set",
    "fs.write",
    "config.set",
    "clock.every",
    "model.complete",
    "agent.spawn",
    "process.spawn",
    "http.fetch",
    "ui.log",
    "prompt.submit",
    "tool.call"
  ]) {
    const init = new FunctionSessionInitializer(true)
    try {
      init.assertMethod(method)
    } catch {
      /* A guest can catch this, but cannot clear it. */
    }
    expect(() => init.assertReady()).toThrow("参数已保存")
    expect(() => init.activate()).toThrow("参数已保存")
  }
})

it("current host activation enables regular calls without leaking a captured candidate mode", () => {
  const init = new FunctionSessionInitializer(true)
  const later = () => init.assertMethod("store.set")
  for (const method of [
    "command.register",
    "tool.register",
    "agent.register",
    "store.get",
    "config.list"
  ])
    expect(() => init.assertMethod(method)).not.toThrow()
  init.activate()
  expect(later).not.toThrow()
  expect(init.strict).toBe(false)
})

it("matcher or guest failure rejects a candidate even if the optional dispatcher recovers", () => {
  const init = new FunctionSessionInitializer(true)
  init.record(Error("matcher failed"))
  expect(() => init.assertReady()).toThrow("matcher failed")
  const ordinary = new FunctionSessionInitializer(false)
  ordinary.record(Error("optional failure"))
  expect(() => ordinary.assertReady()).not.toThrow()
})

it("keeps a held candidate admission read-only after normal calls become active", () => {
  const init = new FunctionSessionInitializer(true)
  const held = init.captureAdmission()
  init.activate()
  expect(() => init.assertMethod("store.set")).not.toThrow()
  expect(() => held.assertMethod("store.get")).not.toThrow()
  expect(() => held.assertMethod("store.set")).toThrowError(
    expect.objectContaining({ code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" })
  )
  expect(() => init.assertReady()).toThrowError(
    expect.objectContaining({ code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" })
  )
})

it("preserves captured restart effects and its caught initialization failure", () => {
  const init = new FunctionSessionInitializer("restart")
  const held = init.captureAdmission()
  init.activate()
  expect(() => held.assertMethod("model.complete")).not.toThrow()
  held.record(new Error("late actual failure"))
  expect(() => init.assertReady()).toThrow("late actual failure")
})

it("does not make ordinary post-start optional failures into initialization failures", () => {
  const init = new FunctionSessionInitializer(false)
  const ordinary = init.captureAdmission()
  ordinary.assertMethod("store.set")
  ordinary.record(new Error("optional"))
  expect(() => init.assertReady()).not.toThrow()
})
