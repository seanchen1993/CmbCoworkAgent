import { expect, it, vi } from "vitest"
import { FunctionConfigRows, type FunctionConfigCell } from "./config-row-registry"

function fixture(cell?: FunctionConfigCell) {
  let value = true,
    revision = 0,
    locked = false
  const writer = vi.fn((input: unknown) => {
    value = input as boolean
    revision++
  })
  const shared = cell ?? { read: () => ({ value, revision: String(revision) }), write: writer }
  const rows = new FunctionConfigRows()
  const close = rows.add({
    key: "gitChangeNoticeEnabled",
    storageKey: "application:git-notice",
    label: "Git notices",
    kind: "boolean",
    provider: { plugin: "engine", tier: "core" },
    cell: shared,
    locked: () => locked,
    validate: (input) => typeof input === "boolean"
  })
  const prepare = (next = false, guard = () => {}) =>
    rows.prepare("gitChangeNoticeEnabled", { kind: "composer" }, next, guard)
  return {
    rows,
    writer,
    shared,
    prepare,
    close,
    lock: () => {
      locked = true
    }
  }
}

it("acknowledges only actual commits, writes once and cannot hide a saved change", () => {
  const f = fixture(),
    receipt = f.prepare()
  expect(receipt.result({ value: false })).toEqual({ deny: "The setting was not saved" })
  expect(receipt.commit(false)).toEqual({ value: false })
  expect(receipt.confirmedRevision()).toBe("1")
  expect(receipt.commit(true)).toEqual({ value: false })
  expect(receipt.result({ deny: "pretend it was refused" })).toEqual({ value: false })
  expect(f.writer).toHaveBeenCalledOnce()
  expect(f.rows.snapshot()[0].value).toBe(false)
})

it("two project registries compare the actual shared global revision, including a value changed back", () => {
  const first = fixture(),
    second = fixture(first.shared)
  const stale = second.prepare()
  first.prepare().commit(false)
  first.prepare(true).commit(true)
  expect(stale.commit(false)).toEqual({
    deny: "This setting changed while the request was being processed"
  })
  expect(first.writer).toHaveBeenCalledTimes(2)
})

it("unknown, locked, invalid, removed and cancelled rows do not write", () => {
  const f = fixture()
  expect(() => f.rows.prepare("unknown", { kind: "composer" }, false, () => {})).toThrow(
    "MODS_CONFIG_UNKNOWN_KEY"
  )
  expect(f.prepare().commit("wrong kind")).toEqual({ deny: "The value does not fit this setting" })
  f.lock()
  expect(f.prepare().commit(false)).toEqual({ deny: "This setting is locked" })
  const gone = f.prepare()
  f.close()
  expect(() => gone.commit(false)).toThrow("MODS_CONFIG_ROW_REPLACED")
  expect(f.writer).not.toHaveBeenCalled()
  const live = fixture(),
    controller = new AbortController()
  const receipt = live.prepare(false, () => controller.signal.throwIfAborted())
  controller.abort()
  expect(() => receipt.commit(false)).toThrow()
  expect(live.writer).not.toHaveBeenCalled()
})

it("same value is a real acknowledgement without another write", () => {
  const f = fixture()
  expect(f.prepare(true).commit(true)).toEqual({ value: true })
  expect(f.writer).not.toHaveBeenCalled()
})

it("a changed value without an advanced storage revision cannot confirm an ABA-safe write", () => {
  let value = true
  const write = vi.fn((received: unknown) => {
    value = received as boolean
  })
  const f = fixture({ read: () => ({ value, revision: "0" }), write })
  const receipt = f.prepare()
  expect(() => receipt.commit(false)).toThrow("MODS_CONFIG_COMMIT_UNCONFIRMED")
  expect(receipt.confirmedRevision()).toBeUndefined()
  expect(() => receipt.commit(false)).toThrow("MODS_CONFIG_COMMIT_UNCONFIRMED")
  expect(write).toHaveBeenCalledOnce()
})

it("a silent writer or failed strict read cannot manufacture a commit proof or repeat an uncertain write", () => {
  const write = vi.fn()
  const silent = fixture({ read: () => ({ value: true, revision: "0" }), write })
  const receipt = silent.prepare()
  expect(() => receipt.commit(false)).toThrow("MODS_CONFIG_COMMIT_UNCONFIRMED")
  expect(receipt.confirmed()).toBeUndefined()
  expect(() => receipt.commit(false)).toThrow("MODS_CONFIG_COMMIT_UNCONFIRMED")
  expect(write).toHaveBeenCalledOnce()
  let failed = false
  const uncertainWrite = vi.fn(() => {
    failed = true
  })
  const uncertain = fixture({
    read: () => {
      if (failed) throw Error("actual storage read failed")
      return { value: true, revision: "0" }
    },
    write: uncertainWrite
  })
  const attempted = uncertain.prepare()
  expect(() => attempted.commit(false)).toThrow("actual storage read failed")
  expect(() => attempted.commit(false)).toThrow("MODS_CONFIG_COMMIT_UNCONFIRMED")
  expect(uncertainWrite).toHaveBeenCalledOnce()
})
