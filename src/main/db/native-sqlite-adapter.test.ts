import initSqlJs from "sql.js"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import {
  forgetRegisteredSqliteQuarantineArtifact,
  listRegisteredSqliteQuarantineArtifacts
} from "../utils/sqlite-durable-file"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-sqlite-"))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("NativeSqliteAdapter", () => {
  it("opens an existing standard SQLite file produced by sql.js", async () => {
    const databasePath = temporaryDatabasePath("legacy.sqlite")
    const SQL = await initSqlJs()
    const legacy = new SQL.Database()
    legacy.run("CREATE TABLE legacy_records (id INTEGER PRIMARY KEY, value TEXT)")
    legacy.run("INSERT INTO legacy_records (id, value) VALUES (?, ?)", [7, "preserved"])
    writeFileSync(databasePath, Buffer.from(legacy.export()))
    legacy.close()

    const opened = openNativeSqliteDatabase(databasePath, "NativeSqliteTest")
    expect(opened.recovered).toBe(false)
    expect(opened.database.exec("SELECT id, value FROM legacy_records")[0]?.values).toEqual([
      [7, "preserved"]
    ])
    expect(opened.database.exec("PRAGMA journal_mode")[0]?.values[0]?.[0]).toBe("wal")
    expect(opened.database.exec("PRAGMA synchronous")[0]?.values[0]?.[0]).toBe(1)
    opened.database.close()
  })

  it("recovers a corrupt live file from a legacy backup candidate", () => {
    const databasePath = temporaryDatabasePath("recover.sqlite")
    const backupPath = `${databasePath}.bak`
    const backup = new DatabaseSync(backupPath)
    backup.exec("PRAGMA journal_mode = DELETE")
    backup.exec("CREATE TABLE recovered_records (value TEXT)")
    backup.prepare("INSERT INTO recovered_records (value) VALUES (?)").run("from backup")
    backup.close()
    writeFileSync(databasePath, "not a sqlite database")

    const opened = openNativeSqliteDatabase(databasePath, "NativeSqliteTest")
    expect(opened.recovered).toBe(true)
    expect(opened.sourcePath).toBe(backupPath)
    expect(opened.database.exec("SELECT value FROM recovered_records")[0]?.values).toEqual([
      ["from backup"]
    ])
    opened.database.close()

    const quarantineArtifacts = listRegisteredSqliteQuarantineArtifacts(databasePath)
    expect(quarantineArtifacts).toHaveLength(1)
    expect(quarantineArtifacts[0]).toMatch(/recover\.sqlite\.corrupt\.\d+$/)
    expect(existsSync(quarantineArtifacts[0]!)).toBe(true)
    forgetRegisteredSqliteQuarantineArtifact(databasePath, quarantineArtifacts[0]!)
  })

  it("materializes a recovery candidate's WAL before promoting its main file", () => {
    const databasePath = temporaryDatabasePath("recover-wal.sqlite")
    const temporaryPath = `${databasePath}.tmp`
    const temporary = new DatabaseSync(temporaryPath)
    try {
      temporary.exec("PRAGMA journal_mode = WAL")
      temporary.exec("PRAGMA wal_autocheckpoint = 0")
      temporary.exec("CREATE TABLE recovered_wal_records (value TEXT)")
      temporary
        .prepare("INSERT INTO recovered_wal_records (value) VALUES (?)")
        .run("committed in wal")

      const opened = openNativeSqliteDatabase(databasePath, "NativeSqliteTest")
      expect(opened.recovered).toBe(true)
      expect(opened.sourcePath).toBe(temporaryPath)
      expect(
        opened.database.exec("SELECT value FROM recovered_wal_records")[0]?.values
      ).toEqual([["committed in wal"]])
      opened.database.close()
    } finally {
      temporary.close()
    }
  })

  it("updates a large database through WAL without export or full snapshot sidecars", () => {
    const databasePath = temporaryDatabasePath("large.sqlite")
    const opened = openNativeSqliteDatabase(databasePath, "NativeSqliteTest")
    const database = opened.database
    const payload = new Uint8Array(16 * 1024 * 1024)
    payload.fill(120)

    database.run("CREATE TABLE payloads (id INTEGER PRIMARY KEY, payload BLOB, revision INTEGER)")
    database.run("INSERT INTO payloads (id, payload, revision) VALUES (?, ?, ?)", [1, payload, 1])
    database.flush("TRUNCATE")
    database.run("UPDATE payloads SET revision = ? WHERE id = ?", [2, 1])

    expect("export" in database).toBe(false)
    expect(database.exec("SELECT revision FROM payloads WHERE id = 1")[0]?.values).toEqual([[2]])
    expect(readdirSync(dirname(databasePath))).not.toEqual(
      expect.arrayContaining([
        "large.sqlite.tmp",
        "large.sqlite.flush.tmp",
        "large.sqlite.bak",
        "large.sqlite.bak.tmp",
        "large.sqlite.recovery.tmp"
      ])
    )

    database.close()
    const reopened = openNativeSqliteDatabase(databasePath, "NativeSqliteTest")
    expect(reopened.database.exec("SELECT revision FROM payloads WHERE id = 1")[0]?.values).toEqual([
      [2]
    ])
    reopened.database.close()
  })

  it("preserves sql.js prepared-statement bind and iteration semantics", () => {
    const databasePath = temporaryDatabasePath("statements.sqlite")
    const database = openNativeSqliteDatabase(databasePath, "NativeSqliteTest").database
    database.run("CREATE TABLE values_table (value INTEGER)")
    database.run("INSERT INTO values_table (value) VALUES (?), (?), (?)", [1, 2, 3])

    const statement = database.prepare(
      "SELECT value FROM values_table WHERE value > ? ORDER BY value ASC"
    )
    statement.bind([1])
    expect(statement.step()).toBe(true)
    expect(statement.getAsObject()).toEqual({ value: 2 })
    expect(statement.step()).toBe(true)
    expect(statement.getAsObject()).toEqual({ value: 3 })
    expect(statement.step()).toBe(false)
    statement.reset()
    statement.bind([2])
    expect(statement.step()).toBe(true)
    expect(statement.getAsObject()).toEqual({ value: 3 })
    statement.free()
    database.close()
  })
})
