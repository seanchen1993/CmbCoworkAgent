import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import { ModControlStore, type ProjectUsePolicy } from "./control-store"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const root = mkdtempSync(join(canonicalTmpdir(), "project-use-grants-"))
  const stores: ModControlStore[] = []
  const open = () => {
    const store = new ModControlStore(join(root, "control.sqlite"))
    stores.push(store)
    return store
  }
  cleanups.push(() => {
    for (const store of stores) store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const data = {
    projectId: "owner",
    workspace: root,
    plugin: { pluginId: "installed", name: "source", version: "1", digest: "a".repeat(64) },
    packageDigest: "b".repeat(64),
    capabilityDigest: "c".repeat(64),
    sources: [
      {
        pluginId: "provider",
        name: "function-one",
        digest: "d".repeat(64),
        capabilities: ["read_file"],
        actionIds: ["verify"],
        configurationOnly: false
      }
    ],
    installedSources: [{ pluginId: "installed", name: "source", version: "1", path: root }]
  }
  const policy: ProjectUsePolicy = {
    ...data,
    reviewDigest: createHash("sha256").update(JSON.stringify(data)).digest("hex")
  }
  return { store: open(), open, policy }
}

it("delegates only an exact owner source to a checked child without ordinary grants", async () => {
  const { store, policy } = fixture()
  const receipt = store.saveProjectUseAuthorization(policy)
  let current = true
  const grant = store.delegateProjectFunctionGrant(
    receipt,
    "C:/selected-child",
    "provider",
    "function-one",
    "d".repeat(64),
    () => {
      if (!current) throw Error("CHILD_CHANGED")
    }
  )
  expect(store.getGrant("C:/selected-child", "function:function-one")).toBeNull()
  expect(store.getGrant(policy.workspace, "function:function-one")).toBeNull()
  expect(() => store.assertGrant({ ...grant })).toThrow("MODS_GRANT_REVOKED")
  await store.withProjectFunctionGrant(grant, async () => {
    expect(store.getGrant(grant.workspace, grant.modId)).toBe(grant)
    await Promise.resolve()
    store.assertGrant(grant)
  })
  current = false
  expect(() => store.assertGrant(grant)).toThrow("CHILD_CHANGED")
  expect(() =>
    store.delegateProjectFunctionGrant(
      receipt,
      grant.workspace,
      "other-id",
      "function-one",
      "d".repeat(64),
      () => {}
    )
  ).toThrow("MODS_GRANT_REVOKED")
})

it("rechecks owner revocation and explicit reapproval epochs across store connections", () => {
  const { store, open, policy } = fixture()
  const receipt = store.saveProjectUseAuthorization(policy)
  const grant = store.delegateProjectFunctionGrant(
    receipt,
    "C:/child",
    "provider",
    "function-one",
    "d".repeat(64),
    () => {}
  )
  const other = open()
  other.revokeProjectUseAuthorization(policy.projectId)
  expect(() => store.assertGrant(grant)).toThrow("MODS_GRANT_REVOKED")
  expect(() => store.saveProjectUseAuthorization(policy, receipt.epoch)).toThrow(
    "MODS_PROJECT_USE_CHANGED"
  )
  const revoked = other.getProjectUseAuthorization(policy.projectId)!
  const approved = other.saveProjectUseAuthorization(policy, revoked.epoch)
  expect(approved.epoch).toBeGreaterThan(revoked.epoch)
  expect(() => store.assertGrant(grant)).toThrow("MODS_GRANT_REVOKED")
  const fresh = store.delegateProjectFunctionGrant(
    approved,
    "C:/child",
    "provider",
    "function-one",
    "d".repeat(64),
    () => {}
  )
  expect(() => store.assertGrant(fresh)).not.toThrow()
  expect(() => other.assertGrant(fresh)).toThrow("MODS_GRANT_REVOKED")
})

it("rejects a changed aggregate policy before persisting any source authorization", () => {
  const { store, policy } = fixture()
  expect(() => store.saveProjectUseAuthorization({ ...policy, workspace: "C:/other" })).toThrow(
    "MODS_PROJECT_USE_INVALID"
  )
  expect(store.getProjectUseAuthorization(policy.projectId)).toBeUndefined()
})

it("does not let a stale rollback revoke a later explicit authorization", () => {
  const { store, policy } = fixture()
  const first = store.saveProjectUseAuthorization(policy)
  const later = store.saveProjectUseAuthorization(policy, first.epoch)
  store.revokeProjectUseAuthorization(policy.projectId, first.epoch)
  expect(store.getProjectUseAuthorization(policy.projectId)).toEqual(later)
  store.revokeProjectUseAuthorization(policy.projectId, later.epoch)
  expect(store.getProjectUseAuthorization(policy.projectId)?.enabled).toBe(false)
})
