/** Normal Electron + controlled model + unchanged AutoBiz checks/workflow + real Chromium.
 * This is runtime acceptance, never a claim that a model authored the controlled source fixture.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve, relative, isAbsolute } from "node:path"
import type { WorkflowWorktreeRecord } from "../src/main/agent/workflow/types"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { ClawActionDescriptor } from "../src/shared/mods/claw-actions"
import type {
  LocalProjectCommand,
  LocalProjectView
} from "../src/shared/project-runtime/platform-api"
import { compileNativeComposition } from "../src/main/plugins/native-composition"
import { projectArtifactReferenceBudget } from "../src/main/harness-board/project-runtime/artifact-reference"
import { readRuntimeScopedFile } from "../src/main/harness-board/project-runtime/safe-files"
import { projectBuiltPreview } from "./support/project-built-preview"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate
} from "./support/project-composition-e2e-fixtures"
import {
  createUnifiedHostProject,
  openUnifiedHostProject
} from "./support/project-unified-native-journey"
import {
  directoryArchive,
  initializeMutationWorkspace,
  mutationBrowserReport,
  mutationE2eConfiguration,
  mutationE2eConfigurationContract,
  mutationSource,
  sha256,
  type AutoBizMutation
} from "./support/autobiz-composition-mutation-fixture"
import {
  mutationModel,
  mutationNativeE2eConfiguration,
  type MutationCase,
  type MutationWorkflow
} from "./support/autobiz-composition-mutation-model"
import { mutationProcessApprovals } from "./support/autobiz-composition-mutation-approvals"
import {
  assertMutationNativeConsumption,
  assertMutationRecordedCompletedTrial,
  assertMutationRecordedE2eTrialResume,
  type MutationRecordedCompletedTrial,
  type MutationRecordedE2eTrialResume
} from "./support/autobiz-mutation-native-consumption"
import {
  originalMutationTestReceipt,
  originalMutationCheckReceipt
} from "./support/autobiz-composition-mutation-receipts"
import {
  mutationRuntimeProfile,
  retainedMutationExecutable
} from "./support/autobiz-composition-mutation-profile"
import { resolveFixtureExecutable } from "../src/main/plugins/native-fixture-executable.test-helper"
import {
  configureMutationProjectViaUi,
  saveMutationProjectConfigurationViaUi,
  assertRetainedCompletedCreatorTrial,
  mutationCreatorIdentity,
  mutationCreatorJourney
} from "./support/autobiz-composition-mutation-creator"
import { openCreatorProjectPreview } from "./support/creator-navigation"

const root = resolve(__dirname, "..")
assert.match(process.version, /^v22\./, "Run this acceptance with the repository's Node 22 policy")
assert.equal(process.env.COMPOSITION_E2E_PACKAGED_DIR, undefined, "No packaging is requested")
assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1", "Explicit normal built Electron required")
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2.0.0")
const guard = projectBuiltPreview(root, undefined, {
  ...process.env,
  CMB_PROJECT_BUILT_PREVIEW: "1",
  CMB_PROJECT_EXPECTED_MAIN_SHA256: process.env.CREATOR_E2E_EXPECTED_SHA256
})
const mutation = (process.env.AUTOBIZ_MUTATION ?? "append-e2e") as AutoBizMutation
assert(["append-e2e", "replace-middle"].includes(mutation), "Unknown mutation")
const hookProbe = process.env.AUTOBIZ_MUTATION_PROBE === "hook-secret"
const creatorJourney = process.env.AUTOBIZ_MUTATION_CREATOR_JOURNEY === "1"
const completedTrialPath = process.env.AUTOBIZ_MUTATION_COMPLETED_TRIAL_EVIDENCE
const completedTrialBytes = completedTrialPath ? readFileSync(completedTrialPath) : undefined
const completedTrialEvidence = completedTrialBytes
  ? (JSON.parse(completedTrialBytes.toString("utf8")) as {
      mutation: string
      originalProfile: string
      source: { directory: string }
      creatorTrial?: { completed: LocalProjectView }
    } & Partial<MutationRecordedCompletedTrial>)
  : undefined
const retainedTrialView =
  completedTrialEvidence?.creatorTrial?.completed ?? completedTrialEvidence?.created
if (completedTrialEvidence) {
  assert(creatorJourney && !process.env.AUTOBIZ_MUTATION_RESTART_UNSTARTED_PROJECT)
  assert.equal(completedTrialEvidence.mutation, mutation)
  assert.equal(
    resolve(completedTrialEvidence.originalProfile),
    resolve(process.env.AUTOBIZ_MUTATION_PROFILE_DIR!)
  )
  assert.equal(
    resolve(completedTrialEvidence.source.directory),
    resolve(process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR!)
  )
  if (completedTrialEvidence.creatorTrial)
    assertRetainedCompletedCreatorTrial(
      completedTrialEvidence.creatorTrial.completed,
      completedTrialEvidence.creatorTrial.completed
    )
  else assertMutationRecordedCompletedTrial(completedTrialEvidence)
}
if (creatorJourney) {
  assert(
    process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR && process.env.AUTOBIZ_MUTATION_PROFILE_DIR,
    "Creator journey requires the original freely authored candidate and isolated profile"
  )
  assert(
    !hookProbe && (!process.env.AUTOBIZ_MUTATION_RESUME_EVIDENCE || mutation === "append-e2e"),
    "Creator resume is restricted to the original pending E2E trial"
  )
}
assert(!process.env.AUTOBIZ_MUTATION_PROBE || hookProbe, "Unknown focused probe")
const resumePath = process.env.AUTOBIZ_MUTATION_RESUME_EVIDENCE
const resumeBytes = resumePath ? readFileSync(resumePath) : undefined
const resume = resumeBytes
  ? (JSON.parse(resumeBytes.toString("utf8")) as {
      passed: boolean
      originalProfile: string
      runtimeArtifacts: string
      created: LocalProjectView
      installedCandidate?: { id: string; path: string }
      events: MutationRecordedE2eTrialResume["events"]
    } & Partial<MutationRecordedE2eTrialResume>)
  : undefined
const resumeCreatorE2e = !!resume && creatorJourney && mutation === "append-e2e"
if (resume) {
  assert(
    !hookProbe &&
      !completedTrialEvidence &&
      !process.env.AUTOBIZ_MUTATION_RESTART_UNSTARTED_PROJECT,
    "Resume, completed-trial reuse, restart and focused probes are mutually exclusive"
  )
  assert(
    resumeCreatorE2e || (!creatorJourney && mutation === "replace-middle"),
    "Only original pending Creator E2E or ordinary failed Code may resume"
  )
  assert(!resume.passed && process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR)
  assert.equal(resolve(resume.originalProfile), resolve(process.env.AUTOBIZ_MUTATION_PROFILE_DIR!))
  if (resumeCreatorE2e) {
    assertMutationRecordedE2eTrialResume(resume)
    assert.equal(
      resolve(resume.source!.directory),
      resolve(process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR!)
    )
  }
}
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= join(root, "output/autobiz-composition-mutations")
const profile = mutationRuntimeProfile(
  root,
  process.env.AUTOBIZ_MUTATION_PROFILE_DIR,
  retainedTrialView?.project.workspace ?? resume?.created.project.workspace
)
const { fixture, artifacts } = profile
console.log(`AUTOBIZ_MUTATION_ARTIFACTS ${artifacts}`)
if (process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR)
  assert(
    process.env.AUTOBIZ_MUTATION_PROFILE_DIR,
    "Use the original authored profile and provider identities"
  )
fixture.env.CMB_MODS_E2E = "0"
let initialized =
  resume || creatorJourney
    ? {
        knowledge: join(fixture.workspace, "acceptance-knowledge"),
        browserDirectory: join(fixture.workspace, "acceptance-browser")
      }
    : initializeMutationWorkspace(root, fixture.workspace)
const prepared = mutationSource(root, mutation, process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR)
const browserReport =
  prepared.source.modules.length === 9 ? mutationBrowserReport(prepared.source) : undefined
const e2eConfigurationContract = mutationE2eConfigurationContract(prepared.source)
let currentUiE2eConfiguration = e2eConfigurationContract ? mutationE2eConfiguration() : undefined
function readBrowserSelection() {
  assert(browserReport)
  const value = JSON.parse(readFileSync(join(fixture.workspace, browserReport.path), "utf8"))
  assert.deepEqual(Object.keys(value).sort(), ["executionId", "protocol", "runId"])
  assert.equal(value.protocol, "devclaw.test-report-selection/v1")
  assert(typeof value.runId === "string" && value.runId.length > 0)
  assert(typeof value.executionId === "string" && value.executionId.length > 0)
  return value as { runId: string; executionId: string }
}
const maven = resolveFixtureExecutable({
  name: "Maven",
  overrideEnv: "AUTOBIZ_TEST_MAVEN",
  homeEnvs: ["MAVEN_HOME", "M2_HOME"],
  commands: process.platform === "win32" ? ["mvn.cmd", "mvn.bat", "mvn.exe"] : ["mvn"]
}).replaceAll("\\", "/")
execFileSync("java", ["-version"], { stdio: "pipe", windowsHide: true })
let app: ElectronApplication | undefined, page: Page | undefined, view: LocalProjectView | undefined
let compiled: Pick<
  ReturnType<typeof compileNativeComposition>,
  "files" | "runtime" | "lock" | "actionLock"
>
let activeThread: string | undefined
let projectLeg = "ordinary"
let originalExecutable: typeof compiled | undefined
let reviewProcesses: (() => Promise<void>) | undefined
let inspectCreator: (() => Promise<unknown>) | undefined
const errors: string[] = [],
  events: Array<Record<string, unknown>> = []
const evidence: Record<string, unknown> = {
  passed: false,
  acceptanceRun: creatorJourney
    ? "creator-trial-save-start-use-and-ordinary-project"
    : hookProbe
      ? "original-hook-rejection-only"
      : resume
        ? "same-project-native-retry-and-finish"
        : "full-project-chain",
  ...(resume
    ? {
        resume: {
          evidence: resumePath,
          sha256: sha256(resumeBytes!),
          priorRuntimeArtifacts: resume.runtimeArtifacts,
          priorApplication: JSON.parse(resumeBytes!.toString()).application,
          ...(resumeCreatorE2e
            ? {
                priorCandidate: resume.candidate,
                historicalAcceptancePassed: false,
                localBuildVerification:
                  "Historical main remains in the immutable prior evidence; current main is independently verified by the reviewed built-preview SHA guard. Native candidate, project and receipts must remain exact."
              }
            : {})
        }
      }
    : {}),
  mutation,
  ...(completedTrialBytes
    ? {
        completedTrialResume: {
          path: completedTrialPath,
          sha256: sha256(completedTrialBytes),
          stageExecutionReplayed: false,
          historicalAcceptancePassed: completedTrialEvidence!.passed ?? false,
          provenance: completedTrialEvidence!.creatorTrial
            ? "Previously recorded completed native trial"
            : "Only the native completed trial is retained; historical acceptance remains failed; the ordinary project executes separately"
        }
      }
    : {}),
  runtimeArtifacts: artifacts,
  candidate: projectCompositionCandidate(root),
  source: {
    provenance: prepared.provenance,
    directory: prepared.directory,
    inputSourceSha256: prepared.inputSourceSha256,
    originalResources: prepared.originalResources
  },
  browserStageContract: browserReport,
  nativeE2eConfigurationContract: e2eConfigurationContract,
  originalProfile: process.env.AUTOBIZ_MUTATION_PROFILE_DIR,
  originalAuthorEvidenceSha256: profile.priorEvidenceSha256,
  driverBudgetsMs: {
    code: 720000,
    browserStage: 240000,
    otherStage: 90000,
    total: creatorJourney ? 3600000 : 1800000,
    cancellation: 60000
  },
  layers: {
    source:
      "Original resource/dependency preservation; external authored executable bytes are installed unchanged in their original profile, controlled source fixtures are compiled only when explicitly used.",
    runtime:
      "Normal built Electron/public IPC/native approval and progression; bounded loopback model outputs.",
    business:
      "Existing AutoBiz production validators, original Code workflow, real Git/Maven/Java/Python execution.",
    browser:
      "test-verification original action must execute node:test with actual Playwright Chromium; output text is not acceptance."
  },
  limitations: [
    "No live model authoring claim for this run.",
    "Native process dialog presentation is deterministic after exact frozen request review; file/stage/result decisions use native public APIs.",
    "No external CI deployment or human business acceptance claim."
  ]
}
const save = () =>
  writeFileSync(
    join(artifacts, "runtime-evidence.json"),
    JSON.stringify(
      {
        ...evidence,
        events,
        errors,
        modelErrors: model.errors,
        requests: model.requests,
        observedReads: model.observedReads,
        requiredKnowledgeReads: model.requiredKnowledgeReads,
        hookRejections: model.hookRejections
      },
      null,
      2
    )
  )
const model = mutationModel({
  isolated: fixture.isolated,
  workspace: fixture.workspace,
  maven,
  e2eReportPath: () => {
    assert(browserReport, "Declared native E2E report required")
    return browserReport.path
  },
  readE2eConfiguration: browserReport
    ? (text) => {
        const configuration = mutationNativeE2eConfiguration(text, browserReport.stageId)
        assert.deepEqual(
          configuration,
          currentUiE2eConfiguration,
          "Actual Host-published stage configuration must equal native UI readback"
        )
        return configuration
      }
    : undefined,
  e2eInputPaths: () =>
    prepared.source.modules[8]?.inputs.map((input) => {
      const output = prepared.source.modules
        .flatMap((stage) => stage.outputs)
        .find((output) => output.id === input.artifactId)
      assert(output, "Declared E2E input must retain its original producer")
      return output.path
    }) ?? [],
  workflowScript(stage) {
    const path =
      stage === "code"
        ? "workflows/native-code.workflow.js"
        : prepared.source.resources.find(
            (path) =>
              path.endsWith(".workflow.js") &&
              compiled.files
                .find((file) => file.path === path)
                ?.bytes.toString("utf8")
                .includes("test-verification")
          )!
    assert(path, "Retained E2E workflow required")
    return compiled.files.find((file) => file.path === path)!.bytes.toString("utf8")
  },
  workflowArgs(stage, kind, configuration) {
    if (stage === "code") {
      const rulesProvider = {
        ...compiled.actionLock.bindings.find(
          (value) => value.ref.plugin === "autobiz-native-rules" && value.ref.actionId === "code"
        )!.ref
      }
      delete (rulesProvider as Partial<typeof rulesProvider>).actionId
      return { rulesProvider }
    }
    const binding = compiled.actionLock.bindings.find(
      (value) => value.ref.plugin === "test-verification"
    )!
    const provider = { ...binding.ref, actionId: "execute-e2e" }
    assert(configuration, "Actual Host-published stage configuration required; no defaults")
    const invocationConfiguration =
      kind === "substitution"
        ? { ...configuration, e2eTestFiles: JSON.stringify(["acceptance-browser/smoke.test.cjs"]) }
        : configuration
    if (kind === "substitution")
      events.push({
        type: "adversarial-real-test-entry-substitution",
        expectedFromNativeContext: configuration,
        modelProposed: invocationConfiguration,
        workflow: "unchanged original verification workflow; independent native checker must reject"
      })
    return {
      provider,
      configuration: invocationConfiguration,
      sources: prepared.source.modules[8].inputs.map((source) => {
        const output = prepared.source.modules
          .flatMap((stage) => stage.outputs)
          .find((output) => output.id === source.artifactId)!
        return {
          artifactId: output.id,
          path: output.path,
          maxBytes: projectArtifactReferenceBudget(compiled.actionLock, output.id)
        }
      })
    }
  },
  latestWorkflow
})
async function latestWorkflow() {
  assert(page && activeThread)
  const list = await page.evaluate((id) => window.api.workflows.listRuns(id), activeThread)
  const latest = list.runs[0] as { runId?: string } | undefined
  if (!latest?.runId) return undefined
  return (await page.evaluate(({ id, run }) => window.api.workflows.getRun(id, run), {
    id: activeThread,
    run: latest.runId
  })) as MutationWorkflow | undefined
}
const command = (input: LocalProjectCommand) => {
  assert(page && view)
  return page.evaluate(
    ({ id, input }) => window.api.harnessBoard.localProjects.command(id, input),
    { id: view.project.projectId, input }
  )
}
async function read() {
  assert(page && view)
  return page.evaluate(
    (id) => window.api.harnessBoard.localProjects.get(id),
    view.project.projectId
  )
}
async function waitProject(accept: (value: LocalProjectView) => boolean, failure: string) {
  assert(page)
  const end = Date.now() + 30000
  do {
    const value = await read()
    if (accept(value)) return value
    await page.waitForTimeout(200)
  } while (Date.now() < end)
  throw Error(failure)
}
async function cancelActiveOperation(reason: string) {
  if (!page || !view || !app || app.process().exitCode !== null || app.process().signalCode) return
  const current = await read()
  const operation = current.operations.find((operation) =>
    ["started", "cancel_requested"].includes(operation.status)
  )
  if (!operation) return
  events.push({
    type: "driver-native-cancellation-request",
    reason,
    operationId: operation.operationId,
    at: Date.now()
  })
  await command({ kind: "cancel", operationId: operation.operationId })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const state = await read()
    const settled = state.operations.find((value) => value.operationId === operation.operationId)
    const physical = operation.execution?.threadId
      ? await page.evaluate(async (id) => {
          const value = (await window.api.workflows.hydrate(id)) as {
            activeRunId: string | null
            latestRun: { status?: string; worktrees?: Array<{ cleanupPending?: unknown }> } | null
          }
          return {
            activeRunId: value.activeRunId,
            status: value.latestRun?.status,
            cleanupPending:
              value.latestRun?.worktrees?.some((tree) => Boolean(tree.cleanupPending)) ?? false
          }
        }, operation.execution.threadId)
      : { activeRunId: null, status: undefined, cleanupPending: false }
    if (
      settled?.execution?.terminal &&
      !["started", "cancel_requested"].includes(settled.status) &&
      !physical.activeRunId &&
      !physical.cleanupPending
    ) {
      events.push({
        type: "driver-native-cancellation-settled",
        reason,
        at: Date.now(),
        operationId: operation.operationId,
        operationStatus: settled.status,
        terminal: settled.execution.terminal,
        physical
      })
      view = state
      save()
      return
    }
    await page.waitForTimeout(500)
  }
  throw Error(`AUTOBIZ_DRIVER_CANCELLATION_UNCONFIRMED:${operation.operationId}`)
}
async function install(bytes: number[], name: string) {
  const result = await page!.evaluate(
    ({ bytes, name }) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, name, "local", undefined, false),
    { bytes, name }
  )
  assert(result.success, result.error)
}
async function auditNativeStageConsumption(
  current: LocalProjectView,
  operation: LocalProjectView["operations"][number],
  auditKind: "stage-completed" | "retained-completed-trial" | "retained-stage"
) {
  assert(page)
  const project = current.project
  const stageIndex = project.manifest.stages.findIndex((stage) => stage.id === operation.stageId)
  assert(stageIndex >= 0, "Native operation must retain its declared stage")
  const stage = project.manifest.stages[stageIndex]
  if (stage.executionMode === "workflow") return
  assert.equal(operation.status, auditKind === "stage-completed" ? "succeeded" : "transitioned")
  assert.equal(operation.execution?.terminal?.outcome, "success")
  assert(
    operation.receipts.length && operation.receipts.every((receipt) => receipt.result === "passed")
  )
  assert.equal(operation.projectId, project.projectId)
  assert.equal(operation.pluginDigest, project.pluginDigest)
  assert.match(project.pluginDigest, /^[a-f0-9]{64}$/)
  const threadId = operation.execution?.threadId
  assert(threadId && stage.skill, "Completed native Skill execution identity required")
  const retainedSkill = compiled.files.find((file) => file.path === stage.skill)
  assert(retainedSkill, "Current retained executable must contain the selected Skill")
  const packageRoot = join(
    fixture.env.CMB_COWORK_AGENT_HOME,
    "local-projects",
    "packages",
    project.pluginDigest,
    "package"
  )
  const skill = readRuntimeScopedFile(packageRoot, stage.skill, retainedSkill.bytes.byteLength)
  assert(skill.bytes?.equals(retainedSkill.bytes), "Current native package Skill bytes changed")
  const precedingIds = [
    ...new Set(project.manifest.stages.slice(0, stageIndex).flatMap((item) => item.artifactIds))
  ]
  const inputIds = stage.inputArtifactIds ?? precedingIds
  assert.equal(new Set(inputIds).size, inputIds.length)
  const inputs = inputIds.map((id) => {
    assert(precedingIds.includes(id), "Native stage input must retain its actual producer")
    const artifact = project.manifest.artifacts.find((item) => item.id === id)
    assert(artifact, "Native declared input artifact required")
    const file = readRuntimeScopedFile(
      project.workspace,
      artifact.path,
      projectArtifactReferenceBudget(compiled.actionLock, artifact.id)
    )
    assert(file.bytes, "Current native stage input bytes required")
    return { path: join(project.workspace, artifact.path), bytes: file.bytes }
  })
  const observed = await page.evaluate(
    async (id) => ({
      thread: await window.api.threads.get(id),
      messages: await window.api.threads.getMessages(id)
    }),
    threadId
  )
  assert.equal(observed.thread?.thread_id, threadId)
  assert.equal(
    resolve(String(observed.thread?.metadata?.workspacePath)),
    resolve(project.workspace)
  )
  const binding = observed.thread?.metadata?.hostProjectRuntime as
    | Record<string, unknown>
    | undefined
  assert.deepEqual(binding, {
    projectId: project.projectId,
    operationId: operation.operationId,
    stageId: stage.id,
    pluginDigest: project.pluginDigest
  })
  const audit = assertMutationNativeConsumption({
    messages: observed.messages,
    selectedSkill: { path: join(packageRoot, stage.skill), bytes: skill.bytes },
    inputs
  })
  events.push({
    type: "native-skill-and-input-consumption-verified",
    source: "window.api.threads.getMessages",
    auditKind,
    projectLeg,
    projectId: project.projectId,
    workspace: project.workspace,
    stage: stage.id,
    operationId: operation.operationId,
    threadId,
    pluginDigest: project.pluginDigest,
    sourceDigest: compiled.lock.sourceDigest,
    inputSourceSha256: prepared.inputSourceSha256,
    inputFingerprint: operation.inputFingerprint,
    messageCount: observed.messages.length,
    messagesSha256: sha256(JSON.stringify(observed.messages)),
    selectedSkill: audit.selectedSkill,
    inputs: audit.inputs.map((file, index) => ({ artifactId: inputIds[index], ...file }))
  })
  save()
}
async function run(kind: MutationCase = "pass", expected: "succeeded" | "failed" = "succeeded") {
  assert(page && view)
  assert(!watchdogExpired, "AUTOBIZ_TOTAL_DRIVER_TIME_LIMIT")
  const stage = view.project.manifest.stages[view.project.stageIndex]
  if (view.project.stageIndex === 8) {
    currentUiE2eConfiguration = mutationE2eConfiguration(kind)
    await openUnifiedHostProject(page, view.project.name, view.project.workspace)
    await saveMutationProjectConfigurationViaUi({
      page,
      view,
      values: currentUiE2eConfiguration,
      record(value) {
        events.push(value)
        save()
      }
    })
    view = await read()
  }
  model.setPhase(
    view.project.stageIndex === 2 ? "specs" : view.project.stageIndex === 8 ? "e2e" : stage.id,
    kind
  )
  await openUnifiedHostProject(page, view.project.name, view.project.workspace)
  const before = await read()
  const requestCount = model.requests.length
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
  if (stage.approval === "human") {
    await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor()
    assert.equal(model.requests.length, requestCount, "No inference before native stage approval")
    await page.getByRole("button", { name: "批准并执行", exact: true }).click()
  }
  // The original single-batch success path has 31 independently approved native
  // processes plus the final checks. This bounds the driver, not native protections.
  const end =
    Date.now() + (stage.id === "code" ? 720000 : view.project.stageIndex === 8 ? 240000 : 90000)
  const approved = new Set<string>()
  let recordedRequests = model.requests.length
  while (Date.now() < end && !watchdogExpired) {
    await reviewProcesses?.()
    assert.deepEqual(model.errors, [], "Controlled output provider rejected native execution")
    const latest = await read()
    if (recordedRequests !== model.requests.length) {
      recordedRequests = model.requests.length
      save()
    }
    const operation = latest.operations.find(
      (operation) => !before.operations.some((old) => old.operationId === operation.operationId)
    )
    if (operation?.execution?.threadId) activeThread = operation.execution.threadId
    if (operation && ["succeeded", "failed", "cancelled", "unknown"].includes(operation.status)) {
      events.push({
        type: "stage-settled",
        projectLeg,
        projectId: latest.project.projectId,
        stage: stage.id,
        kind,
        operation,
        stageIndex: latest.project.stageIndex
      })
      save()
      assert.equal(operation.status, expected, JSON.stringify(operation))
      assert.equal(
        latest.project.stageIndex,
        before.project.stageIndex,
        "Checks cannot advance a stage"
      )
      assert.equal(
        operation.execution?.terminal?.outcome,
        "success",
        "Model execution physically settled"
      )
      assert(operation.receipts.length)
      if (expected === "succeeded")
        assert(operation.receipts.every((receipt) => receipt.result === "passed"))
      else assert(operation.receipts.some((receipt) => receipt.result !== "passed"))
      if (expected === "succeeded")
        await auditNativeStageConsumption(latest, operation, "stage-completed")
      view = latest
      await openUnifiedHostProject(page, view.project.name, view.project.workspace)
      return operation
    }
    if (activeThread && operation?.status === "started") {
      const pending = await page.evaluate(
        (id) => window.api.sandbox.getPendingApprovals(id),
        activeThread
      )
      for (const value of pending) {
        const approval = value as {
          id: string
          operation?: string
          filePath?: string
          cwd?: string
          tool_call: { id: string; name: string; args?: Record<string, unknown> }
        }
        if (approved.has(approval.id)) continue
        const tool = approval.tool_call?.name
        assert(tool, "Actual native approval identity required")
        if (["write_file", "edit_file"].includes(tool)) {
          const declaredArtifact =
            approval.filePath &&
            view.project.manifest.artifacts.some(
              (artifact) =>
                resolve(fixture.workspace, artifact.path) === resolve(approval.filePath!)
            )
          if (!declaredArtifact) {
            assert.equal(
              stage.id,
              "code",
              "Only the original Code workflow authors business/test files"
            )
            assert(approval.filePath)
            const workflow = (await latestWorkflow()) as MutationWorkflow & {
              worktrees?: WorkflowWorktreeRecord[]
            }
            assert.equal(workflow.status, "running")
            const resource = workflow.worktrees?.find((record) => {
              const path = relative(record.workspaceDirectory, approval.filePath!)
              const owned = relative(join(fixture.isolated, "data/worktrees"), record.directory)
              return (
                record.runId === workflow.runId &&
                record.threadId === activeThread &&
                resolve(record.sourceRoot) === resolve(fixture.workspace) &&
                record.resource?.state === "leased" &&
                owned &&
                !owned.startsWith("..") &&
                !isAbsolute(owned) &&
                ["src/main/java/Orders.java", "test_orders.py", "test_e2e.py"].includes(
                  path.replaceAll("\\", "/")
                )
              )
            })
            assert(
              resource,
              "Approve only exact fixture outputs inside this original live native worktree"
            )
            const proposal = model.requests.findLast(
              (request) => request.action === tool && request.filePath === approval.filePath
            )
            assert(proposal, "Review the actual controlled model file proposal")
            const args = approval.tool_call.args
            assert(args)
            assert.equal(
              sha256(String(args.content ?? args.new_string)),
              proposal.writeContentSha256
            )
            events.push({
              type: "original-worktree-file-proposal-reviewed",
              path: approval.filePath,
              runId: workflow.runId,
              resourceId: resource.resource!.id,
              sha256: proposal.writeContentSha256
            })
          }
        } else {
          assert(
            ["workflow", "workflow_resource_merge"].includes(tool),
            `Unexpected approval ${JSON.stringify(approval)}`
          )
          const args = approval.tool_call.args
          assert(args)
          if (tool === "workflow") {
            const proposed = model.requests.findLast((request) => request.action === "workflow")
            assert(proposed, "Review the actual controlled model workflow proposal")
            assert.equal(sha256(String(args.scriptPreview)), proposed.scriptSha256)
            assert.equal(sha256(String(args.argsPreview)), proposed.argsSha256)
          } else {
            assert.equal(stage.id, "code", "Only the original Code workflow may merge")
            assert.equal(resolve(String(args.sourceRoot)), resolve(fixture.workspace))
            for (const key of ["headCommit", "baseCommit", "sourceCommit"])
              assert.match(String(args[key]), /^[a-f0-9]{40,64}$/)
          }
        }
        events.push({ type: "native-approval", stage: stage.id, kind, approval })
        await page.evaluate(
          (approval) =>
            window.api.sandbox.sendApprovalDecision({
              requestId: approval.id,
              type: "approve",
              tool_call_id: approval.tool_call.id
            }),
          approval
        )
        approved.add(approval.id)
        save()
      }
    }
    await page.waitForTimeout(500)
  }
  await cancelActiveOperation("stage-driver-budget")
  const state = await read()
  throw Error(
    `AUTOBIZ_STAGE_TIME_LIMIT:${stage.id}:${JSON.stringify({
      projectId: state.project.projectId,
      stageIndex: state.project.stageIndex,
      operation: state.operations[0] && {
        operationId: state.operations[0].operationId,
        status: state.operations[0].status,
        execution: state.operations[0].execution
      }
    })}`
  )
}
async function approveResult() {
  assert(view && page)
  const operation = view.operations[0]
  if (view.resultApprovalRequired && operation.resultApproval?.decision !== "approved") {
    assert(view.resultReview, "Native result review required")
    const review = view.resultReview
    if (creatorJourney) {
      await page.getByRole("button", { name: "接受当前成果", exact: true }).click()
      view = await waitProject(
        (value) =>
          value.operations.find((value) => value.operationId === operation.operationId)
            ?.resultApproval?.decision === "approved",
        "AUTOBIZ_CREATOR_RESULT_APPROVAL_TIMEOUT"
      )
    } else
      view = await command({
        kind: "approve-result",
        operationId: operation.operationId,
        review: view.resultReview,
        decision: "approved"
      })
    events.push({
      type: "native-result-approval",
      projectLeg,
      stage: operation.stageId,
      review
    })
  }
}
async function advance() {
  assert(view && page)
  const operation = view.operations[0]
  await approveResult()
  if (creatorJourney) {
    const index = view.project.stageIndex
    const last = index + 1 === view.project.manifest.stages.length
    await page
      .getByRole("button", { name: last ? "确认完成任务" : "进入下一阶段", exact: true })
      .click()
    view = await waitProject(
      (value) =>
        last ? value.project.status === "completed" : value.project.stageIndex === index + 1,
      "AUTOBIZ_CREATOR_NATIVE_ADVANCE_TIMEOUT"
    )
  } else view = await command({ kind: "advance", operationId: operation.operationId })
  events.push({
    type: "native-advance",
    projectLeg,
    projectId: view.project.projectId,
    stage: operation.stageId,
    stageIndex: view.project.stageIndex,
    status: view.project.status
  })
  save()
}
let watchdogExpired = false
const watchdog = setTimeout(
  () => {
    watchdogExpired = true
  },
  creatorJourney ? 3600000 : 1800000
)
async function main() {
  const url = await model.listen()
  try {
    guard.assertCurrent()
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app.on("close", () => {
      events.push({ type: "application-close", at: Date.now() })
      save()
    })
    app.process().on("exit", (code, signal) => {
      events.push({ type: "application-process-exit", at: Date.now(), code, signal })
      save()
    })
    evidence.application = await guard.verify(app, fixture.isolated)
    reviewProcesses = await mutationProcessApprovals({
      app,
      root,
      isolated: fixture.isolated,
      artifacts,
      maven,
      record(value) {
        events.push(value)
        save()
      }
    })
    for (const [name, stream] of [
      ["stdout", app.process().stdout],
      ["stderr", app.process().stderr]
    ] as const)
      stream?.on("data", (bytes) => appendFileSync(join(artifacts, `main.${name}.log`), bytes))
    assert.equal(await app.evaluate(() => process.env.CMB_MODS_E2E), "0")
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(20000)
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects))
    evidence.hookLogging = await page.evaluate(async () => ({
      configuration: await window.api.hooks.logging.save({ enabled: true, diagnostic: true }),
      logDirectory: await window.api.hooks.logging.getLogDir()
    }))
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1366, 900))
    await page.evaluate(async (url) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.models.setCustomConfig({
        id: "autobiz-mutation",
        name: "AutoBiz controlled acceptance",
        baseUrl: url,
        model: "autobiz-mutation",
        apiKey: "loopback-only",
        maxTokens: 64000,
        maxOutputTokens: 8192
      })
      await window.api.models.setDefault("custom:autobiz-mutation")
      await window.api.mods.configureGlobal(true)
    }, url)
    if (!process.env.AUTOBIZ_MUTATION_PROFILE_DIR)
      for (const name of ["autobiz-rules", "autobiz-knowledge", "test-verification"])
        await install(
          directoryArchive(join(root, "resources/native-compositions", name)),
          `${name}.zip`
        )
    const retained = process.env.AUTOBIZ_MUTATION_PROFILE_DIR
      ? retainedMutationExecutable(prepared.directory)
      : undefined
    const creatorIdentity = creatorJourney
      ? mutationCreatorIdentity({
          profile: fixture.isolated,
          files: retained!.files,
          evidencePath: process.env.AUTOBIZ_MUTATION_AUTHOR_EVIDENCE,
          threadId: process.env.AUTOBIZ_MUTATION_CREATOR_THREAD_ID
        })
      : undefined
    const setup =
      resume || creatorIdentity
        ? await page.evaluate(
            async ({ threadId }) => {
              const status = await window.api.mods.status(threadId)
              return {
                threadId,
                workspace: status.workspace,
                providers: status.functionMods ?? [],
                approvedProviders: status.functionMods ?? [],
                actions: (await window.api.mods.flowCatalog(threadId)).actions ?? []
              }
            },
            {
              threadId:
                creatorIdentity?.threadId ??
                String(
                  resume!.events.find(
                    (event) => event.type === "native-new-workspace-dependency-consent"
                  )?.threadId
                )
            }
          )
        : await page.evaluate(async (workspace) => {
            const thread = await window.api.threads.create({
              title: "AutoBiz mutation dependency approval",
              workspacePath: workspace,
              agentMode: "normal"
            })
            const threadId = thread.thread_id
            await window.api.workspace.set(threadId, workspace)
            const workspaceKey = (await window.api.mods.status(threadId)).workspace
            if (
              workspaceKey.replaceAll("\\", "/").toLowerCase() !==
              workspace.replaceAll("\\", "/").toLowerCase()
            )
              throw Error("NEW_RUNTIME_APPROVAL_WORKSPACE_CHANGED")
            await window.api.mods.configure(threadId, true, true, workspaceKey)
            const status = await window.api.mods.status(threadId)
            if (status.workspace !== workspaceKey)
              throw Error("NEW_RUNTIME_APPROVAL_WORKSPACE_CHANGED")
            const providers = status.functionMods ?? []
            for (const provider of providers) {
              if (
                !["autobiz-native-rules", "autobiz-native-knowledge", "test-verification"].includes(
                  provider.name
                )
              )
                continue
              if (!provider.digest) throw Error("Provider digest required")
              await window.api.mods.approveFunction(
                threadId,
                provider.pluginId,
                provider.digest,
                status.workspace
              )
            }
            return {
              threadId,
              workspace: status.workspace,
              providers,
              approvedProviders: (await window.api.mods.status(threadId)).functionMods ?? [],
              actions: (await window.api.mods.flowCatalog(threadId)).actions ?? []
            }
          }, fixture.workspace)
    compiled =
      retained ??
      compileNativeComposition(prepared.source, {
        files: prepared.files,
        actionCatalog: setup.actions as ClawActionDescriptor[]
      })
    originalExecutable = compiled
    for (const binding of compiled.actionLock.bindings)
      assert(
        setup.approvedProviders.some(
          (provider) =>
            provider.pluginId === binding.ref.pluginId &&
            provider.digest === binding.ref.digest &&
            provider.state === "ready"
        ),
        `Retain the originally authored provider identity: ${binding.ref.plugin}/${binding.ref.actionId}`
      )
    events.push({
      type: creatorIdentity
        ? "creator-original-author-provider-identities-verified"
        : resume
          ? "existing-native-workspace-dependency-consent-verified"
          : "native-new-workspace-dependency-consent",
      ...setup
    })
    const zip = new AdmZip()
    for (const file of compiled.files) zip.addFile(file.path, file.bytes)
    evidence.compilation = {
      provenance: process.env.AUTOBIZ_MUTATION_PROFILE_DIR
        ? "retained-authored-executable-bytes"
        : "controlled-fixture-compilation",
      sourceDigest: compiled.lock.sourceDigest,
      runtime: compiled.runtime,
      actionLock: compiled.actionLock,
      files: compiled.files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) }))
    }
    let creator: Awaited<ReturnType<typeof mutationCreatorJourney>> | undefined
    if (creatorIdentity) {
      creator = await mutationCreatorJourney({
        app,
        page,
        identity: creatorIdentity,
        deadline: Date.now() + 3600000,
        restartUnstartedProjectId: process.env.AUTOBIZ_MUTATION_RESTART_UNSTARTED_PROJECT,
        record(value) {
          events.push(value)
          save()
        }
      })
      inspectCreator = creator.inspect
      view =
        completedTrialEvidence || resumeCreatorE2e
          ? await page.evaluate(
              (id) => window.api.harnessBoard.localProjects.get(id),
              (retainedTrialView ?? resume!.created).project.projectId
            )
          : await creator.createTrial()
      projectLeg = "creator-trial"
      fixture.workspace = view.project.workspace
      if (completedTrialEvidence) {
        if (completedTrialEvidence.creatorTrial)
          assertRetainedCompletedCreatorTrial(completedTrialEvidence.creatorTrial.completed, view)
        else assertMutationRecordedCompletedTrial(completedTrialEvidence, view)
        await creator.assertPassed(view)
        if (mutation === "replace-middle") {
          for (const stageId of prepared.source.modules.slice(2, 4).map((stage) => stage.id)) {
            const operations = view.operations.filter(
              (operation) => operation.stageId === stageId && operation.status === "transitioned"
            )
            assert.equal(
              operations.length,
              1,
              "One original completed replacement-stage operation required"
            )
            await auditNativeStageConsumption(view, operations[0], "retained-completed-trial")
          }
        }
        initialized = {
          knowledge: join(fixture.workspace, "acceptance-knowledge"),
          browserDirectory: join(fixture.workspace, "acceptance-browser")
        }
        events.push({
          type: "original-completed-trial-receipts-verified-without-replay",
          projectId: view.project.projectId
        })
      } else if (resumeCreatorE2e) {
        const observe = async () => {
          const current = await page!.evaluate(
            (id) => window.api.harnessBoard.localProjects.get(id),
            resume!.created.project.projectId
          )
          const result = assertMutationRecordedE2eTrialResume(resume!, {
            view: current,
            creator: await creator!.inspect(),
            identity: creatorIdentity,
            source: {
              directory: prepared.directory,
              inputSourceSha256: prepared.inputSourceSha256
            },
            compilation: evidence.compilation,
            authorEvidenceSha256: profile.priorEvidenceSha256!
          })
          return { current, result }
        }
        const before = await observe()
        assert(["active", "expired"].includes(before.current.preview?.state ?? ""))
        if (before.current.preview?.state === "expired") {
          const panel = await openCreatorProjectPreview(page)
          const drafts = await page.evaluate(
            (id) => window.api.harnessBoard.localProjects.preview.list(id),
            creatorIdentity.threadId
          )
          const draft = drafts.drafts.find(
            (value) => value.id === resume!.finalNativeCreatorStatus!.projectTrial!.draftId
          )
          assert(draft && draft.recovery)
          assert.equal(draft.digest, creatorIdentity.candidateDigest)
          assert.equal(draft.revision, creatorIdentity.revision)
          assert.equal(draft.recovery.projectId, before.current.project.projectId)
          assert.equal(draft.recovery.projectVersion, before.current.project.version)
          assert.equal(draft.recovery.digest, creatorIdentity.candidateDigest)
          assert.equal(draft.recovery.status, "needs-confirmation")
          assert.equal(draft.recovery.hasUnconfirmedEffects, false)
          const card = panel.locator("article").filter({
            has: page.getByText(`${draft.name} · 版本 ${draft.revision}`, { exact: true })
          })
          const calls = model.requests.length
          await card.getByRole("checkbox", { name: "恢复此版本的试用记录", exact: true }).check()
          await card.getByRole("button", { name: "核对并恢复原试用", exact: true }).click()
          await waitProject(
            (value) => value.preview?.state === "active",
            "AUTOBIZ_CREATOR_ORIGINAL_E2E_RECOVERY_TIMEOUT"
          )
          assert.equal(model.requests.length, calls, "Native recovery must not replay any stage")
        }
        const after = await observe()
        assert.equal(after.current.preview?.state, "active")
        assert.deepEqual(after.current.project, before.current.project)
        assert.deepEqual(after.current.operations, before.current.operations)
        view = after.current
        initialized = {
          knowledge: join(fixture.workspace, "acceptance-knowledge"),
          browserDirectory: join(fixture.workspace, "acceptance-browser")
        }
        evidence.originalSuccessfulStages = after.result.operations
        events.push({
          type: "original-creator-pending-e2e-receipts-verified-without-replay",
          projectLeg,
          projectId: view.project.projectId,
          stageIndex: 8,
          nativeCurrent: view,
          priorEvidenceSha256: sha256(resumeBytes!),
          historicalAcceptancePassed: false,
          stageExecutionReplayed: false,
          historicalApplication: resume!.application,
          currentApplication: evidence.application
        })
        for (const operation of view.operations)
          await auditNativeStageConsumption(view, operation, "retained-stage")
      } else {
        assert(
          !existsSync(join(fixture.workspace, ".git")),
          "Fresh native trial workspace required"
        )
        initialized = initializeMutationWorkspace(root, fixture.workspace)
      }
      model.bindWorkspace(fixture.workspace)
      await openUnifiedHostProject(page, view.project.name, view.project.workspace)
      if (!completedTrialEvidence && !resumeCreatorE2e)
        evidence.nativeTrialSourceConsent = await configureMutationProjectViaUi({
          page,
          view,
          knowledgeRoot: initialized.knowledge,
          additionalConfiguration: currentUiE2eConfiguration,
          record(value) {
            events.push(value)
            save()
          }
        })
      verifyRetainedCandidate()
    } else {
      if (!resume) await install([...zip.toBuffer()], "autobiz-mutation-project.zip")
      const templates = await page.evaluate(() => window.api.harnessBoard.localProjects.templates())
      const template = templates.find((template) => template.name === prepared.source.plugin.id)
      assert(template && !template.unavailableReason, JSON.stringify(templates))
      const installed = await page.evaluate(
        async (id) => (await window.api.plugins.list()).find((plugin) => plugin.id === id),
        template.installedPluginId
      )
      assert(installed)
      for (const file of compiled.files)
        assert(
          readFileSync(join(installed.path, file.path)).equals(file.bytes),
          `Public installation must retain the exact authored executable bytes: ${file.path}`
        )
      evidence.installedCandidate = {
        id: installed.id,
        path: installed.path,
        filesVerified: compiled.files.length
      }
      view = resume
        ? await page.evaluate(
            (id) => window.api.harnessBoard.localProjects.get(id),
            resume.created.project.projectId
          )
        : await createUnifiedHostProject(app, page, {
            name: `AutoBiz mutation ${mutation} ${basename(artifacts)}`,
            workspace: fixture.workspace,
            installedPluginId: template.installedPluginId,
            pluginName: template.name,
            version: template.version,
            goal: "订单查询必须在2秒内返回；保留全部原生检查，最后真实运行浏览器验证。"
          })
      evidence.created = view
      const unknown = resume && view.operations.find((operation) => operation.status === "unknown")
      if (unknown) {
        const reconciled = await command({ kind: "reconcile", operationId: unknown.operationId })
        const outcome = reconciled.operations.find(
          (value) => value.operationId === unknown.operationId
        )
        events.push({
          type: "original-project-native-reconciliation",
          operationId: unknown.operationId,
          before: unknown.status,
          after: outcome?.status,
          terminal: outcome?.execution?.terminal
        })
        view = reconciled
        verifyRetainedCandidate()
        save()
        assert(outcome?.status !== "unknown", "AUTOBIZ_ORIGINAL_PROJECT_RECONCILIATION_BLOCKED")
      }
      const source = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.mods.read(id),
        view.project.projectId
      )
      assert(source.source)
      if (!resume)
        for (const [key, value] of [
          ["knowledgeRoot", initialized.knowledge],
          [
            "selectedDeployUnits",
            JSON.stringify([{ deployUnitId: "orders-api", appType: "backend" }])
          ]
        ]) {
          const config = await page.evaluate(
            ({ id, plugin }) =>
              window.api.harnessBoard.localProjects.mods.config.userConfig(id, plugin),
            { id: view.project.projectId, plugin: view.project.installedPluginId }
          )
          await page.evaluate(
            ({ id, config, key, value }) =>
              window.api.harnessBoard.localProjects.mods.config.saveUserConfig(
                id,
                config,
                key,
                value
              ),
            { id: view.project.projectId, config, key, value }
          )
        }
      const currentSource = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.mods.read(id),
        view.project.projectId
      )
      if (currentUiE2eConfiguration) {
        await openUnifiedHostProject(page, view.project.name, view.project.workspace)
        await saveMutationProjectConfigurationViaUi({
          page,
          view,
          values: currentUiE2eConfiguration,
          record(value) {
            events.push(value)
            save()
          }
        })
      }
      if (currentSource.source?.state !== "ready")
        await page.evaluate((input) => window.api.harnessBoard.localProjects.mods.approve(input), {
          projectId: view.project.projectId,
          projectVersion: view.project.version,
          packageDigest: view.project.pluginDigest,
          compiledDigest: currentSource.source!.digest
        })
      const approvedSource = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.mods.read(id),
        view.project.projectId
      )
      assert.equal(
        approvedSource.source?.state,
        "ready",
        "Current native project source consent required"
      )
      evidence.nativeProjectSourceConsent = approvedSource
    }
    assert(view)
    evidence.created = view
    const resumeStageIndex = resume ? view.project.stageIndex : 0
    if (resume && !resumeCreatorE2e) {
      assert.equal(view.project.projectId, resume.created.project.projectId)
      assert.equal(view.project.installedPluginId, resume.installedCandidate!.id)
      assert.equal(view.project.pluginDigest, resume.created.project.pluginDigest)
      assert.equal(resumeStageIndex, 5, "Only failed original Code attempt may be retried")
      assert.equal(view.project.manifest.stages[resumeStageIndex].id, "code")
      const prior = resume.events
        .filter(
          (event) => event.type === "stage-settled" && event.operation?.status === "succeeded"
        )
        .map((event) => event.operation!)
      assert.equal(prior.length, resumeStageIndex)
      for (const operation of prior) {
        const original = view.operations.find(
          (value) => value.operationId === operation.operationId
        )
        assert(
          original && original.status === "transitioned",
          "Successful original stage was natively advanced"
        )
        assert(
          original.receipts.length && original.receipts.every((value) => value.result === "passed")
        )
        assert.deepEqual(
          original.receipts,
          operation.receipts,
          "Original successful receipts remain unchanged"
        )
      }
      assert(
        view.operations.some(
          (operation) => operation.stageId === "code" && operation.status === "failed"
        )
      )
      evidence.originalSuccessfulStages = prior
    }
    save()
    if (hookProbe) {
      console.log("AUTOBIZ_MUTATION_HOOK_PROBE")
      const operation = await run("hook-secret", "failed")
      const denied = join(fixture.workspace, "application.properties")
      assert.equal(model.hookRejections.length, 1)
      assert(!existsSync(denied), "The original Hook must prevent the sensitive write")
      assert(!existsSync(join(fixture.workspace, "NORMALIZED_REQUIREMENTS.json")))
      assert.equal(
        events.filter((event) => event.type === "native-approval").length,
        0,
        "A Hook-rejected write must never reach native file approval"
      )
      const state = await read()
      await assert.rejects(() => command({ kind: "advance", operationId: operation.operationId }))
      assert.deepEqual(await read(), state)
      assert.match(
        readFileSync(join(artifacts, "main.stdout.log"), "utf8"),
        /\[Hooks\] PreToolUse hook \(command\) "python -I -B -X utf8 hooks\/check-secrets\.py" → exit=2, blocked=true/
      )
      verifyRetainedCandidate()
      evidence.hookProbe = {
        operation,
        blockedFile: denied,
        fileExists: false,
        fileApprovalRequests: 0,
        stageOutcome: operation.status,
        requiredOutputAbsent: true,
        nativeFileValidationReceipts: operation.receipts,
        businessActionCheckExecuted: false,
        advanceRejected: true
      }
      evidence.passed = true
      save()
      console.log(`PASS original Hook native-tool rejection probe only: ${artifacts}`)
      return
    }
    async function executeProject(startIndex: number, includeNegatives: boolean) {
      assert(view && page)
      const expectedPluginDigest = view.project.pluginDigest
      const initialStdoutLength = existsSync(join(artifacts, "main.stdout.log"))
        ? readFileSync(join(artifacts, "main.stdout.log"), "utf8").length
        : 0
      for (const stage of prepared.source.modules.slice(startIndex, 8)) {
        console.log(`AUTOBIZ_MUTATION_STAGE ${stage.id}`)
        const operation = await run()
        assert.equal(operation.stageId, stage.id)
        await advance()
      }
      if (prepared.source.modules.length === 9) {
        for (const negative of [
          "original-fail",
          "zero",
          "fail",
          "fake",
          "substitution",
          "forged-selection"
        ].filter(() => includeNegatives) as MutationCase[]) {
          console.log(`AUTOBIZ_MUTATION_NEGATIVE ${negative}`)
          const operation = await run(negative, "failed")
          if (["original-fail", "zero", "fail", "fake"].includes(negative)) {
            assert(activeThread)
            const workflow = await latestWorkflow()
            // The retained verify script really throws; the result model consumes its original
            // failed notification and the stage's existing artifact check rejects the absence of
            // a success selection. No completed wrapper or fabricated report is used here.
            assert(workflow)
            assert.equal(workflow.status, "error")
            assert.match(workflow.error ?? "", /TEST_EXECUTION_FAILED/)
            assert.equal(workflow.notificationDelivered, true)
            assert.equal(workflow.result, undefined)
            assert(
              !existsSync(join(fixture.workspace, browserReport!.path)),
              "A thrown original workflow cannot manufacture a success selection"
            )
            const receipt = originalMutationTestReceipt(
              fixture.env.CMB_COWORK_AGENT_HOME,
              activeThread,
              { runId: workflow.runId }
            )
            assert.equal(receipt.status, "failed")
            assert.equal(receipt.output.passed, false)
            if (["original-fail", "fail"].includes(negative)) assert(receipt.counts.failed > 0)
            else
              assert.equal(
                receipt.counts.total,
                0,
                "No stdout report may create registered tests in the original runner"
              )
            events.push({
              type: "original-verify-throw-consumed",
              kind: negative,
              workflow,
              ...receipt
            })
          } else if (negative === "substitution") {
            const selection = readBrowserSelection()
            const receipt = originalMutationTestReceipt(
              fixture.env.CMB_COWORK_AGENT_HOME,
              operation.execution!.threadId!,
              selection
            )
            assert.equal(receipt.status, "succeeded")
            assert.equal(receipt.output.passed, true)
            assert(receipt.counts.total > 0 && receipt.counts.failed === 0)
            const check = originalMutationCheckReceipt(fixture.env.CMB_COWORK_AGENT_HOME, {
              workspace: fixture.workspace,
              threadId: operation.execution!.threadId!,
              operationId: operation.operationId,
              actionId: view!.project.manifest.checks.find((check) =>
                browserReport!.checkIds.includes(check.id)
              )!.actionId!
            })
            assert.equal(check.fact.passed, false)
            assert.match(JSON.stringify(check.fact), /TEST_EXPECTED_ENTRY_MISMATCH/)
            events.push({
              type: "real-passing-substitute-rejected-by-ui-bound-check",
              ...receipt,
              check
            })
          }
          const state = await read()
          await assert.rejects(() =>
            command({ kind: "advance", operationId: operation.operationId })
          )
          assert.deepEqual(
            await read(),
            state,
            "A failed original check cannot advance or alter project state"
          )
        }
        const passed = await run("pass")
        const selection = readBrowserSelection()
        const receipt = originalMutationTestReceipt(
          fixture.env.CMB_COWORK_AGENT_HOME,
          passed.execution!.threadId!,
          selection
        )
        assert.equal(receipt.status, "succeeded")
        assert.equal(receipt.output.passed, true)
        assert(receipt.counts.total > 0 && receipt.counts.passed > 0)
        assert.equal(receipt.counts.failed, 0)
        assert.equal(receipt.counts.skipped, 0)
        assert(Array.isArray(receipt.output.subjects) && receipt.output.subjects.length >= 1)
        const check = originalMutationCheckReceipt(fixture.env.CMB_COWORK_AGENT_HOME, {
          workspace: fixture.workspace,
          threadId: passed.execution!.threadId!,
          operationId: passed.operationId,
          actionId: view!.project.manifest.checks.find((check) =>
            browserReport!.checkIds.includes(check.id)
          )!.actionId!
        })
        assert.equal(check.fact.passed, true)
        assert.equal(
          check.fact.output?.expectedEntryBound,
          true,
          "The original checker must independently bind the actual native UI test selection"
        )
        events.push({ type: "original-positive-browser-receipt", ...receipt, check })
        // Approve the current result first, so the next rejection can only establish stale
        // inputs/evidence, rather than accidentally testing the separate human approval gate.
        await approveResult()
        const accepted = await read()
        const upstream = join(fixture.workspace, "CODE_RESULT.json")
        const bytes = readFileSync(upstream)
        writeFileSync(upstream, bytes.toString("utf8") + "\n")
        await assert.rejects(
          () => command({ kind: "advance", operationId: passed.operationId }),
          (error: unknown) => /(?:EVIDENCE_STALE|INPUT_CHANGED)/.test(String(error)),
          "Upstream changes invalidate original evidence"
        )
        assert.equal((await read()).project.stageIndex, accepted.project.stageIndex)
        writeFileSync(upstream, bytes)
        events.push({
          type: "upstream-change-rejected",
          operationId: passed.operationId,
          path: "CODE_RESULT.json"
        })
        view = await read()
        await advance()
      }
      assert.equal(view!.project.status, "completed")
      assert.equal(view!.project.pluginDigest, expectedPluginDigest)
      assert.deepEqual(model.errors, [])
      if (startIndex <= 2) {
        const reads = model.requiredKnowledgeReads.filter(
          (event) =>
            event.event === "native-response-validated" &&
            event.workspace === fixture.workspace &&
            event.phase === "specs"
        )
        assert(
          reads.length > 0,
          "Original review-specs method must be read and verified before SPECS output"
        )
        events.push({
          type: "original-spec-method-native-response-consumed",
          projectLeg,
          projectId: view!.project.projectId,
          reads
        })
      }
      const stdout = readFileSync(join(artifacts, "main.stdout.log"), "utf8").slice(
        initialStdoutLength
      )
      const guardedWrites =
        stdout.match(
          /\[Hooks\] PreToolUse hook \(command\) "python -I -B -X utf8 hooks\/check-secrets\.py" → exit=0, blocked=false/g
        )?.length ?? 0
      assert(
        guardedWrites >= 8 - startIndex,
        "Retained PreToolUse guard must actually run for original stage writes"
      )
      events.push({
        type: "retained-hook-execution-observed",
        projectLeg,
        projectId: view!.project.projectId,
        source: "original Electron hook diagnostics, not a replacement business-check receipt",
        guardedWrites
      })
      verifyRetainedCandidate()
      await openUnifiedHostProject(page, view!.project.name, view!.project.workspace)
      await page.screenshot({ path: join(artifacts, `completed-${projectLeg}.png`) })
      return view!
    }
    const firstCompleted = completedTrialEvidence
      ? view!
      : await executeProject(resumeStageIndex, true)
    if (creator) {
      const journey = await creator.assertPassed(firstCompleted)
      evidence.creatorTrial = { completed: firstCompleted, journey, controlledOutputs: true }
      save()
      const delivered = await creator.saveAndStart(
        firstCompleted,
        join(artifacts, "saved-plugin-workspace"),
        !!completedTrialEvidence
      )
      const savedExecutable = retainedMutationExecutable(delivered.plugin.path)
      assert.deepEqual(
        savedExecutable.actionLock,
        originalExecutable!.actionLock,
        "Native delivery must not rebind any originally authored provider"
      )
      for (const path of prepared.source.resources) {
        const before = originalExecutable!.files.find((file) => file.path === path)
        const after = savedExecutable.files.find((file) => file.path === path)
        assert(
          before && after && before.bytes.equals(after.bytes),
          `Native identity conversion must retain the tested business resource: ${path}`
        )
      }
      evidence.creatorDelivery = {
        ...delivered.delivery,
        authorCandidateDigest: creatorIdentity!.candidateDigest,
        trialPluginDigest: firstCompleted.project.pluginDigest,
        ordinaryPluginDigest: delivered.ordinary.project.pluginDigest,
        compositionSourceDigest: savedExecutable.lock.sourceDigest,
        conversion:
          "Original native delivery identity conversion; this is a distinct package requiring its own execution",
        files: savedExecutable.files.map((file) => ({
          path: file.path,
          sha256: sha256(file.bytes)
        }))
      }
      view = delivered.ordinary
      compiled = savedExecutable
      projectLeg = "saved-plugin-ordinary"
      fixture.workspace = view.project.workspace
      assert(!existsSync(join(fixture.workspace, ".git")), "Fresh ordinary workspace required")
      initialized = initializeMutationWorkspace(root, fixture.workspace)
      model.bindWorkspace(fixture.workspace)
      activeThread = undefined
      await openUnifiedHostProject(page, view.project.name, view.project.workspace)
      evidence.nativeOrdinarySourceConsent = await configureMutationProjectViaUi({
        page,
        view,
        knowledgeRoot: initialized.knowledge,
        additionalConfiguration: currentUiE2eConfiguration,
        record(value) {
          events.push(value)
          save()
        }
      })
      save()
      const ordinary = await executeProject(0, false)
      evidence.creatorOrdinary = {
        completed: ordinary,
        controlledOutputs: true,
        separatelyExecuted: true,
        deliveryDigest: delivered.delivery.digest
      }
      await creator.assertPassed(firstCompleted)
    }
    evidence.completed = view
    evidence.passed = true
    save()
    console.log(
      `PASS AutoBiz ${mutation}: ${creatorJourney ? "original Creator trial + native save/start-use + separately executed ordinary project" : resume ? "five retained successful stages + native Code retry and final stages" : "original eight business stages"}${prepared.source.modules.length === 9 ? " + native real-browser E2E negatives/positive" : " with replaced middle Skill"}: ${artifacts}`
    )
  } catch (error) {
    evidence.passed = false
    events.push({ type: "primary-failure", at: Date.now(), error: String(error) })
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: join(artifacts, "failure.png") })
      } catch (captureError) {
        events.push({ type: "failure-capture-unavailable", error: String(captureError) })
      }
    }
    console.error("AUTOBIZ_MUTATION_PRIMARY_FAILURE", error)
    throw error
  } finally {
    save()
    let physicallySettled = true
    try {
      await cancelActiveOperation("driver-finally")
    } catch (error) {
      physicallySettled = false
      events.push({ type: "cleanup-unconfirmed-app-retained", error: String(error) })
      save()
      console.error("AUTOBIZ_CLEANUP_UNCONFIRMED_APP_RETAINED", error)
    }
    if (app && physicallySettled)
      if (inspectCreator) {
        try {
          evidence.finalNativeCreatorStatus = await inspectCreator()
          save()
        } catch (error) {
          events.push({ type: "creator-final-observation-blocked", error: String(error) })
        }
      }
    if (app && physicallySettled)
      await app
        .close()
        .catch((error) => events.push({ type: "cleanup-failure", error: String(error) }))
    await new Promise<void>((done) => model.server.close(() => done()))
    clearTimeout(watchdog)
  }
}
function verifyRetainedCandidate() {
  if (completedTrialPath)
    assert.equal(
      sha256(readFileSync(completedTrialPath)),
      sha256(completedTrialBytes!),
      "Original completed-trial acceptance evidence remains unchanged"
    )
  if (resumePath)
    assert.equal(
      sha256(readFileSync(resumePath)),
      sha256(resumeBytes!),
      "Original failed runtime evidence remains unchanged"
    )
  if (process.env.AUTOBIZ_MUTATION_CANDIDATE_DIR) {
    assert.equal(
      sha256(readFileSync(join(prepared.directory, "composition/source.json"))),
      prepared.inputSourceSha256,
      "Externally authored candidate source remains unchanged"
    )
    for (const file of (originalExecutable ?? compiled).files)
      assert.equal(
        sha256(readFileSync(join(prepared.directory, file.path))),
        sha256(file.bytes),
        `Externally authored resource remains unchanged: ${file.path}`
      )
  }
  if (profile.priorEvidenceSha256)
    assert.equal(
      sha256(readFileSync(join(fixture.isolated, "evidence.json"))),
      profile.priorEvidenceSha256,
      "Original model-authoring evidence remains unchanged"
    )
}
main().catch((error) => {
  errors.push(String(error))
  save()
  console.error(error)
  process.exitCode = 1
})
