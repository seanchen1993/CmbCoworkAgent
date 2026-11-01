/** Explicit continuation of one owned, completed trial; never reruns authoring or trial stages. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ApprovalRequest } from "../src/main/types"
import { preview } from "vite"
import { normalizeWorkspacePathKey } from "../src/shared/workspace-path"
import { readModsSourceCandidate } from "./support/mods-source-candidate"
import { modsSourceDriverHashes } from "./support/mods-source-driver-hashes"
import {
  createHeadlessProjectCompositionLaunch,
  existingProjectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { genericModLiveRelay } from "./support/generic-mod-live-relay"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"
import { verifyLiveProjectZipIdentity } from "./support/live-project-zip-identity"
import { matrixReportRuntimeGoal, assertMatrixAssembly } from "./support/creator-project-matrix"
import { exerciseLiveOriginalFeatureJourney } from "./support/live-original-feature-journey"

const root = resolve(__dirname, "..")
const expectedRun = join(root, "output/phase3-source-report-derived-eaf7e545/journey/run-Dggxy8")
const threadId = "788ae4df-ae09-40a3-90c8-5cb00288ad50"
const sourceDigest = "07c6b6e37392103c1572d521727f090f083f08a9c315559a5b1e646a205e892d"
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
function inside(parent: string, path: string) {
  const tail = relative(realpathSync(parent), realpathSync(path))
  assert(
    tail &&
      !isAbsolute(tail) &&
      tail !== ".." &&
      !tail.startsWith("..\\") &&
      !tail.startsWith("../"),
    "CONTINUATION_PATH_OUTSIDE_OWNED_RUN"
  )
  return realpathSync(path)
}

async function main() {
  assert.equal(process.env.CREATOR_INSTALLED_REPORT_CONTINUE, "1", "EXPLICIT_CONTINUATION_REQUIRED")
  assert.equal(
    realpathSync(process.env.CREATOR_INSTALLED_REPORT_RUN ?? ""),
    realpathSync(expectedRun)
  )
  const ownedRun = realpathSync(expectedRun)
  const manifest = process.env.COMPOSITION_E2E_SOURCE_CANDIDATE
  assert(manifest, "CONTINUATION_SOURCE_MANIFEST_REQUIRED")
  const candidate = readModsSourceCandidate(manifest)
  assert.equal(candidate.head, "e31d8ad1943b3c9981f0827f6e8cb7687c84b454")
  const oldEvidence = join(ownedRun, "evidence.json")
  const oldRuntime = join(ownedRun, "evidence-matrix-1-runtime.json")
  const oldSource = join(ownedRun, "matrix-1-assembly.json")
  const firstPath = join(ownedRun, "matrix-1-first.json")
  const immutable = Object.fromEntries(
    [oldEvidence, oldRuntime, oldSource, firstPath, manifest].map((path) => [path, hash(path)])
  )
  const prior = read(oldEvidence)
  assert.equal(prior.fatal, "LIVE_ORIGINAL_FEATURE_FAILED")
  const observation = prior.observations[0]
  assert.equal(observation.threadId, threadId)
  assert.equal(observation.requests.length, 13)
  assert(observation.requests.every((request: { status: number }) => request.status === 200))
  const requests = observation.runtime.stages.flatMap(
    (stage: { requests: unknown[] }) => stage.requests
  )
  assert.equal(requests.length, 13)
  assert(requests.every((request: { status: number }) => request.status === 200))
  const runtime = read(oldRuntime)
  const trial = runtime.events.find((event: { trial?: unknown }) => event.trial)?.trial
  assert(trial && trial.status === "completed" && trial.stageIndex === 3)
  const successful = runtime.events.filter(
    (event: { status?: string }) => event.status === "succeeded"
  )
  assert.equal(successful.length, 3)
  assert(
    successful.every(
      (event: { checks: Array<{ result: string }> }) =>
        event.checks.length > 0 && event.checks.every((check) => check.result === "passed")
    )
  )
  const first = read(firstPath)
  const assembly = read(oldSource)
  assert.equal(assembly.originVerified, true)
  assert.equal(assembly.assemblyVerified, true)
  assert.equal(assembly.after.digest, sourceDigest)
  assertMatrixAssembly(first, assembly.after, "report-derived")
  const output = join(
    root,
    "output",
    `phase3-installed-report-continuation-${randomUUID().slice(0, 8)}`
  )
  mkdirSync(output)
  const entry = "tests/creator-installed-report-continuation-native-e2e.spec.ts"
  const driverHashes = await modsSourceDriverHashes(root, [entry])
  const events: unknown[] = []
  const relay = genericModLiveRelay()
  const proof = {
    kind: "installed-report-first-lineage-handoff-only",
    ownedRun,
    manifest,
    head: candidate.head,
    priorEvidence: oldEvidence,
    priorRuntime: oldRuntime,
    priorSource: oldSource,
    priorAuthoringRequests: 13,
    priorRuntimeRequests: 13,
    newAuthoringRequests: 0,
    rerunTrial: false,
    sourceDigest,
    model: relay.model,
    driverHashes,
    immutable,
    startedAt: new Date().toISOString()
  }
  const save = () =>
    writeFileSync(
      join(output, "evidence.json"),
      JSON.stringify(
        {
          ...proof,
          events,
          requests: relay.metrics
        },
        null,
        2
      )
    )
  save()
  console.log(JSON.stringify({ output, ownedRun, head: candidate.head, scenario: proof.kind }))
  const modelUrl = await relay.listen()
  // Reopen only the already compiled bytes, at their pinned origin. No rebuild or manifest edit.
  const rendererOrigin = new URL(candidate.rendererUrl)
  assert.equal(rendererOrigin.hostname, "127.0.0.1")
  const renderer = await preview({
    configFile: false,
    envDir: false,
    envPrefix: [],
    root: join(root, "src/renderer"),
    build: { outDir: join(candidate.root, "renderer") },
    preview: { host: "127.0.0.1", port: Number(rendererOrigin.port), strictPort: true },
    logLevel: "silent"
  }).catch(async (error) => {
    await relay.close()
    throw error
  })
  const fixture = existingProjectCompositionEnvironment(root, ownedRun)
  const app = await createHeadlessProjectCompositionLaunch(root, fixture)().catch(async (error) => {
    await renderer.close()
    await relay.close()
    throw error
  })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(20_000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const workspace = join(ownedRun, "workspace/document")
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()
    const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
    if (!(await chat.isVisible()))
      await page
        .getByText("Live creator acceptance · two-stage-document-project", { exact: true })
        .first()
        .click()
    await enterModsCreatorChat(page, threadId, workspace)
    const state = await page.evaluate(
      (id) => window.api.mods.development.status({ threadId: id }),
      threadId
    )
    assert.equal(normalizeWorkspacePathKey(state.workspace), normalizeWorkspacePathKey(workspace))
    assert.equal(state.mode, "creator")
    assert.equal(state.projectTrial?.digest, sourceDigest)
    assert.equal(state.projectTrial?.journey?.projectId, trial.projectId)
    assert.equal(state.projectTrial?.journey?.phase, "passed")
    assert.equal(state.projectTrial?.journey?.canDeliver, true)
    const currentTrial = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.get(id),
      trial.projectId
    )
    assert.equal(currentTrial.project.status, "completed")
    assert.equal(currentTrial.project.stageIndex, 3)
    assert.equal(
      currentTrial.operations.filter((operation) => operation.status === "transitioned").length,
      3
    )
    for (const operation of currentTrial.operations) {
      assert(operation.status !== "unknown", "CONTINUATION_UNKNOWN_OPERATION")
      assert(operation.receipts.every((receipt) => receipt.result === "passed"))
    }
    for (const artifact of trial.artifacts) {
      const path = inside(ownedRun, resolve(currentTrial.project.workspace, artifact.path))
      assert.equal(hash(path), artifact.sha256, "CONTINUATION_TRIAL_ARTIFACT_CHANGED")
      immutable[path] = artifact.sha256
    }
    const upload = runtime.events.find(
      (event: { operation?: string }) => event.operation === "zip-original-upload"
    )
    assert(
      upload &&
        upload.upload === "original-PluginsPanel-file-input" &&
        upload.copiedGrants === false
    )
    assert.equal(state.projectDelivery?.sourceDigest, sourceDigest)
    assert.equal(state.projectDelivery?.phase, "exported")
    assert.equal(state.projectDelivery?.output, upload.zip)
    assert(!state.projectDelivery?.canReconcile, "REPORT_CONTINUATION_EXPORT_RECONCILE_REQUIRED")
    assert.equal(upload.newInstallation, "d50d6b3b-31a3-4020-bbf7-ed7b46076d5a")
    assert.equal(upload.sourceDigest, sourceDigest)
    const uploadedZip = inside(ownedRun, upload.zip)
    assert.equal(hash(uploadedZip), upload.sha256)
    const originalDirectory = inside(
      ownedRun,
      join(ownedRun, "data/creator-project-deliveries/13425207-1c5b-4266-9362-54c440b6b2fb")
    )
    const verified = await verifyLiveProjectZipIdentity({
      zip: uploadedZip,
      originalDirectory,
      expectedOriginalDigest: upload.packageIdentity.originalContentDigest,
      name: upload.identity.name,
      version: upload.identity.version
    })
    assert.equal(verified.zipContentDigest, upload.packageIdentity.zipContentDigest)
    assert.equal(verified.zipSha256, upload.sha256)
    immutable[uploadedZip] = hash(uploadedZip)
    for (const file of Object.keys(verified.fileHashes)) {
      if (file === "devclaw.package-report.json") continue
      const path = inside(ownedRun, join(originalDirectory, file))
      immutable[path] = hash(path)
    }
    const plugins = await page.evaluate(() => window.api.plugins.list())
    assert(!plugins.some((plugin) => plugin.id === upload.oldInstallation))
    const fresh = plugins.filter(
      (plugin) =>
        plugin.id === upload.newInstallation &&
        plugin.name === upload.identity.name &&
        plugin.version === upload.identity.version
    )
    assert.equal(fresh.length, 1, "REPORT_CONTINUATION_EXACT_FRESH_INSTALLATION_REQUIRED")
    const plugin = fresh[0]
    inside(ownedRun, plugin.path)
    const prepared = await page.evaluate((input) => window.api.plugins.prepareStartUse(input), {
      threadId,
      expectedWorkspace: workspace,
      pluginId: plugin.id,
      expected: { name: plugin.name, version: plugin.version, digest: verified.zipContentDigest }
    })
    assert.equal(prepared.kind, "host-project")
    assert.deepEqual(prepared.identity, upload.identity)
    const zip = { plugin, identity: prepared.identity }
    events.push({
      operation: "continue-prior-first-lineage-original-ui-upload",
      newExport: false,
      newUpload: false,
      newDelete: false,
      verified,
      identity: zip.identity
    })
    events.push({
      operation: "prior-completed-trial-read-only-verified",
      projectId: trial.projectId
    })
    save()
    await page.evaluate(
      async ({ modelUrl, model }) => {
        await window.api.models.setCustomConfig({
          id: "live-isolated-relay",
          name: "真实模型隔离转发",
          baseUrl: modelUrl,
          model,
          apiKey: "localhost-dummy-only",
          maxTokens: 128000,
          maxOutputTokens: 8192,
          enableThinking: false
        })
        await window.api.models.setDefault("custom:live-isolated-relay")
      },
      { modelUrl, model: relay.model }
    )
    const deadline = Date.now() + 300_000
    const creator = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    if (await creator.isVisible())
      await creator.getByRole("button", { name: "Close", exact: true }).click()
    const suffix = randomUUID().slice(0, 8)
    const journey = await exerciseLiveOriginalFeatureJourney({
      app,
      page,
      isolationRoot: ownedRun,
      workspaceParent: ownedRun,
      artifacts: output,
      artifactPrefix: "continued-report-installed",
      installed: {
        pluginId: zip.plugin.id,
        name: zip.plugin.name,
        version: zip.plugin.version,
        sourceDigest: zip.identity.digest
      },
      project: {
        name: `Continued report ${suffix}`,
        code: `CONT${suffix}`,
        systemId: "MODS-ACCEPTANCE",
        systemName: "Isolated Mods acceptance",
        folder: `continued-${suffix}`
      },
      feature: { title: `Handoff ${suffix}`, goal: matrixReportRuntimeGoal },
      deadline,
      beginStage(label) {
        relay.phase(label)
        events.push({ operation: "new-original-stage", label })
        save()
      },
      endStage() {
        relay.phase("after-first-handoff")
        save()
      },
      execution: {
        providerBoundary: "commercial",
        maxStageTransitions: 1,
        confirmStage(view, operation) {
          assert.equal(relay.failure(), undefined)
          assert.deepEqual(view.project.manifest.stages, currentTrial.project.manifest.stages)
          assert.deepEqual(view.project.manifest.checks, currentTrial.project.manifest.checks)
          assert.equal(view.project.manifest.actions.length, 0)
          return (
            operation.status === "prepared" &&
            operation.stageId === view.project.manifest.stages[0].id
          )
        },
        confirmKnownResult(view) {
          const operation = view.operations.find(
            (item) => item.operationId === view.resultReview?.operationId
          )
          if (
            !operation ||
            operation.status !== "succeeded" ||
            operation.execution?.terminal?.outcome !== "success" ||
            !operation.receipts.length ||
            !operation.receipts.every((receipt) => receipt.result === "passed")
          )
            return false
          const outputs = view.project.manifest.stages[0].artifactIds
          for (const id of outputs) {
            const artifact = view.project.manifest.artifacts.find((item) => item.id === id)
            assert(artifact && artifact.path.endsWith(".json"))
            const path = inside(ownedRun, resolve(view.project.workspace, artifact.path))
            JSON.parse(readFileSync(path, "utf8"))
            events.push({
              operation: "first-stage-result-read",
              artifact: artifact.id,
              sha256: hash(path)
            })
          }
          save()
          return outputs.length > 0
        },
        async decideKnownEnvironmentApprovals({ view, operation, pending }) {
          if (relay.failure()) return false
          const allowed = view.project.manifest.stages[0].artifactIds.map(
            (id) => view.project.manifest.artifacts.find((item) => item.id === id)!
          )
          const approvals = pending as ApprovalRequest[]
          const valid = (approval: ApprovalRequest) =>
            approval.id &&
            approval.tool_call?.id &&
            approval.tool_call.name === "write_file" &&
            approval.operation === "write_file" &&
            !approval.command &&
            !approval.retry_reason &&
            approval.allowed_approval_types.includes("approve") &&
            allowed.some(
              (artifact) =>
                artifact.path.endsWith(".json") &&
                normalizeWorkspacePathKey(approval.filePath ?? "") ===
                  normalizeWorkspacePathKey(resolve(view.project.workspace, artifact.path))
            )
          if (!approvals.every(valid)) return false
          const executionThread = operation.execution!.threadId!
          const current = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            executionThread
          )
          for (const approval of approvals) {
            const same = (current as ApprovalRequest[]).find((item) => item.id === approval.id)
            assert(
              same &&
                valid(same) &&
                same.tool_call.id === approval.tool_call.id &&
                same.filePath === approval.filePath,
              "CONTINUATION_PENDING_APPROVAL_CHANGED"
            )
            await page.evaluate(
              (request) =>
                window.api.sandbox.sendApprovalDecision({
                  requestId: request.id,
                  type: "approve",
                  tool_call_id: request.tool_call.id
                }),
              approval
            )
            events.push({
              operation: "one-shot-declared-json-write",
              requestId: approval.id,
              threadId: executionThread,
              path: approval.filePath
            })
          }
          save()
          return true
        }
      }
    })
    events.push({ originalFeature: journey })
    save()
    const handoff = journey.steps.some(
      (step) => step.name === "stage-handoff" && step.status === "passed"
    )
    if (!handoff) await page.screenshot({ path: join(output, "continuation-terminal.png") })
    writeFileSync(
      join(output, "continuation-terminal-body.txt"),
      await page.locator("body").innerText()
    )
    assert.equal(relay.failure(), undefined)
    assert(handoff, "CONTINUATION_FIRST_HANDOFF_UNVERIFIED")
  } catch (error) {
    events.push({ error: relay.redact(error instanceof Error ? error.message : String(error)) })
    save()
    throw Error("INSTALLED_CONTINUATION_FAILED: see isolated evidence")
  } finally {
    await app.close()
    await relay.close()
    await renderer.close()
    readModsSourceCandidate(manifest)
    assert.deepEqual(await modsSourceDriverHashes(root, [entry]), driverHashes)
    for (const [path, digest] of Object.entries(immutable)) assert.equal(hash(path), digest)
    writeFileSync(
      join(output, "integrity.json"),
      JSON.stringify(
        { verified: true, completedAt: new Date().toISOString(), priorEvidenceUnchanged: true },
        null,
        2
      )
    )
  }
}

void main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
