import { afterEach, expect, it } from "vitest"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotHostLock } from "./host-lock"
import { acquireShellTestHostLease } from "./shell-test-host-lease"

// Actual current-platform file locks; no Windows/native capability or closure
// is mocked. Job and restricted-account facts remain the separate OS gate.
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-test-host-lease-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const first = acquireShellTestHostLease(directory)
  cleanup.push(first.release)
  const second = acquireShellTestHostLease(directory)
  cleanup.push(second.release)
  return { directory, first, second }
}
it("multiple Runtime fixtures hold one actual Host lock until their final lease is released", async () => {
  const f = await fixture()
  expect(f.first.lock).toBe(f.second.lock)
  expect(BotHostLock.acquire(f.directory)).toBeNull()
  f.first.release()
  expect(BotHostLock.acquire(f.directory)).toBeNull()
  await f.second.assertCurrent(new AbortController().signal)
  f.second.release()
  const next = BotHostLock.acquire(f.directory)
  expect(next).not.toBeNull()
  next!.release()
})
it("concurrent fixtures join one preparation while the actual lifetime lock remains held", async () => {
  const f = await fixture()
  let finish!: () => void,
    calls = 0
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const first = f.first.prepare(async () => {
    calls++
    await ready
  })
  const second = f.second.prepare(async () => {
    throw new Error("Preparation must not run twice")
  })
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(BotHostLock.acquire(f.directory)).toBeNull()
  finish()
  await Promise.all([first, second])
})
it("a failed preparation reaches all joined fixtures without repeating native preparation", async () => {
  const f = await fixture(),
    failure = new Error("Actual preparation failed")
  const first = f.first.prepare(async () => {
    throw failure
  })
  const second = f.second.prepare(async () => {
    throw new Error("Must not retry")
  })
  await expect(first).rejects.toBe(failure)
  await expect(second).rejects.toBe(failure)
})
it("retaining an unproven scope revokes new command admission for every sharing fixture", async () => {
  const f = await fixture()
  f.first.retain()
  await expect(f.second.assertCurrent(new AbortController().signal)).rejects.toThrow(
    "no longer current"
  )
  await expect(f.second.prepare(async () => {})).rejects.toThrow("resources retained")
  expect(BotHostLock.acquire(f.directory)).toBeNull()
})
it("released leases cannot prepare or admit commands and repeated release cannot release a sibling", async () => {
  const f = await fixture()
  f.first.release()
  f.first.release()
  await expect(f.first.assertCurrent(new AbortController().signal)).rejects.toThrow(
    "no longer current"
  )
  await expect(f.first.prepare(async () => {})).rejects.toThrow("resources retained")
  await f.second.assertCurrent(new AbortController().signal)
  expect(BotHostLock.acquire(f.directory)).toBeNull()
})
