import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  openNativeSqliteDatabase,
  readFunctionConversationNativeSqliteCurrentExecution,
  type NativeSqliteAdapter
} from "./native-sqlite-adapter"

function withDatabase(work: (database: NativeSqliteAdapter, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-data-version-"))
  const path = join(directory, "actual.sqlite")
  const database = openNativeSqliteDatabase(path).database
  try {
    work(database, path)
  } finally {
    database.close()
    expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true)
    expect(basename(directory).startsWith("cmb-native-data-version-")).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("fixed native main data-version read", () => {
  it("reads the real main counter and observes another connection's commit", () => {
    withDatabase((database, path) => {
      const execution = readFunctionConversationNativeSqliteCurrentExecution(database)
      expect(execution).toBeDefined()
      const read = execution!.prepareReadOne("PRAGMA main.data_version")
      const before = read()?.data_version
      expect(typeof before).toBe("number")
      expect(Number.isSafeInteger(before)).toBe(true)
      const other = new DatabaseSync(path)
      try {
        other.exec("CREATE TABLE actual_change(value INTEGER)")
      } finally {
        other.close()
      }
      expect(read()?.data_version).not.toBe(before)
      expect(execution!.prepareReadOne("SELECT 1 AS value")()?.value).toBe(1)
    })
  })

  it("keeps the public adapter read-one API SELECT-only", () => {
    withDatabase(database => {
      expect(() => database.prepareReadOne("PRAGMA main.data_version")).toThrow(
        "Read-one requires SELECT"
      )
      expect(database.prepareReadOne("SELECT 1 AS value")()?.value).toBe(1)
    })
  })

  it.each([
    "PRAGMA main.schema_version",
    "PRAGMA main.data_version=1",
    "PRAGMA main.data_version;",
    "PRAGMA main.data_version; DELETE FROM checkpoints",
    "pragma main.data_version"
  ])("rejects every other pragma spelling or statement: %s", sql => {
    withDatabase(database => {
      const execution = readFunctionConversationNativeSqliteCurrentExecution(database)!
      expect(() => execution.prepareReadOne(sql)).toThrow("Read-one requires SELECT")
      expect(execution.prepareReadOne("PRAGMA main.data_version")()?.data_version).toBeDefined()
    })
  })
})
