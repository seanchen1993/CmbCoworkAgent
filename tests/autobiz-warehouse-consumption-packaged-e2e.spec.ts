/** Original frozen warehouse plugin, native ManagedRun/tools/Hooks/SQLite. Controlled model only. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { extensionContextStorageKey } from "../src/main/harness-board/extension-context"
import type { ManagedRunSummary } from "../src/shared/harness-board-types"
import { createHeadlessProjectCompositionLaunch, projectCompositionCandidate, projectCompositionEnvironment } from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const metadataGuard = join(fixture.isolated, "network-fixture.cjs")
writeFileSync(metadataGuard, `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
const original=http.request;http.request=(options,callback)=>{const host=typeof options==="string"?new URL(options).hostname:options.hostname;
if(host==="archguardservice.paas.cmbchina.cn"){const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request}
if(!["127.0.0.1","localhost"].includes(host))throw Error("A12_EXTERNAL_HTTP_BLOCKED");return original(options,callback)};`)
const archive = resolve(process.env.AUTOBIZ_WAREHOUSE_ARCHIVE ?? "output/deliveries/mods-creator-accepted-20261017/11-数仓开发+进度+知识版.zip")
const archiveBytes = readFileSync(archive), zip = new AdmZip(archiveBytes)
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const metadata = JSON.parse(zip.readAsText("plugin.json"))
const board = JSON.parse(zip.readAsText("board_core/board_config.json"))
const envelope = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
assert.deepEqual(board.workflow.nodes.map((node: { id: string }) => node.id), ["biz.prd", "dev.specs", "warehouse.model", "warehouse.sql", "warehouse.quality"])
assert(!board.workflow.nodes.some((node: { id: string }) => node.id === "dev.code"))
const evidence: Record<string, unknown> = {
  passed: false, candidate, archive, archiveSha256: hash(archiveBytes),
  scope: "Actual five-stage standalone warehouse flow. No original Code/Archive stage is claimed.",
  modelBoundary: "Controlled local tool choices, actual original tools and checks; not enterprise business acceptance.",
  artifactsExportDeclared: envelope.runtime.artifacts,
  stageTimeoutMs: 90000
}
const requests: unknown[] = [], approvals: unknown[] = [], errors: string[] = []
const issued = new Map<string, { step: Step; feature: string; stage: string }>()
const complete = new Set<string>(), authorizedCommands = new Set<string>(), authorizedFiles = new Set<string>()
const stageBegins = new Map<string, number>()
const nativeStageBegins = new Map<string, number>()
let app: ElectronApplication | undefined, page: Page, source = "", workspace = "", projectId = "", activeFeature = ""
const knowledge = join(fixture.isolated, "knowledge")
mkdirSync(join(knowledge, "DW"), { recursive: true })
writeFileSync(join(knowledge, "agents.manifest.json"), JSON.stringify({ schemaVersion: "v1", systems: [{
  systemId: "DW", systemName: "Explicit order warehouse", agentsPath: "DW/AGENTS.md",
  deployUnits: [{ deployUnitId: "DW.ORDER", description: "Local CNY orders" }]
}] }))
const knowledgeRule = "A12_KNOWLEDGE_RULE: CNY integer cents; paid/completed valid; cancelled excluded; explicit local five-order sample; businessAcceptance needs_review."
writeFileSync(join(knowledge, "DW/AGENTS.md"), `# Warehouse rules\n${knowledgeRule}\n`)
writeFileSync(join(knowledge, "DW/orders.md"), `---\ntitle: Order CNY\ntype: Product Knowledge\ndeploy_unit: DW.ORDER\ndescription: A12_KNOWLEDGE_RULE\n---\n${knowledgeRule}\n`)
const sample = resolve("tests/support/autobiz-warehouse-input-sample.py")
const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
interface Step { key: string; name: "read_file" | "write_file" | "execute"; args: Record<string, unknown>; expectedFailure?: boolean }
type Message = { role: string; content: unknown; tool_call_id?: string }
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => text(part?.text)).join("\n") : ""
const save = (name: string, value: unknown) => writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))
function program(skill: string, skillPath: string): Step[] {
  const base = join(workspace, ".autobizdevops/features", activeFeature)
  const file = (name: string) => join(base, "warehouse", name)
  const read = (key: string, path: string): Step => ({ key, name: "read_file", args: { file_path: path } })
  const execute = (key: string, script: string, args: string[]): Step => {
    const command = ["python -I -B -X utf8", quote(script), ...args.map(quote)].join(" ")
    authorizedCommands.add(command)
    return { key, name: "execute", args: { command, cwd: workspace } }
  }
  const checkpoint = (name: string) => execute(`checkpoint-${name}`, join(source, "hooks/update_checkpoint.py"), ["--feature", activeFeature, "--checkpoint", name, "--json"])
  const check = (id: string, command: string) => execute(`${id}-${command}`, join(source, `mods/business/${id}/check.py`), [command, "--feature-dir", base])
  const steps: Step[] = [read("read-original-skill", skillPath)]
  if (skill === "autobiz-requirement-discuss") {
    steps.push(execute("write-prd-input", sample, ["--plugin-root", source, "--workspace", workspace, "--feature", activeFeature, "--step", "prd"]), checkpoint("prd_done"))
  } else if (skill === "autodev-specs") {
    steps.push(checkpoint("specs_in_progress"), execute("write-specs-input", sample, ["--plugin-root", source, "--workspace", workspace, "--feature", activeFeature, "--step", "specs"]), checkpoint("specs_done"))
  } else if (skill === "warehouse-model") {
    steps.push(read("read-prd", join(base, "PRD.md")), checkpoint("warehouse_model_in_progress"), check("warehouse.model", "init-demo"), check("warehouse.model", "build"), read("read-model", file("MODEL.json")), read("read-input", file("INPUT.json")), checkpoint("warehouse_model_done"))
  } else if (skill === "warehouse-sql") {
    steps.push(read("consume-model", file("MODEL.json")), read("consume-input", file("INPUT.json")), read("consume-csv", file("orders.csv")), checkpoint("warehouse_sql_in_progress"))
    if (activeFeature === "warehouse-negative") {
      const path = file("INPUT.json")
      const input = JSON.parse(readFileSync(path, "utf8"))
      authorizedFiles.add(path)
      steps.push({ key: "explicit-upstream-change", name: "write_file", args: { file_path: path, content: JSON.stringify({ ...input, currency: "USD" }, null, 2) } })
      steps.push({ ...check("warehouse.sql", "run"), expectedFailure: true })
      steps.push({ ...checkpoint("warehouse_sql_done"), expectedFailure: true })
    } else {
      steps.push(check("warehouse.sql", "run"), read("read-sql-execution", file("SQL_RUN.json")), read("read-sql-results", file("SQL_RESULTS.json")), checkpoint("warehouse_sql_done"))
    }
  } else if (skill === "warehouse-quality") {
    assert.notEqual(activeFeature, "warehouse-negative", "Invalid upstream input must never start the quality consumer")
    steps.push(read("consume-sql-results", file("SQL_RESULTS.json")), read("consume-sql-run", file("SQL_RUN.json")), checkpoint("warehouse_quality_in_progress"), check("warehouse.quality", "check"), read("read-quality", file("QUALITY.json")), checkpoint("warehouse_quality_done"))
  } else throw Error(`Unsupported original warehouse skill: ${skill}`)
  return steps
}

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) { raw += chunk; assert(raw.length < 4_000_000) }
    const body = JSON.parse(raw), messages = body.messages as Message[]
    assert(requests.length < 150, "No uncontrolled model repair/retry")
    const prompt = text(messages.findLast(message => message.role === "user")?.content)
    const skill = /<name>([^<]+)<\/name>/.exec(prompt)?.[1]
    const skillPath = /<path>([^<]+)<\/path>/.exec(prompt)?.[1]
    assert(skill && skillPath, "Original managed stage must provide its explicit Skill block")
    assert(raw.includes("A12_KNOWLEDGE_RULE"), "Actual provider knowledge must reach every real model request")
    const stageKey = `${activeFeature}:${skill}`
    if (!stageBegins.has(stageKey)) stageBegins.set(stageKey, Date.now())
    assert(Date.now() - stageBegins.get(stageKey)! < 90000, "Unchanged 90 second stage budget")
    for (const message of messages.filter(message => message.role === "tool")) {
      const item = issued.get(message.tool_call_id ?? "")
      if (!item || item.feature !== activeFeature || item.stage !== skill) continue
      const result = text(message.content)
      if (item.step.name === "execute") {
        if (item.step.expectedFailure)
          assert(/exit code [1-9]|blocked|拒绝|失败|not.ok|"ok":\s*false|MODS_/.test(result), result)
        else assert(!/Command failed with exit code [1-9]|MODS_EXECUTION_FAILED/.test(result), result)
      }
      if (item.step.key === "consume-model") {
        const model = JSON.parse(readFileSync(join(workspace, ".autobizdevops/features", activeFeature, "warehouse/MODEL.json"), "utf8"))
        assert(result.includes(model.input.sha256), "Native read_file must deliver the actual model CSV identity before SQL")
      }
      if (item.step.key === "consume-csv") assert(result.includes("O1001,C001,2026-10-01,120.50,paid"))
      if (item.step.key === "consume-sql-results") assert(result.includes("43575"), "Quality's model must receive actual SQL results, not just stage order")
      complete.add(`${stageKey}:${item.step.key}`)
    }
    const step = program(skill, skillPath).find(step => !complete.has(`${stageKey}:${step.key}`))
    let delta: Record<string, unknown> = { role: "assistant", content: activeFeature === "warehouse-negative" && skill === "warehouse-sql" ? "The real upstream contract changed; SQL/checkpoint were rejected. Stop and request input review." : "Actual local stage outputs and original checkpoint checks completed; business review remains required." }
    if (step) {
      assert(body.tools.some((tool: { function: { name: string } }) => tool.function.name === step.name), `Missing actual native tool ${step.name}`)
      const id = `a12-${requests.length}`
      issued.set(id, { step, feature: activeFeature, stage: skill })
      delta = { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
    }
    requests.push({ at: Date.now(), feature: activeFeature, skill, step, body })
    response.writeHead(200, { "content-type": "text/event-stream" })
    const packet = (delta: unknown, finish_reason: unknown) => ({ id: `a12-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
    response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
    response.write(`data: ${JSON.stringify({ ...packet({}, step ? "tool_calls" : "stop"), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("A12 controlled model rejected unexpected facts")
  }
})

async function configureKnowledge(threadId: string, pluginId: string) {
  await app!.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, knowledge)
  await page.evaluate(async ({ threadId, pluginId, workspace }) => {
    const canonical = (await window.api.mods.status(threadId)).workspace
    if (!canonical) throw Error(`Original config workspace unavailable: ${workspace}`)
    await window.api.mods.configure(threadId, true, true, canonical)
    const view = await window.api.mods.userConfig(threadId, pluginId, canonical)
    const selected = await window.api.mods.pickUserConfigPath(threadId, view, "knowledgeRoot")
    if (!selected) throw Error("Native knowledge binding cancelled")
    await window.api.mods.saveUserConfig(threadId, view, "knowledgeRoot", selected)
    const status = await window.api.mods.status(threadId)
    const source = status.functionMods?.find(item => item.pluginId === pluginId)
    if (!source?.digest) throw Error("Missing original compiled function source")
    await window.api.mods.approveFunction(threadId, pluginId, source.digest, canonical)
  }, { threadId, pluginId, workspace })
  const key = extensionContextStorageKey(metadata, zip.readFile("board_core/board_config.json")!, envelope.extensionContract.context, realpathSync(knowledge))
  const collector = join(fixture.env.CMB_COWORK_AGENT_HOME, "plugin-data", key, "collector")
  mkdirSync(collector, { recursive: true })
  const dependencies = resolve("output/creator-context-fixture-deps/node_modules")
  assert(existsSync(join(dependencies, "gray-matter/index.js")))
  cpSync(dependencies, join(collector, "node_modules"), { recursive: true })
}

async function managed(feature: string): Promise<ManagedRunSummary> {
  activeFeature = feature
  const mapping = { deployUnitIdMapping: "a12-order", deployUnitId: "DW.ORDER", localRepoPath: workspace }
  await page.evaluate(async ({ projectId, feature, workspace, mapping }) => {
    await window.api.harnessBoard.createFeature({ projectId, feature,
      selectedDeployUnits: [mapping], sessionContextInjectionSource: "plugin",
      sessionWorkspace: { source: "directory", path: workspace } })
  }, { projectId, feature, workspace, mapping })
  const requestedAt = Date.now()
  nativeStageBegins.set(`${feature}:biz.prd`, requestedAt)
  const run = await page.evaluate(input => window.api.harnessBoard.startManagedRun(input), {
    projectId, featureId: feature, workspacePath: workspace,
    initialUserMessage: `A12 ${feature}: use the explicitly authorized five local CNY orders. Follow the original selected Skill, original checks, native approvals. No production acceptance.`
  })
  let latest = run
  const approved = new Set<string>(), deadline = Date.now() + 5 * 90000
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [])
    latest = (await page.evaluate(({ projectId, feature }) => window.api.harnessBoard.getLatestManagedRun(projectId, feature), { projectId, feature }))!
    const currentStage = latest.lastDecision?.policyResult.facts?.currentNodeId ?? latest.decisionBaseline?.nodeId
    if (currentStage) {
      const key = `${feature}:${currentStage}`
      if (!nativeStageBegins.has(key)) nativeStageBegins.set(key, Date.now())
      assert(Date.now() - nativeStageBegins.get(key)! < 90000, `Original native stage exceeded 90 seconds: ${key}`)
    }
    const thread = latest.currentSession?.threadId
    if (thread) {
      for (const row of await page.evaluate(thread => window.api.sandbox.getPendingApprovals(thread), thread)) {
        const item = row as { id: string; operation?: string; filePath?: string; tool_call: { id: string; name: string; args: { command?: string; file_path?: string } } }
        if (approved.has(item.id)) continue
        if (item.tool_call.name === "execute") assert(authorizedCommands.has(item.tool_call.args.command!), JSON.stringify(item))
        else assert(authorizedFiles.has(item.filePath ?? item.tool_call.args.file_path!), JSON.stringify(item))
        approvals.push(item)
        approved.add(item.id)
        await page.evaluate(item => window.api.sandbox.sendApprovalDecision({ requestId: item.id, tool_call_id: item.tool_call.id, type: "approve" }), item)
      }
    }
    for (const notice of await page.evaluate(() => window.api.appNotifications.list())) {
      if (notice.status !== "pending") continue
      const data = notice.payload as { projectId?: string; featureId?: string }
      if (data.projectId !== projectId || data.featureId !== feature) continue
      if (feature === "warehouse-negative" && notice.type === "biz_retry") {
        const stopped = await page.evaluate(notificationId => window.api.appNotifications.decide({ notificationId, action: "stop", message: "Invalid upstream input; do not replay or continue." }), notice.notificationId)
        assert(stopped.applied, stopped.message)
      } else {
        assert.equal(notice.type, "human_gate", JSON.stringify(notice))
        approvals.push({ nativeHumanGate: notice })
        const result = await page.evaluate(notificationId => window.api.appNotifications.decide({ notificationId, action: "approve", message: "Controlled local sample only; business acceptance remains needs_review." }), notice.notificationId)
        assert(result.applied, result.message)
      }
    }
    if (["completed", "failed", "cancelled"].includes(latest.status)) break
    await new Promise(done => setTimeout(done, 100))
  }
  save(`${feature}-managed.json`, latest)
  save(`${feature}-events.json`, await page.evaluate(({ projectId, feature, runId }) => window.api.harnessBoard.getManagedRunEvents({ projectId, featureId: feature, runId, limit: 500 }), { projectId, feature, runId: run.runId }))
  return latest
}

async function main() {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 900000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app.process().stdout?.on("data", chunk => appendFileSync(join(fixture.isolated, "main.stdout.log"), chunk))
    app.process().stderr?.on("data", chunk => appendFileSync(join(fixture.isolated, "main.stderr.log"), chunk))
    // Controlled network metadata is orthogonal to the original business scripts. No enterprise
    // MCP request is allowed; the original clients see a real transport refusal, never fake tools.
    await app.evaluate((_electron, networkOptions) => {
      // Playwright removes NODE_OPTIONS at Electron launch. Bind only this isolated metadata
      // transport fixture after launch, before original Python/Node collectors can execute.
      process.env.NODE_OPTIONS = networkOptions
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw Error("A12_EXTERNAL_NETWORK_BLOCKED")
        return original(input, init)
      }
    }, `--require "${metadataGuard.replaceAll("\\", "/")}"`)
    page = await app.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.legacyProjects))
    await page.evaluate(() => { (window as unknown as { __name: unknown }).__name = (value: unknown) => value })
    const installed = await page.evaluate(bytes => window.api.plugins.install(new Uint8Array(bytes).buffer, "warehouse-v101.zip", "local"), [...archiveBytes])
    assert(installed.success, installed.error)
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(item => item.name === metadata.name)!
    assert(plugin)
    source = plugin.path
    const prepared = await page.evaluate(async ({ pluginId, workspace, url }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.sandbox.setYoloMode(false)
      await window.api.models.setCustomConfig({ id: "a12-warehouse", name: "A12 actual warehouse", baseUrl: url, model: "a12-warehouse", apiKey: "isolated-fixture", maxTokens: 64000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:a12-warehouse")
      await window.api.mods.configureGlobal(true)
      const project = await window.api.harnessBoard.createProject({ adapterId: pluginId, adapterType: "plugin", name: "A12 local order warehouse", projectCode: "A12WAREHOUSE", projectFromLean: false, projectDir: "warehouse", description: "Explicit local SQLite sample", systemId: "DW", systemName: "Warehouse", workspacePath: workspace })
      return { projectId: project.projectId }
    }, { pluginId: plugin.id, workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` })
    projectId = prepared.projectId
    workspace = join(fixture.workspace, "warehouse")
    writeFileSync(join(workspace, "AGENTS.md"), `# Explicit local warehouse\n${knowledgeRule}\n`)
    const configThread = await page.evaluate(async ({ workspace }) => {
      const thread = await window.api.threads.create({ title: "A12 native bindings", workspacePath: workspace, agentMode: "normal" })
      await window.api.workspace.set(thread.thread_id, workspace)
      return thread.thread_id
    }, { workspace })
    await configureKnowledge(configThread, plugin.id)
    await page.evaluate(({ workspace }) => window.api.harnessBoard.saveDeployUnitMappings([{ deployUnitIdMapping: "a12-order", deployUnitId: "DW.ORDER", description: "CNY sample", repositoryPaths: [{ pathId: "a12-path", localRepoPath: workspace }] }]), { workspace })
    const binding = await page.evaluate(id => window.api.harnessBoard.legacyProjects.enable(id), projectId)
    assert(binding.binding)
    // The commands execute the exact host-pinned package retained by original admission.
    source = join(fixture.env.CMB_COWORK_AGENT_HOME, "legacy-project-runtime/packages", binding.binding.packageDigest, "package")
    assert(existsSync(join(source, "mods/business/warehouse.sql/check.py")))
    const positive = await managed("warehouse-positive")
    assert.equal(positive.status, "completed", JSON.stringify(positive))
    const base = join(workspace, ".autobizdevops/features/warehouse-positive/warehouse")
    const quality = JSON.parse(readFileSync(join(base, "QUALITY.json"), "utf8"))
    assert.equal(quality.qualityStatus, "passed")
    assert.equal(quality.businessAcceptance, "needs_review")
    assert.equal(quality.productionAcceptance, "not_evaluated")
    assert(quality.checks.length >= 15 && quality.checks.every((check: { passed: boolean }) => check.passed))
    assert.equal(quality.summary.inputRows, 5)
    assert.equal(quality.summary.validRows, 4)
    assert.equal(quality.summary.validAmountCents, 43575)
    evidence.positive = { managed: positive, quality, sqlRun: JSON.parse(readFileSync(join(base, "SQL_RUN.json"), "utf8")), sqlResults: JSON.parse(readFileSync(join(base, "SQL_RESULTS.json"), "utf8")) }
    const negative = await managed("warehouse-negative")
    assert.notEqual(negative.status, "completed")
    const bad = join(workspace, ".autobizdevops/features/warehouse-negative/warehouse")
    assert(!existsSync(join(bad, "SQL_RUN.json")))
    assert(!existsSync(join(bad, "local_orders.sqlite3")))
    assert(!existsSync(join(bad, "QUALITY.json")))
    const state = JSON.parse(readFileSync(join(workspace, ".autobizdevops/state.json"), "utf8"))
    assert.notEqual(state.features["warehouse-negative"].checkpoint, "warehouse_sql_done")
    evidence.negative = {
      managed: negative,
      originalInputChanged: JSON.parse(readFileSync(join(bad, "INPUT.json"), "utf8")),
      noSqlEvidenceOrQuality: true,
      originalGateState: state.features["warehouse-negative"],
      detail: await page.evaluate(({ projectId }) => window.api.harnessBoard.getRunDetail(projectId, "warehouse-negative"), { projectId })
    }
    assert.deepEqual(errors, [])
    evidence.warehouseFlowPassed = true
    // A12 additionally requires the separately declared producer-to-consumer handoff. Do not
    // call the whole matrix accepted merely because the standalone warehouse chain passed.
    evidence.passed = false
    evidence.remaining = "Attach original generic artifact export/consumer acceptance; frozen 11 has no runtime.artifacts declaration."
    await page.screenshot({ path: join(fixture.isolated, "warehouse-native-results.png") })
  } finally {
    clearTimeout(watchdog)
    evidence.archiveUnchanged = hash(readFileSync(archive)) === hash(archiveBytes)
    save("evidence.json", { ...evidence, errors, approvals, completedSteps: [...complete], stageBegins: Object.fromEntries(stageBegins), nativeStageBegins: Object.fromEntries(nativeStageBegins) })
    save("model-requests.json", requests)
    await app?.close().catch(() => { /* Preserve failed evidence even if Electron already exited. */ })
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    console.log(JSON.stringify({ candidate, evidence: join(fixture.isolated, "evidence.json") }))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
