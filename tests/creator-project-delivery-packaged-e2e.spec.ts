/** Real ASAR: classic source -> native modularization -> Host draft -> explicit install/export.
 * Loopback decisions and bounded native file selection only; no private state writes or service mocks.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { parseProjectRuntimeManifest } from "../src/shared/project-runtime"
import type { ModWorkspaceStatus } from "../src/shared/mods/types"
import { projectBuiltPreview } from "./support/project-built-preview"
import { createUnifiedHostProject, openUnifiedHostProject } from "./support/project-unified-native-journey"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import {
  creatorDeliveryAddedFiles,
  creatorDeliverySourceFiles,
  creatorProjectDeliveryModel
} from "./support/creator-project-delivery-model"

const root = resolve(__dirname, "..")
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function effectiveSourceAuthorization(status: ModWorkspaceStatus) {
  const functions = (status.functionMods ?? [])
    .map((item) => ({
      pluginId: item.pluginId,
      name: item.name,
      digest: item.digest,
      state: item.state
    }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
  const ready = [
    ...functions
      .filter((item) => item.state === "ready")
      .map((item) => ({ kind: "function", pluginId: item.pluginId, digest: item.digest })),
    ...status.mods
      .filter((item) => item.state === "ready")
      .map((item) => ({ kind: "legacy", pluginId: item.pluginId, digest: item.digest }))
  ].sort((left, right) =>
    `${left.kind}:${left.pluginId}`.localeCompare(`${right.kind}:${right.pluginId}`)
  )
  return { functions, ready }
}
function sourceIdentity() {
  const names = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "-co",
      "--exclude-standard",
      "--",
      "src",
      "resources",
      "examples",
      "scripts",
      "tests",
      "skills",
      "docs/sparks",
      "package.json",
      "package-lock.json",
      ".nvmrc",
      "tsconfig.json",
      "tsconfig.node.json",
      "tsconfig.web.json",
      "electron.vite.config.ts",
      "vitest.config.ts",
      "eslint.config.mjs"
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  )
    .split("\0")
    .filter(Boolean)
  return hash(
    JSON.stringify(
      Object.fromEntries(
        [...new Set(names)]
          .sort()
          .filter((name) => existsSync(join(root, name)) && statSync(join(root, name)).isFile())
          .map((name) => [name, hash(readFileSync(join(root, name)))])
      )
    )
  )
}
const selectedLaunch = projectBuiltPreview(root, process.env.COMPOSITION_E2E_PACKAGED_DIR)
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.execution, selectedLaunch.preview ? "built-output" : "packaged-asar")
assert.match(process.env.CREATOR_E2E_EXPECTED_SHA256 ?? "", /^[a-f0-9]{64}$/)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
assert.match(process.env.CREATOR_E2E_EXPECTED_SOURCE_SHA256 ?? "", /^[a-f0-9]{64}$/)
const sourceSha256 = sourceIdentity()
assert.equal(
  sourceSha256,
  process.env.CREATOR_E2E_EXPECTED_SOURCE_SHA256,
  "Freeze the reviewed source snapshot using the same paths as run-check.cjs"
)
const fixture = projectCompositionEnvironment(root)
const model = creatorProjectDeliveryModel()
const evidence: Record<string, unknown> = {
  execution: selectedLaunch.execution,
  candidate,
  sourceSha256,
  isolated: fixture.isolated,
  modelCapacity: { contextTokens: 64000, outputTokens: 4096, inputBudgetTokens: 58904,
    alignedWith: "tests/mods-creator-business-e2e.spec.ts" },
  limits: [
    "Actual public native tools and approval IPC; deterministic loopback is not external model quality.",
    ...(selectedLaunch.preview ? ["Normal built Electron preview, not an ASAR/package validation."] : []),
    "Native export/directory pickers receive bounded fixture responses; project creation uses the public form.",
    "Doctor/contract/pack success validates this declared technical contract; business stages are not executed or claimed passed.",
    "Source authority is observed through native mods.status effective ready sources, not private stored grant records.",
    "No S6 debugger, rollback, inherited source authorization or automatic plugin update is claimed."
  ]
}
let app: ElectronApplication | undefined,
  page: Page,
  passed = false
const save = () =>
  writeFileSync(
    join(fixture.isolated, "evidence.json"),
    JSON.stringify(
      { ...evidence, passed, requests: model.requests, modelErrors: model.errors },
      null,
      2
    )
  )
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const end = Date.now() + 60000
  do {
    assert.deepEqual(model.errors, [])
    const value = await read()
    if (accept(value)) return value
    await new Promise((done) => setTimeout(done, 100))
  } while (Date.now() < end)
  throw Error(`Original 60s budget expired: ${label}`)
}
async function main() {
  await new Promise<void>((done) => model.server.listen(0, "127.0.0.1", done))
  const address = model.server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 300000)
  try {
    selectedLaunch.assertCurrent()
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    evidence.application = await selectedLaunch.verify(app, fixture.isolated)
    const processHandle = app.process()
    processHandle.stdout?.on("data", (bytes) =>
      appendFileSync(join(fixture.isolated, "main.stdout.log"), bytes)
    )
    processHandle.stderr?.on("data", (bytes) =>
      appendFileSync(join(fixture.isolated, "main.stderr.log"), bytes)
    )
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(30000)
    await page.waitForFunction(() => Boolean(window.api?.mods?.development?.prepareProjectDelivery))
    const rendererErrors: string[] = []
    page.on("pageerror", (error) => rendererErrors.push(String(error)))
    const scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "creator-delivery-loopback",
          name: "隔离交付验收",
          baseUrl: url,
          model: "creator-delivery-loopback",
          apiKey: "local-fixture",
          // Match the existing business Creator fixture's declared model capacity. The r2
          // actual request already needed ~22,693 input tokens before the preview reply;
          // 32k/8192 left only 115 tokens and correctly hit the unchanged native guard.
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:creator-delivery-loopback")
        const thread = await window.api.threads.create({
          title: "Creator native delivery acceptance",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        await window.api.mods.development.setMode({ ...scope, mode: "creator" })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    const zip = new AdmZip()
    for (const file of creatorDeliverySourceFiles) zip.addFile(file.path, Buffer.from(file.text))
    const original = await page.evaluate(
      async (bytes) => {
        const installed = await window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "creator-raw-delivery-source.zip",
          "local"
        )
        if (!installed.success || !installed.pluginId) throw Error(JSON.stringify(installed))
        return (await window.api.plugins.list()).find((item) => item.id === installed.pluginId)!
      },
      [...zip.toBuffer()]
    )
    assert(original)
    model.bindSource(original.id)
    assert(!existsSync(join(original.path, "devclaw.project-runtime.json")))
    assert(!existsSync(join(original.path, "mods/business/manifest.json")))
    assert(!existsSync(join(original.path, "mods/manifest.json")))
    const authorizationBefore = effectiveSourceAuthorization(
      await page.evaluate((id) => window.api.mods.status(id), scope.threadId)
    )
    const status = () =>
      page.evaluate((input) => window.api.mods.development.status(input), {
        threadId: scope.threadId
      })
    await page.reload()
    await page.getByText("Creator native delivery acceptance", { exact: true }).first().click()
    async function send(text: string, finished: string) {
      const panel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
      if (await panel.isVisible())
        await panel.getByRole("button", { name: "Close", exact: true }).click()
      await page.locator("textarea.composer-textarea").fill(text)
      const submit = page.getByRole("button", { name: "发送消息", exact: true })
      await submit.waitFor({ state: "visible", timeout: 60000 })
      // click keeps Playwright's native visible/enabled/actionable checks after the input is filled.
      await submit.click()
      await page.getByText(finished, { exact: true }).waitFor({ timeout: 60000 })
      // An empty composer switches to its voice control. The stop button reflects the real
      // current chat run; native canConfirm below separately requires turn settlement.
      await page
        .getByRole("button", { name: "停止生成", exact: true })
        .waitFor({ state: "hidden", timeout: 60000 })
      assert.deepEqual(model.errors, [])
    }
    await send(
      "DELIVERY_RAW_AUTHOR：检查原插件并提出保留全部原文件的首次模块化申请，等待原生确认。",
      "DELIVERY_RAW_READY_NATIVE_CONFIRMATION_REQUIRED"
    )
    const pending = await until(
      status,
      (value) => value.business?.modularization?.canConfirm === true,
      "settled native modularization confirmation"
    )
    const request = pending.business!.modularization!
    assert.equal(request.phase, "needs-confirmation")
    assert(request.diagnostics.some((value) => value.includes("tests/project-contract.json")))
    assert(!existsSync(join(original.path, "tests/project-contract.json")))
    const approved = await page.evaluate(
      (input) => window.api.mods.development.approveModularization!(input),
      { ...scope, requestId: request.requestId, sourceDigest: request.sourceDigest }
    )
    assert.equal(approved.business?.modularization?.phase, "ready")
    const inspectionId = approved.business!.modularization!.inspectionId!
    assert(inspectionId)
    model.bindInspection(inspectionId)
    await send(
      "DELIVERY_COMPOSE_TRIAL：组合已确认的真实检查来源，准备Host试用请求后停止；不要安装或声称业务执行成功。",
      "DELIVERY_HOST_REQUEST_PREPARED_NOT_EXECUTED"
    )
    const ready = await until(
      status,
      (value) => Boolean(value.projectTrial),
      "real Host draft request"
    )
    const trial = ready.projectTrial!
    assert.equal(trial.origin?.kind, "business-assembly")
    assert.equal(model.results.get("trial")?.trialRoute, "host")
    assert.equal(model.results.get("trial")?.executed, false)
    assert.deepEqual(await page.evaluate(() => window.api.harnessBoard.localProjects.list()), [])
    const name = "creator-independent-delivery",
      version = "2.3.4"
    const checked = await page.evaluate(
      (input) => window.api.mods.development.prepareProjectDelivery!(input),
      { ...scope, requestId: trial.id, digest: trial.digest, name, version }
    )
    const delivery = checked.projectDelivery!
    assert.equal(delivery.phase, "needs-confirmation")
    assert.equal(delivery.canInstall, true)
    assert.equal(delivery.canExport, true)
    assert.equal(delivery.sourceDigest, trial.digest)
    assert.equal(
      (await page.evaluate(() => window.api.plugins.list())).some((item) => item.name === name),
      false
    )
    const confirm = { ...scope, deliveryId: delivery.id, digest: delivery.digest }
    const wrongWorkspace = `${scope.expectedWorkspace}-wrong`
    mkdirSync(wrongWorkspace)
    const crossScope = await page.evaluate(
      async (input) => {
        try {
          await window.api.mods.development.installProjectDelivery!(input)
          return "UNEXPECTED_SUCCESS"
        } catch (error) {
          return String(error)
        }
      },
      { ...confirm, expectedWorkspace: wrongWorkspace }
    )
    assert.match(crossScope, /PROJECT_DELIVERY_REVIEW_REQUIRED|DEVELOPMENT_SCOPE_CHANGED/)
    const installed = await page.evaluate(
      (input) => window.api.mods.development.installProjectDelivery!(input),
      confirm
    )
    assert.equal(installed.projectDelivery?.phase, "installed")
    const plugins = await page.evaluate(() => window.api.plugins.list())
    const output = plugins.find((item) => item.id === installed.projectDelivery!.pluginId)
    assert(output)
    assert.notEqual(output.id, original.id)
    assert.equal(output.name, name)
    assert.equal(output.version, version)
    for (const file of [...creatorDeliverySourceFiles, ...creatorDeliveryAddedFiles]) {
      if (file.path === "plugin.json") continue
      assert.equal(readFileSync(join(output.path, file.path), "utf8"), file.text)
    }
    const outputManifest = JSON.parse(readFileSync(join(output.path, "plugin.json"), "utf8"))
    const outputRuntime = parseProjectRuntimeManifest(
      JSON.parse(readFileSync(join(output.path, "devclaw.project-runtime.json"), "utf8"))
    )
    assert.equal(outputRuntime.mode, "host")
    assert.equal(outputManifest.name, name)
    assert.equal(outputManifest.version, version)
    assert.equal(outputRuntime.plugin.id, name)
    assert.equal(outputRuntime.plugin.version, version)
    const duplicate = await page.evaluate(async (input) => {
      try {
        await window.api.mods.development.installProjectDelivery!(input)
        return "UNEXPECTED_SUCCESS"
      } catch (error) {
        return String(error)
      }
    }, confirm)
    assert.match(
      duplicate,
      /PROJECT_DELIVERY_REVIEW_REQUIRED|PROJECT_DELIVERY_NAME_ALREADY_INSTALLED/
    )
    const installedSnapshot = await import("../src/main/plugins/derivation-source").then((module) =>
      module.snapshotDerivationSource(output.path)
    )
    const exportedPath = join(fixture.isolated, `${name}-${version}.zip`)
    // Test harness supplies native picker decisions only; the production export handler owns checks/packing.
    await app.evaluate(({ dialog }, target) => {
      let calls = 0
      dialog.showSaveDialog = (async (
        _owner: unknown,
        options?: { title?: string; defaultPath?: string }
      ) => {
        if (
          options?.title !== "保存为新的插件 ZIP" ||
          options.defaultPath !== "creator-independent-delivery-2.3.4.zip" ||
          ++calls > 3
        )
          throw Error("UNEXPECTED_NATIVE_DELIVERY_DIALOG")
        return calls === 1
          ? { canceled: true, filePath: undefined }
          : { canceled: false, filePath: target }
      }) as typeof dialog.showSaveDialog
    }, exportedPath)
    const cancelled = await page.evaluate(
      (input) => window.api.mods.development.exportProjectDelivery!(input),
      confirm
    )
    assert.equal(cancelled.projectDelivery?.phase, "installed")
    assert(!existsSync(exportedPath))
    const exported = await page.evaluate(
      (input) => window.api.mods.development.exportProjectDelivery!(input),
      confirm
    )
    assert.equal(exported.projectDelivery?.phase, "exported")
    assert.equal(exported.projectDelivery.output, exportedPath)
    const archiveBytes = readFileSync(exportedPath),
      archive = new AdmZip(archiveBytes)
    for (const file of installedSnapshot.files)
      assert(
        archive.readFile(file.path)?.equals(file.bytes),
        `Export must preserve installed source ${file.path}`
      )
    const existingTarget = await page.evaluate(async (input) => {
      try {
        await window.api.mods.development.exportProjectDelivery!(input)
        return "UNEXPECTED_SUCCESS"
      } catch (error) {
        return String(error)
      }
    }, confirm)
    assert.match(existingTarget, /PROJECT_DELIVERY_EXPORT_TARGET_EXISTS/)
    assert.equal(
      hash(readFileSync(exportedPath)),
      hash(archiveBytes),
      "Existing ZIP must not be overwritten"
    )
    const functionStatus = await page.evaluate((id) => window.api.mods.status(id), scope.threadId)
    const authorizationAfter = effectiveSourceAuthorization(functionStatus)
    assert.deepEqual(
      authorizationAfter,
      authorizationBefore,
      "Classic source delivery must neither add Function sources nor grant any effective executable source authority"
    )
    assert(
      !existsSync(join(output.path, "mods/manifest.json")),
      "Do not invent Function mappings for a classic source"
    )
    for (const file of creatorDeliverySourceFiles)
      assert.equal(readFileSync(join(original.path, file.path), "utf8"), file.text)
    assert(!existsSync(join(original.path, "devclaw.project-runtime.json")))
    assert(!existsSync(join(original.path, "tests/project-contract.json")))
    const startUseInput = {
      threadId: scope.threadId,
      expectedWorkspace: scope.expectedWorkspace,
      pluginId: output.id,
      expected: { name: output.name, version: output.version }
    }
    const startUse = await page.evaluate(
      (input) => window.api.plugins.prepareStartUse(input), startUseInput
    )
    assert.equal(startUse.activationRequired, true, "Creator delivery must require explicit enablement")
    assert.equal(startUse.canOpen, false)
    const enabled = await page.evaluate(
      (input) => window.api.plugins.enableStartUse(input),
      { ...startUseInput, expected: {
        name: output.name, version: output.version, digest: startUse.identity.digest
      } }
    )
    assert.equal(enabled.activationRequired, undefined)
    assert.equal(enabled.canOpen, true)
    assert.equal(enabled.identity.digest, startUse.identity.digest)
    assert.deepEqual(
      effectiveSourceAuthorization(await page.evaluate((id) => window.api.mods.status(id), scope.threadId)),
      authorizationBefore,
      "Explicit catalog enablement must not grant executable source authority"
    )
    evidence.activation = { before: startUse.activationRequired, after: enabled.activationRequired,
      canOpen: enabled.canOpen, identity: enabled.identity }
    const projectWorkspace = join(fixture.isolated, "installed-project-workspace")
    mkdirSync(projectWorkspace)
    const modelRequestsBeforeCreate = model.requests.length
    const created = await createUnifiedHostProject(app, page, {
      name: "Creator installed ordinary project",
      workspace: projectWorkspace,
      installedPluginId: output.id,
      pluginName: output.name,
      version: output.version,
      goal: "Verify ordinary project creation from the installed Host package; do not run a stage."
    })
    assert.deepEqual(created.project.manifest.stages, outputRuntime.stages)
    assert.equal(model.requests.length, modelRequestsBeforeCreate)
    await page.reload()
    await openUnifiedHostProject(page, created.project.name)
    const reopened = await page.evaluate(id => window.api.harnessBoard.localProjects.get(id),
      created.project.projectId)
    assert.deepEqual(reopened, created)
    assert.equal(model.requests.length, modelRequestsBeforeCreate)
    evidence.ordinaryProject = { created, reopened, stagesExecuted: false }
    assert.deepEqual(rendererErrors, [])
    assert.deepEqual(model.errors, [])
    assert.equal(
      sourceIdentity(),
      sourceSha256,
      "The frozen source must remain unchanged throughout acceptance"
    )
    assert.equal(projectCompositionCandidate(root).sha256, candidate.sha256)
    evidence.observations = {
      original: { id: original.id, path: original.path },
      request,
      trial,
      delivery: exported.projectDelivery,
      installed: output,
      crossScope,
      duplicate,
      existingTarget,
      exportSha256: hash(archiveBytes),
      installedFiles: installedSnapshot.files.map((file) => ({
        path: file.path,
        sha256: file.digest
      })),
      authorizationBefore,
      authorizationAfter,
      rendererErrors
    }
    await app.close()
    app = undefined
    assert.equal(processHandle.exitCode, 0)
    assert.equal(processHandle.signalCode, null)
    assert.deepEqual(rendererErrors, [], "Include late renderer failures during shutdown")
    passed = true
  } catch (error) {
    evidence.error = String(error)
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
      const snapshot = await page.locator("body").ariaSnapshot().catch(() => "unavailable")
      writeFileSync(join(fixture.isolated, "failure-ui.txt"), snapshot)
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch(() => {})
    model.server.closeAllConnections()
    await new Promise<void>((done) => model.server.close(() => done()))
    save()
  }
  console.log(`PASS ${selectedLaunch.execution} native Creator project delivery: ${fixture.isolated}`)
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
