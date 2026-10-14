/** Run only after the unified production build. Never edits C:/ai/autobiz_kanban. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  createAutobizPreset,
  withAutobizReportAction,
  type AutobizPreset
} from "../src/shared/mods/flows/autobiz-presets"
import type { FlowRun, HostFlowDefinition } from "../src/shared/mods/flows/types"
import type { ClawActionIdentity } from "../src/shared/mods/claw-actions"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { startAutobizModel } from "./support/mods-autobiz-model"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"

const root = resolve(__dirname, "..")
const upstream = process.env.CMB_AUTOBIZ_SOURCE || "C:/ai/autobiz_kanban"
const commit = "8db1ec937d6ed3d271cb9dc540310d6633c91e70"
const { isolated, workspace, env } = compositionEnvironment(root)
assert(process.env.CMB_MODS_PACKAGED_DIR?.trim(), "AUTOBIZ_E2E_PACKAGED_DIRECTORY_REQUIRED")
const artifacts = process.env.CMB_MODS_CORE_E2E_ARTIFACTS
  ? resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS)
  : join(root, "output/mods-autobiz-e2e")
assert(!existsSync(artifacts), "AUTOBIZ_E2E_ARTIFACT_DIRECTORY_ALREADY_EXISTS")
mkdirSync(artifacts, { recursive: true })
const launchApp = createModsCoreLauncher(root, isolated, env, artifacts)
new AdmZip(
  execFileSync("git", ["--no-replace-objects", "-C", upstream, "archive", "--format=zip", commit])
).extractAllTo(workspace)
mkdirSync(join(workspace, ".cmb"))
const configPath = join(workspace, ".cmb/project-checks.json")
const config = {
  schemaVersion: 1,
  unitTest: {
    runner: "python-unittest",
    startDirectory: "tests",
    pattern: "test_project_status_invalid_checkpoint.py"
  }
}
writeFileSync(configPath, JSON.stringify(config))
const sourcePath = join(workspace, "inspect_state.py")
const original = readFileSync(sourcePath, "utf8")
assert.equal(original.split('"currentNodeId": "unknown",').length, 2)
const testPath = join(workspace, "tests/test_project_status_invalid_checkpoint.py")
const testDigest = createHash("sha256").update(readFileSync(testPath)).digest("hex")
const packageZip =
  process.env.CMB_AUTOBIZ_MODS_ZIP ||
  join(root, "output/autobiz-integrated-2026-10-01-final/AutobizDevOps_Plugin_Kanban_Mods.zip")
const checks: string[] = []
const runs: FlowRun[] = []
const errors: string[] = []
const durations: Record<string, number> = {}
let app: ElectronApplication | undefined
let page: Page
let threadId: string
let reportAction: ClawActionIdentity | undefined
let runFailure: unknown
const pass = (name: string) => {
  checks.push(name)
  console.log("PASS " + name)
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 120_000
  do {
    const button = page
      .getByRole("button", { name: "运行", exact: true })
      .and(page.locator("button:not(nav button)"))
    if (await button.count()) {
      const command = (await button.locator("../..").locator("pre").innerText()).trim()
      assert(
        command.startsWith("python -B -c ") &&
          command.includes("unittest.defaultTestLoader.discover"),
        command
      )
      await button.click()
    }
    const edit = page.getByRole("button", { name: "允许", exact: true })
    if (await edit.count()) {
      const preview = await edit.locator("../..").locator("pre").innerText()
      assert(
        preview.startsWith("编辑:") &&
          preview
            .replaceAll("/", "\\")
            .toLowerCase()
            .includes(sourcePath.replaceAll("/", "\\").toLowerCase()),
        preview
      )
      await edit.click()
    }
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw Error(label)
}

async function execute(
  preset: AutobizPreset,
  suffix: string,
  alterAtApproval = false,
  externalReport = false
) {
  const base = createAutobizPreset(preset, `${preset}-${suffix}`)
  const definition = externalReport ? withAutobizReportAction(base, reportAction!) : base
  const startedAt = performance.now()
  const started = await page.evaluate(
    async (input) => {
      const { threadId, definition } = JSON.parse(input) as {
        threadId: string
        definition: HostFlowDefinition
      }
      const saved = await window.api.mods.flowSave(threadId, definition, 0)
      return window.api.mods.flowStart(threadId, saved.definition.id, saved.revision)
    },
    JSON.stringify({ threadId, definition })
  )
  const read = () =>
    page.evaluate(({ threadId, id }) => window.api.mods.flowRun(threadId, id), {
      threadId,
      id: started.id
    })
  let changed = false
  const final = await until(
    async () => {
      const run = await read()
      if (run?.pendingApproval) {
        if (alterAtApproval && !changed) {
          writeFileSync(
            configPath,
            JSON.stringify({
              ...config,
              unitTest: { ...config.unitTest, pattern: "test_does_not_exist.py" }
            })
          )
          changed = true
        }
        await page
          .evaluate(
            ({ threadId, runId, nonce }) =>
              window.api.mods.flowDecide(threadId, runId, nonce, true),
            { threadId, runId: run.id, nonce: run.pendingApproval.nonce }
          )
          .catch(() => undefined)
      }
      return read()
    },
    (run) =>
      Boolean(run && ["complete", "failed", "cancelled", "interrupted"].includes(run.status)),
    "Autobiz run timeout"
  )
  runs.push(final!)
  durations[suffix] = performance.now() - startedAt
  return final!
}

async function main() {
  const model = await startAutobizModel(workspace)
  const watchdog = setTimeout(() => void app?.close(), 480_000)
  const cleanupFailures: unknown[] = []
  try {
    app = await launchApp(60_000)
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), "1.5.7")
    app
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    app
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await app.firstWindow()
    page.on("pageerror", (error) => errors.push(error.message))
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await page.waitForFunction(() => Boolean(window.api?.mods?.flowSave))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    threadId = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.models.setCustomConfig({
          id: "autobiz",
          name: "Autobiz controlled model",
          baseUrl: url,
          model: "autobiz",
          apiKey: "isolated-fixture",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:autobiz")
        const row = await window.api.threads.create({
          title: "Autobiz 真实源码检视与复检",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (row as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { workspace, url: model.url }
    )
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "autobiz-components.zip"),
      [...readFileSync(packageZip)]
    )
    assert(installed.success, installed.error)
    const mod = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((item) => item.name === "AutobizDevOps_Plugin_Kanban_Mods")!
    assert(mod?.digest)
    await page.evaluate(
      async ({ threadId, mod }) => {
        await window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!)
        let view = await window.api.mods.clawView(threadId)
        const profile = {
          id: "autobiz",
          name: "Autobiz 按需组合",
          capabilities: [
            {
              pluginId: mod.pluginId,
              name: mod.name,
              digest: mod.digest!,
              components: { mode: "selected" as const, ids: ["status"], config: {} }
            }
          ],
          models: { default: "custom:autobiz", roles: {} }
        }
        view = await window.api.mods.clawChange(threadId, {
          kind: "save",
          profile,
          workspace: view.workspace,
          revision: view.revision
        })
        await window.api.mods.clawChange(threadId, {
          kind: "apply",
          id: profile.id,
          workspace: view.workspace,
          revision: view.revision
        })
      },
      { threadId, mod: { pluginId: mod.pluginId, name: mod.name, digest: mod.digest } }
    )
    const commands = await page.evaluate((id) => window.api.mods.commands(id), threadId)
    assert(commands.some((command) => command.command === "kanban-check"))
    assert(
      !commands.some((command) =>
        ["kanban", "kanban-review", "kanban-mode"].includes(command.command)
      )
    )
    pass(
      "Real generated ZIP installs/approves; selected status component omits review/completion commands"
    )
    await page.reload()
    await page.getByText("Autobiz 真实源码检视与复检", { exact: true }).first().click()
    const review = await execute("review", "review-only")
    assert.equal(review.status, "complete", JSON.stringify(review))
    assert(!review.attempts.some((attempt) => attempt.result?.source === "native-check"))
    assert(model.calls.some((call) => call.name === "read_file"))
    assert(!model.calls.some((call) => call.name === "edit_file"))
    pass("Review-only uses real read_file and emits no native project-test claim")
    const tested = await execute("review-test", "review-test")
    assert.equal(tested.status, "complete", JSON.stringify(tested))
    assert(
      tested.attempts.some(
        (attempt) => attempt.result?.source === "native-check" && attempt.status === "passed"
      )
    )
    pass(
      "Python project with no package.json executes the unchanged focused upstream test with real receipt"
    )
    const noRepair = await execute("repair-retest", "already-passing")
    assert.equal(noRepair.status, "complete", JSON.stringify(noRepair))
    assert(
      !noRepair.attempts.some(
        (attempt) => attempt.stepId === "repair" && attempt.status !== "skipped"
      )
    )
    pass("Already-passing source skips repair and retest rather than rewriting unnecessarily")
    writeFileSync(
      sourcePath,
      original.replace('"currentNodeId": "unknown",', '"currentNodeId": "fault-injected",')
    )
    const repaired = await execute("repair-retest", "injected-repair")
    assert.equal(repaired.status, "complete", JSON.stringify(repaired))
    assert(
      repaired.attempts.some((attempt) => attempt.stepId === "unit" && attempt.status === "failed")
    )
    assert(
      repaired.attempts.some(
        (attempt) => attempt.stepId === "repair" && attempt.status === "passed"
      )
    )
    assert(
      repaired.attempts.some(
        (attempt) => attempt.stepId === "retest" && attempt.status === "passed"
      )
    )
    assert.equal(readFileSync(sourcePath, "utf8"), original)
    assert.equal(createHash("sha256").update(readFileSync(testPath)).digest("hex"), testDigest)
    assert(model.calls.some((call) => call.name === "edit_file" && call.repair))
    const failedUnit = repaired.attempts.find(
      (attempt) => attempt.stepId === "unit" && attempt.status === "failed"
    )!
    assert(failedUnit.result)
    assert.equal(failedUnit.result?.source, "native-check")
    assert.equal(failedUnit.result?.passed, false)
    assert.equal(failedUnit.result?.check, "unit-test")
    assert(failedUnit.result.evidenceIds?.length)
    const repairIndex = repaired.attempts.findIndex(
      (attempt) => attempt.stepId === "repair" && attempt.status === "passed"
    )
    const retestIndex = repaired.attempts.findIndex(
      (attempt) => attempt.stepId === "retest" && attempt.status === "passed"
    )
    assert(repaired.attempts.indexOf(failedUnit) < repairIndex && repairIndex < retestIndex)
    assert.equal(
      repaired.attempts.filter(
        (attempt) => attempt.stepId === "repair" && attempt.status !== "skipped"
      ).length,
      1
    )
    const repairEvidence = (
      await page.evaluate((id) => window.api.mods.completionEvidence(id), threadId)
    ).filter((record) => record.runId === repaired.id)
    assert(
      repairEvidence.some((record) => {
        const detail = record.detail as { stepId?: string; exitCode?: number } | undefined
        return (
          record.phase === "validator.result" && record.status === "block" &&
          detail?.stepId === "unit" && typeof detail.exitCode === "number" && detail.exitCode !== 0
        )
      })
    )
    assert(
      repairEvidence.some((record) => {
        const detail = record.detail as { stepId?: string; exitCode?: number } | undefined
        return (
          record.phase === "validator.result" && record.status === "pass" &&
          detail?.stepId === "retest" && detail.exitCode === 0
        )
      })
    )
    writeFileSync(join(artifacts, "repair-evidence.json"), JSON.stringify(repairEvidence, null, 2))
    pass(
      "Injected source bug fails original test, real model-issued read/edit fixes implementation, unchanged test passes"
    )
    const reportZip = new AdmZip()
    reportZip.addLocalFolder(join(root, "examples/mods-component-kit"))
    reportZip.addFile(
      "mods/report.ts",
      Buffer.from(
        reportZip.readAsText("mods/report.ts").replace(
          "export function register(on) {",
          `export function register(on) {
  on("prompt.compose", async ($, facts, next) => {
    const current = await next(facts)
    return { sections: [...current.sections, {
      id: "cross-report:flow-evidence",
      text: "AUTOBIZ_BOUND_PROMPT_MOD_TRANSFORM",
      scope: "session"
    }] }
  })`
        ),
        "utf8"
      )
    )
    const importedReport = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "report-components.zip"),
      [...reportZip.toBuffer()]
    )
    assert(importedReport.success, importedReport.error)
    const reportMod = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((item) => item.name === "component-review-kit")!
    await page.evaluate(
      async ({ threadId, reportMod }) => {
        await window.api.mods.approveFunction(threadId, reportMod.pluginId, reportMod.digest!)
        let view = await window.api.mods.clawView(threadId)
        const profile = {
          ...view.active!,
          capabilities: [
            ...view.active!.capabilities,
            {
              pluginId: reportMod.pluginId,
              name: reportMod.name,
              digest: reportMod.digest!,
              components: { mode: "selected" as const, ids: ["report"], config: {} }
            }
          ]
        }
        view = await window.api.mods.clawChange(threadId, {
          kind: "save",
          profile,
          workspace: view.workspace,
          revision: view.revision
        })
        await window.api.mods.clawChange(threadId, {
          kind: "apply",
          id: profile.id,
          workspace: view.workspace,
          revision: view.revision
        })
      },
      {
        threadId,
        reportMod: {
          pluginId: reportMod.pluginId,
          name: reportMod.name,
          digest: reportMod.digest
        }
      }
    )
    reportAction = (
      await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)
    ).actions!.find(
      (action) => action.pluginId === reportMod.pluginId && action.actionId === "report"
    )
    assert(reportAction)
    const beforeReportedRequests = model.requests.length
    const reported = await execute("review-test", "cross-plugin-report", false, true)
    assert.equal(reported.status, "complete", JSON.stringify(reported))
    assert(
      reported.attempts.some(
        (attempt) =>
          attempt.stepId === "report" &&
          attempt.result?.source === "plugin-action" &&
          attempt.result.summary.includes("AUTOBIZ_REAL_EVIDENCE_REPORT")
      )
    )
    assert(
      model.requests.some(
        (request) =>
          !Array.isArray(request.tools) &&
          JSON.stringify(request.messages).includes('\\"nativeProjectTests\\":\\"passed\\"')
      )
    )
    pass(
      "A separately approved report component receives actual host review/test evidence and calls its model"
    )
    const flowAgentRequests = model.requests
      .slice(beforeReportedRequests)
      .filter((request) => Array.isArray(request.tools))
    assert(flowAgentRequests.length > 0, "The host Flow must actually call its child Agent model")
    for (const request of flowAgentRequests) {
      assert.match(JSON.stringify(request.messages), /AUTOBIZ_BOUND_PROMPT_MOD_TRANSFORM/)
    }
    pass(
      "The applied cross-plugin compose Hook transforms actual host Flow child Agent requests"
    )
    const stale = await execute("review-test", "configuration-changed", true)
    assert.notEqual(stale.status, "complete", JSON.stringify(stale))
    pass(
      "Changing ignored runner configuration during approval prevents stale test evidence from completing"
    )
    await page.screenshot({ path: join(artifacts, "autobiz-final.png") })
    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          checks,
          runs,
          durations,
          isolated,
          workspace,
          commit,
          testDigest,
          modelCalls: model.calls,
          pageErrors: errors,
          scope:
            "Controlled HTTP model tests actual routing/tools/receipts, not model review quality; focused test is not full upstream suite."
        },
        null,
        2
      )
    )
  } catch (error) {
    runFailure = error
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
          checks,
          runs,
          requests: model.requests,
          errors,
          workspace,
          isolated
        },
        null,
        2
      )
    )
  } finally {
    clearTimeout(watchdog)
    try {
      await app?.close()
    } catch (error) {
      cleanupFailures.push(error)
    } finally {
      try {
        await model.close()
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
  }
  if (cleanupFailures.length) {
    throw new AggregateError(
      [...(runFailure === undefined ? [] : [runFailure]), ...cleanupFailures],
      "AUTOBIZ_E2E_CLEANUP_FAILED"
    )
  }
  if (runFailure !== undefined) throw runFailure
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
