import { expect, it, vi } from "vitest"

const { getQuickJS, transform } = vi.hoisted(() => ({ getQuickJS: vi.fn(), transform: vi.fn() }))

vi.mock("quickjs-emscripten", () => ({ getQuickJS }))
vi.mock("../loader", () => ({ modCompiler: () => ({ transform }) }))

import { FunctionGuestRuntime } from "./guest-runtime"

it("overlaps pure preparation and drains it before failing an uninitialized guest", async () => {
  const engine = Promise.withResolvers<never>()
  const bootstrap = Promise.withResolvers<{ code: string }>()
  const extension = Promise.withResolvers<never>()
  getQuickJS.mockReturnValueOnce(engine.promise)
  transform.mockReturnValueOnce(bootstrap.promise).mockReturnValueOnce(extension.promise)

  const engineError = new Error("engine unavailable")
  const failure = vi.fn()
  const load = FunctionGuestRuntime.create("/* guest source */")
  const observed = load.catch(failure)
  await Promise.resolve()

  expect(getQuickJS).toHaveBeenCalledTimes(1)
  expect(transform).toHaveBeenCalledTimes(2)
  expect(transform).toHaveBeenLastCalledWith("/* guest source */", { target: "es2016" })

  engine.reject(engineError)
  extension.reject(new Error("invalid guest source"))
  await Promise.resolve()
  await Promise.resolve()
  expect(failure).not.toHaveBeenCalled()

  bootstrap.resolve({ code: "" })
  await observed
  expect(failure).toHaveBeenCalledWith(engineError)
})
