import assert from "node:assert/strict"
import test from "node:test"
import { ReferenceModel } from "./reference-model.mjs"
import * as fixture from "../../contracts/bot/v1/fixtures/positive.mjs"
import { validator } from "./schema-support.mjs"
import { context, rejects, committedUpload, approve, contentHeaders } from "./model-helpers.mjs"

test("scenario 2: scoped command fingerprint, reauthorize before replay, receipt before CAS, atomic failure", () => {
  const model = new ReferenceModel()
  const body = fixture.requests.createTaskMessage
  const result = model.appendMessage(context, "task-1", body)
  assert.equal(result.taskVersion, 2)
  assert.deepEqual(
    model.appendMessage(context, "task-1", {
      artifactVersions: [],
      text: body.text,
      expectedVersion: 1,
      commandId: body.commandId
    }),
    result
  )
  assert.equal(model.data.messages.size, 1)
  assert.equal(model.data.receipts.size, 1)
  rejects(
    () => model.appendMessage(context, "task-1", { ...body, text: "Changed" }),
    "COMMAND_CONFLICT"
  )
  rejects(
    () =>
      model.createUpload(context, { ...fixture.requests.createUpload, commandId: body.commandId }),
    "COMMAND_CONFLICT"
  )
  model.data.tasks.set("task-2", { ...structuredClone(fixture.task), id: "task-2" })
  model.setAccess(context, {
    resources: [...model.access.get("space-1/principal-1").resources, "task-2"]
  })
  rejects(() => model.appendMessage(context, "task-2", body), "COMMAND_CONFLICT")
  const another = model.appendMessage({ ...context, principalId: "principal-2" }, "task-1", {
    ...body,
    expectedVersion: 2
  })
  assert.notEqual(another.message.id, result.message.id)
  assert.equal(model.data.receipts.size, 2)
  const otherSpace = { ...context, spaceId: "space-2" }
  model.setAccess(otherSpace, { allowed: true })
  rejects(() => model.appendMessage(otherSpace, "task-1", body), "NOT_FOUND")
  model.setAccess(context, { allowed: false })
  rejects(() => model.appendMessage(context, "task-1", body), "FORBIDDEN")
  model.setAccess(context, { allowed: true })
  const before = structuredClone(model.data)
  rejects(
    () =>
      model.appendMessage(context, "task-1", {
        ...body,
        commandId: "cas-conflict",
        expectedVersion: 1
      }),
    "VERSION_CONFLICT"
  )
  assert.deepEqual(model.data, before)
  rejects(
    () =>
      model.appendMessage(context, "task-1", {
        ...body,
        commandId: "invalid-input",
        expectedVersion: 3,
        artifactVersions: [{ ...fixture.prd, digest: `sha256:${"0".repeat(64)}` }]
      }),
    "INPUT_CHANGED"
  )
  assert.deepEqual(model.data, before)
  model.now = "2026-10-03T12:00:00Z"
  rejects(() => model.appendMessage(context, "task-1", body), "COMMAND_EXPIRED")
})

test("scenario 4: upload verification, task/purpose binding, immutable version and no last-writer-wins", () => {
  const model = new ReferenceModel()
  const { upload: pending } = model.createUpload(context, fixture.requests.createUpload)
  rejects(
    () =>
      model.createArtifact(context, "task-1", {
        ...fixture.requests.createArtifact,
        uploadId: pending.id
      }),
    "INPUT_CHANGED"
  )
  const upload = committedUpload(model)
  rejects(
    () =>
      model.createArtifact(context, "task-1", {
        ...fixture.requests.createArtifact,
        uploadId: upload.id,
        kind: "assessment"
      }),
    "INPUT_CHANGED"
  )
  model.data.tasks.set("task-2", { ...structuredClone(fixture.task), id: "task-2" })
  model.setAccess(context, {
    resources: [...model.access.get("space-1/principal-1").resources, "task-2"]
  })
  rejects(
    () =>
      model.createArtifact(context, "task-2", {
        ...fixture.requests.createArtifact,
        uploadId: upload.id
      }),
    "INPUT_CHANGED"
  )
  const result = model.createArtifact(context, "task-1", {
    ...fixture.requests.createArtifact,
    uploadId: upload.id
  })
  assert.equal(validator("ArtifactResult")(result), true)
  const prior = structuredClone(result.artifactVersion)
  rejects(
    () =>
      model.putContent(context, upload.id, {
        headers: contentHeaders("overwrite-committed", '"4"'),
        bytes: "abc"
      }),
    "INPUT_CHANGED"
  )
  const nextUpload = committedUpload(model)
  const body = {
    ...fixture.requests.createArtifactVersion,
    uploadId: nextUpload.id,
    baseVersionId: prior.id
  }
  const next = model.createArtifactVersion(context, result.artifact.id, body)
  assert.equal(next.artifactVersion.number, 2)
  assert.notEqual(next.artifactVersion.id, prior.id)
  assert.deepEqual(model.data.versions.get(prior.id), prior)
  assert.equal(Buffer.from(model.data.blobBytes.get(prior.id)).toString("utf8"), "abc")
  const before = structuredClone(model.data)
  rejects(
    () =>
      model.createArtifactVersion(context, result.artifact.id, { ...body, commandId: "stale-cas" }),
    "VERSION_CONFLICT"
  )
  rejects(
    () =>
      model.createArtifactVersion(context, result.artifact.id, {
        ...body,
        commandId: "stale-base",
        expectedVersion: 2
      }),
    "INPUT_CHANGED"
  )
  assert.deepEqual(model.data, before)
  rejects(
    () =>
      model.putContent(context, upload.id, {
        headers: contentHeaders("unsafe-version", '"9999999999999999"'),
        bytes: "abc"
      }),
    "INVALID_PAYLOAD"
  )
})

test("scenario 3: accurate inputs, distinct human/tool approval, designated approver, expiry and invalidation", () => {
  const model = new ReferenceModel()
  const { approval } = model.createApproval(context, "task-1", fixture.requests.createApproval)
  const body = fixture.requests.decideApproval
  rejects(() => model.decideApproval(context, approval.id, body), "FORBIDDEN")
  const owner = { ...context, principalId: "business-1" }
  rejects(
    () =>
      model.decideApproval(owner, approval.id, {
        ...body,
        inputArtifactVersions: [{ ...fixture.prd, versionId: "prd-v2" }, fixture.assessment]
      }),
    "INPUT_CHANGED"
  )
  const result = model.decideApproval(owner, approval.id, body)
  assert.equal(result.decision.principalId, owner.principalId)
  assert.deepEqual(model.decideApproval(owner, approval.id, body), result)
  rejects(
    () =>
      model.decideApproval(owner, approval.id, {
        ...body,
        commandId: "opposite-decision",
        expectedVersion: 2,
        decision: "reject"
      }),
    "COMMAND_CONFLICT"
  )
  rejects(
    () => model.approved(model.data, context, approval.id, "tool_action", "task-1", fixture.inputs),
    "APPROVAL_REQUIRED"
  )
  rejects(
    () =>
      model.approved(
        model.data,
        context,
        approval.id,
        "technical_handoff",
        "task-1",
        fixture.inputs
      ),
    "APPROVAL_REQUIRED"
  )
  model.setAccess(owner, { allowed: false })
  rejects(() => model.decideApproval(owner, approval.id, body), "FORBIDDEN")
  model.setAccess(owner, { allowed: true })
  model.now = "2026-10-03T12:00:00Z"
  rejects(() => model.decideApproval(owner, approval.id, body), "APPROVAL_EXPIRED")
  model.now = fixture.now
  const upload = committedUpload(model)
  const version = model.createArtifactVersion(context, fixture.prd.artifactId, {
    ...fixture.requests.createArtifactVersion,
    uploadId: upload.id,
    baseVersionId: fixture.prd.versionId
  })
  assert.equal(model.data.approvals.get(approval.id).status, "invalidated")
  assert.notEqual(version.artifactVersion.id, fixture.prd.versionId)
  rejects(() => model.decideApproval(owner, approval.id, body), "INPUT_CHANGED")
  assert.equal(model.data.versions.get(fixture.prd.versionId).digest, fixture.prd.digest)
})

test("scenario 8a: dual confirmation handoff is immutable and idempotent, not a project or Run", () => {
  const model = new ReferenceModel()
  const business = approve(model, "business_scope")
  const technical = approve(model, "technical_handoff")
  const body = {
    ...fixture.requests.createDevelopmentHandoff,
    expectedVersion: model.data.tasks.get("task-1").version,
    businessApprovalId: business.id,
    technicalApprovalId: technical.id
  }
  rejects(
    () =>
      model.createDevelopmentHandoff(context, "task-1", {
        ...body,
        technicalApprovalId: business.id
      }),
    "APPROVAL_REQUIRED"
  )
  const result = model.createDevelopmentHandoff(context, "task-1", body)
  assert.equal(validator("DevelopmentHandoffResult")(result), true)
  assert.deepEqual(model.createDevelopmentHandoff(context, "task-1", body), result)
  assert.equal(model.data.developmentHandoffs.size, 1)
  assert.equal(model.data.runs.size, 0)
  assert.equal(model.data.tasks.get("task-1").status, "handed_off")
  const saved = structuredClone(result.handoff)
  const upload = committedUpload(model)
  model.createArtifactVersion(context, fixture.prd.artifactId, {
    ...fixture.requests.createArtifactVersion,
    uploadId: upload.id,
    baseVersionId: fixture.prd.versionId
  })
  assert.deepEqual(model.data.developmentHandoffs.get(result.handoff.id), saved)
  const beforeReplay = structuredClone(model.data)
  const serial = model.serial
  assert.deepEqual(model.createDevelopmentHandoff(context, "task-1", body), result)
  assert.deepEqual(model.data, beforeReplay)
  assert.equal(model.serial, serial)
  assert.equal(model.data.projectBindings.size, 0)
  assert.equal(model.data.runs.size, 0)
  rejects(
    () =>
      model.createDevelopmentHandoff(context, "task-1", {
        ...body,
        commandId: "new-handoff-old-inputs",
        expectedVersion: model.data.tasks.get("task-1").version
      }),
    "INPUT_CHANGED"
  )
  model.setAccess(context, { resources: [] })
  rejects(() => model.createDevelopmentHandoff(context, "task-1", body), "FORBIDDEN")
})
