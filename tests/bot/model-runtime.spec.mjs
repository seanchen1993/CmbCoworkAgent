import assert from "node:assert/strict"
import test from "node:test"
import { ReferenceModel, inputDigest, move } from "./reference-model.mjs"
import { states, validator } from "./schema-support.mjs"
import * as fixture from "../../contracts/bot/v1/fixtures/positive.mjs"
import {
  context,
  connection,
  rejects,
  committedUpload,
  approve,
  activateStage,
  runRequest,
  startAssessment,
  eventFor
} from "./model-helpers.mjs"

test("scenario 5: server resolved RunSpec, six-way capability intersection and offline waiting", () => {
  const model = new ReferenceModel()
  rejects(() => model.createRun(context, fixture.runSpec), "INVALID_PAYLOAD")
  activateStage(model)
  for (const layer of ["principal", "bot", "group", "task", "mode", "node"]) {
    const blocked = new ReferenceModel()
    activateStage(blocked)
    const request = runRequest(blocked)
    if (layer === "principal") blocked.setAccess(context, { capabilities: [] })
    if (layer === "bot") blocked.data.botVersions.get("bot-v1").config.capabilityCeiling = []
    if (layer === "group") blocked.groupCapabilities.set("group-1", [])
    if (layer === "task") blocked.taskCapabilities.set("task-1", [])
    if (layer === "mode") request.requestedCapabilities = ["command.execute"]
    if (layer === "node") blocked.nodes.get("node-1").capabilities.capabilities = []
    rejects(() => blocked.createRun(context, request), "CAPABILITY_UNAVAILABLE")
    assert.equal(blocked.data.runs.size, 0, layer)
  }
  model.nodeOffline("node-1")
  const request = runRequest(model)
  const { run } = model.createRun(context, request)
  assert.equal(run.status, "waiting_node")
  assert.equal(model.data.attempts.size, 0)
  assert.deepEqual(model.dispatch(run.id), { waiting: true })
  assert.equal(model.data.runs.get(run.id).status, "waiting_node")
  model.nodes.get("node-1").status = "online"
  const start = model.dispatch(run.id)
  assert.equal(validator("StartBody")(start), true)
  assert.equal(start.run.botVersionId, "bot-v1")
  assert.equal(start.run.grant.grantId, "grant-1")
  assert.equal(start.run.contextManifestRef.startsWith("context-"), true)
  model.data.bots.get("bot-1").currentBotVersionId = "bot-v-new"
  assert.equal(
    model.data.runs.get(run.id).botVersionId,
    "bot-v1",
    "versioned context remains frozen"
  )
})

test("scenario 3b/5b: business/technical signatures cannot authorize tools; exact tool scope is required", () => {
  const model = new ReferenceModel()
  const business = approve(model, "business_scope")
  const technical = approve(model, "technical_handoff")
  const humans = [business.id, technical.id]
  const before = structuredClone(model.data)
  rejects(() => activateStage(model, "development", humans), "APPROVAL_REQUIRED")
  rejects(() => activateStage(model, "development", []), "APPROVAL_REQUIRED")
  assert.deepEqual(model.data, before)
  const tool = approve(model, "tool_action", fixture.inputs, {
    capability: "command.execute",
    resourceRefs: ["repo-1", "workspace-project"],
    inputDigest: inputDigest(fixture.inputs)
  })
  const workspaceTool = approve(model, "tool_action", fixture.inputs, {
    capability: "workspace.write",
    resourceRefs: ["repo-1", "workspace-project"],
    inputDigest: inputDigest(fixture.inputs)
  })
  activateStage(model, "scope_confirmation")
  activateStage(model, "development", [...humans, tool.id])
  rejects(
    () =>
      model.createRun(
        context,
        runRequest(model, "project", {
          requestedCapabilities: ["command.execute"],
          approvalIds: humans
        })
      ),
    "APPROVAL_REQUIRED"
  )
  const { run } = model.createRun(
    context,
    runRequest(model, "project", {
      requestedCapabilities: ["repository.read", "workspace.write", "command.execute"],
      approvalIds: [...humans, tool.id, workspaceTool.id]
    })
  )
  assert.equal(run.status, "queued")
  const wrongScope = new ReferenceModel()
  activateStage(wrongScope, "prototype")
  const forged = approve(wrongScope, "tool_action", fixture.inputs, {
    capability: "workspace.write",
    resourceRefs: ["workspace-other"],
    inputDigest: inputDigest(fixture.inputs)
  })
  rejects(
    () =>
      wrongScope.createRun(
        context,
        runRequest(wrongScope, "prototype", {
          requestedCapabilities: ["workspace.write"],
          approvalIds: [forged.id]
        })
      ),
    "INPUT_CHANGED"
  )
  const publish = new ReferenceModel()
  rejects(
    () =>
      publish.createRun(
        context,
        runRequest(publish, "requirement", { requestedCapabilities: ["requirements.publish"] })
      ),
    "APPROVAL_REQUIRED"
  )
  rejects(
    () =>
      publish.createRun(
        context,
        runRequest(publish, "requirement", { requestedCapabilities: ["workspace.write"] })
      ),
    "CAPABILITY_UNAVAILABLE"
  )
})

test("scenario 6: lost start/ACK reuse, bound node/lease/fence/auth, event conflict and detectable gap", () => {
  const model = new ReferenceModel()
  const start = startAssessment(model)
  const runId = start.run.runId
  assert.deepEqual(model.dispatch(runId), start)
  assert.equal(model.data.attempts.size, 1)
  const event = eventFor(start)
  for (const body of [
    { ...event, fence: 2 },
    { ...event, leaseId: "lease-forged" },
    { ...event, authorizationVersion: 2 },
    { ...event, nodeId: "node-forged" }
  ])
    rejects(() => model.receiveEvent(connection, body), "FORBIDDEN")
  rejects(() => model.receiveEvent({ ...connection, nodeId: "node-forged" }, event), "FORBIDDEN")
  rejects(() => model.receiveEvent({ ...connection, spaceId: "space-forged" }, event), "FORBIDDEN")
  rejects(() => model.receiveEvent({ ...connection, authenticated: false }, event), "FORBIDDEN")
  const ack = model.receiveEvent(connection, event)
  assert.equal(validator("AckBody")(ack), true)
  assert.equal(model.data.runs.get(runId).status, "running")
  assert.equal(model.data.attempts.size, 1)
  assert.deepEqual(model.receiveEvent(connection, event), ack)
  rejects(
    () =>
      model.receiveEvent(connection, {
        ...event,
        data: { summary: "Different content at same sequence" }
      }),
    "COMMAND_CONFLICT"
  )
  rejects(
    () => model.receiveEvent(connection, eventFor(start, 2, { eventId: event.eventId })),
    "COMMAND_CONFLICT"
  )
  rejects(() => model.receiveEvent(connection, eventFor(start, 3)), "OUTCOME_UNKNOWN")
  assert.equal(model.data.watermarks.get(start.run.attemptId), 1)
  const foreign = { artifactId: "artifact-forged", versionId: "forged-v1", digest: fixture.digest }
  rejects(
    () =>
      model.receiveEvent(
        connection,
        eventFor(start, 2, { eventType: "artifact_committed", data: { artifact: foreign } })
      ),
    "INPUT_CHANGED"
  )
  assert.equal(model.data.watermarks.get(start.run.attemptId), 1)
  model.receiveEvent(
    connection,
    eventFor(start, 2, { eventType: "artifact_committed", data: { artifact: fixture.prd } })
  )
  assert.equal(model.data.watermarks.get(start.run.attemptId), 2)
  model.setAccess(context, { version: 2 })
  rejects(() => model.receiveEvent(connection, eventFor(start, 3)), "FORBIDDEN")
  model.setAccess(context, { version: 1 })
  model.grantVersions.set("grant-1", 2)
  rejects(
    () => model.receiveEvent(connection, event),
    "FORBIDDEN",
    "reauthorize even duplicate event"
  )
  model.grantVersions.set("grant-1", 1)
  model.now = fixture.expiry
  rejects(() => model.receiveEvent(connection, eventFor(start, 3)), "FORBIDDEN")
})

test("scenario 7a: cancellation/completion race and terminal Run cannot roll back", () => {
  for (const outcome of ["succeeded", "failed", "cancelled", "outcome_unknown"]) {
    const model = new ReferenceModel()
    const start = startAssessment(model)
    model.receiveEvent(connection, eventFor(start))
    const run = model.data.runs.get(start.run.runId)
    const response = model.cancelRun(context, run.id, {
      ...fixture.requests.cancelRun,
      expectedVersion: run.version
    })
    assert.equal(response.run.status, "cancel_requested")
    assert.notEqual(response.run.status, "cancelled")
    const completion = eventFor(start, 2, {
      eventType: "completed",
      data: { outcome, artifactVersions: [] }
    })
    model.receiveEvent(connection, completion)
    assert.equal(model.data.runs.get(run.id).status, outcome)
    assert.equal(model.data.attempts.get(start.run.attemptId).status, outcome)
    assert.equal(model.data.tasks.get("task-1").status, "active")
    assert.deepEqual(model.receiveEvent(connection, completion), {
      eventId: completion.eventId,
      runId: run.id,
      attemptId: start.run.attemptId,
      eventSeq: 2
    })
    rejects(() => model.dispatch(run.id), "OUTCOME_UNKNOWN")
    rejects(() => model.resume(context, run.id, "checkpoint-1"), "OUTCOME_UNKNOWN")
  }
  for (const terminal of ["succeeded", "failed", "cancelled"]) {
    const state = { status: terminal }
    rejects(() => move("RunStatus", state, "queued"), "OUTCOME_UNKNOWN")
    assert.equal(state.status, terminal)
  }
})

test("scenario 7b: offline/unknown side effect cannot migrate/replay; resume needs stopped reconciled same-node checkpoint", () => {
  const model = new ReferenceModel()
  const start = startAssessment(model)
  const runId = start.run.runId
  model.receiveEvent(connection, eventFor(start))
  const snapshot = structuredClone(start.run.inputArtifactVersions)
  model.nodeOffline("node-1")
  assert.equal(model.data.attempts.size, 1)
  assert.equal(model.data.runs.get(runId).status, "running")
  model.leaseLost(runId)
  rejects(() => model.dispatch(runId), "OUTCOME_UNKNOWN")
  rejects(() => model.resume(context, runId, "checkpoint-1"), "OUTCOME_UNKNOWN")
  assert.equal(model.data.attempts.size, 1)
  const inspection = {
    requestId: "inspect-1",
    runId,
    attemptId: start.run.attemptId,
    status: "running",
    lastEventSeq: 1,
    fence: start.lease.fence,
    checkpointRef: "checkpoint-1"
  }
  rejects(() => model.inspectAndReconcile(connection, inspection), "OUTCOME_UNKNOWN")
  model.nodes.get("node-1").status = "online"
  model.inspectAndReconcile(connection, inspection, { externalReceiptVerified: true })
  rejects(() => model.resume(context, runId, "checkpoint-1"), "OUTCOME_UNKNOWN")
  model.inspectAndReconcile(connection, inspection, {
    externalReceiptVerified: true,
    executionStopped: true
  })
  model.nodes.get("node-1").capabilities.recovery = "none"
  rejects(() => model.resume(context, runId, "checkpoint-1"), "CAPABILITY_UNAVAILABLE")
  model.nodes.get("node-1").capabilities.recovery = "same_node_checkpoint"
  model.data.checkpoints.get("checkpoint-1").nodeId = "different-node"
  rejects(() => model.resume(context, runId, "checkpoint-1"), "CAPABILITY_UNAVAILABLE")
  model.data.checkpoints.get("checkpoint-1").nodeId = "node-1"
  const resume = model.resume(context, runId, "checkpoint-1")
  assert.equal(validator("ResumeBody")(resume), true)
  assert.notEqual(resume.run.attemptId, start.run.attemptId)
  assert.notEqual(resume.lease.leaseId, start.lease.leaseId)
  assert.ok(resume.lease.fence > start.lease.fence)
  assert.deepEqual(resume.run.inputArtifactVersions, snapshot)
  assert.equal(model.data.attempts.size, 2)
  rejects(() => model.receiveEvent(connection, eventFor(start, 2)), "FORBIDDEN")
  model.receiveEvent(
    connection,
    eventFor(resume, 1, {
      eventType: "completed",
      data: { outcome: "succeeded", artifactVersions: [] }
    })
  )
  assert.equal(model.data.runs.get(runId).status, "succeeded")
  rejects(() => model.resume(context, runId, "checkpoint-1"), "OUTCOME_UNKNOWN")
  assert.equal(model.data.attempts.size, 2)
})

test("scenario 8b: Delivery retry never creates execution; Task snapshot and cursor increments are consistent and reauthorized", () => {
  const model = new ReferenceModel()
  const start = startAssessment(model)
  const initial = model.taskSnapshot(context, "task-1")
  assert.equal(validator("TaskSnapshotResult")(initial), true)
  const head = model.events(context)
  assert.deepEqual(head.events, [])
  model.appendMessage(context, "task-1", {
    ...fixture.requests.createTaskMessage,
    expectedVersion: initial.task.version
  })
  const increment = model.events(context, { after: initial.snapshotCursor })
  assert.equal(increment.events.length, 1)
  assert.equal(increment.events[0].entityRef.version, initial.task.version + 1)
  assert.equal(validator("EventsResult")(increment), true)
  model.data.deliveries.set("delivery-1", {
    ...fixture.delivery,
    runId: start.run.runId,
    attemptId: start.run.attemptId,
    status: "failed",
    attempts: 1
  })
  const beforeRuns = structuredClone(model.data.runs)
  const beforeAttempts = structuredClone(model.data.attempts)
  const delivery = model.retryDelivery(context, "delivery-1")
  assert.equal(delivery.status, "pending")
  assert.equal(delivery.attempts, 2)
  assert.deepEqual(model.data.runs, beforeRuns)
  assert.deepEqual(model.data.attempts, beforeAttempts)
  model.data.deliveries.get("delivery-1").status = "outcome_unknown"
  rejects(() => model.retryDelivery(context, "delivery-1"), "OUTCOME_UNKNOWN")
  model.setAccess(context, { resources: ["repo-1", "workspace-1"] })
  assert.deepEqual(model.events(context, { after: initial.snapshotCursor }).events, [])
  rejects(
    () =>
      model.appendMessage(context, "task-1", {
        ...fixture.requests.createTaskMessage,
        expectedVersion: initial.task.version
      }),
    "FORBIDDEN"
  )
  model.setAccess(context, { allowed: false })
  rejects(() => model.events(context, { after: initial.snapshotCursor }), "FORBIDDEN")
  model.setAccess(context, { allowed: true })
  model.now = "2026-10-03T12:00:00Z"
  rejects(() => model.events(context, { after: initial.snapshotCursor }), "CURSOR_EXPIRED")
})

test("single state table executes every ordinary/reconciliation edge and rejects undeclared edges", () => {
  for (const [kind, definition] of Object.entries(states.$defs)) {
    for (const from of definition.enum)
      for (const to of definition.enum) {
        const object = { status: from }
        if (from === to || states["x-state-transitions"][kind][from].includes(to)) {
          move(kind, object, to)
          assert.equal(object.status, to)
        } else {
          rejects(() => move(kind, object, to), "OUTCOME_UNKNOWN")
          assert.equal(object.status, from)
        }
      }
    for (const [from, next] of Object.entries(states["x-reconciliation"][kind] ?? {}))
      for (const to of next) {
        const object = { status: from }
        rejects(() => move(kind, object, to), "OUTCOME_UNKNOWN")
        move(kind, object, to, { reconcile: true })
        assert.equal(object.status, to)
      }
  }
})
