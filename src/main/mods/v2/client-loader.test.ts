import { afterEach, expect, it, vi } from "vitest"
const compiler = vi.hoisted(() => ({ transform: vi.fn(), transformSync: vi.fn() }))
vi.mock("../loader", () => ({ modCompiler: () => compiler, resolveModFile: vi.fn() }))
import { parseFunctionModule } from "./client-loader"

afterEach(() => { vi.resetAllMocks() })

it("yields while compiling instead of invoking the blocking compiler entry", async () => {
  const transformed = Promise.withResolvers<{ code: string }>()
  compiler.transform.mockReturnValue(transformed.promise)
  compiler.transformSync.mockImplementation(() => { throw Error("BLOCKING_COMPILATION") })
  const pending = parseFunctionModule("source", "ts", "/root/source.ts", "/root")
  let completed = false
  void pending.then(() => { completed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(completed).toBe(false)
  expect(compiler.transformSync).not.toHaveBeenCalled()
  transformed.resolve({ code: "export const value = 1" })
  expect((await pending).code).toBe("export const value = 1")
})

it.each(['import("./dynamic.js")', 'require("./module.js")'])(
  "retains forbidden import validation after asynchronous compilation: %s", async code => {
    compiler.transform.mockResolvedValue({ code })
    await expect(parseFunctionModule(code, "js", "/root/source.js", "/root"))
      .rejects.toThrow("MODS_IMPORT_DENIED")
  }
)
