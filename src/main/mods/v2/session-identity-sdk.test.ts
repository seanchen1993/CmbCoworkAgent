import { expect, it, vi } from "vitest"
import { basicSdkInput, runBasicSdk, validateBasicResult } from "./basic-sdk"

const context = () => ({
  threadId: "thread",
  workspace: "/actual/project",
  plugin: "test",
  registry: new Map(),
  signal: new AbortController().signal
})

it("reads the host workspace and real version without claiming the reference engine", async () => {
  expect(await runBasicSdk("session.root", {}, context())).toBe("/actual/project")
  expect(
    await runBasicSdk(
      "session.version",
      {},
      {
        ...context(),
        version: { version: "1.5.2", base: "1.5.2" }
      }
    )
  ).toEqual({ version: "1.5.2", base: "1.5.2" })
  await expect(runBasicSdk("session.version", {}, context())).rejects.toThrow(
    "MODS_SESSION_UNAVAILABLE"
  )
  expect(() =>
    validateBasicResult("session.version", { version: "1.5.2", builtAt: "fake" })
  ).toThrow("MODS_SDK_RESULT")
})

it("routes ancestors only through the authorized file backend", async () => {
  const ancestors = vi.fn(async () => [])
  const input = basicSdkInput("fs.ancestors", [{ names: ["AGENTS.md"], of: "src/a.ts" }])
  const ctx = { ...context(), files: { run: vi.fn(), ancestors } }
  expect(await runBasicSdk("fs.ancestors", input, ctx)).toEqual([])
  expect(ancestors).toHaveBeenCalledWith({ names: ["AGENTS.md"], of: "src/a.ts" }, ctx.signal)
  await expect(runBasicSdk("fs.ancestors", input, context())).rejects.toThrow(
    "MODS_CAPABILITY_UNAVAILABLE"
  )
  expect(() =>
    validateBasicResult("fs.ancestors", [{ dir: "/x", name: "a.md", content: "forged", parts: [] }])
  ).toThrow("MODS_SDK_RESULT")
})
