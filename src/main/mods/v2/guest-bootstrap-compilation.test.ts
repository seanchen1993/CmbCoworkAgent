import { expect, it, vi } from "vitest"
import { modCompiler } from "../loader"
import { FUNCTION_GUEST_BOOTSTRAP } from "./guest-bootstrap"
import { FunctionGuestRuntime } from "./guest-runtime"

it("shares concurrent bootstrap compilation and retries after a shared failure", async () => {
  const service = modCompiler()
  const original = service.transform.bind(service)
  const entered = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  const guests: FunctionGuestRuntime[] = []
  let bootstraps = 0
  const spy = vi.spyOn(service, "transform").mockImplementation(async (input, options) => {
    if (input === FUNCTION_GUEST_BOOTSTRAP && ++bootstraps === 1) {
      entered.resolve()
      await first.promise
    }
    return original(input, options)
  })
  const source = 'var __cmbFunctionMod = { register(on) { on("command.run", () => ({text:"ok"})) } }'
  try {
    const rejected = Promise.allSettled([
      FunctionGuestRuntime.create(source), FunctionGuestRuntime.create(source)
    ])
    await entered.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(bootstraps).toBe(1)
    first.reject(Error("COMPILER_START_FAILED"))
    const failures = await rejected
    expect(failures.map(result => result.status)).toEqual(["rejected", "rejected"])
    guests.push(...await Promise.all([
      FunctionGuestRuntime.create(source), FunctionGuestRuntime.create(source)
    ]))
    expect(bootstraps).toBe(2)
    for (const guest of guests) expect(guest.registrations).toHaveLength(1)
  } finally {
    spy.mockRestore()
    for (const guest of guests) guest.dispose()
  }
})
