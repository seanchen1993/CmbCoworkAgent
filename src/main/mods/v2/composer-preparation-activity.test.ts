import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession } from "./session"
import { FunctionDispatcher } from "./dispatcher"
import { createComposerPreparationActivity, retainComposerPreparationWork } from "./composer-preparation-activity"
import type { ModJson } from "../../../shared/mods/types"

it("keeps actual host work pending when its caller stops waiting", async () => {
  const activity = createComposerPreparationActivity(), entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let finished = false, drained = false
  const actual = activity.run(() => retainComposerPreparationWork(async () => {
    entered.resolve()
    try { await proceed.promise } finally { finished = true }
  }, "fs.read"))
  await entered.promise
  const drain = activity.sealAndDrain().then(() => { drained = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(drained).toBe(false)
  proceed.resolve()
  await actual
  await drain
  expect(finished).toBe(true)
  expect(drained).toBe(true)
  await activity.close()
})

it.each([undefined, null, Error("actual host failed")])("keeps a genuine failure sticky: %s", async reason => {
  const activity = createComposerPreparationActivity()
  const actual = activity.run(() => retainComposerPreparationWork(async () => { throw reason }, "state.get"))
  let rejected = false, caught: unknown
  try { await actual } catch (error) { rejected = true; caught = error }
  expect(rejected).toBe(true)
  expect(caught).toBe(reason)
  rejected = false
  try { await activity.sealAndDrain() } catch (error) { rejected = true; caught = error }
  expect(rejected).toBe(true)
  expect(caught).toBe(reason)
  rejected = false
  try { activity.assertDataCurrent() } catch (error) { rejected = true; caught = error }
  expect(rejected).toBe(true)
  expect(caught).toBe(reason)
  await activity.close()
})

it("rejects late inherited work before the real callee and cannot reopen", async () => {
  const activity = createComposerPreparationActivity(), proceed = Promise.withResolvers<void>()
  let calls = 0, late: (() => Promise<void>) | undefined
  await activity.run(async () => {
    late = () => retainComposerPreparationWork(async () => { calls++ }, "fs.read")
    const entered = late
    void proceed.promise.then(() => entered()).catch(() => undefined)
  })
  await activity.sealAndDrain()
  proceed.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(0)
  expect(() => activity.assertDataCurrent()).toThrow("MODS_COMPOSER_PREPARATION_SEALED")
  await activity.close()
})

it.each(["tool.call", "fs.write", "process.spawn", "clock.after", "model.complete", "unknown"])(
  "rejects unsupported preparation admission before %s while ordinary calls retain behavior", async method => {
    const activity = createComposerPreparationActivity()
    let calls = 0
    await expect(activity.run(async () => retainComposerPreparationWork(async () => { calls++ }, method)))
      .rejects.toThrow("MODS_COMPOSER_CAPABILITY_UNAVAILABLE")
    await activity.sealAndDrain()
    expect(calls).toBe(0)
    await activity.close()
    await retainComposerPreparationWork(async () => { calls++ }, method)
    expect(calls).toBe(1)
  }
)

it("retains recursive real core work after dispatcher deadline rejection", async () => {
  const activity = createComposerPreparationActivity(), entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>(), controller = new AbortController()
  const dispatcher = new FunctionDispatcher([])
  let finished = false, drained = false
  const actual = activity.run(() => dispatcher.dispatch("state.get", {}, {
    signal: controller.signal, dispatchCutNs: (process.hrtime.bigint() + 30_000_000_000n).toString(),
    core: async () => {
      entered.resolve()
      try { await proceed.promise; return "actual" } finally { finished = true }
    }
  }))
  const rejected = expect(actual).rejects.toThrow()
  await entered.promise
  controller.abort(Error("caller cancelled"))
  await rejected
  const drain = activity.sealAndDrain().catch(() => undefined).then(() => { drained = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(drained).toBe(false)
  proceed.resolve()
  await drain
  expect(finished).toBe(true)
  await activity.close()
})

it("covers the genuine Session capability entry and denies background before host", async () => {
  const activity = createComposerPreparationActivity()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("prompt.mention",async($,e,next)=>{try{await $.tool.call({tool:"execute",command:"echo x"})}catch(_){}
      return {...await next(e),context:["kept"]};});
  }}`)
  let hostCalls = 0, coreCalls = 0
  const session = new FunctionSession([{ name: "mention", root: "/plugin", tier: "user", guest,
    capabilities: ["tool.call"] }], { workspace: "C:/project", threadId: "mention",
    assertLive() {}, publish: async (value: ModJson) => value,
    callTool: async () => { hostCalls++; return { value: "must not run" } } })
  try {
    const result = await activity.run(() => session.promptMention({ mention: "file.txt", path: "C:/project/file.txt" },
      new AbortController().signal, async () => { coreCalls++; return { type: "file" } }))
    await activity.sealAndDrain()
    expect(result).toEqual({ type: "file", context: ["kept"] })
    expect(coreCalls).toBe(1)
    expect(hostCalls).toBe(0)
  } finally { await activity.close(); await session.close() }
})
