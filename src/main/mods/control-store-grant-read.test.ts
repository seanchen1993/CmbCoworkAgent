import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "./control-store"

const folders: string[] = []
const stores = new Set<ModControlStore>()
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "mods-grant-read-"))
  folders.push(folder)
  const file = join(folder, "control.sqlite")
  const store = new ModControlStore(file)
  stores.add(store)
  return { store, file }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores) store.close()
  stores.clear()
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("mods-grant-read-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(folder, { recursive: true, force: true })
  }
})

it("bounds grant query compilation while checking every streamed frame", () => {
  const { store } = fixture()
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare")
  const grant = store.grant("project", "function:plugin", "digest", true)
  for (let frame = 0; frame < 1000; frame++) store.assertGrant(grant)
  const reads = prepare.mock.calls.filter(
    ([sql]) => sql === "SELECT * FROM mods_grants WHERE workspace=? AND mod_id=?"
  )
  expect(reads).toHaveLength(1)
})

it("observes committed external revocation, digest and epoch changes without retaining authority", () => {
  const { store, file } = fixture()
  const grant = store.grant("project", "function:plugin", "digest", true)
  store.assertGrant(grant)
  const writer = new DatabaseSync(file)
  try {
    writer.exec("BEGIN IMMEDIATE")
    writer.prepare("UPDATE mods_grants SET enabled=0, epoch=epoch+1").run()
    // An uncommitted external transaction is not visible to this connection.
    store.assertGrant(grant)
    writer.exec("COMMIT")
    expect(() => store.assertGrant(grant)).toThrow("MODS_GRANT_REVOKED")
    writer.prepare("UPDATE mods_grants SET enabled=1, epoch=epoch+1").run()
    expect(() => store.assertGrant(grant)).toThrow("MODS_GRANT_REVOKED")
    const renewed = store.getGrant("project", "function:plugin")!
    store.assertGrant(renewed)
    writer.prepare("UPDATE mods_grants SET digest='replacement'").run()
    expect(() => store.assertGrant(renewed)).toThrow("MODS_GRANT_REVOKED")
    writer.prepare("DELETE FROM mods_grants").run()
    expect(store.getGrant("project", "function:plugin")).toBeNull()
    expect(() => store.assertGrant(renewed)).toThrow("MODS_GRANT_REVOKED")
  } finally {
    writer.close()
  }
})

it("keeps returned grants, workspaces and database lifetimes separate", () => {
  const a = fixture(),
    b = fixture()
  const grant = a.store.grant("project-a", "plugin", "a", true)
  a.store.grant("project-b", "plugin", "b", true)
  b.store.grant("project-a", "plugin", "other", true)
  const read = a.store.getGrant("project-a", "plugin")!
  read.digest = "mutated"
  read.enabled = false
  a.store.assertGrant(grant)
  expect(a.store.getGrant("project-b", "plugin")?.digest).toBe("b")
  expect(b.store.getGrant("project-a", "plugin")?.digest).toBe("other")
  a.store.close()
  stores.delete(a.store)
  expect(() => a.store.assertGrant(grant)).toThrow()
  const reopened = new ModControlStore(a.file)
  stores.add(reopened)
  reopened.assertGrant(grant)
})
