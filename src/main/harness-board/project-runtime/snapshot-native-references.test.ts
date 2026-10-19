import { DatabaseSync } from "node:sqlite"
import { expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import { auditNativeSnapshotReferences } from "./snapshot-native-references"

function stream(values: Iterable<unknown[]>) {
  const iterator = values[Symbol.iterator]()
  let current: IteratorResult<unknown[]>
  const statement = {
    step: vi.fn(() => {
      current = iterator.next()
      return !current.done
    }),
    getAsObject: vi.fn(() => ({ metadata: current.value?.[0], thread_values: current.value?.[1] })),
    free: vi.fn(() => {
      iterator.return?.()
    })
  }
  const prepare = vi.fn(() => statement)
  const db = { prepare } as unknown as NativeSqliteAdapter
  return { statement, db, prepare }
}
const audit = (values: unknown[][]) => auditNativeSnapshotReferences(stream(values).db)

it("protects every historical/remote native row and nested snapshot field without pagination", () => {
  const digest = "d".repeat(64)
  const rows: unknown[][] = Array.from({ length: 1200 }, () => ["{}", null])
  rows.push([
    JSON.stringify({ archived: true, remote: true, source: { packageDigest: digest } }),
    "{}"
  ])
  const result = audit(rows)
  expect(result.complete).toBe(true)
  expect([...result.digests]).toEqual([digest])
})

it("refuses unknown old bindings, invalid JSON and unavailable native ledgers", () => {
  for (const text of ["bad-json", "[]", '{"project_host":{"id":"unknown-old-binding"}}'])
    expect(audit([[text, null]]).complete).toBe(false)
  expect(audit([["{}", "bad-values"]]).complete).toBe(false)
  expect(
    audit([[JSON.stringify({ project_runtime: { packageDigest: "e".repeat(64) } }), null]]).complete
  ).toBe(true)
  expect(
    auditNativeSnapshotReferences({
      prepare: () => {
        throw Error("db unavailable")
      }
    } as unknown as NativeSqliteAdapter).complete
  ).toBe(false)
})

it("consumes each historical row before requesting the next and frees its native iterator", () => {
  let consumed = 0
  function* rows() {
    for (let index = 0; index < 10_000; index++) {
      expect(consumed).toBe(index)
      yield [JSON.stringify({ packageDigest: index.toString(16).padStart(64, "0") }), null]
    }
  }
  const f = stream(rows())
  const original = f.statement.getAsObject.getMockImplementation()!
  f.statement.getAsObject.mockImplementation(() => {
    consumed++
    return original()
  })
  expect(auditNativeSnapshotReferences(f.db).digests.size).toBe(10_000)
  expect(consumed).toBe(10_000)
  expect(f.statement.step).toHaveBeenCalledTimes(10_001)
  expect(f.statement.free).toHaveBeenCalledOnce()
})

it.each(["step", "row", "json", "free"] as const)(
  "fails closed and frees the statement on a %s failure",
  (kind) => {
    const f = stream([[kind === "json" ? "bad-json" : "{}", null]])
    if (kind === "step")
      f.statement.step.mockImplementation(() => {
        throw Error("step failed")
      })
    if (kind === "row")
      f.statement.getAsObject.mockImplementation(() => {
        throw Error("row failed")
      })
    if (kind === "free")
      f.statement.free.mockImplementation(() => {
        throw Error("free failed")
      })
    expect(auditNativeSnapshotReferences(f.db).complete).toBe(false)
    expect(f.statement.free).toHaveBeenCalledOnce()
  }
)

it("streams the real native SQLite adapter without using its materializing exec surface", () => {
  const native = new DatabaseSync(":memory:")
  try {
    native.exec("CREATE TABLE threads(metadata TEXT,thread_values TEXT)")
    const insert = native.prepare("INSERT INTO threads VALUES(?,?)")
    for (let index = 0; index < 1200; index++) insert.run("{}", null)
    insert.run(
      JSON.stringify({ archived: true, remote: true, packageDigest: "f".repeat(64) }),
      "{}"
    )
    const adapter = new NativeSqliteAdapter(native)
    const exec = vi.spyOn(adapter, "exec").mockImplementation(() => {
      throw Error("EAGER_SCAN")
    })
    expect(auditNativeSnapshotReferences(adapter)).toMatchObject({ complete: true, blockers: [] })
    expect(auditNativeSnapshotReferences(adapter).digests).toEqual(new Set(["f".repeat(64)]))
    expect(exec).not.toHaveBeenCalled()
  } finally {
    native.close()
  }
})
