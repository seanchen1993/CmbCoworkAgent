import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ProjectCompositionDefinition } from "../../../shared/project-runtime/composition"
import { ProjectCompositionStore } from "./composition-store"
import {
  ProjectCompositionCoordinator,
  type CompositionCoordinatorDependencies,
  type CompositionExecutionContext,
  type CompositionEngineResult
} from "./composition-coordinator"

const roots: string[] = []
const stores: ProjectCompositionStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function complete(context: CompositionExecutionContext): CompositionEngineResult {
  return {
    status: "completed",
    proof: {
      kind: context.unit.kind === "flow" ? "flow-completed" : "capability-completed",
      engineRunId: context.engineRunId ?? `engine-${context.unit.id}`,
      evidenceDigest: "b".repeat(64),
      artifacts: context.unit.outputs.map((output) => ({ ...output, digest: "c".repeat(64) }))
    }
  }
}
function fixture(overrides: Partial<CompositionCoordinatorDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), "composition-coordinator-"))
  roots.push(root)
  const path = join(root, "composition.sqlite")
  const store = new ProjectCompositionStore(path)
  stores.push(store)
  const definition: ProjectCompositionDefinition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "project",
    workspace: root,
    units: [
      {
        id: "first",
        kind: "flow",
        source: { pluginId: "docs", capabilityId: "draft", packageDigest: "a".repeat(64) },
        inputs: [],
        outputs: [{ id: "result", path: "report.json" }]
      },
      {
        id: "second",
        kind: "flow",
        source: { pluginId: "data", capabilityId: "analyze", packageDigest: "d".repeat(64) },
        inputs: [{ inputId: "document", fromUnitId: "first", artifactId: "result" }],
        outputs: []
      }
    ]
  }
  const deps: CompositionCoordinatorDependencies = {
    authorize: vi.fn(async () => {}),
    verifyInputs: vi.fn(async () => true),
    verifyCompletion: vi.fn(async () => true),
    execute: vi.fn(async (context) => complete(context)),
    resume: vi.fn(async (context) => complete(context)),
    cancel: vi.fn(async () => ({ status: "cancelled" as const })),
    ...overrides
  }
  return {
    root,
    path,
    store,
    definition,
    deps,
    coordinator: new ProjectCompositionCoordinator(store, deps)
  }
}

describe("durable project composition orchestration", () => {
  it("persists native unit context with pending CAS and freezes it into the actual engine context", async () => {
    const f = fixture()
    const prepared = await f.coordinator.prepare(f.definition, "context-configuration")
    const selection = { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "e".repeat(64) }
    const updated = f.store.saveUnitContext(prepared.id, prepared.version, "first", selection)
    expect(updated.version).toBe(prepared.version + 1)
    expect(updated.definitionDigest).toBe(prepared.definitionDigest)
    expect(updated.configurationPending).toBe(true)
    expect(f.deps.execute).not.toHaveBeenCalled()
    expect(() => f.store.saveUnitContext(prepared.id, prepared.version, "second", selection))
      .toThrow("COMPOSITION_VERSION_CONFLICT")
    expect(() => f.store.saveUnitContext(prepared.id, updated.version, "other-unit", selection))
      .toThrow("COMPOSITION_CONFIGURATION_CHANGED")
    const reopened = new ProjectCompositionStore(f.path)
    try { expect(reopened.get(prepared.id)?.unitContexts?.first).toEqual(selection) }
    finally { reopened.close() }
    await expect(f.coordinator.startPrepared(prepared.id, prepared.version)).rejects.toThrow("VERSION_CONFLICT")
    expect(f.deps.execute).not.toHaveBeenCalled()
    await f.coordinator.startPrepared(prepared.id, updated.version)
    await f.coordinator.waitForSettlement(prepared.id)
    expect(f.deps.execute).toHaveBeenCalledWith(expect.objectContaining({
      contextSelection: selection, unit: expect.objectContaining({ id: "first" })
    }), expect.any(AbortSignal))
    expect(() => f.store.saveUnitContext(prepared.id, f.store.get(prepared.id)!.version, "first", selection))
      .toThrow("COMPOSITION_CONFIGURATION_CHANGED")
  })
  it("persists native configuration preparation without claiming or invoking an engine", async () => {
    const f = fixture()
    const prepared = await f.coordinator.prepare(f.definition, "native-configuration")
    expect(prepared.configurationPending).toBe(true)
    expect(prepared.units.every(unit => unit.status === "pending" && !unit.attemptId)).toBe(true)
    expect(f.deps.execute).not.toHaveBeenCalled()
    expect(() => f.store.guardWorkspaceMutation(f.root, () => undefined)).toThrow(
      "当前组合等待配置，请先完成参数与授权，或取消本次组合后继续会话")
    expect(() => f.store.claim(prepared.id, prepared.version)).toThrow("COMPOSITION_CONFIGURATION_REQUIRED")
    await expect(f.coordinator.resumeBackground(prepared.id, prepared.version)).rejects.toThrow("COMPOSITION_CONFIGURATION_REQUIRED")
    await expect(f.coordinator.resume(prepared.id, prepared.version)).rejects.toThrow("COMPOSITION_CONFIGURATION_REQUIRED")
    expect((await f.coordinator.startBackground(f.definition, "native-configuration")).configurationPending).toBe(true)
    expect((await f.coordinator.prepare(f.definition, "native-configuration")).id).toBe(prepared.id)
    expect(f.store.recoverInterruptedRuns()).toEqual([])
    const reopened = new ProjectCompositionStore(f.path)
    stores.push(reopened)
    expect(reopened.get(prepared.id)?.configurationPending).toBe(true)
    expect(f.deps.execute).not.toHaveBeenCalled()
    const reject = vi.fn(() => { throw Error("NATIVE_CONFIGURATION_CHANGED") })
    await expect(f.coordinator.startPrepared(prepared.id, prepared.version, reject)).rejects.toThrow("NATIVE_CONFIGURATION_CHANGED")
    expect(f.store.get(prepared.id)?.configurationPending).toBe(true)
    await expect(f.coordinator.startPrepared(prepared.id, prepared.version + 1)).rejects.toThrow("VERSION_CONFLICT")
    const started = await f.coordinator.startPrepared(prepared.id, prepared.version)
    expect(started.configurationPending).toBe(false)
    expect((await f.coordinator.waitForSettlement(prepared.id)).status).toBe("succeeded")
    expect(f.deps.execute).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.deps.verifyInputs).mock.calls.map(([, phase]) => phase))
      .toEqual(["before-prepare", "before-prepare"])
    await expect(f.coordinator.startPrepared(prepared.id, started.version)).rejects.toThrow("VERSION_CONFLICT")
    expect(f.deps.execute).toHaveBeenCalledTimes(2)
  })
  it("cancels native configuration preparation without inventing an engine or an uncertain result", async () => {
    const f = fixture()
    const prepared = await f.coordinator.prepare(f.definition, "cancel-configuration")
    const cancelled = await f.coordinator.cancel(prepared.id)
    expect(cancelled).toMatchObject({ status: "cancelled", configurationPending: false })
    expect(f.deps.cancel).not.toHaveBeenCalled()
    expect(f.deps.execute).not.toHaveBeenCalled()
    expect(() => f.store.create(f.definition, "next")).not.toThrow()
  })
  it("runs different plugin flows serially with exact artifact provenance and idempotent admission", async () => {
    const f = fixture()
    const run = await f.coordinator.start(f.definition, "request")
    expect(run.status).toBe("succeeded")
    expect(f.deps.execute).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.deps.execute).mock.calls[1][0].inputs).toEqual([
      {
        inputId: "document",
        fromUnitId: "first",
        source: f.definition.units[0].source,
        artifact: { id: "result", path: "report.json", digest: "c".repeat(64) }
      }
    ])
    expect((await f.coordinator.start(f.definition, "request")).id).toBe(run.id)
    expect(f.deps.execute).toHaveBeenCalledTimes(2)
    expect((await f.coordinator.start(f.definition, "next")).status).toBe("succeeded")
  })
  it.each(["failed", "unknown", "cancelled"] as const)(
    "%s prevents subsequent flow admission",
    async (status) => {
      const f = fixture({ execute: vi.fn(async () => ({ status })) })
      const run = await f.coordinator.start(f.definition, "request")
      expect(run.status).toBe(status)
      expect(run.units[1].status).toBe("pending")
      expect(f.deps.execute).toHaveBeenCalledTimes(1)
      if (status === "unknown")
        expect(() => f.store.create(f.definition, "other")).toThrow("WORKSPACE_BUSY")
    }
  )
  it("does not treat agent success or unverifiable complete proof as a flow terminal", async () => {
    const f = fixture({ execute: vi.fn(async () => ({ status: "success" }) as never) })
    expect((await f.coordinator.start(f.definition, "request")).status).toBe("unknown")
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
    const unverified = fixture({ verifyCompletion: vi.fn(async () => false) })
    expect((await unverified.coordinator.start(unverified.definition, "request")).status).toBe(
      "unknown"
    )
    expect(unverified.deps.execute).toHaveBeenCalledTimes(1)
  })
  it("persists approval pause and requires explicit CAS resume through the original engine", async () => {
    const f = fixture({
      execute: vi.fn(async (context) =>
        context.unit.id === "first"
          ? { status: "waiting-approval" as const, engineRunId: "original" }
          : complete(context)
      )
    })
    const waiting = await f.coordinator.start(f.definition, "request")
    expect(waiting.status).toBe("waiting-approval")
    expect((await f.coordinator.start(f.definition, "request")).status).toBe("waiting-approval")
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
    await expect(f.coordinator.resume(waiting.id, waiting.version - 1)).rejects.toThrow(
      "VERSION_CONFLICT"
    )
    const resumed = await f.coordinator.resume(waiting.id, waiting.version)
    expect(resumed.status).toBe("succeeded")
    expect(vi.mocked(f.deps.resume).mock.calls[0][0].engineRunId).toBe("original")
    expect(vi.mocked(f.deps.verifyInputs).mock.calls.map(([, phase]) => phase))
      .toEqual(["before-prepare", "prepared", "before-prepare"])
  })
  it("uses strict prepared verification for uncertain-engine reconciliation", async () => {
    const f = fixture({
      execute: vi.fn(async () => ({ status: "unknown" as const, engineRunId: "original" })),
      reconcile: vi.fn(async context => complete(context)),
      verifyInputs: vi.fn(async (_context, phase) => phase !== "prepared")
    })
    const uncertain = await f.coordinator.start(f.definition, "reconcile-inputs")
    expect(uncertain.status).toBe("unknown")
    const resumed = await f.coordinator.resume(uncertain.id, uncertain.version)
    expect(resumed.status).toBe("unknown")
    expect(resumed.units[0].reason).toBe("COMPOSITION_INPUTS_CHANGED")
    expect(f.deps.reconcile).not.toHaveBeenCalled()
    expect(vi.mocked(f.deps.verifyInputs).mock.calls.map(([, phase]) => phase))
      .toEqual(["before-prepare", "prepared"])
  })
  it("retains unknown recovery leases and never automatically repeats external effects", () => {
    const f = fixture()
    const initial = f.store.create(f.definition, "request").run
    f.store.claim(initial.id, initial.version)
    const second = new ProjectCompositionStore(f.path)
    stores.push(second)
    expect(second.recoverInterruptedRuns()[0].status).toBe("unknown")
    expect(second.create(f.definition, "request").created).toBe(false)
    expect(() => second.create(f.definition, "another")).toThrow("WORKSPACE_BUSY")
    expect(() => second.create({ ...f.definition, parentProjectId: "other" }, "another")).toThrow(
      "WORKSPACE_BUSY"
    )
  })
  it("rechecks source authorization and artifact content before every successor", async () => {
    const f = fixture({ verifyInputs: vi.fn(async (context) => context.unit.id !== "second") })
    const run = await f.coordinator.start(f.definition, "request")
    expect(run.status).toBe("failed")
    expect(run.units[1].reason).toContain("INPUTS_CHANGED")
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.deps.authorize).mock.calls.some(([, unit]) => unit?.id === "second")).toBe(
      true
    )
  })
  it("cancels an approval pause via the real adapter and blocks successors", async () => {
    const f = fixture({
      execute: vi.fn(async () => ({ status: "waiting-approval" as const, engineRunId: "original" }))
    })
    const run = await f.coordinator.start(f.definition, "request")
    const cancelled = await f.coordinator.cancel(run.id)
    expect(cancelled.status).toBe("cancelled")
    expect(f.deps.cancel).toHaveBeenCalledTimes(1)
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
  })
  it("uses database CAS and prevents altered payload reuse for an existing request", () => {
    const f = fixture()
    const run = f.store.create(f.definition, "request").run
    f.store.claim(run.id, run.version)
    expect(() => f.store.claim(run.id, run.version)).toThrow("VERSION_CONFLICT")
    expect(() =>
      f.store.create({ ...f.definition, units: f.definition.units.slice(0, 1) }, "request")
    ).toThrow("IDEMPOTENCY_CONFLICT")
  })
  it("holds the lease if permission disappears while cancelling an already admitted engine", async () => {
    let denied = false
    const f = fixture({
      execute: vi.fn(async () => ({
        status: "waiting-approval" as const,
        engineRunId: "original"
      })),
      authorize: vi.fn(async (_definition, unit) => {
        if (denied && unit) throw Error("REVOKED")
      })
    })
    const waiting = await f.coordinator.start(f.definition, "request")
    denied = true
    const result = await f.coordinator.cancel(waiting.id)
    expect(result.status).toBe("unknown")
    expect(f.deps.cancel).not.toHaveBeenCalled()
    expect(() => f.store.create(f.definition, "other")).toThrow("WORKSPACE_BUSY")
  })
  it("propagates cancellation to an executing adapter without advancing to a second flow", async () => {
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish!: (result: CompositionEngineResult) => void
    let observedSignal: AbortSignal | undefined
    const f = fixture({
      execute: vi.fn(async (_context, signal) => {
        observedSignal = signal
        started()
        return new Promise<CompositionEngineResult>((resolve) => {
          finish = resolve
        })
      })
    })
    const pending = f.coordinator.start(f.definition, "request")
    await entered
    const run = f.store.create(f.definition, "request").run
    expect((await f.coordinator.cancel(run.id)).status).toBe("cancelled")
    expect(observedSignal?.aborted).toBe(true)
    finish({ status: "cancelled" })
    expect((await pending).status).toBe("cancelled")
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
  })
  it("rejects approval resume proof from a different original engine", async () => {
    const f = fixture({
      execute: vi.fn(async () => ({
        status: "waiting-approval" as const,
        engineRunId: "original"
      })),
      resume: vi.fn(async (context) => complete({ ...context, engineRunId: "different" }))
    })
    const waiting = await f.coordinator.start(f.definition, "request")
    expect((await f.coordinator.resume(waiting.id, waiting.version)).status).toBe("unknown")
    expect(f.deps.execute).toHaveBeenCalledTimes(1)
  })
})
