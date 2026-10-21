/** Complete plugin10, actual Electron/Legacy admission/native model/Workflow/Python/Git.
 * Loopback controls model choices and local sample authorship, never the executor or receipts.
 * Default strict entry:15min overall and90s per stage. The separate explicit functional entry
 * lets only Code use the remaining original15min while retaining every90s performance breach.
 * The explicit native-functional entry lets the original Workflow timeout chain own Code;
 * its outer cleanup bound derives from native max-runtime plus the original15min allowance.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  realpathSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { ManagedRunSummary } from "../src/shared/harness-board-types"
import type { PersistedWorkflowRun } from "../src/main/agent/workflow/types"
import { extensionContextStorageKey } from "../src/main/harness-board/extension-context"
import { createNativeManagedStageWatchdog } from "./support/native-managed-stage-watchdog"
import { createFullAppAcceptancePolicy, fullAppAcceptanceMode } from "./support/full-app-acceptance-policy"
import { waitForOriginalWorkflowTerminal } from "./support/full-app-workflow-wait"
import { endFullAppModelError, flushFullAppSseHeaders } from "./support/full-app-sse-headers"
import { readFullAppTerminalEvidence } from "./support/full-app-terminal-evidence"
import { modelText, originalWorkflowLauncherArguments, originalWorkflowWorkerReply,
  shellQuote, toolJson, workflowWorkerSteps, originalFullAppProfile, originalMainPromotionArguments,
  type FullAppStep } from "./support/autobiz-full-app-model"
import { createHeadlessProjectCompositionLaunch, projectCompositionCandidate,
  projectCompositionEnvironment } from "./support/project-composition-e2e-fixtures"
import { withModsMainCpuProfile } from "./support/mods-main-cpu-profile-diagnostic"
import { startWorkspaceAccessDiagnostic } from "./support/workspace-access-diagnostic"

const root = resolve(__dirname, "..")
const acceptanceMode = fullAppAcceptanceMode(process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE)
let acceptancePolicy: ReturnType<typeof createFullAppAcceptancePolicy>
let workflowRequestedAt: number | undefined
const fixtureCleanup = new AbortController()
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const archive = resolve(process.env.AUTOBIZ_FULL_APP_ARCHIVE ??
  "output/deliveries/mods-creator-spec-role-20261017-v103/10-完整AutoBiz+并行进度+知识版-1.0.3.zip")
const archiveBytes = readFileSync(archive), zip = new AdmZip(archiveBytes)
const metadata = JSON.parse(zip.readAsText("plugin.json"))
const boardBytes = zip.readFile("board_core/board_config.json")!
const board = JSON.parse(boardBytes.toString("utf8"))
const envelope = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
const packageProfile = originalFullAppProfile(JSON.parse(zip.readAsText("devclaw.business-assembly.json")).kernel)
assert.deepEqual(board.workflow.nodes.map((node: { id: string }) => node.id), [
  "biz.prd", "dev.specs", "dev.design", "dev.plan", "dev.code", "ops.cicd", "ops.archive"
])
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const sample = resolve(packageProfile.parentSample)
const workerSample = resolve(packageProfile.workerSample)
const feature = "app-complete"
const rule = "FULL_APP_KNOWLEDGE_RULE: integer-only APIs; booleans/text rejected; negative values tested; local evidence only; enterprise acceptance needs_review."
const knowledge = join(fixture.isolated, "knowledge"), knowledgeFile = join(knowledge, "sample-context.txt")
mkdirSync(join(knowledge, "CALC"), { recursive: true })
writeFileSync(knowledgeFile, rule)
writeFileSync(join(knowledge, "agents.manifest.json"), JSON.stringify({ schemaVersion: "v1", systems: [{
  systemId: "CALC", systemName: "Controlled calculation", agentsPath: "CALC/AGENTS.md",
  deployUnits: [{ deployUnitId: "CALC.LOCAL", description: "Local successor/double" }]
}] }))
writeFileSync(join(knowledge, "CALC/AGENTS.md"), `# Local calculation\n${rule}\n`)
writeFileSync(join(knowledge, "CALC/rules.md"), `---\ntitle: Integer boundary\ntype: Product Knowledge\ndeploy_unit: CALC.LOCAL\ndescription: FULL_APP_KNOWLEDGE_RULE\n---\n${rule}\n`)
// Only enterprise application metadata is controlled. Remote MCP calls get actual refusal.
const network = join(fixture.isolated, "network-fixture.cjs")
writeFileSync(network, `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
const original=http.request;http.request=(options,callback)=>{const host=typeof options==="string"?new URL(options).hostname:options.hostname;
if(host==="archguardservice.paas.cmbchina.cn"){const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request}
if(!["127.0.0.1","localhost"].includes(host))throw Error("FULL_APP_EXTERNAL_HTTP_BLOCKED");return original(options,callback)};`)
fixture.env.NODE_OPTIONS = `--require "${network.replaceAll("\\", "/")}"`
const requests: unknown[] = [], errors: string[] = [], approvals: unknown[] = [], workflowRuns: unknown[] = []
const evidence: Record<string, unknown> = { passed: false, candidate, archive,
  archiveSha256: hash(archiveBytes), sampleSha256: hash(readFileSync(sample)),
  workerSampleSha256: hash(readFileSync(workerSample)), packageProfile,
  stageTimeoutMs: 90000, overallWatchdogMs: 900000,
  originalVersionLimit: packageProfile.requiresPromotion
    ? "Exact supplied 234-file source / original plugin 1.0.87, independently reviewed author kernel 1.0.3. Native five-role Workflow, production compile/evidence and explicit integration promotion are preserved. No runtime patch or altered wait constants."
    : "Frozen1.0.1 default5worker+2Batch original dispatcher requests three30minute waits after real lifecycles finish; independently reproduced without advancing virtual time. This case uses separately reviewed1.0.3 source preserving the1.0.2 completion wakeup and correcting the original Specs role; it never changes original wait constants at runtime.",
  limits: "Controlled local model/sample code and approval harness; original native execution, Python checks, Git/merge and archive. No enterprise CI or human business acceptance claim." }
type Message = { role: string; content: unknown; tool_call_id?: string }
type Call = { actor: string; step: FullAppStep }
const issued = new Map<string, Call>(), completed = new Map<string, Set<string>>()
const outputs = new Map<string, Record<string, unknown>>()
const authorizedCommands = new Set<string>(), authorizedFiles = new Set<string>()
const stageBegins = new Map<string, number>()
const parentActors = new Map<string, string>()
const specsTaskMarker = "FULL_APP_SPEC_EXPLORATION_TASK_v1"
const specsReportMarker = "FULL_APP_SPEC_EXPLORATION_REAL_REPORT_v1"
const existingSource = "def require_integer(value):\n    if type(value) is not int:\n        raise ValueError(\"integer required\")\n    return value\n"
let app: ElectronApplication | undefined, page: Page, source = "", workspace = "", projectId = ""
let sequence = 0, workflowLaunch: Record<string, unknown> | undefined
let workflowTerminal: PersistedWorkflowRun | undefined
const save = (name: string, value: unknown) =>
  writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))
const execute = (key: string, script: string, args: string[]): FullAppStep => ({ key,
  name: "execute", args: { command: ["python -I -B -X utf8", shellQuote(script),
    ...args.map(shellQuote)].join(" "), cwd: workspace } })
const sampleStep = (action: string, extra: string[] = []) => execute(`sample-${action}`, sample,
  [action, "--plugin-root", source, "--workspace", workspace, "--feature", feature, ...extra])
const checkpoint = (name: string, extra: string[] = []) => execute(`checkpoint-${name}`,
  join(source, "hooks/update_checkpoint.py"), ["--feature", feature, "--checkpoint", name, ...extra, "--json"])
const read = (key: string, file: string): FullAppStep => ({ key, name: "read_file", args: { file_path: file } })

function parentProgram(skill: string, skillPath: string): FullAppStep[] {
  const base = join(workspace, ".autobizdevops/features", feature)
  const steps: FullAppStep[] = [read("chosen-knowledge-rule", join(knowledge, "CALC/rules.md")),
    read("original-skill", skillPath)]
  if (skill === "autobiz-requirement-discuss")
    steps.push(sampleStep("prd"), checkpoint("prd_done"))
  else if (skill === "autodev-specs")
    steps.push(checkpoint("specs_in_progress"), { key: "original-specs-task", name: "task", args: {
      subagent_type: "Explore-autodev-spec",
      description: `${specsTaskMarker}\n使用原 Specs 专用只读角色探索当前真实源码与知识。先 read_file ${join(knowledge, "CALC/rules.md")}，再 read_file ${join(workspace, "existing_input.py")}。逐项核对整数/布尔和文本拒绝/负数规则，严格报告已有实现及信息缺口，引用实际文件和行号。返回 ${specsReportMarker}；不得写文件、产物、checkpoint 或授权。`
    } }, sampleStep("specs"), checkpoint("specs_done"))
  else if (skill === "autodev-design")
    steps.push(checkpoint("design_in_progress"), sampleStep("design"), checkpoint("design_done"))
  else if (skill === "autodev-plan")
    steps.push(checkpoint("plan_in_progress"), sampleStep("plan", ["--knowledge-text-file", knowledgeFile]),
      checkpoint("plan_done"))
  else if (skill === "autodev-code") {
    steps.push(checkpoint("code_in_progress", ["--workflow-decision", "detail_design_before_code=skipped"]),
      execute("original-launcher", join(source, "hooks/workflow_launcher.py"), originalWorkflowLauncherArguments({
        source, workspace, feature, workflowWorkspace: join(workspace, "repositories/creator-code"),
        taskCardId: "Z990692-294" })))
    if (workflowLaunch) {
      const path = workflowLaunch.workflowScriptPath
      assert(typeof path === "string")
      // Exact original file and launcher payload. No simplified replacement Workflow.
      assert.equal(hash(readFileSync(path)), hash(readFileSync(join(source,
        "workflows/code-batched-execution.workflow.js"))))
      assert.equal(hash(readFileSync(path)), workflowLaunch.workflowScriptSha256)
      steps.push({ key: "original-fixed-workflow", name: "workflow", args: {
        scriptPath: path, args: workflowLaunch.workflowArgs, tokenBudget: 40000 } })
      if (workflowTerminal) {
        assert.equal(workflowTerminal.status, "completed")
        assert(workflowTerminal.agents.every(agent => agent.status === "completed"),
          "No errored/cached child may masquerade as a successful native execution")
        const terminal = toolJson(workflowTerminal.result)
        assert.equal(terminal.finalStatus, packageProfile.workflowTerminal)
        if (packageProfile.requiresPromotion)
          steps.push(execute("original-explicit-main-promotion", join(source, "hooks/parallel_integration.py"),
            originalMainPromotionArguments(terminal, feature)))
        steps.push(checkpoint("code_done"))
      }
    }
  } else if (skill === "autoops-cicd")
    steps.push(checkpoint("cicd_in_progress"), read("real-code-evidence", join(base, "evidence/EVIDENCE.jsonl")),
      sampleStep("cicd"), checkpoint("cicd_done"))
  else if (skill === "autoops-archive")
    steps.push(checkpoint("archived", ["--iteration", "1"]), sampleStep("archive"))
  else throw Error(`Unexpected original full10 Skill: ${skill}`)
  return steps
}

const server = createServer(async (request, response) => {
  const disconnected = new AbortController()
  response.once("close", () => disconnected.abort(new Error("Actual model connection closed")))
  const responseSignal = AbortSignal.any([fixtureCleanup.signal, disconnected.signal])
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) { raw += chunk; assert(raw.length < 5_000_000) }
    const body = JSON.parse(raw), messages = body.messages as Message[]
    assert(requests.length < 350, "No uncontrolled retries")
    const prompt = modelText(messages.findLast(message => message.role === "user")?.content)
    const worker = prompt.includes("固定 Code Workflow 已启动：")
    const specsWorker = prompt.includes(specsTaskMarker)
    const tools = body.tools ?? []
    let delta: Record<string, unknown>, step: FullAppStep | undefined, actor = "summary"
    if (!tools.length) {
      delta = { role: "assistant", content: "Preserve the original feature, workflow run IDs, real tool results and pending business checks. Do not replay work or declare approval." }
    } else {
      assert(raw.includes("FULL_APP_KNOWLEDGE_RULE"), "Actual provider knowledge must reach real parent and child requests")
      const prior = messages.filter(message => message.role === "tool")
        .map(message => ({ message, call: issued.get(message.tool_call_id ?? "") }))
        .filter((item): item is { message: Message; call: Call } => Boolean(item.call))
      if (specsWorker) {
        assert(raw.includes("你是 AutoBizDevOps插件中Spec阶段专用文件检索专家"), "Actual original Specs role prompt must be loaded")
        actor = "specs-role-child"
      } else if (worker) actor = prior[0]?.call.actor ?? `child-${++sequence}`
      else {
        const skill = /<name>([^<]+)<\/name>/.exec(prompt)?.[1]
        if (skill) {
          actor = parentActors.get(skill) ?? `parent-${skill}`
          parentActors.set(skill, actor)
        } else actor = "native-workflow-notification"
      }
      const done = completed.get(actor) ?? new Set<string>()
      completed.set(actor, done)
      for (const { message, call } of prior) {
        if (call.actor !== actor || done.has(call.step.key)) continue
        const content = modelText(message.content)
        assert(!/MODS_EXECUTION_FAILED|Command failed with exit code [1-9]/.test(content), content)
        if (call.step.name === "execute") {
          const actual = toolJson(content)
          outputs.set(actor, actual)
          if (call.step.key === "original-launcher") {
            assert.equal(actual.executionMode, "fixed")
            workflowLaunch = actual
            assert(actual.workflowArgs && typeof actual.workflowArgs === "object" && !Array.isArray(actual.workflowArgs))
            const originalArguments = actual.workflowArgs as Record<string, unknown>
            evidence.originalWorkflowTimeouts = { timeoutPerBatchSeconds: originalArguments.timeoutPerBatch,
              runtimeConfig: originalArguments.runtimeConfig, tokenBudget: 40000,
              scope: "Actual original launcher output and original call; not a whole-Code4h deadline" }
          }
        }
        if (call.step.key === "original-explicit-main-promotion") {
          const actual = toolJson(content)
          assert.equal(actual.success, true)
          assert.equal(actual.status, "succeeded")
          assert.equal(actual.runId, toolJson(workflowTerminal!.result).runId)
          evidence.nativePromotion = actual
        }
        if (call.step.key === "read-real-production-source")
          assert(content.includes('raise ValueError("integer required")'), "Review must receive actual source")
        if (call.step.key === "original-specs-task") {
          assert(content.includes(specsReportMarker) && content.includes(rule) &&
            content.includes("existing_input.py:2"), "Parent must receive the original task child real KB/source report")
          evidence.specsTaskResult = { actor, content }
        }
        if (call.step.key === "specs-existing-source")
          assert(content.includes("def require_integer(value):") && content.includes("type(value) is not int") &&
            content.includes('raise ValueError("integer required")'), "Specs child must read actual source bytes")
        if (call.step.key === "chosen-knowledge-rule")
          assert(content.includes(rule), "Real read_file must deliver the complete chosen integer/type/negative constraints before sample authorship")
        if (call.step.name === "structured_output")
          assert(content.includes("Structured output recorded successfully."),
            "The original Workflow must validate the actual structured tool result")
        if (call.step.name === "structured_output") {
          const observed = evidence.structuredOutputResponses as unknown[] | undefined
          evidence.structuredOutputResponses = [...(observed ?? []), { actor, content }]
        }
        done.add(call.step.key)
      }
      if (specsWorker) {
        const steps = [read("chosen-knowledge-rule", join(knowledge, "CALC/rules.md")),
          read("specs-existing-source", join(workspace, "existing_input.py"))]
        step = steps.find(item => !done.has(item.key))
        delta = { role: "assistant", content: `${specsReportMarker}\n## 现有能力\n${join(workspace, "existing_input.py")}:2 使用type(value) is not int拒绝布尔和文本；:4 原样保留负整数。\n## 需求约束\n${rule}\n来源：${join(knowledge, "CALC/rules.md")}。\n## 信息缺口\n未找到加一和乘二实现，需要父步骤根据真实需求生成Specs。` }
      } else if (worker) {
        const plan = workflowWorkerSteps({ prompt, source, workspace, feature, sample: workerSample })
        if (["implementation", "review", "utest", "e2e"].includes(plan.kind))
          plan.steps.unshift(read("chosen-knowledge-rule", join(knowledge, "CALC/rules.md")))
        step = plan.steps.find(item => !done.has(item.key))
        delta = { role: "assistant", content: JSON.stringify(outputs.get(actor)) }
        if (!step) {
          const reply = originalWorkflowWorkerReply(outputs.get(actor), tools,
            done.has("original-structured-output"))
          step = reply.step
          delta = { role: "assistant", content: reply.content }
          if (!tools.some((tool: { function: { name: string } }) => tool.function.name === "structured_output")) {
            const plain = evidence.unstructuredOutputResponses as unknown[] | undefined
            evidence.unstructuredOutputResponses = [...(plain ?? []), {
              actor, actualCommandResult: outputs.get(actor), content: reply.content,
              advertisedToolNames: tools.map((tool: { function: { name: string } }) => tool.function.name)
            }]
          }
        }
        if (step?.name === "structured_output") {
          const submitted = evidence.structuredOutputSubmissions as unknown[] | undefined
          evidence.structuredOutputSubmissions = [...(submitted ?? []), {
            actor, actualCommandResult: outputs.get(actor), arguments: step.args,
            advertisedTool: tools.find((tool: { function: { name: string } }) =>
              tool.function.name === "structured_output")
          }]
        }
      } else {
        const skill = /<name>([^<]+)<\/name>/.exec(prompt)?.[1]
        const skillPath = /<path>([^<]+)<\/path>/.exec(prompt)?.[1]
        if (skill) {
          assert(skillPath)
          const observed = await page.evaluate(() => (window as unknown as {
            fullAppKnowledge: { starts: Array<{ threadId: string }>;
              events: Array<{ threadId: string; items: Array<{ deployUnitId: string; loaded: boolean;
                source: string; path: string }> }> }
          }).fullAppKnowledge)
          const lastStart = observed.starts.at(-1)
          const status = observed.events.findLast(row => row.threadId === lastStart?.threadId)
          const loaded = status?.items.find(item => item.deployUnitId === "CALC.LOCAL")
          assert(loaded?.loaded, "The actual original collector must report CALC.LOCAL loaded before model IO")
          assert.equal(loaded.source, "remote", "Original collector classification must not be a workspace AGENTS.md fallback")
          assert.equal(loaded.path.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase(),
            realpathSync(knowledge).replaceAll("\\", "/").toLowerCase(), "Actual collector must use the native chosen KB")
          evidence.knowledgeLoadObservations = observed
          if (!stageBegins.has(skill)) stageBegins.set(skill, Date.now())
          const stageId = board.workflow.nodes.find((node: { id: string; skill: string }) =>
            node.skill === skill)?.id
          assert(stageId, "Actual original board Skill must identify its stage")
          acceptancePolicy.observe("http", stageId, stageBegins.get(skill)!, Date.now())
          if (skill === "autodev-code" && done.has("original-fixed-workflow") && !workflowTerminal) {
            const deadline = acceptancePolicy.deadline(stageId, stageBegins.get(skill)!)
            flushFullAppSseHeaders(response)
            await waitForOriginalWorkflowTerminal({ readTerminal: () => workflowTerminal,
              deadline, signal: responseSignal,
              observe: () => acceptancePolicy.observe("workflow", stageId, stageBegins.get(skill)!, Date.now()) })
            assert(workflowTerminal, acceptanceMode === "strict90"
              ? "Actual original Code Workflow did not settle within stage90s"
              : acceptanceMode === "bounded-functional"
                ? "Actual original Code Workflow did not settle within original15min absolute budget"
                : "Actual original Code Workflow did not settle within original runtime-derived safety bound")
          }
          step = parentProgram(skill, skillPath).find(item => !done.has(item.key))
        }
        delta = { role: "assistant", content: "Original local stage tools and checks completed. Preserve real workflow facts; enterprise/human acceptance remains needs_review." }
      }
      if (step) {
        if (step.name === "workflow" && workflowRequestedAt === undefined) workflowRequestedAt = Date.now()
        assert(tools.some((item: { function: { name: string } }) => item.function.name === step!.name),
          `Original native tool unavailable: ${step.name}`)
        if (step.name === "task") {
          const actual = tools.find((item: { function: { name: string } }) => item.function.name === "task")
          assert(actual && JSON.stringify(actual).includes("Explore-autodev-spec"),
            "The original runtime task schema must list the actual Specs role")
          assert.equal(actual.function.parameters.properties.description.type, "string")
          assert.equal(actual.function.parameters.properties.subagent_type.type, "string")
          evidence.specsTaskToolSchema = actual
        }
        if (step.name === "execute") authorizedCommands.add(String(step.args.command))
        if (step.name === "read_file") authorizedFiles.add(String(step.args.file_path))
        const id = `full-app-${requests.length}-${++sequence}`
        issued.set(id, { actor, step })
        delta = { role: "assistant", tool_calls: [{ index: 0, id, type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
      }
    }
    requests.push({ at: Date.now(), actor, step, body })
    save("model-requests.json", requests)
    flushFullAppSseHeaders(response)
    const packet = (value: unknown, reason: unknown) => ({ id: `full-app-${requests.length}`,
      object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: value, finish_reason: reason }] })
    response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
    response.write(`data: ${JSON.stringify({ ...packet({}, step ? "tool_calls" : "stop"),
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    if (responseSignal.aborted) {
      response.destroy()
      return
    }
    errors.push(String(error)); save("model-errors.json", errors)
    endFullAppModelError(response)
  }
})

async function configureKnowledge(threadId: string, pluginId: string) {
  await app!.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, knowledge)
  await page.evaluate(async ({ threadId, pluginId }) => {
    const canonical = (await window.api.mods.status(threadId)).workspace
    if (!canonical) throw Error("Missing original configuration workspace")
    await window.api.mods.configure(threadId, true, true, canonical)
    const view = await window.api.mods.userConfig(threadId, pluginId, canonical)
    const selected = await window.api.mods.pickUserConfigPath(threadId, view, "knowledgeRoot")
    if (!selected) throw Error("Native knowledge chooser cancelled")
    await window.api.mods.saveUserConfig(threadId, view, "knowledgeRoot", selected)
    const status = await window.api.mods.status(threadId)
    const actual = status.functionMods?.find(item => item.pluginId === pluginId)
    if (!actual?.digest) throw Error("Missing original compiled source")
    await window.api.mods.approveFunction(threadId, pluginId, actual.digest, canonical)
  }, { threadId, pluginId })
  const key = extensionContextStorageKey(metadata, boardBytes,
    envelope.extensionContract.context, realpathSync(knowledge))
  const collector = join(fixture.env.CMB_COWORK_AGENT_HOME, "plugin-data", key, "collector")
  const dependencies = resolve("output/creator-context-fixture-deps/node_modules")
  assert(existsSync(join(dependencies, "gray-matter/index.js")))
  mkdirSync(collector, { recursive: true })
  cpSync(dependencies, join(collector, "node_modules"), { recursive: true })
}

async function main() {
  let stopWorkspaceDiagnostic: (() => Promise<void>) | undefined
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const started = Date.now()
  acceptancePolicy = createFullAppAcceptancePolicy(acceptanceMode, started)
  const watchdog = setTimeout(() => void app?.close(), acceptancePolicy.overallBudgetMs)
  evidence.overallWatchdogMs = acceptancePolicy.overallBudgetMs
  evidence.nativeRuntimeSafetyBound = acceptancePolicy.nativeRuntime
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture,
      { unobtrusivePresentation: true })()
    const application = app
    stopWorkspaceDiagnostic = await startWorkspaceAccessDiagnostic(application, fixture.isolated, join(fixture.workspace, "complete"))
    if (process.env.CMB_FULL_APP_WORKSPACE_DIAGNOSTIC === "1")
      evidence.workspaceDiagnostic = { enabled: true, naturalAcceptance: false }
    await withModsMainCpuProfile(application, fixture.isolated, async () => {
    // Playwright strips NODE_OPTIONS from Electron launch. Set this private adapter
    // explicitly for the real Python -> Node collector child, never mock its outputs.
    await application.evaluate((_electron, adapter) => {
      process.env.NODE_OPTIONS = `--require "${adapter.replaceAll("\\", "/")}"`
    }, network)
    application.process().stdout?.on("data", value => appendFileSync(join(fixture.isolated, "main.stdout.log"), value))
    application.process().stderr?.on("data", value => appendFileSync(join(fixture.isolated, "main.stderr.log"), value))
    await application.evaluate(() => {
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw Error("FULL_APP_EXTERNAL_FETCH_BLOCKED")
        return original(input, init)
      }
    })
    page = await application.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.legacyProjects))
    await page.evaluate(() => { (window as unknown as { __name: unknown }).__name = (value: unknown) => value })
    const installed = await page.evaluate(bytes => window.api.plugins.install(
      new Uint8Array(bytes).buffer, "full10-actual.zip", "local"), [...archiveBytes])
    assert(installed.success, installed.error)
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(item => item.name === metadata.name)!
    assert(plugin)
    source = plugin.path
    const prepared = await page.evaluate(async ({ pluginId, workspace, url }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.sandbox.setYoloMode(false)
      await window.api.hooks.logging.save({ enabled: true, diagnostic: true })
      await window.api.models.setCustomConfig({ id: "full-app", name: "Full actual App",
        baseUrl: url, model: "full-app", apiKey: "private-fixture", maxTokens: 128000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:full-app")
      await window.api.mods.configureGlobal(true)
      const project = await window.api.harnessBoard.createProject({ adapterId: pluginId,
        adapterType: "plugin", name: "Full actual local AutoBiz", projectCode: "FULLAPP",
        projectFromLean: false, projectDir: "complete", description: "Actual local calculation",
        systemId: "CALC", systemName: "Calculation", workspacePath: workspace })
      return project.projectId
    }, { pluginId: plugin.id, workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` })
    projectId = prepared
    workspace = join(fixture.workspace, "complete")
    writeFileSync(join(workspace, "existing_input.py"), existingSource)
    writeFileSync(join(workspace, "AGENTS.md"), "# Local workspace\nWORKSPACE_FALLBACK_IS_NOT_THE_CHOSEN_KNOWLEDGE\n")
    const threadId = await page.evaluate(async workspace => {
      const thread = await window.api.threads.create({ title: "Full native configuration", workspacePath: workspace, agentMode: "normal" })
      await window.api.workspace.set(thread.thread_id, workspace)
      return thread.thread_id
    }, workspace)
    await configureKnowledge(threadId, plugin.id)
    const mapping = { deployUnitIdMapping: "full-local", deployUnitId: "CALC.LOCAL", localRepoPath: workspace }
    await page.evaluate(({ workspace }) => window.api.harnessBoard.saveDeployUnitMappings([{
      deployUnitIdMapping: "full-local", deployUnitId: "CALC.LOCAL", description: "Local calculation",
      repositoryPaths: [{ pathId: "full-local-path", localRepoPath: workspace }] }]), { workspace })
    const binding = await page.evaluate(id => window.api.harnessBoard.legacyProjects.enable(id), projectId)
    assert(binding.binding)
    evidence.binding = binding
    source = join(fixture.env.CMB_COWORK_AGENT_HOME, "legacy-project-runtime/packages",
      binding.binding.packageDigest, "package")
    assert(existsSync(join(source, "workflows/code-batched-execution.workflow.js")))
    evidence.fixedWorkflowSha256 = hash(readFileSync(join(source, "workflows/code-batched-execution.workflow.js")))
    await page.evaluate(async ({ projectId, workspace, mapping, feature }) => {
      await window.api.harnessBoard.createFeature({ projectId, feature, selectedDeployUnits: [mapping],
        sessionContextInjectionSource: "plugin", sessionWorkspace: { source: "directory", path: workspace } })
    }, { projectId, workspace, mapping, feature })
    await page.evaluate(() => {
      const captured = { starts: [] as Array<{ threadId: string }>, events: [] as unknown[] }
      const host = window as unknown as { fullAppKnowledge: unknown }
      host.fullAppKnowledge = captured
      window.api.agent.onManagedAutoSendStreamStart(start => {
        captured.starts.push({ threadId: start.threadId })
        window.api.agent.observeManagedAutoSendStream(start.runId, event => {
          if (event.type !== "custom") return
          const data = event.data as { type?: string; agentmdLoadStatus?: unknown[] }
          if (data?.type === "harness_agentmd_load_status") captured.events.push({
            threadId: start.threadId, items: data.agentmdLoadStatus
          })
        })
      })
    })
    // The native API awaits inspection/session startup. Charge that preparation to the
    // initial stage too; never start its budget after the API returns or at first HTTP.
    const initialStageStartedAt = Date.now()
    const stageWatchdog = createNativeManagedStageWatchdog(board.workflow.nodes, "biz.prd", initialStageStartedAt,
      (stage, stageStartedAt, at) => {
        acceptancePolicy.observe("native", stage, stageStartedAt, at)
        const skill = board.workflow.nodes.find((node: { id: string; skill: string }) => node.id === stage)?.skill
        const firstHttp = skill && stageBegins.get(skill)
        if (firstHttp !== undefined)
          acceptancePolicy.observe("http", stage, firstHttp, at)
        // The old Workflow wait is charged to the first Code HTTP, not reset at agent()/retry.
        if (stage === "dev.code" && workflowRequestedAt !== undefined && firstHttp !== undefined)
          acceptancePolicy.observe("workflow", stage, firstHttp, at)
      })
    evidence.nativeStageTimingBasis = {
      initial: "host timestamp immediately before original startManagedRun request; includes inspection/admission/context preparation",
      initialStage: "biz.prd",
      initialStageStartedAt,
      subsequent: "original successful transition decision.createTime, attributed by actual new currentSession and exact slashSkill",
      stageTimeoutMs: 90000, acceptanceMode,
      codeExecutionDeadline: acceptanceMode !== "strict90" ? acceptancePolicy.absoluteDeadline : "original90s",
      note: "Original90s timing observations remain performance failures in bounded functional mode"
    }
    const run = await page.evaluate(input => window.api.harnessBoard.startManagedRun(input), {
      projectId, featureId: feature, workspacePath: workspace,
      initialUserMessage: "Full App local integer sample, task card Z990692-294. Follow every original stage, Skill, Hook and validation. Explicitly skip optional detail design. Use original fixed Code workflow with actual two Git worktrees; preserve local evidence. No enterprise acceptance."
    })
    let latest: ManagedRunSummary = run
    const approved = new Set<string>(), observedWorkflows = new Set<string>()
    while (Date.now() - started < acceptancePolicy.overallBudgetMs) {
      assert.deepEqual(errors, [])
      latest = (await page.evaluate(({ projectId, feature }) =>
        window.api.harnessBoard.getLatestManagedRun(projectId, feature), { projectId, feature }))!
      stageWatchdog.observe(latest, Date.now())
      evidence.nativeStageWatchdog = stageWatchdog.evidence()
      const thread = latest.currentSession?.threadId
      const approvalThreads = new Set<string>(thread ? [thread] : [])
      if (thread) {
        const pageOfRuns = await page.evaluate(id => window.api.workflows.listRuns(id, { limit: 10 }), thread)
        for (const summary of pageOfRuns.runs) {
          assert(summary && typeof summary === "object" && "runId" in summary &&
            typeof summary.runId === "string", "Original workflow summary must contain a run ID")
          const actual = await page.evaluate(({ thread, id }) => window.api.workflows.getRun(thread, id),
            { thread, id: summary.runId }) as PersistedWorkflowRun
          assert.equal(actual.scriptSha256, evidence.fixedWorkflowSha256)
          for (const agent of actual.agents) {
            // Read-only approval lookup uses IDs emitted by the actual native run, never a DB row/grant.
            approvalThreads.add(`${actual.threadId}__${actual.runId}_a${agent.index}`)
            assert.notEqual(agent.status, "error", `Original child failed: ${JSON.stringify(agent)}`)
          }
          if (!observedWorkflows.has(actual.runId)) {
            observedWorkflows.add(actual.runId)
            workflowRuns.push({ at: Date.now(), runId: actual.runId, threadId: thread })
          }
          if (actual.status !== "running") {
            assert.equal(actual.status, "completed")
            workflowTerminal = actual
            save("native-workflow.json", actual)
          }
        }
      }
      for (const threadId of approvalThreads) {
        for (const row of await page.evaluate(id => window.api.sandbox.getPendingApprovals(id), threadId)) {
          const item = row as { id: string; filePath?: string; tool_call: {
            id: string; name: string; args: { command?: string; file_path?: string; scriptPreview?: string } } }
          if (approved.has(item.id)) continue
          if (item.tool_call.name === "workflow")
            assert.equal(item.tool_call.args.scriptPreview, readFileSync(join(source,
              "workflows/code-batched-execution.workflow.js"), "utf8"))
          else if (item.tool_call.name === "execute")
            assert(authorizedCommands.has(item.tool_call.args.command!), JSON.stringify(item))
          else assert(authorizedFiles.has(item.filePath ?? item.tool_call.args.file_path!), JSON.stringify(item))
          approvals.push({ at: Date.now(), mechanism: "original native Sandbox decision harness", item })
          approved.add(item.id)
          await page.evaluate(item => window.api.sandbox.sendApprovalDecision({ requestId: item.id,
            tool_call_id: item.tool_call.id, type: "approve" }), item)
        }
      }
      for (const notice of await page.evaluate(() => window.api.appNotifications.list())) {
        const payload = notice.payload as { projectId?: string; featureId?: string }
        if (notice.status !== "pending" || payload.projectId !== projectId || payload.featureId !== feature) continue
        assert.equal(notice.type, "human_gate", JSON.stringify(notice))
        approvals.push({ at: Date.now(), mechanism: "original human-gate decision harness; not human acceptance", notice })
        const decided = await page.evaluate(id => window.api.appNotifications.decide({ notificationId: id,
          action: "approve", message: "Controlled local sample gate only; enterprise business acceptance remains needs_review." }), notice.notificationId)
        assert(decided.applied, decided.message)
      }
      save("managed-latest.json", latest)
      if (["completed", "failed", "cancelled"].includes(latest.status)) break
      await new Promise(done => setTimeout(done, 100))
    }
    assert.equal(latest.status, "completed", JSON.stringify(latest))
    assert(workflowTerminal && workflowRuns.length === 1)
    const specsChildren = requests.filter(row => (row as { actor: string }).actor === "specs-role-child")
    assert(specsChildren.length >= 3, "Actual task child must make HTTP requests for both real reads and its report")
    assert.equal([...issued.values()].filter(call => call.step.key === "original-specs-task").length, 1,
      "One original Specs task invocation, without synthetic DB records or a replacement runner")
    assert(evidence.specsTaskResult, "Parent must consume the real native task result before Specs outputs")
    evidence.specsRoleRequests = specsChildren
    const archived = join(workspace, ".autobizdevops/archive", `${feature}-iter1`)
    assert(existsSync(archived))
    assert(!existsSync(join(workspace, ".autobizdevops/features", feature)))
    const state = JSON.parse(readFileSync(join(workspace, ".autobizdevops/state.json"), "utf8"))
    assert.equal(state.features[feature].checkpoint, "archived")
    const plans = JSON.parse(readFileSync(join(archived, "plan.json"), "utf8"))
    const terminalEvidence = readFullAppTerminalEvidence({ workspace, archived,
      repository: join(workspace, "repositories/creator-code"), workflow: workflowTerminal,
      submissions: evidence.structuredOutputSubmissions as unknown[],
      ...(packageProfile.requiresPromotion ? { promotion: evidence.nativePromotion } : {}) })
    const manifest = terminalEvidence.manifest
    evidence.nativeTerminalProjection = terminalEvidence
    assert([...outputs.values()].some(row => row.negativeFailedTest), "Real failed UTest and original gate rejection required")
    const actualChildren = requests.filter(row => (row as { actor: string }).actor.startsWith("child-"))
    assert(actualChildren.length >= 10, "Actual original child model requests required")
    const actualImplementations = [...issued.values()].filter(item =>
      item.step.key === "actual-original-implementation")
    assert.equal(actualImplementations.length, 2, "Exactly two original implementation child HTTP calls")
    assert.equal(new Set(actualImplementations.map(item => item.actor)).size, 2)
    const implementationFacts = [...outputs.values()].filter(row => packageProfile.requiresPromotion
      ? row.actualProductionCompile : row.actualGitWorktree)
    assert.equal(implementationFacts.length, 2)
    if (packageProfile.requiresPromotion) for (const implementation of implementationFacts) {
      assert.equal((implementation.actualProductionCompile as Record<string, unknown>).passed, true)
      assert.equal(implementation.negativeMissingCompile, true)
      assert.equal(implementation.negativeUnauthorizedWrite, true)
    }
    evidence.result = { latest, workflow: workflowTerminal, state, plans, manifest,
      childModelRequests: actualChildren.length, archive: archived,
      actualImplementationChildren: actualImplementations, workerToolOutputs: Object.fromEntries(outputs) }
    evidence.passed = true
    await page.screenshot({ path: join(fixture.isolated, "full-app-archived.png") })
    })
  } finally {
    await stopWorkspaceDiagnostic?.().catch(error => console.warn("Workspace diagnostic collection failed", String(error)))
    fixtureCleanup.abort(new Error("Full10 fixture finally cleanup; preserve original outcome"))
    clearTimeout(watchdog)
    save("evidence.json", { ...evidence, errors, approvals, workflowRuns,
      acceptance: acceptancePolicy.evidence(evidence.passed === true, Date.now()),
      workflowActualRequestAt: workflowRequestedAt,
      workflowTimingBasis: "Original fixture wait charged from first Code HTTP; actual workflow request time recorded separately",
      stageBegins: Object.fromEntries(stageBegins), elapsedMs: Date.now() - started,
      archiveUnchanged: hash(readFileSync(archive)) === hash(archiveBytes),
      candidateUnchanged: hash(readFileSync(candidate.path)) === candidate.sha256 })
    save("model-requests.json", requests)
    await app?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    console.log(JSON.stringify({ candidate, evidence: join(fixture.isolated, "evidence.json") }))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
