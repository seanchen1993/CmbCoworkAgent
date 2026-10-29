/** Read-only transcript assertions, never business-quality or execution authorization. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { posix, win32 } from "node:path"
import type { Message } from "../../src/main/types"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import type { HostResultReview } from "../../src/shared/project-runtime/host-types"
import type { CreatorProjectTrialJourney } from "../../src/shared/mods/creator-trial-journey"
import type { DevelopmentStatus } from "../../src/shared/mods/development"

export interface MutationRecordedCompletedTrial {
  passed: boolean
  created: LocalProjectView
  finalNativeCreatorStatus: {
    threadId: string
    projectTrial: { digest: string; journey: CreatorProjectTrialJourney }
  }
  events: Array<{
    type: string
    projectLeg?: string
    projectId?: string
    stage?: string
    stageIndex?: number
    status?: string
    operation?: LocalProjectView["operations"][number]
    review?: HostResultReview
  }>
}

/** Preserve a failed acceptance report while verifying its independently completed native trial. */
export function assertMutationRecordedCompletedTrial(
  recorded: Partial<MutationRecordedCompletedTrial>,
  current?: LocalProjectView
) {
  assert.equal(recorded.passed, false, "Historical failed acceptance must remain failed")
  const created = recorded.created
  const final = recorded.finalNativeCreatorStatus
  assert(created && final?.projectTrial?.journey && Array.isArray(recorded.events))
  const project = created.project
  const journey = final.projectTrial.journey
  const stages = project.manifest.stages
  assert.equal(stages.length, 8, "Only the recorded complete eight-stage trial may resume")
  assert.match(project.installedPluginId, /^dev-project-preview:[a-f0-9-]{36}$/)
  assert.equal(project.status, "active")
  assert.equal(project.stageIndex, 0)
  assert.equal(created.operations.length, 0)
  assert.equal(journey.projectId, project.projectId)
  assert.equal(journey.workspace, project.workspace)
  assert.equal(journey.creatorThreadId, final.threadId)
  assert.equal(journey.candidateDigest, final.projectTrial.digest)
  assert.equal(journey.candidateCurrent, true)
  assert.equal(journey.phase, "passed")
  assert.equal(journey.canDeliver, true)
  assert.equal(journey.operationsTruncated, false)
  assert.deepEqual(
    journey.stages.map((stage) => stage.id),
    stages.map((stage) => stage.id)
  )
  const settled = recorded.events.filter(
    (event) => event.type === "stage-settled" && event.projectLeg === "creator-trial"
  )
  const advanced = recorded.events.filter(
    (event) => event.type === "native-advance" && event.projectLeg === "creator-trial"
  )
  assert.equal(settled.length, stages.length)
  assert.equal(advanced.length, stages.length)
  const operations = stages.map((stage, index) => {
    const event = settled[index]
    const operation = event.operation
    assert(operation)
    assert.equal(event.projectId, project.projectId)
    assert.equal(event.stage, stage.id)
    assert.equal(event.stageIndex, index)
    assert.equal(operation.projectId, project.projectId)
    assert.equal(operation.pluginDigest, project.pluginDigest)
    assert.equal(operation.stageId, stage.id)
    assert.equal(operation.expectedVersion, project.version + index)
    assert.equal(operation.status, "succeeded")
    assert.equal(operation.execution?.terminal?.outcome, "success")
    assert(operation.execution?.threadId && operation.receipts.length > 0)
    assert.deepEqual(
      operation.receipts.map((receipt) => receipt.checkId).sort(),
      [...stage.checkIds].sort()
    )
    assert(operation.receipts.every((receipt) => receipt.result === "passed"))
    const projected = journey.stages[index]
    assert.equal(projected.status, "passed")
    assert.deepEqual(
      projected.checks,
      operation.receipts.map((receipt) => ({
        id: receipt.checkId,
        artifactId: project.manifest.checks.find((check) => check.id === receipt.checkId)
          ?.artifactId,
        result: receipt.result,
        checkedAt: receipt.checkedAt,
        validatorVersion: receipt.validatorVersion
      }))
    )
    assert.deepEqual(projected.sessions, [
      {
        threadId: operation.execution.threadId,
        operationId: operation.operationId,
        status: "transitioned",
        terminalOutcome: "success"
      }
    ])
    assert.deepEqual(advanced[index], {
      type: "native-advance",
      projectLeg: "creator-trial",
      projectId: project.projectId,
      stage: stage.id,
      stageIndex: index + 1,
      status: index + 1 === stages.length ? "completed" : "active"
    })
    const reviews = recorded.events!.filter(
      (item) =>
        item.type === "native-result-approval" &&
        item.projectLeg === "creator-trial" &&
        item.stage === stage.id
    )
    assert.equal(
      reviews.length,
      stage.resultApproval === "human" ? 1 : 0,
      "Each required native result approval must retain one original review event"
    )
    if (reviews.length) {
      const review = reviews[0].review
      assert(review)
      assert(recorded.events!.indexOf(event) < recorded.events!.indexOf(reviews[0]))
      assert(recorded.events!.indexOf(reviews[0]) < recorded.events!.indexOf(advanced[index]))
      assert.deepEqual(review, {
        operationId: operation.operationId,
        expectedVersion: operation.expectedVersion,
        inputFingerprint: operation.inputFingerprint,
        pluginDigest: operation.pluginDigest,
        artifactFingerprint: review.artifactFingerprint,
        receiptFingerprint: review.receiptFingerprint,
        policyDigest: review.policyDigest
      })
      for (const digest of [
        review.artifactFingerprint,
        review.receiptFingerprint,
        review.policyDigest
      ])
        assert.match(digest, /^[a-f0-9]{64}$/)
    }
    return operation
  })
  assert.equal(new Set(operations.map((operation) => operation.operationId)).size, stages.length)
  if (current) {
    assert.deepEqual(current.project, {
      ...project,
      status: "completed",
      stageIndex: stages.length,
      version: project.version + stages.length,
      updatedAt: current.project.updatedAt
    })
    assert(current.project.updatedAt >= project.updatedAt)
    assert.equal(current.inputWait, undefined)
    assert.equal(current.migrationReview, undefined)
    assert.equal(current.resultReview, undefined)
    assert(!current.resultApprovalRequired)
    assert.equal(current.operations.length, operations.length)
    for (const operation of operations) {
      const actual = current.operations.find((item) => item.operationId === operation.operationId)
      assert(actual)
      assert(actual.updatedAt >= operation.updatedAt)
      const expected = { ...operation, status: "transitioned", updatedAt: actual.updatedAt }
      const review = recorded.events!.find(
        (event) =>
          event.type === "native-result-approval" &&
          event.projectLeg === "creator-trial" &&
          event.stage === operation.stageId
      )?.review
      if (review && operation.resultApproval == null) {
        const approval = actual.resultApproval
        assert(approval, "Recorded native result approval must remain present")
        assert.deepEqual(approval, {
          ...review,
          decision: "approved",
          actorId: "desktop-user",
          decidedAt: approval.decidedAt
        })
        assert(Number.isSafeInteger(approval.decidedAt))
        assert(approval.decidedAt >= operation.updatedAt)
        assert(approval.decidedAt >= operation.execution!.terminal!.settledAt)
        assert(operation.receipts.every((receipt) => approval.decidedAt >= receipt.checkedAt))
        assert(approval.decidedAt <= actual.updatedAt)
        assert(actual.updatedAt <= current.project.updatedAt)
        expected.resultApproval = approval
      }
      assert.deepEqual(actual, expected)
    }
  }
  return { projectId: project.projectId, workspace: project.workspace, operations }
}

export interface MutationRecordedE2eTrialResume {
  passed: boolean
  acceptanceRun: string
  mutation: string
  originalProfile: string
  originalAuthorEvidenceSha256: string
  source: { directory: string; inputSourceSha256: string }
  candidate: { sha256: string; path: string; execution: string }
  application: { sha256: string; entry: string; execution: string; path: string; packaged: boolean }
  compilation: unknown
  created: LocalProjectView
  finalNativeCreatorStatus: Pick<DevelopmentStatus, "threadId" | "workspace" | "projectTrial">
  events: Array<MutationRecordedCompletedTrial["events"][number] & Record<string, unknown>>
  errors: string[]
  resume?: unknown
  creatorTrial?: unknown
  creatorDelivery?: unknown
  completed?: unknown
}

/** Only the original first E2E configuration visibility failure, never an arbitrary failed run. */
export function assertMutationRecordedE2eTrialResume(
  recorded: Partial<MutationRecordedE2eTrialResume>,
  observed?: {
    view: LocalProjectView
    creator: Pick<DevelopmentStatus, "threadId" | "workspace" | "projectTrial">
    identity: { threadId: string; requestId: string; revision: number; candidateDigest: string }
    source: MutationRecordedE2eTrialResume["source"]
    compilation: unknown
    authorEvidenceSha256: string
  }
) {
  assert.equal(recorded.passed, false)
  assert.equal(recorded.acceptanceRun, "creator-trial-save-start-use-and-ordinary-project")
  assert.equal(recorded.mutation, "append-e2e")
  for (const key of ["resume", "creatorTrial", "creatorDelivery", "completed"] as const)
    assert.equal(recorded[key], undefined, "Only the original interrupted trial may resume")
  const created = recorded.created
  const native = recorded.finalNativeCreatorStatus
  const request = native?.projectTrial
  const journey = request?.journey
  assert(created && native && request && journey && Array.isArray(recorded.events))
  assert(recorded.source && recorded.compilation && recorded.candidate && recorded.application)
  assert.equal(recorded.application.sha256, recorded.candidate.sha256)
  assert.equal(recorded.application.entry, recorded.candidate.path)
  assert.equal(recorded.application.path, recorded.originalProfile)
  assert.equal(recorded.application.execution, "normal-built-Electron")
  assert.equal(recorded.application.packaged, false)
  assert.equal(recorded.candidate.execution, "built-output")
  for (const digest of [
    recorded.source.inputSourceSha256,
    recorded.candidate.sha256,
    recorded.originalAuthorEvidenceSha256,
    request.digest
  ])
    assert.match(digest!, /^[a-f0-9]{64}$/)
  const project = created.project
  assert.match(project.installedPluginId, /^dev-project-preview:[a-f0-9-]{36}$/)
  assert.equal(project.status, "active")
  assert.equal(project.stageIndex, 0)
  assert.equal(project.version, 1)
  assert.deepEqual(created.operations, [])
  const stages = project.manifest.stages
  assert.deepEqual(
    stages.map((stage) => stage.id),
    ["convert", "prd", "specs", "design", "plan", "code", "cicd", "archive", "e2e"]
  )
  assert.equal(journey.projectId, project.projectId)
  assert.equal(journey.workspace, project.workspace)
  assert.equal(journey.creatorThreadId, native.threadId)
  assert.equal(journey.candidateDigest, request.digest)
  assert.equal(journey.candidateCurrent, true)
  assert.equal(journey.operationsTruncated, false)
  assert.equal(journey.canDeliver, false)
  assert.equal(journey.phase, "not-started")
  assert.equal(request.goal, project.goal)
  assert.deepEqual(
    journey.stages.map((stage) => stage.id),
    stages.map((stage) => stage.id)
  )
  const pending = journey.stages[8]
  assert.equal(pending.status, "pending")
  assert.deepEqual(pending.sessions, [])
  assert(pending.checks.length && pending.checks.every((check) => check.result === "unknown"))

  const events = recorded.events
  const failures = events.filter((event) => event.type === "primary-failure")
  assert.equal(failures.length, 1)
  const failure = failures[0]
  assert(typeof failure.error === "string" && Number.isSafeInteger(failure.at))
  assert(failure.error.startsWith("TimeoutError: locator.fill: Timeout 20000ms exceeded."))
  assert(failure.error.includes(`plugin-param-${project.installedPluginId}-e2eSubjects`))
  assert(failure.error.includes("element is not visible"))
  assert.deepEqual(recorded.errors, [failure.error])
  const afterFailure = events.slice(events.indexOf(failure) + 1)
  assert.deepEqual(
    afterFailure.map((event) => event.type),
    ["application-process-exit", "application-close"]
  )
  assert.equal(afterFailure[0].code, 0)
  assert.equal(afterFailure[0].signal, null)
  assert(
    afterFailure.every(
      (event) => Number.isSafeInteger(event.at) && Number(event.at) >= Number(failure.at)
    )
  )
  const settled = events.filter((event) => event.type === "stage-settled")
  const advanced = events.filter((event) => event.type === "native-advance")
  assert.equal(settled.length, 8)
  assert.equal(advanced.length, 8)
  assert.equal(
    events.filter((event) => event.type === "native-result-approval").length,
    stages.slice(0, 8).filter((stage) => stage.resultApproval === "human").length
  )
  const operations = stages.slice(0, 8).map((stage, index) => {
    const event = settled[index]
    const operation = event.operation
    assert(operation)
    assert.equal(event.projectLeg, "creator-trial")
    assert.equal(event.projectId, project.projectId)
    assert.equal(event.stageIndex, index)
    assert.equal(event.stage, stage.id)
    assert.equal(operation.projectId, project.projectId)
    assert.equal(operation.pluginDigest, project.pluginDigest)
    assert.equal(operation.stageId, stage.id)
    assert.equal(operation.expectedVersion, index + 1)
    assert.equal(operation.status, "succeeded")
    assert.equal(operation.execution?.terminal?.outcome, "success")
    assert(operation.execution?.threadId && operation.receipts.length)
    assert(operation.receipts.every((receipt) => receipt.result === "passed"))
    assert.deepEqual(
      operation.receipts.map((receipt) => receipt.checkId).sort(),
      [...stage.checkIds].sort()
    )
    const projected = journey.stages[index]
    assert.equal(projected.status, "passed")
    assert.deepEqual(
      projected.checks,
      operation.receipts.map((receipt) => ({
        id: receipt.checkId,
        artifactId: project.manifest.checks.find((check) => check.id === receipt.checkId)
          ?.artifactId,
        result: receipt.result,
        checkedAt: receipt.checkedAt,
        validatorVersion: receipt.validatorVersion
      }))
    )
    assert.deepEqual(projected.sessions, [
      {
        threadId: operation.execution.threadId,
        operationId: operation.operationId,
        status: "transitioned",
        terminalOutcome: "success"
      }
    ])
    assert.deepEqual(advanced[index], {
      type: "native-advance",
      projectLeg: "creator-trial",
      projectId: project.projectId,
      stage: stage.id,
      stageIndex: index + 1,
      status: "active"
    })
    assert(events.indexOf(event) < events.indexOf(advanced[index]))
    if (index) assert(events.indexOf(advanced[index - 1]) < events.indexOf(event))
    assert(events.indexOf(advanced[index]) < events.indexOf(failure))
    const reviews = events.filter(
      (item) =>
        item.type === "native-result-approval" &&
        item.projectLeg === "creator-trial" &&
        item.stage === stage.id
    )
    assert.equal(reviews.length, stage.resultApproval === "human" ? 1 : 0)
    if (reviews.length) {
      assert(events.indexOf(event) < events.indexOf(reviews[0]))
      assert(events.indexOf(reviews[0]) < events.indexOf(advanced[index]))
    }
    return operation
  })
  assert.equal(new Set(operations.map((operation) => operation.operationId)).size, 8)
  if (observed) {
    const { view, creator, identity } = observed
    assert.equal(recorded.source.directory, observed.source.directory)
    assert.equal(recorded.source.inputSourceSha256, observed.source.inputSourceSha256)
    assert.deepEqual(recorded.compilation, observed.compilation)
    assert.equal(recorded.originalAuthorEvidenceSha256, observed.authorEvidenceSha256)
    assert.equal(identity.threadId, native.threadId)
    assert.equal(identity.requestId, request.id)
    assert.equal(identity.revision, request.revision)
    assert.equal(identity.candidateDigest, request.digest)
    assert.equal(creator.threadId, native.threadId)
    assert.equal(creator.workspace, native.workspace)
    assert.deepEqual(creator.projectTrial, request)
    assert.deepEqual(view.project, {
      ...project,
      version: 9,
      stageIndex: 8,
      status: "active",
      updatedAt: view.project.updatedAt
    })
    assert(
      view.project.updatedAt >= project.updatedAt && view.project.updatedAt <= Number(failure.at)
    )
    for (const key of [
      "inputWait",
      "resultReview",
      "resultReviewError",
      "migrationReview",
      "continuation",
      "importedSource"
    ] as const)
      assert.equal(view[key], undefined)
    assert(!view.resultApprovalRequired)
    assert.equal(
      view.operations.length,
      8,
      "No new, active, unknown or E2E attempt may be borrowed"
    )
    for (const operation of operations) {
      const actual = view.operations.find((item) => item.operationId === operation.operationId)
      assert(actual)
      assert(actual.updatedAt >= operation.updatedAt && actual.updatedAt <= view.project.updatedAt)
      const expected = { ...operation, status: "transitioned", updatedAt: actual.updatedAt }
      const review = events.find(
        (event) =>
          event.type === "native-result-approval" &&
          event.projectLeg === "creator-trial" &&
          event.stage === operation.stageId
      )?.review
      if (review && operation.resultApproval == null) {
        const approval = actual.resultApproval
        assert(approval)
        assert.deepEqual(review, {
          operationId: operation.operationId,
          expectedVersion: operation.expectedVersion,
          inputFingerprint: operation.inputFingerprint,
          pluginDigest: operation.pluginDigest,
          artifactFingerprint: review.artifactFingerprint,
          receiptFingerprint: review.receiptFingerprint,
          policyDigest: review.policyDigest
        })
        assert.deepEqual(approval, {
          ...review,
          decision: "approved",
          actorId: "desktop-user",
          decidedAt: approval.decidedAt
        })
        assert(
          Number.isSafeInteger(approval.decidedAt) && approval.decidedAt >= operation.updatedAt
        )
        assert(approval.decidedAt >= operation.execution!.terminal!.settledAt)
        assert(operation.receipts.every((receipt) => approval.decidedAt >= receipt.checkedAt))
        assert(approval.decidedAt <= actual.updatedAt)
        expected.resultApproval = approval
      }
      assert.deepEqual(
        actual,
        expected,
        "Original operation, execution and receipts must be unchanged"
      )
    }
  }
  return { projectId: project.projectId, workspace: project.workspace, operations }
}

export type MutationNativeMessage = Pick<
  Message,
  | "id"
  | "role"
  | "content"
  | "tool_calls"
  | "tool_call_id"
  | "status"
  | "is_error"
  | "name"
  | "recovery_integrity"
>

export interface MutationNativeFile {
  path: string
  bytes: Uint8Array
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

function pathKey(value: string) {
  assert(typeof value === "string" && value.length > 0, "NATIVE_READ_PATH_REQUIRED")
  if (/^[a-z]:[\\/]|^(?:\\\\|\/\/)/i.test(value))
    return win32.normalize(value).replaceAll("\\", "/").toLowerCase()
  assert(posix.isAbsolute(value), "NATIVE_READ_ABSOLUTE_PATH_REQUIRED")
  return posix.normalize(value)
}

function messageText(message: MutationNativeMessage) {
  assert.notEqual(message.recovery_integrity, "unverified", "NATIVE_READ_UNVERIFIED_PREVIEW")
  if (typeof message.content === "string") return message.content
  assert(Array.isArray(message.content), "NATIVE_READ_TEXT_REQUIRED")
  return message.content
    .map((part) => {
      assert(part.type === "text" && typeof part.text === "string", "NATIVE_READ_TEXT_REQUIRED")
      return part.text
    })
    .join("\n")
}

/** LocalSandbox emits 6-column line labels and 10000-character continuation chunks. */
function expectedNativeText(bytes: Uint8Array) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  assert(source.trim(), "NATIVE_READ_NONEMPTY_UTF8_REQUIRED")
  const lines = source.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const formatted = lines.flatMap((line, index) => {
    const chunks = Math.max(1, Math.ceil(line.length / 10000))
    return Array.from({ length: chunks }, (_, chunk) => {
      const label = String(chunk === 0 ? index + 1 : `${index + 1}.${chunk}`).padStart(6)
      return `${label}\t${line.slice(chunk * 10000, (chunk + 1) * 10000)}`
    })
  })
  return { formatted: formatted.join("\n"), visible: lines.join("\n") }
}

/**
 * Audit one completed stage's own getMessages response against caller-pinned files.
 * The caller binds the native operation/thread, package digest and workspace.
 * No file lookup, DB mutation, model request, or inferred artifact location occurs here.
 */
export function assertMutationNativeConsumption(input: {
  messages: readonly MutationNativeMessage[]
  selectedSkill: MutationNativeFile
  inputs: readonly MutationNativeFile[]
}) {
  const { messages, selectedSkill, inputs } = input
  const expectedSkill = pathKey(selectedSkill.path)
  const selected = messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      [
        ...messageText(message).matchAll(
          /<CMBDEVCLAW-SKILL-USE-V1>[\s\S]*?<\/CMBDEVCLAW-SKILL-USE-V1>/g
        )
      ].map(([block]) => {
        const paths = [...block.matchAll(/<path>([^<]+)<\/path>/g)]
        assert.equal(paths.length, 1, "NATIVE_SELECTED_SKILL_PATH_REQUIRED")
        return { messageId: message.id, path: pathKey(paths[0][1]) }
      })
    )
  assert.equal(selected.length, 1, "NATIVE_SELECTED_SKILL_BLOCK_REQUIRED")
  assert.equal(selected[0].path, expectedSkill, "NATIVE_SELECTED_SKILL_CHANGED")

  const calls = messages.flatMap((message, messageIndex) =>
    message.role === "assistant"
      ? (message.tool_calls ?? []).map((call) => ({ call, message, messageIndex }))
      : []
  )
  const reads = calls.filter(({ call }) => call.name === "read_file")
  for (const { call } of reads) {
    const file = call.args.file_path
    assert(typeof file === "string", "NATIVE_READ_PATH_REQUIRED")
    if (/[\\/]SKILL\.md$/i.test(file))
      assert.equal(pathKey(file), expectedSkill, "NATIVE_SELECTED_SKILL_READ_CHANGED")
  }
  const expectedPaths = [selectedSkill, ...inputs].map((file) => pathKey(file.path))
  assert.equal(
    new Set(expectedPaths).size,
    expectedPaths.length,
    "NATIVE_READ_DUPLICATE_EXPECTATION"
  )

  function verify(file: MutationNativeFile) {
    const expected = expectedNativeText(file.bytes)
    const matches = reads.filter(
      ({ call }) => pathKey(String(call.args.file_path)) === pathKey(file.path)
    )
    assert(matches.length > 0, "NATIVE_EXPECTED_READ_REQUIRED")
    const verified = matches.map(({ call, message, messageIndex }) => {
      assert(call.id && message.id, "NATIVE_READ_ID_REQUIRED")
      assert.notEqual(message.recovery_integrity, "unverified", "NATIVE_READ_UNVERIFIED_PREVIEW")
      assert.equal(
        calls.filter((other) => other.call.id === call.id).length,
        1,
        "NATIVE_READ_CALL_ID_AMBIGUOUS"
      )
      assert(call.args.offset === undefined || call.args.offset === 0, "NATIVE_READ_PARTIAL_RANGE")
      const responses = messages
        .map((response, index) => ({ response, index }))
        .filter(({ response }) => response.role === "tool" && response.tool_call_id === call.id)
      assert.equal(responses.length, 1, "NATIVE_MATCHING_READ_RESPONSE_REQUIRED")
      const { response, index } = responses[0]
      assert(index > messageIndex && response.id, "NATIVE_READ_RESPONSE_ORDER_INVALID")
      assert(
        response.name === undefined || response.name === "read_file",
        "NATIVE_READ_RESPONSE_NAME_INVALID"
      )
      assert(
        response.is_error !== true &&
          (response.status === undefined || response.status === "success"),
        "NATIVE_READ_FAILED"
      )
      const text = messageText(response)
      assert(
        !/^(?:Error\b|ToolException:|Error executing tool|Tool execution failed|Permission denied)/i.test(
          text.trimStart()
        ),
        "NATIVE_READ_FAILED"
      )
      // Native hooks append feedback after the complete numbered file, outside its content.
      const body = text.split(/\n\n(?=\[Hook (?:output|context|notice|requested review)\])/)[0]
      assert.equal(hash(body), hash(expected.formatted), "NATIVE_READ_CURRENT_CONTENT_REQUIRED")
      const continuation = messages.slice(index + 1).find((next) => next.role === "assistant")
      assert(continuation?.id, "NATIVE_READ_ASSISTANT_CONTINUATION_REQUIRED")
      return {
        toolCallId: call.id,
        callMessageId: message.id,
        responseMessageId: response.id,
        continuedByMessageId: continuation.id,
        responseSha256: hash(text)
      }
    })
    return {
      path: file.path,
      expectedFileSha256: hash(file.bytes),
      // read_file omits the final LF; this is the complete content visible to the model.
      visibleContentSha256: hash(expected.visible),
      reads: verified
    }
  }

  return {
    selectedSkill: { selectionMessageId: selected[0].messageId, ...verify(selectedSkill) },
    inputs: inputs.map(verify)
  }
}
