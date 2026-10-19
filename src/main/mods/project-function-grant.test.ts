import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "./control-store"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-grant-")),
    path = join(root, "store.sqlite")
  const stores: ModControlStore[] = []
  const open = () => {
    const store = new ModControlStore(path)
    stores.push(store)
    return store
  }
  cleanup.push(() => {
    for (const store of stores) store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store: open(), open }
}
it("isolates project/source grants from ordinary chats and other projects in the same workspace", () => {
  const { store } = fixture(),
    workspace = "C:/workspace",
    digest = "a".repeat(64)
  const ordinary = store.grant(workspace, "function:example", "b".repeat(64), true)
  const project = store.grantProjectFunction(
    workspace,
    "project-one",
    digest,
    "example",
    "c".repeat(64),
    true
  )
  expect(project.modId).toBe("function:example")
  expect(project.sourceScope).toMatch(/^project-function:[a-f0-9]{64}$/)
  expect(store.getGrant(workspace, "function:example")).toEqual(ordinary)
  expect(store.getProjectFunctionGrant(workspace, "project-two", digest, "example")).toBeNull()
  expect(
    store.getProjectFunctionGrant(workspace, "project-one", "d".repeat(64), "example")
  ).toBeNull()
  expect(() => store.assertGrant(project)).not.toThrow()
  expect(() => store.assertGrant({ ...project })).toThrow("MODS_GRANT_REVOKED")
  store.grantProjectFunction(workspace, "project-one", digest, "example", project.digest, false)
  expect(() => store.assertGrant(project)).toThrow("MODS_GRANT_REVOKED")
  expect(() => store.assertGrant(ordinary)).not.toThrow()
})
it("retains scoped native re-lookups only for the physical call and rejects inherited expired frames", async () => {
  const { store } = fixture(),
    workspace = "C:/workspace"
  const ordinary = store.grant(workspace, "function:example", "b".repeat(64), true)
  const project = store.grantProjectFunction(
    workspace,
    "project",
    "a".repeat(64),
    "example",
    "c".repeat(64),
    true
  )
  const gate = Promise.withResolvers<void>()
  let late: Promise<unknown> | undefined
  await store.withProjectFunctionGrant(project, async () => {
    expect(store.getGrant(workspace, "function:example")).toBe(project)
    await Promise.resolve()
    expect(store.getGrant(workspace, "function:example")).toBe(project)
    late = gate.promise.then(() => {
      expect(() => store.getGrant(workspace, "function:example")).toThrow("MODS_GRANT_REVOKED")
    })
  })
  expect(store.getGrant(workspace, "function:example")).toEqual(ordinary)
  gate.resolve()
  await late
})
it("rechecks durable scoped receipts after restart but cannot marshal authority between store instances", () => {
  const { store, open } = fixture(),
    workspace = "C:/workspace",
    digest = "a".repeat(64)
  const original = store.grantProjectFunction(
    workspace,
    "project",
    digest,
    "example",
    "c".repeat(64),
    true
  )
  const restarted = open()
  expect(() => restarted.assertGrant(original)).toThrow("MODS_GRANT_REVOKED")
  const checked = restarted.getProjectFunctionGrant(workspace, "project", digest, "example")!
  expect(() => restarted.assertGrant(checked)).not.toThrow()
  restarted.grantProjectFunction(workspace, "project", digest, "example", "d".repeat(64), true)
  expect(() => store.assertGrant(original)).toThrow("MODS_GRANT_REVOKED")
})
