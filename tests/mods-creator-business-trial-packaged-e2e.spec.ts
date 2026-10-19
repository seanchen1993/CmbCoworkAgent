/** Actual creator -> uninstalled candidate -> native trial -> original PRD/Hook -> feedback.
 * Controlled loopback model and bounded native dialog/tool approvals, not OS human acceptance.
 * No substitute runner, direct business-state write, synthetic receipt or installed candidate.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Locator, Page } from "playwright"
import type { DevelopmentBusinessTrialStatus } from "../src/shared/mods/development"
import { extensionContextStorageKey } from "../src/main/harness-board/extension-context"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import {
  creatorBusinessTrialModel,
  creatorTrialWorkspaceIdentity
} from "./support/creator-business-trial-model"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "A final ASAR is mandatory; no built fallback")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.execution, "packaged-asar")
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256, "Pin the actual final ASAR")
const fixture = projectCompositionEnvironment(root)
const archive = resolve(
  process.env.AUTOBIZ_CREATOR_TRIAL_SOURCE_ZIP ??
    "output/deliveries/mods-creator-spec-role-20261017-v103/10-完整AutoBiz+并行进度+知识版-1.0.3.zip"
)
const bytes = readFileSync(archive),
  zip = new AdmZip(bytes)
const baseMetadata = JSON.parse(zip.readAsText("plugin.json")) as { name: string; version: string }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const knowledge = join(fixture.isolated, "knowledge")
const knowledgeFile = join(knowledge, "CALC/rules.md")
const rule =
  "CREATOR_TRIAL_KNOWLEDGE_FULL_BODY: integer inputs only; reject booleans and text; cover negative integers; preserve original hooks; local sample only; business acceptance needs_review."
mkdirSync(join(knowledge, "CALC"), { recursive: true })
writeFileSync(
  join(knowledge, "agents.manifest.json"),
  JSON.stringify({
    schemaVersion: "v1",
    systems: [
      {
        systemId: "CALC",
        systemName: "Controlled native trial",
        agentsPath: "CALC/AGENTS.md",
        deployUnits: [{ deployUnitId: "CALC.LOCAL", description: "Real local PRD trial" }]
      }
    ]
  })
)
writeFileSync(
  join(knowledge, "CALC/AGENTS.md"),
  "# Native trial knowledge\nRead the selected CALC/rules.md for the actual requirements. This index does not contain the rule body.\n"
)
writeFileSync(
  knowledgeFile,
  `---\ntitle: Trial knowledge\ntype: Product Knowledge\ndeploy_unit: CALC.LOCAL\ndescription: CREATOR_TRIAL_KNOWLEDGE_FULL_BODY\n---\n${rule}\n`
)
const network = join(fixture.isolated, "collector-network-fixture.cjs")
writeFileSync(
  network,
  `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
const original=http.request;http.request=(options,callback)=>{const host=typeof options==="string"?new URL(options).hostname:options.hostname;
if(host==="archguardservice.paas.cmbchina.cn"){const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request}
if(!["127.0.0.1","localhost"].includes(host))throw Error("CREATOR_TRIAL_EXTERNAL_HTTP_BLOCKED");return original(options,callback)};`
)
let app: ElectronApplication | undefined,
  page: Page,
  baseId = ""
let scope: { threadId: string; expectedWorkspace: string }
const model = creatorBusinessTrialModel({
  baseId: () => baseId,
  knowledgeFile,
  knowledgeRule: rule,
  privateTrialRoot: join(fixture.env.CMB_COWORK_AGENT_HOME, "creator-business/trials")
})
const approvals: unknown[] = []
const evidence: Record<string, unknown> = {
  passed: false,
  candidate,
  archive,
  archiveSha256: hash(bytes),
  stageTimeoutMs: 90000,
  controlledModel: true,
  nativeApprovalHarness:
    "Original native UI configuration/source consent and bounded directory/tool decisions; not OS human/business acceptance",
  scope:
    "One actual original AutoBiz PRD with chosen KB; original full candidate is stopped explicitly after PRD. No full lifecycle or S6 claim."
}
const save = () =>
  writeFileSync(
    join(fixture.isolated, "validation.json"),
    JSON.stringify(
      {
        ...evidence,
        modelRequests: model.requests,
        modelErrors: model.errors,
        approvals
      },
      null,
      2
    )
  )
async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  budget = 60000
) {
  const deadline = Date.now() + budget
  do {
    assert.deepEqual(model.errors, [])
    const next = await read()
    if (predicate(next)) return next
    await new Promise((done) => setTimeout(done, 100))
  } while (Date.now() < deadline)
  throw Error(`Timed out without relaxing original stage budget: ${label}`)
}
async function status() {
  return page.evaluate((input) => window.api.mods.development.status(input), {
    threadId: scope.threadId
  })
}
async function trial() {
  const value = (await status()).business?.trial
  assert(value, "Original host must return a trial record")
  return value
}
async function showTrialSession(record: Locator) {
  await record.getByRole("button", {
    name: /^(查看试用会话与原工具确认|收起试用会话)$/
  }).waitFor({ timeout: 5000 })
  const open = record.getByRole("button", { name: "查看试用会话与原工具确认", exact: true })
  if (await open.isVisible()) await open.click()
}
async function showCheckpointRecord(record: Locator) {
  const summary = record.locator("summary").filter({ hasText: "原生检查点与流程决策记录" })
  if (!(await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click()
}
async function showCreator() {
  await page.getByText("Isolated business creator", { exact: true }).first().click()
  await page.waitForSelector("textarea.composer-textarea")
}
async function launch() {
  app = await createHeadlessProjectCompositionLaunch(root, fixture, {
    unobtrusivePresentation: true
  })()
  app
    .process()
    .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
  app
    .process()
    .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
  // Playwright deliberately strips NODE_OPTIONS on launch. Configure this private test-only
  // metadata adapter in the actual main process for original Python -> Node child inheritance.
  await app.evaluate((_electron, path) => {
    process.env.NODE_OPTIONS = `--require "${path.replaceAll("\\", "/")}"`
  }, network)
  await app.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      )
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw Error("CREATOR_TRIAL_EXTERNAL_FETCH_BLOCKED")
      return original(input, init)
    }
  })
  page = await app.firstWindow({ timeout: 60000 })
  await page.waitForFunction(() => Boolean(window.api?.mods?.development?.businessTrial))
}
function retainedSource(record: DevelopmentBusinessTrialStatus) {
  assert(record.packageDigest)
  const source = join(
    fixture.env.CMB_COWORK_AGENT_HOME,
    "creator-business/trials/packages",
    record.packageDigest,
    "package"
  )
  assert(existsSync(join(source, "board_core/board_config.json")), "Exact actual retained source")
  return source
}
function prepareCollectorDependencies(record: DevelopmentBusinessTrialStatus) {
  const source = retainedSource(record)
  const metadata = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"))
  const board = readFileSync(join(source, "board_core/board_config.json"))
  const contract = JSON.parse(readFileSync(join(source, "devclaw.project-runtime.json"), "utf8"))
  const key = extensionContextStorageKey(
    metadata,
    board,
    contract.extensionContract.context,
    knowledge
  )
  const collector = join(fixture.env.CMB_COWORK_AGENT_HOME, "plugin-data", key, "collector")
  const dependencies = resolve("output/creator-context-fixture-deps/node_modules")
  assert(
    existsSync(join(dependencies, "gray-matter/index.js")),
    "Prepare fixed fixture dependencies separately; do not install into the package"
  )
  mkdirSync(collector, { recursive: true })
  cpSync(dependencies, join(collector, "node_modules"), { recursive: true })
}
async function configureCurrentTrial(expectedId: string) {
  const dialog = page.getByRole("dialog", { name: "插件试用与整轮验收" })
  await dialog.getByRole("checkbox", { name: /我已核对此候选版本和目标/ }).check()
  await dialog.getByRole("button", { name: "确认创建隔离试用", exact: true }).click()
  let prepared = await until(
    trial,
    (value) => value.id === expectedId && value.phase === "needs-configuration",
    "isolated prepare"
  )
  const sourceReview = await page.evaluate(
    (id) => window.api.mods.development.businessTrial!.source.read(id),
    prepared.id
  )
  assert.equal(sourceReview.projectId, prepared.id)
  assert.equal(sourceReview.packageDigest, prepared.packageDigest)
  assert(sourceReview.source?.hasConfiguration)
  assert.notEqual(
    sourceReview.source.state,
    "ready",
    "A new private trial must not borrow the previous grant"
  )
  const fields = await page.evaluate(
    ({ id, review }) =>
      window.api.mods.development.businessTrial!.source.config.userConfig(
        id,
        review.source!.pluginId!,
        review.workspace
      ),
    { id: prepared.id, review: sourceReview }
  )
  assert(
    !fields.fields.find((field) => field.key === "knowledgeRoot")?.value,
    "New trial must not copy parent/other trial configuration"
  )
  await app!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, knowledge)
  await dialog.getByRole("button", { name: "选择目录", exact: true }).click()
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await until(
    async () =>
      page.evaluate(
        ({ id, review }) =>
          window.api.mods.development.businessTrial!.source.config.userConfig(
            id,
            review.source!.pluginId!,
            review.workspace
          ),
        { id: prepared.id, review: sourceReview }
      ),
    (view) => view.fields.find((field) => field.key === "knowledgeRoot")?.value === knowledge,
    "original native configuration store"
  )
  prepareCollectorDependencies(prepared)
  const consent = dialog.getByRole("region", { name: "本包功能权限" })
  await consent.getByRole("checkbox", { name: /我已核对本包源码版本/ }).check()
  await consent.getByRole("button", { name: "授权此试用版本", exact: true }).click()
  await dialog.getByRole("checkbox", { name: "CALC.LOCAL", exact: true }).check({ timeout: 30000 })
  await dialog.getByRole("button", { name: "确认试用业务上下文", exact: true }).click()
  prepared = await until(
    trial,
    (value) => value.id === expectedId && value.phase === "ready",
    "native context CAS"
  )
  approvals.push({
    mechanism:
      "Native original editor + bounded OS-directory chooser + explicit exact source checkbox",
    id: prepared.id,
    packageDigest: prepared.packageDigest,
    privateWorkspace: sourceReview.workspace,
    configValue: knowledge
  })
  return { prepared, workspace: sourceReview.workspace, source: retainedSource(prepared) }
}
async function approveBoundedTools(record: DevelopmentBusinessTrialStatus,
  beforeExecuteApproval?: () => Promise<void>) {
  if (!record.observation?.threadId) return
  for (const pending of await page.evaluate(
    (id) => window.api.sandbox.getPendingApprovals(id),
    record.observation.threadId
  )) {
    const item = pending as {
      id: string
      filePath?: string
      tool_call: { id: string; name: string; args: { command?: string; file_path?: string } }
    }
    if (item.tool_call.name === "execute") {
      assert(model.commands.has(item.tool_call.args.command!), JSON.stringify(item))
      await beforeExecuteApproval?.()
    } else
      assert(model.files.has(item.filePath ?? item.tool_call.args.file_path!), JSON.stringify(item))
    approvals.push({ mechanism: "Exact bounded original native Sandbox decision harness", item })
    await page.evaluate(
      (item) =>
        window.api.sandbox.sendApprovalDecision({
          requestId: item.id,
          tool_call_id: item.tool_call.id,
          type: "approve"
        }),
      item
    )
  }
}
async function main() {
  execFileSync("git", ["init", "-b", "acceptance", fixture.workspace], { windowsHide: true })
  await new Promise<void>((done) => model.server.listen(0, "127.0.0.1", done))
  const address = model.server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 420000)
  try {
    await launch()
    const install = await page.evaluate(
      (value) =>
        window.api.plugins.install(
          new Uint8Array(value).buffer,
          "reviewed-autobiz-source.zip",
          "local"
        ),
      [...bytes]
    )
    assert(install.success, install.error)
    const installed = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.name === baseMetadata.name
    )!
    assert(installed)
    baseId = installed.id
    const sourceDigest = (await snapshotDerivationSource(installed.path)).digest
    const baselinePlugins = await page.evaluate(() => window.api.plugins.list())
    scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.sandbox.setYoloMode(false)
        await window.api.hooks.logging.save({ enabled: true, diagnostic: true })
        await window.api.models.setCustomConfig({
          id: "creator-trial",
          name: "Actual creator trial",
          baseUrl: url,
          model: "creator-trial",
          apiKey: "isolated-loopback",
          maxTokens: 128000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:creator-trial")
        const thread = await window.api.threads.create({
          title: "Isolated business creator",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const state = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, state.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: state.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await showCreator()
    await page.evaluate(() => {
      const observations: Array<{ threadId: string; items: unknown }> = []
      const nativeWindow = window as unknown as { creatorTrialKnowledge: unknown }
      nativeWindow.creatorTrialKnowledge = observations
      window.api.agent.onManagedAutoSendStreamStart((start) => {
        window.api.agent.observeManagedAutoSendStream(start.runId, (event) => {
          if (event.type !== "custom") return
          const value = event.data as { type?: string; agentmdLoadStatus?: unknown }
          if (value?.type === "harness_agentmd_load_status")
            observations.push({ threadId: start.threadId, items: value.agentmdLoadStatus })
        })
      })
    })
    await page
      .locator("textarea.composer-textarea")
      .fill(
        "TRIAL_CREATOR_CREATE 用原AutoBiz和知识灵件制作可隔离试用的业务插件，增加初版审阅标识。先用真实工具核对来源并准备试用请求，不安装候选，只验原PRD和知识规则。"
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    const first = await until(
      async () => (await status()).business?.trial,
      (value) => !!value && value.phase === "needs-confirmation" && value.canPrepare,
      "model request_trial and original creator turn physical settlement"
    )
    assert(first)
    assert.deepEqual(
      await page.evaluate(() => window.api.plugins.list()),
      baselinePlugins,
      "request_trial must not install the candidate"
    )
    const firstPrepared = await configureCurrentTrial(first.id)
    const firstSnapshotDigest = (await snapshotDerivationSource(firstPrepared.source)).digest
    const dialog = page.getByRole("dialog", { name: "插件试用与整轮验收" })
    const started = Date.now()
    await dialog.getByRole("button", { name: "确认并启动试用", exact: true }).click()
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    const creatorComposer = page.locator("textarea.composer-textarea").first()
    await creatorComposer.fill("CREATOR_DRAFT_MUST_SURVIVE_TRIAL: 试用期间保留的修改意见")
    assert.equal(
      await creatorComposer.inputValue(),
      "CREATOR_DRAFT_MUST_SURVIVE_TRIAL: 试用期间保留的修改意见",
      "Original creator composer must stay editable while the embedded trial session is read-only"
    )
    await page.getByRole("button", { name: "业务插件试用中", exact: true }).click()
    await page.getByRole("button", { name: "继续查看本轮试用与验收", exact: true }).click()
    let firstTrialThreadId: string | undefined
    const checked = await until(
      async () => {
        const current = await trial()
        await approveBoundedTools(current, async () => {
          if (evidence.firstCandidateFunctionUiVisible) return
          assert(current.observation?.threadId)
          // Inspect the actual live Mod at an already-required native approval boundary.
          // After retirement AbovePrompt is not a durable message and must not be replayed.
          const record = dialog.getByRole("region", { name: "原流程运行记录" })
          await showTrialSession(record)
          await record
            .getByText("业务试用审阅标识：初版", { exact: true })
            .waitFor({ state: "visible", timeout: 5000 })
          firstTrialThreadId = current.observation.threadId
          evidence.firstCandidateFunctionUiVisible = true
        })
        const native = model.runtime.get(creatorTrialWorkspaceIdentity(firstPrepared.workspace))
        const statePath = join(firstPrepared.workspace, ".autobizdevops/state.json")
        const state = existsSync(statePath)
          ? JSON.parse(readFileSync(statePath, "utf8"))
          : undefined
        return { current, native, state }
      },
      (value) =>
        !!value.native &&
        value.state?.features?.[value.native.feature]?.checkpoint === "prd_done" &&
        value.current.observation?.stageAttribution === "decision-source" &&
        value.current.observation.stageId === "biz.prd" &&
        value.current.observation.sourceNodeStatus === "done",
      "actual original PRD gate and checkpoint",
      90000
    )
    assert(Date.now() - started < 90000, "Do not relax the original stage limit")
    assert(evidence.firstCandidateFunctionUiVisible)
    assert(firstTrialThreadId)
    const originalSession = dialog.getByRole("region", { name: "原流程运行记录" })
    assert.equal(await originalSession.getByLabel("查看本次试用会话", { exact: true }).inputValue(),
      firstTrialThreadId, "A new managed thread must not replace the session being read")
    const history = originalSession.getByRole("region", { name: "原会话历史记录" })
    await history.locator("pre").filter({ hasText: /"new_checkpoint":\s*"prd_done"/ }).first()
      .waitFor({ state: "visible", timeout: 5000 })
    evidence.originalPrdHistoryVisible = { threadId: firstTrialThreadId,
      durableCheckpointResponse: true, guestReexecution: false }
    const featureRoot = join(
      firstPrepared.workspace,
      ".autobizdevops/features",
      checked.native!.feature
    )
    assert(readFileSync(join(featureRoot, "PRD.md"), "utf8").includes("backend_only"))
    assert(
      model.completed.get(creatorTrialWorkspaceIdentity(firstPrepared.workspace))?.has("chosen-knowledge"),
      "Complete knowledge body must be consumed before authored output"
    )
    const knowledgeObservations = await page.evaluate(
      () =>
        (
          window as unknown as {
            creatorTrialKnowledge: Array<{
              threadId: string
              items: Array<{
                deployUnitId: string
                loaded: boolean
                source: string
                path: string
              }>
            }>
          }
        ).creatorTrialKnowledge
    )
    const loaded = knowledgeObservations
      .flatMap((item) => item.items ?? [])
      .find((item) => item.deployUnitId === "CALC.LOCAL" && item.loaded && item.source === "remote")
    assert(loaded, "Original collector must load the actual chosen external knowledge source")
    assert.equal(resolve(loaded.path).toLowerCase(), resolve(knowledge).toLowerCase())
    evidence.knowledgeLoadObservations = knowledgeObservations
    const gates = await page.evaluate(
      (input) => window.api.mods.development.businessTrial!.gates(input),
      {
        ...scope,
        trialId: checked.current.id,
        digest: checked.current.digest,
        expectedVersion: checked.current.version
      }
    )
    if (gates.some((gate) => gate.status === "pending")) {
      const originalGate = dialog.getByRole("region", { name: "试用原流程人工确认" })
      await originalGate.getByRole("button", { name: "批准此阶段", exact: true }).first().click()
      await originalGate.getByRole("button", { name: "确认批准", exact: true }).click()
      approvals.push({
        mechanism:
          "Original native trial HumanGate card, two explicit confirmations; local fixture only",
        gates
      })
    }
    evidence.originalHumanGateObserved = gates.length > 0
    await dialog.getByRole("button", { name: "停止本次试用", exact: true }).click()
    const stopped = await until(
      trial,
      (value) => value.id === first.id && value.phase === "cancelled",
      "original managed cancellation and confirmed physical cleanup"
    )
    assert(stopped.observation?.threadId)
    assert.equal(checked.current.observation!.sourceNodeStatus, "done")
    assert.equal(checked.current.observation!.stageAttribution, "decision-source")
    const nativeRecord = dialog.getByRole("region", { name: "原流程运行记录" })
    await showCheckpointRecord(nativeRecord)
    await nativeRecord.getByText("最近决策来源节点", { exact: true }).waitFor()
    assert((await nativeRecord.innerText()).includes(stopped.observation.stageId ?? "尚无阶段记录"))
    evidence.firstTrial = {
      id: first.id,
      candidateDigest: first.digest,
      packageDigest: firstPrepared.prepared.packageDigest,
      workspace: firstPrepared.workspace,
      source: firstPrepared.source,
      sourceDigest: firstSnapshotDigest,
      actualCheckpoint: checked.state.features[checked.native!.feature].checkpoint,
      nativeObservation: stopped.observation,
      phase: stopped.phase,
      prdSha256: hash(readFileSync(join(featureRoot, "PRD.md")))
    }
    assert.equal(
      await creatorComposer.inputValue(),
      "CREATOR_DRAFT_MUST_SURVIVE_TRIAL: 试用期间保留的修改意见"
    )
    evidence.creatorComposerEditableAndDraftPreserved = true
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await creatorComposer.fill("")
    await page.getByRole("button", { name: "业务插件组装", exact: true }).click()
    await page.getByRole("button", { name: "继续查看本轮试用与验收", exact: true }).click()
    await dialog
      .getByRole("textbox", { name: "业务插件试用反馈", exact: true })
      .fill(
        "TRIAL_CREATOR_PATCH 将审阅标识改成修订版，保留原业务步骤、知识和校验。为修订候选准备新的隔离试用，不修改或重跑旧任务。"
      )
    await dialog.getByRole("button", { name: "保存反馈并对话优化", exact: true }).click()
    const revised = await until(
      trial,
      (value) =>
        value.id !== first.id &&
        value.digest !== first.digest &&
        value.phase === "needs-confirmation" &&
        value.canPrepare,
      "dialogue feedback -> revised candidate -> fresh trial"
    )
    assert.equal((await snapshotDerivationSource(firstPrepared.source)).digest, firstSnapshotDigest)
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), baselinePlugins)
    const secondPrepared = await configureCurrentTrial(revised.id)
    assert.notEqual(secondPrepared.workspace, firstPrepared.workspace)
    assert.notEqual(secondPrepared.source, firstPrepared.source)
    await dialog.getByRole("button", { name: "确认并启动试用", exact: true }).click()
    const interrupted = await until(
      trial,
      (value) =>
        value.id === revised.id &&
        value.phase === "running" &&
        !!value.observation?.threadId &&
        model.runtime.has(creatorTrialWorkspaceIdentity(secondPrepared.workspace)),
      "new trial actual model entry before controlled process interruption",
      90000
    )
    const revisedConversation = dialog.getByRole("region", { name: "原流程运行记录" })
    await showTrialSession(revisedConversation)
    await revisedConversation
      .getByText("业务试用审阅标识：修订版", { exact: true })
      .waitFor({ state: "visible", timeout: 5000 })
    assert.equal(
      await revisedConversation.getByText("业务试用审阅标识：初版", { exact: true }).count(),
      0,
      "The new trial must render its own authorized Function Mod instead of the previous version"
    )
    evidence.revisedCandidateFunctionUiVisible = true
    evidence.secondTrial = {
      id: revised.id,
      digest: revised.digest,
      packageDigest: secondPrepared.prepared.packageDigest,
      workspace: secondPrepared.workspace,
      source: secondPrepared.source,
      nativeObservation: interrupted.observation
    }
    await page.screenshot({ path: join(fixture.isolated, "creator-isolated-trial.png") })
    // Abruptly exit ONLY this isolated fixture process while its real model request is pending.
    // No store/phase/receipt is modified; restart must derive uncertainty from original durable state.
    const interruptedProcess = app!.process()
    const exited = once(interruptedProcess, "exit")
    await app!.evaluate(() => process.exit(86)).catch(() => {})
    await exited
    app = undefined
    model.releaseHeld()
    const beforeRestart = model.requests.length
    await launch()
    // The original customization view restores its trial dialog after a process restart.
    // Use the new page's locator and its normal Close control before sidebar navigation.
    // The old `dialog` locator belongs to the terminated Electron renderer.
    const restoredDialog = page.getByRole("dialog", { name: "插件试用与整轮验收" })
    await restoredDialog.getByRole("button", { name: "Close", exact: true }).click()
    await restoredDialog.waitFor({ state: "hidden" })
    evidence.restartRestoredDialogDismissed = {
      mechanism: "Original recovered native trial dialog Close button on the new renderer",
      forcedInteraction: false
    }
    await showCreator()
    const restarted = await trial()
    assert.equal(restarted.id, revised.id)
    assert.equal(restarted.phase, "unknown")
    assert.equal(restarted.canStart, false)
    const readback = await page.evaluate(
      (input) => window.api.mods.development.businessTrial!.refresh(input),
      {
        ...scope,
        trialId: restarted.id,
        digest: restarted.digest,
        expectedVersion: restarted.version
      }
    )
    assert.equal(readback.business?.trial?.phase, "unknown")
    const unresolved = readback.business!.trial!
    await assert.rejects(
      () =>
        page.evaluate((input) => window.api.mods.development.businessTrial!.start(input), {
          ...scope,
          trialId: unresolved.id,
          digest: unresolved.digest,
          expectedVersion: unresolved.version
        }),
      /BUSINESS_TRIAL_NOT_READY/,
      "A current-version request still cannot restart an uncertain physical operation"
    )
    await new Promise((done) => setTimeout(done, 2000))
    assert.equal(
      model.requests.length,
      beforeRestart,
      "Restart/readback must not replay model or tools"
    )
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), baselinePlugins)
    assert.equal((await snapshotDerivationSource(installed.path)).digest, sourceDigest)
    assert.equal((await snapshotDerivationSource(firstPrepared.source)).digest, firstSnapshotDigest)
    assert.equal(hash(readFileSync(archive)), hash(bytes))
    evidence.restart = {
      trialId: restarted.id,
      phase: restarted.phase,
      originalModelRequestsUnchanged: true
    }
    evidence.passed = true
    evidence.formalCandidateInstalled = false
    evidence.externalSourceAndFrozenArchiveUnchanged = true
    console.log(`PASS native creator isolated business trial: ${fixture.isolated}`)
  } catch (cause) {
    // Failure-only observation: preserve the original failed deadline and pending approval.
    // These reads neither mount a site nor approve/restart a business operation.
    const observe = async (name: string, read: () => Promise<unknown>) => {
      try { return { name, value: await read() } }
      catch (error) { return { name, error: String(error) } }
    }
    evidence.failureDiagnostics = await Promise.all([
      observe("native-trial", trial),
      observe("trial-dom", async () => page.getByRole("dialog", {
        name: "插件试用与整轮验收"
      }).evaluate((element) => ({
        text: (element.textContent ?? "").slice(0, 32768),
        html: element.outerHTML.slice(0, 131072)
      }))),
      observe("screenshot", async () => {
        const path = join(fixture.isolated, "failure-live-trial.png")
        await page.screenshot({ path, timeout: 5000 })
        return path
      })
    ])
    throw cause
  } finally {
    clearTimeout(watchdog)
    save()
    model.releaseHeld()
    await app?.close()
    model.server.closeAllConnections()
    await new Promise<void>((done) => model.server.close(() => done()))
  }
}
void main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
