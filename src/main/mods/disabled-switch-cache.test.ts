import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createDisabledSwitchReader } from "./disabled-switch-cache"

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-switch-/)
    rmSync(root, { recursive: true, force: true })
  })
)

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

it("reuses unchanged enabled parsing but observes an external disable on the next read", () => {
  const { reader, write, load } = fixture()
  write(true)
  expect(reader.read()).toBe(true)
  for (let index = 0; index < 1000; index++) expect(reader.read()).toBe(true)
  expect(load).toHaveBeenCalledTimes(1)
  write(false)
  expect(reader.read()).toBe(false)
  expect(reader.read()).toBe(false)
  expect(load).toHaveBeenCalledTimes(2)
})

it("detects a same-length external rewrite even when modification time is restored", () => {
  const { reader, path, load } = fixture()
  writeFileSync(path, '{"enabled":true }')
  expect(reader.read()).toBe(true)
  const original = statSync(path)
  const originalChangeTime = statSync(path, { bigint: true }).ctimeNs
  // Real filesystem metadata, not a mocked invalidation or an application setter.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  writeFileSync(path, '{"enabled":false}')
  utimesSync(path, original.atime, original.mtime)
  expect(statSync(path).size).toBe(original.size)
  expect(statSync(path, { bigint: true }).ctimeNs).not.toBe(originalChangeTime)
  expect(reader.read()).toBe(false)
  expect(load).toHaveBeenCalledTimes(2)
})

it("checks a replacement identity and explicit invalidation even after an enabled read", () => {
  const { reader, path, write, load } = fixture()
  write(true)
  expect(reader.read()).toBe(true)
  reader.invalidate()
  expect(reader.read()).toBe(true)
  expect(load).toHaveBeenCalledTimes(2)
  const replacement = join(path, "..", "replacement.json")
  writeFileSync(replacement, '{"enabled":false}')
  renameSync(replacement, path)
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
