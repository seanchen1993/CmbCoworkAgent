/** Fixture-only preflight. Does not launch an App or execute any business stage. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import AdmZip from "adm-zip"
import { modelText, originalWorkflowCommands, originalWorkflowLauncherArguments, originalWorkflowStructuredOutput,
  originalWorkflowWorkerReply,
  toolJson, workflowWorkerSteps } from "./support/autobiz-full-app-model"

const source = "C:/tmp/private-retained-source"
const workspace = "C:/tmp/private-app-workspace"
const sample = resolve("tests/support/autobiz-full-app-sample.py")
const originalPackage = new AdmZip(resolve(process.env.AUTOBIZ_FULL_APP_ARCHIVE ??
  "output/deliveries/mods-creator-spec-role-20261017-v103/10-完整AutoBiz+并行进度+知识版-1.0.3.zip"))
const launcher = originalPackage.readAsText("hooks/workflow_launcher.py")
// Parse, never import/execute, the actual frozen plugin entry point. No business state is created.
const parser = JSON.parse(execFileSync("python", ["-I", "-B", "-c", `
import ast,json,sys
tree=ast.parse(sys.stdin.buffer.read().decode("utf-8"))
main=next(item for item in tree.body if isinstance(item,ast.FunctionDef) and item.name=="main")
arguments={}
for item in ast.walk(main):
 if isinstance(item,ast.Call) and isinstance(item.func,ast.Attribute) and item.func.attr=="add_argument":
  flags=[arg.value for arg in item.args if isinstance(arg,ast.Constant) and isinstance(arg.value,str) and arg.value.startswith("--")]
  action=next((key.value.value for key in item.keywords if key.arg=="action" and isinstance(key.value,ast.Constant)),None)
  for flag in flags: arguments[flag]=0 if action=="store_true" else 1
print(json.dumps(arguments))
`], { encoding: "utf8", input: launcher, windowsHide: true })) as Record<string, number>
const launchArgs = originalWorkflowLauncherArguments({ source, workspace, feature: "app-complete",
  workflowWorkspace: `${workspace}/repositories/creator-code`, taskCardId: "Z990692-294" })
const validateLauncher = (args: string[]) => {
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    assert(Object.hasOwn(parser, flag), `Unsupported original launcher flag: ${flag}`)
    if (parser[flag] === 1) assert(args[++index] && !args[index].startsWith("--"), `Missing value: ${flag}`)
  }
}
validateLauncher(launchArgs)
assert.deepEqual(launchArgs, ["--feature", "app-complete", "--plugin-path", source,
  "--workspace", workspace, "--workflow-workspace", `${workspace}/repositories/creator-code`,
  "--task-card-id", "Z990692-294", "--json"])
assert.throws(() => validateLauncher(launchArgs.map(arg => arg === "--workflow-workspace" ? "--code-workspace" : arg)), /Unsupported original launcher flag/)
assert.throws(() => validateLauncher(["--feature"]), /Missing value/)
assert.throws(() => validateLauncher([...launchArgs, "--unsupported-option"]), /Unsupported original launcher flag/)
const prefix = `固定 Code Workflow 已启动：示例 python -X utf8 "${source}/hooks/query_json_fields.py" --file "<JSON_PATH>"。\n`
const command = `python -X utf8 "${source}/hooks/parallel_batch_scheduler.py" status --workspace "${workspace}" --feature "app-complete" --run-id "R1" --workflow-view`
assert.deepEqual(originalWorkflowCommands(`${prefix}执行 ${command}。只返回完整JSON。`, source), [command])
assert.deepEqual(originalWorkflowCommands(`${prefix}执行 ${command}。可选示例 python -X utf8 "${source}/hooks/query_json_fields.py" --file "manifest.json" --field "batches.<BATCH_ID>.status"。`, source), [command])
assert.throws(() => originalWorkflowCommands(`${prefix}执行 python -X utf8 "C:/foreign/hooks/a.py" status。`, source), /Foreign/)
assert.throws(() => originalWorkflowCommands(`${prefix}执行 ${command} && echo bypass。`, source), /continuation/)
assert.deepEqual(originalWorkflowCommands(`${prefix}${command}，并且只原样返回它的 stdout JSON。`, source), [command])
const quotedComma = `${command} --metadata-json '{"message":"保留，正文","values":[1,2]}' --label "甲，乙"`
assert.deepEqual(originalWorkflowCommands(`${prefix}${quotedComma}，只返回 JSON。`, source), [quotedComma])
assert.throws(() => originalWorkflowCommands(`${prefix}执行 ${command} --token <placeholder>。`, source), /Non-executable/)
assert.deepEqual(toolJson("Original native execute exit0\n{\"runId\":\"R1\",\"nested\":{\"brace\":\"}\"}}\n"),
  { runId: "R1", nested: { brace: "}" } })
assert.deepEqual(toolJson("noise\nAPP_SAMPLE_RESULT={\"batchId\":\"B001\",\"status\":\"success\"}\n"),
  { batchId: "B001", status: "success" })
assert.throws(() => toolJson("Tool result exceeded the original output limit"), /complete JSON/)
const structuredTools = [{ function: { name: "structured_output", parameters: {
  type: "object", required: ["runId", "status", "readyBatches", "batchWorkspaces"],
  additionalProperties: false, properties: {
    runId: { type: "string" }, status: { type: "string" },
    readyBatches: { type: "array", items: { type: "string" } },
    batchWorkspaces: { type: "object", additionalProperties: {
      type: "object", required: ["worktreePath"], additionalProperties: false,
      properties: { worktreePath: { type: ["string", "null"] } }
    } }
  }
} } }]
const observedScheduler = { ok: true, runId: "R1", status: "running",
  readyBatches: ["B001", "B002"],
  batchWorkspaces: { B001: { worktreePath: null, diagnostic: "not provisioned" } } }
const structured = originalWorkflowStructuredOutput(observedScheduler, structuredTools)
assert.equal(structured.name, "structured_output")
assert.deepEqual(structured.args, { runId: "R1", status: "running",
  readyBatches: ["B001", "B002"], batchWorkspaces: { B001: { worktreePath: null } } })
assert.equal(observedScheduler.ok, true, "The native command result must not be rewritten")
assert.throws(() => originalWorkflowStructuredOutput(undefined, structuredTools), /actual native command/)
assert.throws(() => originalWorkflowStructuredOutput(observedScheduler, []), /must be advertised/)
assert.throws(() => originalWorkflowStructuredOutput({ ...observedScheduler, runId: undefined }, structuredTools), /violates original Workflow schema/)
assert.throws(() => originalWorkflowStructuredOutput({ ...observedScheduler, readyBatches: '["B001"]' }, structuredTools), /violates original Workflow schema/)
assert.throws(() => originalWorkflowStructuredOutput({ ...observedScheduler,
  batchWorkspaces: { B001: {} } }, structuredTools), /violates original Workflow schema/)
assert.equal(originalWorkflowStructuredOutput({ ...observedScheduler, status: "failed" }, structuredTools)
  .args.status, "failed", "Never turn an actual failure into success")
assert.equal(originalWorkflowWorkerReply(observedScheduler, structuredTools).step?.name, "structured_output")
assert.equal(originalWorkflowWorkerReply(observedScheduler, structuredTools, true).step, undefined,
  "A recorded structured result cannot replay a business command or result tool")
assert.deepEqual(JSON.parse(originalWorkflowWorkerReply(observedScheduler, []).content), observedScheduler)
assert.equal(originalWorkflowWorkerReply(observedScheduler, []).step, undefined)
assert.equal(JSON.parse(originalWorkflowWorkerReply({ status: "failed" }, []).content).status, "failed")
assert.throws(() => originalWorkflowWorkerReply(undefined, []), /cannot return invented/)
assert.throws(() => originalWorkflowWorkerReply(observedScheduler,
  [{ function: { name: "structured_output" } }]), /must be advertised/,
"An advertised but malformed result tool must never silently fall back to ordinary text")
// Optional original HTTP evidence checks the exact public schema and untouched native stdout.
// This reads evidence only; it does not replay a command, launch an App or create a run.
if (process.env.AUTOBIZ_FULL_WORKFLOW_RESPONSE_EVIDENCE) {
  const actualRequests = JSON.parse(readFileSync(process.env.AUTOBIZ_FULL_WORKFLOW_RESPONSE_EVIDENCE, "utf8")) as Array<{
    actor: string; step?: { key: string };
    body: { tools: typeof structuredTools; messages: Array<{ role: string; content: unknown }> }
  }>
  const response = actualRequests.findLast(row => row.actor.startsWith("child-") && !row.step &&
    row.body.tools.some(tool => tool.function.name === "structured_output"))
  assert(response, "Actual original Workflow structured worker response is required")
  const native = response.body.messages.findLast(message => message.role === "tool")
  assert(native)
  const actual = toolJson(native.content)
  const call = originalWorkflowStructuredOutput(actual, response.body.tools)
  assert.equal(originalWorkflowWorkerReply(actual, response.body.tools).step?.name, "structured_output")
  assert.equal(call.args.runId, actual.runId)
  assert.equal(call.args.status, actual.status)
  assert.deepEqual(call.args.readyBatches, actual.readyBatches)
  assert.deepEqual(call.args.batchWorkspaces, actual.batchWorkspaces)
  const missingRun = { ...actual }
  delete missingRun.runId
  assert.throws(() => originalWorkflowStructuredOutput(missingRun, response.body.tools), /violates original Workflow schema/)
  console.log("PASS actual captured Workflow public schema: exact native stdout values, missing required field rejected")
}
const originalWorkflowText = originalPackage.readAsText("workflows/code-batched-execution.workflow.js")
const workflowAst = ts.createSourceFile("original.workflow.js", originalWorkflowText,
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const actualSchemaContracts = new Map<string, boolean>()
const labelPrefix = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return labelPrefix(node.left)
  return undefined
}
const visit = (node: ts.Node): void => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "workflowAgent") {
    const options = node.arguments[1]
    if (options && ts.isObjectLiteralExpression(options)) {
      const fields = options.properties.filter(ts.isPropertyAssignment)
      const label = fields.find(field => field.name.getText(workflowAst) === "label")
      const prefix = label && labelPrefix(label.initializer)
      if (prefix) actualSchemaContracts.set(prefix,
        fields.some(field => field.name.getText(workflowAst) === "schema"))
    }
  }
  ts.forEachChild(node, visit)
}
visit(workflowAst)
for (const [label, required] of [["fixed-workflow-prepare", true], ["stage-implement-", false],
  ["stage-review-", true], ["validate-review-", true], ["stage-utest-", true],
  ["provision-worktree-", true], ["fixed-batch-", true]] as const)
  assert.equal(actualSchemaContracts.get(label), required, `Actual original agent schema contract: ${label}`)
if (process.env.AUTOBIZ_FULL_WORKFLOW_CONTROL_EVIDENCE) {
  const requests = JSON.parse(readFileSync(process.env.AUTOBIZ_FULL_WORKFLOW_CONTROL_EVIDENCE, "utf8")) as Array<{
    actor: string; body: { tools: typeof structuredTools;
      messages: Array<{ role: string; content: unknown }> }
  }>
  for (const actor of ["child-48", "child-50"]) {
    const recorded = requests.findLast(row => row.actor === actor)
    assert(recorded, `Actual R24 control worker must exist: ${actor}`)
    assert(!recorded.body.tools.some(tool => tool.function.name === "structured_output"))
    const stdout = recorded.body.messages.findLast(message => message.role === "tool")
    assert(stdout, "Original recorded command stdout is required")
    const actual = toolJson(stdout.content)
    const reply = originalWorkflowWorkerReply(actual, recorded.body.tools)
    assert.equal(reply.step, undefined)
    assert.deepEqual(JSON.parse(reply.content), actual,
      "No success fields may be added to a non-schema worker's actual stdout")
  }
  console.log("PASS actual R24 non-schema controls: original JS options omit schema; real tools/stdout returned unchanged")
}
if (process.env.AUTOBIZ_FULL_WORKFLOW_REVIEW_EVIDENCE) {
  const requests = JSON.parse(readFileSync(process.env.AUTOBIZ_FULL_WORKFLOW_REVIEW_EVIDENCE, "utf8")) as Array<{
    actor: string; body: { messages: Array<{ role: string; content: unknown }> }
  }>
  for (const actor of ["child-58", "child-61"]) {
    const recorded = requests.find(row => row.actor === actor)
    assert(recorded, `Actual R25 Review worker must exist: ${actor}`)
    const prompt = modelText(recorded.body.messages.findLast(message => message.role === "user")?.content)
    const actualSource = /python -X utf8 "([^"\r\n]+)\/hooks\/query_json_fields\.py"/.exec(prompt)?.[1]
    assert(actualSource, "The actual original prompt must identify its retained plugin source")
    const reviewPlan = workflowWorkerSteps({ prompt, source: actualSource, workspace,
      feature: "app-complete", sample })
    assert.equal(reviewPlan.kind, "review")
    const last = reviewPlan.steps.at(-1)!
    assert(String(last.args.command).includes("validate-review-result"))
    assert(/--batch-id "B\d+"$/.test(String(last.args.command)),
      "Stop at the original unquoted Chinese comma; never append the stdout JSON instruction")
    assert.equal(reviewPlan.steps[1].name, "read_file", "Actual production source review must remain")
  }
  console.log("PASS actual R25 Review prompts: unquoted Chinese-comma prose excluded, original real source-read/commands retained")
}
const common = { source, workspace, feature: "app-complete", sample }
const implementation = workflowWorkerSteps({ ...common, prompt: `${prefix}在插件创建的原生 Git worktree "C:/worktree/B001" 中执行 Batch B001。Feature=app-complete，runId=R1，artifact workspace=${workspace}。` })
assert.equal(implementation.kind, "implementation")
assert.equal(implementation.steps[0].name, "execute")
assert(String(implementation.steps[0].args.command).includes("--run-id 'R1' --batch-id B001"))
const utest = workflowWorkerSteps({ ...common, prompt: `${prefix}在 Batch B002 的原生 Git worktree "C:/worktree/B002" 内完成该 Batch 的 UTest。执行 python "${source}/hooks/batch_lease_manager.py" acquire --run-id "R1"。` })
assert.equal(utest.kind, "utest")
const stage = `python -X utf8 "${source}/hooks/parallel_batch_stage.py"`
const review = workflowWorkerSteps({ ...common, prompt: `${prefix}对已草稿封存的 Batch B001 做只读评审。代码只在原生 worktree "C:/worktree/B001"，TASK 范围仅为 ["T001"]。先执行 ${stage} start --stage review。通过后执行 ${stage} complete --stage review --metadata-json '{"batchCommit":"abc"}'。发现问题时必须先执行 ${stage} fail --message "<具体问题>"。最后必须执行 ${stage} validate-review-result --run-id "R1"。` })
assert.deepEqual(review.steps.map(step => step.key), ["start-original-review", "read-real-production-source", "review-0", "review-1"])
assert.equal(review.steps[1].args.file_path, "C:/worktree/B001/cap.py")
assert(review.steps.every(step => !String(step.args.command).includes(" fail ")))
const e2e = workflowWorkerSteps({ ...common, prompt: `${prefix}在当前已合并 main 上执行唯一的 B-E2E 验证。Feature=app-complete，runId=R1。必须只在这些插件创建的临时验证 Worktree 中操作：{"default":"C:/actual-e2e"}；不得操作主 checkout。` })
assert.equal(e2e.kind, "e2e")
assert(String(e2e.steps[0].args.command).includes("--worktree 'C:/actual-e2e'"))
const original = readFileSync(resolve("output/deliveries/mods-creator-accepted-20261017/Mods来源/AutoBiz/workflows/code-batched-execution.workflow.js"), "utf8")
for (const phrase of ["在插件创建的原生 Git worktree", "完成该 Batch 的 UTest", "对已草稿封存的 Batch",
  "在当前已合并 main 上执行唯一的 B-E2E", "DISPATCH_POLL_INTERVAL_MS = 30 * 60 * 1000"])
  assert(original.includes(phrase), `Original Workflow contract changed: ${phrase}`)
for (const path of ["tests/autobiz-full-journey-packaged-e2e.spec.ts", "tests/support/autobiz-full-app-model.ts"]) {
  const result = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: path, reportDiagnostics: true
  })
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error), [])
}
execFileSync("python", ["-I", "-B", "-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read()); print('Python authorship helper syntax valid')", sample], { stdio: "inherit" })
const help = execFileSync("python", ["-I", "-B", sample, "--help"], { encoding: "utf8" })
assert(help.includes("implement") && help.includes("utest") && help.includes("e2e"))
const fixture = readFileSync("tests/autobiz-full-journey-packaged-e2e.spec.ts", "utf8")
const initialTimingAt = fixture.indexOf("const initialStageStartedAt = Date.now()")
const nativeStartAt = fixture.indexOf("const run = await page.evaluate(input => window.api.harnessBoard.startManagedRun(input)")
assert(initialTimingAt >= 0 && nativeStartAt > initialTimingAt,
  "Initial stage timing must precede native startup, never reset after startup/context preparation")
assert(fixture.includes('createNativeManagedStageWatchdog(board.workflow.nodes, "biz.prd", initialStageStartedAt,'))
assert(fixture.includes('fullAppAcceptanceMode(process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE)'))
assert(fixture.includes('acceptancePolicy.evidence(evidence.passed === true, Date.now())'))
assert(fixture.includes('setTimeout(() => void app?.close(), acceptancePolicy.overallBudgetMs)'))
assert(fixture.includes('while (Date.now() - started < acceptancePolicy.overallBudgetMs)'))
assert(fixture.includes('acceptancePolicy.observe("workflow", stageId, stageBegins.get(skill)!, Date.now())'))
assert(fixture.includes("evidence.nativeStageTimingBasis"))
assert(fixture.includes('name: "workflow", args: {\n        scriptPath: path, args: workflowLaunch.workflowArgs'))
assert(fixture.includes('hash(readFileSync(join(source,\n        "workflows/code-batched-execution.workflow.js")))'))
assert(fixture.includes('subagent_type: "Explore-autodev-spec"'))
assert(fixture.includes('name: "task"'))
assert(fixture.includes('evidence.specsTaskResult'))
assert(fixture.includes('originalWorkflowLauncherArguments({'))
assert(fixture.includes('originalWorkflowWorkerReply(outputs.get(actor), tools,'))
assert(fixture.includes('done.has("original-structured-output")'),
  "Recording a result must never replay the business command on the following model turn")
assert(fixture.includes('specsChildren.length >= 3'))
assert(!fixture.includes("subagentRunner") && !fixture.includes("runWorkflowEngine"))
console.log("PASS full App fixture preflight: original command boundaries, actual-result-only replies, original Workflow identity, TS/Python syntax; no App/business execution claimed")
