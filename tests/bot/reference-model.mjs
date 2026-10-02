// In-memory contract reference only. Trusted harness inputs stand in for authentication,
// authorization, DB transactions, storage verification and external receipt reconciliation.
// This is deliberately not imported by application or production server code.
import { createHash } from "node:crypto"
import { states, validator } from "./schema-support.mjs"
import * as fixture from "../../contracts/bot/v1/fixtures/positive.mjs"

export class ContractError extends Error {
  constructor(code, message = code) {
    super(message)
    this.code = code
    this.retryable = false
  }
}
const fail = (code, message) => {
  throw new ContractError(code, message)
}
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  )
export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const inputKey = (refs) =>
  canonical(
    [...refs].sort((a, b) =>
      a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0
    )
  )
export const inputDigest = (refs) => sha256(inputKey(refs))
const scope = (context) => `${context.spaceId}/${context.principalId}`
const sameInputs = (a, b) => inputKey(a) === inputKey(b)
const mutation = (object, now) => {
  object.version++
  if ("updatedAt" in object) object.updatedAt = now
  return object
}
// UTC schema permits up to nine fractional digits. Compare exact nanoseconds rather
// than lexical strings or millisecond-truncated Date values. Unrepresentable instants
// (including leap seconds) fail closed; they never grant extra execution lifetime.
const instant = (value) => {
  if (!validator("UtcDateTime")(value)) fail("INVALID_PAYLOAD", "Invalid UTC instant")
  const match = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(value)
  const milliseconds = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(milliseconds)) fail("INVALID_PAYLOAD", "Unrepresentable UTC instant")
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"))
}
const expired = (value, now) => instant(value) <= instant(now)
const formatInstant = (value) => {
  const fraction = ((value % 1000000000n) + 1000000000n) % 1000000000n
  const seconds = (value - fraction) / 1000000000n
  return `${new Date(Number(seconds * 1000n)).toISOString().slice(0, 19)}.${fraction.toString().padStart(9, "0")}Z`
}

export function move(kind, object, to, { reconcile = false } = {}) {
  const table = states[reconcile ? "x-reconciliation" : "x-state-transitions"][kind]
  if (!states.$defs[kind]?.enum.includes(object.status) || !states.$defs[kind].enum.includes(to))
    fail("INVALID_PAYLOAD", "Unknown status")
  if (object.status === to) return object
  if (!table?.[object.status]?.includes(to))
    fail("OUTCOME_UNKNOWN", `Forbidden ${kind} transition ${object.status} -> ${to}`)
  object.status = to
  return object
}

export class ReferenceModel {
  constructor() {
    this.now = fixture.now
    this.serial = 0
    this.access = new Map()
    this.nodes = new Map([[fixture.node.id, structuredClone(fixture.node)]])
    this.groupCapabilities = new Map([[fixture.group.id, [...fixture.capabilities.capabilities]]])
    this.taskCapabilities = new Map([[fixture.task.id, [...fixture.capabilities.capabilities]]])
    this.grantVersions = new Map([["grant-1", 1]])
    this.workspaces = new Map([
      ["workspace-1", { modeId: "assessment", spec: structuredClone(fixture.workspace) }],
      [
        "workspace-requirement",
        {
          modeId: "requirement",
          spec: {
            workspaceRef: "workspace-requirement",
            isolation: "task",
            access: "read",
            inputArtifactVersions: fixture.inputs
          }
        }
      ],
      [
        "workspace-prototype",
        {
          modeId: "prototype",
          spec: {
            workspaceRef: "workspace-prototype",
            isolation: "task",
            access: "write",
            inputArtifactVersions: fixture.inputs
          }
        }
      ],
      [
        "workspace-project",
        {
          modeId: "project",
          spec: {
            ...structuredClone(fixture.workspace),
            workspaceRef: "workspace-project",
            access: "write"
          }
        }
      ]
    ])
    this.data = Object.fromEntries(
      [
        "bots",
        "botVersions",
        "groups",
        "tasks",
        "messages",
        "uploads",
        "uploadBytes",
        "artifacts",
        "versions",
        "blobBytes",
        "approvals",
        "decisions",
        "handoffs",
        "developmentHandoffs",
        "projectBindings",
        "runs",
        "resolvedRuns",
        "attempts",
        "deliveries",
        "receipts",
        "runtimeEvents",
        "eventIds",
        "watermarks",
        "checkpoints",
        "stopped",
        "reconciled",
        "cursors"
      ].map((name) => [name, new Map()])
    )
    this.data.events = []
    for (const [name, value] of [
      ["bots", fixture.bot],
      [
        "botVersions",
        {
          ...fixture.botVersion,
          config: { ...fixture.config, capabilityCeiling: fixture.capabilities.capabilities }
        }
      ],
      ["groups", fixture.group],
      ["tasks", fixture.task]
    ])
      this.data[name].set(value.id, structuredClone(value))
    this.data.groups
      .get("group-1")
      .members.push({ principalId: "principal-2", role: "participant" })
    for (const [ref, kind] of [
      [fixture.prd, "prd"],
      [fixture.assessment, "assessment"]
    ]) {
      this.data.artifacts.set(ref.artifactId, {
        ...structuredClone(fixture.artifact),
        id: ref.artifactId,
        kind,
        currentVersionId: ref.versionId
      })
      this.data.versions.set(ref.versionId, {
        ...structuredClone(fixture.artifactVersion),
        id: ref.versionId,
        artifactId: ref.artifactId
      })
      this.data.blobBytes.set(ref.versionId, "abc")
    }
    const all = [...fixture.capabilities.capabilities]
    for (const principalId of ["principal-1", "business-1", "technical-1", "principal-2"])
      this.setAccess(
        { spaceId: "space-1", principalId },
        { capabilities: all, resources: ["repo-1", ...this.workspaces.keys(), fixture.task.id] }
      )
  }
  id(prefix) {
    return `${prefix}-${++this.serial}`
  }
  setAccess(context, { allowed = true, capabilities, resources, version } = {}) {
    const prior = this.access.get(scope(context))
    this.access.set(scope(context), {
      allowed,
      capabilities: [...(capabilities ?? prior?.capabilities ?? [])],
      resources: [...(resources ?? prior?.resources ?? [])],
      version: version ?? prior?.version ?? 1
    })
  }
  authorize(context, entity, data = this.data) {
    if (!context || !validator("Id")(context.spaceId) || !validator("Id")(context.principalId))
      fail("UNAUTHENTICATED")
    const access = this.access.get(scope(context))
    if (!access?.allowed) fail("FORBIDDEN")
    if (entity && entity.spaceId !== context.spaceId) fail("NOT_FOUND")
    const run = entity?.runId ? data.runs.get(entity.runId) : undefined
    if (entity?.runId && (!run || run.spaceId !== context.spaceId)) fail("NOT_FOUND")
    if (entity?.attemptId) {
      const attempt = data.attempts.get(entity.attemptId)
      if (!attempt || attempt.runId !== run?.id || attempt.spaceId !== context.spaceId)
        fail("NOT_FOUND")
    }
    const taskId =
      entity?.taskId ?? run?.taskId ?? (entity && data.tasks.has(entity.id) ? entity.id : undefined)
    if (taskId) {
      const task = data.tasks.get(taskId)
      const group = task && data.groups.get(task.groupId)
      if (!task || task.spaceId !== context.spaceId || !group || group.spaceId !== context.spaceId)
        fail("NOT_FOUND")
      if (
        !access.resources.includes(taskId) ||
        !group?.members.some((m) => m.principalId === context.principalId)
      )
        fail("FORBIDDEN")
    }
    return access
  }
  entity(data, collection, id, context) {
    if (!validator("Id")(id)) fail("INVALID_PAYLOAD")
    const entity = data[collection].get(id)
    if (!entity) fail("NOT_FOUND")
    this.authorize(context, entity, data)
    return entity
  }
  validate(name, value) {
    if (!validator(name)?.(value)) fail("INVALID_PAYLOAD", `Invalid ${name}`)
  }
  meta(context, prefix) {
    return {
      id: this.id(prefix),
      spaceId: context.spaceId,
      version: 1,
      createdAt: this.now,
      updatedAt: this.now
    }
  }
  atomic(effect) {
    const draft = structuredClone(this.data)
    const serial = this.serial
    try {
      const result = effect(draft)
      this.data = draft
      return result
    } catch (error) {
      this.serial = serial
      throw error
    }
  }
  command(context, method, path, body, { schema, target, authorize, effect, fingerprintBody }) {
    if (schema) this.validate(schema, body)
    this.authorize(context)
    const current = target?.(this.data)
    // Resource-specific authorization also precedes receipt lookup, not just membership.
    if (authorize) authorize(this.data, current)
    const key = `${scope(context)}/${body.commandId}`
    const { commandId: _commandId, ...payload } = body
    const fingerprint = canonical({
      spaceId: context.spaceId,
      authenticatedPrincipalId: context.principalId,
      method: method.toUpperCase(),
      path,
      body: fingerprintBody ?? payload
    })
    const existing = this.data.receipts.get(key)
    if (existing) {
      if (expired(existing.expiresAt, this.now)) fail("COMMAND_EXPIRED")
      if (existing.fingerprint !== fingerprint) fail("COMMAND_CONFLICT")
      return structuredClone(existing.result)
    }
    if (current && body.expectedVersion !== current.version) fail("VERSION_CONFLICT")
    const draft = structuredClone(this.data)
    const serial = this.serial
    try {
      const result = effect(draft)
      draft.receipts.set(key, {
        fingerprint,
        result: structuredClone(result),
        expiresAt: fixture.expiry
      })
      this.data = draft
      return structuredClone(result)
    } catch (error) {
      this.serial = serial
      throw error
    }
  }
  inputs(data, taskId, refs, { current = false } = {}) {
    this.validate("ArtifactRefs", refs)
    for (const ref of refs) {
      const version = data.versions.get(ref.versionId)
      const artifact = data.artifacts.get(ref.artifactId)
      if (
        !version ||
        !artifact ||
        version.artifactId !== ref.artifactId ||
        version.digest !== ref.digest ||
        version.taskId !== taskId
      )
        fail("INPUT_CHANGED")
      if (current && artifact.currentVersionId !== ref.versionId) fail("INPUT_CHANGED")
    }
  }
  emit(data, context, kind, entity, taskId) {
    const seq = data.events.filter((e) => e.spaceId === context.spaceId).length + 1
    data.events.push({
      eventId: this.id("business-event"),
      spaceId: context.spaceId,
      seq,
      occurredAt: this.now,
      kind,
      taskId,
      entityRef: { kind: kind.split("_")[0], id: entity.id, version: entity.version }
    })
  }
  appendMessage(context, taskId, body) {
    return this.command(context, "POST", `/api/bot/v1/tasks/${taskId}/messages`, body, {
      schema: "CreateTaskMessageRequest",
      target: (data) => this.entity(data, "tasks", taskId, context),
      effect: (data) => {
        const task = data.tasks.get(taskId)
        this.inputs(data, taskId, body.artifactVersions)
        const message = {
          id: this.id("message"),
          spaceId: context.spaceId,
          taskId,
          authorPrincipalId: context.principalId,
          text: body.text,
          artifactVersions: body.artifactVersions,
          createdAt: this.now
        }
        data.messages.set(message.id, structuredClone(message))
        mutation(task, this.now)
        this.emit(data, context, "task_updated", task, taskId)
        return { message, taskVersion: task.version }
      }
    })
  }
  createUpload(context, body) {
    return this.command(context, "POST", "/api/bot/v1/uploads", body, {
      schema: "CreateUploadRequest",
      authorize: (data) => this.entity(data, "tasks", body.taskId, context),
      effect: (data) => {
        const { commandId: _commandId, ...fields } = body
        const upload = {
          id: this.id("upload"),
          spaceId: context.spaceId,
          version: 1,
          ...fields,
          status: "created",
          expiresAt: fixture.expiry
        }
        data.uploads.set(upload.id, upload)
        return { upload }
      }
    })
  }
  putContent(context, uploadId, { headers, bytes }) {
    this.entity(this.data, "uploads", uploadId, context)
    this.validate("UploadContentHeaders", headers)
    if (headers["X-DevClaw-Space"] !== context.spaceId) fail("FORBIDDEN")
    const commandId = headers["X-Command-Id"]
    const ifMatch = headers["If-Match"]
    const mediaType = headers["Content-Type"]
    const expectedVersion = Number(ifMatch.slice(1, -1))
    this.validate("Version", expectedVersion)
    if (typeof bytes !== "string" && !Buffer.isBuffer(bytes)) fail("INVALID_PAYLOAD")
    const sizeBytes = Buffer.byteLength(bytes)
    // This applies before hashing and before receipt lookup, including repeats.
    this.validate("ByteSize", sizeBytes)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")
    const body = {
      commandId,
      expectedVersion,
      mediaType,
      digest: sha256(buffer),
      sizeBytes
    }
    return this.command(context, "PUT", `/api/bot/v1/uploads/${uploadId}/content`, body, {
      target: (data) => this.entity(data, "uploads", uploadId, context),
      fingerprintBody: { digest: body.digest, mediaType, ifMatch },
      effect: (data) => {
        const upload = data.uploads.get(uploadId)
        if (expired(upload.expiresAt, this.now)) fail("COMMAND_EXPIRED")
        if (upload.status !== "created")
          fail("INPUT_CHANGED", "Upload content cannot be reopened or overwritten")
        if (
          upload.digest !== body.digest ||
          upload.sizeBytes !== body.sizeBytes ||
          upload.mediaType !== mediaType
        )
          fail("INPUT_CHANGED")
        move("UploadStatus", upload, "uploading")
        mutation(upload, this.now)
        data.uploadBytes.set(uploadId, new Uint8Array(buffer))
        return { upload }
      }
    })
  }
  completeUpload(context, uploadId, body) {
    return this.command(context, "POST", `/api/bot/v1/uploads/${uploadId}/complete`, body, {
      schema: "CompleteUploadRequest",
      target: (data) => this.entity(data, "uploads", uploadId, context),
      effect: (data) => {
        const upload = data.uploads.get(uploadId)
        if (
          upload.status !== "uploading" ||
          body.digest !== upload.digest ||
          body.sizeBytes !== upload.sizeBytes ||
          expired(upload.expiresAt, this.now)
        )
          fail("INPUT_CHANGED")
        move("UploadStatus", upload, "verifying")
        mutation(upload, this.now)
        return { upload }
      }
    })
  }
  verifyUpload(uploadId) {
    const upload = this.data.uploads.get(uploadId)
    const bytes = this.data.uploadBytes.get(uploadId)
    if (
      !upload ||
      bytes === undefined ||
      sha256(bytes) !== upload.digest ||
      Buffer.byteLength(bytes) !== upload.sizeBytes
    )
      fail("INPUT_CHANGED")
    if (expired(upload.expiresAt, this.now)) fail("COMMAND_EXPIRED")
    move("UploadStatus", upload, "committed")
    mutation(upload, this.now)
  }
  checkedUpload(data, context, taskId, uploadId, kind) {
    const upload = this.entity(data, "uploads", uploadId, context)
    if (upload.status !== "committed" || upload.taskId !== taskId || upload.purpose !== kind)
      fail("INPUT_CHANGED")
    return upload
  }
  makeVersion(data, context, artifact, upload) {
    const prior = data.versions.get(artifact.currentVersionId)
    const version = {
      id: this.id("artifact-version"),
      artifactId: artifact.id,
      spaceId: context.spaceId,
      taskId: artifact.taskId,
      number: prior ? prior.number + 1 : 1,
      digest: upload.digest,
      mediaType: upload.mediaType,
      sizeBytes: upload.sizeBytes,
      blobRef: this.id("blob"),
      createdAt: this.now,
      createdBy: context.principalId
    }
    data.versions.set(version.id, version)
    data.blobBytes.set(version.id, data.uploadBytes.get(upload.id))
    artifact.currentVersionId = version.id
    return version
  }
  createArtifact(context, taskId, body) {
    return this.command(context, "POST", `/api/bot/v1/tasks/${taskId}/artifacts`, body, {
      schema: "CreateArtifactRequest",
      target: (data) => this.entity(data, "tasks", taskId, context),
      effect: (data) => {
        const upload = this.checkedUpload(data, context, taskId, body.uploadId, body.kind)
        const artifact = {
          ...this.meta(context, "artifact"),
          taskId,
          kind: body.kind,
          currentVersionId: "pending-version"
        }
        const artifactVersion = this.makeVersion(data, context, artifact, upload)
        data.artifacts.set(artifact.id, artifact)
        mutation(data.tasks.get(taskId), this.now)
        this.emit(data, context, "artifact_committed", artifact, taskId)
        return { artifact, artifactVersion }
      }
    })
  }
  createArtifactVersion(context, artifactId, body) {
    return this.command(context, "POST", `/api/bot/v1/artifacts/${artifactId}/versions`, body, {
      schema: "CreateArtifactVersionRequest",
      target: (data) => this.entity(data, "artifacts", artifactId, context),
      effect: (data) => {
        const artifact = data.artifacts.get(artifactId)
        if (artifact.currentVersionId !== body.baseVersionId) fail("INPUT_CHANGED")
        const upload = this.checkedUpload(
          data,
          context,
          artifact.taskId,
          body.uploadId,
          artifact.kind
        )
        const artifactVersion = this.makeVersion(data, context, artifact, upload)
        mutation(artifact, this.now)
        for (const approval of data.approvals.values())
          if (
            ["pending", "approved"].includes(approval.status) &&
            approval.inputArtifactVersions.some((ref) => ref.artifactId === artifactId)
          ) {
            move("ApprovalStatus", approval, "invalidated")
            mutation(approval, this.now)
          }
        this.emit(data, context, "artifact_committed", artifact, artifact.taskId)
        return { artifact, artifactVersion }
      }
    })
  }
  createApproval(context, taskId, body) {
    return this.command(context, "POST", `/api/bot/v1/tasks/${taskId}/approvals`, body, {
      schema: "CreateApprovalRequest",
      target: (data) => this.entity(data, "tasks", taskId, context),
      effect: (data) => {
        const task = data.tasks.get(taskId)
        const group = data.groups.get(task.groupId)
        this.inputs(data, taskId, body.inputArtifactVersions, { current: true })
        if (expired(body.expiresAt, this.now)) fail("APPROVAL_EXPIRED")
        const role =
          body.kind === "business_scope"
            ? "business_owner"
            : body.kind === "technical_handoff"
              ? "technical_owner"
              : "admin"
        for (const principalId of body.approverIds)
          if (
            !group.members.some(
              (member) => member.principalId === principalId && member.role === role
            ) ||
            !this.access.get(`${context.spaceId}/${principalId}`)?.allowed
          )
            fail("FORBIDDEN", "Unapproved target approver")
        const { commandId: _commandId, expectedVersion: _version, ...fields } = body
        const approval = { ...this.meta(context, "approval"), taskId, ...fields, status: "pending" }
        data.approvals.set(approval.id, approval)
        mutation(task, this.now)
        return { approval }
      }
    })
  }
  decideApproval(context, approvalId, body) {
    return this.command(context, "POST", `/api/bot/v1/approvals/${approvalId}/decisions`, body, {
      schema: "DecideApprovalRequest",
      target: (data) => this.entity(data, "approvals", approvalId, context),
      authorize: (data, approval) => {
        if (!approval.approverIds.includes(context.principalId)) fail("FORBIDDEN")
        const group = data.groups.get(data.tasks.get(approval.taskId).groupId)
        const role =
          approval.kind === "business_scope"
            ? "business_owner"
            : approval.kind === "technical_handoff"
              ? "technical_owner"
              : "admin"
        if (
          !group.members.some(
            (member) => member.principalId === context.principalId && member.role === role
          )
        )
          fail("FORBIDDEN")
        if (expired(approval.expiresAt, this.now)) fail("APPROVAL_EXPIRED")
        if (approval.status === "invalidated") fail("INPUT_CHANGED")
      },
      effect: (data) => {
        const approval = data.approvals.get(approvalId)
        if (!sameInputs(approval.inputArtifactVersions, body.inputArtifactVersions))
          fail("INPUT_CHANGED")
        this.inputs(data, approval.taskId, body.inputArtifactVersions, { current: true })
        const existing = [...data.decisions.values()].find(
          (d) => d.approvalId === approvalId && d.principalId === context.principalId
        )
        if (existing) {
          if (
            existing.decision !== body.decision ||
            !sameInputs(existing.inputArtifactVersions, body.inputArtifactVersions)
          )
            fail("COMMAND_CONFLICT")
          return { approval, decision: existing }
        }
        if (approval.status !== "pending") fail("COMMAND_CONFLICT")
        move("ApprovalStatus", approval, body.decision === "approve" ? "approved" : "rejected")
        mutation(approval, this.now)
        const decision = {
          id: this.id("decision"),
          approvalId,
          spaceId: context.spaceId,
          principalId: context.principalId,
          decision: body.decision,
          ...(body.comment ? { comment: body.comment } : {}),
          inputArtifactVersions: body.inputArtifactVersions,
          createdAt: this.now
        }
        data.decisions.set(decision.id, decision)
        return { approval, decision }
      }
    })
  }
  approved(data, context, approvalId, kind, taskId, refs) {
    const approval = this.entity(data, "approvals", approvalId, context)
    if (expired(approval.expiresAt, this.now)) fail("APPROVAL_EXPIRED")
    if (approval.kind !== kind || approval.status !== "approved") fail("APPROVAL_REQUIRED")
    if (!sameInputs(approval.inputArtifactVersions, refs)) fail("INPUT_CHANGED")
    if (
      approval.taskId !== taskId ||
      !approval.approverIds.every((id) => this.access.get(`${context.spaceId}/${id}`)?.allowed)
    )
      fail("FORBIDDEN")
    const group = data.groups.get(data.tasks.get(taskId).groupId)
    const role =
      kind === "business_scope"
        ? "business_owner"
        : kind === "technical_handoff"
          ? "technical_owner"
          : "admin"
    if (
      !approval.approverIds.every((id) =>
        group.members.some((m) => m.principalId === id && m.role === role)
      )
    )
      fail("FORBIDDEN")
    return approval
  }
  createDevelopmentHandoff(context, taskId, body) {
    return this.command(context, "POST", `/api/bot/v1/tasks/${taskId}/development-handoffs`, body, {
      schema: "CreateDevelopmentHandoffRequest",
      target: (data) => this.entity(data, "tasks", taskId, context),
      effect: (data) => {
        const refs = [body.prd, body.assessment, ...(body.prototype ? [body.prototype] : [])]
        for (const kind of ["prd", "assessment", ...(body.prototype ? ["prototype"] : [])])
          if (data.artifacts.get(body[kind].artifactId)?.kind !== kind) fail("INPUT_CHANGED")
        this.inputs(data, taskId, refs, { current: true })
        this.approved(data, context, body.businessApprovalId, "business_scope", taskId, refs)
        this.approved(data, context, body.technicalApprovalId, "technical_handoff", taskId, refs)
        const { expectedVersion: _version, ...fields } = body
        const handoff = {
          id: this.id("development-handoff"),
          spaceId: context.spaceId,
          taskId,
          ...fields,
          createdAt: this.now
        }
        data.developmentHandoffs.set(handoff.id, structuredClone(handoff))
        const task = data.tasks.get(taskId)
        move("TaskStatus", task, "handed_off")
        mutation(task, this.now)
        return { handoff }
      }
    })
  }
  stageTransition(context, taskId, body) {
    return this.command(context, "POST", `/api/bot/v1/tasks/${taskId}/stage-transitions`, body, {
      schema: "TransitionStageRequest",
      target: (data) => this.entity(data, "tasks", taskId, context),
      effect: (data) => {
        const task = data.tasks.get(taskId)
        this.inputs(data, taskId, body.inputArtifactVersions, { current: true })
        const from = task.stages.find((s) => s.id === task.currentStageId)
        const to = task.stages.find((s) => s.kind === body.toStage)
        if (!from || !to || to.status !== "pending") fail("INPUT_CHANGED")
        if (body.toStage === "development") {
          for (const kind of ["business_scope", "technical_handoff"]) {
            const approvalId = body.approvalIds.find((id) => data.approvals.get(id)?.kind === kind)
            if (!approvalId) fail("APPROVAL_REQUIRED")
            this.approved(data, context, approvalId, kind, taskId, body.inputArtifactVersions)
          }
          this.toolApproved(
            data,
            context,
            body.approvalIds,
            taskId,
            body.inputArtifactVersions,
            "command.execute",
            ["repo-1", "workspace-project"]
          )
          if (from.kind !== "scope_confirmation")
            fail("INPUT_CHANGED", "Development starts after the explicit scope-confirmation stage")
        }
        move("StageStatus", from, "completed")
        move("StageStatus", to, "active")
        to.inputArtifactVersions = structuredClone(body.inputArtifactVersions)
        task.currentStageId = to.id
        mutation(task, this.now)
        this.emit(data, context, "task_updated", task, taskId)
        return { task }
      }
    })
  }
  toolApproved(data, context, approvalIds, taskId, refs, capability, resources) {
    const candidates = approvalIds.filter(
      (id) =>
        data.approvals.get(id)?.kind === "tool_action" &&
        data.approvals.get(id).requestedAction.capability === capability
    )
    if (!candidates.length) fail("APPROVAL_REQUIRED")
    const approval = this.approved(data, context, candidates[0], "tool_action", taskId, refs)
    if (
      approval.requestedAction.inputDigest !== inputDigest(refs) ||
      !resources.every((ref) => approval.requestedAction.resourceRefs.includes(ref))
    )
      fail("INPUT_CHANGED")
    return approval
  }
  capabilityCheck(
    data,
    context,
    {
      botVersionId,
      taskId,
      mode,
      workspace,
      inputArtifactVersions,
      requestedCapabilities,
      approvalIds
    },
    nodeId
  ) {
    const access = this.authorize(context, data.tasks.get(taskId), data)
    const botVersion = data.botVersions.get(botVersionId)
    const task = data.tasks.get(taskId)
    const node = this.nodes.get(nodeId)
    if (
      !node ||
      node.spaceId !== context.spaceId ||
      !node.capabilities.modes.some((m) => m.id === mode.id && m.version === mode.version)
    )
      fail("CAPABILITY_UNAVAILABLE")
    const resources = [
      workspace.workspaceRef,
      ...(workspace.repositoryRef ? [workspace.repositoryRef] : [])
    ]
    if (!resources.every((ref) => access.resources.includes(ref))) fail("FORBIDDEN")
    const ceilings = [
      access.capabilities,
      botVersion?.config.capabilityCeiling ?? [],
      this.groupCapabilities.get(task.groupId) ?? [],
      this.taskCapabilities.get(taskId) ?? [],
      states["x-mode-capabilities"][mode.id] ?? [],
      node.capabilities.capabilities
    ]
    if (!requestedCapabilities.every((cap) => ceilings.every((set) => set.includes(cap))))
      fail("CAPABILITY_UNAVAILABLE")
    if (
      requestedCapabilities.includes("workspace.write") &&
      (workspace.access !== "write" ||
        this.workspaces.get(workspace.workspaceRef)?.spec.access !== "write")
    )
      fail("FORBIDDEN", "A read-only workspace cannot be elevated by ceilings or approvals")
    for (const capability of requestedCapabilities)
      if (["workspace.write", "command.execute", "requirements.publish"].includes(capability))
        this.toolApproved(
          data,
          context,
          approvalIds,
          taskId,
          inputArtifactVersions,
          capability,
          resources
        )
    if (mode.id === "assessment" && workspace.access !== "read") fail("FORBIDDEN")
    if (mode.id === "prototype" && (workspace.repositoryRef || workspace.isolation !== "task"))
      fail("FORBIDDEN")
    return access
  }
  createRun(context, body, { nodeId = fixture.node.id } = {}) {
    const plan = (data) => {
      const task = this.entity(data, "tasks", body.taskId, context)
      const member = data.groups.get(task.groupId).bots.find((b) => b.botId === body.botId)
      const bot = data.bots.get(body.botId)
      if (!member || !bot || bot.status !== "active") fail("FORBIDDEN")
      const authorizedWorkspace = this.workspaces.get(body.workspaceRef)
      if (
        !authorizedWorkspace ||
        authorizedWorkspace.modeId !== body.mode.id ||
        !sameInputs(authorizedWorkspace.spec.inputArtifactVersions, body.inputArtifactVersions)
      )
        fail("FORBIDDEN")
      const resolved = {
        botVersionId: member.botVersionId,
        taskId: body.taskId,
        mode: body.mode,
        workspace: authorizedWorkspace.spec,
        inputArtifactVersions: body.inputArtifactVersions,
        requestedCapabilities: body.requestedCapabilities,
        approvalIds: body.approvalIds
      }
      this.capabilityCheck(data, context, resolved, nodeId)
      return resolved
    }
    return this.command(context, "POST", "/api/bot/v1/runs", body, {
      schema: "CreateRunRequest",
      target: (data) => this.entity(data, "tasks", body.taskId, context),
      authorize: (data) => plan(data),
      effect: (data) => {
        const task = data.tasks.get(body.taskId)
        const stage = task.stages.find((s) => s.id === body.stageId)
        const expectedKind = body.mode.id === "project" ? "development" : body.mode.id
        if (
          !stage ||
          stage.status !== "active" ||
          stage.kind !== expectedKind ||
          task.currentStageId !== stage.id ||
          ["completed", "cancelled"].includes(task.status)
        )
          fail("INPUT_CHANGED")
        this.inputs(data, body.taskId, body.inputArtifactVersions, { current: true })
        if (expired(body.deadline, this.now)) fail("INVALID_PAYLOAD")
        const resolved = plan(data)
        const access = this.authorize(context, task)
        const node = this.nodes.get(nodeId)
        const run = {
          ...this.meta(context, "run"),
          taskId: body.taskId,
          stageId: body.stageId,
          botVersionId: resolved.botVersionId,
          mode: body.mode,
          inputArtifactVersions: structuredClone(body.inputArtifactVersions),
          status: node.status === "online" ? "queued" : "waiting_node",
          requesterPrincipalId: context.principalId,
          budget: body.budget,
          deadline: body.deadline
        }
        data.runs.set(run.id, run)
        data.resolvedRuns.set(run.id, {
          ...structuredClone(resolved),
          nodeId,
          provider: node.provider,
          grant: { grantId: "grant-1", version: this.grantVersions.get("grant-1") },
          authorizationVersion: access.version,
          contextManifestRef: this.id("context"),
          credentialBindings: [],
          budget: body.budget,
          deadline: body.deadline
        })
        mutation(task, this.now)
        this.emit(data, context, "run_updated", run, body.taskId)
        return { run }
      }
    })
  }
  requester(run) {
    return { spaceId: run.spaceId, principalId: run.requesterPrincipalId }
  }
  reauthorizeRun(data, runId) {
    const run = data.runs.get(runId)
    if (!run) fail("NOT_FOUND")
    const resolved = data.resolvedRuns.get(runId)
    const access = this.capabilityCheck(data, this.requester(run), resolved, resolved.nodeId)
    if (
      access.version !== resolved.authorizationVersion ||
      this.grantVersions.get(resolved.grant.grantId) !== resolved.grant.version
    )
      fail("FORBIDDEN")
    if (!sameInputs(run.inputArtifactVersions, resolved.inputArtifactVersions))
      fail("INPUT_CHANGED")
    return { run, resolved }
  }
  newAttempt(data, run, resolved) {
    if (expired(run.deadline, this.now))
      fail("OUTCOME_UNKNOWN", "Deadline does not authorize new execution")
    const previous = [...data.attempts.values()].filter((a) => a.runId === run.id)
    const number = previous.length + 1
    const fence = Math.max(0, ...previous.map((a) => a.lease.fence)) + 1
    const lease = {
      leaseId: this.id("lease"),
      fence,
      expiresAt: formatInstant(
        instant(this.now) + 60000000000n < instant(run.deadline)
          ? instant(this.now) + 60000000000n
          : instant(run.deadline)
      ),
      authorizationVersion: resolved.authorizationVersion
    }
    const attempt = {
      id: this.id("attempt"),
      spaceId: run.spaceId,
      runId: run.id,
      number,
      runtimeNodeId: resolved.nodeId,
      status: "dispatched",
      lease
    }
    data.attempts.set(attempt.id, attempt)
    run.activeAttemptId = attempt.id
    mutation(run, this.now)
    const spec = {
      schemaVersion: 1,
      runId: run.id,
      attemptId: attempt.id,
      taskId: run.taskId,
      stageId: run.stageId,
      botVersionId: resolved.botVersionId,
      mode: resolved.mode,
      contextManifestRef: resolved.contextManifestRef,
      inputArtifactVersions: resolved.inputArtifactVersions,
      workspace: resolved.workspace,
      grant: resolved.grant,
      credentialBindings: resolved.credentialBindings,
      approvalIds: resolved.approvalIds,
      budget: resolved.budget,
      deadline: resolved.deadline
    }
    this.validate("RunSpec", spec)
    return { run: structuredClone(spec), lease: structuredClone(lease) }
  }
  dispatch(runId) {
    const { run, resolved } = this.reauthorizeRun(this.data, runId)
    if (
      ["succeeded", "failed", "cancelled", "outcome_unknown", "cancel_requested"].includes(
        run.status
      )
    )
      fail("OUTCOME_UNKNOWN")
    if (run.activeAttemptId) {
      const old = this.data.attempts.get(run.activeAttemptId)
      if (
        ["outcome_unknown", "cancel_requested", "succeeded", "failed", "cancelled"].includes(
          old.status
        ) ||
        expired(old.lease.expiresAt, this.now)
      )
        fail("OUTCOME_UNKNOWN")
      const spec = {
        ...resolved,
        schemaVersion: 1,
        runId,
        attemptId: old.id,
        taskId: run.taskId,
        stageId: run.stageId
      }
      for (const key of ["nodeId", "provider", "requestedCapabilities", "authorizationVersion"])
        delete spec[key]
      return { run: structuredClone(spec), lease: structuredClone(old.lease) }
    }
    if (this.nodes.get(resolved.nodeId).status !== "online") {
      if (run.status === "queued") move("RunStatus", run, "waiting_node")
      return { waiting: true }
    }
    return this.atomic((data) => {
      const draftRun = data.runs.get(runId)
      move("RunStatus", draftRun, "starting")
      return this.newAttempt(data, draftRun, resolved)
    })
  }
  connection(connection, run, attempt) {
    if (
      !connection?.authenticated ||
      connection.spaceId !== run.spaceId ||
      connection.nodeId !== attempt.runtimeNodeId ||
      connection.connectionId !== "connection-1"
    )
      fail("FORBIDDEN")
  }
  receiveEvent(connection, body) {
    this.validate("RuntimeEventBody", body)
    const { run, resolved } = this.reauthorizeRun(this.data, body.runId)
    const attempt = this.data.attempts.get(body.attemptId)
    if (!attempt || attempt.runId !== run.id || attempt.spaceId !== run.spaceId) fail("FORBIDDEN")
    this.connection(connection, run, attempt)
    if (
      body.nodeId !== connection.nodeId ||
      run.activeAttemptId !== attempt.id ||
      body.leaseId !== attempt.lease.leaseId ||
      body.fence !== attempt.lease.fence ||
      body.authorizationVersion !== attempt.lease.authorizationVersion ||
      body.authorizationVersion !== resolved.authorizationVersion ||
      expired(attempt.lease.expiresAt, this.now)
    )
      fail("FORBIDDEN")
    const key = `${run.spaceId}/${run.id}/${attempt.id}/${body.eventSeq}`
    const fingerprint = canonical(body)
    const prior = this.data.runtimeEvents.get(key)
    if (prior) {
      if (prior !== fingerprint) fail("COMMAND_CONFLICT")
      return {
        eventId: body.eventId,
        runId: run.id,
        attemptId: attempt.id,
        eventSeq: body.eventSeq
      }
    }
    if (this.data.eventIds.has(body.eventId)) fail("COMMAND_CONFLICT")
    if (body.eventSeq !== (this.data.watermarks.get(attempt.id) ?? 0) + 1)
      fail("OUTCOME_UNKNOWN", "Event sequence gap: replay/inspect, do not order by arrival")
    const data = structuredClone(this.data)
    const activeRun = data.runs.get(run.id)
    const activeAttempt = data.attempts.get(attempt.id)
    if (activeRun.status === "starting") move("RunStatus", activeRun, "running")
    if (activeAttempt.status === "dispatched") move("AttemptStatus", activeAttempt, "accepted")
    if (activeAttempt.status === "accepted") move("AttemptStatus", activeAttempt, "running")
    if (body.eventType === "artifact_committed") this.inputs(data, run.taskId, [body.data.artifact])
    if (body.eventType === "waiting_approval") {
      const approval = data.approvals.get(body.data.approvalId)
      if (!approval || approval.taskId !== run.taskId) fail("APPROVAL_REQUIRED")
      move("RunStatus", activeRun, "waiting_approval")
      move("AttemptStatus", activeAttempt, "waiting_approval")
    }
    if (body.eventType === "completed") {
      this.inputs(data, run.taskId, body.data.artifactVersions)
      move("RunStatus", activeRun, body.data.outcome)
      move("AttemptStatus", activeAttempt, body.data.outcome)
      activeAttempt.finishedAt = this.now
    }
    mutation(activeRun, this.now)
    data.runtimeEvents.set(key, fingerprint)
    data.eventIds.set(body.eventId, key)
    data.watermarks.set(attempt.id, body.eventSeq)
    this.data = data
    // ACK is constructed only after the simulated atomic persist.
    return { eventId: body.eventId, runId: run.id, attemptId: attempt.id, eventSeq: body.eventSeq }
  }
  cancelRun(context, runId, body) {
    return this.command(context, "POST", `/api/bot/v1/runs/${runId}/cancel`, body, {
      schema: "CancelRunRequest",
      target: (data) => this.entity(data, "runs", runId, context),
      effect: (data) => {
        const run = data.runs.get(runId)
        move("RunStatus", run, "cancel_requested")
        mutation(run, this.now)
        if (run.activeAttemptId)
          move("AttemptStatus", data.attempts.get(run.activeAttemptId), "cancel_requested")
        return { run }
      }
    })
  }
  nodeOffline(nodeId) {
    this.nodes.get(nodeId).status = "offline"
  }
  leaseLost(runId) {
    return this.atomic((data) => {
      const run = data.runs.get(runId)
      if (!run) fail("NOT_FOUND")
      const attempt = data.attempts.get(run.activeAttemptId)
      if (!attempt) fail("NOT_FOUND")
      move("RunStatus", run, "outcome_unknown")
      move("AttemptStatus", attempt, "outcome_unknown")
    })
  }
  inspectAndReconcile(
    connection,
    inspection,
    { externalReceiptVerified = false, executionStopped = false } = {}
  ) {
    this.validate("InspectionBody", inspection)
    return this.atomic((data) => {
      const { run } = this.reauthorizeRun(data, inspection.runId)
      const attempt = data.attempts.get(inspection.attemptId)
      if (!attempt) fail("NOT_FOUND")
      this.connection(connection, run, attempt)
      if (
        inspection.fence !== attempt.lease.fence ||
        run.activeAttemptId !== attempt.id ||
        inspection.lastEventSeq !== (data.watermarks.get(attempt.id) ?? 0)
      )
        fail(
          "OUTCOME_UNKNOWN",
          "Inspection must reconcile exact persisted high-water mark and current fence"
        )
      if (run.status === "outcome_unknown") {
        if (!externalReceiptVerified) fail("OUTCOME_UNKNOWN")
        if (!["running", "succeeded", "failed", "cancelled"].includes(inspection.status))
          fail("OUTCOME_UNKNOWN", "Inspection has not resolved the unknown execution outcome")
        const target = ["succeeded", "failed", "cancelled"].includes(inspection.status)
          ? inspection.status
          : "running"
        move("RunStatus", run, target, { reconcile: true })
        move("AttemptStatus", attempt, target, { reconcile: true })
        data.reconciled.set(attempt.id, true)
      } else if (["succeeded", "failed", "cancelled"].includes(inspection.status)) {
        if (!externalReceiptVerified) fail("OUTCOME_UNKNOWN")
        if (run.status === "starting" && inspection.status === "succeeded")
          move("RunStatus", run, "running")
        if (attempt.status === "dispatched") move("AttemptStatus", attempt, "accepted")
        if (attempt.status === "accepted" && inspection.status === "succeeded")
          move("AttemptStatus", attempt, "running")
        move("RunStatus", run, inspection.status)
        move("AttemptStatus", attempt, inspection.status)
      }
      if (inspection.checkpointRef)
        data.checkpoints.set(inspection.checkpointRef, {
          runId: run.id,
          nodeId: attempt.runtimeNodeId,
          provider: this.nodes.get(attempt.runtimeNodeId).provider,
          modeVersion: run.mode.version,
          inputDigest: inputDigest(run.inputArtifactVersions)
        })
      if (executionStopped) data.stopped.set(attempt.id, true)
      return { run: structuredClone(run), attempt: structuredClone(attempt) }
    })
  }
  resume(context, runId, checkpointRef) {
    const { run, resolved } = this.reauthorizeRun(this.data, runId)
    this.authorize(context, run)
    if (context.principalId !== run.requesterPrincipalId) fail("FORBIDDEN")
    if (
      ["succeeded", "failed", "cancelled", "outcome_unknown", "cancel_requested"].includes(
        run.status
      )
    )
      fail("OUTCOME_UNKNOWN")
    const old = this.data.attempts.get(run.activeAttemptId)
    const checkpoint = this.data.checkpoints.get(checkpointRef)
    const node = this.nodes.get(resolved.nodeId)
    if (!old || !this.data.stopped.get(old.id))
      fail("OUTCOME_UNKNOWN", "Old execution has not been proved stopped")
    if (old.status === "outcome_unknown" && !this.data.reconciled.get(old.id))
      fail("OUTCOME_UNKNOWN")
    if (node.status !== "online") fail("NODE_OFFLINE")
    if (
      node.capabilities.recovery !== "same_node_checkpoint" ||
      node.provider !== resolved.provider ||
      !checkpoint ||
      checkpoint.runId !== runId ||
      checkpoint.nodeId !== old.runtimeNodeId ||
      checkpoint.provider !== node.provider ||
      checkpoint.modeVersion !== run.mode.version ||
      checkpoint.inputDigest !== inputDigest(run.inputArtifactVersions)
    )
      fail("CAPABILITY_UNAVAILABLE")
    return this.atomic((data) => ({
      ...this.newAttempt(data, data.runs.get(runId), resolved),
      checkpointRef
    }))
  }
  retryDelivery(context, deliveryId) {
    const delivery = this.entity(this.data, "deliveries", deliveryId, context)
    move("DeliveryStatus", delivery, "pending")
    delivery.attempts++
    return structuredClone(delivery)
  }
  cursor(context, seq) {
    const id = this.id("cursor")
    this.data.cursors.set(id, { spaceId: context.spaceId, seq, expiresAt: fixture.expiry })
    return id
  }
  taskSnapshot(context, taskId) {
    const task = this.entity(this.data, "tasks", taskId, context)
    const seq = this.data.events.filter((e) => e.spaceId === context.spaceId).length
    return { task: structuredClone(task), snapshotCursor: this.cursor(context, seq) }
  }
  events(context, { after, limit = 200 } = {}) {
    this.authorize(context)
    this.validate("EventLimit", limit)
    const scoped = this.data.events.filter((e) => e.spaceId === context.spaceId)
    const head = scoped.length
    if (after === undefined)
      return { events: [], nextCursor: this.cursor(context, head), hasMore: false }
    const cursor = this.data.cursors.get(after)
    if (!cursor || cursor.spaceId !== context.spaceId || expired(cursor.expiresAt, this.now))
      fail("CURSOR_EXPIRED")
    const scan = scoped.filter((e) => e.seq > cursor.seq).slice(0, limit)
    const events = scan.filter((event) => {
      try {
        this.entity(this.data, "tasks", event.taskId, context)
        return true
      } catch (error) {
        if (["FORBIDDEN", "NOT_FOUND"].includes(error.code)) return false
        throw error
      }
    })
    const seq = scan.length ? scan.at(-1).seq : cursor.seq
    return {
      events: structuredClone(events),
      nextCursor: this.cursor(context, seq),
      hasMore: seq < head
    }
  }
}
