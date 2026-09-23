import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createDisabledSwitchReader } from "./disabled-switch-cache"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-switch-"))
  roots.push(root)
  const path = join(root, "settings.json")
  const write = (enabled: unknown) => writeFileSync(path, JSON.stringify({ enabled }))
  write(false)
  const load = vi.fn(() => JSON.parse(readFileSync(path, "utf8")).enabled === true)
  const reader = createDisabledSwitchReader(path, load)
  return { path, write, load, reader }
}

it("avoids repeated settings JSON reads only while a disabled file is unchanged", () => {
  const { reader, load } = fixture()
  for (let index = 0; index < 100; index++) expect(reader.read()).toBe(false)
  expect(load).toHaveBeenCalledTimes(1)
})

it("never caches enabled authority and observes an external disable immediately", () => {
  const { reader, write, load } = fixture()
  write(true)
  expect(reader.read()).toBe(true)
  expect(reader.read()).toBe(true)
  expect(load).toHaveBeenCalledTimes(2)
  write(false)
  expect(reader.read()).toBe(false)
  expect(reader.read()).toBe(false)
  expect(load).toHaveBeenCalledTimes(3)
})

it("reloads externally replaced settings and explicit application writes", () => {
  const { reader, path, write, load } = fixture()
  expect(reader.read()).toBe(false)
  unlinkSync(path)
  write(true)
  expect(reader.read()).toBe(true)
  write(false)
  expect(reader.read()).toBe(false)
  reader.invalidate()
  expect(reader.read()).toBe(false)
  expect(load).toHaveBeenCalledTimes(4)
})

it("fails closed on corrupt or missing settings and recovers after replacement", () => {
  const { reader, path, write } = fixture()
  write(true)
  expect(reader.read()).toBe(true)
  writeFileSync(path, "invalid json")
  expect(reader.read()).toBe(false)
  unlinkSync(path)
  expect(reader.read()).toBe(false)
  write(true)
  expect(reader.read()).toBe(true)
})

it("does not publish an enabled read when the settings changed during that read", () => {
  const { path, write } = fixture()
  write(true)
  const reader = createDisabledSwitchReader(path, () => {
    write(false)
    return true
  })
  expect(reader.read()).toBe(false)
})

it("does not cache a failed read or a non-regular settings path", () => {
  const { path } = fixture()
  const failed = vi.fn(() => {
    throw new Error("read failed")
  })
  const reader = createDisabledSwitchReader(path, failed)
  expect(reader.read()).toBe(false)
  expect(reader.read()).toBe(false)
  expect(failed).toHaveBeenCalledTimes(2)
  const directoryLoad = vi.fn(() => true)
  expect(createDisabledSwitchReader(join(path, ".."), directoryLoad).read()).toBe(false)
  expect(directoryLoad).not.toHaveBeenCalled()
})
