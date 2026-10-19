import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  AUTOBIZ_CONTEXT_OUTPUT,
  AUTOBIZ_CONTEXT_MAX_BYTES,
  SOURCE_HANDOFF_DECLARATION
} from "../../../shared/project-runtime/autobiz-handoff"
import type { CompositionExecutionContext } from "./composition-coordinator"
import {
  observeLegacyCompositionCompletion,
  proveLegacyCompositionCompletion
} from "./composition-legacy-proof"
import {
  assertAutobizHandoffDeclaration,
  encodeAutobizHandoff,
  materializeAutobizHandoff
} from "./composition-autobiz-handoff"
import { runtimeDigest } from "./safe-files"
import {
  CompositionLegacyAdapter,
  type CompositionLegacyDependencies
} from "./composition-legacy-adapter"
import type {
  CompositionInternalProject,
  CompositionInternalProjects
} from "./composition-internal-projects"
import { captureSourceHandoffBaseline } from "./composition-source-handoff"
import { FunctionModsManager } from "../../mods/v2/manager"
import { ModControlStore } from "../../mods/control-store"
import { captureProjectActionInputs, createProjectActionBinding } from "./action-input"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "autobiz-handoff-"))
  roots.push(workspace)
  const prefix = ".autobizdevops/features/feature/"
  mkdirSync(join(workspace, prefix), { recursive: true })
  const path = prefix + "PRD.md",
    inputPath = prefix + "PLAN.md"
  writeFileSync(join(workspace, path), "# Actual producer result\nUNIQUE_OUTPUT_BYTES")
  writeFileSync(join(workspace, inputPath), "VALIDATED_INPUT_IS_NOT_AN_OUTPUT")
  writeFileSync(join(workspace, "unrelated.md"), "NEVER_SCAN_THE_WORKSPACE")
  const context: CompositionExecutionContext = {
    runId: "composition",
    parentProjectId: "parent",
    workspace,
    executionWorkspace: workspace,
    attemptId: "attempt",
    idempotencyKey: "unit",
    inputs: [],
    unit: {
      id: "producer",
      kind: "flow",
      source: { pluginId: "pinned", capabilityId: "project-flow", packageDigest: "a".repeat(64) },
      inputs: [],
      outputs: [{ ...AUTOBIZ_CONTEXT_OUTPUT }]
    }
  }
  const contracts = [
    {
      nodeId: "biz.prd",
      checkId: "postcheck",
      contractDigest: "b".repeat(64),
      artifacts: [{ id: "prd", path }]
    },
    {
      nodeId: "dev.code",
      checkId: "postcheck",
      contractDigest: "c".repeat(64),
      artifacts: [{ id: "plan", path: inputPath }]
    }
  ]
  const input: Parameters<typeof observeLegacyCompositionCompletion>[1] = {
    projectId: "internal",
    featureId: "feature",
    journalHealthy: true,
    managed: {
      projectId: "internal",
      featureId: "feature",
      runId: "managed",
      status: "completed"
    } as never,
    events: [{ runId: "managed", type: "run_completed", eventId: "completed" }] as never,
    detail: {
      project: { projectId: "internal", projectRootPath: workspace },
      adapterSnapshot: { mock: false },
      workflow: {
        nodes: [
          {
            id: "biz.prd",
            hookDefinitions: [],
            artifactDefinitions: [{ id: "prd", required: true }]
          },
          { id: "dev.code", hookDefinitions: [], artifactDefinitions: [] }
        ]
      },
      run: {
        slug: "feature",
        featureStatus: "archived",
        currentNodeId: "dev.code",
        nodes: [
          {
            id: "biz.prd",
            nodeStatus: "done",
            hooks: [],
            artifacts: [{ id: "prd", path, required: true }]
          },
          { id: "dev.code", nodeStatus: "done", hooks: [], artifacts: [] }
        ]
      }
    } as never,
    stageChecks: {
      contracts,
      receipts: contracts.map((contract) => ({
        runId: context.runId,
        unitId: context.unit.id,
        engineRunId: "managed",
        packageDigest: context.unit.source.packageDigest,
        threadId: "original-child",
        incarnationKey: "incarnation",
        hookId: "host:project_checkpoint",
        receipt: {
          apiVersion: "devclaw.stage-check/v1",
          nodeId: contract.nodeId,
          checkId: contract.checkId,
          contractDigest: contract.contractDigest,
          outcome: "passed",
          artifacts: contract.artifacts.map((artifact) => ({
            ...artifact,
            digest: runtimeDigest(readFileSync(join(workspace, artifact.path)))
          }))
        }
      }))
    }
  }
  return { context, input, path, inputPath, workspace }
}

it("exports actual original outputs and latest checked bytes with exact provenance, never validated-only inputs", async () => {
  const f = fixture()
  const observed = await observeLegacyCompositionCompletion(f.context, f.input, true)
  expect(observed.files).toHaveLength(1)
  expect(observed.files[0]).toMatchObject({
    id: "prd",
    path: f.path,
    outputNodeId: "biz.prd",
    checkedBy: { nodeId: "biz.prd", checkId: "postcheck", contractDigest: "b".repeat(64) },
    content: expect.stringContaining("UNIQUE_OUTPUT_BYTES")
  })
  const first = encodeAutobizHandoff(f.context, f.input, observed.proof, observed.files)
  expect(first.toString()).not.toMatch(/VALIDATED_INPUT_IS_NOT_AN_OUTPUT|NEVER_SCAN_THE_WORKSPACE/)
  expect(JSON.parse(first.toString()).producer).toMatchObject({
    compositionRunId: "composition",
    unitId: "producer",
    engineRunId: "managed",
    source: f.context.unit.source
  })
  expect(first).toEqual(encodeAutobizHandoff(f.context, f.input, observed.proof, observed.files))
  const latest = structuredClone(f.input.stageChecks!.receipts[0])
  latest.receipt.nodeId = "dev.code"
  latest.receipt.contractDigest = "c".repeat(64)
  f.input.stageChecks!.contracts[1].artifacts.push({ id: "prd", path: f.path })
  writeFileSync(join(f.workspace, f.path), "LATEST_VALIDATED_DOCUMENT")
  latest.receipt.artifacts[0].digest = runtimeDigest("LATEST_VALIDATED_DOCUMENT")
  f.input.stageChecks!.receipts.push(latest)
  const updated = await observeLegacyCompositionCompletion(f.context, f.input, true)
  expect(updated.files[0]).toMatchObject({
    outputNodeId: "biz.prd",
    checkedBy: { nodeId: "dev.code" },
    content: "LATEST_VALIDATED_DOCUMENT"
  })
})

it("requires complete original terminal proof, frozen receipts and unchanged output bytes", async () => {
  const f = fixture()
  f.input.managed.status = "running"
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow(
    "NOT_COMPLETED"
  )
  f.input.managed.status = "completed"
  f.input.stageChecks!.receipts[0].packageDigest = "d".repeat(64)
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow(
    "RECEIPT_SCOPE_CHANGED"
  )
  f.input.stageChecks!.receipts[0].packageDigest = f.context.unit.source.packageDigest
  writeFileSync(join(f.workspace, f.path), "unverified edit")
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow(
    "REQUIRED_CHECK_UNPROVEN"
  )
})

it("selects explicit checked JSON outputs without silently exporting binary or validated inputs", async () => {
  const f = fixture()
  const binaryPath = ".autobizdevops/features/feature/database.sqlite3"
  writeFileSync(join(f.workspace, binaryPath), Buffer.from([0, 255, 0, 1]))
  f.input.detail.run.nodes[0].artifacts.push({ id: "database", path: binaryPath, required: true } as never)
  f.input.stageChecks!.contracts[0].artifacts.push({ id: "database", path: binaryPath })
  f.input.stageChecks!.receipts[0].receipt.artifacts.push({ id: "database", path: binaryPath,
    digest: runtimeDigest(readFileSync(join(f.workspace, binaryPath))) })
  const selected = await observeLegacyCompositionCompletion(f.context, f.input, true, ["prd"])
  expect(selected.files.map(file => file.id)).toEqual(["prd"])
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow("TEXT_REQUIRED")
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true, ["database"])).rejects.toThrow("TEXT_REQUIRED")
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true, ["plan"])).rejects.toThrow("UNDECLARED")
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true, ["prd", "prd"])).rejects.toThrow("SELECTION_INVALID")
  f.input.detail.run.nodes[1].artifacts.push({ ...f.input.detail.run.nodes[0].artifacts[0] })
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true, ["prd"])).rejects.toThrow("AMBIGUOUS")
})

it("passes original proven file bytes through an exact input binding into a real independent Guest consumer", async () => {
  const f = fixture()
  const json = JSON.stringify({ totalCents: 6200, businessAcceptance: "needs_review", marker: "真实数仓结果" })
  writeFileSync(join(f.workspace, f.path), json)
  f.input.stageChecks!.receipts[0].receipt.artifacts[0].digest = runtimeDigest(json)
  const observed = await observeLegacyCompositionCompletion(f.context, f.input, true, ["prd"])
  const bytes = encodeAutobizHandoff(f.context, f.input, observed.proof, observed.files)
  materializeAutobizHandoff(f.workspace, bytes, true)
  const store = new ModControlStore(join(f.workspace, "consumer.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(store, {
    plugins: () => [{ id: "consumer-source", name: "verified-artifact-consumer",
      path: resolve("examples/verified-artifact-consumer"), enabled: true }],
    enabled: () => true, clawApplicable: () => true, changed: () => {},
    publish: async (_workspace, value) => value
  }, () => {
    const owned: FunctionGuestRuntime[] = []
    return {
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        owned.push(guest)
        guests.push(guest)
        return guest
      },
      stop() { owned.forEach(guest => guest.dispose()) },
      async stopAndDrain() { owned.forEach(guest => guest.dispose()) }
    }
  })
  try {
    for (const source of await manager.status(f.workspace))
      await manager.approve(f.workspace, source.pluginId, source.digest!)
    const [action] = await manager.actionCatalog(f.workspace, "consumer-thread")
    expect(action.actionId).toBe("inspect")
    const binding = createProjectActionBinding("consume", action, { requiredIds: ["prd"] }, {},
      { kind: "artifact", artifactId: "document", pointer: "", format: "text" })
    const state: HostProjectState = {
      ...hostProjectFixture(f.workspace), schemaVersion: 1, stateOwner: "host", version: 2,
      stageIndex: 1, status: "active", createdAt: 1, updatedAt: 1
    }
    state.manifest.artifacts[0].path = AUTOBIZ_CONTEXT_OUTPUT.path
    state.manifest.actions = [{ id: binding.id, ref: binding.ref }]
    state.manifest.stages[1].actionIds = [binding.id]
    const capture = () => captureProjectActionInputs(state, {
      apiVersion: "devclaw.project-actions-lock/v1", bindings: [binding]
    })
    const captured = capture()
    expect(captured.bindings[0].input.content).toBe(bytes.toString())
    const signal = new AbortController().signal
    const prepared = await manager.prepareAction(f.workspace, "consumer-thread", action, signal)
    const consume = async (executionId: string) => {
      const current = capture()
      current.assertCurrent()
      return manager.runAction(f.workspace, "consumer-thread", prepared, {
        version: 1, input: current.bindings[0].input, config: {}, task: "Consume real bound documents",
        runId: "consumer-run", stepId: "consume", executionId
      }, signal)
    }
    expect(await consume("first")).toMatchObject({ passed: true, output: {
      bundleDigest: runtimeDigest(bytes), artifacts: [{ id: "prd", digest: runtimeDigest(json),
        value: { totalCents: 6200, businessAcceptance: "needs_review", marker: "真实数仓结果" } }]
    } })
    const altered = JSON.parse(bytes.toString())
    altered.files[0].content = '{"totalCents":9999}'
    writeFileSync(join(f.workspace, AUTOBIZ_CONTEXT_OUTPUT.path), JSON.stringify(altered))
    expect(() => captured.assertCurrent()).toThrow("INPUT_CHANGED")
    await expect(consume("altered")).rejects.toThrow()
    writeFileSync(join(f.workspace, AUTOBIZ_CONTEXT_OUTPUT.path), bytes)
    binding.input.requiredIds = ["missing"]
    await expect(consume("missing")).rejects.toThrow()
    binding.input.requiredIds = ["prd"]
    const duplicate = JSON.parse(bytes.toString())
    duplicate.files.push(duplicate.files[0])
    writeFileSync(join(f.workspace, AUTOBIZ_CONTEXT_OUTPUT.path), JSON.stringify(duplicate))
    await expect(consume("duplicate")).rejects.toThrow()
  } finally {
    manager.close()
    guests.forEach(guest => guest.dispose())
    await new Promise(done => setTimeout(done, 20))
    store.close()
  }
})

it("keeps old output-free definitions unchanged and never invents outputs without frozen evidence", async () => {
  const f = fixture()
  f.context.unit.outputs = []
  expect((await proveLegacyCompositionCompletion(f.context, f.input)).artifacts).toEqual([])
  f.input.stageChecks = undefined
  f.input.detail.run.nodes[0].artifacts[0].exists = true
  f.input.detail.run.nodes[0].artifacts[0].validation = { status: "valid" } as never
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow(
    "CONTRACT_REQUIRED"
  )
})

it("materializes one immutable deterministic file, supports read-only recovery, and rejects replacement/limits", async () => {
  const f = fixture(),
    observed = await observeLegacyCompositionCompletion(f.context, f.input, true)
  const bytes = encodeAutobizHandoff(f.context, f.input, observed.proof, observed.files)
  expect(() => materializeAutobizHandoff(f.workspace, bytes, false)).toThrow("EXPORT_CHANGED")
  expect(materializeAutobizHandoff(f.workspace, bytes, true)).toBe(runtimeDigest(bytes))
  expect(materializeAutobizHandoff(f.workspace, bytes, false)).toBe(runtimeDigest(bytes))
  expect(materializeAutobizHandoff(f.workspace, bytes, true)).toBe(runtimeDigest(bytes))
  writeFileSync(join(f.workspace, AUTOBIZ_CONTEXT_OUTPUT.path), "replaced")
  expect(() => materializeAutobizHandoff(f.workspace, bytes, true)).toThrow("EXPORT_CHANGED")
  expect(() =>
    encodeAutobizHandoff(f.context, f.input, observed.proof, [
      { ...observed.files[0], content: "x".repeat(AUTOBIZ_CONTEXT_MAX_BYTES) }
    ])
  ).toThrow("SIZE_LIMIT")
  expect(() => assertAutobizHandoffDeclaration(f.workspace)).toThrow("UNDECLARED")
})

it("rejects binary output instead of truncating or silently substituting model text", async () => {
  const f = fixture(),
    bytes = Buffer.from([0xff, 0, 0xfe])
  writeFileSync(join(f.workspace, f.path), bytes)
  f.input.stageChecks!.receipts[0].receipt.artifacts[0].digest = runtimeDigest(bytes)
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow(
    "TEXT_REQUIRED"
  )
})

it("preserves UTF-8 BOM bytes and refuses valid receipts outside the producer feature", async () => {
  const f = fixture(),
    bytes = Buffer.from("\ufeff# checked text")
  writeFileSync(join(f.workspace, f.path), bytes)
  f.input.stageChecks!.receipts[0].receipt.artifacts[0].digest = runtimeDigest(bytes)
  const observed = await observeLegacyCompositionCompletion(f.context, f.input, true)
  expect(runtimeDigest(Buffer.from(observed.files[0].content))).toBe(runtimeDigest(bytes))
  writeFileSync(join(f.workspace, "outside.md"), bytes)
  f.input.detail.run.nodes[0].artifacts[0].path = "outside.md"
  f.input.stageChecks!.contracts[0].artifacts[0].path = "outside.md"
  f.input.stageChecks!.receipts[0].receipt.artifacts[0].path = "outside.md"
  await expect(observeLegacyCompositionCompletion(f.context, f.input, true)).rejects.toThrow(
    "SCOPE_INVALID"
  )
})

it("reconciles completed original engines idempotently without replay and only verifies existing exports", async () => {
  const f = fixture(),
    source = join(f.workspace, "frozen-source")
  mkdirSync(source)
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify({
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: "pinned", version: "1.0.0" },
      mode: "legacy",
      stateOwner: "plugin",
      stages: [],
      actions: [],
      checks: [],
      environment: [],
      artifacts: [{ ...AUTOBIZ_CONTEXT_OUTPUT, required: true }],
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: true
      }
    })
  )
  writeFileSync(
    join(source, "devclaw.source-handoff.json"),
    JSON.stringify(SOURCE_HANDOFF_DECLARATION)
  )
  const baseline = await captureSourceHandoffBaseline(
    f.workspace,
    f.context.unit.source.packageDigest,
    { ...SOURCE_HANDOFF_DECLARATION, scopes: [...SOURCE_HANDOFF_DECLARATION.scopes] }
  )
  mkdirSync(join(f.workspace, "src"))
  writeFileSync(join(f.workspace, "src/actual.ts"), "export const actual = 1")
  const record = {
    projectId: "internal",
    featureId: "feature",
    phase: "running",
    engineRunId: "managed",
    workspace: f.workspace,
    packageDigest: f.context.unit.source.packageDigest,
    plugin: { path: source }
  } as CompositionInternalProject
  const projects = {
    get: () => record,
    prepare: vi.fn(async () => {})
  } as unknown as CompositionInternalProjects
  const deps = {
    sourceBaseline: () => baseline,
    authorize: vi.fn(async () => {}),
    observe: async () => f.input,
    readStatus: () => ({ runId: "managed", status: "completed" }),
    initialize: vi.fn(),
    createFeature: vi.fn(),
    start: vi.fn()
  } as unknown as CompositionLegacyDependencies
  const adapter = new CompositionLegacyAdapter(projects, deps)
  const first = await adapter.reconcile(f.context, new AbortController().signal)
  expect(first.status).toBe("completed")
  if (first.status !== "completed") throw Error("Expected original completion")
  expect(await adapter.verifyCompletion(f.context, first.proof)).toBe(true)
  const packed = JSON.parse(readFileSync(join(f.workspace, AUTOBIZ_CONTEXT_OUTPUT.path), "utf8"))
  expect(packed.sourceChanges.changes).toEqual([
    {
      path: "src/actual.ts",
      change: "added",
      digest: runtimeDigest("export const actual = 1"),
      content: "export const actual = 1"
    }
  ])
  const recovered = await new CompositionLegacyAdapter(projects, deps).reconcile(
    f.context,
    new AbortController().signal
  )
  expect(recovered).toEqual(first)
  expect(deps.initialize).not.toHaveBeenCalled()
  expect(deps.createFeature).not.toHaveBeenCalled()
  expect(deps.start).not.toHaveBeenCalled()
  rmSync(join(f.workspace, AUTOBIZ_CONTEXT_OUTPUT.path))
  await expect(adapter.verifyCompletion(f.context, first.proof)).rejects.toThrow("EXPORT_CHANGED")
})
