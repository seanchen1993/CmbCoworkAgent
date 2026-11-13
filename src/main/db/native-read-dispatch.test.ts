import { DatabaseSync, StatementSync } from "node:sqlite"
import { types } from "node:util"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import { originalCurrentDispatch } from "./native-read-dispatch"

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-dispatch-"))
  const database = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  cleanup.push(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return database
}

describe("actual SQLite callback dispatch classification", () => {
  it("uses captured primitives without polling unrelated Main JSON or descriptor replacements", () => {
    const database = fixture()
    let actual = false
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw Error("Unrelated Main parser must not be called")
    })
    const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(() => {
      throw Error("Dispatch classification must use its captured descriptor")
    })
    try { actual = originalCurrentDispatch(database) }
    finally { descriptor.mockRestore(); parse.mockRestore() }
    expect(actual).toBe(true)
  })

  it("retains actual public/native/statement override classification without executing callbacks", () => {
    const database = fixture()
    expect(originalCurrentDispatch(database)).toBe(true)
    const publicRead = vi.spyOn(database, "prepareReadOne")
    expect(originalCurrentDispatch(database)).toBe(false)
    expect(publicRead).not.toHaveBeenCalled()
    publicRead.mockRestore()
    const nativePrepare = vi.spyOn(DatabaseSync.prototype, "prepare")
    expect(originalCurrentDispatch(database)).toBe(false)
    expect(nativePrepare).not.toHaveBeenCalled()
    nativePrepare.mockRestore()
    const get = vi.spyOn(StatementSync.prototype, "get")
    expect(originalCurrentDispatch(database)).toBe(false)
    expect(get).not.toHaveBeenCalled()
    get.mockRestore()
    expect(originalCurrentDispatch(database)).toBe(true)
  })

  it("rejects Proxy adapters using its captured native proxy detector", () => {
    const database = fixture()
    const proxy = new Proxy(database, {
      getPrototypeOf() { throw Error("Proxy traps must not execute") }
    })
    const changedDetector = vi.spyOn(types, "isProxy").mockReturnValue(false)
    let actual = true
    try { actual = originalCurrentDispatch(proxy) }
    finally { changedDetector.mockRestore() }
    expect(actual).toBe(false)
  })
})
