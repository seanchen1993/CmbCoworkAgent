import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { checkFunctionPlugin } from "../devtools/check"

const roots: string[] = []
async function plugin(source: string, modules = ["./register.ts"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mods-v2-loader-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "loader-probe" })
  )
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules }))
  await writeFile(join(root, "hooks/register.ts"), source)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("function plugin snapshot loader", () => {
  it("loads the real Claude package layout and reports registration without granting permissions", async () => {
    const report = await checkFunctionPlugin(resolve("tests/fixtures/mods-v2/conformance"))
    expect(report).toMatchObject({ valid: true, authorized: false, profile: "claude-code/2.1.273" })
    expect(report.registrations.some((r) => r.hasCatch)).toBe(true)
  })
  it("includes package metadata and source in the immutable digest", async () => {
    const root = await plugin('export function register(on){on("command.run",()=>({text:"a"}))}')
    const first = await compileFunctionPlugin(root)
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(on){on("command.run",()=>({text:"b"}))}'
    )
    const second = await compileFunctionPlugin(root)
    expect(second.digest).not.toBe(first.digest)
    expect(first.code).toContain('"a"')
  })
  it("refuses escaping module paths and arbitrary runtime imports", async () => {
    const escape = await plugin("export function register(){}", ["../../outside.ts"])
    await expect(compileFunctionPlugin(escape)).rejects.toThrow("MODS_PATH_INVALID")
    const bare = await plugin(
      'import fs from "node:fs";export function register(){fs.readFileSync("x")}'
    )
    await expect(compileFunctionPlugin(bare)).rejects.toThrow("MODS_IMPORT_DENIED")
  })
  it("does not silently accept asynchronous registration through the module wrapper", async () => {
    const root = await plugin("export async function register(){}")
    await expect(checkFunctionPlugin(root)).rejects.toThrow()
  })
  it("reports unknown events and never claims that checking grants access", async () => {
    const root = await plugin('export function register(on){on("turn.typo",()=>({}))}')
    expect(await checkFunctionPlugin(root)).toMatchObject({
      valid: false,
      authorized: false,
      diagnostics: [{ code: "MODS_EVENT_PROVIDER_REQUIRED", pattern: "turn.typo" }]
    })
  })
})
