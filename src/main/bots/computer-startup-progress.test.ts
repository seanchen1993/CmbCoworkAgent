import { afterEach, expect, it } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotHostLock } from "./host-lock"
import { readVerifiedComputerStartupProgress } from "./computer-startup-progress"

const roots: string[] = []
const locks: BotHostLock[] = []
afterEach(() => {
  locks.splice(0).forEach((lock) => lock.release())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-startup-progress-"))
  roots.push(root)
  const lock = BotHostLock.acquire(root)!
  locks.push(lock)
  const descriptor = {
    version: 1,
    pid: process.pid,
    hostId: "starting",
    socketPath: "unused",
    token: randomUUID()
  }
  lock.publish(descriptor)
  const now = Date.now()
  const progress = {
    format: 1,
    owner: {
      pid: process.pid,
      hostTokenSha256: createHash("sha256").update(descriptor.token).digest("hex"),
      ...lock.recoveryOwnershipIdentity()
    },
    nonce: randomUUID(),
    operation: "startup-restore",
    phase: "prepare",
    component: "data",
    activity: "native-sqlite",
    startedAt: now,
    updatedAt: now,
    sequence: 1,
    entries: 0,
    bytes: 0
  }
  mkdirSync(join(root, "computer-recovery"), { mode: 0o700 })
  const path = join(root, "computer-recovery", "progress.private.json")
  const write = () => writeFileSync(path, JSON.stringify(progress), { mode: 0o600 })
  write()
  return { root, lock, descriptor, progress, path, write }
}

it("accepts only progress bound to a current starting descriptor and held OS lock", async () => {
  const f = fixture()
  expect(await readVerifiedComputerStartupProgress(f.root, f.descriptor)).toEqual(f.progress)
  f.lock.release()
  expect(await readVerifiedComputerStartupProgress(f.root, f.descriptor)).toBeUndefined()
})

it.each(["token", "identity", "stale", "ready", "superseded", "oversized"])(
  "does not extend startup for %s progress authority",
  async (kind) => {
    const f = fixture()
    if (kind === "token") f.progress.owner.hostTokenSha256 = "b".repeat(64)
    if (kind === "identity") f.progress.owner.lock.ino = "0"
    if (kind === "stale") {
      f.progress.startedAt -= 20_000
      f.progress.updatedAt -= 20_000
    }
    if (kind === "ready") f.descriptor.hostId = "ready"
    if (kind === "superseded")
      writeFileSync(
        join(f.root, "host.json"),
        JSON.stringify({ ...f.descriptor, token: randomUUID() })
      )
    f.write()
    if (kind === "oversized") writeFileSync(f.path, " ".repeat(5000) + JSON.stringify(f.progress))
    expect(await readVerifiedComputerStartupProgress(f.root, f.descriptor)).toBeUndefined()
  }
)

it.skipIf(process.platform === "win32")(
  "rejects a linked progress directory without reading foreign records",
  async () => {
    const f = fixture()
    const foreign = mkdtempSync(join(tmpdir(), "cmb-foreign-progress-"))
    roots.push(foreign)
    writeFileSync(join(foreign, "progress.private.json"), JSON.stringify(f.progress))
    rmSync(join(f.root, "computer-recovery"), { recursive: true })
    symlinkSync(foreign, join(f.root, "computer-recovery"))
    expect(await readVerifiedComputerStartupProgress(f.root, f.descriptor)).toBeUndefined()
  }
)
