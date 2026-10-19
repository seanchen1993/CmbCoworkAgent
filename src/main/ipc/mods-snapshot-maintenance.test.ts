import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { projectSnapshotRoots } from "../harness-board/project-runtime/snapshot-reference-audit"
import { registerSnapshotMaintenanceHandlers } from "./mods-snapshot-maintenance"
import {
  collectSnapshotGarbage,
  inspectSnapshotGarbage,
  type SnapshotReferenceAudit
} from "../harness-board/project-runtime/snapshot-retention"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { auditNativeSnapshotReferences } from "../harness-board/project-runtime/snapshot-native-references"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture(prepare?: () => Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "snapshot-maintenance-ipc-"))
  directories.push(base)
  for (const root of projectSnapshotRoots(base)) mkdirSync(root, { recursive: true })
  const sender = { isDestroyed: () => false },
    frame = {}
  const state = { time: 100, base, trusted: true, frame }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const audit = vi.fn<() => SnapshotReferenceAudit>(() => ({
    complete: true,
    digests: new Set(),
    blockers: []
  }))
  const previewAudit = vi.fn((_roots: readonly string[]) => {
    void _roots
    return audit()
  })
  const inspect = vi.fn((_root: string, _references?: SnapshotReferenceAudit) => {
    void _root
    void _references
    return {
      published: 3,
      protected: ["a".repeat(64)],
      candidates: ["b".repeat(64), "c".repeat(64)],
      blockers: [] as string[]
    }
  })
  const collect = vi.fn((_root: string, expected: readonly string[]) => {
    audit()
    return {
      removed: expected.slice(0, 1),
      publishedAfter: 2,
      blockers: ["SNAPSHOT_READER_ACTIVE_OR_UNCONFIRMED"]
    }
  })
  registerSnapshotMaintenanceHandlers(
    { handle: (name, handler) => handlers.set(name, handler) } as unknown as IpcMain,
    {
      base: () => state.base,
      now: () => state.time,
      prepare,
      previewAudit,
      inspect,
      collect,
      trusted: (event) => {
        if (!state.trusted || event.sender !== sender) throw Error("UNTRUSTED")
      }
    }
  )
  const call = (action: string, input?: unknown, override = {}) =>
    handlers.get(`mods:snapshot-maintenance-${action}`)!(
      { sender, senderFrame: state.frame, ...override } as IpcMainInvokeEvent,
      input
    )
  return { base, state, sender, call, inspect, collect, audit, previewAudit }
}

it("inspection has no collection effects and confirmation uses only native-preview candidates", async () => {
  const f = fixture()
  const preview = (await f.call("preview")) as { previewId: string; groups: unknown[] }
  expect(preview.groups).toHaveLength(4)
  expect(f.collect).not.toHaveBeenCalled()
  expect(f.call("collect", preview.previewId)).toMatchObject({ removed: 4, remaining: 8 })
  expect(
    f.collect.mock.calls.every(
      ([, candidates]) => candidates.join() === ["b".repeat(64), "c".repeat(64)].join()
    )
  ).toBe(true)
  expect(() => f.call("collect", preview.previewId)).toThrow("PREVIEW_EXPIRED")
})

it("blocks untrusted/path input, stale frames, changed roots and expired preview capabilities", async () => {
  for (const kind of ["sender", "frame", "base", "root", "expiry"] as const) {
    const f = fixture()
    const preview = (await f.call("preview")) as { previewId: string }
    if (kind === "frame") f.state.frame = {}
    if (kind === "base") f.state.base += "-changed"
    if (kind === "expiry") f.state.time += 300_001
    if (kind === "root") {
      const path = projectSnapshotRoots(f.base)[0]
      renameSync(path, path + "-old")
      mkdirSync(path)
    }
    expect(() =>
      f.call("collect", preview.previewId, kind === "sender" ? { sender: {} } : {})
    ).toThrow()
    expect(f.collect).not.toHaveBeenCalled()
  }
  const f = fixture()
  await expect(f.call("preview", { root: "C:/untrusted" })).rejects.toThrow("ARGUMENTS")
  expect(() => f.call("collect", { digests: ["b".repeat(64)] })).toThrow("ARGUMENTS")
})

it("never authorizes blocked groups and bounds outstanding previews", async () => {
  const f = fixture()
  f.inspect.mockReturnValue({
    published: 3,
    protected: [],
    candidates: ["b".repeat(64)],
    blockers: ["unknown"]
  })
  const first = (await f.call("preview")) as {
    previewId: string
    groups: Array<{ candidates: number }>
  }
  expect(first.groups.every((group) => group.candidates === 0)).toBe(true)
  for (let i = 0; i < 16; i++) await f.call("preview")
  expect(() => f.call("collect", first.previewId)).toThrow("PREVIEW_EXPIRED")
  const next = (await f.call("preview")) as { previewId: string }
  f.call("collect", next.previewId)
  expect(f.collect.mock.calls.every(([, candidates]) => candidates.length === 0)).toBe(true)
})

it("shares one advisory audit for four preview roots but never passes it to collection", async () => {
  const f = fixture()
  const preview = (await f.call("preview")) as { previewId: string }
  expect(f.previewAudit).toHaveBeenCalledExactlyOnceWith(projectSnapshotRoots(f.base))
  expect(f.audit).toHaveBeenCalledOnce()
  const references = f.previewAudit.mock.results[0].value
  expect(f.inspect.mock.calls).toHaveLength(4)
  expect(f.inspect.mock.calls.every(([, captured]) => captured === references)).toBe(true)
  f.call("collect", preview.previewId)
  expect(f.audit).toHaveBeenCalledTimes(5)
  expect(f.collect.mock.calls.every((args) => args.length === 2)).toBe(true)
})

it("re-audits under every collection lock and preserves references persisted between roots", async () => {
  const f = fixture(),
    roots = projectSnapshotRoots(f.base)
  const installed = join(f.base, "installed")
  mkdirSync(installed)
  const snapshots = roots.map((root, index) => {
    writeFileSync(join(installed, "source.txt"), `version-${index}`)
    return new RetainedPackageSnapshots(root).capture(installed)
  })
  const native = new DatabaseSync(":memory:")
  try {
    native.exec("CREATE TABLE threads(metadata TEXT,thread_values TEXT)")
    const adapter = new NativeSqliteAdapter(native)
    f.audit.mockImplementation(() => auditNativeSnapshotReferences(adapter))
    f.inspect.mockImplementation((root, references) => {
      const result = inspectSnapshotGarbage(root, () => references ?? f.audit())
      return { ...result, published: result.publishedBefore }
    })
    f.collect.mockImplementation((root, expected) => {
      const result = collectSnapshotGarbage(
        root,
        () => {
          expect(existsSync(join(root, ".snapshot-retention", "maintenance.lock"))).toBe(true)
          return f.audit()
        },
        expected
      )
      if (root === roots[0])
        native
          .prepare("INSERT INTO threads VALUES(?,?)")
          .run(JSON.stringify({ packageDigest: snapshots[1].digest }), null)
      return result
    })
    const preview = (await f.call("preview")) as { previewId: string }
    expect(f.audit).toHaveBeenCalledOnce()
    expect(f.call("collect", preview.previewId)).toMatchObject({ removed: 3, remaining: 1 })
    expect(f.audit).toHaveBeenCalledTimes(5)
    expect(existsSync(snapshots[1].root)).toBe(true)
    expect(existsSync(snapshots[0].root)).toBe(false)
  } finally {
    native.close()
  }
})

it("keeps all groups advisory-blocked when the shared audit fails", async () => {
  const f = fixture()
  f.previewAudit.mockImplementation(() => {
    throw Error("REFERENCE_READ_FAILED")
  })
  f.inspect.mockImplementation((_root, references) => ({
    published: 1,
    protected: ["b".repeat(64)],
    candidates: [],
    blockers: [...references!.blockers]
  }))
  const preview = (await f.call("preview")) as {
    previewId: string
    groups: Array<{ candidates: number; blockers: string[] }>
  }
  expect(preview.groups.every((group) => !group.candidates && group.blockers.length)).toBe(true)
  f.call("collect", preview.previewId)
  expect(f.collect.mock.calls.every(([, candidates]) => candidates.length === 0)).toBe(true)
})

it("does not audit or create a preview after its async preparation loses trusted scope", async () => {
  const gate = Promise.withResolvers<void>()
  const f = fixture(() => gate.promise)
  const pending = f.call("preview")
  const rejected = expect(pending).rejects.toThrow("UNTRUSTED")
  f.state.trusted = false
  gate.resolve()
  await rejected
  expect(f.previewAudit).not.toHaveBeenCalled()
  expect(f.inspect).not.toHaveBeenCalled()
  expect(f.collect).not.toHaveBeenCalled()
})
