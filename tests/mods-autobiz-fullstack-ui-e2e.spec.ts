/** Exact Autobiz branch: public DIY UI, real guests/tools and a bounded native-dialog contract. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import AdmZip from "adm-zip"
import type { MessageBoxOptions } from "electron"
import type { ElectronApplication, Locator, Page } from "playwright"
import type { ClawView } from "../src/shared/mods/claw"
import type { FlowRun, FlowStep, SavedFlow } from "../src/shared/mods/flows/types"
import type { ModCommandJob } from "../src/shared/mods/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "./support/mods-e2e-failures"
import { modsUiFileHash as hashFile, selectModsUiRelease } from "./support/mods-ui-release-pins"

const root = resolve(__dirname, "..")
const commit = "504e327d2f9a4d9e30e9f541c4432accf8000ad5"
const branch = "dev_autobiz_fullstack_0920"
const pluginName = "AutobizDevOps_Plugin_Kanban_Fullstack0920_Mods"
const modelNames = { a: "fullstack-ui-a", b: "fullstack-ui-b" } as const
const refs = { a: "custom:fullstack-ui-a", b: "custom:fullstack-ui-b" } as const
const profileName = "Autobiz 全栈 DIY Claw"
const crossFlowName = "Autobiz 真实文件跨插件检视"
const agentFlowName = "Autobiz A 与 B 只读分工"
const threadTitle = "Autobiz fullstack 0920 真实源码体验"
const taskGoal = "读取 mods-demo 的真实文件，独立检视并汇报，等待我的确认"
const exportRoot = resolve(
  root,
  process.env.CMB_AUTOBIZ_FULLSTACK_EXPORT ?? "output/autobiz-fullstack-0920-20261009"
)
const artifactParent = resolve(root, "output/mods-v2-validation")
const artifacts = resolve(
  root,
  process.env.CMB_AUTOBIZ_FULLSTACK_E2E_ARTIFACTS ??
    `output/mods-v2-validation/stage44-autobiz-fullstack-ui-${Date.now()}`
)
assert(/^[^./\\][^/\\]*$/.test(relative(artifactParent, artifacts)))
assert(!existsSync(artifacts), "Preserve prior reports; select a fresh artifact directory")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)

interface FilePin {
  path: string
  sha256: string
}
interface ExportReceipt {
  schemaVersion: 1
  source: { repository: string; branch: string; commit: string; upstreamVersion: string }
  packages: Array<{ name: string; file: string; sha256: string }>
  originalFiles: FilePin[]
  workspace: {
    path: string
    feature: string
    checkpoint: string
    sourceFile: string
    record: Record<string, unknown>
  }
}
interface NativeApproval {
  request: Record<string, unknown> | null
  approved: boolean
  reason: string
}
interface ProviderMessage {
  role: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments?: string } }>
}
interface ProviderBody {
  model: string
  stream?: boolean
  messages: ProviderMessage[]
  tools?: Array<{ function: { name: string } }>
}
interface ProviderRequest {
  stage: string
  kind: "single-review" | "cross-review" | "report" | "agent-read" | "agent-result"
  model: string
  messages: ProviderMessage[]
  answer?: string
  tool?: { id: string; name: string; arguments: Record<string, unknown> }
}

const checks: string[] = []
const screenshots: string[] = []
const pageErrors: string[] = []
const providerErrors: string[] = []
const dialogErrors: string[] = []
const confirmations: Array<{ type: string; message: string }> = []
const requests: ProviderRequest[] = []
const stages: Array<{ name: string; elapsedMs: number }> = []
const waits: Array<{ label: string; elapsedMs: number; reads: number; succeeded: boolean }> = []
const readBack: Record<string, unknown> = {}
const inputPins: FilePin[] = []
const copiedPins: FilePin[] = []
const components = new Map<string, string>()
let release: ReturnType<typeof selectModsUiRelease> | undefined
let exported: ExportReceipt
let sourceText = ""
let page: Page
let application: ElectronApplication | undefined
let threadId = ""
let stage = "bootstrap"
let stageStartedAt = performance.now()
const startedAt = stageStartedAt
let completed = false
let watchdogExpired = false
let applicationClosed = false
let serverClosed = false
let nativeApprovalInstalled = false

const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex")
const text = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "")
const identity = (path: string): string => {
  const actual = realpathSync(path)
  return process.platform === "win32" ? actual.toLowerCase() : actual
}
function inside(parent: string, path: string): boolean {
  const child = relative(parent, path)
  return (
    !!child &&
    !isAbsolute(child) &&
    child !== ".." &&
    !child.startsWith("../") &&
    !child.startsWith("..\\")
  )
}
function pinsForDirectory(directory: string): FilePin[] {
  const pins: FilePin[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      assert(!lstatSync(path).isSymbolicLink(), "Fixture input must not contain a link")
      if (entry.isDirectory()) visit(path)
      else {
        assert(entry.isFile(), "Fixture input must contain only regular files")
        pins.push({ path, sha256: hashFile(path) })
        assert(pins.length <= 4096)
      }
    }
  }
  visit(directory)
  return pins.sort((a, b) => a.path.localeCompare(b.path))
}
function verifyPins(pins: FilePin[]): void {
  for (const pin of pins) {
    assert(lstatSync(pin.path).isFile() && !lstatSync(pin.path).isSymbolicLink())
    assert.equal(hashFile(pin.path), pin.sha256, pin.path)
  }
}
function verifyInputs(): void {
  release?.verify()
  verifyPins(inputPins)
  verifyPins(copiedPins)
}
function prepareInputs(): void {
  release = selectModsUiRelease(root, "new159")
  const receiptPath = join(exportRoot, "SOURCE.json")
  assert(lstatSync(receiptPath).isFile() && !lstatSync(receiptPath).isSymbolicLink())
  exported = JSON.parse(readFileSync(receiptPath, "utf8")) as ExportReceipt
  assert.equal(exported.schemaVersion, 1)
  assert.equal(exported.source.branch, branch)
  assert.equal(exported.source.commit, commit)
  assert.equal(exported.source.upstreamVersion, "1.0.87")
  assert.equal(exported.source.repository, "https://github.com/seikou00/autobiz_kanban.git")
  assert.equal(exported.workspace.feature, "mods-demo")
  assert.equal(exported.workspace.sourceFile, "tests/test_project_status_invalid_checkpoint.py")
  assert.equal(exported.workspace.record.checkpoint, exported.workspace.checkpoint)
  assert(
    !["code_in_progress", "requirements_eval_in_progress"].includes(exported.workspace.checkpoint)
  )
  assert(exported.workspace.checkpoint && typeof exported.workspace.checkpoint === "string")
  if (exported.workspace.record.workflowNodes !== undefined) {
    assert(Array.isArray(exported.workspace.record.workflowNodes))
    assert(exported.workspace.record.workflowNodes.every((node) => typeof node === "string"))
  }
  assert.equal(exported.workspace.record.workflowTemplate, "lean")
  assert.deepEqual(
    exported.packages.map((item) => item.name),
    [pluginName, "review-agent", "component-review-kit"]
  )
  inputPins.push(
    { path: __filename, sha256: hashFile(__filename) },
    { path: receiptPath, sha256: hashFile(receiptPath) }
  )
  for (const support of [
    "mods-core-packaged-launch.ts",
    "mods-ui-release-pins.ts",
    "mods-composition-fixtures.ts",
    "mods-e2e-failures.ts"
  ])
    inputPins.push({
      path: join(root, "tests/support", support),
      sha256: hashFile(join(root, "tests/support", support))
    })
  for (const item of exported.packages) {
    assert.equal(item.file, item.name + ".zip")
    assert(/^[0-9a-f]{64}$/.test(item.sha256))
    const path = join(exportRoot, item.file)
    assert.equal(hashFile(path), item.sha256)
    inputPins.push({ path, sha256: item.sha256 })
  }
  assert.equal(
    exported.packages[2].sha256,
    "5b4966131122a65bd3edc0a76cccf36e1a1bba932931b48cdffdf6a0f2099f1f"
  )
  const zip = new AdmZip(join(exportRoot, exported.packages[0].file))
  const manifest = JSON.parse(zip.readAsText("plugin.json")) as {
    name: string
    version: string
    mods: string
    hooks: string
  }
  assert.equal(manifest.name, pluginName)
  assert.equal(manifest.version, "1.0.87-mods.1")
  assert.equal(manifest.mods, "mods/manifest.json")
  assert.equal(manifest.hooks, "hooks/hooks.json")
  const native = JSON.parse(zip.readAsText(manifest.mods)) as {
    claw: { components: Array<{ id: string; name: string; dependsOn?: string[] }> }
  }
  assert.deepEqual(
    native.claw.components.map((item) => item.id),
    ["status", "board", "review", "review-input"]
  )
  assert.deepEqual(native.claw.components.find((item) => item.id === "board")?.dependsOn, [
    "status"
  ])
  for (const item of native.claw.components) {
    assert(item.name && !components.has(item.id))
    components.set(item.id, item.name)
  }
  const sourceWorkspace = resolve(exportRoot, exported.workspace.path)
  assert(inside(identity(exportRoot), identity(sourceWorkspace)))
  assert(
    !existsSync(join(sourceWorkspace, ".git")),
    "The experience must use an archive, not a live checkout"
  )
  assert(Array.isArray(exported.originalFiles) && exported.originalFiles.length > 100)
  for (const original of exported.originalFiles) {
    assert(!isAbsolute(original.path) && !original.path.includes("\\"))
    assert(original.path.split("/").every((part) => part && part !== "." && part !== ".."))
    const sourcePath = resolve(sourceWorkspace, original.path)
    assert(inside(sourceWorkspace, sourcePath))
    assert.equal(hashFile(sourcePath), original.sha256)
    if (original.path !== "plugin.json") {
      const entry = zip.getEntry(original.path)
      assert(entry && !entry.isDirectory, original.path)
      assert.equal(
        digest(entry.getData()),
        original.sha256,
        "Changed upstream asset: " + original.path
      )
    }
  }
  const state = JSON.parse(
    readFileSync(join(sourceWorkspace, ".autobizdevops/state.json"), "utf8")
  ) as {
    features: Record<string, { checkpoint: string }>
  }
  assert.equal(state.features[exported.workspace.feature].checkpoint, exported.workspace.checkpoint)
  inputPins.push(...pinsForDirectory(sourceWorkspace))
  cpSync(sourceWorkspace, workspace, { recursive: true, force: false, errorOnExist: true })
  copiedPins.push(...pinsForDirectory(workspace))
  for (const pin of copiedPins) {
    const sourcePath = join(sourceWorkspace, relative(workspace, pin.path))
    assert.equal(hashFile(sourcePath), pin.sha256)
  }
  sourceText = readFileSync(join(workspace, exported.workspace.sourceFile), "utf8")
  assert(sourceText.trim() && sourceText.length <= 4000)
  readBack.export = {
    source: exported.source,
    packages: exported.packages,
    workspace: exported.workspace
  }
  readBack.originalAssetCount = exported.originalFiles.length
  readBack.sourceFileSha256 = digest(sourceText)
  verifyInputs()
}

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  budget = 30_000
): Promise<T> {
  const began = performance.now()
  const deadline = Date.now() + budget
  let reads = 0
  let succeeded = false
  try {
    while (Date.now() < deadline) {
      const value = await read()
      reads++
      if (accept(value)) {
        succeeded = true
        return value
      }
      await new Promise<void>((done) => setTimeout(done, 150))
    }
    throw Error("Timeout: " + label)
  } finally {
    waits.push({ label, elapsedMs: performance.now() - began, reads, succeeded })
  }
}
function pass(label: string): void {
  checks.push(label)
  stages.push({ name: label, elapsedMs: performance.now() - stageStartedAt })
  stageStartedAt = performance.now()
  console.log("PASS " + label)
}
async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(artifacts, name) })
  screenshots.push(name)
}
async function view(): Promise<ClawView> {
  return JSON.parse(
    await page.evaluate(async (id) => JSON.stringify(await window.api.mods.clawView(id)), threadId)
  ) as ClawView
}
async function jobs(): Promise<ModCommandJob[]> {
  return JSON.parse(
    await page.evaluate(async (id) => JSON.stringify(await window.api.mods.jobs(id)), threadId)
  ) as ModCommandJob[]
}
async function runs(): Promise<FlowRun[]> {
  return JSON.parse(
    await page.evaluate(async (id) => JSON.stringify(await window.api.mods.flowRuns(id)), threadId)
  ) as FlowRun[]
}
async function savedFlows(): Promise<SavedFlow[]> {
  return JSON.parse(
    await page.evaluate(async (id) => JSON.stringify(await window.api.mods.flowList(id)), threadId)
  ) as SavedFlow[]
}
async function commands(): Promise<string[]> {
  return page.evaluate(
    async (id) => (await window.api.mods.commands(id)).map((item) => item.command).sort(),
    threadId
  )
}
async function activity(): Promise<{ requests: number; jobs: number; runs: number }> {
  return { requests: requests.length, jobs: (await jobs()).length, runs: (await runs()).length }
}
async function navigate(tab: "mods" | "claw" | "flows"): Promise<Locator> {
  const names = { mods: "Function Mods", claw: "我的 Claw", flows: "DIY 流程" }
  const target = page.locator(tab === "flows" ? "[data-diy-flows]" : `[data-${tab}-settings]`)
  if (!(await target.isVisible())) {
    const navigation = page
      .locator("nav")
      .filter({ has: page.getByRole("button", { name: "Function Mods", exact: true }) })
    if (!(await navigation.isVisible()))
      await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await navigation.getByRole("button", { name: names[tab], exact: true }).click()
  }
  await target.waitFor({ state: "visible" })
  return target
}
async function chat(): Promise<void> {
  const back = page.getByRole("button", { name: "回到聊天使用", exact: true })
  const returnApp = page.getByRole("button", { name: "返回应用", exact: true })
  if (await back.isVisible()) await back.click()
  else if (await returnApp.isVisible()) await returnApp.click()
  await page
    .locator("nav")
    .filter({ has: page.getByRole("button", { name: "Function Mods", exact: true }) })
    .waitFor({ state: "hidden" })
  for (const selector of ["[data-mods-settings]", "[data-claw-settings]", "[data-diy-flows]"])
    await page.locator(selector).waitFor({ state: "hidden" })
  await returnApp.waitFor({ state: "hidden" })
  const composer = page.locator("textarea.composer-textarea")
  await composer.waitFor({ state: "visible" })
  assert(await composer.evaluate((node) => !node.closest('[inert], [aria-hidden="true"]')))
  const sendMode = page.getByRole("button", { name: "选择发送方式", exact: true })
  if (await sendMode.isVisible()) {
    await sendMode.click()
    await page.getByRole("button", { name: "聊天", exact: true }).click()
  }
}
async function sidebar(tab: "运行" | "插件与结果"): Promise<Locator> {
  const panel = page.getByRole("complementary", { name: "Claw 工作台", exact: true })
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
  await panel.getByRole("button", { name: tab, exact: true }).click()
  return panel
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
async function saveAndApply(): Promise<ClawView> {
  const beforeActivity = await activity()
  const before = await view()
  const settings = page.locator("[data-claw-settings]")
  await settings.getByRole("button", { name: "保存能力组合", exact: true }).click()
  const saved = await until(view, (value) => value.revision > before.revision, "public Claw save")
  assert.deepEqual(saved.active, before.active)
  assert.equal(saved.bindingRevision, before.bindingRevision)
  const card = settings.getByRole("button", { name: profileName, exact: true }).locator("..")
  await card.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  const preview = settings.getByRole("region", { name: "应用变化预览", exact: true })
  await preview.getByRole("heading", { name: `核对后应用：${profileName}`, exact: true }).waitFor()
  assert((await preview.innerText()).includes("不会发送任务"))
  await preview.getByRole("button", { name: "确认应用", exact: true }).click()
  const applied = await until(
    view,
    (value) => value.bindingRevision > saved.bindingRevision,
    "public Claw confirmation"
  )
  assert.deepEqual(
    applied.active,
    saved.profiles.find((item) => item.name === profileName)
  )
  assert.deepEqual(await activity(), beforeActivity, "Save and apply cannot dispatch work")
  return applied
}
function componentControl(settings: Locator, id: string): Locator {
  const name = components.get(id)
  assert(name, id)
  return settings.getByLabel(`选择组件 ${pluginName} · ${name}`, { exact: true })
}
async function command(name: string, argument = ""): Promise<ModCommandJob> {
  await chat()
  const previous = new Set((await jobs()).map((item) => item.id))
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("/" + name)
  const option = page
    .getByRole("listbox")
    .getByRole("option")
    .filter({ has: page.getByText(name, { exact: true }) })
  await option.waitFor({ state: "visible" })
  assert.equal(await option.count(), 1)
  await option.click()
  if (argument) await composer.fill("/" + name + " " + argument)
  const send = page.getByRole("button", { name: /^(发送消息|执行灵件操作)$/ })
  assert.equal(await send.count(), 1)
  await send.click()
  const rows = await until(
    jobs,
    (values) =>
      values.some(
        (item) =>
          item.command === name &&
          !previous.has(item.id) &&
          !["queued", "running"].includes(item.state)
      ),
    "public slash " + name,
    60_000
  )
  const job = rows.find((item) => item.command === name && !previous.has(item.id))!
  assert.equal(job.state, "succeeded", JSON.stringify(job))
  await sidebar("插件与结果")
  return job
}
async function expandStep(step: Locator): Promise<void> {
  const toggle = step.locator("button[aria-expanded]")
  assert.equal(await toggle.count(), 1)
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
}
async function addPluginStep(editor: Locator, label: string, name: string): Promise<Locator> {
  await editor.getByRole("button", { name: "添加插件动作", exact: true }).click()
  const appended = editor.locator("[data-flow-step]").last()
  const id = await appended.getAttribute("data-flow-step")
  assert(id)
  await appended.getByRole("button", { name: "上移步骤", exact: true }).click()
  const step = editor.locator(`[data-flow-step="${id}"]`)
  await expandStep(step)
  await step.getByLabel("动作提供者", { exact: true }).selectOption({ label })
  await step.getByLabel("步骤名称", { exact: true }).fill(name)
  return step
}
async function saveFlow(editor: Locator, name: string): Promise<SavedFlow> {
  const before = await activity()
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  const rows = await until(
    savedFlows,
    (values) => values.some((item) => item.definition.name === name),
    "public saved Flow " + name
  )
  const flow = rows.find((item) => item.definition.name === name)!
  assert.equal(flow.definition.schemaVersion, 2)
  assert.equal(flow.revision, 1)
  assert.deepEqual(await activity(), before)
  assert(await editor.isVisible())
  return flow
}
async function bindFlow(flow: SavedFlow): Promise<ClawView> {
  const settings = await editProfile()
  await settings
    .getByLabel("Claw 绑定流程", { exact: true })
    .selectOption(`${flow.definition.id}:${flow.revision}`)
  const active = await saveAndApply()
  assert.deepEqual(active.active?.flow, flow)
  return active
}
async function startFlow(active: ClawView, goal: string): Promise<Locator> {
  await chat()
  const panel = await sidebar("运行")
  const select = panel.getByLabel("对话使用的 DIY 流程", { exact: true })
  await select.selectOption(`claw:${active.bindingRevision}`)
  assert.equal(await select.inputValue(), `claw:${active.bindingRevision}`)
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "执行流程", exact: true }).click()
  await page.locator("textarea.composer-textarea").fill(goal)
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  return panel
}
async function details(panel: Locator, run: FlowRun): Promise<Locator> {
  const summary = panel.getByText(`流程任务 · ${run.flow.definition.name} · 查看进度与结果`, {
    exact: true
  })
  await summary.waitFor({ state: "visible" })
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click()
  const pane = panel.locator(`[data-flow-run="${run.id}"]`)
  await pane.waitFor({ state: "visible" })
  for (const disclosure of await pane.getByText("查看结果与证据", { exact: true }).all())
    if ((await disclosure.locator("..").getAttribute("open")) === null) await disclosure.click()
  return pane
}
function assertNoNativeTests(run: FlowRun): void {
  assert(
    !run.attempts.some(
      (item) => item.result?.source === "native-check" || item.result?.check !== undefined
    )
  )
}

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      assert(length <= 2 * 1024 * 1024)
      chunks.push(bytes)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderBody
    assert(
      Object.values(modelNames).includes(body.model as typeof modelNames.a | typeof modelNames.b)
    )
    assert(Array.isArray(body.messages))
    const users = body.messages.filter((item) => item.role === "user")
    const userText = text(users.at(-1)?.content)
    let kind: ProviderRequest["kind"]
    let answer: string | undefined
    let tool: ProviderRequest["tool"]
    if (Array.isArray(body.tools)) {
      assert.equal(stage, "agents")
      const key = body.model === modelNames.a ? "A" : "B"
      assert(
        userText.includes(`[FULLSTACK-AGENT-${key}]`),
        "The fixed Agent model must match its public goal"
      )
      assert(body.tools.some((item) => item.function.name === "structured_output"))
      const readId = `fullstack-read-${key}`
      const prior = body.messages.find(
        (item) => item.role === "tool" && item.tool_call_id === readId
      )
      if (!prior) {
        assert(
          !body.messages.some((item) => item.tool_calls?.some((call) => call.id === readId)),
          "A pending read must not be answered before its real tool result"
        )
        assert(body.tools.some((item) => item.function.name === "read_file"))
        kind = "agent-read"
        tool = {
          id: readId,
          name: "read_file",
          arguments: { file_path: join(workspace, exported.workspace.sourceFile) }
        }
      } else {
        assert(text(prior.content).includes("test_keeps_invalid_checkpoint_as_unknown"))
        assert(text(prior.content).includes("ProjectStatusInvalidCheckpointTest"))
        kind = "agent-result"
        answer = `模型 ${key} 已通过真实 read_file 读取分支测试源码；只读检视，未修改或运行项目测试。`
        tool = {
          id: `fullstack-output-${key}`,
          name: "structured_output",
          arguments: { passed: true, summary: answer }
        }
      }
    } else {
      assert.equal(body.model, modelNames.b)
      if (stage === "single-review") {
        assert(userText.includes(sourceText.trim()))
        kind = "single-review"
        answer =
          "AUTOBIZ_SINGLE_REVIEW：已收到真实分支文件，检查未知 checkpoint 的状态展示。仅本文件意见，未执行项目测试。"
      } else {
        assert.equal(stage, "cross-flow")
        const systemText = body.messages
          .filter((item) => item.role === "system")
          .map((item) => text(item.content))
          .join("\n")
        if (systemText.includes("你是独立代码检视者")) {
          assert(userText.includes(sourceText.trim()))
          assert(userText.includes(exported.workspace.feature))
          assert(userText.includes(exported.workspace.checkpoint))
          kind = "cross-review"
          answer =
            "AUTOBIZ_CROSS_REVIEW：已收到 mods-demo 的真实源码及规范化状态；未知 checkpoint 按 unknown 显示。检视范围仅此文件，未运行测试或推进阶段。"
        } else {
          assert(systemText.includes("将给定内容整理为简短中文汇报"))
          const evidence = JSON.parse(userText) as {
            version: number
            nativeProjectTests: string
            results: Array<{ source: string; summary: string; stepId: string }>
          }
          assert.equal(evidence.version, 1)
          assert.equal(evidence.nativeProjectTests, "not-run")
          assert.equal(evidence.results.length, 2)
          assert(evidence.results.every((item) => item.source === "plugin-action"))
          assert(evidence.results.some((item) => item.summary.includes("AUTOBIZ_CROSS_REVIEW")))
          kind = "report"
          answer =
            "AUTOBIZ_EVIDENCE_REPORT：真实文件准备及独立检视已完成；没有原生项目测试回执，未推进阶段，等待人工确认。"
        }
      }
    }
    requests.push({ stage, kind, model: body.model, messages: body.messages, answer, tool })
    const common = { id: `fullstack-ui-${requests.length}`, created: 1, model: body.model }
    const usage = { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 }
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: tool.id,
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) }
            }
          ]
        }
      : { role: "assistant", content: answer }
    const finish = tool ? "tool_calls" : "stop"
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message: delta, finish_reason: finish }],
          usage
        })
      )
    }
  } catch (error) {
    providerErrors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Autobiz fullstack bounded protocol fixture failed")
  }
})

async function installNativeApprovalContract(pluginRoot: string): Promise<void> {
  assert(application)
  assert(
    inside(identity(isolated), identity(pluginRoot)),
    "Installed plugin must stay in the private profile"
  )
  const sourceZip = new AdmZip(join(exportRoot, exported.packages[0].file))
  const metadataSha256 = digest(sourceZip.readFile("MODS_SOURCE.json")!)
  const scriptSha256 = digest(sourceZip.readFile("read_state_json.py")!)
  const contract = {
    modId: "function:" + pluginName,
    pluginRoot: realpathSync(pluginRoot),
    workspace: realpathSync(workspace),
    commit,
    metadataSha256,
    scriptSha256
  }
  await application.evaluate("globalThis.__name = value => value")
  await application.evaluate(({ dialog }, expected) => {
    /* eslint-disable @typescript-eslint/no-require-imports -- This callback runs in Electron main and cannot capture the test's imports. */
    const assert: typeof import("node:assert/strict") = require("node:assert/strict")
    const fs = require("node:fs") as typeof import("node:fs")
    const path = require("node:path") as typeof import("node:path")
    const crypto = require("node:crypto") as typeof import("node:crypto")
    /* eslint-enable @typescript-eslint/no-require-imports */
    const state = globalThis as typeof globalThis & { __autobizNativeApprovals?: NativeApproval[] }
    state.__autobizNativeApprovals = []
    const normalize = (value: string): string => {
      const actual = fs.realpathSync(value)
      return process.platform === "win32" ? actual.toLowerCase() : actual
    }
    const sha = (value: string): string =>
      crypto.createHash("sha256").update(fs.readFileSync(value)).digest("hex")
    const evaluate = (
      options: MessageBoxOptions
    ): { approved: boolean; reason: string; request: Record<string, unknown> | null } => {
      let request: Record<string, unknown> | null = null
      try {
        assert.equal(options.title, "批准插件运行本机命令")
        assert.equal(options.type, "question")
        assert.equal(options.message, `插件 ${expected.modId} 请求运行 python`)
        assert.deepEqual(options.buttons, ["拒绝", "允许本次命令"])
        assert.equal(options.defaultId, 0)
        assert.equal(options.cancelId, 0)
        const separator = options.detail?.indexOf("\n\n") ?? -1
        assert(separator >= 0)
        request = JSON.parse(options.detail!.slice(separator + 2)) as Record<string, unknown>
        assert(
          Object.keys(request).every((key) => ["argv", "cwd", "env", "timeoutMs"].includes(key))
        )
        assert(Array.isArray(request.argv) && request.argv.length === 5)
        assert.deepEqual(request.argv.slice(0, 4), ["python", "-B", "-X", "utf8"])
        assert.equal(typeof request.argv[4], "string")
        assert.equal(
          normalize(request.argv[4]),
          normalize(path.join(expected.pluginRoot, "read_state_json.py"))
        )
        assert.equal(typeof request.cwd, "string")
        assert.equal(normalize(request.cwd as string), normalize(expected.workspace))
        assert(request.env && typeof request.env === "object" && !Array.isArray(request.env))
        const environment = request.env as Record<string, unknown>
        assert.deepEqual(
          Object.keys(environment).sort(),
          ["PLUGIN_WORKSPACE", "PROJECT_DIR", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING"].sort()
        )
        assert.equal(typeof environment.PLUGIN_WORKSPACE, "string")
        assert.equal(
          normalize(environment.PLUGIN_WORKSPACE as string),
          normalize(path.dirname(expected.workspace))
        )
        assert.equal(environment.PROJECT_DIR, path.basename(expected.workspace))
        assert.equal(environment.PYTHONIOENCODING, "utf-8")
        assert.equal(environment.PYTHONDONTWRITEBYTECODE, "1")
        assert(
          typeof request.timeoutMs === "number" &&
            request.timeoutMs > 0 &&
            request.timeoutMs <= 30_000
        )
        const metadataPath = path.join(expected.pluginRoot, "MODS_SOURCE.json")
        assert(!fs.lstatSync(metadataPath).isSymbolicLink())
        assert.equal(sha(metadataPath), expected.metadataSha256)
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
          source: { commit: string }
        }
        assert.equal(metadata.source.commit, expected.commit)
        const scriptPath = path.join(expected.pluginRoot, "read_state_json.py")
        assert(!fs.lstatSync(scriptPath).isSymbolicLink())
        assert.equal(sha(scriptPath), expected.scriptSha256)
        return {
          approved: true,
          reason: "Exact installed branch read-only state reader for this private workspace",
          request
        }
      } catch (error) {
        return {
          approved: false,
          reason: error instanceof Error ? error.message : String(error),
          request
        }
      }
    }
    // This is an explicitly bounded native approval contract, not a native UI click.
    const surrogate = async (first: unknown, second?: unknown) => {
      const options = (second ?? first) as MessageBoxOptions
      const decision = evaluate(options)
      state.__autobizNativeApprovals!.push(decision)
      return { response: decision.approved ? 1 : 0, checkboxChecked: false }
    }
    dialog.showMessageBox = surrogate as typeof dialog.showMessageBox
  }, contract)
  nativeApprovalInstalled = true
  readBack.nativeApprovalContract = contract
}

async function run(failures: unknown[]): Promise<void> {
  const watchdog = setTimeout(() => {
    watchdogExpired = true
    failures.push(Error("Autobiz fullstack UI watchdog expired after 600 seconds"))
    void application?.close().catch((error) => failures.push(error))
  }, 600_000)
  try {
    prepareInputs()
    await new Promise<void>((done, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", done)
    })
    const address = server.address()
    assert(address && typeof address === "object")
    application = await launch(60_000)
    assert(release)
    readBack.packageIdentity = await release.verifyBoot(application)
    application
      .process()
      .stdout?.on("data", (chunk: Buffer) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    application
      .process()
      .stderr?.on("data", (chunk: Buffer) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
    )
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("dialog", async (dialog) => {
      try {
        const message = dialog.message()
        confirmations.push({ type: dialog.type(), message })
        if (
          dialog.type() === "confirm" &&
          [
            "当前组件参数有未完成的草稿，切换会丢弃这些草稿，继续吗？",
            "更换步骤类型会丢弃当前类型的参数和草稿，是否继续？",
            "删除步骤会丢弃它的参数和未完成草稿，是否继续？"
          ].includes(message)
        )
          await dialog.accept()
        else {
          dialogErrors.push("Unexpected page dialog: " + message)
          await dialog.dismiss()
        }
      } catch (error) {
        dialogErrors.push(error instanceof Error ? error.message : String(error))
      }
    })
    await page.addInitScript("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawView))
    // Bootstrap only. Product mutations below use actual public controls.
    threadId = await page.evaluate(
      async ({ workspace, url, title }) => {
        for (const model of ["fullstack-ui-a", "fullstack-ui-b"])
          await window.api.models.setCustomConfig({
            id: model,
            name: model,
            baseUrl: url,
            model,
            apiKey: "isolated-autobiz-fullstack-fixture",
            maxTokens: 32000,
            maxOutputTokens: 4096
          })
        await window.api.models.setDefault("custom:fullstack-ui-a")
        const row = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (row as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        return id
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1`, title: threadTitle }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threadTitle, { exact: true }).first().click()
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), false)
    assert.equal((await page.evaluate(() => window.api.plugins.list())).length, 0)

    const mods = await navigate("mods")
    const upload = mods.getByLabel("选择插件 ZIP 文件", { exact: true })
    for (const item of exported.packages) {
      await until(
        () => upload.isEnabled(),
        (value) => value,
        "upload control ready"
      )
      await upload.setInputFiles(join(exportRoot, item.file))
      await until(
        async () => ({
          plugins: await page.evaluate(() => window.api.plugins.list()),
          notice: (await mods
            .getByRole("status", { name: "灵件操作结果", exact: true })
            .isVisible())
            ? await mods.getByRole("status", { name: "灵件操作结果", exact: true }).innerText()
            : "",
          ready: await upload.isEnabled()
        }),
        (value) =>
          value.plugins.some((entry) => entry.name === item.name) &&
          value.notice.includes(item.name) &&
          value.ready,
        "current ZIP result and upload re-enabled: " + item.name
      )
    }
    const installed = await page.evaluate(() => window.api.plugins.list())
    assert.deepEqual(
      installed.map((item) => item.name).sort(),
      exported.packages.map((item) => item.name).sort()
    )
    assert.equal(new Set(installed.map((item) => item.id)).size, 3)
    const autobiz = installed.find((item) => item.name === pluginName)!
    assert.equal(autobiz.version, "1.0.87-mods.1")
    await installNativeApprovalContract(autobiz.path)
    assert.equal((await jobs()).length, 0)
    assert.equal((await runs()).length, 0)
    assert.equal(requests.length, 0)
    await shot("01-imported-three-packages.png")
    pass("Exact 504e327 branch package and two independent plugins import through public UI")

    const global = mods.getByRole("checkbox", { name: "允许使用灵件", exact: true })
    await until(
      () => global.isEnabled(),
      (value) => value,
      "application Mods hydration",
      15_000
    )
    assert.equal(await global.isChecked(), false)
    await global.click()
    await until(
      () => page.evaluate(() => window.api.mods.globalEnabled()),
      (value) => value,
      "application Mods enabled"
    )
    const project = mods.getByRole("checkbox", { name: "在此项目使用灵件", exact: true })
    await until(
      () => project.isEnabled(),
      (value) => value,
      "project Mods hydration",
      15_000
    )
    assert.equal(await project.isChecked(), false)
    await project.click()
    await until(
      () => page.evaluate((id) => window.api.mods.status(id), threadId),
      (value) => value.enabled && identity(value.workspace) === identity(workspace),
      "project Mods enabled"
    )
    for (const item of exported.packages) {
      const card = mods.locator(`[data-function-mod-id="${item.name}"]`)
      await card.getByText("查看完整能力与版本", { exact: true }).click()
      await card.getByRole("button", { name: "授权以上能力", exact: true }).click()
      await card.getByText("已授权", { exact: true }).waitFor()
      await until(
        () => page.evaluate((id) => window.api.mods.status(id), threadId),
        (value) => value.functionMods?.find((entry) => entry.name === item.name)?.state === "ready",
        "authorized " + item.name
      )
    }
    assert.equal(requests.length, 0)
    await shot("02-enabled-and-authorized.png")
    pass("Public switches and digest grants enable three actual sources without starting work")

    let claw = await navigate("claw")
    await claw.getByLabel("Claw 组合名称", { exact: true }).fill(profileName)
    await claw.getByLabel("选择能力 " + pluginName, { exact: true }).check()
    await claw.getByLabel("组件范围 " + pluginName, { exact: true }).selectOption("selected")
    for (const id of ["board", "review", "review-input"]) await componentControl(claw, id).uncheck()
    await claw.getByLabel("Claw 默认模型", { exact: true }).selectOption(refs.b)
    await claw.getByLabel("Claw 角色模型 implementation", { exact: true }).selectOption(refs.a)
    await claw.getByLabel("Claw 角色模型 review", { exact: true }).selectOption(refs.b)
    for (const label of ["技能 Skill", "外部工具 MCP 服务"])
      await claw
        .getByRole("region", { name: label, exact: true })
        .getByRole("button", { name: "仅使用所选", exact: true })
        .click()
    let active = await saveAndApply()
    assert.deepEqual(active.active?.capabilities[0].components?.ids, ["status"])
    assert.equal(active.active?.models?.default, refs.b)
    assert.deepEqual(active.active?.skills, { mode: "selected", items: [] })
    assert.deepEqual(active.active?.mcp, { mode: "selected", items: [] })
    const partial = await commands()
    assert(
      partial.includes("autobiz-fullstack-info") && partial.includes("autobiz-fullstack-status")
    )
    assert(
      !partial.includes("autobiz-fullstack-board") && !partial.includes("autobiz-fullstack-review")
    )
    await shot("03-status-only-combination.png")
    const info = await command("autobiz-fullstack-info")
    assert(info.result?.text.includes(commit))
    assert(info.result?.text.includes(branch))
    const status = await command("autobiz-fullstack-status")
    assert(status.result?.text.includes(exported.workspace.feature))
    assert(status.result?.text.includes(exported.workspace.checkpoint))
    assert.equal(requests.length, 0)
    readBack.statusJob = status
    await shot("04-original-readonly-state.png")
    pass(
      "Status-only selection changes slash availability and reads actual normalized state without a model"
    )

    claw = await editProfile()
    await componentControl(claw, "board").check()
    await componentControl(claw, "status").uncheck()
    await claw.getByText("还缺少配套功能，请点击“加入所需依赖”后保存。", { exact: true }).waitFor()
    assert(await claw.getByRole("button", { name: "保存能力组合", exact: true }).isDisabled())
    await claw.getByRole("button", { name: "加入所需依赖", exact: true }).click()
    assert(await componentControl(claw, "status").isChecked())
    active = await saveAndApply()
    assert.deepEqual(
      new Set(active.active?.capabilities[0].components?.ids),
      new Set(["status", "board"])
    )
    await command("autobiz-fullstack-board")
    const board = page.locator("[data-function-pane]")
    assert.equal(await board.count(), 1)
    await board.waitFor({ state: "visible" })
    assert((await board.innerText()).includes("尚未选定 Feature"))
    await board
      .getByRole("combobox", { name: "明确选择 Feature", exact: true })
      .selectOption(exported.workspace.feature)
    await until(
      () => board.innerText(),
      (value) => value.includes(exported.workspace.checkpoint),
      "public Feature selection"
    )
    await board.getByRole("button", { name: "刷新真实状态（保留执行审批）", exact: true }).click()
    await until(
      () => board.innerText(),
      (value) => value.includes("已通过原分支入口刷新。"),
      "real board refresh callback"
    )
    const boardText = await board.innerText()
    assert(
      boardText.includes(exported.workspace.feature) &&
        boardText.includes(exported.workspace.checkpoint)
    )
    const nodes = exported.workspace.record.workflowNodes
    if (Array.isArray(nodes) && nodes.length)
      for (const node of nodes) assert(boardText.includes(String(node)))
    else assert(boardText.includes("原状态未提供选定节点；不推断流程。"))
    await shot("05-real-state-board.png")
    pass(
      "Board dependency, explicit Feature selection and real refresh preserve the original state"
    )

    claw = await editProfile()
    await componentControl(claw, "review").check()
    await componentControl(claw, "review-input").check()
    await claw.getByLabel("选择能力 review-agent", { exact: true }).check()
    await claw.getByLabel("选择能力 component-review-kit", { exact: true }).check()
    await claw.getByLabel("组件范围 component-review-kit", { exact: true }).selectOption("selected")
    await claw.getByLabel("选择组件 component-review-kit · 代码检视", { exact: true }).uncheck()
    await claw.getByLabel("选择组件 component-review-kit · 示例说明", { exact: true }).uncheck()
    active = await saveAndApply()
    assert.deepEqual(
      new Set(active.active?.capabilities.map((item) => item.name)),
      new Set([pluginName, "review-agent", "component-review-kit"])
    )
    assert(active.active)
    const kit = active.active.capabilities.find((item) => item.name === "component-review-kit")
    assert(kit)
    assert.deepEqual(kit.components?.ids, ["report"])
    stage = "single-review"
    const single = await command("autobiz-fullstack-review", exported.workspace.sourceFile)
    assert(single.result?.text.includes("AUTOBIZ_SINGLE_REVIEW"))
    assert.equal(requests.length, 1)
    await shot("06-single-file-model-result.png")
    pass("Adding the review component makes a real file command call the selected model B")

    const beforeFlow = await activity()
    await navigate("flows")
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
    const editor = page.getByRole("group", { name: "流程编辑器", exact: true })
    await editor.getByLabel("流程名称", { exact: true }).fill(crossFlowName)
    await editor.getByLabel("任务目标", { exact: true }).fill(taskGoal)
    const prepare = editor.locator("[data-flow-step]").first()
    await expandStep(prepare)
    await prepare.getByLabel("步骤类型", { exact: true }).selectOption("plugin-action")
    await prepare
      .getByLabel("动作提供者", { exact: true })
      .selectOption({ label: pluginName + " · Autobiz：准备真实单文件检视输入" })
    await prepare.getByLabel("步骤名称", { exact: true }).fill("准备真实文件和 Feature 状态")
    for (const [field, value] of [
      ["真实 Feature ID", exported.workspace.feature],
      ["项目相对文件路径", exported.workspace.sourceFile]
    ]) {
      await prepare.getByLabel("设置 动作输入 · " + field, { exact: true }).check()
      await prepare.getByLabel("动作输入 · " + field, { exact: true }).fill(value)
    }
    const prepareId = await prepare.getAttribute("data-flow-step")
    assert(prepareId)
    const review = await addPluginStep(
      editor,
      "review-agent · 独立 Review：检视前一步文件",
      "独立插件检视真实文件"
    )
    const reviewId = await review.getAttribute("data-flow-step")
    assert(reviewId)
    await review.getByLabel("接收前置步骤输出", { exact: true }).selectOption(prepareId)
    assert.equal(await review.getByLabel("输出来源路径", { exact: true }).inputValue(), "")
    const report = await addPluginStep(
      editor,
      "component-review-kit · 整理提供的结果",
      "第三个插件汇报有效结果"
    )
    await report.getByLabel("接收前置步骤输出", { exact: true }).selectOption("__evidence")
    assert.equal(await report.getByLabel("执行结果写入字段", { exact: true }).inputValue(), "text")
    const crossFlow = await saveFlow(editor, crossFlowName)
    assert.equal(crossFlow.definition.steps.length, 4)
    assert.deepEqual(
      crossFlow.definition.steps.map((item) => item.kind),
      ["plugin-action", "plugin-action", "plugin-action", "approval"]
    )
    const [prepareStep, reviewStep, reportStep] = crossFlow.definition.steps
    assert(
      prepareStep.kind === "plugin-action" &&
        reviewStep.kind === "plugin-action" &&
        reportStep.kind === "plugin-action"
    )
    assert.equal(prepareStep.actionId, "prepare-review")
    assert.deepEqual(prepareStep.input, {
      feature: exported.workspace.feature,
      path: exported.workspace.sourceFile
    })
    assert.equal(reviewStep.actionId, "review-input")
    assert.deepEqual(reviewStep.inputFrom, { stepId: prepareId })
    assert.deepEqual(reviewStep.input, {})
    assert.equal(reportStep.actionId, "report")
    assert.deepEqual(reportStep.evidenceInput, { field: "text" })
    assert.equal(reportStep.inputFrom, undefined)
    assert.equal(new Set([prepareStep.pluginId, reviewStep.pluginId, reportStep.pluginId]).size, 3)
    assert.deepEqual(await activity(), beforeFlow)
    readBack.crossFlow = crossFlow
    await shot("07-three-plugin-flow-editor.png")
    active = await bindFlow(crossFlow)
    stage = "cross-flow"
    const panel = await startFlow(active, taskGoal)
    await shot("08-chat-started-flow.png")
    const waitingRows = await until(
      runs,
      (values) =>
        values.some(
          (item) =>
            item.flow.definition.name === crossFlowName &&
            ["waiting", "complete", "failed", "cancelled", "interrupted"].includes(item.status)
        ),
      "cross-plugin result and confirmation",
      90_000
    )
    const waiting = waitingRows.find((item) => item.flow.definition.name === crossFlowName)!
    readBack.crossWaiting = waiting
    assert.equal(waiting.status, "waiting", JSON.stringify(waiting))
    assert(waiting.pendingApproval)
    assert.equal(waiting.taskGoal, taskGoal)
    assert.deepEqual(waiting.flow, active.active?.flow)
    assert.equal(requests.length, 3)
    const prepared = waiting.attempts.find((item) => item.stepId === prepareId)!
    assert.equal(prepared.status, "passed")
    assert.equal(prepared.result?.source, "plugin-action")
    assert.equal(prepared.result?.output?.feature, exported.workspace.feature)
    assert.equal(prepared.result?.output?.checkpoint, exported.workspace.checkpoint)
    assert.equal(prepared.result?.output?.stage, exported.workspace.record.stage)
    assert.equal(prepared.result?.output?.path, exported.workspace.sourceFile)
    assert.equal(prepared.result?.output?.source, sourceText)
    const reviewed = waiting.attempts.find((item) => item.stepId === reviewId)!
    assert.equal(reviewed.status, "passed")
    assert.equal(reviewed.result?.output?.scope, "single-file-no-tests")
    assert.equal(reviewed.result?.output?.model, "default")
    assert(text(reviewed.result?.output?.review).includes("AUTOBIZ_CROSS_REVIEW"))
    assertNoNativeTests(waiting)
    const waitingPane = await details(panel, waiting)
    assert((await waitingPane.innerText()).includes("AUTOBIZ_CROSS_REVIEW"))
    assert((await waitingPane.innerText()).includes("AUTOBIZ_EVIDENCE_REPORT"))
    assert(
      (await waitingPane.getByLabel("原生项目测试证据", { exact: true }).innerText()).includes(
        "尚无可确认的项目测试结果"
      )
    )
    await shot("09-real-results-and-confirmation.png")
    pass(
      "Public chat runs three independent plugins with real source, current evidence and no test claim"
    )
    await waitingPane.getByRole("button", { name: "同意并继续", exact: true }).click()
    const finalRows = await until(
      runs,
      (values) =>
        values.some(
          (item) =>
            item.id === waiting.id &&
            ["complete", "failed", "cancelled", "interrupted"].includes(item.status)
        ),
      "public human confirmation",
      60_000
    )
    const crossFinal = finalRows.find((item) => item.id === waiting.id)!
    readBack.crossFinal = crossFinal
    assert.equal(crossFinal.status, "complete", JSON.stringify(crossFinal))
    assert.equal(requests.length, 3)
    assertNoNativeTests(crossFinal)
    await details(panel, crossFinal)
    await shot("10-human-confirmed-flow.png")
    pass("Human confirmation completes the current outcome without replay or checkpoint changes")

    stage = "agents"
    await navigate("flows")
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
    await editor.getByLabel("流程名称", { exact: true }).fill(agentFlowName)
    await editor
      .getByLabel("任务目标", { exact: true })
      .fill("两个模型分别只读同一个实际源码文件，展示分工而非项目测试或代码实现")
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
      await expandStep(step)
      await step.getByLabel("步骤名称", { exact: true }).fill(`模型 ${key.toUpperCase()} 只读检视`)
      await step.getByLabel("执行助手", { exact: true }).selectOption("Explore")
      await step
        .getByLabel("步骤目标", { exact: true })
        .fill(
          `[FULLSTACK-AGENT-${key.toUpperCase()}] 必须用 read_file 读取 ${join(workspace, exported.workspace.sourceFile)}，核对 unknown checkpoint 的展示，随后返回 structured_output。禁止修改、运行测试或推进阶段。`
        )
      await step.getByLabel("模型选择方式", { exact: true }).selectOption("fixed")
      await step.getByLabel("模型", { exact: true }).selectOption(refs[key])
    }
    const agentFlow = await saveFlow(editor, agentFlowName)
    assert.equal(agentFlow.definition.steps.length, 2)
    for (const [index, ref] of [refs.a, refs.b].entries()) {
      const step: FlowStep = agentFlow.definition.steps[index]
      assert(step.kind === "agent" && step.enabled)
      assert.equal(step.modelId, ref)
      assert.equal(step.agentType, "Explore")
      assert.equal(step.modelRole, undefined)
    }
    readBack.agentFlow = agentFlow
    await shot("11-two-fixed-model-editor.png")
    active = await bindFlow(agentFlow)
    const agentPanel = await startFlow(
      active,
      "分别由模型 A 与 B 读取同一分支文件并给出只读检视结果"
    )
    const agentRows = await until(
      runs,
      (values) =>
        values.some(
          (item) =>
            item.flow.definition.name === agentFlowName &&
            ["complete", "failed", "cancelled", "interrupted"].includes(item.status)
        ),
      "real A/B Agent reads",
      90_000
    )
    const agentFinal = agentRows.find((item) => item.flow.definition.name === agentFlowName)!
    readBack.agentFinal = agentFinal
    assert.equal(agentFinal.status, "complete", JSON.stringify(agentFinal))
    assert.equal(agentFinal.attempts.length, 3)
    assert.deepEqual(
      agentFinal.attempts.map((item) => item.stepId),
      [...agentFlow.definition.steps.map((item) => item.id), "__final"]
    )
    for (const [index, ref] of [refs.a, refs.b].entries()) {
      const attempt = agentFinal.attempts[index]
      assert.equal(attempt.status, "passed")
      assert.notEqual(attempt.invalidated, true)
      assert.equal(attempt.result?.source, "agent")
      assert.equal(attempt.result?.modelId, ref)
    }
    assert.equal(agentFinal.attempts[2].result?.source, "host")
    assert.equal(agentFinal.attempts[2].result?.modelId, undefined)
    assertNoNativeTests(agentFinal)
    const agentRequests = requests.filter((item) => item.stage === "agents")
    assert.deepEqual(
      agentRequests.map((item) => [item.model, item.kind]),
      [
        [modelNames.a, "agent-read"],
        [modelNames.a, "agent-result"],
        [modelNames.b, "agent-read"],
        [modelNames.b, "agent-result"]
      ]
    )
    assert.equal(requests.length, 7)
    const agentPane = await details(agentPanel, agentFinal)
    for (const request of agentRequests.filter((item) => item.kind === "agent-result"))
      assert((await agentPane.innerText()).includes(request.answer!))
    await shot("12-real-A-B-file-read-results.png")
    pass(
      "Two fixed Agent models each perform the actual read_file and return separately without writing"
    )

    const beforeRefresh = await activity()
    const binding = await view()
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threadTitle, { exact: true }).first().click()
    const restored = await sidebar("运行")
    await details(restored, agentFinal)
    assert.deepEqual((await view()).active, binding.active)
    assert.deepEqual(await activity(), beforeRefresh)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(providerErrors, [])
    assert.deepEqual(dialogErrors, [])
    verifyInputs()
    await shot("13-refreshed-results-no-replay.png")
    pass(
      "Refresh preserves the applied version and real outcomes without modifying source or replaying work"
    )
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
            error: error instanceof Error ? error.stack : String(error),
            stage,
            checks,
            pageErrors,
            providerErrors,
            dialogErrors,
            readBack
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  } finally {
    clearTimeout(watchdog)
    if (application && nativeApprovalInstalled)
      await attemptModsE2eCleanup(failures, async () => {
        const decisions = await application!.evaluate(
          () =>
            (globalThis as typeof globalThis & { __autobizNativeApprovals?: NativeApproval[] })
              .__autobizNativeApprovals ?? []
        )
        readBack.nativeApprovals = decisions
        assert(decisions.length > 0, "The real host must request process authorization")
        assert(
          decisions.every((item) => item.approved),
          "Unknown native requests must fail closed and fail this acceptance"
        )
      })
    if (application)
      applicationClosed = await attemptModsE2eCleanup(failures, () => application!.close())
    serverClosed = await attemptModsE2eCleanup(failures, async () => {
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
    })
    await attemptModsE2eCleanup(failures, verifyInputs)
    await attemptModsE2eCleanup(failures, () => {
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(providerErrors, [])
      assert.deepEqual(dialogErrors, [])
      if (completed) assert.equal(requests.length, 7)
    })
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "report.json"),
        JSON.stringify(
          {
            passed: completed && failures.length === 0,
            source: exported?.source,
            version: release?.version,
            freezeManifest: release && {
              path: release.manifestPath,
              sha256: release.manifestSha256
            },
            packageFiles: release?.packageFiles,
            exportRoot,
            isolated,
            workspace,
            threadId,
            checks,
            screenshots,
            stages,
            waits,
            requests: requests.map((item) => ({
              ...item,
              messages: item.messages.map((message) => ({
                role: message.role,
                content: text(message.content).slice(0, 20_000),
                tool_call_id: message.tool_call_id,
                tool_calls: message.tool_calls
              }))
            })),
            inputPins,
            copiedPins,
            readBack,
            pageErrors,
            providerErrors,
            dialogErrors,
            confirmations,
            watchdogExpired,
            applicationClosed,
            serverClosed,
            totalElapsedMs: performance.now() - startedAt,
            failures: failures.map((error) =>
              error instanceof Error ? error.stack : String(error)
            ),
            mutationBoundary:
              "Only model/thread/workspace bootstrap uses IPC; Mod/Claw/Flow editing and execution use public UI. Native process approval is an exact-request contract surrogate, not a native UI click.",
            fixtures: [
              "private profile and copied archive",
              "offline SSO",
              "local HTTP protocol models",
              "bounded native process approval dialog"
            ],
            notCovered: [
              "customer installation/SSO/model review quality",
              "complete legacy Plugin/Harness business workflow",
              "project Python/Node tests or repair",
              "automatic checkpoint advancement",
              "full process-tree cleanup"
            ],
            testBoundary:
              "This suite reads actual upstream source; separate root/integration/script/Node baseline receipts own project test results. Host __final is bookkeeping, not a project test.",
            artifactLeaf: basename(artifacts)
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
