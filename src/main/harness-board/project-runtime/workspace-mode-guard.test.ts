import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { HostProjectStore } from "./host-store"
import { LegacyOperationStore } from "./legacy-operation-store"
import { ProjectWorkspaceModeGuard } from "./workspace-mode-guard"
import { hostProjectFixture } from "./host-fixtures.test-helper"

function paths() {
  const root = mkdtempSync(join(tmpdir(), "project-workspace-mode-"))
  const host = join(root, "host.sqlite"),
    legacy = join(root, "legacy.sqlite"),
    lock = join(root, "lock.sqlite")
  const binding = {
    projectId: "legacy",
    workspace: root,
    installedPluginId: "plugin",
    packageId: "docs",
    packageVersion: "1",
    packageDigest: "a".repeat(64),
    mods: null
  }
  return {
    root,
    host,
    legacy,
    lock,
    binding,
    guard: () => new ProjectWorkspaceModeGuard(host, legacy, lock)
  }
}

it.each(["host", "legacy"] as const)(
  "rejects opposite configuration after %s ownership across store instances",
  (first) => {
    const f = paths()
    const host = new HostProjectStore(f.host, undefined, f.guard())
    const legacy = new LegacyOperationStore(f.legacy, undefined, f.guard())
    try {
      if (first === "host") {
        host.create(hostProjectFixture(f.root))
        expect(() => legacy.enable(f.binding)).toThrow("PROJECT_WORKSPACE_MODE_CONFLICT")
      } else {
        legacy.enable(f.binding)
        expect(() => host.create(hostProjectFixture(f.root))).toThrow(
          "PROJECT_WORKSPACE_MODE_CONFLICT"
        )
        legacy.disable("legacy")
        expect(host.create(hostProjectFixture(f.root)).workspace).toBe(f.root)
      }
    } finally {
      host.close()
      legacy.close()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

it("refuses both original start paths for already overlapping persisted configurations", () => {
  const f = paths()
  const oldHost = new HostProjectStore(f.host),
    oldLegacy = new LegacyOperationStore(f.legacy)
  const project = oldHost.create(hostProjectFixture(f.root))
  const operation = oldHost.prepare({
    projectId: project.projectId,
    expectedVersion: 1,
    stageId: "draft",
    idempotencyKey: "old",
    inputFingerprint: "b".repeat(64)
  })
  oldLegacy.enable(f.binding)
  oldHost.close()
  oldLegacy.close()
  const host = new HostProjectStore(f.host, undefined, f.guard())
  const legacy = new LegacyOperationStore(f.legacy, undefined, f.guard())
  try {
    expect(() => host.start(operation.operationId, operation.inputFingerprint)).toThrow(
      "PROJECT_WORKSPACE_MODE_CONFLICT"
    )
    expect(() =>
      legacy.admit({
        projectId: "legacy",
        featureId: "feature",
        workspace: f.root,
        installedPluginId: "plugin",
        packageDigest: f.binding.packageDigest,
        threadId: "thread",
        threadIncarnation: "one",
        requestId: "run",
        inputDigest: "c".repeat(64)
      })
    ).toThrow("PROJECT_WORKSPACE_MODE_CONFLICT")
    expect(host.getOperation(operation.operationId)?.status).toBe("prepared")
    expect(legacy.list("legacy")).toEqual([])
  } finally {
    host.close()
    legacy.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})
