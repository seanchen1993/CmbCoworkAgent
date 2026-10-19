import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { afterEach, expect, it, vi } from "vitest"
const probe = vi.hoisted(() => ({ fsyncs: 0 }))
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return {
    ...actual,
    fsyncSync(fd: number) {
      probe.fsyncs++
      return actual.fsyncSync(fd)
    }
  }
})
import { RetainedPackageSnapshots } from "./package-snapshots"
import {
  acquireSnapshotPathLeases,
  collectSnapshotGarbage,
  withSnapshotPathRetention,
  withSnapshotRetention
} from "./snapshot-retention"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource,
  assertCurrentRuntimePluginSourceContent
} from "../../plugins/runtime-source-scope"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "known-digest-retention-"))
  roots.push(base)
  const source = join(base, "source"),
    root = join(base, "packages")
  mkdirSync(source)
  const snapshots = new RetainedPackageSnapshots(root)
  const capture = (text: string) => {
    writeFileSync(join(source, "source.txt"), text)
    return snapshots.capture(source)
  }
  const one = capture("original"),
    two = capture("unrelated")
  const collect = () =>
    collectSnapshotGarbage(root, () => ({
      complete: true,
      digests: new Set<string>(),
      blockers: []
    }))
  const readers = () => readdirSync(join(root, ".snapshot-retention/readers"))
  return { base, source, root, snapshots, one, two, collect, readers }
}

it("reuses only the original token's exact physical lease while every full source and knowledge check still runs", async () => {
  const f = fixture(),
    metadata = await f.snapshots.captureGuardAsync(f.one.digest)
  const knowledge = join(f.base, "knowledge.txt")
  writeFileSync(knowledge, "required-original")
  let checks = 0,
    live = true
  const token = issueRuntimePluginSourceToken(
    {
      mode: "legacy",
      threadId: "thread",
      incarnationKey: "incarnation",
      projectId: "project",
      operationId: "operation",
      workspace: f.base,
      packageDigest: f.one.digest,
      stageId: "stage",
      plugin: {
        id: "plugin",
        name: "plugin",
        version: "1.0.0",
        path: f.one.root,
        enabled: true,
        description: "",
        author: "",
        skillCount: 0,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    },
    () => {
      checks++
      f.snapshots.read(f.one.digest)
      metadata()
      if (readFileSync(knowledge, "utf8") !== "required-original") throw Error("KNOWLEDGE_CHANGED")
    },
    () => {
      if (!live) throw Error("ORIGINAL_OWNER_REVOKED")
    }
  )
  await withRuntimePluginSource(token, async () => {
    const before = checks
    probe.fsyncs = 0
    for (let index = 0; index < 3; index++)
      withSnapshotRetention([f.root], assertCurrentRuntimePluginSourceContent)
    const baselineFsyncs = probe.fsyncs
    expect(baselineFsyncs).toBe(3)
    probe.fsyncs = 0
    for (let index = 0; index < 3; index++) assertCurrentRuntimePluginSourceContent()
    const currentFsyncs = probe.fsyncs
    expect(currentFsyncs).toBe(0)
    expect(checks - before).toBe(6)
    console.info(
      "Known digest retention evidence",
      JSON.stringify({ baselineFsyncs, currentFsyncs, fullChecks: checks - before, boundaries: 3 })
    )
    expect(f.collect().removed).toEqual([f.two.digest])
    writeFileSync(knowledge, "changed")
    expect(assertCurrentRuntimePluginSourceContent).toThrow("KNOWLEDGE_CHANGED")
    writeFileSync(knowledge, "required-original")
    writeFileSync(join(f.one.root, "source.txt"), "tampered")
    expect(assertCurrentRuntimePluginSourceContent).toThrow("PACKAGE_CHANGED")
    live = false
    expect(assertCurrentRuntimePluginSourceContent).toThrow("ORIGINAL_OWNER_REVOKED")
  })
  expect(f.readers()).toEqual([])
})

it("keeps both concurrent async owners until actual settlement without releasing the other owner's lease", async () => {
  const f = fixture(),
    a = Promise.withResolvers<void>(),
    b = Promise.withResolvers<void>()
  const enteredA = Promise.withResolvers<void>(),
    enteredB = Promise.withResolvers<void>()
  probe.fsyncs = 0
  const first = withSnapshotPathRetention([f.one.root], async () => {
    expect((await f.snapshots.readAsync(f.one.digest)).digest).toBe(f.one.digest)
    enteredA.resolve()
    await a.promise
  })
  const second = withSnapshotPathRetention([f.one.root], async () => {
    expect((await f.snapshots.readAsync(f.one.digest)).digest).toBe(f.one.digest)
    enteredB.resolve()
    await b.promise
  })
  await Promise.all([enteredA.promise, enteredB.promise])
  expect(probe.fsyncs).toBe(1)
  expect(f.readers()).toHaveLength(1)
  expect(f.collect().removed).toEqual([f.two.digest])
  a.resolve()
  await first
  expect(f.collect().protected).toEqual([f.one.digest])
  expect(f.readers()).toHaveLength(1)
  b.resolve()
  await second
  expect(f.readers()).toEqual([])
  expect(f.collect().removed).toEqual([f.one.digest])
})

it("releases a nested exception without releasing its independently held owner", () => {
  const f = fixture(),
    owner = acquireSnapshotPathLeases([f.one.root], "independent-owner")
  probe.fsyncs = 0
  expect(() =>
    withSnapshotPathRetention([f.one.root], () => {
      f.snapshots.read(f.one.digest)
      f.snapshots.captureGuard(f.one.digest)()
      throw Error("ORIGINAL_OPERATION_FAILED")
    })
  ).toThrow("ORIGINAL_OPERATION_FAILED")
  expect(probe.fsyncs).toBe(0)
  expect(f.collect().removed).toEqual([f.two.digest])
  owner.release()
  expect(f.readers()).toEqual([])
  expect(f.collect().removed).toEqual([f.one.digest])
})

it("still performs actual async byte validation and releases the failed physical operation", async () => {
  const f = fixture()
  const pending = withSnapshotPathRetention([f.one.root], () => f.snapshots.readAsync(f.one.digest))
  writeFileSync(join(f.one.root, "source.txt"), "tampered")
  await expect(pending).rejects.toThrow("PACKAGE_CHANGED")
  expect(f.readers()).toEqual([])
})

it("keeps the original abort guard and releases async leases after cancellation", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort(Error("ORIGINAL_CANCELLED"))
  await expect(f.snapshots.readAsync(f.one.digest, controller.signal)).rejects.toThrow(
    "ORIGINAL_CANCELLED"
  )
  expect(f.readers()).toEqual([])
})

it("validates digests before leasing and does not let a fresh guard reuse prior validation", () => {
  const f = fixture(),
    guard = f.snapshots.captureGuard(f.one.digest)
  for (const invalid of ["../escape", "A".repeat(64), "bad"])
    expect(() => f.snapshots.read(invalid)).toThrow()
  expect(f.readers()).toEqual([])
  guard()
  writeFileSync(join(f.one.root, "new-resource.txt"), "changed")
  expect(guard).toThrow("PACKAGE_CHANGED")
  expect(f.readers()).toEqual([])
})
