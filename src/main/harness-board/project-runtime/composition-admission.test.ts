import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { canonicalTmpdir } from "../../../../tests/support/canonical-temp-dir"
import { acquireCompositionAdmission, compositionWorkspaceKey } from "./composition-admission"
import { guardUnopenedCompositionWorkspace, ProjectCompositionStore } from "./composition-store"
import { runtimeDigest } from "./safe-files"

it("excludes the same workspace across processes and releases the lock when the reader crashes", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "composition-process-admission-"))
  const workspace = join(root, "held")
  const another = join(root, "other")
  mkdirSync(workspace)
  mkdirSync(another)
  mkdirSync(join(root, "admission"))
  const databasePath = join(root, "state.sqlite")
  const heldKey = compositionWorkspaceKey(workspace)
  const otherKey = compositionWorkspaceKey(another)
  const heldPath = join(root, "admission", runtimeDigest(heldKey) + ".sqlite")
  const reader = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1], { timeout: 0 })
    db.exec("BEGIN")
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get()
    console.log("locked")
    setInterval(() => {}, 60000)
  `, heldPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  const exit = once(reader, "close")
  try {
    const result = await Promise.race([once(reader.stdout, "data"), exit])
    expect(String(result[0]).trim()).toBe("locked")
    expect(() => acquireCompositionAdmission(databasePath, heldKey, "writer"))
      .toThrow("COMPOSITION_WORKSPACE_BUSY")
    const releaseReader = acquireCompositionAdmission(databasePath, heldKey, "reader")
    releaseReader()
    const releaseOther = acquireCompositionAdmission(databasePath, otherKey, "writer")
    releaseOther()
    reader.kill("SIGKILL")
    await exit
    const releaseFormer = acquireCompositionAdmission(databasePath, heldKey, "writer")
    releaseFormer()
  } finally {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL")
    await exit
    rmSync(root, { recursive: true, force: true })
  }
})

it("refuses redirected lock storage or a non-file lock before opening SQLite", () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "composition-lock-path-"))
  const outside = join(root, "separate")
  const database = join(root, "state.sqlite")
  const lockDirectory = join(root, "admission")
  const scope = compositionWorkspaceKey(root)
  try {
    mkdirSync(outside)
    symlinkSync(outside, lockDirectory, process.platform === "win32" ? "junction" : "dir")
    expect(() => acquireCompositionAdmission(database, scope, "reader")).toThrow("DIRECTORY_INVALID")
    expect(readdirSync(outside)).toEqual([])
    // Remove the link itself before preparing the non-file case.
    unlinkSync(lockDirectory)
    mkdirSync(lockDirectory)
    const nonFile = join(lockDirectory, runtimeDigest(scope) + ".sqlite")
    mkdirSync(nonFile)
    expect(() => acquireCompositionAdmission(database, scope, "reader"))
      .toThrow("COMPOSITION_STORAGE_INVALID")
    expect(readdirSync(nonFile)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("releases a retained admission when the run claim throws before attachment", () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "composition-admission-attach-"))
  const path = join(root, "state.sqlite")
  const store = new ProjectCompositionStore(path)
  try {
    expect(() => guardUnopenedCompositionWorkspace(path, root, () => {
      throw Error("RUN_LEASE_CLAIM_FAILED")
    }, true)).toThrow("RUN_LEASE_CLAIM_FAILED")
    acquireCompositionAdmission(path, compositionWorkspaceKey(root), "writer")()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
