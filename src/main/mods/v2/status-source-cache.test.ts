import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionConfigurationSourceCache } from "./configuration-source-cache"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-status-cache-"))
  roots.push(root)
  await mkdir(join(root, "mods"))
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "cached-mod" }))
  await writeFile(join(root, "mods/manifest.json"), JSON.stringify({
    apiVersion: "cmb.mods/v2", id: "cached-mod", entry: "main.ts"
  }))
  const file = join(root, "mods/main.ts")
  await writeFile(file, 'export function register(on) { on("command.run",()=>({text:"one"})) }')
  const compile = vi.fn(compileFunctionPlugin)
  return { root, file, compile, cache: new FunctionConfigurationSourceCache(64, compile) }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("reuses unchanged compilation across sequential directory reads", async () => {
  const f = await fixture()
  const first = await f.cache.read(f.root)
  expect(await f.cache.read(f.root)).toBe(first)
  expect(f.compile).toHaveBeenCalledTimes(1)
})

it("recompiles changed bytes and detects a newly added higher-priority manifest", async () => {
  const f = await fixture()
  const first = await f.cache.read(f.root)
  await writeFile(f.file, 'export function register(on) { on("command.run",()=>({text:"two"})) }')
  const second = await f.cache.read(f.root)
  expect(second.digest).not.toBe(first.digest)
  await mkdir(join(f.root, ".claude-plugin"))
  await writeFile(join(f.root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "changed" }))
  expect(await f.cache.read(f.root)).not.toBe(second)
  expect(f.compile).toHaveBeenCalledTimes(3)
})

it("deduplicates concurrent compilation and clear forces a fresh read", async () => {
  const f = await fixture()
  const [a, b] = await Promise.all([f.cache.read(f.root), f.cache.read(f.root)])
  expect(a).toBe(b)
  expect(f.compile).toHaveBeenCalledTimes(1)
  f.cache.clear()
  await f.cache.read(f.root)
  expect(f.compile).toHaveBeenCalledTimes(2)
})
