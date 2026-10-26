import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type {
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import type { FlowRun } from "../../../shared/mods/flows/types"
import {
  PROJECT_ACTION_LOCK_PATH,
  parseProjectActionLock
} from "../../../shared/project-runtime/action-bindings"
import { PROJECT_ARTIFACT_REFERENCE_PROTOCOL } from "../../../shared/project-runtime/artifact-reference"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  assertProjectActionLock,
  captureProjectActionInputs,
  createProjectActionBinding
} from "./action-input"
import { createProjectActionFlow } from "./action-flow"
import { readHostActionCheckEvidence } from "./action-check-evidence"
import { runtimeDigest } from "./safe-files"
import {
  assertHostReceiptsCurrent,
  fingerprintHostStageInput,
  validateHostStage
} from "./host-validators"
import { HostProjectStore } from "./host-store"
import { hostResultReview } from "./host-state-protocol"
import { setProjectActionRuntime } from "../project-action-runtime"
import {
  attachFlowActionExecutionFacts,
  bindFlowActionExecutionFacts,
  captureNativeFlowActionFacts,
  readFlowActionExecutionFacts,
  requiresNativeFlowActionFacts
} from "../../mods/flows/action-execution-facts"
import { validateRegisteredToolInput } from "../../mods/v2/tool-schema"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const provider: ClawActionDescriptor = {
  pluginId: "approved-rules",
  plugin: "rules",
  digest: "e".repeat(64),
  actionId: "check",
  name: "Read-only check",
  platform: { id: "business-checks", version: "1.0.0", action: "check" },
  inputSchema: {
    type: "object",
    required: ["protocol", "current", "sources"],
    properties: { protocol: { const: PROJECT_ARTIFACT_REFERENCE_PROTOCOL } }
  },
  outputSchema: { type: "object" }
}
function fixture(text = "中".repeat(30_000), limit = 512 * 1024) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-artifact-reference-")))
  roots.push(root)
  const project: HostProjectState = {
    ...hostProjectFixture(root),
    schemaVersion: 1,
    stateOwner: "host",
    version: 2,
    stageIndex: 1,
    status: "active",
    createdAt: 1,
    updatedAt: 1
  }
  project.manifest.artifacts = [
    { id: "prior", path: "prior.json", required: true },
    { id: "result", path: "result.json", required: true }
  ]
  project.manifest.stages[0].artifactIds = ["prior"]
  project.manifest.stages[1].artifactIds = ["result"]
  project.manifest.stages[1].checkIds = ["shape", "business"]
  project.manifest.stages[1].approval = "none"
  project.manifest.checks = [
    {
      id: "shape",
      kind: "json-schema",
      artifactId: "result",
      sideEffect: "read",
      schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } }
    },
    {
      id: "business",
      kind: "action",
      artifactId: "result",
      actionId: "business",
      sideEffect: "read"
    }
  ]
  const binding = createProjectActionBinding(
    "business",
    provider,
    {},
    {},
    {
      kind: "artifact",
      artifactId: "result",
      pointer: "",
      format: "artifact-reference-v1",
      maxBytes: limit
    }
  )
  const lock = { apiVersion: "devclaw.project-actions-lock/v1" as const, bindings: [binding] }
  project.manifest.actions = [{ id: binding.id, ref: binding.ref }]
  writeFileSync(join(root, "prior.json"), JSON.stringify({ text: "保留原输入\n😀" }))
  writeFileSync(join(root, "result.json"), JSON.stringify({ text }))
  writeFileSync(join(root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
  const phase = { actionIds: [binding.id], allowCheckArtifacts: true }
  const capture = () => captureProjectActionInputs(project, lock, phase)
  return { root, project, lock, binding, capture, phase }
}

function originalEvidence(f: ReturnType<typeof fixture>, originalTicket?: HostExecutionTicket) {
  const operationId = originalTicket?.operationId ?? "original-operation"
  const captured = f.capture()
  const definition = createProjectActionFlow(f.project, operationId, captured, "checks")
  const run: FlowRun = {
    id: "flow-original",
    threadId: "original-thread",
    workspace: f.root,
    status: "complete",
    startedAt: 1,
    epoch: 0,
    failureCounts: {},
    flow: {
      definition,
      revision: 1,
      digest: runtimeDigest(JSON.stringify(definition)),
      updatedAt: 1
    },
    attempts: [
      {
        executionId: "execution-original",
        stepId: "business",
        attempt: 1,
        epoch: 0,
        status: "running",
        startedAt: 1
      }
    ]
  }
  const result = {
    passed: true,
    summary: "original rule report",
    source: "plugin-action" as const,
    provider: f.binding.ref,
    output: { passed: true }
  }
  attachFlowActionExecutionFacts(
    run,
    "execution-original",
    bindFlowActionExecutionFacts(run, run.attempts[0], result)
  )
  run.attempts[0].status = "passed"
  run.attempts[0].result = result
  setProjectActionRuntime({
    catalog: async () => [provider],
    prepareSelection: async () => {},
    flows: { startSaved: vi.fn(), waitForSettlement: vi.fn(), run: vi.fn(), cancel: vi.fn() },
    readRuns: () => [run],
    readActionResult: (_w, _t, _r, executionId) => readFlowActionExecutionFacts(run, executionId)
  })
  const ticket: HostExecutionTicket = originalTicket ?? {
    operationId,
    projectId: f.project.projectId,
    expectedVersion: f.project.version,
    pluginDigest: f.project.pluginDigest,
    stageId: "review",
    inputFingerprint: captured.fingerprint
  }
  const operation = {
    ...ticket,
    execution: { threadId: run.threadId },
    status: "succeeded"
  } as HostProjectOperation
  const evidence = () => readHostActionCheckEvidence(f.project, ticket, operation, f.root)
  return { run, ticket, operation, evidence }
}

describe("Host-bound artifact references", () => {
  it("captures large original UTF-8 bytes and prior files without embedding their contents", () => {
    const f = fixture()
    expect(() => assertProjectActionLock(f.project.manifest, f.lock)).not.toThrow()
    const captured = f.capture()
    const input = captured.bindings[0].input
    const bytes = readFileSync(join(f.root, "result.json"))
    expect(input).toMatchObject({
      protocol: PROJECT_ARTIFACT_REFERENCE_PROTOCOL,
      projectId: f.project.projectId,
      current: {
        artifactId: "result",
        path: "result.json",
        bytes: bytes.length,
        sha256: runtimeDigest(bytes),
        maxBytes: 512 * 1024
      },
      sources: [{ artifactId: "prior", path: "prior.json" }]
    })
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(8192)
    expect(JSON.stringify(input)).not.toContain("中")
    expect(() => captured.assertCurrent()).not.toThrow()
    const rebuilt = f.capture()
    expect(rebuilt.fingerprint).toBe(captured.fingerprint)
    expect(createProjectActionFlow(f.project, "same-operation", rebuilt, "checks")).toEqual(
      createProjectActionFlow(f.project, "same-operation", captured, "checks")
    )
  })

  it.each(["prior.json", "result.json"])("rejects changed captured bytes in %s", (name) => {
    const f = fixture()
    const captured = f.capture()
    writeFileSync(join(f.root, name), '{"text":"changed"}')
    expect(() => captured.assertCurrent()).toThrow("INPUT_CHANGED")
  })

  it("keeps exact byte limits including non-BMP input and rejects a hard-linked artifact", () => {
    const text = '😀\\"\n'.repeat(600)
    const limit = Buffer.byteLength(JSON.stringify({ text }))
    const f = fixture(text, limit)
    expect(() => f.capture()).not.toThrow()
    writeFileSync(join(f.root, "result.json"), JSON.stringify({ text: text + "x" }))
    expect(() => f.capture()).toThrow("FILE_LIMIT")
    writeFileSync(join(f.root, "result.json"), JSON.stringify({ text }))
    linkSync(join(f.root, "result.json"), join(f.root, "second-link.json"))
    expect(() => f.capture()).toThrow("FILE_UNSAFE")
  })

  it("rejects unsigned paths, constants, non-read checks and execution actions", () => {
    const f = fixture()
    f.binding.input = { current: { path: "prior.json", sha256: "f".repeat(64) } }
    expect(() => f.capture()).toThrow("REFERENCE_CHECK_ONLY")
    f.binding.input = {}
    f.project.manifest.checks[1].sideEffect = "external"
    expect(() => f.capture()).toThrow("REFERENCE_CHECK_ONLY")
    f.project.manifest.checks[1].sideEffect = "read"
    f.project.manifest.stages[1].actionIds = ["business"]
    expect(() => assertProjectActionLock(f.project.manifest, f.lock)).toThrow(
      "REFERENCE_CHECK_ONLY"
    )
  })

  it.each([undefined, 0, -1, 524289, 1.5])("rejects an invalid declared budget %s", (maxBytes) => {
    const f = fixture()
    const raw = JSON.parse(JSON.stringify(f.lock))
    if (maxBytes === undefined) delete raw.bindings[0].inputFrom.maxBytes
    else raw.bindings[0].inputFrom.maxBytes = maxBytes
    expect(() => parseProjectActionLock(raw)).toThrow("SOURCE_INVALID")
  })

  it("keeps old json/text and command inputs from opting into the reference budget", () => {
    const f = fixture()
    const raw = JSON.parse(JSON.stringify(f.lock))
    raw.bindings[0].inputFrom.format = "json"
    expect(() => parseProjectActionLock(raw)).toThrow("SOURCE_INVALID")
    raw.bindings[0].inputFrom.format = "artifact-reference-v1"
    delete raw.bindings[0].platform
    raw.bindings[0].command = "check"
    expect(() => parseProjectActionLock(raw)).toThrow("SOURCE_INVALID")
  })

  it("rejects a reference envelope exceeding the unchanged platform budget", () => {
    const f = fixture()
    f.project.goal = "中".repeat(6000)
    const captured = f.capture()
    expect(() => createProjectActionFlow(f.project, "operation", captured, "checks")).toThrow(
      "REFERENCE_ENVELOPE_LIMIT"
    )
  })

  it("allows the larger shape profile only with the matching original Host check facts", () => {
    const f = fixture()
    const original = originalEvidence(f)
    const evidence = original.evidence()
    expect(
      validateHostStage(f.project, original.ticket, undefined, () => 1, evidence).map(
        (receipt) => receipt.result
      )
    ).toEqual(["passed", "passed"])
    expect(
      validateHostStage(f.project, original.ticket, undefined, () => 1, new Map(evidence))[0].result
    ).toBe("failed")
    expect(() =>
      validateRegisteredToolInput({ type: "object" }, { text: "x".repeat(64001) })
    ).toThrow("MODS_TOOL_INPUT_LIMIT")
    writeFileSync(join(f.root, "result.json"), JSON.stringify({ text: "different" }))
    expect(
      validateHostStage(f.project, original.ticket, undefined, () => 1, evidence)[0].result
    ).toBe("failed")
  })

  it("does not let a public passed Flow or cloned custody supply Host evidence", () => {
    const f = fixture()
    const original = originalEvidence(f)
    captureNativeFlowActionFacts(original.run.flow)
    expect(requiresNativeFlowActionFacts(structuredClone(original.run.flow))).toBe(false)
    delete (original.run.attempts[0] as unknown as Record<string, unknown>).__nativeActionFacts
    expect(() => original.evidence()).toThrow("NATIVE_FACTS_SCOPE_CHANGED")
  })

  it("rejects another project's genuine path/hash and a modified captured provider input", () => {
    const f = fixture()
    const original = originalEvidence(f)
    const other = fixture()
    f.project.workspace = other.root
    expect(() => original.evidence()).toThrow("NATIVE_FACTS_SCOPE_CHANGED")
    f.project.workspace = f.root
    const input = original.run.flow.definition.steps[0]
    if (input.kind !== "plugin-action") throw Error("test step")
    input.input = { ...input.input, projectId: "foreign-project" }
    original.run.flow.digest = runtimeDigest(JSON.stringify(original.run.flow.definition))
    expect(() => original.evidence()).toThrow("NATIVE_FACTS_SCOPE_CHANGED")
  })

  it("keeps large artifact receipts and result approval bound through the original store commit", () => {
    const f = fixture()
    f.project.manifest.stages = [f.project.manifest.stages[1]]
    f.project.manifest.stages[0].resultApproval = "human"
    f.project.manifest.artifacts = f.project.manifest.artifacts.filter(
      (item) => item.id === "result"
    )
    const {
      projectId,
      name,
      goal,
      workspace,
      installedPluginId,
      packageId,
      packageVersion,
      pluginDigest,
      manifest
    } = f.project
    const creation = {
      projectId,
      name,
      goal,
      workspace,
      installedPluginId,
      packageId,
      packageVersion,
      pluginDigest,
      manifest
    }
    const store = new HostProjectStore(join(f.root, "host.sqlite"))
    try {
      Object.assign(f.project, store.create(creation))
      const fingerprint = fingerprintHostStageInput(f.project, f.project.goal)
      const prepared = store.prepare({
        projectId: f.project.projectId,
        expectedVersion: 1,
        stageId: "review",
        idempotencyKey: "reference-check",
        inputFingerprint: fingerprint
      })
      const ticket = store.start(prepared.operationId, fingerprint)
      const original = originalEvidence(f, ticket)
      store.bindExecutionThread(ticket, original.run.threadId)
      store.recordExecutionTerminal(ticket, {
        outcome: "success",
        code: "project_actions_complete"
      })
      const evidence = original.evidence()
      const receipts = validateHostStage(f.project, ticket, undefined, () => Date.now(), evidence)
      const settled = store.recordResult(ticket, { outcome: "succeeded", receipts })
      assertHostReceiptsCurrent(f.project, settled, evidence)
      const review = hostResultReview(
        f.project,
        settled,
        runtimeDigest(readFileSync(join(f.root, "result.json")))
      )
      expect(() => store.transition(prepared.operationId, fingerprint, review)).toThrow(
        "RESULT_APPROVAL_REQUIRED"
      )
      store.decideResultApproval(prepared.operationId, {
        ...review,
        decision: "approved",
        actorId: "test-user"
      })
      const completed = store.transition(prepared.operationId, fingerprint, review)
      expect(completed.status).toBe("completed")
      expect(completed.version).toBe(2)
      expect(store.getOperation(prepared.operationId)?.receipts).toEqual(receipts)
      expect(JSON.stringify(receipts)).not.toContain("中")
    } finally {
      store.close()
    }
  })
})
