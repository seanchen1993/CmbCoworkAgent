import { expect, it } from "vitest"
import { FunctionClassicEndStage } from "./classic-end-stage"
import { FunctionDispatchDeadline } from "./dispatch-deadline"

it("wakes an existing waiter when quit subsequently attaches a cut without settling actual work", async () => {
  const gate = Promise.withResolvers<void>()
  let finished = false
  const stage = new FunctionClassicEndStage(async () => {
    try {
      await gate.promise
    } finally {
      finished = true
    }
  })
  const waiting = stage.wait()
  await Promise.resolve()
  const drain = new FunctionDispatchDeadline(30)
  stage.attach(drain)
  await expect(waiting).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
  expect(finished).toBe(false)
  expect(() => stage.assertLive()).toThrow("总等待期限")
  gate.resolve()
  await stage.actual
  expect(finished).toBe(true)
  drain.close()
})

it("rejects a stage attached after expiry before executing its original callback", async () => {
  const drain = new FunctionDispatchDeadline(1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  let calls = 0
  const stage = new FunctionClassicEndStage(async () => {
    calls++
  })
  stage.attach(drain)
  await expect(stage.actual).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
  expect(calls).toBe(0)
  drain.close()
})

it("keeps a completed or closed stage terminal instead of reviving its proof", async () => {
  const stage = new FunctionClassicEndStage(async () => "done")
  expect(await stage.wait()).toBe("done")
  expect(() => stage.assertLive()).toThrow()
  const drain = new FunctionDispatchDeadline(5000)
  const blocked = new FunctionClassicEndStage(async () => {})
  blocked.attach(drain)
  drain.close()
  await expect(blocked.actual).rejects.toMatchObject({ code: "MODS_INVOCATION_ENDED" })
})

it("rejects a synchronous success crossing the cut before its timer can run", async () => {
  const drain = new FunctionDispatchDeadline(10)
  const stage = new FunctionClassicEndStage(async () => {
    const until = performance.now() + 25
    while (performance.now() < until) {
      /* Keep the timer queued past its native cut. */
    }
    return "late"
  })
  stage.attach(drain)
  await expect(stage.wait()).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
  expect(await stage.actual).toBe("late")
  drain.close()
})
