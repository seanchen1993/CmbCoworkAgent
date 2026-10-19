import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { checkFunctionPlugin } from "./check"
import { functionCheckExitCode } from "./cli-options"
import { compileFunctionPlugin } from "../v2/loader"
import { FunctionGuestRuntime } from "../v2/guest-runtime"

const roots: string[] = []
async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "mods-sdk-check-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "sdk-check" }))
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(join(root, "hooks/register.ts"), `export function register(on) { ${body} }`)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-sdk-check-")
    )
      throw Error("Unexpected SDK fixture cleanup path")
    await rm(root, { recursive: true, force: true })
  }
})

it("strict checks reject unsupported SDK even when the event is supported", async () => {
  const root = await fixture(
    'on("command.run", $ => { throw Error("Hook must not execute"); $.audio.speak("x") })'
  )
  const report = await checkFunctionPlugin(root)
  expect(report.valid).toBe(true)
  expect(report.compatibility.strictCompatible).toBe(true)
  expect(report.sdkCompatibility.strictCompatible).toBe(false)
  expect(report.sdkCompatibility.digest).toBe(report.digest)
  expect(functionCheckExitCode(report, true)).toBe(1)
  expect(functionCheckExitCode(report, false)).toBe(0)
  expect(report.authorized).toBe(false)
})

it("accepts known SDK and checks the compiled snapshot despite a later disk change", async () => {
  const root = await fixture('on("command.run", $ => $.ui.log("ok"))')
  const report = await checkFunctionPlugin(root, async (code, options) => {
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(on) { on("command.run", $ => $.audio.speak("changed")) }'
    )
    return FunctionGuestRuntime.create(code, options)
  })
  expect(functionCheckExitCode(report, true)).toBe(0)
  expect(report.sdkCompatibility.usages.map((row) => row.method)).toEqual(["ui.log"])
  const changed = await checkFunctionPlugin(root)
  expect(changed.digest).not.toBe(report.digest)
  expect(functionCheckExitCode(changed, true)).toBe(1)
})

it("only captures normalized SDK entry metadata for explicit tooling", async () => {
  const root = await fixture('on("command.run", (_, event, next) => next(event))')
  const compiled = await compileFunctionPlugin(root)
  expect(compiled.authoringSources).toBeUndefined()
  expect(compiled.authoringEntries).toBeUndefined()
  const tooling = await compileFunctionPlugin(root, { captureSources: true })
  expect(tooling.authoringEntries).toEqual(["hooks/register.ts"])
  expect(tooling.digest).toBe(compiled.digest)
})

it("keeps known supported examples strict-compatible", async () => {
  const report = await checkFunctionPlugin(resolve("examples/mods-typed-counter"))
  expect(report.sdkCompatibility.diagnostics).toEqual([])
  expect(functionCheckExitCode(report, true)).toBe(0)
})

it.each([
  "examples/sparks-task-workbench/provider",
  "examples/sparks-task-workbench/consumer",
  "examples/sparks-task-workbench/behavior-prefix",
  "examples/sparks-task-workbench/behavior-compact",
  "examples/sparks-edit-reminder"
])(
  "recognizes actual capability registrations in %s without authorizing execution",
  async (path) => {
    const report = await checkFunctionPlugin(resolve(path))
    expect(report.valid).toBe(true)
    expect(report.authorized).toBe(false)
    expect(report.compatibility).toMatchObject({ strictCompatible: true, diagnostics: [] })
    expect(report.registrations.some((entry) => entry.pattern === "platform.action")).toBe(true)
    expect(report.sdkCompatibility.runtimeVerified).toBe(false)
    expect(
      report.sdkCompatibility.diagnostics.some((entry) => entry.code === "MODS_SDK_UNSUPPORTED")
    ).toBe(false)
  }
)
