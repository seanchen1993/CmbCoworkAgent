import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync,
  statSync, symlinkSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"
import * as appDb from "../db"
import * as threadIdentity from "../db/function-conversation-thread-identity-read"
import {
  captureFunctionConversationNativeRun,
  readFunctionConversationNativeRun,
  type FunctionConversationNativeRunCapture,
  type FunctionConversationNativeRunProof
} from "./native-conversation-run"
import { ModRuntimeAuthorities } from "./runtime-instance"
import { matchesThreadIncarnation } from "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
const fsProbe = vi.hoisted(() => ({ zeroIdentityPaths: new Set<string>(),
  resolvedPaths: new Set<string>(), realpathCalls: 0 }))
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  const observe = (args: unknown[]) => {
    if (typeof args[0] === "string" && fsProbe.resolvedPaths.has(key(args[0])))
      fsProbe.realpathCalls++
  }
  const originalRealpath = actual.realpathSync
  const realpath = Object.assign((...args: unknown[]) => {
    observe(args)
    return Reflect.apply(originalRealpath, actual, args)
  }, { native: (...args: unknown[]) => {
    observe(args)
    return Reflect.apply(originalRealpath.native, originalRealpath, args)
  } })
  return { ...actual, realpathSync: realpath, statSync: (...args: unknown[]) => {
    const value: unknown = Reflect.apply(actual.statSync, actual, args)
    if (typeof args[0] !== "string" || !fsProbe.zeroIdentityPaths.has(key(args[0]))) return value
    if (!value || typeof value !== "object") throw Error("ACTUAL_STAT_RESULT_REQUIRED")
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const field of ["dev", "ino"]) {
      const descriptor = descriptors[field]
      if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_STAT_DATA_REQUIRED")
      descriptors[field] = { ...descriptor, value: typeof descriptor.value === "bigint" ? 0n : 0 }
    }
    return Object.create(Object.getPrototypeOf(value), descriptors) as object
  } }
})
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-conversation-run-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  fsProbe.zeroIdentityPaths.clear()
  fsProbe.resolvedPaths.clear()
  fsProbe.realpathCalls = 0
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const path = realpathSync(mkdtempSync(join(directory, "workspace-")))
  const workspace = process.platform === "win32" ? path.toLowerCase() : path
  const threadId = randomUUID()
  const physicalRunId = randomUUID()
  const turnId = `hook-${randomUUID()}`
  const controller = new AbortController()
  const authorities = new ModRuntimeAuthorities()
  const created = authorities.create({ workspace, threadId, turnId }, controller.signal)
  const authority = created.authority
  const thread = appDb.createThread(threadId, { workspacePath: path })
  const claim = claimLocalThreadRunLease({ threadId, owner: "desktop", runId: physicalRunId })
  if (!claim.acquired) throw Error("ACTUAL_RUN_LEASE_REQUIRED")
  let binding = Object.freeze({})
  const originalBinding = binding
  const assertBinding = vi.fn(() => {
    if (binding !== originalBinding) throw Error("ORIGINAL_BINDING_RETIRED")
  })
  const input: FunctionConversationNativeRunCapture = {
    authority, authorities, physicalRunId, signal: controller.signal, assertBinding
  }
  cleanups.push(() => {
    authorities.close()
    const lease = getLocalThreadRunLease(threadId)
    if (lease) releaseLocalThreadRunLease(threadId, lease.owner, lease.runId)
  })
  return {
    input, authority, authorities, controller, thread, threadId, physicalRunId, workspace, path,
    assertBinding,
    replaceBinding: () => { binding = Object.freeze({}) }
  }
}

/** Delete only this test's empty actual workspace, with no recursive removal or link target. */
function removeOwnedEmptyWorkspace(path: string): void {
  const root = realpathSync(directory), actual = realpathSync(path)
  const child = relative(root, actual)
  const samePath = process.platform === "win32"
    ? actual.toLowerCase() === resolve(path).toLowerCase() : actual === resolve(path)
  if (!child || isAbsolute(child) || child === ".." || child.startsWith("../") ||
    child.startsWith("..\\") || !samePath || lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isDirectory() || readdirSync(actual).length)
    throw Error("ACTUAL_EMPTY_OWNED_WORKSPACE_REQUIRED")
  rmdirSync(actual)
}

describe("actual native conversation run proof", () => {
  it("captures a frozen physical run independently of the Hook turn id", () => {
    const f = fixture()
    const captured = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(captured.proof, f.authority)
    expect(run.lease.runId).toBe(f.physicalRunId)
    expect(f.authority.turnId).not.toBe(f.physicalRunId)
    expect(run.incarnation.token).not.toBeNull()
    expect(Object.is(run.database, appDb.getDb())).toBe(true)
    for (const value of [captured, captured.proof, run, run.run, run.lease, run.incarnation])
      expect(Object.isFrozen(value)).toBe(true)
    expect(readFunctionConversationNativeRun(captured.proof, f.authority)).toBe(run)
    run.assertCurrent()
  })

  it("does not let an equal serialized proof or authority borrow the original run", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const copiedProof: FunctionConversationNativeRunProof = { ...proof }
    expect(() => readFunctionConversationNativeRun(copiedProof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_UNAVAILABLE")
    expect(() => readFunctionConversationNativeRun(proof, { ...f.authority }))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_UNAVAILABLE")
    expect(() => captureFunctionConversationNativeRun({ ...f.input,
      authority: { ...f.authority } })).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
  })

  it("rejects a different actual authority at the read boundary", () => {
    const first = fixture()
    const second = fixture()
    const { proof } = captureFunctionConversationNativeRun(first.input)
    expect(() => readFunctionConversationNativeRun(proof, second.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_UNAVAILABLE")
  })

  it("rejects capture without the exact physical run lease", () => {
    const f = fixture()
    expect(() => captureFunctionConversationNativeRun({ ...f.input, physicalRunId: "other" }))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    releaseLocalThreadRunLease(f.threadId, "desktop", f.physicalRunId)
    expect(() => captureFunctionConversationNativeRun(f.input))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
  })

  it("rejects release and reacquisition with identical lease fields", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    expect(releaseLocalThreadRunLease(f.threadId, "desktop", f.physicalRunId)).toBe(true)
    const claim = claimLocalThreadRunLease({ ...run.lease })
    expect(claim.acquired).toBe(true)
    expect(getLocalThreadRunLease(f.threadId)).toEqual(run.lease)
    expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    const fresh = captureFunctionConversationNativeRun(f.input)
    expect(Object.is(readFunctionConversationNativeRun(fresh.proof, f.authority).run, run.run))
      .toBe(false)
  })

  it("rejects handoff and same-id acquisition by another lease owner", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const replacement = randomUUID()
    expect(claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop",
      runId: replacement, handoffFromRunId: f.physicalRunId }).acquired).toBe(true)
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    releaseLocalThreadRunLease(f.threadId, "desktop", replacement)
    expect(claimLocalThreadRunLease({ threadId: f.threadId, owner: "scheduler",
      runId: f.physicalRunId }).acquired).toBe(true)
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
  })

  it("does not transfer a proof to a replacement runtime with equal public fields", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const replacement = f.authorities.create({ ...f.authority }, f.controller.signal)
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(() => readFunctionConversationNativeRun(proof, replacement.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_UNAVAILABLE")
  })

  it("does not recapture a replacement binding or swallow the original guard error", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    f.replaceBinding()
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("ORIGINAL_BINDING_RETIRED")
    expect(() => captureFunctionConversationNativeRun(f.input))
      .toThrow("ORIGINAL_BINDING_RETIRED")
  })

  it("checks physical ownership again after the synchronous binding guard", () => {
    const f = fixture()
    let replace = false
    const input = { ...f.input, assertBinding: () => {
      if (!replace) return
      const lease = getLocalThreadRunLease(f.threadId)
      if (!lease) throw Error("ACTUAL_RUN_LEASE_REQUIRED")
      releaseLocalThreadRunLease(f.threadId, lease.owner, lease.runId)
      claimLocalThreadRunLease(lease)
    } }
    const { proof } = captureFunctionConversationNativeRun(input)
    replace = true
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(() => captureFunctionConversationNativeRun(input))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
  })

  it("rejects an asynchronous binding guard without minting an admitted proof", () => {
    const f = fixture()
    expect(() => captureFunctionConversationNativeRun({ ...f.input,
      assertBinding: () => Promise.resolve() }))
      .toThrow("MODS_CONVERSATION_NATIVE_BINDING_GUARD_ASYNC")
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
  })

  it("rejects a deleted and recreated thread while preserving the replacement lease", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    appDb.getDb().run("DELETE FROM threads WHERE thread_id = ?", [f.threadId])
    appDb.createThread(f.threadId, { workspacePath: f.workspace })
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
  })

  it("rejects workspace changes even when the thread incarnation is unchanged", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const other = mkdtempSync(join(directory, "other-workspace-"))
    const metadata: unknown = JSON.parse(f.thread.metadata ?? "{}")
    if (!metadata || typeof metadata !== "object") throw Error("ACTUAL_METADATA_REQUIRED")
    appDb.getDb().run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [
      JSON.stringify({ ...metadata, workspacePath: other }), f.threadId
    ])
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
  })

  it("resolves the real workspace alias on every check and rejects a junction retarget", () => {
    const f = fixture()
    const alias = join(directory, `workspace-alias-${randomUUID()}`)
    const other = mkdtempSync(join(directory, "alias-other-workspace-"))
    const linkType = process.platform === "win32" ? "junction" : "dir"
    symlinkSync(f.path, alias, linkType)
    cleanups.push(() => {
      // Remove only the link. The actual workspace roots stay owned by their original cleanup.
      if (lstatSync(alias).isSymbolicLink()) unlinkSync(alias)
      else throw Error("ACTUAL_WORKSPACE_ALIAS_REQUIRED")
    })
    const metadata: unknown = JSON.parse(f.thread.metadata ?? "{}")
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw Error("ACTUAL_METADATA_REQUIRED")
    const fixedMetadata = JSON.stringify({ ...metadata, workspacePath: alias })
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [fixedMetadata, f.threadId])
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    run.assertCurrent()

    unlinkSync(alias)
    symlinkSync(other, alias, linkType)
    expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(fixedMetadata)
    expect(matchesThreadIncarnation(appDb.getThreadCore(f.threadId), run.incarnation)).toBe(true)
    expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(() => readFunctionConversationNativeRun(proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")

    unlinkSync(alias)
    symlinkSync(f.path, alias, linkType)
    expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(fixedMetadata)
    expect(readFunctionConversationNativeRun(proof, f.authority)).toBe(run)
    run.assertCurrent()
  })

  it.runIf(process.platform === "win32")(
    "rejects deletion and recreation of the original canonical directory at the same path", () => {
      const f = fixture()
      const original = statSync(f.path, { bigint: true })
      expect(original.dev > 0n && original.ino > 0n && original.birthtimeNs > 0n).toBe(true)
      const { proof } = captureFunctionConversationNativeRun(f.input)
      const run = readFunctionConversationNativeRun(proof, f.authority)
      removeOwnedEmptyWorkspace(f.path)
      mkdirSync(f.path)
      expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(f.thread.metadata)
      expect(matchesThreadIncarnation(appDb.getThreadCore(f.threadId), run.incarnation)).toBe(true)
      expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
      expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
      expect(() => readFunctionConversationNativeRun(proof, f.authority))
        .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    })

  it.runIf(process.platform === "win32")(
    "rejects replacing both alias and canonical directory objects despite equal real path strings", () => {
      const f = fixture(), alias = join(directory, `paired-alias-${randomUUID()}`)
      symlinkSync(f.path, alias, "junction")
      cleanups.push(() => {
        if (!lstatSync(alias).isSymbolicLink()) throw Error("ACTUAL_WORKSPACE_ALIAS_REQUIRED")
        unlinkSync(alias)
      })
      const metadata: unknown = JSON.parse(f.thread.metadata ?? "{}")
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        throw Error("ACTUAL_METADATA_REQUIRED")
      const fixedMetadata = JSON.stringify({ ...metadata, workspacePath: alias })
      appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [fixedMetadata, f.threadId])
      const original = statSync(f.path, { bigint: true })
      expect(original.dev > 0n && original.ino > 0n && original.birthtimeNs > 0n).toBe(true)
      const { proof } = captureFunctionConversationNativeRun(f.input)
      const run = readFunctionConversationNativeRun(proof, f.authority)
      unlinkSync(alias)
      removeOwnedEmptyWorkspace(f.path)
      mkdirSync(f.path)
      symlinkSync(f.path, alias, "junction")
      expect(realpathSync.native(alias).toLowerCase()).toBe(f.workspace)
      expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(fixedMetadata)
      expect(matchesThreadIncarnation(appDb.getThreadCore(f.threadId), run.incarnation)).toBe(true)
      expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    })

  it("falls back to actual realpath before and after every guard when directory IDs are unsupported", () => {
    const f = fixture(), alias = join(directory, `fallback-alias-${randomUUID()}`)
    const other = mkdtempSync(join(directory, "fallback-other-workspace-"))
    const linkType = process.platform === "win32" ? "junction" : "dir"
    symlinkSync(f.path, alias, linkType)
    cleanups.push(() => {
      if (!lstatSync(alias).isSymbolicLink()) throw Error("ACTUAL_WORKSPACE_ALIAS_REQUIRED")
      unlinkSync(alias)
    })
    const metadata: unknown = JSON.parse(f.thread.metadata ?? "{}")
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw Error("ACTUAL_METADATA_REQUIRED")
    const fixedMetadata = JSON.stringify({ ...metadata, workspacePath: alias })
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [fixedMetadata, f.threadId])
    const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
    for (const path of [alias, f.path]) fsProbe.zeroIdentityPaths.add(key(path))
    fsProbe.resolvedPaths.add(key(alias))
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    const before = fsProbe.realpathCalls
    run.assertCurrent()
    expect(fsProbe.realpathCalls - before).toBeGreaterThanOrEqual(2)
    unlinkSync(alias)
    symlinkSync(other, alias, linkType)
    expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(fixedMetadata)
    expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    unlinkSync(alias)
    symlinkSync(f.path, alias, linkType)
    expect(readFunctionConversationNativeRun(proof, f.authority)).toBe(run)
    run.assertCurrent()
  })

  it.runIf(process.platform === "win32")(
    "never downgrades an admitted directory identity when its later stat reports unsupported IDs", () => {
      const f = fixture()
      const original = statSync(f.path, { bigint: true })
      expect(original.dev > 0n && original.ino > 0n && original.birthtimeNs > 0n).toBe(true)
      const { proof } = captureFunctionConversationNativeRun(f.input)
      const run = readFunctionConversationNativeRun(proof, f.authority)
      const exactPath = f.path.toLowerCase()
      fsProbe.zeroIdentityPaths.add(exactPath)
      fsProbe.resolvedPaths.add(exactPath)
      fsProbe.realpathCalls = 0
      expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
      expect(() => readFunctionConversationNativeRun(proof, f.authority))
        .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
      expect(fsProbe.realpathCalls).toBe(0)
      expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(f.thread.metadata)
      expect(matchesThreadIncarnation(appDb.getThreadCore(f.threadId), run.incarnation)).toBe(true)
      expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
      fsProbe.zeroIdentityPaths.delete(exactPath)
      expect(readFunctionConversationNativeRun(proof, f.authority)).toBe(run)
      run.assertCurrent()
    })

  it("rejects missing or malformed workspace metadata at admission", () => {
    const f = fixture()
    for (const metadata of ["{}", "null", "[]", "not-json"]) {
      appDb.getDb().run("UPDATE threads SET metadata = ? WHERE thread_id = ?",
        [metadata, f.threadId])
      expect(() => captureFunctionConversationNativeRun(f.input))
        .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    }
  })

  it("allows unrelated runtime changes and ordinary edits to the original thread", () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const unrelated = fixture()
    unrelated.replaceBinding()
    unrelated.authorities.close()
    appDb.getDb().run("UPDATE threads SET title = ? WHERE thread_id = ?",
      ["ordinary title edit", f.threadId])
    readFunctionConversationNativeRun(proof, f.authority).assertCurrent()
  })

  it("reuses original text decoding while reading both current fact windows", () => {
    const f = fixture(), { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    const originalParse = JSON.parse
    let decodes = 0, reads = 0, bindings = 0
    const databaseRead = vi.spyOn(threadIdentity, "readFunctionConversationThreadIdentityCurrent")
    const parse = vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === f.thread.metadata) decodes++
      return Reflect.apply(originalParse, JSON, args)
    })
    f.assertBinding.mockClear()
    try {
      run.assertCurrent()
      reads = databaseRead.mock.calls.length
      bindings = f.assertBinding.mock.calls.length
    } finally { parse.mockRestore(); databaseRead.mockRestore() }
    expect(reads).toBe(2)
    expect(bindings).toBe(1)
    expect(decodes).toBe(0)
  })

  it("keeps original nonlegacy token semantics when only the fresh timestamp changes", () => {
    const f = fixture(), { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    expect(run.incarnation.token).not.toBeNull()
    appDb.getDb().run("UPDATE threads SET created_at=created_at+1 WHERE thread_id=?", [f.threadId])
    expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(f.thread.metadata)
    run.assertCurrent()
  })

  it("checks the fresh legacy timestamp again after the actual binding callback", () => {
    const f = fixture()
    const metadata = JSON.parse(f.thread.metadata ?? "{}") as Record<string, unknown>
    delete metadata.cmb_thread_incarnation
    const raw = JSON.stringify(metadata)
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [raw, f.threadId])
    let change = false
    const { proof } = captureFunctionConversationNativeRun({ ...f.input, assertBinding: () => {
      f.assertBinding()
      if (change) appDb.getDb().run(
        "UPDATE threads SET created_at=created_at+1 WHERE thread_id=?", [f.threadId])
    } })
    const run = readFunctionConversationNativeRun(proof, f.authority)
    expect(run.incarnation.token).toBeNull()
    run.assertCurrent()
    change = true
    expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(raw)
  })

  it("fully decodes every changed text fact window without replacing its original baseline", () => {
    const f = fixture(), { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    const metadata = JSON.parse(f.thread.metadata ?? "{}") as Record<string, unknown>
    const changed = JSON.stringify({ ...metadata, ordinaryNote: "actual changed metadata" })
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [changed, f.threadId])
    const originalParse = JSON.parse
    let decodes = 0
    const parse = vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === changed) decodes++
      return Reflect.apply(originalParse, JSON, args)
    })
    try { run.assertCurrent(); run.assertCurrent() }
    finally { parse.mockRestore() }
    expect(decodes).toBe(8)
  })

  it("rejects changed workspace text after the binding callback despite a valid first window", () => {
    const f = fixture()
    const metadata = JSON.parse(f.thread.metadata ?? "{}") as Record<string, unknown>
    const other = mkdtempSync(join(directory, "callback-other-workspace-"))
    let change = false
    const { proof } = captureFunctionConversationNativeRun({ ...f.input, assertBinding: () => {
      f.assertBinding()
      if (change) appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [
        JSON.stringify({ ...metadata, workspacePath: other }), f.threadId
      ])
    } })
    const run = readFunctionConversationNativeRun(proof, f.authority)
    run.assertCurrent()
    change = true
    expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
  })

  it("cannot borrow a reopened connection to the same durable AppDB", async () => {
    const f = fixture()
    const { proof } = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(proof, f.authority)
    try {
      await appDb.closeDatabase()
      expect(() => run.assertCurrent()).toThrow()
      await appDb.initializeDatabase()
      expect(Object.is(run.database, appDb.getDb())).toBe(false)
      expect(() => readFunctionConversationNativeRun(proof, f.authority))
        .toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
      const fresh = captureFunctionConversationNativeRun(f.input)
      expect(Object.is(readFunctionConversationNativeRun(fresh.proof, f.authority).database,
        appDb.getDb())).toBe(true)
    } finally {
      await appDb.initializeDatabase()
    }
  })

  it("preserves actual input cancellation and never aborts that input on retirement", () => {
    const f = fixture()
    const captured = captureFunctionConversationNativeRun(f.input)
    const run = readFunctionConversationNativeRun(captured.proof, f.authority)
    captured.retire()
    captured.retire()
    expect(run.signal.aborted).toBe(true)
    expect(f.controller.signal.aborted).toBe(false)
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
    f.authority.assertLive()
    expect(() => run.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CLOSED")
    expect(() => readFunctionConversationNativeRun(captured.proof, f.authority))
      .toThrow("MODS_CONVERSATION_NATIVE_RUN_CLOSED")
    const fresh = captureFunctionConversationNativeRun(f.input)
    const freshRun = readFunctionConversationNativeRun(fresh.proof, f.authority)
    const reason = Error("ORIGINAL_NATIVE_RUN_CANCELLED")
    f.controller.abort(reason)
    expect(freshRun.signal.reason).toBe(reason)
    expect(() => freshRun.assertCurrent()).toThrow(reason)
    expect(() => captureFunctionConversationNativeRun(f.input)).toThrow(reason)
  })
})
