/** Fast join-contract tests only. These do not claim Electron, authoring, or business execution. */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuthoringSourceBundle } from "../src/main/mods/devtools/authoring-bundle"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"
import type { CreatorProjectTrialJourney } from "../src/shared/mods/creator-trial-journey"
import type { ElectronApplication, Page } from "playwright"
import {
  assertMutationCreatorPassed,
  assertUnstartedCreatorTrial,
  assertRetainedCompletedCreatorTrial,
  assertMutationCreatorRequest,
  mutationCreatorIdentity,
  mutationCreatorJourney
} from "./support/autobiz-composition-mutation-creator"
import {
  mutationE2eConfiguration,
  mutationE2eConfigurationContract,
  mutationSource
} from "./support/autobiz-composition-mutation-fixture"
import {
  mutationNativeE2eConfiguration,
  mutationSpecKnowledgePath,
  mutationSpecKnowledgeResponse,
  MUTATION_STAGE_CONFIGURATION_LABEL
} from "./support/autobiz-composition-mutation-model"
import { resolve } from "node:path"

const profile = mkdtempSync(join(tmpdir(), "autobiz-creator-join-contract-"))
const threadId = "11111111-1111-4111-8111-111111111111"
const otherThread = "22222222-2222-4222-8222-222222222222"
const requestId = "33333333-3333-4333-8333-333333333333"
const revision = 6
let checks = 0

/** Minimal Page double verifies ordering only; it grants no native authority or runtime receipt. */
async function checkCreatorEntry(
  identity: ReturnType<typeof mutationCreatorIdentity>,
  initiallyEntered: boolean
) {
  const events: string[] = []
  let selected = false
  let entered = initiallyEntered
  let navigationHandlerInstalled = false
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalRequest = { id: requestId, revision, digest: identity.candidateDigest }
  const status = () => ({
    threadId,
    workspace: profile,
    enabled: entered,
    mode: entered ? "creator" : "normal",
    ...(entered ? { projectTrial: originalRequest } : {})
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      api: {
        mods: {
          status: async (id: string) => {
            assert.equal(id, threadId)
            events.push("read-native-workspace")
            return { workspace: profile }
          },
          development: {
            status: async ({ threadId: id }: { threadId: string }) => {
              assert.equal(id, threadId)
              assert(entered, "Creator status must not be required before visible UI admission")
              events.push("read-creator-status")
              return status()
            }
          }
        },
        threads: {
          get: async (id: string) => {
            assert.equal(id, threadId)
            events.push("read-original-thread")
            return { thread_id: threadId, title: "Original author" }
          }
        }
      }
    }
  })
  const button = {
    waitFor: async () => {
      assert(selected)
    },
    getAttribute: async () => (entered ? "true" : "false"),
    click: async () => {
      assert(selected)
      events.push("enter-original-creator-ui")
      entered = true
    }
  }
  const chat = {
    isVisible: async () => selected,
    waitFor: async () => {
      assert(selected)
    },
    getByRole: (role: string, options: { name: string }) => {
      assert.equal(role, "button")
      assert.equal(options.name, "创造者模式")
      return button
    }
  }
  const page = {
    evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value),
    addLocatorHandler: async () => {
      navigationHandlerInstalled = true
    },
    removeLocatorHandler: async () => {
      navigationHandlerInstalled = false
    },
    getByRole: (role: string, options: { name: string }) => {
      if (role === "dialog" && options.name === "插件创作工作区")
        return { isVisible: async () => false }
      if (role === "button" && options.name === "返回会话") return { isVisible: async () => false }
      assert.equal(role, "tab")
      assert.equal(options.name, "对话模式")
      return {
        click: async () => {
          events.push("open-chat-mode")
        }
      }
    },
    locator: (selector: string) => {
      assert.equal(selector, `[data-chat-thread-id=${JSON.stringify(threadId)}]`)
      return chat
    },
    getByText: (title: string) => {
      assert.equal(title, "Original author")
      return {
        first: () => ({
          click: async () => {
            assert(navigationHandlerInstalled)
            events.push("select-original-chat")
            selected = true
          }
        })
      }
    },
    waitForFunction: async () => {
      assert(selected && entered)
    }
  } as unknown as Page
  try {
    const records: Record<string, unknown>[] = []
    await mutationCreatorJourney({
      app: {} as ElectronApplication,
      page,
      identity,
      deadline: Date.now() + 1000,
      record: (value) => {
        records.push(value)
      }
    })
    assert.deepEqual(events, [
      "read-native-workspace",
      "read-original-thread",
      "open-chat-mode",
      "select-original-chat",
      ...(!initiallyEntered ? ["enter-original-creator-ui"] : []),
      "read-creator-status",
      "read-creator-status"
    ])
    assert.equal(records.length, 1)
    assert.equal(records[0].requestId, requestId)
    assert.equal(records[0].revision, revision)
    assert.equal(records[0].candidateDigest, identity.candidateDigest)
    assert.equal(navigationHandlerInstalled, false)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

async function main() {
  try {
    const files = [{ path: "plugin.json", bytes: Buffer.from('{"name":"original"}') }]
    const candidateDigest = createAuthoringSourceBundle(
      files.map((file) => ({
        path: file.path,
        text: file.bytes.toString("utf8")
      }))
    ).digest
    const evidence = {
      observations: [
        {
          threadId,
          authoring: {
            projectTrial: {
              id: requestId,
              revision,
              digest: candidateDigest
            }
          }
        }
      ]
    }
    const path = join(profile, "evidence.json")
    writeFileSync(path, JSON.stringify(evidence))
    const before = readFileSync(path)
    const identity = mutationCreatorIdentity({ profile, files })
    assert.equal(identity.threadId, threadId)
    assert.equal(identity.candidateDigest, candidateDigest)
    assert.equal(identity.requestId, requestId)
    assert.equal(identity.revision, revision)
    assert.equal(identity.evidenceSha256.length, 64)
    checks++
    assert.throws(
      () => mutationCreatorIdentity({ profile, files, threadId: otherThread }),
      /AUTHOR_EVIDENCE_BINDING_REQUIRED/
    )
    checks++
    assert.throws(
      () =>
        mutationCreatorIdentity({
          profile,
          files: [{ path: "plugin.json", bytes: Buffer.from('{"name":"renamed"}') }]
        }),
      /ORIGINAL_THREAD_REQUIRED/
    )
    checks++
    evidence.observations.push({
      threadId: otherThread,
      authoring: { projectTrial: { id: requestId, revision, digest: candidateDigest } }
    })
    writeFileSync(path, JSON.stringify(evidence))
    assert.throws(() => mutationCreatorIdentity({ profile, files }), /ORIGINAL_THREAD_REQUIRED/)
    assert.equal(mutationCreatorIdentity({ profile, files, threadId }).threadId, threadId)
    checks++
    writeFileSync(path, before)
    assert(readFileSync(path).equals(before))
    for (const trial of [
      { digest: candidateDigest },
      { id: "invalid-request", revision, digest: candidateDigest },
      { id: requestId, revision: 0, digest: candidateDigest },
      { id: requestId, revision: 9, digest: candidateDigest },
      { id: requestId, revision: 1.5, digest: candidateDigest }
    ]) {
      writeFileSync(
        path,
        JSON.stringify({ observations: [{ threadId, authoring: { projectTrial: trial } }] })
      )
      assert.throws(() => mutationCreatorIdentity({ profile, files }), /ORIGINAL_REQUEST_REQUIRED/)
      checks++
    }
    for (const changed of [
      { id: otherThread, revision, digest: candidateDigest },
      { id: requestId, revision: revision + 1, digest: candidateDigest }
    ]) {
      writeFileSync(
        path,
        JSON.stringify({
          observations: [
            evidence.observations[0],
            { threadId, authoring: { projectTrial: changed } }
          ]
        })
      )
      assert.throws(() => mutationCreatorIdentity({ profile, files }), /ORIGINAL_REQUEST_REQUIRED/)
      checks++
    }
    writeFileSync(path, before)
    assertMutationCreatorRequest({ id: requestId, revision, digest: candidateDigest }, identity)
    for (const request of [
      undefined,
      { id: otherThread, revision, digest: candidateDigest },
      { id: requestId, revision: revision + 1, digest: candidateDigest },
      { id: requestId, revision, digest: "f".repeat(64) }
    ]) {
      assert.throws(() => assertMutationCreatorRequest(request, identity))
      checks++
    }
    await checkCreatorEntry(identity, false)
    await checkCreatorEntry(identity, true)
    checks += 2

    const unstarted = {
      project: {
        projectId: threadId,
        installedPluginId: `dev-project-preview:${requestId}`,
        version: 1,
        stageIndex: 0,
        status: "active"
      },
      operations: []
    } as unknown as LocalProjectView
    assertUnstartedCreatorTrial(unstarted, threadId)
    checks++
    for (const change of [
      "project",
      "installation",
      "version",
      "stage",
      "completed",
      "operation",
      "input",
      "review",
      "migration",
      "import"
    ] as const) {
      const changed = structuredClone(unstarted)
      if (change === "project") changed.project.projectId = otherThread
      if (change === "installation") changed.project.installedPluginId = "installed-plugin"
      if (change === "version") changed.project.version++
      if (change === "stage") changed.project.stageIndex++
      if (change === "completed") changed.project.status = "completed"
      if (change === "operation") changed.operations.push({ status: "prepared" } as never)
      if (change === "input") changed.inputWait = {} as never
      if (change === "review") changed.resultReview = {} as never
      if (change === "migration") changed.migrationReview = {} as never
      if (change === "import") changed.importedSource = {} as never
      assert.throws(() => assertUnstartedCreatorTrial(changed, threadId), undefined, change)
      checks++
    }

    const project = {
      project: {
        projectId: "project",
        workspace: profile,
        status: "completed",
        manifest: { stages: [{ id: "browser-e2e", checkIds: ["native-original-receipt"] }] }
      }
    } as LocalProjectView
    const journey: CreatorProjectTrialJourney = {
      projectId: "project",
      creatorThreadId: threadId,
      candidateDigest,
      candidateCurrent: true,
      workspace: profile,
      phase: "passed",
      canDeliver: true,
      operationsTruncated: false,
      diagnostics: [],
      stages: [
        {
          id: "browser-e2e",
          title: "Browser verification",
          status: "passed",
          artifacts: [],
          checks: [{ id: "native-original-receipt", artifactId: "report", result: "passed" }],
          sessions: []
        }
      ]
    }
    assertMutationCreatorPassed(journey, project, identity)
    checks++
    const completed = {
      project: {
        ...project.project,
        installedPluginId: `dev-project-preview:${requestId}`,
        stageIndex: 1
      },
      operations: [
        {
          stageId: "browser-e2e",
          status: "transitioned",
          operationId: "original-operation",
          execution: { terminal: { outcome: "success" } },
          receipts: [{ checkId: "native-original-receipt", result: "passed" }]
        }
      ]
    } as unknown as LocalProjectView
    assertRetainedCompletedCreatorTrial(completed, structuredClone(completed))
    checks++
    for (const change of [
      "active",
      "wrong-installation",
      "missing-stage",
      "missing-check",
      "failed-check",
      "no-success",
      "unknown",
      "other-project",
      "other-receipt",
      "input-wait"
    ] as const) {
      const recorded = structuredClone(completed)
      const current = structuredClone(completed)
      if (change === "active") recorded.project.status = "active"
      if (change === "wrong-installation") recorded.project.installedPluginId = "installed"
      if (change === "missing-stage") recorded.operations = []
      if (change === "missing-check") recorded.operations[0].receipts = []
      if (change === "failed-check") recorded.operations[0].receipts[0].result = "failed"
      if (change === "no-success") recorded.operations[0].execution = undefined
      if (change === "unknown") recorded.operations[0].status = "unknown"
      if (change === "other-project") current.project.projectId = "other"
      if (change === "other-receipt") current.operations[0].receipts[0].checkId = "other"
      if (change === "input-wait") current.inputWait = {} as never
      if (!["other-project", "other-receipt", "input-wait"].includes(change))
        Object.assign(current, structuredClone(recorded))
      assert.throws(() => assertRetainedCompletedCreatorTrial(recorded, current), undefined, change)
      checks++
    }
    for (const change of [
      "project",
      "thread",
      "digest",
      "current",
      "phase",
      "deliver",
      "truncated",
      "stage",
      "check-identity",
      "zero-checks",
      "failed-check",
      "uncompleted"
    ] as const) {
      const altered = structuredClone(journey)
      const actual = structuredClone(project)
      if (change === "project") altered.projectId = "another-project"
      if (change === "thread") altered.creatorThreadId = otherThread
      if (change === "digest") altered.candidateDigest = "f".repeat(64)
      if (change === "current") altered.candidateCurrent = false
      if (change === "phase") altered.phase = "failed"
      if (change === "deliver") altered.canDeliver = false
      if (change === "truncated") altered.operationsTruncated = true
      if (change === "stage") altered.stages[0].id = "different-stage"
      if (change === "check-identity") altered.stages[0].checks[0].id = "unrelated-check"
      if (change === "zero-checks") altered.stages[0].checks = []
      if (change === "failed-check") altered.stages[0].checks[0].result = "failed"
      if (change === "uncompleted") actual.project.status = "active"
      assert.throws(() => assertMutationCreatorPassed(altered, actual, identity), undefined, change)
      checks++
    }
    const configuration = mutationE2eConfiguration()
    const stageId = "browser-e2e"
    const material =
      MUTATION_STAGE_CONFIGURATION_LABEL + "\n" + JSON.stringify({ stageId, configuration })
    assert.deepEqual(mutationNativeE2eConfiguration(material, stageId), configuration)
    checks++
    assert.deepEqual(
      mutationNativeE2eConfiguration(material + "\n" + material, stageId),
      configuration
    )
    checks++
    for (const text of [
      JSON.stringify(configuration),
      material.replace(stageId, "another-stage"),
      MUTATION_STAGE_CONFIGURATION_LABEL +
        "\n" +
        JSON.stringify({ stageId, configuration: { ...configuration, e2eTimeoutMs: "60000" } }),
      MUTATION_STAGE_CONFIGURATION_LABEL +
        "\n" +
        JSON.stringify({ stageId, configuration: { ...configuration, extra: "unselected" } }),
      material +
        "\n" +
        MUTATION_STAGE_CONFIGURATION_LABEL +
        "\n" +
        JSON.stringify({ stageId, configuration: mutationE2eConfiguration("zero") })
    ]) {
      assert.throws(() => mutationNativeE2eConfiguration(text, stageId))
      checks++
    }
    const append = mutationSource(resolve(__dirname, ".."), "append-e2e").source
    assert.deepEqual(mutationE2eConfigurationContract(append)?.keys, [
      "e2eTestFiles",
      "e2eSubjects",
      "e2eTimeoutMs"
    ])
    checks++
    const replacement = mutationSource(resolve(__dirname, ".."), "replace-middle").source
    assert.equal(mutationE2eConfigurationContract(replacement), undefined)
    assert.equal(replacement.configuration?.userConfig?.e2eTestFiles, undefined)
    checks++
    const changed = structuredClone(append)
    const check = changed.modules[8].checks.find((check) => check.kind === "action")!
    assert(check.kind === "action")
    check.configurationKeys = ["e2eTestFiles"]
    assert.throws(() => mutationE2eConfigurationContract(changed))
    checks++
    const selectedSkill = join(profile, "pinned-package", "skills", "native-acceptance", "SKILL.md")
    const knowledgeFile = mutationSpecKnowledgePath(selectedSkill, profile)
    assert.equal(knowledgeFile, join(profile, "pinned-package", "knowledge", "review-specs.md"))
    checks++
    assert.throws(() =>
      mutationSpecKnowledgePath(join(profile, "modules", "acceptance", "SKILL.md"), profile)
    )
    assert.throws(() => mutationSpecKnowledgePath(selectedSkill, join(profile, "another-profile")))
    checks += 2
    const readCall = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "actual-read-id",
          function: { name: "read_file", arguments: JSON.stringify({ file_path: knowledgeFile }) }
        }
      ]
    }
    const readResponse = {
      role: "tool",
      tool_call_id: "actual-read-id",
      content: "# 行为规格回检\n需求涉及的角色应有验收场景。"
    }
    assert.equal(
      mutationSpecKnowledgeResponse([readCall, readResponse], knowledgeFile).toolCallId,
      "actual-read-id"
    )
    checks++
    for (const messages of [
      [readCall],
      [readResponse],
      [readCall, { ...readResponse, tool_call_id: "other-tool-id" }],
      [readCall, { ...readResponse, content: "File not found" }],
      [readCall, { ...readResponse, content: "Error: denied 行为规格回检 需求涉及的角色" }],
      [
        readCall,
        {
          ...readResponse,
          content: JSON.stringify({ isError: true, text: "行为规格回检 需求涉及的角色" })
        }
      ],
      [
        readCall,
        { ...readResponse, content: [{ is_error: true, text: "行为规格回检 需求涉及的角色" }] }
      ],
      [readCall, readResponse, readResponse]
    ]) {
      assert.throws(() => mutationSpecKnowledgeResponse(messages, knowledgeFile))
      checks++
    }
    console.log(`PASS ${checks} Creator join contract checks only; no Electron/runtime claim`)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
