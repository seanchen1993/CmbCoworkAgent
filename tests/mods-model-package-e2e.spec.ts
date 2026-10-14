/** Extra model boundaries only; the independent public 12-stage journey stays unchanged. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { ElectronApplication, Locator, Page } from "playwright"
import type { RoutingTrace } from "../src/main/agent/trace/types"
import type { ClawView } from "../src/shared/mods/claw"
import type { FlowRun, FlowStep, SavedFlow } from "../src/shared/mods/flows/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "./support/mods-e2e-failures"
import {
  MODS_UI_STARTER_PACKAGES,
  modsUiFileHash,
  selectModsUiRelease
} from "./support/mods-ui-release-pins"

interface ProviderMessage {
  role: string
  content: unknown
}
interface ProviderBody {
  model: string
  messages: ProviderMessage[]
  stream?: boolean
  tools?: Array<{ function?: { name?: string } }>
}
interface ProviderRequest {
  stage: string
  kind: "classifier" | "root" | "flow-agent"
  marker: string
  model: string
  body: ProviderBody
  answer: string
}
interface TraceDetail {
  traceId: string
  outcome: string
  nodes?: Array<{
    type: string
    parentId: string | null
    metadata?: { routingTrace?: RoutingTrace }
  }>
}

const root = resolve(__dirname, "..")
const requestedRelease = process.env.CMB_MODS_UI_RELEASE ?? "new158"
assert(
  requestedRelease === "new158" || requestedRelease === "new159",
  "The additional model suite only validates fixed new158/new159 releases"
)
const release = selectModsUiRelease(root, requestedRelease)
const artifacts = resolve(
  root,
  process.env.CMB_MODS_MODEL_E2E_ARTIFACTS ??
    `output/mods-v2-validation/stage42-model-package-${Date.now()}-${randomUUID()}`
)
assert(relative(resolve(root, "output/mods-v2-validation"), artifacts).match(/^[^./\\][^/\\]*$/))
assert(!existsSync(artifacts), "Preserve every earlier package model result; use a fresh leaf")
mkdirSync(artifacts, { recursive: true })
const sourceHashes = [__filename, join(root, "tests/support/mods-ui-release-pins.ts")].map(
  (path) => ({ path, sha256: modsUiFileHash(path) })
)
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const profileName = "主版本模型组合"
const flowName = "两个步骤分别使用 A 和 B"
const threadTitle = "主版本模型与 Mods 启停验收"
const refs = { a: "custom:starter-ui-a", b: "custom:starter-ui-b", c: "custom:starter-ui-c" }
const providerModels = { a: "starter-ui-a", b: "starter-ui-b", c: "qwen-stage42-c" }
const nonce = randomUUID().replace(/-/g, "")
const requests: ProviderRequest[] = []
const providerErrors: string[] = []
const pageErrors: string[] = []
const dialogErrors: string[] = []
const confirmations: Array<{ type: string; message: string }> = []
const checks: string[] = []
const screenshots: string[] = []
const segments: Array<{ name: string; requests: ProviderRequest[] }> = []
const readBack: Record<string, unknown> = {}
const waits: Array<{ label: string; elapsedMs: number; succeeded: boolean }> = []
const stages: Array<{ name: string; elapsedMs: number }> = []
let stage = "bootstrap"
let stageStartedAt = performance.now()
const startedAt = stageStartedAt
let application: ElectronApplication | undefined
let page: Page
let threadId = ""
let completed = false
let watchdogExpired = false

const messageText = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "")
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      assert(length <= 1024 * 1024, "The local provider body must stay bounded")
      chunks.push(bytes)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderBody
    assert(Object.values(providerModels).includes(body.model))
    assert(Array.isArray(body.messages))
    const classifierSystem = body.messages.some(
      (message) =>
        message.role === "system" &&
        messageText(message.content).startsWith(
          "You are a routing classifier for an AI coding agent"
        )
    )
    const classifierHuman = body.messages.some(
      (message) =>
        message.role === "user" &&
        messageText(message.content).startsWith(
          'Classify this request (reply only "premium" or "economy")'
        )
    )
    assert.equal(
      classifierSystem,
      classifierHuman,
      "Both real classifier protocol prefixes are required"
    )
    const users = body.messages.filter((message) => message.role === "user")
    const userText = messageText(users.at(-1)?.content)
    const flowMarker = /\[STAGE42-FLOW-(A|B)\]/.exec(userText)?.[1]
    const kind = classifierSystem ? "classifier" : flowMarker ? "flow-agent" : "root"
    const marker = flowMarker ?? /\[STAGE42-([^\]]+)\]/.exec(userText)?.[1] ?? "UNMARKED"
    assert.notEqual(marker, "UNMARKED", "Every inference must belong to a public send")
    const answer =
      kind === "classifier"
        ? "economy"
        : kind === "flow-agent"
          ? `受控步骤 ${flowMarker} 已返回真实结构化结果`
          : `主版本普通答复[${marker}]`
    requests.push({ stage, kind, marker, model: body.model, body, answer })
    if (kind === "classifier") {
      assert.equal(body.model, providerModels.c)
      assert.notEqual(body.stream, true)
    }
    if (kind === "flow-agent")
      assert(
        body.tools?.some((tool) => tool.function?.name === "structured_output"),
        "Agent must request the real structured_output tool"
      )
    const common = { id: `stage42-model-${requests.length}`, created: 1, model: body.model }
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      const delta =
        kind === "flow-agent"
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `stage42-output-${requests.length}`,
                  type: "function",
                  function: {
                    name: "structured_output",
                    arguments: JSON.stringify({ passed: true, summary: answer })
                  }
                }
              ]
            }
          : { role: "assistant", content: answer }
      response.write(
        `data: ${JSON.stringify({
          ...common,
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta, finish_reason: kind === "flow-agent" ? "tool_calls" : "stop" }
          ]
        })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [], usage })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } else {
      assert.notEqual(
        kind,
        "flow-agent",
        "The native Agent fixture expects actual streaming tool calls"
      )
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }
          ],
          usage
        })
      )
    }
  } catch (error) {
    providerErrors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Stage42 local model protocol failed")
  }
})

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  budget = 30_000
): Promise<T> {
  const began = performance.now()
  let succeeded = false
  try {
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      const value = await read()
      if (accept(value)) {
        succeeded = true
        return value
      }
      await new Promise<void>((done) => setTimeout(done, 100))
    }
    throw Error("Timeout: " + label)
  } finally {
    waits.push({ label, elapsedMs: performance.now() - began, succeeded })
  }
}
async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(artifacts, name) })
  screenshots.push(name)
}
function pass(name: string): void {
  checks.push(name)
  stages.push({ name, elapsedMs: performance.now() - stageStartedAt })
  stageStartedAt = performance.now()
  console.log("PASS " + name)
}
async function view(): Promise<ClawView> {
  return JSON.parse(
    await page.evaluate(async (id) => JSON.stringify(await window.api.mods.clawView(id)), threadId)
  ) as ClawView
}
async function runs(): Promise<FlowRun[]> {
  return JSON.parse(
    await page.evaluate(async (id) => JSON.stringify(await window.api.mods.flowRuns(id)), threadId)
  ) as FlowRun[]
}
async function metadata(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await page.evaluate(
      async (id) => JSON.stringify((await window.api.threads.get(id))?.metadata ?? {}),
      threadId
    )
  ) as Record<string, unknown>
}
async function activity(): Promise<{ jobs: number; runs: number; requests: number }> {
  const jobs = await page.evaluate(async (id) => (await window.api.mods.jobs(id)).length, threadId)
  return { jobs, runs: (await runs()).length, requests: requests.length }
}
async function noExecution(operation: () => Promise<unknown>): Promise<void> {
  const before = await activity()
  await operation()
  assert.deepEqual(await activity(), before, "Configuring a Claw must not execute a task")
}
async function navigate(tab: "mods" | "claw" | "flows"): Promise<Locator> {
  const labels = { mods: "Function Mods", claw: "我的 Claw", flows: "DIY 流程" }
  const target = page.locator(tab === "flows" ? "[data-diy-flows]" : `[data-${tab}-settings]`)
  if (!(await target.isVisible())) {
    const menu = page.locator("nav").filter({
      has: page.getByRole("button", { name: "Function Mods", exact: true })
    })
    if (!(await menu.isVisible()))
      await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await menu.getByRole("button", { name: labels[tab], exact: true }).click()
  }
  await target.waitFor({ state: "visible" })
  return target
}
async function chat(): Promise<void> {
  const back = page.getByRole("button", { name: "回到聊天使用", exact: true })
  const returnApp = page.getByRole("button", { name: "返回应用", exact: true })
  if (await back.isVisible()) await back.click()
  else if (await returnApp.isVisible()) await returnApp.click()
  const settingsNavigation = page.locator("nav").filter({
    has: page.getByRole("button", { name: "Function Mods", exact: true })
  })
  await settingsNavigation.waitFor({ state: "hidden" })
  await returnApp.waitFor({ state: "hidden" })
  for (const selector of ["[data-mods-settings]", "[data-claw-settings]", "[data-diy-flows]"])
    await page.locator(selector).waitFor({ state: "hidden" })
  const composer = page.locator("textarea.composer-textarea")
  await composer.waitFor({ state: "visible" })
  assert(
    await composer.evaluate((input) => !input.closest('[inert], [aria-hidden="true"]')),
    "The visible composer must belong to the active chat, not the shielded settings background"
  )
  const sendMode = page.getByRole("button", { name: "选择发送方式", exact: true })
  if (await sendMode.isVisible()) {
    await sendMode.click()
    await page.getByRole("button", { name: "聊天", exact: true }).click()
  }
}
async function editProfile(): Promise<Locator> {
  const settings = await navigate("claw")
  await settings.getByRole("button", { name: profileName, exact: true }).click()
  assert.equal(
    await settings.getByLabel("Claw 组合名称", { exact: true }).inputValue(),
    profileName
  )
  return settings
}
async function save(apply: boolean): Promise<ClawView> {
  const settings = page.locator("[data-claw-settings]")
  const before = await view()
  await settings.getByRole("button", { name: "保存能力组合", exact: true }).click()
  const saved = await until(
    view,
    (value) => value.revision > before.revision,
    "public combination save"
  )
  assert.deepEqual(saved.active, before.active)
  assert.equal(saved.bindingRevision, before.bindingRevision)
  if (!apply) return saved
  const card = settings.getByRole("button", { name: profileName, exact: true }).locator("..")
  await card.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  const preview = settings.getByRole("region", { name: "应用变化预览", exact: true })
  await preview.getByRole("heading", { name: `核对后应用：${profileName}`, exact: true }).waitFor()
  assert((await preview.innerText()).includes("不会发送任务"))
  await preview.getByRole("button", { name: "确认应用", exact: true }).click()
  const applied = await until(
    view,
    (value) => value.bindingRevision > saved.bindingRevision,
    "public combination confirmation"
  )
  assert.deepEqual(
    applied.active,
    saved.profiles.find((profile) => profile.name === profileName)
  )
  return applied
}
async function remove(): Promise<ClawView> {
  const before = await view()
  const settings = await navigate("claw")
  await settings.getByRole("button", { name: "恢复原配置", exact: true }).click()
  const preview = settings.getByRole("region", { name: "应用变化预览", exact: true })
  await preview.getByRole("heading", { name: "核对后应用：恢复原配置", exact: true }).waitFor()
  await preview.getByRole("button", { name: "确认应用", exact: true }).click()
  const value = await until(
    view,
    (next) => next.active === null && next.bindingRevision > before.bindingRevision,
    "public removal confirmation"
  )
  assert.deepEqual(value.profiles, before.profiles)
  return value
}
async function basePopover(): Promise<Locator> {
  const content = page.locator('[data-slot="popover-content"]')
  if (!(await content.isVisible())) {
    const trigger = page.getByRole("button", { name: "原聊天模型与智能路由", exact: true })
    if (await trigger.isVisible()) await trigger.click()
    else
      await page
        .locator('[data-slot="popover-trigger"]')
        .filter({ hasText: /starter-ui-a|智能路由/ })
        .click()
  }
  await content.waitFor({ state: "visible" })
  return content
}
async function assertManualA(): Promise<void> {
  assert.equal(
    (await metadata()).model,
    refs.a,
    "The persisted original manual model must remain A"
  )
}
async function assertComboB(): Promise<void> {
  await page.getByRole("button", { name: "当前组合模型：starter-ui-b", exact: true }).waitFor()
  await page.getByRole("button", { name: "原聊天模型与智能路由", exact: true }).waitFor()
  assert.equal((await view()).active?.models?.default, refs.b)
}
async function traceFor(marker: string): Promise<TraceDetail> {
  const rows = await until(
    () =>
      page.evaluate(
        async (id) => window.api.optimizer.getTraces({ threadId: id, limit: 30 }),
        threadId
      ),
    (values) =>
      values.some((value) => value.userMessage.includes(marker) && value.outcome === "success"),
    "completed real root trace " + marker,
    45_000
  )
  const row = rows.find(
    (value) => value.userMessage.includes(marker) && value.outcome === "success"
  )!
  const value = JSON.parse(
    await page.evaluate(
      async (id) => JSON.stringify(await window.api.optimizer.getTraceDetail(id)),
      row.traceId
    )
  ) as TraceDetail | null
  assert(value)
  assert.equal(value.outcome, "success")
  return value
}
function routingOf(trace: TraceDetail): RoutingTrace {
  const routing = trace.nodes?.find((node) => node.type === "trace" && node.parentId === null)
    ?.metadata?.routingTrace
  assert(routing, "The production root trace must retain its complete routing funnel")
  return routing
}
async function ordinary(
  label: string,
  expectedModel: string,
  text?: string,
  classifier = false
): Promise<TraceDetail> {
  await chat()
  const before = await activity()
  const marker = `${label}-${nonce}`
  await page
    .locator("textarea.composer-textarea")
    .fill(text ?? `只需回答这一条消息。[STAGE42-${marker}]`)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  const trace = await traceFor(marker)
  await page.getByText(`主版本普通答复[${marker}]`, { exact: true }).waitFor({ timeout: 45_000 })
  await until(
    async () => page.getByRole("button", { name: "停止生成", exact: true }).count(),
    (count) => count === 0,
    "ordinary turn settled " + label,
    45_000
  )
  const segment = requests.slice(before.requests)
  assert.deepEqual(
    segment.map((request) => request.kind),
    classifier ? ["classifier", "root"] : ["root"]
  )
  if (classifier) assert.equal(segment[0].marker, marker)
  assert.equal(segment.at(-1)?.model, expectedModel)
  assert.equal(segment.at(-1)?.marker, marker)
  assert.equal((await activity()).jobs, before.jobs)
  assert.equal((await runs()).length, before.runs)
  const transcript = JSON.parse(
    await page.evaluate(
      async (id) => JSON.stringify(await window.api.threads.getMessagesPage(id, { limit: 50 })),
      threadId
    )
  ) as {
    messages: Array<{ role: string; content: unknown }>
  }
  assert(
    transcript.messages.some(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message.content).includes(`主版本普通答复[${marker}]`)
    )
  )
  await assertManualA()
  segments.push({ name: label, requests: segment })
  readBack[label] = { view: await view(), metadata: await metadata(), trace }
  return trace
}

async function run(failures: unknown[]): Promise<void> {
  const watchdog = setTimeout(() => {
    watchdogExpired = true
    failures.push(Error("Additional model package watchdog expired after 360 seconds"))
    void application?.close().catch((error) => failures.push(error))
  }, 360_000)
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", done)
    })
    const address = server.address()
    assert(address && typeof address === "object")
    application = await launch(60_000)
    readBack.packageIdentity = await release.verifyBoot(application)
    application
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    application
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("dialog", async (dialog) => {
      const message = dialog.message()
      confirmations.push({ type: dialog.type(), message })
      try {
        if (
          dialog.type() === "confirm" &&
          [
            "删除步骤会丢弃它的参数和未完成草稿，是否继续？",
            "更换步骤类型会丢弃当前类型的参数和草稿，是否继续？",
            "当前组件参数有未完成的草稿，切换会丢弃这些草稿，继续吗？"
          ].includes(message)
        )
          await dialog.accept()
        else {
          dialogErrors.push("Unexpected page dialog: " + message)
          await dialog.dismiss()
        }
      } catch (error) {
        dialogErrors.push(String(error))
      }
    })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    await page.addInitScript("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawView))
    // Only model/thread/workspace bootstrap is allowed to mutate through API.
    threadId = await page.evaluate(
      async ({ workspace, url, title }) => {
        for (const id of ["starter-ui-a", "starter-ui-b", "starter-ui-c"])
          await window.api.models.setCustomConfig({
            id,
            name: id,
            baseUrl: url,
            model: id === "starter-ui-c" ? "qwen-stage42-c" : id,
            apiKey: "isolated-stage42-local-provider",
            maxTokens: 32000,
            maxOutputTokens: 4096,
            tier: id === "starter-ui-c" ? "economy" : "premium"
          })
        await window.api.models.setDefault("custom:starter-ui-a")
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1`, title: threadTitle }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threadTitle, { exact: true }).first().click()
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), false)
    assert.equal((await page.evaluate(() => window.api.plugins.list())).length, 0)
    assert.equal((await view()).active, null)
    const mods = await navigate("mods")
    for (const item of MODS_UI_STARTER_PACKAGES) {
      const input = mods.getByLabel("选择插件 ZIP 文件", { exact: true })
      await input.setInputFiles(join(release.starter, item.file))
      await until(
        async () => {
          const values = await page.evaluate(() => window.api.plugins.list())
          const status = mods.getByRole("status", { name: "灵件操作结果", exact: true })
          return {
            installed: values.some((value) => value.name === item.name),
            notice: (await status.isVisible()) ? (await status.innerText()).trim() : "",
            inputEnabled: await input.isEnabled(),
            uploadEnabled: await mods
              .getByRole("button", { name: "上传插件（ZIP）", exact: true })
              .isEnabled()
          }
        },
        (value) =>
          value.installed &&
          value.notice === `已安装 ${item.name}。安装未改变运行开关，请在项目中检查授权状态。` &&
          value.inputEnabled &&
          value.uploadEnabled,
        "public cold upload " + item.name
      )
    }
    const globalSwitch = mods.getByRole("checkbox", {
      name: "允许使用灵件",
      exact: true
    })
    assert.equal(await globalSwitch.isChecked(), false)
    await globalSwitch.click()
    await until(
      async () => ({
        checked: await globalSwitch.isChecked(),
        enabled: await page.evaluate(() => window.api.mods.globalEnabled())
      }),
      (value) => value.checked && value.enabled,
      "application enabled"
    )
    const projectSwitch = mods.getByRole("checkbox", { name: "在此项目使用灵件", exact: true })
    assert.equal(await projectSwitch.isChecked(), false)
    await projectSwitch.click()
    await until(
      async () => ({
        checked: await projectSwitch.isChecked(),
        current: await view()
      }),
      (value) => value.checked && value.current.enabled && value.current.applicable,
      "project enabled"
    )
    for (const item of MODS_UI_STARTER_PACKAGES) {
      const card = mods.locator(`[data-function-mod-id="${item.name}"]`)
      await card.getByText("查看完整能力与版本", { exact: true }).click()
      await card.getByRole("button", { name: "授权以上能力", exact: true }).click()
      await card.getByText("已授权", { exact: true }).waitFor()
      await until(
        () => page.evaluate((id) => window.api.mods.status(id), threadId),
        (value) =>
          value.functionMods?.find((plugin) => plugin.name === item.name)?.state === "ready",
        "public source grant " + item.name
      )
    }
    const settings = await navigate("claw")
    await settings.getByLabel("Claw 组合名称", { exact: true }).fill(profileName)
    for (const item of MODS_UI_STARTER_PACKAGES)
      await settings.getByLabel("选择能力 " + item.name, { exact: true }).check()
    await settings
      .getByLabel("组件范围 component-review-kit", { exact: true })
      .selectOption("selected")
    await settings.getByLabel("选择组件 component-review-kit · 汇报整理", { exact: true }).uncheck()
    await settings.getByLabel("Claw 默认模型", { exact: true }).selectOption(refs.b)
    await noExecution(() => save(true))
    await chat()
    const base = await basePopover()
    await base.getByRole("button", { name: "starter-ui-a 自定义", exact: true }).click()
    await until(metadata, (value) => value.model === refs.a, "public original manual model A")
    assert.equal(await page.evaluate(() => window.api.routing.getMode()), "pinned")
    const initial = await view()
    assert.deepEqual(
      initial.active?.capabilities.map((item) => item.name),
      MODS_UI_STARTER_PACKAGES.map((item) => item.name)
    )
    assert.deepEqual(
      new Set(
        initial.active?.capabilities.find((item) => item.name === "component-review-kit")
          ?.components?.ids
      ),
      new Set(["context", "review"])
    )
    assert.equal(requests.length, 0)
    await shot("00-public-preparation.png")
    readBack.initial = initial

    stage = "13-ordinary-B"
    const codexPath = join(release.packageDirectory, "resources/bin/win32/codex.exe")
    const codexGzipPath = codexPath + ".gz"
    const codexColdBefore = !existsSync(codexPath)
    readBack.codexRecovery = {
      path: codexPath,
      gzipPath: codexGzipPath,
      state: codexColdBefore ? "cold" : "warm",
      coldBefore: codexColdBefore
    }
    await assertComboB()
    await ordinary("ordinary-b", providerModels.b)
    const codexColdAfter = !existsSync(codexPath)
    const codexSha = codexColdAfter ? null : modsUiFileHash(codexPath)
    const codexGzipSha = modsUiFileHash(codexGzipPath)
    readBack.codexRecovery = {
      path: codexPath,
      gzipPath: codexGzipPath,
      state: codexColdBefore ? "cold" : "warm",
      coldBefore: codexColdBefore,
      coldAfter: codexColdAfter,
      recoveredByRealOrdinaryTurn: codexColdBefore && !codexColdAfter,
      sha256: codexSha,
      gzipSha256: codexGzipSha
    }
    if (codexColdBefore) {
      assert.equal(
        codexColdAfter,
        false,
        "The successful real ordinary turn must restore codex.exe"
      )
      assert.equal(codexSha, "7bc8db2eaa02235e4169adeea327760ff2bfacd7b5b1cbe69f6be495b08bb87c")
      assert.equal(codexGzipSha, "6400e2ae28a9bacbd28467062f4c72176c738ad0cde529cd3c3f6c807de3959b")
    }
    await shot("13-ordinary-B.png")
    pass("Ordinary chat really requests B while the original persisted manual model remains A")

    stage = "14-saved-C-not-applied"
    const beforeSave = await view()
    await noExecution(async () => {
      const claw = await editProfile()
      await claw.getByLabel("Claw 默认模型", { exact: true }).selectOption(refs.c)
      const saved = await save(false)
      assert.equal(
        saved.profiles.find((profile) => profile.name === profileName)?.models?.default,
        refs.c
      )
      assert.deepEqual(saved.active, beforeSave.active)
      assert.equal(saved.bindingRevision, beforeSave.bindingRevision)
    })
    await chat()
    await assertComboB()
    await ordinary("saved-c", providerModels.b)
    await shot("14-saved-C-active-B.png")
    pass("Saving template C does not apply it; the frozen active B snapshot still executes")

    for (const [scope, number] of [
      ["project", 15],
      ["application", 16]
    ] as const) {
      stage = `${number}-${scope}-off-on`
      const retained = await view()
      for (const enabled of [false, true]) {
        await noExecution(async () => {
          const panel = await navigate("mods")
          const control = panel.getByRole("checkbox", {
            name: scope === "project" ? "在此项目使用灵件" : "允许使用灵件",
            exact: true
          })
          await until(
            () => control.isEnabled(),
            (ready) => ready,
            `${scope} Mods control hydration`,
            15_000
          )
          assert.equal(await control.isChecked(), !enabled)
          await control.click()
          if (scope === "application")
            await until(
              async () => ({
                checked: await control.isChecked(),
                enabled: await page.evaluate(() => window.api.mods.globalEnabled())
              }),
              (value) => value.checked === enabled && value.enabled === enabled,
              "global Mods toggle"
            )
          await until(
            async () => ({
              checked: await control.isChecked(),
              current: await view()
            }),
            (value) =>
              value.checked === enabled &&
              value.current.enabled === enabled &&
              (!enabled || value.current.applicable),
            `${scope} effective toggle`
          )
        })
        const current = await view()
        assert.deepEqual(current.active, retained.active)
        assert.deepEqual(current.profiles, retained.profiles)
        assert.equal(current.bindingRevision, retained.bindingRevision)
        await chat()
        if (enabled) await assertComboB()
        else {
          assert.equal(await page.getByRole("button", { name: /^当前组合模型：/ }).count(), 0)
          await page.getByRole("button", { name: "starter-ui-a", exact: true }).waitFor()
          assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
        }
        await ordinary(
          `${scope}-${enabled ? "on" : "off"}`,
          enabled ? providerModels.b : providerModels.a
        )
        await shot(`${number}-${scope}-${enabled ? "on" : "off"}.png`)
      }
      pass(`${scope} Mods OFF requests A, ON requests B, with the saved/applied snapshot retained`)
    }

    stage = "17-pinned-remove"
    await noExecution(remove)
    await chat()
    await page.getByRole("button", { name: "starter-ui-a", exact: true }).waitFor()
    await ordinary("pinned-remove", providerModels.a)
    await shot("17-pinned-restored-A.png")
    await noExecution(async () => {
      const claw = await editProfile()
      assert.equal(await claw.getByLabel("Claw 默认模型", { exact: true }).inputValue(), refs.c)
      await claw.getByLabel("Claw 默认模型", { exact: true }).selectOption(refs.b)
      await save(true)
    })
    await chat()
    await assertComboB()
    pass(
      "Removing a pinned combination restores A; B returns only after public save and confirmation"
    )

    stage = "18-auto-candidate-C-root-B"
    await noExecution(async () => {
      const popover = await basePopover()
      const toggle = popover.getByRole("switch", { name: "智能路由", exact: true })
      assert.equal(await toggle.getAttribute("aria-checked"), "false")
      await toggle.click()
      await until(
        () => page.evaluate(() => window.api.routing.getMode()),
        (value) => value === "auto",
        "real auto ON"
      )
      await until(
        () => toggle.getAttribute("aria-checked"),
        (value) => value === "true",
        "visible auto ON"
      )
      await page.keyboard.press("Escape")
    })
    const autoMarker = `auto-b-${nonce}`
    const autoTrace = await ordinary(
      "auto-b",
      providerModels.b,
      `在资源有限而目标相互牵制的情形里，怎样安排先后顺序才能兼顾短期收益和长期风险？请给出决策依据。[STAGE42-${autoMarker}]`,
      true
    )
    const autoRouting = routingOf(autoTrace)
    assert.equal(autoRouting.routingMode, "auto")
    assert.equal(autoRouting.decidedByLayer, "layer3")
    assert.equal(autoRouting.resolvedModelId, refs.c)
    const classifier = autoRouting.layers.find((layer) => layer.layer === "layer3")
    assert(classifier)
    assert.equal(classifier.detail?.classifierModel, providerModels.c)
    assert.equal(classifier.detail?.cacheHit, false)
    assert.notEqual(classifier.detail?.timedOut, true)
    assert.equal(classifier.reason, "llm-classifier→economy")
    assert.equal(classifier.detail?.rawPreview, "economy")
    assert.equal(classifier.detail?.timeoutMs, 1000)
    await assertComboB()
    const routedBase = await basePopover()
    await routedBase.getByText("普通聊天的路由候选：starter-ui-c", { exact: true }).waitFor()
    assert.equal(
      await routedBase.getByRole("switch", { name: "智能路由" }).getAttribute("aria-checked"),
      "true"
    )
    await shot("18-auto-C-candidate-actual-B.png")
    await page.keyboard.press("Escape")
    pass(
      "Real L3 classifies with C while Claw requests B; the route candidate is visibly distinguished"
    )

    stage = "19-auto-remove"
    await noExecution(remove)
    await chat()
    const stillAuto = await basePopover()
    assert.equal(
      await stillAuto.getByRole("switch", { name: "智能路由" }).getAttribute("aria-checked"),
      "true"
    )
    await page.keyboard.press("Escape")
    assert.equal(await page.evaluate(() => window.api.routing.getMode()), "auto")
    const economy = await ordinary(
      "auto-remove",
      providerModels.c,
      `你好。[STAGE42-auto-remove-${nonce}]`
    )
    const economyRouting = routingOf(economy)
    assert.equal(economyRouting.routingMode, "auto")
    assert.equal(economyRouting.decidedByLayer, "layer2")
    assert.equal(economyRouting.resolvedModelId, refs.c)
    assert(!economyRouting.layers.some((layer) => layer.layer === "layer3"))
    await shot("19-auto-removal-keeps-ON.png")
    pass(
      "Removing Claw retains auto ON; the strict economy request really uses C without a classifier"
    )

    stage = "20-fixed-A-B-flow"
    const beforeFlow = await activity()
    let flow: SavedFlow | undefined
    await noExecution(async () => {
      await navigate("flows")
      await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
      const editor = page.getByRole("group", { name: "流程编辑器", exact: true })
      await editor.getByLabel("流程名称", { exact: true }).fill(flowName)
      await editor
        .getByLabel("任务目标", { exact: true })
        .fill("两个受控步骤各自返回结构化结果，不声称项目测试通过")
      assert.equal(await editor.locator("[data-flow-step]").count(), 2)
      await editor
        .locator("[data-flow-step]")
        .nth(1)
        .getByRole("button", { name: "删除步骤", exact: true })
        .click()
      await editor.getByRole("button", { name: "添加步骤", exact: true }).click()
      for (const [index, key] of [
        [0, "a"],
        [1, "b"]
      ] as const) {
        const step = editor.locator("[data-flow-step]").nth(index)
        const expand = step.locator("button[aria-expanded]")
        if ((await expand.getAttribute("aria-expanded")) !== "true") await expand.click()
        assert.equal(await step.getByLabel("步骤类型", { exact: true }).inputValue(), "agent")
        await step.getByLabel("步骤名称", { exact: true }).fill(`步骤 ${key.toUpperCase()}`)
        await step
          .getByLabel("步骤目标", { exact: true })
          .fill(
            `[STAGE42-FLOW-${key.toUpperCase()}] 只返回指定结构化结果，禁止修改项目或声称已经运行项目测试`
          )
        await step.getByLabel("模型选择方式", { exact: true }).selectOption("fixed")
        await step.getByLabel("模型", { exact: true }).selectOption(refs[key])
      }
      await page.getByRole("button", { name: "保存流程", exact: true }).click()
      const values = await until(
        async () =>
          JSON.parse(
            await page.evaluate(
              async (id) => JSON.stringify(await window.api.mods.flowList(id)),
              threadId
            )
          ) as SavedFlow[],
        (rows) => rows.some((row) => row.definition.name === flowName),
        "public two Agent Flow save"
      )
      flow = values.find((row) => row.definition.name === flowName)
      assert(flow && flow.definition.schemaVersion === 2)
      assert.deepEqual(flow.definition.execution, { kind: "host" })
      assert.equal(flow.definition.steps.length, 2)
      for (const [index, ref] of [refs.a, refs.b].entries()) {
        const step: FlowStep = flow.definition.steps[index]
        assert(step.kind === "agent" && step.enabled)
        assert.equal(step.modelId, ref)
        assert.equal(step.modelRole, undefined)
      }
      await shot("20a-two-Agent-editor.png")
      const claw = await editProfile()
      await claw.getByLabel("Claw 默认模型", { exact: true }).selectOption(refs.b)
      await claw
        .getByLabel("Claw 绑定流程", { exact: true })
        .selectOption(`${flow.definition.id}:${flow.revision}`)
      const applied = await save(true)
      assert.deepEqual(applied.active?.flow, flow)
      assert.equal(applied.active?.models?.default, refs.b)
      assert.equal(applied.active?.capabilities.length, 3)
    })
    assert(flow)
    await chat()
    const workbench = page.getByRole("complementary", { name: "Claw 工作台", exact: true })
    if (!(await workbench.isVisible()))
      await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
    await workbench.getByRole("button", { name: "运行", exact: true }).click()
    const applied = await view()
    await workbench
      .getByLabel("对话使用的 DIY 流程", { exact: true })
      .selectOption(`claw:${applied.bindingRevision}`)
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "执行流程", exact: true }).click()
    await page.getByRole("button", { name: "模型按步骤设置", exact: true }).waitFor()
    await page.getByRole("button", { name: "原聊天模型与智能路由", exact: true }).waitFor()
    const goal = `公开界面启动两步不同模型。[STAGE42-FLOW-GOAL-${nonce}]`
    await page.locator("textarea.composer-textarea").fill(goal)
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    const final = await until(
      runs,
      (values) =>
        values.some((value) =>
          ["complete", "failed", "cancelled", "interrupted"].includes(value.status)
        ),
      "real fixed-model Agent Flow",
      90_000
    )
    const result = final.at(-1)
    readBack.fixedAgentFlow = result ?? null
    assert.equal(final.length, beforeFlow.runs + 1)
    assert(result)
    assert.equal(result.status, "complete", JSON.stringify(result))
    assert.equal(result.taskGoal, goal)
    assert.deepEqual(result.flow, applied.active?.flow)
    const flowRequests = requests.slice(beforeFlow.requests)
    assert.deepEqual(
      flowRequests.map((request) => [request.kind, request.marker, request.model]),
      [
        ["flow-agent", "A", providerModels.a],
        ["flow-agent", "B", providerModels.b]
      ]
    )
    assert.equal(result.attempts.length, 3)
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.stepId),
      [...flow.definition.steps.map((step) => step.id), "__final"]
    )
    const executionIds = result.attempts.map((attempt) => attempt.executionId)
    assert(executionIds.every((id) => typeof id === "string" && id.trim().length > 0))
    assert.equal(new Set(executionIds).size, 3)
    for (const [index, ref] of [refs.a, refs.b].entries()) {
      const attempt = result.attempts.find(
        (item) => item.stepId === flow!.definition.steps[index].id
      )
      assert(attempt && attempt.status === "passed" && attempt.invalidated !== true)
      assert.equal(attempt.result?.modelId, ref)
      assert.equal(attempt.result?.passed, true)
      assert.equal(attempt.result?.source, "agent")
      assert.equal(attempt.result?.summary, flowRequests[index].answer)
    }
    const finalAttempt = result.attempts[2]
    assert.equal(finalAttempt.stepId, "__final")
    assert.equal(finalAttempt.status, "passed")
    assert.notEqual(finalAttempt.invalidated, true)
    assert(
      typeof finalAttempt.finishedAt === "number" &&
        Number.isFinite(finalAttempt.finishedAt) &&
        Number.isFinite(finalAttempt.startedAt) &&
        finalAttempt.finishedAt >= finalAttempt.startedAt
    )
    assert(finalAttempt.result)
    assert.equal(finalAttempt.result.passed, true)
    assert.equal(finalAttempt.result.source, "host")
    assert.equal(finalAttempt.result.modelId, undefined)
    assert.equal(finalAttempt.result.check, undefined)
    assert.equal(finalAttempt.result.output, undefined)
    assert.deepEqual(finalAttempt.result.evidenceIds, [])
    assert.equal(finalAttempt.result.summary, "流程已完成；检查结果以各步骤的实际执行记录为准")
    const details = workbench.getByText(`流程任务 · ${flowName} · 查看进度与结果`, { exact: true })
    await details.waitFor()
    if ((await details.locator("..").getAttribute("open")) === null) await details.click()
    const pane = workbench.locator(`[data-flow-run="${result.id}"]`)
    await pane.getByText(flowName + " · 已完成", { exact: true }).waitFor()
    for (const summary of await pane.getByText("查看结果与证据", { exact: true }).all())
      await summary.click()
    for (const request of flowRequests)
      await pane.getByText(request.answer, { exact: true }).waitFor()
    await assertManualA()
    assert.equal(await page.evaluate(() => window.api.routing.getMode()), "auto")
    segments.push({ name: "fixed-agent-flow", requests: flowRequests })
    await shot("20b-fixed-model-flow-complete.png")
    const beforeReloadRequests = requests.length
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threadTitle, { exact: true }).first().click()
    assert.deepEqual(await runs(), final)
    assert.deepEqual(await view(), applied)
    assert.equal(
      requests.length,
      beforeReloadRequests,
      "Refresh must not repeat completed Agent requests"
    )
    await shot("20c-restored-flow-no-replay.png")
    pass(
      "Public fixed A/B Agent steps execute real structured_output and retain evidence without replay"
    )
    assert.equal(checks.length, 8)
    assert.equal(requests.length, 12)
    completed = true
  } catch (error) {
    failures.push(error)
    await attemptModsE2eCleanup(failures, () =>
      page?.screenshot({ path: join(artifacts, "failure.png") })
    )
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "failure.json"),
        JSON.stringify(
          {
            stage,
            error: error instanceof Error ? error.stack : String(error),
            checks,
            pageErrors,
            providerErrors,
            dialogErrors,
            requests
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  } finally {
    clearTimeout(watchdog)
    await attemptModsE2eCleanup(failures, () => application?.close())
    await attemptModsE2eCleanup(failures, async () => {
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
    })
    await attemptModsE2eCleanup(failures, () => {
      release.verify()
      for (const file of sourceHashes) assert.equal(modsUiFileHash(file.path), file.sha256)
    })
    await attemptModsE2eCleanup(failures, () => {
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(providerErrors, [])
      assert.deepEqual(dialogErrors, [])
      if (completed) assert.equal(requests.length, 12)
    })
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "report.json"),
        JSON.stringify(
          {
            passed: completed && failures.length === 0,
            version: release.version,
            release: release.release,
            freezeManifest: { path: release.manifestPath, sha256: release.manifestSha256 },
            sourceHashes,
            packageFiles: release.packageFiles,
            starterPackages: MODS_UI_STARTER_PACKAGES,
            isolated,
            workspace,
            threadId,
            checks,
            screenshots,
            stages,
            waits,
            segments,
            requests,
            readBack,
            pageErrors,
            providerErrors,
            dialogErrors,
            confirmations,
            watchdogExpired,
            totalElapsedMs: performance.now() - startedAt,
            failures: failures.map((error) =>
              error instanceof Error ? error.stack : String(error)
            ),
            mutationBoundary:
              "Models/thread/workspace bootstrap only; all Mods/Claw/Flow/routing/send mutations use public UI",
            fixtures: [
              "cold private profile",
              "offline SSO",
              "local classifier/root/structured-output HTTP provider"
            ],
            notCovered: [
              "customer installation/login",
              "customer model quality",
              "actual project review/tests/repair",
              "full-process restart"
            ],
            independentBaseline:
              "The old157/new158 public 12-stage suite owns its exact three A/B/B requests"
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  }
}
void runModsE2eWithFailures(run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
