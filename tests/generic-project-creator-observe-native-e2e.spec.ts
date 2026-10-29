/** Read-only follow-up to retained live authoring/runtime evidence. Never executes or installs. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { auditGenericProjectRuntime } from "./support/generic-project-creator-scenario"
import { createHeadlessProjectCompositionLaunch, projectCompositionCandidate,
  projectCompositionEnvironment } from "./support/project-composition-e2e-fixtures"

async function main() {
  const root = resolve(__dirname, "..")
  assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1")
  const candidate = projectCompositionCandidate(root)
  assert.equal(candidate.execution, "built-output")
  assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
  const profile = realpathSync(resolve(process.env.GENERIC_PROJECT_CREATOR_PROFILE ?? ""))
  assert.equal(dirname(profile), join(root, "output/generic-project-creator-live-20261028"))
  const priorPath = join(profile, "continuation-runtime-repair-recovered.json")
  const prior = JSON.parse(readFileSync(priorPath, "utf8"))
  assert.equal(prior.fatal, "GENERIC_PROJECT_QUOTATION_NOT_FROM_CURRENT_SOURCE")
  assert.equal(prior.candidate.sha256,
    process.env.GENERIC_PROJECT_CREATOR_EXECUTION_SHA256 ?? candidate.sha256)
  const previousObservation = JSON.parse(readFileSync(
    join(profile, "generic-project-readonly-final-second.json"), "utf8"))
  assert.equal(previousObservation.passed, true)
  assert.equal(previousObservation.readOnly, true)
  assert.equal(previousObservation.candidate.sha256, prior.candidate.sha256)
  const trialExecution = JSON.parse(readFileSync(
    join(profile, "continuation-diagnostic-repair-2.json"), "utf8"))
  const trialTrace = JSON.parse(readFileSync(
    join(profile, "continuation-diagnostic-repair-2-runtime.json"), "utf8"))
  const trace = JSON.parse(readFileSync(
    join(profile, "continuation-runtime-repair-recovered-runtime.json"), "utf8"))
  const trial = trace.events.find((event) => event.trial)?.trial
  const completed = trace.events.find((event) => event.ordinary)
  assert(trial && completed?.ordinary && completed.delivery)
  assert.notEqual(trial.projectId, completed.ordinary.projectId)
  assert.deepEqual(completed.delivery, previousObservation.delivery)
  assert.deepEqual(previousObservation.observations.map((item) => item.projectId),
    [trial.projectId, completed.ordinary.projectId])
  const label = process.env.GENERIC_PROJECT_CREATOR_OBSERVATION_LABEL ?? "final"
  assert(/^[a-z0-9-]{1,32}$/.test(label))
  const output = join(profile, `generic-project-readonly-${label}.json`)
  writeFileSync(output, "{}", { flag: "wx" })
  process.env.COMPOSITION_E2E_ARTIFACT_ROOT = dirname(profile)
  const fixture = projectCompositionEnvironment(root)
  fixture.env.CMB_MODS_E2E = "0"
  for (const [key, value] of Object.entries(fixture.env))
    if (value.startsWith(fixture.isolated)) fixture.env[key] = join(profile,
      relative(fixture.isolated, value))
  fixture.isolated = profile
  fixture.workspace = join(profile, "workspace")
  const app = await createHeadlessProjectCompositionLaunch(root, fixture,
    { unobtrusivePresentation: true })()
  app.process().stderr?.on("data", (chunk) => appendFileSync(
    join(profile, "readonly-electron-stderr.log"), chunk.toString()))
  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => !!window.api?.harnessBoard)
    const observations = []
    for (const expected of [trial, completed.ordinary]) {
      const isTrial = expected.projectId === trial.projectId
      const originalTrace = isTrial ? trialTrace : trace
      const executionCandidate = isTrial ? trialExecution.candidate : prior.candidate
      const view = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id),
        expected.projectId)
      assert.equal(view.project.pluginDigest, expected.pluginDigest)
      for (const stage of view.project.manifest.stages) {
        const operation = view.operations.find((entry) => entry.stageId === stage.id &&
          entry.status === "transitioned")
        assert(operation && operation.receipts.length > 0 &&
          operation.receipts.every((receipt) => receipt.result === "passed"))
        assert.equal(operation.execution?.terminal?.outcome, "success")
        assert.equal(operation.resultApproval?.decision, "approved")
        const recorded = originalTrace.events.find((event) => event.kind ===
          (isTrial ? "trial" : "ordinary") && event.stageId === stage.id &&
          event.status === "succeeded")
        assert(recorded, "GENERIC_PROJECT_ORIGINAL_EXECUTION_RECORD_REQUIRED")
        assert.equal(operation.operationId, recorded.operationId)
        assert.equal(operation.execution?.threadId, recorded.threadId)
        assert.deepEqual(operation.receipts.map((receipt) => ({ id: receipt.checkId,
          result: receipt.result })), recorded.checks)
      }
      for (const artifact of expected.artifacts) {
        assert.equal(createHash("sha256").update(readFileSync(
          join(view.project.workspace, artifact.path))).digest("hex"), artifact.sha256)
      }
      observations.push({ ...await auditGenericProjectRuntime(page, expected.projectId),
        executionCandidate, validation: "read-only; original stages were not executed again" })
    }
    await page.screenshot({ path: join(profile, `generic-project-readonly-${label}.png`) })
    writeFileSync(output, JSON.stringify({ passed: true, readOnly: true, candidate,
      observationCandidate: candidate, businessExecutionCandidate: prior.candidate,
      validation: "ordinary project executed on the businessExecutionCandidate; this run only reads retained native state and unchanged artifacts",
      generationCandidate: prior.generationCandidate, priorEvidence: priorPath,
      delivery: completed.delivery, observations }, null, 2))
    console.log(JSON.stringify({ passed: true, output, projects: observations.length }))
  } finally {
    await app.close()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
