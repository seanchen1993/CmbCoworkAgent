import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { afterEach, expect, it, vi } from "vitest"
const nativeProbe = vi.hoisted(() => ({ calls: 0 }))
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    execFile: (...args: unknown[]) => {
      nativeProbe.calls++
      return Reflect.apply(original.execFile, undefined, args)
    }
  }
})
import { RetainedPackageSnapshots } from "./package-snapshots"
import {
  acquireSnapshotLease,
  acquireSnapshotPathLeases,
  collectSnapshotGarbage,
  inspectSnapshotGarbage,
  prepareSnapshotMaintenance,
  withSnapshotRetention,
  type SnapshotReferenceAudit
} from "./snapshot-retention"
import {
  issueRuntimePluginSourceToken,
  assertCurrentRuntimePluginSourceContent,
  withRuntimePluginSource,
  retainRuntimePluginSourceToken
} from "../../plugins/runtime-source-scope"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "snapshot-gc-"))
  roots.push(base)
  const root = join(base, "packages"),
    installed = join(base, "installed")
  mkdirSync(installed)
  const snapshots = new RetainedPackageSnapshots(root)
  const capture = (text: string) => {
    writeFileSync(join(installed, "source.txt"), text)
    return snapshots.capture(installed)
  }
  const collect = (digests: string[] = []) =>
    collectSnapshotGarbage(root, () => ({
      complete: true,
      digests: new Set(digests),
      blockers: []
    }))
  return { base, root, installed, snapshots, capture, collect }
}

it("reclaims published unreferenced packages and really admits version 65 while retaining history", () => {
  const f = fixture()
  const versions = Array.from({ length: 64 }, (_, index) => f.capture(String(index)))
  expect(() => f.capture("65")).toThrow("SNAPSHOT_CAPACITY")
  const result = f.collect([versions[0].digest, versions[20].digest])
  expect(result).toMatchObject({ publishedBefore: 64, publishedAfter: 2, blockers: [] })
  expect(result.removed).toHaveLength(62)
  expect(f.snapshots.read(versions[0].digest)).toEqual(versions[0])
  expect(f.capture("65").digest).not.toBe(versions[0].digest)
}, 15000)

it("covers the async capture to persist gap and releases only after physical settlement", async () => {
  const f = fixture(),
    gate = Promise.withResolvers<void>()
  let captured = ""
  const pending = withSnapshotRetention([f.root], async () => {
    captured = (await f.snapshots.captureAsync(f.installed)).digest
    await gate.promise
  })
  await Promise.resolve()
  const blocked = f.collect()
  expect(blocked.blockers).toContain("SNAPSHOT_READER_ACTIVE_OR_UNCONFIRMED")
  gate.resolve()
  await pending
  expect(f.collect().removed).toEqual([captured])
})

it("keeps only the digest referenced by a live owner while collecting other packages", () => {
  const f = fixture(),
    one = f.capture("one"),
    two = f.capture("two")
  const lease = acquireSnapshotPathLeases([one.root], "test-external-engine")
  expect(f.collect().removed).toEqual([two.digest])
  expect(f.collect().protected).toEqual([one.digest])
  lease.release()
  expect(f.collect().removed).toEqual([one.digest])
})

it("treats orphan/unknown reader files as protection without age or PID expiry", () => {
  const f = fixture(),
    one = f.capture("one")
  const readers = join(f.root, ".snapshot-retention", "readers")
  writeFileSync(join(readers, "unknown.json"), '{"pid":99999999}')
  expect(f.collect().blockers).toContain("SNAPSHOT_READER_UNKNOWN")
  expect(f.snapshots.read(one.digest)).toEqual(one)
})

it("holds the maintenance gate while auditing and refuses a new reader before it can start IO", () => {
  const f = fixture(),
    one = f.capture("one")
  const result = collectSnapshotGarbage(f.root, () => {
    expect(() => acquireSnapshotLease(f.root)).toThrow("SNAPSHOT_MAINTENANCE_BUSY")
    return { complete: true, digests: new Set([one.digest]), blockers: [] }
  })
  expect(result.protected).toEqual([one.digest])
  expect(readdirSync(join(f.root, ".snapshot-retention", "readers"))).toEqual([])
})

it("protects upgrade-era packages without leases until the native boot migration boundary", async () => {
  await prepareSnapshotMaintenance()
  const f = fixture(),
    digest = "a".repeat(64)
  mkdirSync(join(f.root, digest, "package"), { recursive: true })
  const lease = acquireSnapshotLease(f.root)
  lease.release()
  const modern = f.capture("new-protocol")
  expect(f.collect()).toMatchObject({ removed: [modern.digest], protected: [digest] })
  const marker = join(f.root, ".snapshot-retention", "protocol-v1.json")
  const protocol = JSON.parse(readFileSync(marker, "utf8"))
  // A native OS boot change is the proof; no lease/PID/mtime disappearance is used.
  writeFileSync(marker, JSON.stringify({ ...protocol, boot: "previous-os-boot" }))
  expect(f.collect().removed).toEqual([digest])
})

it("recovers proved prior-boot maintenance and reader fences without expiring current readers", async () => {
  await prepareSnapshotMaintenance()
  const f = fixture(),
    one = f.capture("one")
  const directory = join(f.root, ".snapshot-retention"),
    readers = join(directory, "readers")
  const current = acquireSnapshotLease(f.root, [one.digest])
  const activePath = join(readers, readdirSync(readers)[0])
  const live = JSON.parse(readFileSync(activePath, "utf8"))
  expect(live.boot).not.toBe("")
  const orphanPath = join(readers, `${randomUUID()}.json`)
  writeFileSync(
    orphanPath,
    JSON.stringify({ ...live, owner: randomUUID(), boot: "prior-native-boot", digests: null })
  )
  const lock = join(directory, "maintenance.lock")
  writeFileSync(
    lock,
    JSON.stringify({ version: 1, pid: 1, owner: randomUUID(), boot: "prior-native-boot" })
  )
  expect(f.collect().blockers).toContain("SNAPSHOT_MAINTENANCE_BUSY")
  await prepareSnapshotMaintenance([f.root])
  expect(existsSync(lock)).toBe(false)
  expect(existsSync(orphanPath)).toBe(false)
  expect(existsSync(activePath)).toBe(true)
  expect(f.collect().protected).toEqual([one.digest])
  current.release()
  expect(f.collect().removed).toEqual([one.digest])
})

it.each(["current", "unknown"] as const)(
  "preserves %s-boot maintenance locks and readers",
  async (kind) => {
    await prepareSnapshotMaintenance()
    const f = fixture(),
      one = f.capture("one")
    const directory = join(f.root, ".snapshot-retention"),
      readers = join(directory, "readers")
    const temporary = acquireSnapshotLease(f.root, [one.digest])
    const live = JSON.parse(readFileSync(join(readers, readdirSync(readers)[0]), "utf8"))
    temporary.release()
    const record = {
      version: 1,
      pid: 1,
      owner: randomUUID(),
      boot: kind === "current" ? live.boot : ""
    }
    const reader = join(readers, `${randomUUID()}.json`),
      lock = join(directory, "maintenance.lock")
    writeFileSync(reader, JSON.stringify({ ...record, digests: null }))
    writeFileSync(lock, JSON.stringify(record))
    await prepareSnapshotMaintenance([f.root])
    expect(existsSync(lock)).toBe(true)
    expect(existsSync(reader)).toBe(true)
    expect(f.collect().removed).toEqual([])
  }
)

it("keeps unconfirmed stdio bytes on this boot but recovers a prior-boot external fence", async () => {
  await prepareSnapshotMaintenance()
  const f = fixture(),
    one = f.capture("one")
  const lease = acquireSnapshotPathLeases([one.root], "unconfirmed-stdio")
  lease.keepUntilNextBoot?.()
  lease.release()
  await prepareSnapshotMaintenance([f.root])
  expect(f.collect().protected).toEqual([one.digest])
  const readers = join(f.root, ".snapshot-retention", "readers")
  const currentPath = join(readers, readdirSync(readers)[0])
  const current = JSON.parse(readFileSync(currentPath, "utf8"))
  expect(current.boot).not.toBe("")
  // Simulate the persisted prior-process record, without pretending this process's live owner died.
  const oldPath = join(readers, `${randomUUID()}.json`)
  writeFileSync(
    oldPath,
    JSON.stringify({ ...current, owner: randomUUID(), boot: "prior-native-boot" })
  )
  await prepareSnapshotMaintenance([f.root])
  expect(existsSync(oldPath)).toBe(false)
  expect(existsSync(currentPath)).toBe(true)
})

it("refuses to sweep if durable roots or the protocol marker cannot be fully verified", () => {
  const f = fixture(),
    one = f.capture("one")
  const audit: SnapshotReferenceAudit = {
    complete: false,
    digests: new Set(),
    blockers: ["bad schema"]
  }
  expect(collectSnapshotGarbage(f.root, () => audit).removed).toEqual([])
  writeFileSync(join(f.root, ".snapshot-retention", "protocol-v1.json"), "bad-json")
  expect(f.collect().blockers).toContain("SNAPSHOT_READER_MIGRATION_UNCONFIRMED")
  expect(f.snapshots.read(one.digest)).toEqual(one)
})

it("pins an issued source, an in-flight run and a deferred native owner independently", async () => {
  const f = fixture(),
    one = f.capture("one"),
    gate = Promise.withResolvers<void>()
  const token = issueRuntimePluginSourceToken({
    threadId: "thread",
    incarnationKey: "inc",
    projectId: "project",
    operationId: "op",
    workspace: f.base,
    packageDigest: one.digest,
    stageId: "stage",
    plugin: {
      id: "p",
      name: "p",
      version: "1",
      path: one.root,
      enabled: true,
      description: "",
      author: "",
      skillCount: 0,
      mcpServerCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  })
  expect(f.collect().protected).toEqual([one.digest])
  const deferred = retainRuntimePluginSourceToken(token, "deferred-session-end")
  const running = withRuntimePluginSource(token, async () => {
    await gate.promise
  })
  expect(f.collect().protected).toEqual([one.digest])
  gate.resolve()
  await running
  expect(f.collect().protected).toEqual([one.digest])
  deferred.release()
  expect(f.collect().removed).toEqual([one.digest])
})

it("rechecks previewed candidates and never deletes a newly published unpreviewed version", () => {
  const f = fixture(),
    one = f.capture("one"),
    two = f.capture("two")
  const audit = () => ({ complete: true, digests: new Set<string>(), blockers: [] })
  const preview = inspectSnapshotGarbage(f.root, audit)
  expect(new Set(preview.candidates)).toEqual(new Set([one.digest, two.digest]))
  const three = f.capture("not-previewed")
  const lease = acquireSnapshotPathLeases([one.root], "new-reader-after-preview")
  const removed = collectSnapshotGarbage(f.root, audit, preview.candidates)
  expect(removed.removed).toEqual([two.digest])
  expect(f.snapshots.read(three.digest)).toEqual(three)
  lease.release()
})

it("retains nested async readers after the outer scope returns and reacquires in detached continuations", async () => {
  const f = fixture(),
    one = f.capture("one"),
    gate = Promise.withResolvers<void>()
  let nested: Promise<void> | undefined
  withSnapshotRetention([f.root], () => {
    nested = withSnapshotRetention([f.root], async () => {
      await gate.promise
    })
  })
  expect(f.collect().blockers).toContain("SNAPSHOT_READER_ACTIVE_OR_UNCONFIRMED")
  gate.resolve()
  await nested
  const begin = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  let detached: Promise<void> | undefined
  withSnapshotRetention([f.root], () => {
    detached = begin.promise.then(() =>
      withSnapshotRetention([f.root], async () => {
        expect(f.collect().blockers).toContain("SNAPSHOT_READER_ACTIVE_OR_UNCONFIRMED")
        await finish.promise
      })
    )
  })
  begin.resolve()
  await Promise.resolve()
  expect(f.collect().blockers).toContain("SNAPSHOT_READER_ACTIVE_OR_UNCONFIRMED")
  finish.resolve()
  await detached
  expect(f.collect().removed).toEqual([one.digest])
})

it("honors a real independent process lease until that reader physically closes it", async () => {
  const f = fixture(),
    one = f.capture("external-reader")
  const script = join(f.base, "reader.mts")
  writeFileSync(
    script,
    `import {acquireSnapshotLease} from ${JSON.stringify(pathToFileURL(resolve("src/main/harness-board/project-runtime/snapshot-retention.ts")).href)};
    const lease=acquireSnapshotLease(process.argv[2],[process.argv[3]],"external-test-reader");
    process.on("message",()=>{lease.release();process.send("closed");process.exit(0)});
    process.send("ready");`
  )
  const child = spawn(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), script, f.root, one.digest],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  )
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve())
      child.once("error", reject)
      child.once("exit", (code) => reject(Error(`reader exited ${code}`)))
    })
    expect(f.collect().protected).toEqual([one.digest])
    const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.send("release")
    await closed
    expect(f.collect().removed).toEqual([one.digest])
  } finally {
    if (child.exitCode === null) child.kill()
  }
}, 10000)

it("immediate assertions do not create reader files or start a native boot probe", () => {
  const calls = nativeProbe.calls
  const f = fixture(),
    one = f.capture("source")
  const token = issueRuntimePluginSourceToken({
    threadId: "thread",
    incarnationKey: "inc",
    projectId: "project",
    operationId: "op",
    workspace: f.base,
    packageDigest: one.digest,
    stageId: "stage",
    plugin: { id: "p", path: one.root } as import("../../types").PluginMetadata
  })
  withRuntimePluginSource(token, () => {
    const directory = join(f.root, ".snapshot-retention", "readers")
    const before = readdirSync(directory)
    for (let index = 0; index < 1000; index++) assertCurrentRuntimePluginSourceContent()
    expect(readdirSync(directory)).toEqual(before)
    const first = retainRuntimePluginSourceToken(token, "one-owner")
    const second = retainRuntimePluginSourceToken(token, "another-owner")
    expect(readdirSync(directory)).toEqual(before)
    first.release()
    second.release()
  })
  expect(nativeProbe.calls).toBe(calls)
})

it("preserves synchronous values, throws, prefixes and Promise identity without a retained source", () => {
  const original = Promise.resolve("ordinary chat")
  let entered = false
  const result = withRuntimePluginSource(undefined, () => {
    entered = true
    return original
  })
  expect(entered).toBe(true)
  expect(result).toBe(original)
  expect(withRuntimePluginSource(undefined, () => 42)).toBe(42)
  const failure = Error("synchronous failure")
  expect(() =>
    withRuntimePluginSource(undefined, () => {
      throw failure
    })
  ).toThrow(failure)
})
