/* Real Electron IPC, creator tools and installer; deterministic local model, isolated data. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import { portableBusinessModFiles } from "../src/main/plugins/business-mod-portable-source"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const requests: unknown[] = [],
  errors: string[] = []
let app: ElectronApplication | undefined, page: Page | undefined
let baseId = "",
  passed = false
const output = join(fixture.isolated, "creator-business.zip")
const updateOutput = join(fixture.isolated, "creator-business-update.zip")
const extensionId = "custom.review-label"
const extensionPath = `mods/business/${extensionId}/register.ts`
const extensionSource = `export function register(on) {
  on("ui.render", {component:"AbovePrompt"}, async ($,event) => {
    const {Text}=$.ui.resolve(event)
    return Text({children:"自定义业务审阅标识"})
  })
}`
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      assert(raw.length < 4_000_000)
    }
    const body = JSON.parse(raw)
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const last = messages.findLastIndex((message) => message.role === "user")
    const prompt = JSON.stringify(messages[last])
    assert(/CREATE_BUSINESS|PATCH_BUSINESS/.test(prompt), prompt.slice(0, 200))
    const replies = messages
      .slice(last + 1)
      .filter((row) => row.role === "tool")
      .map((row) => JSON.parse(String(row.content)))
    for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply))
    let args: Record<string, unknown> | undefined
    if (prompt.includes("PATCH_BUSINESS")) {
      const pages = replies.filter(
        (reply) =>
          reply.result?.format === "json-pages" ||
          (reply.result?.id === "custom-review-label" &&
            reply.result?.files &&
            reply.result?.catalog)
      )
      const tail = pages.at(-1)?.result
      if (!tail || tail.nextCursor !== undefined)
        args = {
          action: "read",
          id: "custom-review-label",
          ...(tail ? { cursor: tail.nextCursor } : {})
        }
      else if (replies.length === pages.length) args = { action: "inspect", pluginId: baseId }
      else if (replies.length === pages.length + 1) {
        const draft =
          tail.format === "json-pages"
            ? JSON.parse(pages.map((page) => page.result.jsonChunk).join(""))
            : tail
        args = {
          action: "save",
          id: draft.id,
          name: draft.name,
          revision: draft.revision,
          inspectionId: replies.at(-1).result.id,
          modules: draft.catalog.modules,
          extensions: draft.catalog.extensions,
          files: draft.files.map((file: { path: string; text: string }) =>
            file.path === extensionPath
              ? {
                  ...file,
                  text: file.text.replace("自定义业务审阅标识", "自定义业务审阅标识（修订版）")
                }
              : file
          )
        }
      } else if (replies.length === pages.length + 2) {
        const base = replies[pages.length].result,
          draft = replies.at(-1).result
        args = {
          action: "preview",
          name: "creator-business-acceptance",
          version: "1.0.1",
          sources: [
            { inspectionId: base.id, modIds: base.mods.map((mod: { id: string }) => mod.id) }
          ],
          drafts: [
            { id: draft.id, revision: draft.revision, modIds: ["autobiz.knowledge", extensionId] }
          ],
          acceptFixedWorkflow: true
        }
      } else if (replies.length === pages.length + 3) {
        assert.equal(replies.at(-1).result.valid, true)
        args = { action: "request_review", previewId: replies.at(-1).result.previewId }
      } else {
        assert.equal(replies.length, pages.length + 4)
        assert.equal(replies.at(-1).result.review.exportOnly, true)
      }
    } else if (!replies.length) args = { action: "catalog" }
    else if (replies.length === 1) {
      assert(
        replies[0].result.sources.some((source: { pluginId: string }) => source.pluginId === baseId)
      )
      assert(
        replies[0].result.bundledExamples.some(
          (example: { exampleId: string }) => example.exampleId === "autobiz-knowledge"
        )
      )
      args = { action: "inspect", pluginId: baseId }
    } else {
      const pages = replies
        .slice(2)
        .filter(
          (reply) =>
            reply.result?.format === "json-pages" || reply.result?.exampleId === "autobiz-knowledge"
        )
      const tail = pages.at(-1)?.result
      if (!tail || tail.nextCursor !== undefined)
        args = {
          action: "example",
          exampleId: "autobiz-knowledge",
          ...(tail ? { cursor: tail.nextCursor } : {})
        }
      else if (replies.length === pages.length + 2) {
        const example =
          tail.format === "json-pages"
            ? JSON.parse(pages.map((page) => page.result.jsonChunk).join(""))
            : tail
        args = {
          action: "save",
          id: "custom-review-label",
          name: "知识与自定义业务审阅标识",
          revision: 0,
          inspectionId: replies[1].result.id,
          modules: [],
          extensions: [
            ...example.draft.extensions,
            {
              id: extensionId,
              title: "自定义业务审阅标识",
              kind: "function",
              usage: "chat",
              entry: extensionPath,
              resources: [],
              dependencies: { required: [], advisory: [] }
            }
          ],
          files: [...example.draft.files, { path: extensionPath, text: extensionSource }]
        }
      } else if (replies.length === pages.length + 3) {
        const base = replies[1].result,
          draft = replies.at(-1).result
        args = {
          action: "preview",
          name: "creator-business-acceptance",
          version: "1.0.0",
          sources: [
            { inspectionId: base.id, modIds: base.mods.map((mod: { id: string }) => mod.id) }
          ],
          drafts: [
            { id: draft.id, revision: draft.revision, modIds: ["autobiz.knowledge", extensionId] }
          ],
          acceptFixedWorkflow: true
        }
      } else if (replies.length === pages.length + 4) {
        assert.equal(replies.at(-1).result.valid, true, JSON.stringify(replies.at(-1)))
        args = { action: "request_review", previewId: replies.at(-1).result.previewId }
      } else {
        assert.equal(replies.length, pages.length + 5)
        assert.equal(replies.at(-1).result.review.phase, "needs-approval")
      }
    }
    if (args)
      assert(
        body.tools.some(
          (tool: { function: { name: string } }) => tool.function.name === "mod_business"
        )
      )
    requests.push({ action: args?.action ?? "done", replyCount: replies.length })
    assert(requests.length <= 28)
    assert(body.stream)
    response.writeHead(200, { "content-type": "text/event-stream" })
    const delta = args
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `business-${requests.length}`,
              type: "function",
              function: { name: "mod_business", arguments: JSON.stringify(args) }
            }
          ]
        }
      : { role: "assistant", content: "业务插件已准备，请在原生确认卡核对并安装或导出。" }
    for (const value of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: args ? "tool_calls" : "stop" }
    ])
      response.write(
        `data: ${JSON.stringify({
          id: "business",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, ...value }]
        })}\n\n`
      )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("fixture rejected")
  }
})
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, label: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    assert.equal(errors.length, 0, errors.join("\n"))
    const value = await read()
    if (test(value)) return value
    await new Promise((done) => setTimeout(done, 250))
  }
  throw Error(`Timed out: ${label}`)
}
async function installSource(directory: string) {
  const source = await snapshotDerivationSource(directory)
  const zip = new AdmZip()
  for (const file of portableBusinessModFiles(source)) zip.addFile(file.path, file.bytes)
  const result = await page!.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "source.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(result.success, result.error)
  const metadata = JSON.parse(
    source.files.find((file) => file.path === "plugin.json")!.bytes.toString()
  )
  const installed = (await page!.evaluate(() => window.api.plugins.list())).find(
    (plugin) => plugin.name === metadata.name
  )!
  assert(installed)
  return { id: installed.id, digest: source.digest }
}
async function main() {
  const original = process.env.AUTOBIZ_CONTEXT_TEST_SOURCE ?? "C:/ai/autobiz_kanban"
  const originalDigest = (await snapshotDerivationSource(original)).digest
  execFileSync("git", ["init", "-b", "acceptance", fixture.workspace], { windowsHide: true })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 240_000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stdout?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "main.stdout.log"), bytes)
      )
    app
      .process()
      .stderr?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "main.stderr.log"), bytes)
      )
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    baseId = (await installSource(original)).id
    const scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "business-loopback",
          name: "隔离业务模型",
          baseUrl: url,
          model: "business-loopback",
          apiKey: "local-fixture",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:business-loopback")
        const thread = await window.api.threads.create({
          title: "Business creator acceptance",
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
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.getByText("Business creator acceptance", { exact: true }).first().click()
    const status = () =>
      page!.evaluate((input) => window.api.mods.development.status(input), {
        threadId: scope.threadId
      })
    const started = Date.now()
    await page
      .locator("textarea.composer-textarea")
      .fill(
        "CREATE_BUSINESS 使用已安装AutoBiz和知识Mod制作业务插件，增加自定义审阅标识，保留Hooks和知识规则；本隔离样本允许固定步骤。先核对来源，然后准备安装和导出确认。"
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    const ready = await until(
      status,
      (value) => Boolean(value.business?.review?.canConfirm),
      "native business review"
    )
    assert.equal(ready.business!.review!.phase, "needs-approval")
    assert(
      !(await page.evaluate(() => window.api.plugins.list())).some(
        (plugin) => plugin.name === "creator-business-acceptance"
      ),
      "Model must not install"
    )
    const card = page.getByRole("article", { name: "业务插件组装确认" })
    await card.getByRole("button", { name: "保存为新插件并安装", exact: true }).click()
    const installed = await until(
      status,
      (value) => value.business?.review?.phase === "installed",
      "native installer"
    )
    const installedPlugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.id === installed.business!.review!.pluginId
    )!
    assert(installedPlugin)
    assert(
      readFileSync(join(installedPlugin.path, extensionPath), "utf8").includes("自定义业务审阅标识")
    )
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, fixture.workspace)
    const configured = await page.evaluate(
      async ({ scope, pluginId }) => {
        const view = await window.api.mods.userConfig(
          scope.threadId,
          pluginId,
          scope.expectedWorkspace
        )
        if (!view.fields.some((field) => field.key === "knowledgeRoot"))
          throw Error("Missing knowledge binding")
        const selected = await window.api.mods.pickUserConfigPath(
          scope.threadId,
          view,
          "knowledgeRoot"
        )
        if (!selected) throw Error("Native directory selection cancelled")
        await window.api.mods.saveUserConfig(scope.threadId, view, "knowledgeRoot", selected)
        const saved = await window.api.mods.userConfig(
          scope.threadId,
          pluginId,
          scope.expectedWorkspace
        )
        return saved.fields.find((field) => field.key === "knowledgeRoot")?.value
      },
      { scope, pluginId: installedPlugin.id }
    )
    assert.equal(configured, fixture.workspace, "Use the original external configuration store")
    // Simulate only the OS file chooser response; the actual button/IPC/export service stay unchanged.
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, output)
    await card.getByRole("button", { name: "导出插件包…", exact: true }).click()
    await until(
      status,
      (value) =>
        value.business?.review?.phase === "installed" && value.business.review.output === output,
      "native ZIP export"
    )
    const exported = new AdmZip(output)
    const manifest = JSON.parse(exported.readAsText("mods/business/manifest.json"))
    assert(!exported.readAsText("plugin.json").includes(fixture.workspace))
    assert(manifest.extensions.some((extension: { id: string }) => extension.id === extensionId))
    assert(
      manifest.extensions.some((extension: { id: string }) => extension.id === "autobiz.knowledge")
    )
    assert.equal(JSON.parse(exported.readAsText("board_core/board_config.json")).apiVersion, 2)
    const contract = JSON.parse(exported.readAsText("devclaw.project-runtime.json"))
    assert.equal(contract.apiVersion, "devclaw.project-runtime/v2")
    assert.equal(contract.extensionContract.context.configuration, "host-resolved")
    assert.equal((await snapshotDerivationSource(original)).digest, originalDigest)
    await page.getByRole("button", { name: "返回原聊天继续创作", exact: true }).click()
    await page
      .locator("textarea.composer-textarea")
      .fill(
        "PATCH_BUSINESS 将自定义业务审阅标识改为修订版，保留知识与业务规则，生成同名1.0.1更新包；不开始业务任务。"
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until(
      status,
      (value) =>
        Boolean(
          value.business?.review?.canConfirm &&
          value.business.review.exportOnly &&
          value.business.review.version === "1.0.1"
        ),
      "same-name update review"
    )
    assert.equal(await card.getByRole("button", { name: "保存为新插件并安装", exact: true }).count(), 0)
    assert(
      !readFileSync(join(installedPlugin.path, extensionPath), "utf8").includes("修订版"),
      "Dialogue authoring must not overwrite the installed version"
    )
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, updateOutput)
    await card.getByRole("button", { name: "导出更新包…", exact: true }).click()
    await until(
      status,
      (value) => value.business?.review?.output === updateOutput,
      "native update export"
    )
    const updated = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "creator-business-update.zip",
          "local"
        ),
      [...readFileSync(updateOutput)]
    )
    assert(updated.success, updated.error)
    const updatedPlugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.name === "creator-business-acceptance"
    )!
    assert.equal(updatedPlugin.id, installedPlugin.id)
    assert.equal(updatedPlugin.version, "1.0.1")
    assert(readFileSync(join(updatedPlugin.path, extensionPath), "utf8").includes("修订版"))
    const preservedConfig = await page.evaluate(
      ({ scope, pluginId }) =>
        window.api.mods.userConfig(scope.threadId, pluginId, scope.expectedWorkspace),
      { scope, pluginId: updatedPlugin.id }
    )
    assert.equal(
      preservedConfig.fields.find((field) => field.key === "knowledgeRoot")?.value,
      fixture.workspace
    )
    await page.screenshot({ path: join(fixture.isolated, "business-installed-exported.png") })
    await app.close()
    app = undefined
    const fresh = projectCompositionEnvironment(root)
    execFileSync("git", ["init", "-b", "acceptance", fresh.workspace], { windowsHide: true })
    app = await createHeadlessProjectCompositionLaunch(root, fresh, {
      unobtrusivePresentation: true
    })()
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const reinstalled = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "creator-business.zip", "local"),
      [...readFileSync(output)]
    )
    assert(reinstalled.success, reinstalled.error)
    const freshPlugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.name === "creator-business-acceptance"
    )!
    assert(freshPlugin)
    assert.notEqual(
      freshPlugin.id,
      installedPlugin.id,
      "Installation identity must be environment-local"
    )
    assert.equal(
      (await page.evaluate(() => window.api.plugins.list())).length,
      1,
      "Portable output must not require the original source installation"
    )
    const freshConfiguration = await page.evaluate(
      async ({ workspace, pluginId }) => {
        const thread = await window.api.threads.create({
          title: "Fresh configuration",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        return window.api.mods.userConfig(thread.thread_id, pluginId, current.workspace)
      },
      { workspace: fresh.workspace, pluginId: freshPlugin.id }
    )
    assert(
      !freshConfiguration.fields.find((field) => field.key === "knowledgeRoot")?.value,
      "Machine bindings must be supplied again in the new environment"
    )
    writeFileSync(
      join(fixture.isolated, "validation.json"),
      JSON.stringify(
        {
          passed: true,
          candidate,
          controlledModel: true,
          modelRequests: requests,
          nativeInstallConfirmations: 1,
          nativeExportConfirmations: 1,
          elapsedMs: Date.now() - started,
          installedId: installedPlugin.id,
          dialogueRevision: "1.0.1",
          nativeZipUpdatePreservedIdAndConfiguration: true,
          updatePackage: updateOutput,
          package: output,
          digest: ready.business!.review!.digest,
          originalSourceUnchanged: true,
          freshEnvironment: fresh.isolated,
          freshInstallId: freshPlugin.id,
          stageDebugDeveloped: false
        },
        null,
        2
      )
    )
    passed = true
    console.log(`PASS business creator real Electron: ${fixture.isolated}`)
  } finally {
    clearTimeout(watchdog)
    writeFileSync(
      join(fixture.isolated, "requests.json"),
      JSON.stringify({ passed, requests, errors }, null, 2)
    )
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
