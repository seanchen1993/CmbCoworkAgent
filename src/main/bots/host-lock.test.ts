import { afterEach, expect, it } from "vitest"
import { once } from "node:events"
import { spawn } from "node:child_process"
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotHostLock } from "./host-lock"
import { DatabaseSync } from "node:sqlite"

const directories: string[] = []
const locks: BotHostLock[] = []
const descriptor = {
  version: 1,
  pid: process.pid,
  hostId: "starting",
  socketPath: "test",
  token: "a".repeat(64)
}
function directory() {
  const path = mkdtempSync(join(tmpdir(), "bot-host-lock-"))
  directories.push(path)
  return path
}
function acquire(path: string) {
  const lock = BotHostLock.acquire(path)
  if (lock) locks.push(lock)
  return lock
}
afterEach(() => {
  locks.splice(0).forEach((lock) => lock.release())
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

it("excludes competing hosts and replaces torn descriptors only after acquiring ownership", () => {
  const path = directory()
  writeFileSync(join(path, "host.json"), '{"pid":')
  const first = acquire(path)!
  first.publish(descriptor)
  expect(acquire(path)).toBeNull()
  first.publish({ ...descriptor, hostId: "ready" })
  expect(JSON.parse(readFileSync(join(path, "host.json"), "utf8")).hostId).toBe("ready")
  if (process.platform !== "win32")
    expect(statSync(join(path, "host.json")).mode & 0o777).toBe(0o600)
  expect(() => first.publish({ ...descriptor, token: "b".repeat(64) })).toThrow("owner")
  first.release()
  expect(acquire(path)).not.toBeNull()
  expect(() => first.publish(descriptor)).toThrow("released")
})

it("does not delete a descriptor with a different owner during cleanup", () => {
  const path = directory(),
    lock = acquire(path)!
  lock.publish(descriptor)
  writeFileSync(join(path, "host.json"), JSON.stringify({ ...descriptor, token: "b".repeat(64) }))
  lock.release()
  expect(JSON.parse(readFileSync(join(path, "host.json"), "utf8")).token).toBe("b".repeat(64))
})

it.each(["hard", "symbolic"])("rejects a %s linked lock without touching its target", (kind) => {
  if (kind === "symbolic" && process.platform === "win32") return
  const path = directory(),
    target = join(path, "target.sqlite"),
    db = new DatabaseSync(target)
  db.exec("CREATE TABLE evidence(value); INSERT INTO evidence VALUES('unmodified')")
  db.close()
  const before = readFileSync(target)
  if (kind === "hard") linkSync(target, join(path, "host-lock.sqlite"))
  else symlinkSync(target, join(path, "host-lock.sqlite"))
  expect(() => acquire(path)).toThrow("锁")
  expect(readFileSync(target)).toEqual(before)
})

it("rejects a linked SQLite lock sidecar before SQLite can open it", () => {
  const path = directory(),
    target = join(path, "foreign-journal")
  const first = acquire(path)!
  first.release()
  writeFileSync(target, "foreign bytes")
  linkSync(target, join(path, "host-lock.sqlite-journal"))
  expect(() => acquire(path)).toThrow("锁")
  expect(readFileSync(target, "utf8")).toBe("foreign bytes")
})

it("withdraws ownership if a second link is added after acquisition", () => {
  const path = directory(),
    first = acquire(path)!
  first.publish(descriptor)
  linkSync(join(path, "host-lock.sqlite"), join(path, "linked-lock"))
  expect(() => first.assertCurrent()).toThrow("锁")
  expect(() => first.publish({ ...descriptor, hostId: "unsafe" })).toThrow("锁")
  expect(JSON.parse(readFileSync(join(path, "host.json"), "utf8")).hostId).toBe("starting")
})

it.skipIf(process.platform === "win32")(
  "fences a replaced inode and never publishes or removes the replacement owner's descriptor",
  () => {
    const path = directory(),
      first = acquire(path)!
    first.publish(descriptor)
    renameSync(join(path, "host-lock.sqlite"), join(path, "displaced-lock.sqlite"))
    const replacement = acquire(path)!
    expect(replacement).not.toBeNull()
    replacement.publish({ ...descriptor, token: "b".repeat(64), hostId: "replacement" })
    expect(() => first.assertCurrent()).toThrow("锁")
    expect(() => first.publish({ ...descriptor, hostId: "unsafe" })).toThrow("锁")
    first.release()
    expect(JSON.parse(readFileSync(join(path, "host.json"), "utf8")).hostId).toBe("replacement")
  }
)

it("recovers the OS lock after a process is killed without cleanup", async () => {
  const path = directory()
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setInterval(() => {}, 1000);
  `,
      join(path, "host-lock.sqlite")
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  )
  const exited = once(child, "exit")
  try {
    await once(child, "message", { signal: AbortSignal.timeout(5000) })
    expect(acquire(path)).toBeNull()
    child.kill("SIGKILL")
    await exited
    const recovered = acquire(path)!
    expect(recovered).not.toBeNull()
    recovered.publish(descriptor)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
  }
}, 10_000)
