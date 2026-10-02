import assert from "node:assert/strict"
import test from "node:test"
import { ReferenceModel, inputDigest, move } from "./reference-model.mjs"
import { schemas, validator } from "./schema-support.mjs"
import * as fixture from "../../contracts/bot/v1/fixtures/positive.mjs"
import {
  context,
  connection,
  rejects,
  contentHeaders,
  approve,
  activateStage,
  runRequest,
  startAssessment,
  eventFor
} from "./model-helpers.mjs"

const unchanged = (model, operation, code) => {
  const before = structuredClone(model.data)
  const serial = model.serial
  rejects(operation, code)
  assert.deepEqual(
    model.data,
    before,
    "rejected operation leaves every state/evidence map unchanged"
  )
  assert.equal(model.serial, serial, "rejected operation consumes no IDs")
}

test("R1: every expiry gate compares exact UTC instants, including equal and nanosecond precision", () => {
  const now = "2026-10-01T12:00:00.100000000Z"
  for (const [expiresAt, isExpired] of [
    ["2026-10-01T12:00:00.1Z", true], // same instant, different precision
    ["2026-10-01T12:00:00Z", true], // expired by 100ms; lexical comparison used to allow it
    ["2026-10-01T12:00:00.099999999Z", true],
    ["2026-10-01T12:00:00.100000001Z", false]
  ]) {
    const exercise = (model, operation, code) => {
      model.now = now
      if (isExpired) unchanged(model, operation, code)
      else operation()
    }
    for (const phase of ["put", "complete", "verify"]) {
      const model = new ReferenceModel()
      const { upload } = model.createUpload(context, fixture.requests.createUpload)
      const put = () =>
        model.putContent(context, upload.id, {
          headers: contentHeaders("time-content"),
          bytes: "abc"
        })
      const complete = () =>
        model.completeUpload(context, upload.id, {
          ...fixture.requests.completeUpload,
          expectedVersion: 2
        })
      if (phase !== "put") put()
      if (phase === "verify") complete()
      model.data.uploads.get(upload.id).expiresAt = expiresAt
      exercise(
        model,
        phase === "put"
          ? put
          : phase === "complete"
            ? complete
            : () => model.verifyUpload(upload.id),
        phase === "complete" ? "INPUT_CHANGED" : "COMMAND_EXPIRED"
      )
    }
    const command = new ReferenceModel()
    const original = command.appendMessage(context, "task-1", fixture.requests.createTaskMessage)
    command.data.receipts.get("space-1/principal-1/command-message").expiresAt = expiresAt
    exercise(
      command,
      () =>
        assert.deepEqual(
          command.appendMessage(context, "task-1", fixture.requests.createTaskMessage),
          original
        ),
      "COMMAND_EXPIRED"
    )

    const cursor = new ReferenceModel()
    const snapshot = cursor.taskSnapshot(context, "task-1")
    cursor.data.cursors.get(snapshot.snapshotCursor).expiresAt = expiresAt
    exercise(
      cursor,
      () => cursor.events(context, { after: snapshot.snapshotCursor }),
      "CURSOR_EXPIRED"
    )

    const creation = new ReferenceModel()
    exercise(
      creation,
      () =>
        creation.createApproval(context, "task-1", {
          ...fixture.requests.createApproval,
          expiresAt
        }),
      "APPROVAL_EXPIRED"
    )
    const decision = new ReferenceModel()
    const { approval } = decision.createApproval(context, "task-1", fixture.requests.createApproval)
    decision.data.approvals.get(approval.id).expiresAt = expiresAt
    exercise(
      decision,
      () =>
        decision.decideApproval(
          { ...context, principalId: "business-1" },
          approval.id,
          fixture.requests.decideApproval
        ),
      "APPROVAL_EXPIRED"
    )
    const gated = new ReferenceModel()
    const business = approve(gated, "business_scope")
    const technical = approve(gated, "technical_handoff")
    gated.data.approvals.get(business.id).expiresAt = expiresAt
    exercise(
      gated,
      () =>
        gated.createDevelopmentHandoff(context, "task-1", {
          ...fixture.requests.createDevelopmentHandoff,
          expectedVersion: gated.data.tasks.get("task-1").version,
          businessApprovalId: business.id,
          technicalApprovalId: technical.id
        }),
      "APPROVAL_EXPIRED"
    )

    const deadline = new ReferenceModel()
    activateStage(deadline)
    const deadlineRequest = runRequest(deadline, "assessment", { deadline: expiresAt })
    exercise(deadline, () => deadline.createRun(context, deadlineRequest), "INVALID_PAYLOAD")
    const dispatch = new ReferenceModel()
    dispatch.now = "2026-10-01T11:59:59Z"
    activateStage(dispatch)
    const { run } = dispatch.createRun(
      context,
      runRequest(dispatch, "assessment", { deadline: expiresAt })
    )
    exercise(
      dispatch,
      () => {
        const start = dispatch.dispatch(run.id)
        assert.equal(
          start.lease.expiresAt,
          "2026-10-01T12:00:00.100000001Z",
          "lease never truncates or extends deadline"
        )
      },
      "OUTCOME_UNKNOWN"
    )
    for (const gate of ["event", "repeated start"]) {
      const lease = new ReferenceModel()
      const start = startAssessment(lease)
      lease.data.attempts.get(start.run.attemptId).lease.expiresAt = expiresAt
      exercise(
        lease,
        () =>
          gate === "event"
            ? lease.receiveEvent(connection, eventFor(start))
            : lease.dispatch(start.run.runId),
        gate === "event" ? "FORBIDDEN" : "OUTCOME_UNKNOWN"
      )
    }
  }
})

test("binary PUT consumes actual HTTP headers, strict ETag and real-byte fingerprint before new CAS", () => {
  const model = new ReferenceModel()
  const { upload } = model.createUpload(context, fixture.requests.createUpload)
  const request = fixture.operations.find(
    (operation) => operation.operationId === "putUploadContent"
  ).request
  const headers = structuredClone(request.headers)
  assert.equal(headers["Content-Type"], upload.mediaType)
  for (const ifMatch of [
    'W/"1"',
    "*",
    '"1", "2"',
    '"01"',
    '"0"',
    '"-1"',
    '"1.0"',
    '"9007199254740992"',
    '"9999999999999999"'
  ]) {
    assert.equal(validator("IfMatchVersion")(ifMatch), false)
    unchanged(
      model,
      () =>
        model.putContent(context, upload.id, {
          headers: { ...headers, "If-Match": ifMatch },
          bytes: "abc"
        }),
      "INVALID_PAYLOAD"
    )
  }
  for (const mediaType of [
    "Text/Plain",
    "text/plain; charset=utf-8",
    " text/plain",
    "text/plain ",
    "text/*"
  ]) {
    unchanged(
      model,
      () =>
        model.putContent(context, upload.id, {
          headers: { ...headers, "Content-Type": mediaType },
          bytes: "abc"
        }),
      "INVALID_PAYLOAD"
    )
  }
  unchanged(
    model,
    () =>
      model.putContent(context, upload.id, {
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        bytes: "abc"
      }),
    "INPUT_CHANGED"
  )
  const accepted = model.putContent(context, upload.id, { headers, bytes: request.body })
  assert.deepEqual(
    model.putContent(context, upload.id, { headers, bytes: Buffer.from("abc") }),
    accepted
  )
  for (const changed of [
    { headers, bytes: "abd" },
    { headers: { ...headers, "Content-Type": "application/octet-stream" }, bytes: "abc" },
    { headers: { ...headers, "If-Match": '"2"' }, bytes: "abc" }
  ])
    unchanged(model, () => model.putContent(context, upload.id, changed), "COMMAND_CONFLICT")
  unchanged(
    model,
    () =>
      model.putContent(context, upload.id, {
        headers,
        bytes: Buffer.alloc(schemas.$defs.ByteSize.maximum + 1)
      }),
    "INVALID_PAYLOAD"
  )
  model.setAccess(context, { resources: [] })
  unchanged(
    model,
    () => model.putContent(context, upload.id, { headers, bytes: "abc" }),
    "FORBIDDEN"
  )
  for (const value of [
    1,
    9,
    10,
    999999999999999,
    1000000000000000,
    8999999999999999,
    9000000000000000,
    Number.MAX_SAFE_INTEGER
  ])
    assert.equal(validator("IfMatchVersion")(`"${value}"`), true)
})

test("R2: refused inspection, reconciliation, lease loss and dual-object cancellation are atomic", () => {
  const model = new ReferenceModel()
  const start = startAssessment(model)
  const inspection = {
    requestId: "inspect-test",
    runId: start.run.runId,
    attemptId: start.run.attemptId,
    status: "cancelled",
    lastEventSeq: 0,
    fence: start.lease.fence,
    checkpointRef: "checkpoint-refused"
  }
  unchanged(
    model,
    () =>
      model.inspectAndReconcile(connection, inspection, {
        externalReceiptVerified: true,
        executionStopped: true
      }),
    "OUTCOME_UNKNOWN"
  )
  assert.equal(model.data.attempts.get(start.run.attemptId).status, "dispatched")
  assert.equal(model.data.runs.get(start.run.runId).status, "starting")
  model.receiveEvent(connection, eventFor(start))
  model.data.attempts.get(start.run.attemptId).status = "succeeded" // trusted harness seeds inconsistent counterpart
  unchanged(
    model,
    () =>
      model.inspectAndReconcile(
        connection,
        { ...inspection, status: "failed", lastEventSeq: 1 },
        { externalReceiptVerified: true, executionStopped: true }
      ),
    "OUTCOME_UNKNOWN"
  )
  unchanged(model, () => model.leaseLost(start.run.runId), "OUTCOME_UNKNOWN")
  unchanged(
    model,
    () =>
      model.cancelRun(context, start.run.runId, {
        ...fixture.requests.cancelRun,
        expectedVersion: model.data.runs.get(start.run.runId).version
      }),
    "OUTCOME_UNKNOWN"
  )
  model.data.runs.get(start.run.runId).status = "outcome_unknown"
  unchanged(
    model,
    () =>
      model.inspectAndReconcile(
        connection,
        { ...inspection, status: "running", lastEventSeq: 1 },
        { externalReceiptVerified: true, executionStopped: true }
      ),
    "OUTCOME_UNKNOWN"
  )
})

test("R3: Delivery read/retry rechecks Run/Attempt/Task/Group ownership and current resource access", () => {
  for (const restriction of [
    "task access",
    "membership",
    "run space",
    "task space",
    "group space",
    "attempt belongs to run"
  ]) {
    const model = new ReferenceModel()
    const start = startAssessment(model)
    model.data.deliveries.set("delivery-1", {
      ...fixture.delivery,
      runId: start.run.runId,
      attemptId: start.run.attemptId,
      status: "failed",
      attempts: 1
    })
    if (restriction === "task access") model.setAccess(context, { resources: [] })
    if (restriction === "membership") model.data.groups.get("group-1").members = []
    if (restriction === "run space") model.data.runs.get(start.run.runId).spaceId = "space-2"
    if (restriction === "task space") model.data.tasks.get("task-1").spaceId = "space-2"
    if (restriction === "group space") model.data.groups.get("group-1").spaceId = "space-2"
    if (restriction === "attempt belongs to run")
      model.data.attempts.get(start.run.attemptId).runId = "another-run"
    const code = ["task access", "membership"].includes(restriction) ? "FORBIDDEN" : "NOT_FOUND"
    unchanged(model, () => model.retryDelivery(context, "delivery-1"), code)
    unchanged(model, () => model.entity(model.data, "deliveries", "delivery-1", context), code)
  }
  const model = new ReferenceModel()
  const start = startAssessment(model)
  model.data.deliveries.set("delivery-1", {
    ...fixture.delivery,
    runId: start.run.runId,
    attemptId: start.run.attemptId,
    status: "outcome_unknown",
    attempts: 1
  })
  unchanged(model, () => model.retryDelivery(context, "delivery-1"), "OUTCOME_UNKNOWN")
  move("DeliveryStatus", model.data.deliveries.get("delivery-1"), "failed", { reconcile: true })
  const beforeRuns = structuredClone(model.data.runs)
  const beforeAttempts = structuredClone(model.data.attempts)
  assert.equal(model.retryDelivery(context, "delivery-1").status, "pending")
  assert.deepEqual(model.data.runs, beforeRuns)
  assert.deepEqual(model.data.attempts, beforeAttempts)
})

test("R4: read-only workspace refuses explicit workspace.write at create, dispatch and resume", () => {
  const prepared = () => {
    const model = new ReferenceModel()
    activateStage(model, "prototype")
    const approval = approve(model, "tool_action", fixture.inputs, {
      capability: "workspace.write",
      resourceRefs: ["workspace-prototype"],
      inputDigest: inputDigest(fixture.inputs)
    })
    return {
      model,
      request: runRequest(model, "prototype", {
        requestedCapabilities: ["workspace.write"],
        approvalIds: [approval.id]
      })
    }
  }
  const creating = prepared()
  creating.model.workspaces.get("workspace-prototype").spec.access = "read"
  unchanged(creating.model, () => creating.model.createRun(context, creating.request), "FORBIDDEN")
  assert.equal(
    creating.model.createRun(context, runRequest(creating.model, "prototype")).run.status,
    "queued",
    "non-write prototype capability is not implicitly broadened"
  )
  const { model, request } = prepared()
  const { run } = model.createRun(context, request)
  assert.equal(run.status, "queued")
  model.workspaces.get("workspace-prototype").spec.access = "read"
  unchanged(model, () => model.dispatch(run.id), "FORBIDDEN")
  model.workspaces.get("workspace-prototype").spec.access = "write"
  const start = model.dispatch(run.id)
  model.receiveEvent(connection, eventFor(start))
  model.inspectAndReconcile(
    connection,
    {
      requestId: "inspection-write",
      runId: run.id,
      attemptId: start.run.attemptId,
      status: "running",
      lastEventSeq: 1,
      fence: start.lease.fence,
      checkpointRef: "checkpoint-write"
    },
    { executionStopped: true }
  )
  model.workspaces.get("workspace-prototype").spec.access = "read"
  unchanged(model, () => model.resume(context, run.id, "checkpoint-write"), "FORBIDDEN")
  model.workspaces.get("workspace-prototype").spec.access = "write"
  assert.ok(model.resume(context, run.id, "checkpoint-write").lease.fence > start.lease.fence)
})

test("zero-event inspection can recover only a nonterminal stopped Run; provider/input mismatch refuses resume", () => {
  const model = new ReferenceModel()
  const start = startAssessment(model)
  const inspection = {
    requestId: "inspect-zero",
    runId: start.run.runId,
    attemptId: start.run.attemptId,
    status: "dispatched",
    lastEventSeq: 0,
    fence: start.lease.fence,
    checkpointRef: "checkpoint-zero"
  }
  model.inspectAndReconcile(connection, inspection, { executionStopped: true })
  const checkpoint = structuredClone(model.data.checkpoints.get("checkpoint-zero"))
  for (const field of ["provider", "inputDigest", "modeVersion"]) {
    model.data.checkpoints.get("checkpoint-zero")[field] = field === "modeVersion" ? 2 : "mismatch"
    unchanged(
      model,
      () => model.resume(context, start.run.runId, "checkpoint-zero"),
      "CAPABILITY_UNAVAILABLE"
    )
    model.data.checkpoints.set("checkpoint-zero", structuredClone(checkpoint))
  }
  const resumed = model.resume(context, start.run.runId, "checkpoint-zero")
  assert.ok(resumed.lease.fence > start.lease.fence)
  assert.notEqual(resumed.lease.leaseId, start.lease.leaseId)
  model.inspectAndReconcile(
    connection,
    {
      ...inspection,
      attemptId: resumed.run.attemptId,
      fence: resumed.lease.fence,
      status: "succeeded"
    },
    { externalReceiptVerified: true, executionStopped: true }
  )
  unchanged(
    model,
    () => model.resume(context, start.run.runId, "checkpoint-zero"),
    "OUTCOME_UNKNOWN"
  )
  unchanged(
    model,
    () =>
      model.inspectAndReconcile(
        connection,
        {
          ...inspection,
          attemptId: resumed.run.attemptId,
          fence: resumed.lease.fence,
          status: "failed"
        },
        { externalReceiptVerified: true, executionStopped: true }
      ),
    "OUTCOME_UNKNOWN"
  )
})
