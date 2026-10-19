import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import {
  captureInternalHarnessProjectIdentityGuard,
  isInternalHarnessProjectId,
  readInternalHarnessProject,
  readInternalHarnessProjectWorkspaceIndex,
  registerInternalHarnessProjectProvider,
  type InternalHarnessProjectContext,
  type InternalHarnessProjectOwnerKind
} from "./internal-project-context"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks() })
const compositionId = "composition-legacy:run-one:unit-one"
const trialId = "creator-business-trial:trial-one"

function context(kind: InternalHarnessProjectOwnerKind): InternalHarnessProjectContext {
  const projectId = kind === "composition" ? compositionId : trialId
  const common = {
    featureId: "original-feature", goal: "Original business goal",
    context: {
      project: { projectId, name: "Isolated original project", description: "",
        projectCode: "unit", projectDir: "unit", projectFromLean: false,
        workspacePath: tmpdir(), systemId: "", systemName: "",
        "harness-adapter": { id: "installed-uuid", name: "original", version: "1.0.0", type: "plugin" as const },
        lifecycle: { status: "active" as const, createAt: "2026-10-17T00:00:00Z" } },
      plugin: null, configSnapshot: null, projectDirectoryExists: true,
      selectedDeployUnits: [], sessionContextInjectionSource: "plugin" as const, leanToken: ""
    },
    featureBinding: { projectId, featureId: "original-feature", selectedDeployUnitMappings: [],
      sessionWorkspace: { source: "directory" as const, path: resolve(tmpdir(), "unit") },
      sessionContextInjectionSource: "plugin" as const,
      createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }
  }
  return kind === "composition" ? { ...common,
    parentProjectId: "real-parent", compositionRunId: "run-one", unitId: "unit-one" } : {
    ...common, ownerKind: "creator-business-trial", trialId,
    creatorScope: { threadId: "creator-thread", workspace: tmpdir(),
      incarnation: { token: "actual-creator-incarnation", legacyCreatedAt: 1 } }
  }
}
function owner(kind: InternalHarnessProjectOwnerKind) {
  const row = context(kind), projectId = row.context.project.projectId
  let authorized = true
  const assertOwner = vi.fn((id: string) => {
    if (!authorized) throw Error("ORIGINAL_OWNER_REVOKED")
    if (id !== projectId) throw Error("ORIGINAL_FOREIGN_PROJECT")
  })
  const read = vi.fn((id: string) => { assertOwner(id); return row })
  const identity = vi.fn((id: string) => {
    assertOwner(id)
    return () => assertOwner(id)
  })
  const workspace = vi.fn((id: string) => {
    assertOwner(id)
    return { projectId, featureId: row.featureId, workspace: resolve(tmpdir(), "unit") }
  })
  const stop = registerInternalHarnessProjectProvider(read, identity, workspace, kind)
  cleanup.push(stop)
  return { row, read, identity, workspace, assertOwner, stop, revoke: () => { authorized = false } }
}

it("preserves the default composition provider and its original parent/run/unit facts", () => {
  const row = context("composition"), read = vi.fn(() => row)
  cleanup.push(registerInternalHarnessProjectProvider(read))
  expect(readInternalHarnessProject(compositionId)).toBe(row)
  expect(row).toMatchObject({ parentProjectId: "real-parent", compositionRunId: "run-one", unitId: "unit-one" })
  expect(row.ownerKind).toBeUndefined()
  expect(readInternalHarnessProject(trialId)).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(1)
})

it("routes two independent owners without manufacturing composition facts for a creator trial", () => {
  const composition = owner("composition"), creator = owner("creator-business-trial")
  expect(readInternalHarnessProject(compositionId)).toBe(composition.row)
  expect(readInternalHarnessProject(trialId)).toBe(creator.row)
  for (const key of ["parentProjectId", "compositionRunId", "unitId"])
    expect(Object.hasOwn(creator.row, key)).toBe(false)
  expect(creator.row).toMatchObject({ ownerKind: "creator-business-trial", trialId })
  expect(readInternalHarnessProjectWorkspaceIndex(compositionId)?.projectId).toBe(compositionId)
  expect(readInternalHarnessProjectWorkspaceIndex(trialId)?.projectId).toBe(trialId)
  captureInternalHarnessProjectIdentityGuard(compositionId)()
  captureInternalHarnessProjectIdentityGuard(trialId)()
  expect(composition.read.mock.calls).toEqual([[compositionId]])
  expect(creator.read.mock.calls).toEqual([[trialId]])
  expect(composition.workspace.mock.calls).toEqual([[compositionId]])
  expect(creator.workspace.mock.calls).toEqual([[trialId]])
})

it("treats namespaces as routing only and invokes the actual owner's rejection for foreign IDs", () => {
  const composition = owner("composition"), creator = owner("creator-business-trial")
  for (const id of ["ordinary-project", "creator-business-trialish:one", "composition-legacyish:one"]) {
    expect(isInternalHarnessProjectId(id)).toBe(false)
    expect(readInternalHarnessProject(id)).toBeUndefined()
    expect(readInternalHarnessProjectWorkspaceIndex(id)).toBeUndefined()
    expect(() => captureInternalHarnessProjectIdentityGuard(id)).toThrow("SOURCE_NOT_ADMITTED")
  }
  expect(composition.read).not.toHaveBeenCalled()
  expect(creator.read).not.toHaveBeenCalled()
  for (const id of ["composition-legacy:foreign:unit", "creator-business-trial:foreign"]) {
    expect(isInternalHarnessProjectId(id)).toBe(true)
    expect(() => readInternalHarnessProject(id)).toThrow("ORIGINAL_FOREIGN_PROJECT")
    expect(() => readInternalHarnessProjectWorkspaceIndex(id)).toThrow("ORIGINAL_FOREIGN_PROJECT")
    expect(() => captureInternalHarnessProjectIdentityGuard(id)).toThrow("ORIGINAL_FOREIGN_PROJECT")
  }
})

it.each(["creator-on-composition", "composition-on-creator", "foreign-project", "foreign-trial"] as const)(
  "rejects a provider returning %s identity", mismatch => {
    const kind = mismatch === "creator-on-composition" ? "composition" : "creator-business-trial"
    let row = context(kind)
    if (mismatch === "creator-on-composition") row = context("creator-business-trial")
    if (mismatch === "composition-on-creator") row = context("composition")
    if (mismatch === "foreign-project") row.context.project.projectId = "foreign-project"
    if (mismatch === "foreign-trial" && row.ownerKind === "creator-business-trial")
      row.trialId = "creator-business-trial:another-trial"
    cleanup.push(registerInternalHarnessProjectProvider(() => row, undefined, undefined, kind))
    expect(() => readInternalHarnessProject(kind === "composition" ? compositionId : trialId))
      .toThrow("SOURCE_NOT_ADMITTED")
  }
)

it("unregisters one owner without disturbing the other owner's read or captured guard", () => {
  const composition = owner("composition"), creator = owner("creator-business-trial")
  const original = captureInternalHarnessProjectIdentityGuard(compositionId)
  const trial = captureInternalHarnessProjectIdentityGuard(trialId)
  composition.stop()
  expect(readInternalHarnessProject(compositionId)).toBeUndefined()
  expect(() => original()).toThrow("PROVIDER_CHANGED")
  expect(readInternalHarnessProject(trialId)).toBe(creator.row)
  expect(() => trial()).not.toThrow()
})

it("rejects a second provider for the same owner without changing the original registration", () => {
  const creator = owner("creator-business-trial")
  expect(() => registerInternalHarnessProjectProvider(() => context("creator-business-trial"),
    undefined, undefined, "creator-business-trial")).toThrow("ALREADY_REGISTERED")
  expect(readInternalHarnessProject(trialId)).toBe(creator.row)
})

it("invalidates an old captured guard on same-reader replacement and ignores its stale unregister", () => {
  const creator = owner("creator-business-trial")
  const before = captureInternalHarnessProjectIdentityGuard(trialId)
  const nextIdentity = vi.fn(() => () => creator.assertOwner(trialId))
  cleanup.push(registerInternalHarnessProjectProvider(creator.read, nextIdentity,
    creator.workspace, "creator-business-trial"))
  creator.stop()
  expect(() => before()).toThrow("PROVIDER_CHANGED")
  expect(readInternalHarnessProject(trialId)).toBe(creator.row)
  const current = captureInternalHarnessProjectIdentityGuard(trialId)
  current()
  expect(nextIdentity).toHaveBeenCalledWith(trialId)
  creator.revoke()
  expect(() => current()).toThrow("ORIGINAL_OWNER_REVOKED")
})

it.each(["composition", "creator-business-trial"] as const)(
  "rechecks the original %s owner's live permissions for reads, indexes and captured guards", kind => {
    const current = owner(kind), id = current.row.context.project.projectId
    const guard = captureInternalHarnessProjectIdentityGuard(id)
    const before = current.assertOwner.mock.calls.length
    guard(); guard()
    expect(current.assertOwner.mock.calls.length).toBe(before + 2)
    current.revoke()
    expect(() => guard()).toThrow("ORIGINAL_OWNER_REVOKED")
    expect(() => readInternalHarnessProject(id)).toThrow("ORIGINAL_OWNER_REVOKED")
    expect(() => readInternalHarnessProjectWorkspaceIndex(id)).toThrow("ORIGINAL_OWNER_REVOKED")
  }
)

it("cannot capture execution identity from a namespace or a provider without an owner guard", () => {
  expect(isInternalHarnessProjectId(trialId)).toBe(true)
  expect(readInternalHarnessProject(trialId)).toBeUndefined()
  expect(() => captureInternalHarnessProjectIdentityGuard(trialId)).toThrow("SOURCE_NOT_ADMITTED")
  cleanup.push(registerInternalHarnessProjectProvider(() => context("creator-business-trial"),
    undefined, undefined, "creator-business-trial"))
  expect(() => captureInternalHarnessProjectIdentityGuard(trialId)).toThrow("SOURCE_NOT_ADMITTED")
})

it("does not fall back to full context when a modern workspace index returns no row", () => {
  const read = vi.fn(() => context("creator-business-trial")), workspace = vi.fn(() => undefined)
  cleanup.push(registerInternalHarnessProjectProvider(read, undefined, workspace, "creator-business-trial"))
  expect(readInternalHarnessProjectWorkspaceIndex(trialId)).toBeUndefined()
  expect(workspace).toHaveBeenCalledWith(trialId)
  expect(read).not.toHaveBeenCalled()
})

it("retains safe path and projectCode fallback for the original provider without a workspace reader", () => {
  const row = context("composition"), read = vi.fn(() => row)
  cleanup.push(registerInternalHarnessProjectProvider(read))
  expect(readInternalHarnessProjectWorkspaceIndex(compositionId)?.workspace).toBe(resolve(tmpdir(), "unit"))
  row.context.project.projectDir = ""
  row.context.project.projectCode = "fallback"
  expect(readInternalHarnessProjectWorkspaceIndex(compositionId)?.workspace).toBe(resolve(tmpdir(), "fallback"))
  row.context.project.projectDir = "../foreign"
  expect(() => readInternalHarnessProjectWorkspaceIndex(compositionId)).toThrow("outside workspace")
  expect(read).toHaveBeenCalledTimes(3)
})
