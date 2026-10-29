/** Pure transcript contracts; no Electron, DB, model, or business-quality claim. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { projectBuiltPreview } from "./support/project-built-preview"
import {
  assertMutationNativeConsumption,
  assertMutationRecordedCompletedTrial,
  assertMutationRecordedE2eTrialResume,
  type MutationRecordedCompletedTrial,
  type MutationRecordedE2eTrialResume,
  type MutationNativeMessage
} from "./support/autobiz-mutation-native-consumption"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"

const skill = {
  path: "C:/owned/packages/current/skills/native-acceptance/SKILL.md",
  bytes: Buffer.from("---\nname: acceptance\n---\n读取当前需求并输出验收用例。\n")
}
const artifact = {
  path: "C:/owned/trial-workspace/SPECS.bundle.json",
  bytes: Buffer.from('{"feature":"orders","stage":"specs","revision":2}')
}
const numbered = (text: string) =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join("\n")

function fixture(): MutationNativeMessage[] {
  return [
    {
      id: "native-selection",
      role: "user",
      content: `<CMBDEVCLAW-SKILL-USE-V1>\n<name>acceptance</name>\n<path>${skill.path}</path>\n</CMBDEVCLAW-SKILL-USE-V1>`
    },
    {
      id: "native-reads",
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "read-skill", name: "read_file", args: { file_path: skill.path } },
        { id: "read-specs", name: "read_file", args: { file_path: artifact.path } }
      ]
    },
    {
      id: "skill-response",
      role: "tool",
      name: "read_file",
      status: "success",
      tool_call_id: "read-skill",
      content: numbered(skill.bytes.toString())
    },
    {
      id: "specs-response",
      role: "tool",
      name: "read_file",
      status: "success",
      tool_call_id: "read-specs",
      content: numbered(artifact.bytes.toString())
    },
    { id: "next-native-model-step", role: "assistant", content: "阶段产物已生成" }
  ]
}

let checks = 0
function check(name: string, run: () => void) {
  run()
  checks++
  console.log(`PASS ${name}`)
}
function rejects(change: (messages: MutationNativeMessage[]) => void, diagnostic: string) {
  const messages = fixture()
  change(messages)
  assert.throws(
    () => assertMutationNativeConsumption({ messages, selectedSkill: skill, inputs: [artifact] }),
    new RegExp(diagnostic)
  )
}

check("pins native selected Skill, paired current UTF-8 content and subsequent model step", () => {
  const result = assertMutationNativeConsumption({
    messages: fixture(),
    selectedSkill: skill,
    inputs: [artifact]
  })
  assert.equal(result.selectedSkill.selectionMessageId, "native-selection")
  assert.equal(result.selectedSkill.reads[0].toolCallId, "read-skill")
  assert.equal(result.inputs[0].reads[0].continuedByMessageId, "next-native-model-step")
  assert.match(result.inputs[0].expectedFileSha256, /^[a-f0-9]{64}$/)
  assert(!JSON.stringify(result).includes("读取当前需求"))
})
check(
  "rejects the original Skill selection and an old Skill read even with a current response",
  () => {
    rejects((messages) => {
      messages[0].content = String(messages[0].content).replace("native-acceptance", "native-specs")
    }, "NATIVE_SELECTED_SKILL_CHANGED")
    rejects((messages) => {
      messages[1].tool_calls![0].args.file_path = skill.path.replace(
        "native-acceptance",
        "native-specs"
      )
    }, "NATIVE_SELECTED_SKILL_READ_CHANGED")
  }
)
check("rejects missing, mismatched, duplicate and out-of-order native tool responses", () => {
  rejects((messages) => {
    messages.splice(3, 1)
  }, "NATIVE_MATCHING_READ_RESPONSE_REQUIRED")
  rejects((messages) => {
    messages[3].tool_call_id = "unrelated-call"
  }, "NATIVE_MATCHING_READ_RESPONSE_REQUIRED")
  rejects((messages) => {
    messages.splice(4, 0, { ...messages[3], id: "duplicate" })
  }, "NATIVE_MATCHING_READ_RESPONSE_REQUIRED")
  rejects((messages) => {
    messages.unshift(messages.splice(3, 1)[0])
  }, "NATIVE_READ_RESPONSE_ORDER_INVALID")
})
check("rejects failed or unknown reads, error text and unverified transcript previews", () => {
  rejects((messages) => {
    messages[3].is_error = true
  }, "NATIVE_READ_FAILED")
  rejects((messages) => {
    messages[3].status = "error"
  }, "NATIVE_READ_FAILED")
  rejects((messages) => {
    messages[3].status = "unknown"
  }, "NATIVE_READ_FAILED")
  rejects((messages) => {
    messages[3].content = "Error reading file: denied"
  }, "NATIVE_READ_FAILED")
  rejects((messages) => {
    messages[3].recovery_integrity = "unverified"
  }, "NATIVE_READ_UNVERIFIED_PREVIEW")
})
check("rejects old artifact bytes, incomplete pages and missing assistant continuation", () => {
  rejects((messages) => {
    messages[2].content = numbered("---\nname: specs\n---\n旧技能\n")
  }, "NATIVE_READ_CURRENT_CONTENT_REQUIRED")
  rejects((messages) => {
    messages[3].content = numbered('{"feature":"orders","stage":"specs","revision":1}')
  }, "NATIVE_READ_CURRENT_CONTENT_REQUIRED")
  rejects((messages) => {
    messages[3].content = `[Lines 1-1 of 2. Use offset=1 to read more.]\n${messages[3].content}`
  }, "NATIVE_READ_CURRENT_CONTENT_REQUIRED")
  rejects((messages) => {
    messages[1].tool_calls![1].args.offset = 1
  }, "NATIVE_READ_PARTIAL_RANGE")
  rejects((messages) => {
    messages.pop()
  }, "NATIVE_READ_ASSISTANT_CONTINUATION_REQUIRED")
})
check("rejects the same filename in another workspace and duplicate call identities", () => {
  rejects((messages) => {
    messages[1].tool_calls![1].args.file_path = artifact.path.replace(
      "trial-workspace",
      "old-workspace"
    )
  }, "NATIVE_EXPECTED_READ_REQUIRED")
  rejects((messages) => {
    messages[1].tool_calls!.push({ id: "read-specs", name: "other_tool", args: {} })
  }, "NATIVE_READ_CALL_ID_AMBIGUOUS")
})
check("accepts native text blocks and Hook feedback without treating feedback as source", () => {
  const messages = fixture()
  messages[3].content = [
    { type: "text", text: `${messages[3].content}\n\n[Hook output]\nread audited` }
  ]
  const result = assertMutationNativeConsumption({
    messages,
    selectedSkill: skill,
    inputs: [artifact]
  })
  assert.equal(result.inputs[0].reads.length, 1)
  rejects((rows) => {
    rows[3].content = `     1\tstale\n\n[Hook output]\n${numbered(artifact.bytes.toString())}`
  }, "NATIVE_READ_CURRENT_CONTENT_REQUIRED")
})
check("checks every read rather than allowing a newer response to hide stale content", () => {
  const messages = fixture()
  messages.splice(
    4,
    0,
    {
      id: "reread",
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "read-specs-again", name: "read_file", args: { file_path: artifact.path } }
      ]
    },
    {
      id: "reread-response",
      role: "tool",
      tool_call_id: "read-specs-again",
      content: numbered(artifact.bytes.toString())
    }
  )
  messages[3].content = "     1\tstale"
  assert.throws(
    () => assertMutationNativeConsumption({ messages, selectedSkill: skill, inputs: [artifact] }),
    /NATIVE_READ_CURRENT_CONTENT_REQUIRED/
  )
})

function completedTrialFixture(
  names = ["convert", "prd", "acceptance", "design", "plan", "code", "cicd", "archive"]
) {
  const project: LocalProjectView["project"] = {
    schemaVersion: 1,
    stateOwner: "host",
    version: 1,
    stageIndex: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    projectId: "project-one",
    name: "Original native trial",
    goal: "test",
    workspace: "C:/owned/trial",
    installedPluginId: "dev-project-preview:11111111-1111-4111-8111-111111111111",
    packageId: "autobiz",
    packageVersion: "1",
    pluginDigest: "a".repeat(64),
    manifest: {
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: "autobiz", version: "1" },
      mode: "host",
      stateOwner: "host",
      stages: names.map((id) => ({
        id,
        title: id,
        skill: `skills/native-${id}/SKILL.md`,
        actionIds: [],
        artifactIds: [id],
        checkIds: [`${id}.shape`],
        approval: "none"
      })),
      artifacts: names.map((id) => ({ id, path: `${id}.json`, required: true })),
      checks: names.map((id) => ({
        id: `${id}.shape`,
        kind: "file-exists",
        artifactId: id,
        sideEffect: "read"
      })),
      actions: [],
      environment: [],
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: true
      }
    }
  }
  const operations: LocalProjectView["operations"] = names.map((id, index) => ({
    schemaVersion: 1,
    operationId: `operation-${id}`,
    projectId: project.projectId,
    pluginDigest: project.pluginDigest,
    expectedVersion: index + 1,
    stageId: id,
    idempotencyKey: id,
    inputFingerprint: "original-input",
    status: "succeeded",
    createdAt: 2,
    updatedAt: 3,
    startedAt: 2,
    cancelRequestedAt: null,
    approval: null,
    resultApproval: null,
    execution: {
      threadId: `thread-${id}`,
      terminal: { outcome: "success", code: "project_actions_complete", settledAt: 3 }
    },
    receipts: [
      {
        schemaVersion: 1,
        operationId: `operation-${id}`,
        projectId: project.projectId,
        stageId: id,
        pluginDigest: project.pluginDigest,
        inputFingerprint: "original-input",
        checkId: `${id}.shape`,
        artifactFingerprint: "original-artifact",
        result: "passed",
        validatorVersion: "native/v1",
        checkedAt: 3
      }
    ]
  }))
  const record: MutationRecordedCompletedTrial = {
    passed: false,
    created: { project, operations: [] },
    finalNativeCreatorStatus: {
      threadId: "creator",
      projectTrial: {
        digest: "candidate",
        journey: {
          projectId: project.projectId,
          creatorThreadId: "creator",
          candidateDigest: "candidate",
          candidateCurrent: true,
          workspace: project.workspace,
          phase: "passed",
          canDeliver: true,
          operationsTruncated: false,
          diagnostics: [],
          stages: names.map((id, index) => ({
            id,
            title: id,
            status: "passed",
            artifacts: [project.manifest.artifacts[index]],
            checks: [
              {
                id: `${id}.shape`,
                artifactId: id,
                result: "passed",
                validatorVersion: "native/v1",
                checkedAt: 3
              }
            ],
            sessions: [
              {
                threadId: `thread-${id}`,
                operationId: `operation-${id}`,
                status: "transitioned",
                terminalOutcome: "success"
              }
            ]
          }))
        }
      }
    },
    events: operations.flatMap((operation, index) => [
      {
        type: "stage-settled",
        projectLeg: "creator-trial",
        projectId: project.projectId,
        stage: operation.stageId,
        stageIndex: index,
        operation
      },
      {
        type: "native-advance",
        projectLeg: "creator-trial",
        projectId: project.projectId,
        stage: operation.stageId,
        stageIndex: index + 1,
        status: index === 7 ? "completed" : "active"
      }
    ])
  }
  const current: LocalProjectView = {
    project: {
      ...structuredClone(project),
      version: 9,
      stageIndex: 8,
      status: "completed",
      updatedAt: 10
    },
    operations: operations.map((operation) => ({
      ...structuredClone(operation),
      status: "transitioned",
      updatedAt: 4
    }))
  }
  return { record, current }
}

check("retains failed acceptance while proving all native stages completed without replay", () => {
  const { record, current } = completedTrialFixture()
  const before = JSON.stringify(record)
  assertMutationRecordedCompletedTrial(record)
  assert.equal(assertMutationRecordedCompletedTrial(record, current).operations.length, 8)
  assert.equal(JSON.stringify(record), before)
  assert.equal(record.passed, false)
})
check("rejects incomplete or duplicate native settlement and advance coverage", () => {
  for (const type of ["stage-settled", "native-advance"]) {
    const { record, current } = completedTrialFixture()
    record.events.splice(
      record.events.findIndex((event) => event.type === type),
      1
    )
    assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
  }
  const { record, current } = completedTrialFixture()
  record.events[2] = structuredClone(record.events[0])
  assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
})
check("rejects a different project, package, manifest, or unknown operation", () => {
  for (const mutate of [
    (view: LocalProjectView) => {
      view.project.projectId = "other"
    },
    (view: LocalProjectView) => {
      view.project.pluginDigest = "b".repeat(64)
    },
    (view: LocalProjectView) => {
      view.project.manifest.stages[2].skill = "skills/old/SKILL.md"
    },
    (view: LocalProjectView) => {
      view.operations[2].status = "unknown"
    },
    (view: LocalProjectView) => {
      view.operations.push(structuredClone(view.operations[0]))
    }
  ]) {
    const { record, current } = completedTrialFixture()
    mutate(current)
    assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
  }
})
check(
  "rejects changed receipts, execution identities, and unauthorized operation field changes",
  () => {
    for (const mutate of [
      (view: LocalProjectView) => {
        view.operations[2].receipts[0].artifactFingerprint = "stale"
      },
      (view: LocalProjectView) => {
        view.operations[2].execution!.threadId = "other-thread"
      },
      (view: LocalProjectView) => {
        view.operations[2].inputFingerprint = "other-input"
      },
      (view: LocalProjectView) => {
        view.operations[2].updatedAt = 1
      }
    ]) {
      const { record, current } = completedTrialFixture()
      mutate(current)
      assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
    }
  }
)
check("requires current passed Creator journey and no outstanding native review or input", () => {
  const { record, current } = completedTrialFixture()
  record.finalNativeCreatorStatus.projectTrial.journey.candidateCurrent = false
  assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
  const other = completedTrialFixture()
  other.current.resultApprovalRequired = true
  assert.throws(() => assertMutationRecordedCompletedTrial(other.record, other.current))
  other.current.resultApprovalRequired = false
  other.record.passed = true
  assert.throws(() => assertMutationRecordedCompletedTrial(other.record, other.current))
})

function approvedTrialFixture(names?: string[]) {
  const fixture = completedTrialFixture(names)
  for (const id of ["design", "code", "cicd"]) {
    fixture.record.created.project.manifest.stages.find(
      (stage) => stage.id === id
    )!.resultApproval = "human"
    fixture.current.project.manifest.stages.find((stage) => stage.id === id)!.resultApproval =
      "human"
    const operation = fixture.record.events.find(
      (event) => event.type === "stage-settled" && event.stage === id
    )!.operation!
    const review = {
      operationId: operation.operationId,
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint,
      pluginDigest: operation.pluginDigest,
      artifactFingerprint: "a".repeat(64),
      receiptFingerprint: "b".repeat(64),
      policyDigest: "c".repeat(64)
    }
    const beforeAdvance = fixture.record.events.findIndex(
      (event) => event.type === "native-advance" && event.stage === id
    )
    fixture.record.events.splice(beforeAdvance, 0, {
      type: "native-result-approval",
      projectLeg: "creator-trial",
      stage: id,
      review
    })
    const actual = fixture.current.operations.find((item) => item.stageId === id)!
    actual.resultApproval = {
      ...review,
      decision: "approved",
      actorId: "desktop-user",
      decidedAt: 4
    }
    actual.updatedAt = 5
  }
  return fixture
}

check("matches all three original human reviews to bounded native result approvals", () => {
  const { record, current } = approvedTrialFixture()
  const original = JSON.stringify(record)
  assertMutationRecordedCompletedTrial(record, current)
  assert.equal(JSON.stringify(record), original)
  assert.equal(record.passed, false)
})
check("rejects missing, unrelated or reordered review events and changed review digests", () => {
  for (const mutate of [
    (fixture: ReturnType<typeof approvedTrialFixture>) => {
      fixture.record.events.splice(
        fixture.record.events.findIndex((event) => event.type === "native-result-approval"),
        1
      )
    },
    (fixture: ReturnType<typeof approvedTrialFixture>) => {
      fixture.record.events.find(
        (event) => event.type === "native-result-approval"
      )!.review!.operationId = "unrelated"
    },
    (fixture: ReturnType<typeof approvedTrialFixture>) => {
      fixture.record.events.push(
        fixture.record.events.splice(
          fixture.record.events.findIndex((event) => event.type === "native-result-approval"),
          1
        )[0]
      )
    },
    (fixture: ReturnType<typeof approvedTrialFixture>) => {
      fixture.current.operations.find(
        (operation) => operation.stageId === "design"
      )!.resultApproval!.policyDigest = "d".repeat(64)
    }
  ]) {
    const fixture = approvedTrialFixture()
    mutate(fixture)
    assert.throws(() => assertMutationRecordedCompletedTrial(fixture.record, fixture.current))
  }
})
check(
  "rejects unrecorded approvals, rejected decisions, wrong actors and out-of-range timestamps",
  () => {
    for (const mutate of [
      (operation: LocalProjectView["operations"][number]) => {
        operation.resultApproval!.decision = "rejected"
      },
      (operation: LocalProjectView["operations"][number]) => {
        operation.resultApproval!.actorId = "other-actor"
      },
      (operation: LocalProjectView["operations"][number]) => {
        operation.resultApproval!.decidedAt = 2
      },
      (operation: LocalProjectView["operations"][number]) => {
        operation.resultApproval!.decidedAt = 6
      }
    ]) {
      const { record, current } = approvedTrialFixture()
      mutate(current.operations.find((operation) => operation.stageId === "design")!)
      assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
    }
    const { record, current } = approvedTrialFixture()
    current.operations[0].resultApproval = structuredClone(current.operations[3].resultApproval)
    assert.throws(() => assertMutationRecordedCompletedTrial(record, current))
  }
)

function pendingE2eFixture() {
  const { record: prefix, current } = approvedTrialFixture([
    "convert",
    "prd",
    "specs",
    "design",
    "plan",
    "code",
    "cicd",
    "archive"
  ])
  const manifest = prefix.created.project.manifest
  manifest.stages.push({
    id: "e2e",
    title: "Browser test",
    approval: "none",
    resultApproval: "human",
    skill: "skills/native-e2e/SKILL.md",
    artifactIds: ["e2e-report"],
    checkIds: ["e2e.receipt"],
    actionIds: []
  })
  manifest.artifacts.push({ id: "e2e-report", path: "E2E_REPORT.json", required: true })
  manifest.checks.push({
    id: "e2e.receipt",
    kind: "file-exists",
    artifactId: "e2e-report",
    sideEffect: "read"
  })
  current.project.manifest = structuredClone(manifest)
  current.project.status = "active"
  current.preview = { state: "expired", revision: 8 }
  const request = {
    id: "original-request",
    draftId: "original-draft",
    revision: 8,
    name: "Original source",
    digest: "d".repeat(64),
    goal: prefix.created.project.goal,
    journey: {
      ...prefix.finalNativeCreatorStatus.projectTrial.journey,
      candidateDigest: "d".repeat(64),
      phase: "not-started" as const,
      canDeliver: false,
      stages: [
        ...prefix.finalNativeCreatorStatus.projectTrial.journey.stages,
        {
          id: "e2e",
          title: "Browser test",
          status: "pending" as const,
          artifacts: [manifest.artifacts[8]],
          checks: [{ id: "e2e.receipt", artifactId: "e2e-report", result: "unknown" as const }],
          sessions: []
        }
      ]
    }
  }
  const error = `TimeoutError: locator.fill: Timeout 20000ms exceeded.\nplugin-param-${current.project.installedPluginId}-e2eSubjects\nelement is not visible`
  const record: MutationRecordedE2eTrialResume = {
    ...prefix,
    acceptanceRun: "creator-trial-save-start-use-and-ordinary-project",
    mutation: "append-e2e",
    originalProfile: "C:/owned/run-Test",
    originalAuthorEvidenceSha256: "e".repeat(64),
    candidate: { sha256: "f".repeat(64), path: "C:/built/main.js", execution: "built-output" },
    application: {
      sha256: "f".repeat(64),
      entry: "C:/built/main.js",
      execution: "normal-built-Electron",
      packaged: false,
      path: "C:/owned/run-Test"
    },
    source: { directory: "C:/owned/run-Test/candidate", inputSourceSha256: "a".repeat(64) },
    compilation: {
      provenance: "retained-authored-executable-bytes",
      files: [{ path: "modules/e2e/SKILL.md", sha256: "b".repeat(64) }]
    },
    finalNativeCreatorStatus: {
      threadId: "creator",
      workspace: "C:/owned/author",
      projectTrial: request
    },
    events: [
      ...prefix.events.map((event) =>
        event.type === "native-advance" && event.stage === "archive"
          ? { ...event, status: "active" }
          : { ...event }
      ),
      { type: "primary-failure", at: 20, error },
      { type: "application-process-exit", at: 21, code: 0, signal: null },
      { type: "application-close", at: 22 }
    ],
    errors: [error]
  }
  const observed = {
    view: current,
    creator: structuredClone(record.finalNativeCreatorStatus),
    identity: {
      threadId: "creator",
      requestId: request.id,
      revision: 8,
      candidateDigest: request.digest
    },
    source: structuredClone(record.source),
    compilation: structuredClone(record.compilation),
    authorEvidenceSha256: record.originalAuthorEvidenceSha256
  }
  return { record, observed }
}

check(
  "resumes only the original pending E2E after eight exact native transitions without changing evidence",
  () => {
    const { record, observed } = pendingE2eFixture()
    const before = JSON.stringify({ record, observed })
    assert.equal(assertMutationRecordedE2eTrialResume(record).operations.length, 8)
    assert.equal(
      assertMutationRecordedE2eTrialResume(record, observed).projectId,
      observed.view.project.projectId
    )
    assert.equal(JSON.stringify({ record, observed }), before)
    assert.equal(record.passed, false)
    observed.view.preview = { state: "active", revision: 8 }
    assertMutationRecordedE2eTrialResume(record, observed)
  }
)

check(
  "rejects changed E2E current project, candidate, author or complete executable identity",
  () => {
    const mutations: Array<(value: ReturnType<typeof pendingE2eFixture>["observed"]) => void> = [
      (value) => {
        value.view.project.projectId = "another-project"
      },
      (value) => {
        value.view.project.workspace = "C:/other"
      },
      (value) => {
        value.view.project.pluginDigest = "0".repeat(64)
      },
      (value) => {
        value.view.project.installedPluginId = "another-plugin"
      },
      (value) => {
        value.view.project.stageIndex = 5
      },
      (value) => {
        value.view.project.version++
      },
      (value) => {
        value.view.project.updatedAt = 21
      },
      (value) => {
        value.view.project.manifest.stages[8].skill = "skills/other/SKILL.md"
      },
      (value) => {
        value.creator.projectTrial!.id = "new-request"
      },
      (value) => {
        value.creator.projectTrial!.goal = "new-goal"
      },
      (value) => {
        value.creator.projectTrial!.digest = "0".repeat(64)
      },
      (value) => {
        value.creator.workspace = "C:/other-author"
      },
      (value) => {
        value.identity.threadId = "other-author"
      },
      (value) => {
        value.identity.revision++
      },
      (value) => {
        value.source.inputSourceSha256 = "0".repeat(64)
      },
      (value) => {
        value.compilation = { files: [] }
      },
      (value) => {
        value.authorEvidenceSha256 = "0".repeat(64)
      },
      (value) => {
        value.source.directory = "C:/other-candidate"
      }
    ]
    for (const mutate of mutations) {
      const { record, observed } = pendingE2eFixture()
      mutate(observed)
      assert.throws(() => assertMutationRecordedE2eTrialResume(record, observed))
    }
  }
)

check(
  "retains the historical main while a different current build passes its own unchanged SHA guard",
  () => {
    const { record, observed } = pendingE2eFixture()
    const before = JSON.stringify(record)
    const temporary = mkdtempSync(join(tmpdir(), "autobiz-resume-build-"))
    try {
      mkdirSync(join(temporary, "out/main"), { recursive: true })
      const bytes = Buffer.from("Current independently reviewed local build")
      const currentSha = createHash("sha256").update(bytes).digest("hex")
      writeFileSync(join(temporary, "out/main/index.js"), bytes)
      assert.notEqual(currentSha, record.candidate.sha256)
      const environment = {
        CMB_PROJECT_BUILT_PREVIEW: "1",
        CMB_PROJECT_EXPECTED_MAIN_SHA256: currentSha
      }
      const currentGuard = projectBuiltPreview(temporary, undefined, environment)
      currentGuard.assertCurrent()
      assertMutationRecordedE2eTrialResume(record, observed)
      assert.equal(JSON.stringify(record), before)
      assert.throws(
        () =>
          projectBuiltPreview(temporary, undefined, {
            ...environment,
            CMB_PROJECT_EXPECTED_MAIN_SHA256: record.candidate.sha256
          }),
        /PROJECT_PREVIEW_MAIN_CHANGED/
      )
      assert.throws(
        () =>
          projectBuiltPreview(temporary, undefined, {
            CMB_PROJECT_BUILT_PREVIEW: "1"
          }),
        /PROJECT_PREVIEW_MAIN_SHA_REQUIRED/
      )
      writeFileSync(join(temporary, "out/main/index.js"), "Unreviewed changed current build")
      assert.throws(() => currentGuard.assertCurrent(), /PROJECT_PREVIEW_MAIN_CHANGED/)
    } finally {
      assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
      assert(basename(temporary).startsWith("autobiz-resume-build-"))
      rmSync(temporary, { recursive: true, force: true })
    }
  }
)

check(
  "rejects native operation, execution or receipt substitutions and unconfirmed effects",
  () => {
    const mutations: Array<(value: LocalProjectView) => void> = [
      (value) => {
        value.operations[0].execution!.threadId = "other-thread"
      },
      (value) => {
        value.operations[0].receipts[0].checkedAt++
      },
      (value) => {
        value.operations[0].receipts[0].result = "failed"
      },
      (value) => {
        value.operations[0].inputFingerprint = "other-input"
      },
      (value) => {
        value.operations[0].status = "unknown"
      },
      (value) => {
        value.operations[0].status = "started"
      },
      (value) => {
        value.operations[0].status = "failed"
      },
      (value) => {
        value.operations.push({ ...structuredClone(value.operations[0]), stageId: "e2e" })
      },
      (value) => {
        value.operations.pop()
      },
      (value) => {
        value.inputWait = {
          operationId: "new",
          requestId: "wait",
          threadId: "thread",
          status: "waiting",
          resumable: true
        }
      },
      (value) => {
        value.resultApprovalRequired = true
      },
      (value) => {
        value.importedSource = { sourceProjectId: "other", prefixStageIds: [] }
      }
    ]
    for (const mutate of mutations) {
      const { record, observed } = pendingE2eFixture()
      mutate(observed.view)
      assert.throws(() => assertMutationRecordedE2eTrialResume(record, observed))
    }
  }
)

check(
  "requires complete original prefix coverage and never trusts an E2E or unknown historical receipt",
  () => {
    const mutations: Array<(value: MutationRecordedE2eTrialResume) => void> = [
      (value) => {
        value.events = value.events.filter((event) => event.stage !== "prd")
      },
      (value) => {
        value.events.push(
          structuredClone(value.events.find((event) => event.type === "stage-settled")!)
        )
      },
      (value) => {
        value.events.find((event) => event.type === "stage-settled")!.stageIndex = 8
      },
      (value) => {
        value.events.find(
          (event) => event.type === "stage-settled"
        )!.operation!.receipts[0].result = "unknown"
      },
      (value) => {
        value.finalNativeCreatorStatus.projectTrial!.journey!.stages[8].status = "passed"
      },
      (value) => {
        value.finalNativeCreatorStatus.projectTrial!.journey!.operationsTruncated = true
      }
    ]
    for (const mutate of mutations) {
      const { record, observed } = pendingE2eFixture()
      mutate(record)
      assert.throws(() => assertMutationRecordedE2eTrialResume(record, observed))
    }
  }
)

check(
  "does not turn arbitrary failed acceptance, another configuration error or a retry into E2E resume",
  () => {
    const mutations: Array<(value: MutationRecordedE2eTrialResume) => void> = [
      (value) => {
        value.passed = true
      },
      (value) => {
        value.mutation = "replace-middle"
      },
      (value) => {
        value.acceptanceRun = "full-project-chain"
      },
      (value) => {
        value.resume = { evidence: "previous-retry" }
      },
      (value) => {
        value.creatorTrial = { completed: value.created }
      },
      (value) => {
        value.events.find((event) => event.type === "primary-failure")!.error =
          "TimeoutError: another failure"
      },
      (value) => {
        value.errors = ["different failure"]
      },
      (value) => {
        value.events.find((event) => event.type === "application-process-exit")!.code = 1
      },
      (value) => {
        value.application.sha256 = "0".repeat(64)
      },
      (value) => {
        value.application.entry = "C:/unverified/main.js"
      }
    ]
    for (const mutate of mutations) {
      const { record, observed } = pendingE2eFixture()
      mutate(record)
      assert.throws(() => assertMutationRecordedE2eTrialResume(record, observed))
    }
  }
)

check(
  "preserves original result approvals rather than accepting new decisions or invented reviews",
  () => {
    for (const change of ["missing-review", "actor", "fingerprint", "timestamp"] as const) {
      const { record, observed } = pendingE2eFixture()
      const actual = observed.view.operations.find((operation) => operation.stageId === "design")!
      if (change === "missing-review")
        record.events = record.events.filter(
          (event) => !(event.type === "native-result-approval" && event.stage === "design")
        )
      if (change === "actor") actual.resultApproval!.actorId = "other-actor"
      if (change === "fingerprint") actual.resultApproval!.artifactFingerprint = "0".repeat(64)
      if (change === "timestamp") actual.resultApproval!.decidedAt = 30
      assert.throws(() => assertMutationRecordedE2eTrialResume(record, observed))
    }
  }
)

console.log(`PASS ${checks} native consumption and retained-trial contracts`)
