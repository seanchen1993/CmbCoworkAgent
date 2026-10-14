import { expect, it } from "vitest"
import { discoverFunctionEnvironment, readFunctionEnvironment } from "./environment-sdk"

const context = (declared: string[]) => ({
  declared,
  signal: new AbortController().signal,
  assertLive() {
    /* Live host fixture. */
  },
  publish: async (value: import("../../../shared/mods/types").ModJson) => value
})

it("discovers only literal env names, including computed property spelling, ignoring comments", () => {
  expect(
    discoverFunctionEnvironment(`
    // $.env.get("SECRET")
    const text='$.env.get("ALSO_SECRET")';
    $.env.get("HOME"); sdk["env"]["get"]("PATH"); $.env.set("GIT_PAGER","cat");
    const get=$.env.get;get("INVISIBLE_ALIAS");
  `)
  ).toEqual({ read: ["HOME", "PATH"], write: ["GIT_PAGER"] })
  expect(() => discoverFunctionEnvironment("$.env.get(name)")).toThrow("MODS_ENV_NAME_LITERAL")
  expect(() => discoverFunctionEnvironment("$.env.get(`HOME`)")).toThrow("MODS_ENV_NAME_LITERAL")
  expect(discoverFunctionEnvironment('sdk["\\x65nv"]["get"]("HOME")')).toEqual({
    read: ["HOME"],
    write: []
  })
})

it("requires both source declaration and host read allowlist", async () => {
  await expect(readFunctionEnvironment("PATH", context([]))).rejects.toThrow("MODS_ENV_UNDECLARED")
  await expect(
    readFunctionEnvironment("ANTHROPIC_API_KEY", context(["ANTHROPIC_API_KEY"]))
  ).rejects.toThrow("MODS_ENV_READ_DENIED")
  const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH")!
  expect(await readFunctionEnvironment(pathKey, context([pathKey]))).toBe(process.env[pathKey])
})

it("publishes before exposing a value and rechecks cancellation/authority afterward", async () => {
  const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH")!
  const c = context([pathKey])
  c.publish = async () => "[protected]"
  expect(await readFunctionEnvironment(pathKey, c)).toBe("[protected]")
  c.publish = async () => {
    c.assertLive = () => {
      throw new Error("revoked")
    }
    return "not-published"
  }
  await expect(readFunctionEnvironment(pathKey, c)).rejects.toThrow("revoked")
  const aborted = new AbortController()
  aborted.abort(new Error("aborted"))
  await expect(
    readFunctionEnvironment(pathKey, { ...context([pathKey]), signal: aborted.signal })
  ).rejects.toThrow("aborted")
})

it("reports unset permitted values as undefined without changing the environment", async () => {
  const old = process.env.LC_CTYPE
  try {
    delete process.env.LC_CTYPE
    expect(await readFunctionEnvironment("LC_CTYPE", context(["LC_CTYPE"]))).toBeUndefined()
  } finally {
    if (old === undefined) delete process.env.LC_CTYPE
    else process.env.LC_CTYPE = old
  }
})

it.skipIf(process.platform !== "win32")(
  "matches Windows environment names case-insensitively",
  async () => {
    expect(await readFunctionEnvironment("path", context(["Path"]))).toBe(process.env.PATH)
  }
)
