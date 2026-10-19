/* Actual native UI/IPC/installer/OS secret store. Controlled loopback model and one-shot lost-receipt fault. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { FunctionUserConfigView } from "../src/shared/mods/v2/user-config-view"
import { BUSINESS_MOD_MANIFEST } from "../src/shared/business-mods"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, ".."),
  candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root),
  title = "Configuration and outcome recovery"
const secret = "isolated-native-secret-must-not-reach-model",
  configName = "configuration-upgrade-fixture"
const nativeName = "configuration-native-id",
  outputName = "reconciled-business-fixture"
let app: ElectronApplication | undefined,
  page: Page | undefined,
  configId = "",
  sourceId = ""
let scope: { threadId: string; expectedWorkspace: string }
const requests: Array<{ tool?: string; action?: unknown }> = [],
  errors: string[] = []
const evidence: Record<string, unknown> = {
  passed: false,
  candidate,
  controlledModel: true,
  stageDebugDeveloped: false
}
const zipBytes = (files: Record<string, unknown>) => {
  const zip = new AdmZip()
  for (const [path, value] of Object.entries(files))
    zip.addFile(path, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)))
  return [...zip.toBuffer()]
}
function configPackage(upgrade: boolean) {
  const text = { type: "string", title: "标签", description: "Ordinary field" }
  const token = { ...text, title: upgrade ? "新令牌" : "旧令牌", sensitive: true }
  return zipBytes({
    "plugin.json": {
      name: configName,
      version: upgrade ? "2.0.0" : "1.0.0",
      mods: "mods/manifest.json"
    },
    "mods/manifest.json": {
      apiVersion: "cmb.mods/v2",
      id: nativeName,
      entry: "register.ts",
      userConfig: upgrade ? { label: text, token } : { oldLabel: text, oldToken: token },
      ...(upgrade
        ? {
            cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" },
            userConfigSchema: {
              version: 1,
              migrations: [
                {
                  fromVersion: 0,
                  toVersion: 1,
                  changes: [
                    { kind: "rename", from: "oldLabel", to: "label" },
                    { kind: "rename", from: "oldToken", to: "token" }
                  ]
                }
              ]
            }
          }
        : {})
    },
    "mods/register.ts": "export function register() {}"
  })
}
function businessSource() {
  const mod = {
    id: "document",
    title: "文档",
    node: {
      id: "document",
      skill: "write-document",
      checkpoints: ["document_in_progress", "document_done"],
      validators: [],
      guards: [],
      artifacts: { inputs: [], outputs: [{ id: "document", path: "DOCUMENT.md", required: true }] }
    },
    skill: { entry: "skills/write-document/SKILL.md", resources: [] },
    resources: [],
    dependencies: { required: [], advisory: [] },
    checks: { validators: [], guards: [] }
  }
  return zipBytes({
    "plugin.json": { name: "recovery-business-source", version: "1.0.0" },
    [BUSINESS_MOD_MANIFEST]: {
      apiVersion: "devclaw.business-mods/v1",
      kind: "catalog",
      kernel: {
        id: "fixture.recovery-kernel",
        version: "1.0.0",
        boardConfigPath: "board_core/board_config.json",
        resources: ["board_core/runtime.py"]
      },
      modules: [mod]
    },
    "board_core/board_config.json": { apiVersion: 1, workflow: { nodes: [mod.node] } },
    "board_core/runtime.py":
      "# Package inspection fixture; no business execution or gate success is claimed.\n",
    "skills/write-document/SKILL.md":
      "---\nname: write-document\ndescription: Write an actual document\n---\nWrite DOCUMENT.md and verify it exists.\n"
  })
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      assert(raw.length < 4_000_000)
    }
    assert(!raw.includes(secret), "A native secret must never enter a model request")
    const body = JSON.parse(raw),
      messages = body.messages as Array<{ role: string; content: unknown }>
    const index = messages.findLastIndex((message) => message.role === "user"),
      prompt = JSON.stringify(messages[index])
    const replies = messages
      .slice(index + 1)
      .filter((row) => row.role === "tool")
      .map((row) => JSON.parse(String(row.content)))
    for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply))
    let tool: string | undefined, args: Record<string, unknown> | undefined
    if (/FOUNDATION_CONFIG_(INITIAL|UPGRADE)/.test(prompt)) {
      tool = "mod_configuration"
      const initial = prompt.includes("FOUNDATION_CONFIG_INITIAL")
      if (!replies.length) args = { action: "inspect", pluginId: configId }
      else if (initial && replies.length === 1)
        args = {
          action: "set",
          pluginId: configId,
          digest: replies[0].result.digest,
          revision: replies[0].result.savedRevision,
          key: "oldLabel",
          value: "retained-label"
        }
      else if (replies.length === (initial ? 2 : 1)) {
        const view = replies.at(-1).result
        args = {
          action: "request_input",
          pluginId: configId,
          digest: view.digest,
          revision: view.savedRevision,
          key: initial ? "oldToken" : "token"
        }
      }
    } else {
      assert(/FOUNDATION_BUSINESS/.test(prompt), prompt)
      tool = "mod_business"
      if (!replies.length) args = { action: "catalog" }
      else if (replies.length === 1) args = { action: "inspect", pluginId: sourceId }
      else if (replies.length === 2)
        args = {
          action: "preview",
          name: outputName,
          version: "1.0.0",
          sources: [{ inspectionId: replies[1].result.id, modIds: ["document"] }]
        }
      else if (replies.length === 3) {
        assert.equal(replies[2].result.valid, true, JSON.stringify(replies[2]))
        args = { action: "request_review", previewId: replies[2].result.previewId }
      } else assert.equal(replies.length, 4)
    }
    if (args)
      assert(
        body.tools.some((value: { function: { name: string } }) => value.function.name === tool),
        JSON.stringify({
          requiredTool: tool,
          actualTools: body.tools.map(
            (value: { function: { name: string } }) => value.function.name
          )
        })
      )
    requests.push({ tool: args ? tool : undefined, action: args?.action ?? "completed" })
    assert(requests.length < 40)
    response.writeHead(200, { "content-type": "text/event-stream" })
    const delta = args
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `foundation-${requests.length}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) }
            }
          ]
        }
      : { role: "assistant", content: "已准备原生表单，请核对后确认。" }
    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: args ? "tool_calls" : "stop" }
    ])
      response.write(
        `data: ${JSON.stringify({
          id: "foundation",
          object: "chat.completion.chunk",
          model: body.model,
          created: 1,
          choices: [{ index: 0, ...choice }]
        })}\n\n`
      )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("fixture rejected")
  }
})
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, label: string) {
  for (let i = 0; i < 240; i++) {
    assert.equal(errors.length, 0, errors.join("\n"))
    const value = await read()
    if (test(value)) return value
    await new Promise((done) => setTimeout(done, 250))
  }
  throw Error(`Timed out: ${label}`)
}
async function launch() {
  app = await createHeadlessProjectCompositionLaunch(root, fixture, {
    unobtrusivePresentation: true
  })()
  app
    .process()
    .stdout?.on("data", (bytes) => appendFileSync(join(fixture.isolated, "main.stdout.log"), bytes))
  app
    .process()
    .stderr?.on("data", (bytes) => appendFileSync(join(fixture.isolated, "main.stderr.log"), bytes))
  page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.api?.mods?.development?.reconcileBusiness))
}
async function install(bytes: number[], name: string) {
  const result = await page!.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "foundation-fixture.zip", "local"),
    bytes
  )
  assert(result.success, result.error)
  const metadata = (await page!.evaluate(() => window.api.plugins.list())).find(
    (plugin) => plugin.name === name
  )
  assert(metadata)
  return metadata
}
const readConfig = () =>
  page!.evaluate(
    ({ scope, id }) => window.api.mods.userConfig(scope.threadId, id, scope.expectedWorkspace),
    { scope, id: configId }
  )
const status = () =>
  page!.evaluate((input) => window.api.mods.development.status(input), { threadId: scope.threadId })
async function chat(text: string) {
  await page!.locator("textarea.composer-textarea").fill(text)
  await page!.getByRole("button", { name: "发送消息", exact: true }).click()
}
async function requestConfig(upgrade: boolean, digest?: string) {
  const previous = (await status()).configuration?.id
  await chat(
    upgrade
      ? "FOUNDATION_CONFIG_UPGRADE 核对新版配置，打开原生迁移表单，不要自行确认。"
      : "FOUNDATION_CONFIG_INITIAL 设置普通标签，再让我在原生表单填写令牌；不要接收令牌值。"
  )
  await until(
    status,
    (value) =>
      value.configuration?.id !== previous &&
      value.configuration?.key === (upgrade ? "token" : "oldToken") &&
      (!digest || value.configuration.digest === digest),
    "fresh native configuration editor"
  )
  await page!.getByRole("button", { name: "发送消息", exact: true }).waitFor({ state: "visible" })
}
async function migrationDialog(response: 0 | 1) {
  await app!.evaluate(({ dialog }, response) => {
    const state = globalThis as typeof globalThis & { __foundationMigrationDialogs?: number }
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string }
      if (options.title !== "确认迁移插件配置") throw Error("Unexpected native dialog")
      state.__foundationMigrationDialogs = (state.__foundationMigrationDialogs ?? 0) + 1
      return { response, checkboxChecked: false }
    }
  }, response)
}
const dialogCount = () =>
  app!.evaluate(
    () =>
      (globalThis as typeof globalThis & { __foundationMigrationDialogs?: number })
        .__foundationMigrationDialogs ?? 0
  )
async function showChat() {
  await page!.getByText(title, { exact: true }).first().click()
  await page!.locator("textarea.composer-textarea").waitFor()
}
async function armLostReceipt(kind: "install" | "export") {
  await app!.evaluate((_electron, kind) => {
    const sqlite = process.getBuiltinModule("node:sqlite"),
      original = sqlite.StatementSync.prototype.run
    const state = { kind, triggered: 0 }
    ;(globalThis as typeof globalThis & { __foundationFault?: typeof state }).__foundationFault =
      state
    sqlite.StatementSync.prototype.run = function (...args: unknown[]) {
      if (
        !state.triggered &&
        typeof args[1] === "string" &&
        args[1].startsWith("mods-creator-business-review-v1:") &&
        typeof args[0] === "string"
      ) {
        const value = JSON.parse(args[0])
        if (
          value.review?.phase === "installed" &&
          value.review.pluginId &&
          (kind === "install" ? !value.review.output : Boolean(value.review.output))
        ) {
          // The original installer/ZIP writer already returned. Refuse only its subsequent acknowledgement.
          state.triggered++
          throw Error("TEST_LOST_CREATOR_ACK_AFTER_ORIGINAL_EFFECT")
        }
      }
      return Reflect.apply(original, this, args)
    }
  }, kind)
}
const faultCount = () =>
  app!.evaluate(
    () =>
      (globalThis as typeof globalThis & { __foundationFault?: { triggered: number } })
        .__foundationFault?.triggered ?? 0
  )
async function restart() {
  await app!.close()
  app = undefined
  await launch()
  await showChat()
}
async function enterCreatorForNewRequest() {
  // Restart restores durable observations, never the previous creator-mode admission.
  // Only a new explicit native action may enable the next human authoring request.
  const before = await status()
  assert.equal(before.mode, "normal")
  assert.equal(before.enabled, false)
  const after = await page!.evaluate(
    (scope) => window.api.mods.development.setMode({ ...scope, mode: "creator" }),
    scope
  )
  assert.equal(after.mode, "creator")
  assert.equal(after.enabled, true)
  return {
    beforeMode: before.mode,
    beforeEnabled: before.enabled,
    afterMode: after.mode,
    afterEnabled: after.enabled,
    mechanism:
      "Explicit original native creator-mode action for a new human request; not restart recovery"
  }
}
async function openInterruptedBusinessReview() {
  const before = await status()
  assert.equal(before.mode, "normal")
  assert.equal(before.enabled, false)
  assert.equal(before.business?.review?.phase, "unknown")
  assert.equal(before.business?.review?.canConfirm, false)
  assert.equal(before.business?.review?.canReconcile, true)
  const card = page!.getByRole("article", { name: "业务插件组装确认" })
  // Sidebar navigation may dismiss the popover opened by the initial status read.
  // Reopen the original readback entry without restoring creator-mode admission.
  if (!(await card.isVisible()))
    await page!.getByRole("button", { name: "插件结果待核对", exact: true }).click()
  await card.waitFor({ state: "visible" })
  await card.getByRole("button", { name: "核对中断结果", exact: true }).waitFor()
  const after = await status()
  assert.equal(after.mode, "normal")
  assert.equal(after.enabled, false)
  assert.equal(after.business?.review?.planId, before.business?.review?.planId)
  assert.equal(after.business?.review?.canConfirm, false)
  return {
    mode: after.mode,
    enabled: after.enabled,
    planId: after.business?.review?.planId,
    canConfirm: after.business?.review?.canConfirm,
    canReconcile: after.business?.review?.canReconcile,
    mechanism: "Original interrupted-result popover trigger; no creator authorization or replay"
  }
}
async function secretProof(view: FunctionUserConfigView, key: string) {
  return app!.evaluate(
    ({ safeStorage }, { workspace, plugin, key, expected }) => {
      const path = process.getBuiltinModule("node:path"),
        sqlite = process.getBuiltinModule("node:sqlite")
      const db = new sqlite.DatabaseSync(
        path.join(process.env.CMB_COWORK_AGENT_HOME!, "mods-control.sqlite"),
        { readOnly: true }
      )
      try {
        const record = db
          .prepare("SELECT value FROM mods_meta WHERE key=?")
          .get("function-user-config:" + JSON.stringify([workspace, plugin]))
        if (!record || !safeStorage.isEncryptionAvailable())
          throw Error("Actual OS protection unavailable")
        const raw = JSON.parse(String(record.value)),
          sealed = raw.sealed?.[key]
        if (typeof sealed !== "string") throw Error("Missing actual protected value")
        const envelope = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, "base64")))
        const grant = db
          .prepare("SELECT enabled FROM mods_grants WHERE workspace=? AND mod_id=?")
          .get(workspace, "function:" + plugin)
        return {
          secretMatches:
            envelope.value === expected &&
            envelope.key === key &&
            envelope.workspace === workspace &&
            envelope.plugin === plugin,
          noPlaintext: !String(record.value).includes(expected),
          revision: raw.revision,
          schemaVersion: raw.schemaVersion ?? 0,
          codeGrantEnabled: grant?.enabled === 1
        }
      } finally {
        db.close()
      }
    },
    { workspace: view.workspace, plugin: view.plugin, key, expected: secret }
  )
}
async function main() {
  assert.equal(
    candidate.execution,
    "packaged-asar",
    "Use the final unified packaged candidate; no built fallback"
  )
  execFileSync("git", ["init", "-b", "acceptance", fixture.workspace], { windowsHide: true })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 360_000)
  try {
    await launch()
    configId = (await install(configPackage(false), configName)).id
    sourceId = (await install(businessSource(), "recovery-business-source")).id
    scope = await page!.evaluate(
      async ({ workspace, url, title }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "foundation-local",
          name: "本地配置验收",
          baseUrl: url,
          model: "foundation-local",
          apiKey: "fixture",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:foundation-local")
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1`, title }
    )
    await page!.reload()
    await showChat()
    await requestConfig(false)
    const configCard = () => page!.getByRole("article", { name: "插件参数填写请求" })
    await configCard().getByLabel("旧令牌", { exact: true }).fill(secret)
    await configCard().getByRole("button", { name: "保存", exact: true }).click()
    const old = await until(
      readConfig,
      (value) =>
        value.fields.some((field) => field.key === "oldToken" && field.secretState === "saved"),
      "OS protected save"
    )
    assert.equal(old.plugin, nativeName)
    assert.equal(old.fields.find((field) => field.key === "oldLabel")?.value, "retained-label")
    const before = await secretProof(old, "oldToken")
    assert(before.secretMatches && before.noPlaintext)
    assert.equal(before.codeGrantEnabled, false)
    assert.equal((await install(configPackage(true), configName)).id, configId)
    const pending = await readConfig()
    assert(pending.migration?.canApply)
    await requestConfig(true, pending.digest)
    await migrationDialog(0)
    await configCard().getByRole("button", { name: "核对并迁移配置", exact: true }).click()
    await until(dialogCount, (value) => value === 1, "actual native migration cancellation")
    await until(
      readConfig,
      (value) => value.savedRevision === old.savedRevision && Boolean(value.migration),
      "cancelled migration"
    )
    assert.deepEqual(await secretProof(old, "oldToken"), before)
    // Original native ZIP rollback before migration must still expose the unmodified legacy record.
    assert.equal((await install(configPackage(false), configName)).id, configId)
    const rolledBack = await readConfig()
    assert.equal(rolledBack.fields.find((field) => field.key === "oldToken")?.secretState, "saved")
    assert.equal(
      rolledBack.fields.find((field) => field.key === "oldLabel")?.value,
      "retained-label"
    )
    assert.equal((await install(configPackage(true), configName)).id, configId)
    await requestConfig(true, pending.digest)
    await migrationDialog(1)
    await configCard().getByRole("button", { name: "核对并迁移配置", exact: true }).click()
    await until(dialogCount, (value) => value === 2, "actual native migration approval")
    const migrated = await until(
      readConfig,
      (value) => !value.migration && value.savedRevision === old.savedRevision + 1,
      "native-confirmed migration"
    )
    assert.equal(migrated.fields.find((field) => field.key === "label")?.value, "retained-label")
    const proof = await secretProof(migrated, "token")
    assert(proof.secretMatches && proof.noPlaintext && proof.schemaVersion === 1)
    assert.equal(proof.codeGrantEnabled, false)
    await page!.screenshot({ path: join(fixture.isolated, "migration-confirmed.png") })
    await restart()
    assert.deepEqual(await secretProof(await readConfig(), "token"), proof)
    evidence.schemaMigration = {
      nativeId: nativeName,
      UUID: configId,
      cancelledKeepsOld: true,
      actualNativeZipRollbackPreservesOld: true,
      nativeZipUpgradeKeepsId: true,
      nativeConfirmed: true,
      actualOsProtectedSecretPreservedAcrossRestart: true,
      originalRevision: old.savedRevision,
      finalRevision: migrated.savedRevision
    }
    evidence.businessCreationNativeCreatorEntry = await enterCreatorForNewRequest()
    await chat("FOUNDATION_BUSINESS 制作独立的文档业务插件，保留真实来源，只准备原生安装确认。")
    await until(
      status,
      (value) => Boolean(value.business?.review?.canConfirm),
      "business native review"
    )
    await armLostReceipt("install")
    const businessCard = () => page!.getByRole("article", { name: "业务插件组装确认" })
    await businessCard().getByRole("button", { name: "安装独立插件", exact: true }).click()
    const unknownInstall = await until(
      status,
      (value) => value.business?.review?.phase === "unknown",
      "lost install acknowledgement"
    )
    assert.equal(await faultCount(), 1, "The one-shot receipt fault must actually occur")
    const installed = (await page!.evaluate(() => window.api.plugins.list())).filter(
      (plugin) => plugin.name === outputName
    )
    assert.equal(installed.length, 1)
    await restart()
    assert.equal((await status()).business?.review?.phase, "unknown")
    evidence.installReadbackNativeEntry = await openInterruptedBusinessReview()
    await businessCard().getByRole("button", { name: "核对中断结果", exact: true }).click()
    const reconciled = await until(
      status,
      (value) => value.business?.review?.phase === "installed",
      "native install readback"
    )
    assert.equal(reconciled.business!.review!.pluginId, installed[0].id)
    assert.equal(reconciled.business!.review!.canConfirm, false)
    assert.equal(reconciled.business!.review!.reconciliation?.outcome, "installed")
    const afterInstall = (await page!.evaluate(() => window.api.plugins.list())).filter(
      (plugin) => plugin.name === outputName
    )
    assert.deepEqual(afterInstall, installed)
    evidence.installReadback = {
      planId: unknownInstall.business!.review!.planId,
      pluginId: installed[0].id,
      originalEffectActuallyPresent: true,
      restartedBeforeReadback: true,
      originalMetadataUnchanged: true,
      noReapproval: true
    }
    evidence.businessExportNativeCreatorEntry = await enterCreatorForNewRequest()
    await chat("FOUNDATION_BUSINESS 重新核对同一文档插件，准备原生导出确认，不重复安装。")
    await until(
      status,
      (value) => Boolean(value.business?.review?.canConfirm),
      "fresh native export approval"
    )
    const output = join(fixture.isolated, "recovered-plugin.zip")
    await app!.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
    }, output)
    await armLostReceipt("export")
    await businessCard().getByRole("button", { name: "导出插件包…", exact: true }).click()
    await until(
      status,
      (value) => value.business?.review?.phase === "unknown",
      "lost export acknowledgement"
    )
    assert.equal(await faultCount(), 1, "The one-shot receipt fault must actually occur")
    const actualZip = readFileSync(output),
      expectedArchiveSha256 = createHash("sha256").update(actualZip).digest("hex")
    assert.equal(JSON.parse(new AdmZip(actualZip).readAsText("plugin.json")).name, outputName)
    await restart()
    evidence.exportReadbackNativeEntry = await openInterruptedBusinessReview()
    const changed = Buffer.from(actualZip)
    changed[changed.length - 1] ^= 1
    writeFileSync(output, changed)
    await businessCard().getByRole("button", { name: "核对中断结果", exact: true }).click()
    await until(
      status,
      (value) => value.business?.review?.reconciliation?.outcome === "unknown",
      "modified ZIP refusal"
    )
    assert.equal((await status()).business!.review!.phase, "unknown")
    writeFileSync(output, actualZip)
    await businessCard().getByRole("button", { name: "核对中断结果", exact: true }).click()
    const exported = await until(
      status,
      (value) => value.business?.review?.phase === "exported",
      "exact ZIP native readback"
    )
    assert.equal(exported.business!.review!.canConfirm, false)
    assert.equal(exported.business!.review!.reconciliation?.outcome, "exported")
    assert.equal(
      createHash("sha256").update(readFileSync(output)).digest("hex"),
      expectedArchiveSha256
    )
    assert.deepEqual(
      (await page!.evaluate(() => window.api.plugins.list())).filter(
        (plugin) => plugin.name === outputName
      ),
      installed
    )
    evidence.exportReadback = {
      expectedArchiveSha256,
      output,
      modifiedZipRejected: true,
      restoredExactArtifactConfirmed: true,
      restartedBeforeReadback: true,
      originalInstalledMetadataUnchanged: true
    }
    await page!.screenshot({ path: join(fixture.isolated, "native-outcome-reconciled.png") })
    evidence.passed = true
    console.log(`PASS native configuration/recovery: ${fixture.isolated}`)
  } catch (error) {
    evidence.failure = String(error)
    if (page && !page.isClosed()) {
      evidence.failureStatus = await status().catch((failure) => ({ error: String(failure) }))
      evidence.failureDom = (await page.locator("body").innerText()).slice(0, 131_072)
      await page.screenshot({ path: join(fixture.isolated, "failure.png") })
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    writeFileSync(
      join(fixture.isolated, "validation.json"),
      JSON.stringify({ ...evidence, errors, requests }, null, 2)
    )
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
