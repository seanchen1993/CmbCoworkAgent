import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModControlStore } from "./control-store"

const folders: string[] = []
const stores: ModControlStore[] = []
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "cmb-mods-control-"))
  folders.push(folder)
  const file = join(folder, "control.sqlite")
  const store = new ModControlStore(file)
  stores.push(store)
  return { store, file }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("cmb-mods-control-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(folder, { recursive: true, force: true })
  }
})

describe("Mod durable control store", () => {
  it("preserves cards and consumed action keys across restart", () => {
    const { store, file } = fixture()
    store.saveCard("card", "thread", { id: "card", nodes: [] })
    store.consumeAction("card:button")
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.cards("thread")).toEqual([{ id: "card", nodes: [] }])
    expect(reopened.actionConsumed("card:button")).toBe(true)
    expect(() => reopened.consumeAction("card:button")).toThrow("ALREADY_USED")
  })
  it("rejects reuse of a call ID, including different arguments", () => {
    const { store } = fixture()
    store.claim("turn:call", "host:write_file", { content: "one" })
    expect(() => store.claim("turn:call", "host:write_file", { content: "one" })).toThrow(
      "ALREADY_STARTED"
    )
    expect(() => store.claim("turn:call", "host:write_file", { content: "two" })).toThrow(
      "COLLISION"
    )
    store.settle("turn:call", "succeeded")
    expect(store.status("turn:call")).toBe("succeeded")
  })
  it("recovers uncompleted operations as unknown without replay", () => {
    const { store, file } = fixture()
    store.claim("pending", "remote:write", {})
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.status("pending")).toBe("unknown")
    expect(() => reopened.claim("pending", "remote:write", {})).toThrow("ALREADY_STARTED")
  })
  it("invalidates captured grants after revocation and reapproval", () => {
    const { store } = fixture()
    const grant = store.grant("workspace", "mod", "digest-1", true)
    store.assertGrant(grant)
    store.grant("workspace", "mod", "digest-1", false)
    expect(() => store.assertGrant(grant)).toThrow("REVOKED")
    store.grant("workspace", "mod", "digest-1", true)
    expect(() => store.assertGrant(grant)).toThrow("REVOKED")
  })
  it("isolates state namespaces and rolls back quota violations", () => {
    const { store } = fixture()
    store.write("one", "key", "value")
    expect(store.read("two", "key")).toBeNull()
    expect(() => store.write("one", "key", "x".repeat(70_000))).toThrow("VALUE_LIMIT")
    expect(store.read("one", "key")).toBe("value")
  })
})
