/* eslint-disable @typescript-eslint/no-explicit-any -- Electron transport instrumentation is test-only. */
/** Actual packaged generation, installation, native closure and original feature form. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { waitForAsyncEvidence } from "./support/async-evidence"
import { enterModsCreatorChat, openModsAdvancedSettings } from "./support/mods-sidebar-navigation"
import {
  derivationContentIdentity,
  snapshotDerivationSource
} from "../src/main/plugins/derivation-source"

const root = resolve(__dirname, "..")
const sourceDirectory = process.env.CMB_CONVERSATIONAL_SOURCE_DIR?.trim()
assert(sourceDirectory, "Set CMB_CONVERSATIONAL_SOURCE_DIR to the reviewed original plugin")
const source = resolve(sourceDirectory)
assert(process.env.CMB_MODS_PACKAGED_DIR, "Explicit reviewed production package required")
const packageDir = resolve(process.env.CMB_MODS_PACKAGED_DIR)
const packageHash = () =>
  createHash("sha256")
    .update(readFileSync(join(packageDir, "resources/app.asar")))
    .digest("hex")
const asarSha256 = packageHash()
assert(process.env.CMB_CONVERSATIONAL_EXPECTED_SHA256, "Root-approved package SHA required")
assert.equal(asarSha256, process.env.CMB_CONVERSATIONAL_EXPECTED_SHA256)
const artifacts = resolve(
  process.env.CMB_CONVERSATIONAL_ARTIFACTS ??
    join(root, "output/conversational-authoring-20261013", `packaged-${randomUUID()}`)
)
assert(!existsSync(artifacts), "Fresh evidence directory required")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const evidence: Record<string, unknown> = {
  asarSha256,
  isolated,
  workspace,
  artifacts,
  limitations: [
    "Deterministic loopback HTTP provider; no external business services",
    "Feature gate transport fixture only; production IPC, model provider, plugin installer and node closure remain real",
    "Business stage execution and approval evidence is recorded by the separate runtime suite"
  ]
}
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined

async function modelFixture() {
  const requests: Array<{ instruction: string; skill: string; tools: number }> = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const chunk of request) raw += chunk.toString()
      const body = JSON.parse(raw)
      const user = body.messages?.find((message: { role: string }) => message.role === "user")
      const content =
        typeof user?.content === "string"
          ? user.content
          : user?.content?.map((item: { text?: string }) => item.text ?? "").join("")
      const prompt = JSON.parse(content)
      const skill =
        prompt.availableSkills.find(
          (file: { path: string }) => file.path === "skills/autobiz/SKILL.md"
        ) ?? prompt.availableSkills[0]
      assert(skill && /SKILL\.md$/.test(skill.path))
      assert.equal(body.tools?.length ?? 0, 0)
      const sql = prompt.instruction.includes("SQL")
      const addition = sql
        ? "业务目标：完成数据开发。输入包括数据口径、源表与目标表。产物包含转换 SQL、空值与重复键检查结果，以及数据质量报告。验收时核对 SQL 与口径一致，并按原流程提供真实检查证据。不得跳过原检查或审批。"
        : "业务目标：完成 CSV 字段映射。输入包括源字段、目标字段和格式要求。产物包括映射表和样例转换报告。验收时核对每个字段的映射结果，并保留原流程检查。"
      requests.push({
        instruction: prompt.instruction,
        skill: skill.path,
        tools: body.tools?.length ?? 0
      })
      const text = JSON.stringify({
        summary: sql ? "增加 SQL 与数据质量报告要求" : "增加 CSV 字段映射要求",
        files: [{ path: skill.path, addition }]
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const id = `conversational-${requests.length}`
      for (const packet of [
        { delta: { role: "assistant", content: text }, finish_reason: null },
        { delta: {}, finish_reason: "stop" }
      ])
        response.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, ...packet }] })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Controlled authoring provider failed")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function chooseDirectory(path: string) {
  await app!.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => {
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: [path] }
    }) as typeof dialog.showOpenDialog
  }, path)
}

async function main() {
  const model = await modelFixture()
  const watchdog = setTimeout(() => {
    errors.push("Packaged product watchdog expired")
    void app?.close()
  }, 300_000)
  try {
    app = await createModsCoreLauncher(root, isolated, env, artifacts)(60000)
    await app.evaluate(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    app
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    app
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    await app.evaluate(async ({ session }) => {
      const http = process.getBuiltinModule("http")
      const https = process.getBuiltinModule("https")
      const { PassThrough } = process.getBuiltinModule("stream")
      const { EventEmitter } = process.getBuiltinModule("events")
      const net = process.getBuiltinModule("net")
      const socketConnect = net.Socket.prototype.connect
      net.Socket.prototype.connect = function (...args: any[]) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0]
        const host =
          typeof options === "object"
            ? (options.host ?? options.hostname)
            : typeof args[1] === "string" && typeof options === "number"
              ? args[1]
              : undefined
        if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
          queueMicrotask(() => this.emit("error", Error("OFFLINE_FIXTURE_EXTERNAL_SOCKET_BLOCKED")))
          return this
        }
        return socketConnect.apply(this, args as any)
      } as typeof socketConnect
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["http://*/*", "https://*/*"] },
        (details, callback) => {
          callback({
            cancel: !["127.0.0.1", "localhost", "::1"].includes(new URL(details.url).hostname)
          })
        }
      )
      const manifest = {
        version: "0.0.0",
        featureGates: {
          projectMode: {
            enabled: true,
            rolloutPercent: 100,
            includeAnonymous: true
          }
        }
      }
      const patch = (module: any) => {
        const original = module.request
        module.request = (url: any, options: any, callback: any) => {
          const target =
            typeof url === "string" || url instanceof URL
              ? new URL(url)
              : new URL(
                  `${url.protocol || "https:"}//${url.hostname || url.host}${url.path || "/"}`
                )
          if (["127.0.0.1", "localhost", "::1"].includes(target.hostname))
            return original(url, options, callback)
          const request: any = new EventEmitter()
          request.write = () => true
          request.setTimeout = () => request
          request.destroy = () => request
          request.end = () =>
            queueMicrotask(() => {
              if (
                target.pathname.endsWith("/download") &&
                target.searchParams.get("file")?.includes("latest")
              ) {
                const response: any = new PassThrough()
                response.statusCode = 200
                ;(typeof options === "function" ? options : callback)?.(response)
                request.emit("response", response)
                response.end(JSON.stringify(manifest))
              } else request.emit("error", Error("OFFLINE_FIXTURE_EXTERNAL_NETWORK_BLOCKED"))
            })
          return request
        }
      }
      patch(http)
      patch(https)
      const fetch = globalThis.fetch
      globalThis.fetch = ((url: any, ...args: any[]) => {
        const target = new URL(typeof url === "string" ? url : (url.url ?? String(url)))
        if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname))
          return Promise.reject(Error("OFFLINE_FIXTURE_EXTERNAL_NETWORK_BLOCKED"))
        return fetch(url, ...args)
      }) as typeof fetch
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() =>
      Boolean(window.api?.pluginDerivation && window.api?.nodeComposition)
    )
    assert(
      (
        await page.evaluate(() =>
          window.api.featureGates.isEnabled("projectMode", { refresh: true })
        )
      ).enabled
    )
    const original = await snapshotDerivationSource(source)
    evidence.source = {
      name: original.name,
      digest: original.digest,
      files: original.files.length
    }
    const archive = new AdmZip()
    for (const file of original.files) archive.addFile(file.path, file.bytes)
    const installation = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "original-autobiz.zip", "local"),
      [...archive.toBuffer()]
    )
    assert(installation.success, installation.error)
    const originalPlugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.name === original.name
    )
    assert(originalPlugin)
    const threadId = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "conversational-fixture",
          name: "隔离业务生成模型",
          baseUrl: url,
          model: "conversational-fixture",
          apiKey: "loopback-fixture-only",
          maxTokens: 64000,
          maxOutputTokens: 12000
        })
        await window.api.models.setDefault("custom:conversational-fixture")
        const thread = await window.api.threads.create({
          title: "描述需求制作与节点组合验收",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { workspace, url: model.url }
    )
    await page.reload()
    await page.getByText("描述需求制作与节点组合验收", { exact: true }).first().click()
    await enterModsCreatorChat(page, threadId, workspace)
    await openModsAdvancedSettings(page, "灵件与使用设置")
    await page
      .getByRole("navigation", { name: "灵件工作区" })
      .getByRole("button", { name: "对话创作", exact: true })
      .click()
    await page.getByRole("button", { name: "高级：手动组装、源码与历史版本", exact: true }).click()
    await page.getByRole("button", { name: "从已有插件创建", exact: true }).click()
    const panel = page.getByRole("region", { name: "从已有插件创建", exact: true })
    await panel.getByLabel("选择原插件").selectOption(originalPlugin.id)
    const name = `AutoBiz-业务生成-${Date.now()}`
    await panel.getByLabel("2. 给新插件起个名字").fill(name)
    await panel.getByRole("button", { name: "创建我的插件", exact: true }).click()
    await panel.getByLabel("告诉我你想怎么改").waitFor()
    const scope = { threadId, expectedWorkspace: workspace }
    const copy = await page.evaluate(
      async ({ scope, name }) =>
        (await window.api.pluginDerivation.list(scope)).find((copy) => copy.name === name),
      { scope, name }
    )
    assert(copy)
    const copyRoot = join(env.CMB_COWORK_AGENT_HOME, "plugin-derivations", copy.copyId, "source")
    const before = await snapshotDerivationSource(copyRoot)
    await panel.getByLabel("告诉我你想怎么改").fill("增加 CSV 字段映射与样例转换报告要求")
    await panel.getByRole("button", { name: "生成修改建议", exact: true }).click()
    await panel.getByLabel("修改建议预览").waitFor()
    assert.equal((await snapshotDerivationSource(copyRoot)).digest, before.digest)
    await panel.getByRole("button", { name: "取消本次建议", exact: true }).click()
    await panel
      .getByLabel("告诉我你想怎么改")
      .fill("增加 SQL 转换、空值和重复键检查、数据质量报告要求，保留原检查和人工确认")
    await panel.getByRole("button", { name: "生成修改建议", exact: true }).click()
    const preview = panel.getByLabel("修改建议预览")
    await preview.waitFor()
    const changedPath = model.requests.at(-1)!.skill
    await preview.getByText(changedPath, { exact: true }).click()
    await preview.getByLabel("本次新增的业务要求").waitFor()
    assert((await preview.getByLabel("本次新增的业务要求").innerText()).includes("转换 SQL"))
    await preview.getByText("查看完整修改前后", { exact: true }).click()
    await preview.getByText("修改前", { exact: true }).waitFor()
    await preview.getByText("修改后", { exact: true }).waitFor()
    assert.equal((await snapshotDerivationSource(copyRoot)).digest, before.digest)
    await page.screenshot({ path: join(artifacts, "a-generated-preview.png"), fullPage: true })
    await panel.getByRole("button", { name: "确认保存修改", exact: true }).click()
    await panel
      .getByText("业务要求已保存到技能文件。接下来检查能否安装。", { exact: true })
      .waitFor()
    const saved = await snapshotDerivationSource(copyRoot)
    for (const file of before.files)
      if (file.path !== changedPath)
        assert.equal(
          saved.files.find((item) => item.path === file.path)?.digest,
          file.digest,
          file.path
        )
    const savedSkill = saved.files.find((file) => file.path === changedPath)!.bytes.toString("utf8")
    assert(
      savedSkill.startsWith(
        before.files.find((file) => file.path === changedPath)!.bytes.toString("utf8")
      )
    )
    assert(savedSkill.includes("转换 SQL"))
    assert(!savedSkill.includes("业务目标：完成 CSV 字段映射"))
    await panel.getByRole("button", { name: "添加自选步骤选项", exact: true }).click()
    const nodeConfigPreview = panel.getByLabel("修改建议预览")
    await nodeConfigPreview.getByText("board_core/board_config.json", { exact: true }).click()
    await nodeConfigPreview.getByLabel("新增节点组合配置").waitFor()
    await nodeConfigPreview.getByText("查看完整修改前后", { exact: true }).click()
    await nodeConfigPreview.getByText("修改前", { exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, "a-node-config-preview.png"), fullPage: true })
    assert.equal((await snapshotDerivationSource(copyRoot)).digest, saved.digest)
    await panel.getByRole("button", { name: "取消本次建议", exact: true }).click()
    assert.equal((await snapshotDerivationSource(copyRoot)).digest, saved.digest)
    await panel.getByRole("button", { name: "添加自选步骤选项", exact: true }).click()
    await panel.getByRole("button", { name: "确认添加自选步骤选项", exact: true }).click()
    await panel.getByText("“自选项目步骤”已保存。接下来检查能否安装。", { exact: true }).waitFor()
    const configured = await snapshotDerivationSource(copyRoot)
    const configPath = "board_core/board_config.json"
    const originalConfig = JSON.parse(
      saved.files.find((file) => file.path === configPath)!.bytes.toString("utf8")
    )
    const composedConfig = JSON.parse(
      configured.files.find((file) => file.path === configPath)!.bytes.toString("utf8")
    )
    assert.equal(composedConfig.workflow.templates["devclaw-composed"].kind, "custom")
    assert.deepEqual(composedConfig.workflow.templates["devclaw-composed"].requiredNodes, [
      "dev.code",
      "ops.archive"
    ])
    delete composedConfig.workflow.templates["devclaw-composed"]
    assert.deepEqual(composedConfig, originalConfig)
    for (const file of saved.files)
      if (file.path !== configPath)
        assert.equal(
          configured.files.find((item) => item.path === file.path)?.digest,
          file.digest,
          file.path
        )
    evidence.nodeConfiguration = {
      onlyAddedTemplate: true,
      otherFilesExact: true,
      canceledWithoutWrite: true
    }
    await panel.getByRole("button", { name: "检查能否安装", exact: true }).click()
    await panel.getByRole("button", { name: "安装新插件", exact: true }).click()
    await panel.getByRole("button", { name: "启用新插件", exact: true }).click()
    await panel.getByRole("button", { name: "新插件已启用", exact: true }).waitFor()
    const installedCopy = await page.evaluate((input) => window.api.pluginDerivation.get(input), {
      ...scope,
      copyId: copy.copyId
    })
    assert(installedCopy.pluginId)
    const installed = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.id === installedCopy.pluginId
    )
    assert(installed?.enabled)
    assert.equal((await snapshotDerivationSource(installed.path)).digest, configured.digest)
    await panel.getByRole("button", { name: "修改这个插件（创建新版本草稿）", exact: true }).click()
    await panel.getByLabel("告诉我你想怎么改").waitFor()
    const revision = await page.evaluate(
      async ({ scope, copyId }) =>
        (await window.api.pluginDerivation.list(scope)).find(
          (item) => item.parentCopyId === copyId
        ),
      { scope, copyId: copy.copyId }
    )
    assert(revision)
    assert.equal(revision.status, "created")
    assert.equal(revision.pluginId, undefined)
    assert.notEqual(revision.copyId, copy.copyId)
    assert.equal(
      await panel.getByRole("button", { name: "从最新来源制作", exact: true }).count(),
      0
    )
    await panel
      .getByText("尚未检查来源更新。点击后读取来源文件，较大插件可能需要稍候。", { exact: true })
      .waitFor()
    await panel.getByRole("button", { name: "检查来源更新", exact: true }).click()
    await panel.getByText("来源内容未变化。", { exact: true }).waitFor()
    const revisionSource = await snapshotDerivationSource(
      join(env.CMB_COWORK_AGENT_HOME, "plugin-derivations", revision.copyId, "source")
    )
    const preservedHooks = configured.files.filter((file) => file.path.startsWith("hooks/"))
    assert(preservedHooks.length > 0, "Fixture must include actual original hooks and checks")
    for (const file of preservedHooks) {
      assert.equal(
        revisionSource.files.find((item) => item.path === file.path)?.digest,
        file.digest,
        file.path
      )
      assert.equal(
        original.files.find((item) => item.path === file.path)?.digest,
        file.digest,
        file.path
      )
    }
    assert.equal((await snapshotDerivationSource(installed.path)).digest, configured.digest)
    await page.screenshot({
      path: join(artifacts, "a-installed-new-version-draft.png"),
      fullPage: true
    })
    evidence.revision = {
      copyId: revision.copyId,
      name: revision.name,
      parentCopyId: copy.copyId,
      sourceCheckedExplicitly: true,
      upstreamUnchanged: true,
      installedVersionUnchanged: true,
      originalHookFilesPreserved: preservedHooks.map((file) => file.path)
    }
    await panel.getByText("继续修改已创建的插件（2）", { exact: true }).click()
    await panel.getByRole("button", { name, exact: true }).click()
    await panel.getByRole("button", { name: "新插件已启用", exact: true }).waitFor()
    await panel.getByRole("button", { name: "新建项目", exact: true }).click()
    await page
      .getByRole("dialog", { name: "项目模式使用引导", exact: true })
      .getByRole("button", { name: "知道了，不再提示", exact: true })
      .click()
    await page
      .getByRole("region", { name: "为新插件创建项目" })
      .getByRole("button", { name: "填写新项目" })
      .click()
    const projectDialog = page.getByRole("dialog", { name: "新建项目", exact: true })
    await projectDialog.getByPlaceholder("输入项目编号搜索", { exact: true }).fill("LOCAL31")
    await projectDialog
      .getByPlaceholder("输入项目名称搜索", { exact: true })
      .fill("业务生成独立项目")
    await projectDialog.getByLabel("系统编号 *", { exact: true }).fill("LOCAL")
    await projectDialog.getByLabel("系统名称 *", { exact: true }).fill("隔离系统")
    const projectWorkspace = join(isolated, "new-project-workspace")
    mkdirSync(projectWorkspace, { recursive: true })
    await chooseDirectory(projectWorkspace)
    await projectDialog.getByLabel("插件工作区根目录", { exact: true }).click()
    await projectDialog.getByLabel("本项目产物文件夹", { exact: true }).fill("independent")
    await projectDialog.getByRole("button", { name: "创建", exact: true }).click()
    await projectDialog.waitFor({ state: "hidden" })
    const project = (await page.evaluate(() => window.api.harnessBoard.listProjects())).find(
      (item) => item.harnessAdapter.id === installedCopy.pluginId
    )
    assert(project)
    await page
      .getByRole("region", { name: "新项目已创建" })
      .getByRole("button", { name: "选择这个项目的步骤", exact: true })
      .click()
    await page.getByRole("dialog", { name: "选择新项目步骤", exact: true }).waitFor()
    await page.getByRole("checkbox").first().waitFor()
    const projectThread = (await page.evaluate(() => window.api.threads.list())).find(
      (item) => item.metadata?.workspacePath === projectWorkspace
    )
    assert(projectThread, "Different project workspace must have its own real conversation")
    const nodeScope = { threadId: projectThread.thread_id, expectedWorkspace: projectWorkspace }
    evidence.projectWorkspace = projectWorkspace
    await page
      .getByRole("dialog", { name: "选择新项目步骤", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click()
    await page
      .getByRole("region", { name: "新项目已创建" })
      .getByRole("button", { name: "选择这个项目的步骤", exact: true })
      .click()
    await page.getByRole("dialog", { name: "选择新项目步骤", exact: true }).waitFor()
    await page.getByRole("checkbox").first().waitFor()
    assert.equal(
      (await page.evaluate(() => window.api.threads.list())).filter(
        (item) => item.metadata?.workspacePath === projectWorkspace
      ).length,
      1,
      "Reopening node selection must reuse its conversation scope"
    )
    const catalog = await page.evaluate((input) => window.api.nodeComposition.catalog(input), {
      ...nodeScope,
      projectId: project.projectId
    })
    const template = catalog.config.templates.find((item) => item.templateType === "custom")!
    assert(template)
    const target =
      catalog.nodes.find((node) => node.id === "dev.review") ??
      catalog.nodes.find((node) => !template.requiredNodes.includes(node.id))!
    assert(target)
    await page
      .getByLabel("项目节点组合")
      .getByRole("checkbox", {
        name: new RegExp(target.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      })
      .check()
    await page.getByRole("button", { name: "检查并预览步骤", exact: true }).click()
    const nodePreview = page.getByLabel("节点组合预览")
    await nodePreview.waitFor()
    const orderedLabels = await nodePreview.locator("ol li").allTextContents()
    const ordered = orderedLabels.map(
      (label) => catalog.nodes.find((node) => label.startsWith(node.label))?.id
    )
    assert(ordered.every(Boolean))
    await page.screenshot({ path: join(artifacts, "b-native-node-preview.png"), fullPage: true })
    await nodePreview.getByRole("button", { name: "在项目里创建需求", exact: true }).click()
    const featureDialog = page
      .getByRole("dialog")
      .filter({ has: page.getByPlaceholder("请输入特性名称") })
    await featureDialog.waitFor()
    assert.equal(
      await featureDialog
        .getByRole("tab", { name: "选择要使用的工作流", exact: true })
        .getAttribute("data-state"),
      "active"
    )
    await featureDialog.getByPlaceholder("请输入特性名称").fill("conversational-native-feature")
    await chooseDirectory(projectWorkspace)
    await featureDialog.getByLabel("会话工作区", { exact: true }).click()
    const directory = await featureDialog.getByLabel("会话工作区", { exact: true }).inputValue()
    await featureDialog
      .getByRole("button", { name: "重新检查节点（保留当前输入）", exact: true })
      .click()
    await featureDialog
      .getByRole("button", { name: "重新检查节点（保留当前输入）", exact: true })
      .waitFor()
    assert.equal(
      await featureDialog.getByPlaceholder("请输入特性名称").inputValue(),
      "conversational-native-feature"
    )
    assert.equal(
      await featureDialog.getByLabel("会话工作区", { exact: true }).inputValue(),
      directory
    )
    await page.screenshot({ path: join(artifacts, "b-original-workflow-form.png"), fullPage: true })
    await featureDialog.getByRole("button", { name: "创建", exact: true }).click()
    await featureDialog.waitFor({ state: "hidden" })
    const detail = await page.evaluate(
      (id) => window.api.harnessBoard.getProjectDetail(id),
      project.projectId
    )
    const feature = detail.runs.find((run) => run.slug === "conversational-native-feature")
    assert(feature, JSON.stringify(detail))
    assert.deepEqual(feature.nodeIds, ordered)
    evidence.feature = feature
    evidence.threadId = threadId
    evidence.projectRoot = join(projectWorkspace, project.projectDir)
    evidence.modelEndpointClosedAfterRun = true
    if (process.env.CMB_CONVERSATIONAL_NATIVE_STAGE) {
      const stage = await import(
        pathToFileURL(resolve(process.env.CMB_CONVERSATIONAL_NATIVE_STAGE)).href
      )
      evidence.nativeChain = await stage.runConversationalNativeChain({
        app,
        page,
        workspace: projectWorkspace,
        artifacts,
        pluginId: installedCopy.pluginId,
        projectId: project.projectId,
        slug: feature.slug
      })
    }
    // This isolated original is enabled only to inspect its project entry; no business run starts.
    const enabledOriginal = await page.evaluate(
      (id) => window.api.plugins.setEnabled(id, true),
      originalPlugin.id
    )
    assert(enabledOriginal.success, enabledOriginal.error)
    const directoryThreadTitle = `原生插件目录包验-${randomUUID()}`
    await page.evaluate(({ id, title }) => window.api.threads.update(id, { title }), {
      id: projectThread.thread_id,
      title: directoryThreadTitle
    })
    await page.reload()
    await page.getByText(directoryThreadTitle, { exact: true }).first().click()
    await openModsAdvancedSettings(page, "搭配管理")
    const nativeDirectory = page.getByRole("region", { name: "已安装的原生插件", exact: true })
    const originalCard = nativeDirectory.getByRole("article", {
      name: originalPlugin.name,
      exact: true
    })
    const derivedCard = nativeDirectory.getByRole("article", { name: installed.name, exact: true })
    await originalCard.waitFor()
    await derivedCard.waitFor()
    await derivedCard.getByRole("button", { name: "查看项目流程", exact: true }).click()
    const projectOptions = nativeDirectory.getByLabel("选择节点所属项目")
    await projectOptions.waitFor()
    await projectOptions
      .locator(`option[value="${project.projectId}"]`)
      .waitFor({ state: "attached" })
    const options = await projectOptions
      .locator("option")
      .evaluateAll((items) =>
        items.map((item) => (item as HTMLOptionElement).value).filter(Boolean)
      )
    assert.deepEqual(options, [project.projectId], "Derived entry must show only its bound project")
    await page.screenshot({
      path: join(artifacts, "c-native-directory-project-binding.png"),
      fullPage: true
    })
    await originalCard.getByRole("button", { name: "查看项目流程", exact: true }).click()
    await nativeDirectory
      .getByText("这个工作区没有绑定此插件版本的可用项目。", { exact: false })
      .waitFor()
    assert.equal(await nativeDirectory.getByLabel("选择节点所属项目").locator("option").count(), 1)
    assert.equal(
      derivationContentIdentity((await snapshotDerivationSource(installed.path)).files),
      derivationContentIdentity(configured.files),
      "Executing native inspectors may add excluded Python caches but cannot modify retained files"
    )
    const originalInstalled = await snapshotDerivationSource(originalPlugin.path)
    for (const file of preservedHooks)
      assert.equal(
        originalInstalled.files.find((item) => item.path === file.path)?.digest,
        file.digest,
        file.path
      )
    await originalCard.getByRole("button", { name: "管理插件", exact: true }).click()
    await page.getByRole("button", { name: "已启用", exact: true }).click()
    const disabledPlugin = await waitForAsyncEvidence(
      () =>
        page!.evaluate(
          async (id) => (await window.api.plugins.list()).find((item) => item.id === id),
          originalPlugin.id
        ),
      (plugin) => plugin?.enabled === false,
      "original plugin disabled after management",
      30_000
    )
    assert.equal(disabledPlugin?.enabled, false)
    await openModsAdvancedSettings(page, "搭配管理")
    await originalCard.getByRole("button", { name: "管理并启用插件", exact: true }).waitFor()
    assert(
      await originalCard.getByRole("button", { name: "查看项目流程", exact: true }).isDisabled()
    )
    await originalCard.getByRole("button", { name: "管理并启用插件", exact: true }).click()
    await page.getByRole("button", { name: "已禁用", exact: true }).click()
    const enabledPlugin = await waitForAsyncEvidence(
      () =>
        page!.evaluate(
          async (id) => (await window.api.plugins.list()).find((item) => item.id === id),
          originalPlugin.id
        ),
      (plugin) => plugin?.enabled === true,
      "original plugin enabled after management",
      30_000
    )
    assert.equal(enabledPlugin?.enabled, true)
    await openModsAdvancedSettings(page, "搭配管理")
    await originalCard.getByRole("button", { name: "管理插件", exact: true }).waitFor()
    assert(
      await originalCard.getByRole("button", { name: "查看项目流程", exact: true }).isEnabled()
    )
    await page.screenshot({
      path: join(artifacts, "d-native-directory-management-return.png"),
      fullPage: true
    })
    evidence.nativeDirectory = {
      originalVisible: true,
      derivedVisible: true,
      derivedProjectIds: options,
      originalHasNoBoundProject: true,
      originalHooksUnchanged: true,
      originalDisabled: disabledPlugin?.enabled === false,
      originalEnabled: enabledPlugin?.enabled === true,
      retainedDirectoryRefreshesAfterManagement: true
    }
    assert.equal((await snapshotDerivationSource(source)).digest, original.digest)
    assert.equal(packageHash(), asarSha256)
    assert.deepEqual(errors, [])
    evidence.result = {
      copy: installedCopy,
      project,
      target: target.id,
      beforeDigest: before.digest,
      savedDigest: saved.digest,
      changedPath
    }
    evidence.passed = true
  } catch (error) {
    evidence.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    if (page) {
      await page
        .screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
        .catch(() => undefined)
      evidence.visibleText = await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable")
    }
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    evidence.modelRequests = model.requests
    evidence.errors = errors
    await app?.close().catch((error) => {
      errors.push(String(error))
      process.exitCode = 1
    })
    await model.close()
    if (errors.length) evidence.passed = false
    writeFileSync(join(artifacts, "report.json"), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ artifacts, passed: evidence.passed ?? false }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
