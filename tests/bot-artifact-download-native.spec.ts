import { randomUUID, createHash } from "node:crypto"
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  link,
  unlink,
  symlink,
  mkdir,
  rename
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import {
  DesktopArtifactDownloads,
  type DesktopArtifactDownloadDependencies
} from "../src/main/bots/desktop-artifact-downloads"
import type { BotArtifactDownloadSource } from "../src/shared/bot-artifact-downloads"
import type { BotArtifact } from "../src/shared/bot-types"
import { BOT_FILE_CHUNK_BYTES } from "../src/shared/bot-files"

const roots: string[] = []
process.once("beforeExit", () => {
  void Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(bytes = Buffer.from("verified result")) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-save-native-")))
  roots.push(root)
  const source: BotArtifactDownloadSource = {
    artifactId: "artifact",
    conversationId: "conversation",
    dataEpoch: "epoch-1",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }
  const artifact: BotArtifact = {
    id: source.artifactId,
    conversationId: source.conversationId,
    runId: null,
    name: "result.txt",
    mime: "text/plain",
    size: source.size,
    sha256: source.sha256,
    createdAt: Date.now()
  }
  let choices = 0
  const deps: DesktopArtifactDownloadDependencies = {
    source: {
      release: async () => undefined,
      describe: async () => ({ dataEpoch: source.dataEpoch, artifact }),
      read: async (_source, offset) => ({
        dataEpoch: source.dataEpoch,
        chunk: {
          artifact,
          offset,
          base64: bytes.subarray(offset, offset + BOT_FILE_CHUNK_BYTES).toString("base64")
        }
      })
    },
    choose: async () => {
      choices++
      return join(root, "result.txt")
    },
    reveal: async () => undefined,
    assertOwnership: () => undefined,
    withPublication: async (_source, _signal, operation) => operation()
  }
  const open = () => new DesktopArtifactDownloads(join(root, "ledger", "downloads.sqlite"), deps)
  return { root, source, artifact, deps, open, choices: () => choices, bytes }
}
async function settled(manager: DesktopArtifactDownloads, id: string) {
  for (let i = 0; i < 200; i++) {
    const row = (await manager.page({})).items.find((row) => row.id === id)
    if (row && ["completed", "failed", "paused", "cancelled"].includes(row.state)) return row
    await delay(10)
  }
  throw new Error("did not settle")
}
test("native download rejects Node's permissive noncanonical base64 before writing or publishing", async () => {
  const f = await fixture(Buffer.from("f"))
  const manager = f.open()
  try {
    for (const raw of ["Zh==", "Zg", "Zg==\n", "Zg__"]) {
      f.deps.source.read = async (_source, offset) => ({
        dataEpoch: f.source.dataEpoch,
        chunk: { artifact: f.artifact, offset, base64: raw }
      })
      const job = await manager.start({ nonce: randomUUID(), source: f.source })
      const failed = await settled(manager, job.id)
      assert.equal(failed.state, "failed")
      assert.equal(failed.bytes, 0)
      assert.equal(failed.diagnostic?.code, "download_source_changed")
      await assert.rejects(readFile(join(f.root, "result.txt")), { code: "ENOENT" })
      await manager.cancel({ id: failed.id, revision: failed.revision })
    }
  } finally {
    await manager.close()
  }
})
test("native stream verifies full bytes and publishes one absent target", async () => {
  const f = await fixture(Buffer.alloc(BOT_FILE_CHUNK_BYTES * 2 + 7, 17)),
    manager = f.open(),
    nonce = randomUUID()
  try {
    const job = await manager.start({ nonce, source: f.source })
    assert.equal(job.id, nonce)
    const done = await settled(manager, nonce)
    assert.equal(done.state, "completed")
    assert.equal(done.bytes, f.bytes.length)
    assert.deepEqual(await readFile(join(f.root, "result.txt")), f.bytes)
    assert.equal((await manager.start({ nonce, source: f.source })).state, "completed")
    assert.equal(f.choices(), 1)
  } finally {
    await manager.close()
  }
})
test("OS-selected directory aliases save to the pinned physical parent", async () => {
  const f = await fixture(),
    physical = join(f.root, "physical"),
    alias = join(f.root, "chosen")
  await mkdir(physical)
  await symlink(physical, alias, "junction")
  f.deps.choose = async () => join(alias, "result.txt")
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source })
    assert.equal((await settled(manager, job.id)).state, "completed")
    assert.deepEqual(await readFile(join(physical, "result.txt")), f.bytes)
  } finally {
    await manager.close()
  }
})
test("retargeting a chooser alias cannot redirect an admitted save", async () => {
  const f = await fixture(),
    original = join(f.root, "original"),
    replacement = join(f.root, "replacement"),
    alias = join(f.root, "chosen")
  await mkdir(original)
  await mkdir(replacement)
  await symlink(original, alias, "junction")
  f.deps.choose = async () => join(alias, "result.txt")
  const read = f.deps.source.read
  let changed = false
  f.deps.source.read = async (...args) => {
    if (!changed) {
      changed = true
      await unlink(alias)
      await symlink(replacement, alias, "junction")
    }
    return read(...args)
  }
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source })
    assert.equal((await settled(manager, job.id)).state, "completed")
    assert.deepEqual(await readFile(join(original, "result.txt")), f.bytes)
    await assert.rejects(readFile(join(replacement, "result.txt")), { code: "ENOENT" })
  } finally {
    await manager.close()
  }
})
test("replacing the pinned physical parent before publication rejects the save", async () => {
  const f = await fixture(),
    physical = join(f.root, "physical"),
    held = join(f.root, "original-held")
  await mkdir(physical)
  f.deps.choose = async () => join(physical, "result.txt")
  f.deps.withPublication = async (_source, _signal, operation) => {
    await rename(physical, held)
    await mkdir(physical)
    return operation()
  }
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source }),
      done = await settled(manager, job.id)
    assert.equal(done.state, "failed")
    assert.equal(done.diagnostic?.code, "download_destination_changed")
    await assert.rejects(readFile(join(physical, "result.txt")), { code: "ENOENT" })
    await assert.rejects(readFile(join(held, "result.txt")), { code: "ENOENT" })
  } finally {
    await manager.close()
  }
})
test("same nonce while native chooser is pending returns accepted receipt, never a second dialog", async () => {
  const f = await fixture()
  let release!: (path: string | undefined) => void
  f.deps.choose = async () =>
    new Promise((resolve) => {
      release = resolve
    })
  const manager = f.open(),
    nonce = randomUUID()
  try {
    const pending = manager.start({ nonce, source: f.source })
    while (!release) await delay(1)
    assert.equal((await manager.start({ nonce, source: f.source })).state, "choosing")
    await assert.rejects(
      manager.start({ nonce, source: { ...f.source, sha256: "f".repeat(64) } }),
      (error) =>
        error instanceof Error && "code" in error && error.code === "download_nonce_conflict"
    )
    release(undefined)
    assert.equal((await pending).state, "cancelled")
  } finally {
    await manager.close()
  }
})
test("cancelled chooser survives restart and forget retains nonce tombstone", async () => {
  const f = await fixture()
  f.deps.choose = async () => undefined
  let manager = f.open()
  const nonce = randomUUID()
  const first = await manager.start({ nonce, source: f.source })
  assert.equal(first.state, "cancelled")
  await manager.close()
  manager = f.open()
  try {
    assert.equal((await manager.start({ nonce, source: f.source })).state, "cancelled")
    const exact = (await manager.page({})).items[0]!
    await manager.forget({ id: nonce, revision: exact.revision })
    await assert.rejects(
      manager.start({ nonce, source: f.source }),
      (error) => error instanceof Error && "code" in error && error.code === "download_archived"
    )
  } finally {
    await manager.close()
  }
})
test("existing target is never overwritten", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "result.txt"), "user bytes")
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source })
    assert.equal(job.state, "failed")
    assert.equal(job.diagnostic?.code, "download_destination_exists")
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "user bytes")
  } finally {
    await manager.close()
  }
})
test("target appearing immediately before publish is never overwritten", async () => {
  const f = await fixture()
  f.deps.withPublication = async (_source, _signal, operation) => {
    await writeFile(join(f.root, "result.txt"), "new owner")
    return operation()
  }
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source })
    const done = await settled(manager, job.id)
    assert.equal(done.state, "failed")
    assert.equal(done.diagnostic?.code, "download_destination_exists")
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "new owner")
  } finally {
    await manager.close()
  }
})
test("epoch revoked before final publication rejects old source without publishing", async () => {
  const f = await fixture()
  f.deps.withPublication = async (_source, _signal, operation) => {
    f.deps.source.describe = async () => ({
      dataEpoch: "epoch-2",
      artifact: f.artifact
    })
    return operation()
  }
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source })
    const done = await settled(manager, job.id)
    assert.equal(done.state, "failed")
    assert.equal(done.diagnostic?.code, "download_source_changed")
    await assert.rejects(readFile(join(f.root, "result.txt")), {
      code: "ENOENT"
    })
  } finally {
    await manager.close()
  }
})
test("maintenance waits accepted publication and pause survives reopen without automatic resume", async () => {
  const f = await fixture(Buffer.alloc(BOT_FILE_CHUNK_BYTES * 3, 5))
  let readStarted = false
  f.deps.source.read = async (_source, offset, signal) => {
    if (offset >= BOT_FILE_CHUNK_BYTES) {
      readStarted = true
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        })
      )
    }
    return {
      dataEpoch: f.source.dataEpoch,
      chunk: {
        artifact: f.artifact,
        offset,
        base64: f.bytes.subarray(offset, offset + BOT_FILE_CHUNK_BYTES).toString("base64")
      }
    }
  }
  let manager = f.open()
  const job = await manager.start({ nonce: randomUUID(), source: f.source })
  while (!readStarted) await delay(1)
  await manager.drainForMaintenance()
  assert.equal((await manager.page({})).items[0]?.bytes, BOT_FILE_CHUNK_BYTES)
  await manager.close()
  f.deps.source.read = async (_source, offset) => ({
    dataEpoch: f.source.dataEpoch,
    chunk: {
      artifact: f.artifact,
      offset,
      base64: f.bytes.subarray(offset, offset + BOT_FILE_CHUNK_BYTES).toString("base64")
    }
  })
  manager = f.open()
  try {
    const saved = (await manager.page({})).items[0]!
    assert.equal(saved.state, "paused")
    await manager.resume({ id: job.id, revision: saved.revision })
    assert.equal((await settled(manager, job.id)).state, "completed")
    assert.deepEqual(await readFile(join(f.root, "result.txt")), f.bytes)
  } finally {
    await manager.close()
  }
})
import { spawn } from "node:child_process"
import { once } from "node:events"
for (const point of ["before-offset", "after-offset", "after-publish"] as const) {
  test(`actual Main stream SIGKILL ${point} resumes exact durable offset/publish receipt`, async () => {
    const f = await fixture(Buffer.alloc(BOT_FILE_CHUNK_BYTES * 2 + 9, 43)),
      nonce = randomUUID()
    await writeFile(join(f.root, "fixture-source"), f.bytes)
    const child = spawn(
      process.execPath,
      [
        ...(process.env.CMB_BOT_DOWNLOAD_CRASH_FIXTURE ? [] : ["--import", "tsx"]),
        process.env.CMB_BOT_DOWNLOAD_CRASH_FIXTURE ??
          resolve("tests/fixtures/bot-artifact-download-crash.ts"),
        f.root,
        nonce,
        point
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        cwd: process.cwd(),
        windowsHide: true
      }
    )
    const [code, signal] = await once(child, "exit")
    assert.equal(code, null)
    assert.equal(signal, "SIGKILL")
    const offsets: number[] = []
    const read = f.deps.source.read
    f.deps.source.read = async (...args) => {
      offsets.push(args[1])
      return read(...args)
    }
    const manager = f.open()
    try {
      const saved = (await manager.page({})).items[0]!
      if (point === "after-publish") {
        assert.equal(saved.state, "completed")
        assert.deepEqual(offsets, [])
      } else {
        assert.equal(saved.state, "paused")
        assert.equal(saved.bytes, point === "after-offset" ? BOT_FILE_CHUNK_BYTES : 0)
        await manager.resume({ id: saved.id, revision: saved.revision })
        assert.equal((await settled(manager, nonce)).state, "completed")
        assert.equal(offsets[0], point === "after-offset" ? BOT_FILE_CHUNK_BYTES : 0)
      }
      assert.deepEqual(await readFile(join(f.root, "result.txt")), f.bytes)
    } finally {
      await manager.close()
    }
  })
}
test("durable publish recovery refuses target user edits after lost ACK", async () => {
  const f = await fixture(Buffer.alloc(BOT_FILE_CHUNK_BYTES + 3, 59)),
    nonce = randomUUID()
  await writeFile(join(f.root, "fixture-source"), f.bytes)
  const child = spawn(
    process.execPath,
    [
      ...(process.env.CMB_BOT_DOWNLOAD_CRASH_FIXTURE ? [] : ["--import", "tsx"]),
      process.env.CMB_BOT_DOWNLOAD_CRASH_FIXTURE ??
        resolve("tests/fixtures/bot-artifact-download-crash.ts"),
      f.root,
      nonce,
      "after-publish"
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: process.cwd(),
      windowsHide: true
    }
  )
  await once(child, "exit")
  await writeFile(join(f.root, "result.txt"), "user edited this already")
  const manager = f.open()
  try {
    const saved = (await manager.page({})).items[0]!
    assert.equal(saved.state, "failed")
    assert.equal(saved.diagnostic?.code, "download_publish_unknown")
    await manager.cancel({ id: saved.id, revision: saved.revision })
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "user edited this already")
  } finally {
    await manager.close()
  }
})
import { BotDomainError } from "../src/shared/bot-types"
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
test("close drains pending source describe and exact release; repeated close joins same promise", async () => {
  const f = await fixture(),
    waiting = deferred<{ dataEpoch: string; artifact: BotArtifact }>(),
    releaseDrain = deferred<void>()
  let signal: AbortSignal | undefined,
    released = 0
  f.deps.source.describe = async (_source, s) => {
    signal = s
    return waiting.promise
  }
  f.deps.source.release = async (s) => {
    assert.equal(s, signal)
    released++
    waiting.reject(s.reason)
    await releaseDrain.promise
  }
  const manager = f.open(),
    nonce = randomUUID(),
    started = manager.start({ nonce, source: f.source })
  while (!signal) await delay(1)
  const first = manager.close(),
    second = manager.close()
  assert.equal(first, second)
  let closed = false
  void first.then(() => {
    closed = true
  })
  await delay(10)
  assert.equal(closed, false)
  assert.equal(released, 1)
  releaseDrain.resolve()
  assert.equal((await started).state, "cancelled")
  await first
  assert.equal(released, 1)
  await assert.rejects(
    manager.page({}),
    (error) => error instanceof BotDomainError && error.code === "download_request_rejected"
  )
  f.deps.source.describe = async () => ({
    dataEpoch: f.source.dataEpoch,
    artifact: f.artifact
  })
  f.deps.source.release = async () => undefined
  const reopened = f.open()
  try {
    assert.equal((await reopened.page({})).items[0]?.state, "cancelled")
  } finally {
    await reopened.close()
  }
})
test("close cancels logical OS chooser without waiting for native late result or accessing closed ledger", async () => {
  const f = await fixture(),
    choice = deferred<string | undefined>()
  let opened = false,
    released = 0
  f.deps.choose = async () => {
    opened = true
    return choice.promise
  }
  f.deps.source.release = async () => {
    released++
  }
  const manager = f.open(),
    nonce = randomUUID(),
    started = manager.start({ nonce, source: f.source })
  while (!opened) await delay(1)
  await manager.close()
  assert.equal((await started).state, "cancelled")
  assert.equal(released, 1)
  choice.resolve(join(f.root, "late.txt"))
  await delay(10)
  await assert.rejects(readFile(join(f.root, "late.txt")), { code: "ENOENT" })
  const reopened = f.open()
  try {
    assert.equal((await reopened.page({})).items[0]?.state, "cancelled")
  } finally {
    await reopened.close()
  }
})
async function pausedFixture() {
  const f = await fixture(Buffer.alloc(BOT_FILE_CHUNK_BYTES * 2, 7))
  let reading = false
  f.deps.source.read = async (_source, _offset, signal) => {
    reading = true
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      })
    )
    throw new Error("unreachable")
  }
  const manager = f.open(),
    job = await manager.start({ nonce: randomUUID(), source: f.source })
  while (!reading) await delay(1)
  const current = (await manager.page({})).items[0]!
  await manager.pause({ id: job.id, revision: current.revision })
  return { ...f, manager, paused: (await manager.page({})).items[0]! }
}
test("resume persists definitive deleted source failure and releases its preflight connection", async () => {
  const f = await pausedFixture()
  let released = 0
  f.deps.source.describe = async () => {
    throw new BotDomainError("download_source_changed", "source deleted")
  }
  f.deps.source.release = async () => {
    released++
  }
  try {
    const failed = await f.manager.resume({
      id: f.paused.id,
      revision: f.paused.revision
    })
    assert.equal(failed.state, "failed")
    assert.equal(failed.diagnostic?.code, "download_source_changed")
    assert.equal(released, 1)
  } finally {
    await f.manager.close()
  }
})
test("close drains pending resume preflight without advancing paused source or leaking handle", async () => {
  const f = await pausedFixture(),
    waiting = deferred<{ dataEpoch: string; artifact: BotArtifact }>()
  let signal: AbortSignal | undefined,
    released = 0
  f.deps.source.describe = async (_source, s) => {
    signal = s
    return waiting.promise
  }
  f.deps.source.release = async (s) => {
    released++
    waiting.reject(s.reason)
  }
  const resumed = f.manager.resume({
    id: f.paused.id,
    revision: f.paused.revision
  })
  while (!signal) await delay(1)
  await f.manager.close()
  assert.equal((await resumed).state, "paused")
  assert.equal(released, 1)
  assert.equal(signal.aborted, true)
  f.deps.source.describe = async () => ({
    dataEpoch: f.source.dataEpoch,
    artifact: f.artifact
  })
  f.deps.source.release = async () => undefined
  const manager = f.open()
  try {
    assert.equal((await manager.page({})).items[0]?.state, "paused")
  } finally {
    await manager.close()
  }
})
test("invalid platform filename is rejected before native chooser", async () => {
  const f = await fixture()
  f.artifact.name = "../outside.txt"
  const manager = f.open()
  try {
    const job = await manager.start({ nonce: randomUUID(), source: f.source })
    assert.equal(job.state, "failed")
    assert.equal(job.diagnostic?.code, "download_source_changed")
    assert.equal(f.choices(), 0)
  } finally {
    await manager.close()
  }
})

test("lost publication recovery never accepts a target symlink even if its content points to the owned inode", async () => {
  const f = await fixture(Buffer.alloc(BOT_FILE_CHUNK_BYTES + 3, 61)),
    nonce = randomUUID()
  await writeFile(join(f.root, "fixture-source"), f.bytes)
  const child = spawn(
    process.execPath,
    [
      ...(process.env.CMB_BOT_DOWNLOAD_CRASH_FIXTURE ? [] : ["--import", "tsx"]),
      process.env.CMB_BOT_DOWNLOAD_CRASH_FIXTURE ??
        resolve("tests/fixtures/bot-artifact-download-crash.ts"),
      f.root,
      nonce,
      "after-publish"
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: process.cwd(),
      windowsHide: true
    }
  )
  await once(child, "exit")
  const target = join(f.root, "result.txt"),
    stage = join(f.root, `.CMBDevClaw-save-${nonce}.part`),
    other = join(f.root, "other-link.txt")
  await unlink(target)
  await link(stage, other)
  await symlink(other, target)
  const manager = f.open()
  try {
    const saved = (await manager.page({})).items[0]!
    assert.equal(saved.state, "failed")
    assert.equal(saved.diagnostic?.code, "download_publish_unknown")
    assert.deepEqual(await readFile(target), f.bytes)
  } finally {
    await manager.close()
  }
})
