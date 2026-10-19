import * as scopedFiles from "./safe-files-async"
import { runtimeDigest } from "./safe-files"
import type { StageCheckReceipt } from "../../../shared/project-runtime/stage-check-receipt"
import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type {
  HarnessRunDetailViewModel,
  ManagedRunEvent,
  ManagedRunSnapshot
} from "../../../shared/harness-board-types"
import type { CompositionExecutionContext } from "./composition-coordinator"
import { proveLegacyCompositionCompletion } from "./composition-legacy-proof"
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "legacy-complete-proof-"))
  roots.push(workspace)
  mkdirSync(join(workspace, "reports"))
  writeFileSync(join(workspace, "reports/result.md"), "Original engine verified result")
  const context: CompositionExecutionContext = {
    runId: "composition",
    parentProjectId: "parent",
    workspace,
    executionWorkspace: workspace,
    attemptId: "attempt",
    idempotencyKey: "unit",
    inputs: [],
    unit: {
      id: "unit",
      kind: "flow",
      source: { pluginId: "original", capabilityId: "flow", packageDigest: "a".repeat(64) },
      inputs: [],
      outputs: [{ id: "report", path: "reports/result.md" }]
    }
  }
  const managed = {
    projectId: "internal",
    featureId: "feature",
    runId: "managed",
    status: "completed"
  } as ManagedRunSnapshot
  const events = [
    { type: "session_started", nodeId: "review", targetThreadId: "child" },
    { type: "human_gate_invoked", nodeId: "review", gateId: "gate" },
    { type: "human_gate_approved", nodeId: "review", gateId: "gate", decisionEventId: "4" },
    { type: "run_completed" },
    {
      type: "managed_run_decision",
      gateId: "gate",
      sourceEventId: "1",
      decisionActor: "user",
      decisionAction: "approve_human_gate",
      decisionChannel: "desktop"
    }
  ].map((event, index) => ({
    ...event,
    eventId: String(index),
    runId: "managed",
    createTime: "2026-10-14T00:00:00Z"
  })) as ManagedRunEvent[]
  const detail = {
    project: { projectId: "internal", projectRootPath: workspace },
    adapterSnapshot: { mock: false },
    workflow: {
      nodes: [
        {
          id: "review",
          hookDefinitions: [{ id: "check", required: true }],
          artifactDefinitions: [{ id: "report", required: true }]
        }
      ]
    },
    run: {
      slug: "feature",
      featureStatus: "done",
      currentNodeId: "review",
      nodes: [
        {
          id: "review",
          nodeStatus: "done",
          artifacts: [
            {
              id: "report",
              path: "reports/result.md",
              required: true,
              exists: true,
              validation: { status: "valid", message: "original validator" }
            }
          ],
          hooks: [
            {
              eventId: "check",
              eventStatus: "success",
              nodeId: "review",
              pluginId: "original",
              featureId: "feature",
              sessionId: "child",
              ts: "2026-10-14T00:00:00Z"
            }
          ]
        }
      ]
    }
  } as unknown as HarnessRunDetailViewModel
  return {
    context,
    input: {
      projectId: "internal",
      featureId: "feature",
      managed,
      events,
      detail,
      journalHealthy: true
    }
  }
}
it("requires original final node, complete check/approval evidence and fresh actual output bytes", async () => {
  const f = fixture()
  expect(await proveLegacyCompositionCompletion(f.context, f.input)).toMatchObject({
    kind: "flow-completed",
    engineRunId: "managed"
  })
  f.input.managed.status = "running"
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "NOT_COMPLETED"
  )
  f.input.managed.status = "completed"
  f.input.detail.run.nodes[0].artifacts[0].validation!.status = "unknown"
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "CHECK_UNPROVEN"
  )
})
it("rejects historical foreign hooks and synthetic approval success", async () => {
  const f = fixture()
  f.input.detail.run.nodes[0].hooks[0].sessionId = "prior-run-child"
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "HOOK_UNPROVEN"
  )
  f.input.detail.run.nodes[0].hooks[0].sessionId = "child"
  f.input.events[4].decisionActor = "controller"
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "APPROVAL_UNPROVEN"
  )
})
it("does not mistake agent/managed success or absent output for completion", async () => {
  const f = fixture()
  f.input.detail.run.currentNodeId = "earlier"
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "STAGES_INCOMPLETE"
  )
  f.input.detail.run.currentNodeId = "review"
  rmSync(join(f.context.workspace, "reports/result.md"))
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "ARTIFACT_UNPROVEN"
  )
})

it("validates bounded original directory artifacts while keeping handoff outputs exact files", async () => {
  const f = fixture()
  f.input.detail.run.nodes[0].artifacts[0].path = "reports"
  f.context.unit.outputs = []
  const first = await proveLegacyCompositionCompletion(f.context, f.input)
  writeFileSync(join(f.context.workspace, "reports/extra.md"), "changed directory")
  expect((await proveLegacyCompositionCompletion(f.context, f.input)).evidenceDigest).not.toBe(
    first.evidenceDigest
  )
})

it("uses original historical checks but requires latest receipt bytes for final artifacts", async () => {
  const f = fixture()
  f.input.detail.run.nodes[0].artifacts[0].validation = undefined
  const receipt: StageCheckReceipt = {
    apiVersion: "devclaw.stage-check/v1",
    nodeId: "review",
    checkId: "postcheck",
    contractDigest: "b".repeat(64),
    outcome: "passed",
    artifacts: [
      {
        id: "report",
        path: "reports/result.md",
        digest: runtimeDigest("Original engine verified result")
      }
    ]
  }
  const input = {
    ...f.input,
    stageChecks: {
      contracts: [
        {
          nodeId: "review",
          checkId: "postcheck",
          contractDigest: receipt.contractDigest,
          artifacts: [{ id: "report", path: "reports/result.md" }]
        }
      ],
      receipts: [
        {
          runId: "composition",
          unitId: "unit",
          engineRunId: "managed",
          packageDigest: "a".repeat(64),
          threadId: "child",
          incarnationKey: "incarnation",
          hookId: "check",
          receipt
        }
      ]
    }
  }
  expect((await proveLegacyCompositionCompletion(f.context, input)).kind).toBe("flow-completed")
  f.input.detail.run.nodes[0].hooks = []
  await expect(proveLegacyCompositionCompletion(f.context, input)).rejects.toThrow("HOOK_UNPROVEN")
  receipt.checkId = "check"
  input.stageChecks.contracts[0].checkId = "check"
  expect((await proveLegacyCompositionCompletion(f.context, input)).kind).toBe("flow-completed")
  writeFileSync(join(f.context.workspace, "reports/result.md"), "later unverified change")
  await expect(proveLegacyCompositionCompletion(f.context, input)).rejects.toThrow(
    "REQUIRED_CHECK_UNPROVEN"
  )
})

it("reads a shared required artifact and handoff output only once per proof", async () => {
  const f = fixture()
  const read = vi.spyOn(scopedFiles, "readRuntimeScopedFileAsync")
  await proveLegacyCompositionCompletion(f.context, f.input)
  expect(read).toHaveBeenCalledTimes(1)
})

it("bounds the total unique files and bytes across directory artifacts", async () => {
  const f = fixture()
  f.input.detail.run.nodes[0].artifacts[0].path = "reports"
  f.context.unit.outputs = []
  for (let i = 0; i < 128; i++)
    writeFileSync(join(f.context.workspace, `reports/file-${i}.md`), "bounded")
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "ARTIFACT_LIMIT"
  )
  const g = fixture()
  g.input.detail.run.nodes[0].artifacts[0].path = "reports"
  g.context.unit.outputs = []
  for (let i = 0; i < 5; i++)
    writeFileSync(join(g.context.workspace, `reports/file-${i}.md`), Buffer.alloc(4 * 1024 * 1024))
  await expect(proveLegacyCompositionCompletion(g.context, g.input)).rejects.toThrow("FILE_LIMIT")
})

it("rejects replacement of a file already observed during an asynchronous proof", async () => {
  const f = fixture()
  const original = scopedFiles.readRuntimeScopedFileAsync
  vi.spyOn(scopedFiles, "readRuntimeScopedFileAsync").mockImplementation(async (...args) => {
    const result = await original(...args)
    writeFileSync(join(f.context.workspace, "reports/result.md"), "replaced after read")
    return result
  })
  await expect(proveLegacyCompositionCompletion(f.context, f.input)).rejects.toThrow(
    "ARTIFACT_CHANGED"
  )
})
