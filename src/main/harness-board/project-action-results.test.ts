import { expect, it } from "vitest"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../shared/project-runtime/host-types"
import type { FlowRun } from "../../shared/mods/flows/types"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { createProjectActionBinding } from "./project-runtime/action-input"
import { runtimeDigest } from "./project-runtime/safe-files"
import { projectActionResults } from "./project-action-results"

function fixture() {
  const descriptor = {
    pluginId: "installed",
    plugin: "formatter",
    digest: "a".repeat(64),
    actionId: "format",
    name: "Format",
    command: "format",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  }
  const binding = createProjectActionBinding("format", descriptor, {})
  const project: HostProjectState = {
    ...hostProjectFixture("C:\\User\\Project"),
    schemaVersion: 1,
    stateOwner: "host",
    version: 2,
    stageIndex: 1,
    status: "active",
    createdAt: 1,
    updatedAt: 1
  }
  project.manifest.stages[1].actionIds = [binding.id]
  project.manifest.actions = [{ id: binding.id, ref: binding.ref }]
  const operation: HostProjectOperation = {
    schemaVersion: 1,
    projectId: project.projectId,
    operationId: "operation",
    pluginDigest: project.pluginDigest,
    expectedVersion: 2,
    stageId: "review",
    idempotencyKey: "idempotency",
    inputFingerprint: "b".repeat(64),
    status: "succeeded",
    createdAt: 1,
    updatedAt: 2,
    cancelRequestedAt: null,
    startedAt: 1,
    receipts: [],
    approval: null,
    execution: { threadId: "thread", terminal: { outcome: "success", code: "done", settledAt: 2 } }
  }
  const run: FlowRun = {
    id: "run",
    threadId: "thread",
    workspace: project.workspace.toLowerCase(),
    flow: {
      revision: 1,
      updatedAt: 1,
      digest: "c".repeat(64),
      definition: {
        schemaVersion: 2,
        execution: { kind: "host" },
        id: `project-actions-${runtimeDigest(operation.operationId).slice(0, 24)}`,
        name: "bound flow",
        goal: "test",
        timeoutMs: 1000,
        maxExecutions: 3,
        steps: [
          {
            id: binding.id,
            name: "Format",
            enabled: true,
            kind: "plugin-action",
            ...binding.ref,
            input: {},
            config: {}
          }
        ]
      }
    },
    status: "complete",
    startedAt: 1,
    finishedAt: 2,
    epoch: 0,
    failureCounts: {},
    attempts: [
      {
        stepId: binding.id,
        executionId: "execution",
        attempt: 1,
        epoch: 0,
        status: "passed",
        startedAt: 1,
        finishedAt: 2,
        result: {
          passed: true,
          source: "plugin-action",
          summary: "Actual provider result",
          provider: binding.ref,
          output: { text: "actual output" }
        }
      }
    ]
  }
  return {
    project,
    operation,
    threadId: "thread",
    binding: {
      projectId: project.projectId,
      operationId: operation.operationId,
      stageId: operation.stageId,
      pluginDigest: project.pluginDigest
    },
    lock: { apiVersion: "devclaw.project-actions-lock/v1" as const, bindings: [binding] },
    runs: [run],
    catalog: [descriptor]
  }
}
it("reads matching persisted output and locked schema without changing history", () => {
  const input = fixture(),
    before = structuredClone(input)
  const result = projectActionResults(input)
  expect(result.actions[0]).toMatchObject({
    authorizedNow: true,
    status: "passed",
    output: '{\n  "text": "actual output"\n}'
  })
  expect(JSON.parse(result.actions[0].outputSchema)).toEqual({ type: "object" })
  expect(input).toEqual(before)
})
it("hides output after grant removal or contract drift and rejects foreign identity", () => {
  const input = fixture()
  expect(projectActionResults({ ...input, catalog: [] }).actions[0]).toMatchObject({
    authorizedNow: false,
    output: null,
    summary: null
  })
  expect(
    projectActionResults({ ...input, catalog: [{ ...input.catalog[0], command: "changed" }] })
      .actions[0].authorizedNow
  ).toBe(false)
  expect(() => projectActionResults({ ...input, threadId: "foreign" })).toThrow("SCOPE_CHANGED")
  input.runs[0].attempts[0].result!.provider = {
    ...input.lock.bindings[0].ref,
    digest: "d".repeat(64)
  }
  expect(() => projectActionResults(input)).toThrow("PROVIDER_CHANGED")
})
it("bounds large outputs and never substitutes another operation's result", () => {
  const input = fixture()
  input.runs[0].attempts[0].result!.output = { text: "x".repeat(100000) }
  const result = projectActionResults(input)
  expect(result.actions[0].output!.length).toBe(8192)
  expect(result.actions[0].truncated).toBe(true)
  input.runs[0].flow.definition.id = "other-operation"
  expect(projectActionResults(input)).toMatchObject({
    flowStatus: null,
    actions: [{ status: "not-recorded", output: null }]
  })
})
