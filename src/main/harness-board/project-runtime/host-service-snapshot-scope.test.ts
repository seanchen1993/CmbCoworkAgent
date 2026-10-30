import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { HostProjectService, type HostSkillExecutionContext } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"

const cleanup: Array<() => void> = []
vi.setConfig({ testTimeout: 30000 })
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)

async function fixture(
  executeSkill: (context: HostSkillExecutionContext) => Promise<"succeeded" | "failed">
) {
  const root = mkdtempSync(join(tmpdir(), "host-snapshot-scope-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace"),
    plugin = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(plugin)
  const manifest = hostProjectFixture(workspace).manifest
  for (const stage of manifest.stages) {
    stage.approval = "none"
    mkdirSync(join(plugin, "skills", stage.id), { recursive: true })
    writeFileSync(join(plugin, stage.skill!), "original")
  }
  writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  // Enough retained files to expose accidental O(boundaries * full-byte-reads) behavior.
  for (let index = 0; index < 40; index++)
    writeFileSync(join(plugin, `asset-${index}.txt`), "x".repeat(4096))
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const store = new HostProjectStore(join(root, "host.sqlite"))
  cleanup.push(() => store.close())
  let epoch = 0
  const service = new HostProjectService(store, snapshots, {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "docs",
      root: plugin,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: async () => {},
    captureInputAuthorityIdentity: () => () => String(epoch),
    executeSkill
  })
  await service.localCreate({
    projectId: "docs",
    name: "Docs",
    workspace,
    installedPluginId: "docs",
    goal: "produce a document"
  })
  const run = async () => {
    const project = service.get("docs")!
    const operation = service.prepare({
      projectId: "docs",
      expectedVersion: project.version,
      idempotencyKey: String(service.operations("docs").length)
    })
    return service.start(operation.operationId)
  }
  return {
    root,
    workspace,
    snapshots,
    service,
    run,
    revoke: () => {
      epoch++
    }
  }
}

it("reuses only admitted source within one operation and still fully reads every dispatch and settlement", async () => {
  let checks = 0
  const setup = await fixture(async (context) => {
    const fullStarted = performance.now()
    if (checks === 0)
      for (let index = 0; index < 25; index++) setup.snapshots.read(context.project.pluginDigest)
    const fullMs = performance.now() - fullStarted
    const baseline = read.mock.calls.length
    const guardStarted = performance.now()
    for (let index = 0; index < 25; index++) {
      context.assertInputsCurrent!()
      await Promise.resolve()
    }
    expect(read.mock.calls.length).toBe(baseline)
    if (checks === 0)
      console.info(
        "HOST_OPERATION_SNAPSHOT_COMPARISON",
        JSON.stringify({
          checks: 25,
          files: 44,
          beforeFullReads: 25,
          afterInternalFullReads: 0,
          baselineFullReadMs: Math.round(fullMs),
          guardedFingerprintMs: Math.round(performance.now() - guardStarted)
        })
      )
    // The actual project action executor owns an independent reader. Its byte check is unchanged.
    const dispatch = new HostPackageSnapshots(join(setup.root, "snapshots"))
    expect(dispatch.read(context.project.pluginDigest).root).toBe(context.snapshotRoot)
    checks++
    writeFileSync(join(setup.workspace, "document.md"), "verified")
    return "succeeded"
  })
  const read = vi.spyOn(setup.snapshots, "read")
  const before = read.mock.calls.length
  const first = await setup.run()
  expect(first.status).toBe("succeeded")
  expect(read.mock.calls.length).toBeGreaterThan(before + 2)
  setup.service.transition(first.operationId)
  const afterFirst = read.mock.calls.length
  const second = await setup.run()
  expect(second.status).toBe("succeeded")
  expect(read.mock.calls.length).toBeGreaterThan(afterFirst + 2)
  expect(checks).toBe(2)
})

it.each(["same-size-restored-mtime", "add", "delete", "parent-replaced", "junction"] as const)(
  "rejects %s source changes during consecutive guarded steps",
  async (kind) => {
    let observed = false
    const setup = await fixture(async (context) => {
      context.assertInputsCurrent!()
      await Promise.resolve()
      const file = join(context.snapshotRoot, context.skillPath)
      if (kind === "same-size-restored-mtime") {
        const before = statSync(file)
        writeFileSync(file, "modified")
        utimesSync(file, before.atime, before.mtime)
      } else if (kind === "add") writeFileSync(join(context.snapshotRoot, "added.txt"), "new")
      else if (kind === "delete") rmSync(file)
      else {
        const parent = join(context.snapshotRoot, "skills")
        const moved = join(setup.root, "moved-skills")
        renameSync(parent, moved)
        if (kind === "junction")
          symlinkSync(moved, parent, process.platform === "win32" ? "junction" : "dir")
        else cpSync(moved, parent, { recursive: true })
      }
      expect(() => context.assertInputsCurrent!()).toThrow()
      // A changed source is never adopted as a new baseline inside this operation.
      expect(() => context.assertInputsCurrent!()).toThrow()
      observed = true
      return "failed"
    })
    const operation = await setup.run()
    expect(observed).toBe(true)
    expect(operation.status).not.toBe("succeeded")
    expect(() => setup.service.transition(operation.operationId)).toThrow()
  }
)

it("does not cache authorization or operation lifetime alongside immutable source", async () => {
  let stale: (() => void) | undefined
  const setup = await fixture(async (context) => {
    context.assertInputsCurrent!()
    stale = context.assertInputsCurrent
    setup.revoke()
    expect(() => context.assertInputsCurrent!()).toThrow("INPUT_CHANGED")
    return "failed"
  })
  const operation = await setup.run()
  expect(operation.status).not.toBe("succeeded")
  expect(stale).toBeDefined()
  expect(() => stale!()).toThrow("OPERATION_SCOPE_CHANGED")
})

it("does not carry a successful source admission into the next stage", async () => {
  let retained = ""
  const setup = await fixture(async (context) => {
    retained = context.snapshotRoot
    writeFileSync(join(setup.workspace, "document.md"), "verified")
    return "succeeded"
  })
  const first = await setup.run()
  expect(first.status).toBe("succeeded")
  setup.service.transition(first.operationId)
  const file = join(retained, "skills/review/SKILL.md")
  const before = statSync(file)
  expect(readFileSync(file, "utf8")).toBe("original")
  writeFileSync(file, "modified")
  utimesSync(file, before.atime, before.mtime)
  await expect(setup.run()).rejects.toThrow("PACKAGE_CHANGED")
})
