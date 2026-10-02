import assert from "node:assert/strict"
import * as fixture from "../../contracts/bot/v1/fixtures/positive.mjs"
export const context = { spaceId: "space-1", principalId: "principal-1" }
export const connection = {
  authenticated: true,
  spaceId: "space-1",
  nodeId: "node-1",
  connectionId: "connection-1"
}
export const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code)
export const contentHeaders = (commandId, ifMatch = '"1"', mediaType = "text/plain") => ({
  "X-DevClaw-Space": context.spaceId,
  "X-Command-Id": commandId,
  "If-Match": ifMatch,
  "Content-Type": mediaType
})
export function committedUpload(
  model,
  { purpose = "prd", taskId = "task-1", commandId = model.id("upload-command") } = {}
) {
  const { upload } = model.createUpload(context, {
    ...fixture.requests.createUpload,
    commandId,
    taskId,
    purpose
  })
  model.putContent(context, upload.id, {
    headers: contentHeaders(model.id("content-command")),
    bytes: "abc"
  })
  const complete = {
    commandId: model.id("complete-command"),
    expectedVersion: 2,
    digest: fixture.digest,
    sizeBytes: 3
  }
  const accepted = model.completeUpload(context, upload.id, complete)
  assert.equal(accepted.upload.status, "verifying")
  model.verifyUpload(upload.id)
  assert.deepEqual(model.completeUpload(context, upload.id, complete), accepted)
  return model.data.uploads.get(upload.id)
}
export function approve(model, kind, refs = fixture.inputs, requestedAction) {
  const approver =
    kind === "business_scope"
      ? "business-1"
      : kind === "technical_handoff"
        ? "technical-1"
        : "principal-1"
  const request = {
    ...fixture.requests.createApproval,
    commandId: model.id("approval-command"),
    expectedVersion: model.data.tasks.get("task-1").version,
    kind,
    inputArtifactVersions: refs,
    approverIds: [approver],
    ...(requestedAction ? { requestedAction } : {})
  }
  const { approval } = model.createApproval(context, "task-1", request)
  const decided = model.decideApproval({ ...context, principalId: approver }, approval.id, {
    commandId: model.id("decision-command"),
    expectedVersion: 1,
    decision: "approve",
    inputArtifactVersions: refs
  })
  return decided.approval
}
export function activateStage(model, kind = "assessment", approvalIds = []) {
  const body = {
    ...fixture.requests.transitionStage,
    commandId: model.id("stage-command"),
    expectedVersion: model.data.tasks.get("task-1").version,
    toStage: kind,
    approvalIds
  }
  return model.stageTransition(context, "task-1", body).task
}
export function runRequest(model, mode = "assessment", overrides = {}) {
  return {
    ...fixture.requests.createRun,
    commandId: model.id("run-command"),
    expectedVersion: model.data.tasks.get("task-1").version,
    stageId: `stage-${mode === "project" ? "development" : mode}`,
    mode: { id: mode, version: 1 },
    workspaceRef: mode === "assessment" ? "workspace-1" : `workspace-${mode}`,
    requestedCapabilities:
      mode === "requirement"
        ? ["requirements.analyze"]
        : mode === "assessment"
          ? ["repository.read"]
          : mode === "prototype"
            ? ["prototype.generate"]
            : ["repository.read"],
    ...overrides
  }
}
export function startAssessment(model) {
  activateStage(model)
  const { run } = model.createRun(context, runRequest(model))
  return model.dispatch(run.id)
}
export function eventFor(start, eventSeq = 1, overrides = {}) {
  return {
    ...fixture.runtimeEvent,
    runId: start.run.runId,
    attemptId: start.run.attemptId,
    eventSeq,
    eventId: `runtime-event-${start.run.attemptId}-${eventSeq}`,
    leaseId: start.lease.leaseId,
    fence: start.lease.fence,
    authorizationVersion: start.lease.authorizationVersion,
    ...overrides
  }
}
