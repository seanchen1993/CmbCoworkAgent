import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { FunctionConfigurationSourceCache } from "./configuration-source-cache"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-config-cache-")
    )
      throw Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-config-cache-"))
  roots.push(root)
  await mkdir(join(root, "hooks"))
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      name: "cache-demo",
      userConfig: {
        text: { type: "string", title: "Text", description: "Help", default: "a" }
      }
    })
  )
  await writeFile(join(root, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(join(root, "hooks/register.ts"), "export function register(){}")
  return { root, cache: new FunctionConfigurationSourceCache() }
}

it("reuses only deeply frozen actual code snapshots and rechecks bytes despite restored metadata", async () => {
  const f = await fixture()
  const first = await f.cache.read(f.root)
  expect(await f.cache.read(f.root)).toBe(first)
  expect(Object.isFrozen(first.userConfig?.text)).toBe(true)
  const path = join(f.root, "plugin.json"),
    previous = statSync(path)
  await writeFile(path, (await readFile(path, "utf8")).replace('"default":"a"', '"default":"b"'))
  await utimes(path, previous.atime, previous.mtime)
  const next = await f.cache.read(f.root)
  expect(next).not.toBe(first)
  expect(next.digest).not.toBe(first.digest)
  expect(next.userConfig?.text.default).toBe("b")
  f.cache.clear()
  expect(await f.cache.read(f.root)).not.toBe(next)
})

it("new higher-priority manifests invalidate cached identity, and unusable old cold results are never cached", async () => {
  const f = await fixture()
  const first = await f.cache.read(f.root)
  await mkdir(join(f.root, ".claude-plugin"))
  await writeFile(
    join(f.root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "other-cache-name" })
  )
  expect((await f.cache.read(f.root)).name).toBe("other-cache-name")
  await writeFile(join(f.root, ".claude-plugin/plugin.json"), " ".repeat(32769))
  const cold = await f.cache.read(f.root)
  expect(cold.name).toBe(first.name)
  expect(await f.cache.read(f.root)).not.toBe(cold)
})

it("an alias retargeted to a different package never reuses the intact old canonical root", async () => {
  const old = await fixture(),
    next = await fixture()
  await writeFile(join(next.root, "plugin.json"), '{"name":"retargeted-name"}')
  const alias = join(old.root, "alias")
  await symlink(next.root, alias, "junction")
  const cache = new FunctionConfigurationSourceCache()
  const first = await cache.read(alias)
  await unlink(alias)
  await symlink(old.root, alias, "junction")
  expect((await cache.read(alias)).name).toBe("cache-demo")
  expect(first.name).toBe("retargeted-name")
  await unlink(alias)
})

it("same bytes on a replacement file identity are recompiled", async () => {
  const f = await fixture(),
    path = join(f.root, "plugin.json")
  const first = await f.cache.read(f.root)
  await writeFile(path + ".replacement", await readFile(path))
  await rename(path + ".replacement", path)
  expect(await f.cache.read(f.root)).not.toBe(first)
})

it("bounds code retention to sixteen source paths with true least-recently-used eviction", async () => {
  const fixtures = await Promise.all(Array.from({ length: 17 }, () => fixture()))
  const cache = new FunctionConfigurationSourceCache()
  const original = await cache.read(fixtures[0].root)
  const second = await cache.read(fixtures[1].root)
  for (const f of fixtures.slice(2, 16)) await cache.read(f.root)
  expect(await cache.read(fixtures[0].root)).toBe(original)
  await cache.read(fixtures[16].root)
  expect(await cache.read(fixtures[0].root)).toBe(original)
  expect(await cache.read(fixtures[1].root)).not.toBe(second)
})
