import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { HostProjectStore } from "./host-store"
import { HostProjectService } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { ProjectCompositionService } from "./composition-service"
import { LegacyOperationStore } from "./legacy-operation-store"
import { ProjectWorkspaceModeGuard } from "./workspace-mode-guard"
import type { ProjectCompositionDefinition } from "../../../shared/project-runtime/composition"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture(
  options: {
    approval?: boolean
    failCheck?: boolean
    missingTerminal?: boolean
    legacyParent?: boolean
    mappedInput?: string
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "composition-host-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  const snapshots = new HostPackageSnapshots(join(root, "packages"))
  const sources = ["documents", "analytics"].map((name) => {
    const path = join(root, name)
    mkdirSync(path)
    const manifest = hostProjectFixture(workspace).manifest
    manifest.plugin.id = name
    for (const stage of manifest.stages) {
      if (!options.approval) stage.approval = "none"
      mkdirSync(join(path, "skills", stage.id), { recursive: true })
      writeFileSync(join(path, stage.skill!), `# ${name} ${stage.id}`)
    }
    writeFileSync(join(path, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
    writeFileSync(join(path, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    return { name, path, id: `installed-${name}`, digest: snapshots.capture(path).digest }
  })
  const serviceRef: { current?: ProjectCompositionService } = {}
  const modeGuard = new ProjectWorkspaceModeGuard(
    join(root, "host.sqlite"),
    join(root, "legacy.sqlite"),
    join(root, "mode.sqlite")
  )
  const store = new HostProjectStore(
    join(root, "host.sqlite"),
    undefined,
    modeGuard,
    (workspace, work) =>
      serviceRef.current ? serviceRef.current.guardWorkspaceMutation(workspace, work) : work()
  )
  if (options.legacyParent) {
    const legacy = new LegacyOperationStore(join(root, "legacy.sqlite"), undefined, modeGuard)
    cleanups.push(() => legacy.close())
    legacy.enable({
      projectId: "visible-parent",
      workspace,
      installedPluginId: "legacy-installation",
      packageId: "legacy",
      packageVersion: "1",
      mods: null,
      packageDigest: "a".repeat(64)
    })
  }
  cleanups.push(() => store.close())
  const sourceState = { revoked: false }
  const inputCopies: Array<string | undefined> = []
  const executeSkill = vi.fn(
    async (
      context: Parameters<ConstructorParameters<typeof HostProjectService>[2]["executeSkill"]>[0]
    ) => {
      inputCopies.push(
        existsSync(join(context.project.workspace, "document.md"))
          ? readFileSync(join(context.project.workspace, "document.md"), "utf8")
          : undefined
      )
      if (!options.failCheck)
        writeFileSync(
          join(context.project.workspace, "document.md"),
          `${context.project.packageId}-${context.operation.stageId}`
        )
      context.bindThread(`thread-${context.operation.operationId}`)
      if (!options.missingTerminal)
        context.recordTerminal({ outcome: "success", code: "original-complete" })
      return "succeeded" as const
    }
  )
  const host = new HostProjectService(store, snapshots, {
    resolveInstalledPlugin: async (id) => {
      const source = sources.find((source) => source.id === id)
      return source
        ? {
            installedPluginId: id,
            root: source.path,
            packageId: source.name,
            packageVersion: "1.0.0",
            enabled: true
          }
        : undefined
    },
    authorize: async () => {},
    executeSkill
  })
  const beforeStart = vi.fn()
  const service = new ProjectCompositionService(join(root, "composition.sqlite"), host, {
    authorize: async () => {
      if (sourceState.revoked) throw Error("SOURCE_REVOKED")
    },
    authorizeDefinition: async () => {
      if (sourceState.revoked) throw Error("SOURCE_REVOKED")
    },
    authorizeParent: async () => {},
    assertWorkspaceIdle: () => {},
    beforeStart,
    inputPath: options.mappedInput ? () => options.mappedInput! : undefined,
    resolveSource: async (context) => ({
      installedPluginId: context.unit.source.pluginId,
      hostPackageDigest: sources.find((source) => source.id === context.unit.source.pluginId)!
        .digest,
      goal: "Produce and verify the requested document."
    })
  })
  serviceRef.current = service
  cleanups.push(() => service.close())
  const definition: ProjectCompositionDefinition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "visible-parent",
    workspace,
    units: sources.map((source, index) => ({
      id: `unit${index}`,
      kind: "flow" as const,
      source: { pluginId: source.id, capabilityId: "delivery", packageDigest: source.digest },
      inputs: index
        ? [{ inputId: "prior-document", fromUnitId: "unit0", artifactId: "document" }]
        : [],
      outputs: [{ id: "document", path: "document.md" }]
    }))
  }
  return {
    root,
    workspace,
    host,
    store,
    service,
    definition,
    executeSkill,
    beforeStart,
    inputPath: options.mappedInput ? () => options.mappedInput! : undefined,
    sourceState,
    inputCopies
  }
}

describe("composition through original HostProjectService", () => {
  describe("preallocated handoff", () => {
    let f: ReturnType<typeof fixture>
    beforeEach(() => {
      // Build independent packages, snapshots and stores outside the behavior timer.
      // Native preparation and all four checked Host stages remain inside the case.
      f = fixture({ mappedInput: "incoming/document.md" })
    })
    it("materializes verified handoffs after native configuration preallocates both unit roots", async () => {
      const prepared = await f.service.prepare(f.definition, "prepared-handoff")
      expect(prepared.configurationPending).toBe(true)
      expect(f.executeSkill).not.toHaveBeenCalled()
      // Inspect the real original workspace mapping rather than manufacturing a consumer root.
      const registeredRoot = f.service.store.unitWorkspace(prepared.id, "unit1")!
      expect(existsSync(registeredRoot)).toBe(true)
      expect(existsSync(join(registeredRoot, "incoming/document.md"))).toBe(false)
      await f.service.startPrepared(prepared.id, prepared.version)
      const run = await f.service.waitForSettlement(prepared.id)
      expect(run.status).toBe("succeeded")
      expect(f.executeSkill).toHaveBeenCalledTimes(4)
      const consumer = f.executeSkill.mock.calls[2][0]
      expect(consumer.project.workspace).toBe(registeredRoot)
      expect(readFileSync(join(consumer.project.workspace, "incoming/document.md"), "utf8"))
        .toBe("documents-review")
      expect(consumer.assertInputsCurrent).toBeTypeOf("function")
    })
  })
  it("rejects a conflicting preallocated copy before admitting the consumer engine", async () => {
    const f = fixture({ mappedInput: "incoming/document.md" })
    const prepared = await f.service.prepare(f.definition, "conflicting-prepared-handoff")
    const consumerRoot = f.service.store.unitWorkspace(prepared.id, "unit1")!
    mkdirSync(join(consumerRoot, "incoming"))
    writeFileSync(join(consumerRoot, "incoming/document.md"), "untrusted existing content")
    await f.service.startPrepared(prepared.id, prepared.version)
    const run = await f.service.waitForSettlement(prepared.id)
    expect(run.status).toBe("failed")
    expect(run.units[0].status).toBe("succeeded")
    expect(run.units[1].reason).toBe("COMPOSITION_INPUTS_CHANGED")
    expect(run.units[1].engineRunId).toBeUndefined()
    expect(f.executeSkill).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(consumerRoot, "incoming/document.md"), "utf8"))
      .toBe("untrusted existing content")
  })
  it("rejects a missing input copy on approval resume instead of rematerializing it", async () => {
    const f = fixture({ approval: true, mappedInput: "incoming/document.md" })
    const producerWaiting = await f.service.start(f.definition, "resume-missing-handoff")
    const approve = async (run: typeof producerWaiting, unitId: string) => {
      const operation = f.service.waitingOperation(run.id, unitId)!
      await f.service.approve(run.id, unitId, operation.operationId, {
        expectedVersion: operation.expectedVersion,
        inputFingerprint: operation.inputFingerprint,
        decision: "approved", actorId: "user"
      })
    }
    await approve(producerWaiting, "unit0")
    const consumerWaiting = await f.service.resume(producerWaiting.id, producerWaiting.version)
    expect(consumerWaiting.status).toBe("waiting-approval")
    expect(consumerWaiting.units[0].status).toBe("succeeded")
    expect(f.executeSkill).toHaveBeenCalledTimes(3)
    const consumerRoot = f.service.store.unitWorkspace(consumerWaiting.id, "unit1")!
    rmSync(join(consumerRoot, "incoming/document.md"))
    await approve(consumerWaiting, "unit1")
    const resumed = await f.service.resume(consumerWaiting.id, consumerWaiting.version)
    expect(resumed.status).toBe("unknown")
    expect(resumed.units[1].reason).toBe("COMPOSITION_INPUTS_CHANGED")
    expect(f.executeSkill).toHaveBeenCalledTimes(3)
    expect(existsSync(join(consumerRoot, "incoming/document.md"))).toBe(false)
  })
  it("keeps a legacy parent binding intact while host flows use separate owned state roots", async () => {
    const f = fixture({ legacyParent: true })
    writeFileSync(join(f.workspace, "parent-only.txt"), "Existing project content")
    const started = await f.service.startBackground(f.definition, "request")
    expect(started.status).toBe("running")
    const run = await f.service.waitForSettlement(started.id)
    expect(run.status).toBe("succeeded")
    const roots = run.units.map((unit) => f.host.get(unit.proof!.engineRunId)!.workspace)
    expect(new Set(roots).size).toBe(2)
    expect(roots.every((root) => root !== f.workspace)).toBe(true)
    expect(roots.every((root) => !existsSync(join(root, "parent-only.txt")))).toBe(true)
    expect(existsSync(join(f.workspace, "document.md"))).toBe(false)
    expect(readFileSync(join(f.workspace, "parent-only.txt"), "utf8")).toBe(
      "Existing project content"
    )
  })
  it("executes two complete original routes with passed checks, transitions and artifact handoff", async () => {
    const f = fixture()
    const run = await f.service.start(f.definition, "request")
    expect(run.status).toBe("succeeded")
    expect(f.executeSkill).toHaveBeenCalledTimes(4)
    expect(f.beforeStart).toHaveBeenCalledTimes(4)
    const second = f.executeSkill.mock.calls[2][0]
    expect(second.goal).toContain("prior-document")
    expect(f.inputCopies[2]).toBe("documents-review")
    for (const unit of run.units) {
      expect(unit.proof?.kind).toBe("flow-completed")
      expect(f.host.get(unit.proof!.engineRunId)?.status).toBe("completed")
      expect(
        f.host
          .operations(unit.proof!.engineRunId)
          .every((operation) => operation.status === "transitioned")
      ).toBe(true)
      expect(f.service.parentForHostUnit(unit.proof!.engineRunId)).toBe("visible-parent")
    }
    expect(f.service.parentForHostUnit("composition:forged:unit0")).toBeUndefined()
  })
  it("rejects a consumer's changed input copy while the producer proof remains unchanged", async () => {
    const f = fixture({ mappedInput: "incoming/document.md" })
    const original = f.executeSkill.getMockImplementation()!
    f.executeSkill.mockImplementation(async (context) => {
      const outcome = await original(context)
      if (context.project.packageId === "analytics") {
        expect(context.assertInputsCurrent).toBeTypeOf("function")
        writeFileSync(join(context.project.workspace, "incoming/document.md"), "changed consumer copy")
        expect(() => context.assertInputsCurrent!()).toThrow("COMPOSITION_INPUTS_CHANGED")
      }
      return outcome
    })
    const run = await f.service.start(f.definition, "mutated-consumer")
    expect(run.status).not.toBe("succeeded")
    expect(f.executeSkill).toHaveBeenCalledTimes(3)
    const producer = f.host.get(run.units[0].proof!.engineRunId)!
    expect(readFileSync(join(producer.workspace, "document.md"), "utf8")).toBe("documents-review")
    expect(run.units[1].proof).toBeUndefined()
  })
  it("stops at original approval, preserves fingerprint and resumes only after real approval", async () => {
    const f = fixture({ approval: true })
    const run = await f.service.start(f.definition, "request")
    expect(run.status).toBe("waiting-approval")
    expect(f.executeSkill).toHaveBeenCalledTimes(1)
    const operation = f.service.waitingOperation(run.id, "unit0")!
    await expect(
      f.service.approve(run.id, "unit0", operation.operationId, {
        expectedVersion: operation.expectedVersion,
        inputFingerprint: "f".repeat(64),
        decision: "approved",
        actorId: "user"
      })
    ).rejects.toThrow()
    await f.service.approve(run.id, "unit0", operation.operationId, {
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "user"
    })
    const next = await f.service.resume(run.id, run.version)
    expect(next.status).toBe("waiting-approval")
    expect(next.units[0].status).toBe("succeeded")
    expect(f.executeSkill).toHaveBeenCalledTimes(3)
  })
  it("never accepts agent success without original checked artifacts or original terminal evidence", async () => {
    const failed = fixture({ failCheck: true })
    expect((await failed.service.start(failed.definition, "request")).status).toBe("failed")
    expect(failed.executeSkill).toHaveBeenCalledTimes(1)
    const missing = fixture({ missingTerminal: true })
    expect((await missing.service.start(missing.definition, "request")).status).toBe("unknown")
    expect(missing.executeSkill).toHaveBeenCalledTimes(2)
  })
  it("holds the shared workspace guard through approval and allows only the admitted owner", async () => {
    const f = fixture({ approval: true })
    const run = await f.service.start(f.definition, "request")
    expect(() => f.service.guardWorkspaceMutation(f.workspace, () => "other engine")).toThrow(
      "WORKSPACE_BUSY"
    )
    expect(
      f.service.store.withWorkspaceOwner(run.id, () =>
        f.service.guardWorkspaceMutation(f.workspace, () => "owned")
      )
    ).toBe("owned")
    expect((await f.service.cancel(run.id)).status).toBe("cancelled")
    expect(f.service.guardWorkspaceMutation(f.workspace, () => "released")).toBe("released")
  })
  it("allows parent-authorized cancellation after a source is disabled", async () => {
    const f = fixture({ approval: true })
    const run = await f.service.start(f.definition, "request")
    f.sourceState.revoked = true
    expect((await f.service.cancel(run.id)).status).toBe("cancelled")
    expect(f.executeSkill).toHaveBeenCalledTimes(1)
  })
})

it("copies verified outputs to the destination capability's declared input path", async () => {
  const f = fixture({ mappedInput: "incoming/previous.md" })
  const run = await f.service.start(f.definition, "mapped-input")
  expect(run.status).toBe("succeeded")
  const workspace = f.service.store.unitWorkspace(run.id, "unit1")!
  expect(readFileSync(join(workspace, "incoming/previous.md"), "utf8")).toBe("documents-review")
})

it("resolves only the current internal engine thread from authoritative operation records", async () => {
  const f = fixture()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  f.executeSkill.mockImplementationOnce(async (context) => {
    context.bindThread("actual-internal-thread")
    await waiting
    context.recordTerminal({ outcome: "cancelled", code: "fixture-stop" })
    return "succeeded" as const
  })
  const run = await f.service.startBackground(f.definition, "thread-discovery")
  await vi.waitFor(() =>
    expect(f.service.executionThreadIds(run.id, "unit0")).toEqual(["actual-internal-thread"])
  )
  expect(f.service.executionThreadIds(run.id, "unit1")).toEqual([])
  expect(f.service.executionThreadIds("foreign", "unit0")).toEqual([])
  release()
  await f.service.waitForSettlement(run.id)
  expect(f.service.executionThreadIds(run.id, "unit0")).toEqual([])
})
