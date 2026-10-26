import { expect, it } from "vitest"
import { isHostWorkflowExecution, captureHostWorkflowExecution } from "./host-execution"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
const binding = {
  projectId: "generic-project",
  operationId: "original-operation",
  stageId: "implementation",
  packageDigest: "a".repeat(64),
  inputFingerprint: "b".repeat(64),
  threadId: "original-thread",
  incarnationKey: "original-incarnation"
}
function token(guard: () => void = () => {}) {
  return issueRuntimePluginSourceToken(
    {
      ...binding,
      mode: "host",
      executionMode: "workflow",
      workspace: process.cwd(),
      plugin: {
        id: "supplier",
        name: "supplier",
        version: "1.0.0",
        path: process.cwd(),
        enabled: true,
        description: "",
        author: "",
        skillCount: 0,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    },
    guard,
    guard
  )
}
it("captures only the opaque original Host binding and never infers old run ownership", () => {
  expect(captureHostWorkflowExecution(binding.threadId)).toBeUndefined()
  expect(
    withRuntimePluginSource(token(), () => captureHostWorkflowExecution(binding.threadId))
  ).toEqual(binding)
  expect(() =>
    withRuntimePluginSource(token(), () => captureHostWorkflowExecution("other-thread"))
  ).toThrow("HOST_WORKFLOW_EXECUTION_CHANGED")
})
it("rechecks the original authority rather than treating persisted metadata as a grant", () => {
  let live = true
  const original = token(() => {
    if (!live) throw Error("ORIGINAL_REVOKED")
  })
  expect(
    withRuntimePluginSource(original, () => captureHostWorkflowExecution(binding.threadId))
  ).toEqual(binding)
  live = false
  expect(() =>
    withRuntimePluginSource(original, () => captureHostWorkflowExecution(binding.threadId))
  ).toThrow("ORIGINAL_REVOKED")
})
it("requires the exact bounded persisted shape including both input and source fingerprints", () => {
  expect(isHostWorkflowExecution(binding)).toBe(true)
  for (const value of [
    null,
    [],
    { ...binding, inputFingerprint: "forged" },
    { ...binding, incarnationKey: "x".repeat(1025) },
    { ...binding, granted: true },
    { ...binding, threadId: undefined }
  ])
    expect(isHostWorkflowExecution(value)).toBe(false)
})
