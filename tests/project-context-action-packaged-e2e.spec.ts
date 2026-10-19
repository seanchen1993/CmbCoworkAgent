/** Non-AutoBiz: actual packaged Guest → original Flow → model/context/check receipts. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { ClawActionDescriptor } from "../src/shared/mods/claw-actions"
import type { LocalProjectCommand, LocalProjectView } from "../src/shared/project-runtime/platform-api"
import { createProjectActionBinding } from "../src/main/harness-board/project-runtime/action-input"
import { CONTEXT_HANDOFF_PROTOCOL, wrapProjectRuntimeManifest } from "../src/shared/project-runtime"
import { hostProjectFixture } from "../src/main/harness-board/project-runtime/host-fixtures.test-helper"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1", "Choose the new real ASAR package or an explicitly labelled built preflight")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const launch = createHeadlessProjectCompositionLaunch(root, fixture, { unobtrusivePresentation: true })
const artifact = (name: string, value: unknown) => writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))
const knowledge = join(fixture.workspace, "knowledge")
mkdirSync(knowledge)
const knowledgeFile = join(knowledge, "glossary.md")
writeFileSync(knowledgeFile, "GENERIC_KB_V1: invoice requires approval")
let app: ElectronApplication | undefined, page: Page
const requests: unknown[] = [], errors: string[] = [], checks: string[] = []
let mode: "good" | "bad" = "good"
const wait = () => new Promise((done) => setTimeout(done, 100))
const evidence: Record<string, unknown> = { candidate, isolated: fixture.isolated, limitations: [
  "Loopback model chooses real tools; it does not supply Guest results or host receipts.",
  "Knowledge default references only this isolated test directory; no portability claim.",
  "Public result forgery coverage here uses a real failed check returning misleading output.passed=true; direct private custody mutation remains covered by unit regressions."
] }
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    assert(requests.length < 40)
    requests.push(body)
    const text = body.messages.map((message: { content: string | Array<{ type: string; text?: string }> | null }) =>
      typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")).join("\n")
    const stage = text.includes('"stageId":"draft"')
    let delta: Record<string, unknown> = { role: "assistant", content: "GENERIC_STAGE_COMPLETE" }
    let calls = false
    if (stage && (body.tools ?? []).length) {
      assert(text.includes("GENERIC_KB_"), "Canonical provider context must reach the actual HTTP request")
      const skillPath = /<path>([^<]+)<\/path>/.exec(text)?.[1]
      assert(skillPath, "Original explicit Skill path must reach the model")
      const readSkill = body.messages.some((message: { tool_calls?: Array<{ function?: { name?: string } }> }) =>
        message.tool_calls?.some((call) => call.function?.name === "read_file"))
      const wrote = body.messages.some((message: { tool_calls?: Array<{ function?: { name?: string } }> }) =>
        message.tool_calls?.some((call) => call.function?.name === "write_file" || call.function?.name === "edit_file"))
      const documentPath = join(fixture.workspace, "document.md")
      const readDocument = body.messages.some((message: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }) =>
        message.tool_calls?.some((call) => call.function?.name === "read_file" && JSON.parse(call.function.arguments!).file_path === documentPath))
      if (!readSkill) {
        assert(body.tools.some((tool: { function?: { name?: string } }) => tool.function?.name === "read_file"))
        calls = true
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `generic-read-${requests.length}`, type: "function", function: {
          name: "read_file", arguments: JSON.stringify({ file_path: skillPath })
        } }] }
      } else if (!wrote) {
        assert(text.includes("GENERIC_SKILL_CHAIN"), "Actual Skill read result must reach the model")
        const content = mode === "good" ? "GENERIC_GOOD_DOCUMENT\n" : "GENERIC_REJECTED_DOCUMENT\n"
        const exists = existsSync(documentPath)
        if (exists && !readDocument) {
          calls = true
          delta = { role: "assistant", tool_calls: [{ index: 0, id: `generic-document-read-${requests.length}`, type: "function", function: {
            name: "read_file", arguments: JSON.stringify({ file_path: documentPath })
          } }] }
        } else if (!exists || readFileSync(documentPath, "utf8") !== content) {
          const name = exists ? "edit_file" : "write_file"
          assert(body.tools.some((tool: { function?: { name?: string } }) => tool.function?.name === name))
          calls = true
          delta = { role: "assistant", tool_calls: [{ index: 0, id: `generic-write-${requests.length}`, type: "function", function: {
            name, arguments: JSON.stringify(exists ? { file_path: documentPath, old_string: readFileSync(documentPath, "utf8"), new_string: content } : { file_path: documentPath, content })
          } }] }
        }
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const packet = (delta: unknown, finish_reason: unknown) => ({ id: `generic-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] })
    response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
    response.write(`data: ${JSON.stringify({ ...packet({}, calls ? "tool_calls" : "stop"), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Generic fixture assertion failed")
  }
})
const install = async (zip: AdmZip) => {
  const result = await page.evaluate((bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "generic-fixture.zip", "local"), [...zip.toBuffer()])
  assert(result.success, result.error)
}
const command = (id: string, command: LocalProjectCommand) => page.evaluate(({ id, command }) => window.api.harnessBoard.localProjects.command(id, command), { id, command })
function provider() {
  const zip = new AdmZip()
  const object = { type: "object", additionalProperties: true }
  const inputSchema = { type: "object", required: ["content"], properties: { content: { type: "string" } }, additionalProperties: false }
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "generic-evidence-provider", version: "1.0.0", mods: "mods/manifest.json", claw: { actions: [
    { id: "context", name: "Load actual document vocabulary", command: "generic-context", inputSchema: object },
    { id: "check", name: "Check actual document bytes", platform: { id: "document-checks", version: "1.0.0", action: "verify" }, inputSchema, outputSchema: object }
  ] } })))
  zip.addFile("mods/manifest.json", Buffer.from(JSON.stringify({ apiVersion: "cmb.mods/v2", id: "generic-evidence-provider", entry: "register.ts" })))
  zip.addFile("mods/register.ts", Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"generic-context",description:"Read vocabulary",immediate:true});return next(e)});
    on("command.run",{command:"generic-context"},async($)=>{const text=await $.fs.read("knowledge/glossary.md");if(text.includes("PROVIDER_FAIL"))throw Error("GENERIC_PROVIDER_FAILED");return{text:"Canonical vocabulary: "+text}});
    on.capability({apiVersion:"devclaw.capability/v1",id:"document-checks",version:"1.0.0",title:"Document validation",scope:"conversation",stateSchema:{type:"object"},actions:[{id:"verify",title:"Verify document",inputSchema:${JSON.stringify(object)},outputSchema:${JSON.stringify(object)},requiredPermissions:[],cancellable:true,idempotency:"keyed"}]},{act:async($,e)=>{const content=e.input.input.content;const passed=content.includes("GENERIC_GOOD_DOCUMENT");return{status:passed?"succeeded":"failed",text:passed?"GENERIC_CHECK_PASSED":"GENERIC_CHECK_REJECTED",output:{passed:true,actualContent:content,checkRejected:!passed}}}})
  }`))
  return zip
}
function project(context: ClawActionDescriptor, check: ClawActionDescriptor) {
  const zip = new AdmZip()
  const schema = {
    audience: { type: "string", title: "Audience", description: "Original native configuration", required: true },
    knowledge: { type: "directory", title: "Vocabulary", description: "Fixture-only read binding", default: knowledge }
  }
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "generic-document-project", version: "1.0.0", skills: "skills", mods: "mods/manifest.json" })))
  zip.addFile("mods/manifest.json", Buffer.from(JSON.stringify({ apiVersion: "cmb.mods/v2", id: "generic-project-observer", entry: "register.ts", userConfig: schema })))
  zip.addFile("mods/register.ts", Buffer.from('export function register(on,options){if(!options.audience)throw Error("MISSING_NATIVE_AUDIENCE")}'))
  const manifest = hostProjectFixture(fixture.workspace).manifest
  manifest.plugin = { id: "generic-document-project", version: "1.0.0" }
  manifest.stages = [{ ...manifest.stages[0], approval: "human", checkIds: ["document-exists", "document-check"] }]
  manifest.checks.push({ id: "document-check", artifactId: "document", kind: "action", actionId: "check-document", sideEffect: "read" })
  const bindings = [createProjectActionBinding("session-vocabulary", context, {}), createProjectActionBinding("check-document", check, {}, {}, { kind: "artifact", artifactId: "document", pointer: "", format: "text" })]
  manifest.actions = bindings.map((item) => ({ id: item.id, ref: item.ref }))
  zip.addFile("devclaw.project-actions.lock.json", Buffer.from(JSON.stringify({ apiVersion: "devclaw.project-actions-lock/v1", bindings })))
  zip.addFile("devclaw.project-runtime.json", Buffer.from(JSON.stringify(wrapProjectRuntimeManifest(manifest, {
    apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL], context: {
      sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved", knowledge: { required: true, binding: "knowledge" },
      provider: { actionId: "session-vocabulary", operations: ["session-context"] }
    }
  }))))
  zip.addFile("skills/draft/SKILL.md", Buffer.from("---\nname: generic-document-draft\n---\nGENERIC_SKILL_CHAIN. Use the provided vocabulary and write document.md with the native write_file tool. Do not invoke check actions; the host owns validation.\n"))
  return zip
}
async function create(name: string, installedPluginId: string) {
  let view = await page.evaluate((input) => window.api.harnessBoard.localProjects.create(input), { name, installedPluginId, workspace: fixture.workspace, goal: "Create a document using actual vocabulary and host validation." })
  const review = await page.evaluate((id) => window.api.harnessBoard.localProjects.mods.read(id), view.project.projectId)
  assert(review.source)
  const config = await page.evaluate(({ id, sourceId }) => window.api.harnessBoard.localProjects.mods.config.userConfig(id, sourceId), { id: view.project.projectId, sourceId: installedPluginId })
  if (!config.fields.find((field) => field.key === "audience")?.value)
    await page.evaluate(({ id, config }) => window.api.harnessBoard.localProjects.mods.config.saveUserConfig(id, config, "audience", "native-audience"), { id: view.project.projectId, config })
  const ready = await page.evaluate((input) => window.api.harnessBoard.localProjects.mods.approve(input), {
    projectId: view.project.projectId, projectVersion: view.project.version, packageDigest: view.project.pluginDigest, compiledDigest: review.source.digest
  })
  assert.equal(ready.source?.state, "ready")
  view = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), view.project.projectId)
  return view
}
async function prepare(view: LocalProjectView) {
  view = await command(view.project.projectId, { kind: "prepare", expectedVersion: view.project.version, idempotencyKey: randomUUID() })
  const operation = view.operations[0]
  return command(view.project.projectId, { kind: "approve", operationId: operation.operationId, expectedVersion: view.project.version, inputFingerprint: operation.inputFingerprint, decision: "approved" })
}
async function execute(view: LocalProjectView) {
  const id = view.project.projectId, operationId = view.operations[0].operationId
  let done = false, value: LocalProjectView | undefined, failure: unknown
  void command(id, { kind: "start", operationId }).then((result) => { value = result; done = true }, (error) => { failure = error; done = true })
  const approved = new Set<string>()
  const end = Date.now() + 120000
  while (!done && Date.now() < end) {
    const current = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), id)
    const thread = current.operations.find((operation) => operation.operationId === operationId)?.execution?.threadId
    if (thread) {
      const pending = await page.evaluate((id) => window.api.sandbox.getPendingApprovals(id), thread)
      for (const entry of pending) {
        const approval = entry as { id: string; operation: string; filePath: string; tool_call: { id: string } }
        if (approved.has(approval.id)) continue
        assert(["write_file", "edit_file"].includes(approval.operation))
        assert.equal(resolve(approval.filePath), resolve(fixture.workspace, "document.md"))
        assert(approval.tool_call.id)
        await page.evaluate((entry) => window.api.sandbox.sendApprovalDecision({ requestId: entry.id, type: "approve", tool_call_id: entry.tool_call.id }), approval)
        approved.add(approval.id)
      }
    }
    await wait()
  }
  assert(done, "Original project run did not physically settle")
  if (failure) throw failure
  return value!
}
function originalFacts(view: LocalProjectView) {
  const threadId = view.operations[0].execution!.threadId
  const db = new DatabaseSync(join(fixture.env.CMB_COWORK_AGENT_HOME, "mods-control.sqlite"), { readOnly: true })
  try {
    const rows = db.prepare("SELECT key,value FROM mods_meta").all()
    const row = rows.find((row) => {
      try { const key = JSON.parse(String(row.key)); return key[0] === "diy-flow-v1" && key[1] === "runs" && key[3] === threadId } catch { return false }
    })
    assert(row, "Actual original Flow attempts must be durable")
    const runs = JSON.parse(String(row.value))
    const facts = runs.flatMap((run: { attempts: Array<{ __nativeActionFacts?: Record<string, unknown> }> }) => run.attempts.flatMap((attempt) => attempt.__nativeActionFacts ? [attempt.__nativeActionFacts] : []))
    assert(facts.every((fact: { threadId: string }) => fact.threadId === threadId))
    return { runs, facts }
  } finally { db.close() }
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address === "object")
  try {
    app = await launch()
    evidence.application = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), executable: process.execPath }))
    assert.equal((evidence.application as { packaged: boolean }).packaged, Boolean(process.env.COMPOSITION_E2E_PACKAGED_DIR))
    for (const [name, stream] of [["stdout", app.process().stdout], ["stderr", app.process().stderr]] as const)
      stream?.on("data", (bytes) => appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes))
    page = await app.firstWindow({ timeout: 60000 })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects))
    await page.evaluate(() => { (window as unknown as { __name: unknown }).__name = (value: unknown) => value })
    await page.evaluate(async (url) => {
      await window.api.models.setCustomConfig({ id: "generic-evidence", name: "Generic evidence loopback", baseUrl: url, model: "generic-evidence", apiKey: "isolated-loopback", maxTokens: 64000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:generic-evidence")
      await window.api.mods.configureGlobal(true)
    }, `http://127.0.0.1:${address.port}/v1`)
    await install(provider())
    const setup = await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({ title: "Generic provider consent", workspacePath: workspace, agentMode: "normal" })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      await window.api.mods.configure(id, true, true)
      const source = (await window.api.mods.status(id)).functionMods!.find((mod) => mod.name === "generic-evidence-provider")!
      await window.api.mods.approveFunction(id, source.pluginId, source.digest!)
      return { id, actions: (await window.api.mods.flowCatalog(id)).actions! }
    }, fixture.workspace)
    const context = setup.actions.find((action) => action.actionId === "context")!, check = setup.actions.find((action) => action.actionId === "check")!
    assert(context && check)
    await install(project(context, check))
    const templates = await page.evaluate(() => window.api.harnessBoard.localProjects.templates())
    const template = templates.find((template) => template.name === "generic-document-project")!
    assert(template && !template.unavailableReason, JSON.stringify(templates))
    let view = await create("Generic context/check", template.installedPluginId)
    evidence.created = view
    checks.push("Required config did not prevent creation; native config and exact source consent applied")
    for (const kind of ["configuration", "knowledge", "rules"]) {
      view = await prepare(view)
      const count = requests.length
      if (kind === "configuration") {
        const config = await page.evaluate(({ id, pluginId }) => window.api.harnessBoard.localProjects.mods.config.userConfig(id, pluginId), { id: view.project.projectId, pluginId: template.installedPluginId })
        await page.evaluate(({ id, config }) => window.api.harnessBoard.localProjects.mods.config.saveUserConfig(id, config, "audience", "native-audience-revised"), { id: view.project.projectId, config })
      } else if (kind === "knowledge") writeFileSync(knowledgeFile, "GENERIC_KB_V2: invoice approval is required")
      else await page.evaluate(async (id) => {
        const policy = await window.api.mods.completionPolicy(id, "generic-evidence-provider")
        await window.api.mods.setCompletionPolicy(id, "generic-evidence-provider", { ...policy.policy, timeoutMs: policy.policy.timeoutMs + 1000 })
      }, setup.id)
      await assert.rejects(() => command(view.project.projectId, { kind: "start", operationId: view.operations[0].operationId }))
      assert.equal(requests.length, count)
      evidence[`stale-${kind}`] = view.operations[0]
      view = await command(view.project.projectId, { kind: "cancel", operationId: view.operations[0].operationId })
      checks.push(`Original ${kind} change rejected stale approval before model entry`)
    }
    mode = "bad"
    view = await execute(await prepare(view))
    assert.equal(view.operations[0].status, "failed", JSON.stringify(view))
    assert(!view.operations[0].receipts.some((receipt) => receipt.checkId === "document-check" && receipt.result === "passed"))
    const rejected = originalFacts(view)
    assert(rejected.facts.some((fact: { stepId: string; passed: boolean; output?: { passed?: boolean } }) => fact.stepId === "check-document" && fact.passed === false && fact.output?.passed === true))
    evidence.rejectedCheck = rejected
    checks.push("Actual failed Guest platform check cannot pass using misleading output.passed=true")
    mode = "good"
    view = await execute(await prepare(view))
    assert.equal(view.operations[0].status, "succeeded", JSON.stringify(view))
    assert(view.operations[0].receipts.some((receipt) => receipt.checkId === "document-check" && receipt.result === "passed" && receipt.validatorVersion.startsWith("host-action/v1:")))
    const actual = originalFacts(view)
    assert(actual.facts.some((fact: { stepId: string; contextText?: string }) => fact.stepId === "session-vocabulary" && fact.contextText?.includes("GENERIC_KB_V2")))
    assert(actual.facts.some((fact: { stepId: string; passed: boolean; output?: { actualContent?: string } }) => fact.stepId === "check-document" && fact.passed && fact.output?.actualContent === readFileSync(join(fixture.workspace, "document.md"), "utf8")))
    evidence.actual = actual
    evidence.success = view
    view = await command(view.project.projectId, { kind: "advance", operationId: view.operations[0].operationId })
    assert.equal(view.project.status, "completed")
    checks.push("Actual context/check Flow private facts and host receipt completed original project")
    let stale = await create("Generic receipt invalidation", template.installedPluginId)
    stale = await execute(await prepare(stale))
    assert.equal(stale.operations[0].status, "succeeded")
    writeFileSync(knowledgeFile, "GENERIC_KB_V3: changed after receipt")
    await assert.rejects(() => command(stale.project.projectId, { kind: "advance", operationId: stale.operations[0].operationId }))
    checks.push("Knowledge byte changes also reject an already-issued receipt at transition")
    // The original workspace owner remains held until the user explicitly releases this result.
    stale = await command(stale.project.projectId, { kind: "cancel", operationId: stale.operations[0].operationId })
    assert.equal(stale.operations[0].status, "cancelled")
    writeFileSync(knowledgeFile, "GENERIC_KB_PROVIDER_FAIL")
    let failed = await create("Generic provider failure", template.installedPluginId)
    failed = await prepare(failed)
    const before = requests.length
    failed = await execute(failed)
    assert.equal(failed.operations[0].status, "unknown")
    assert.equal(requests.length, before, "Required provider failure must not enter model")
    assert.equal(failed.project.version, 1)
    assert.equal(failed.operations[0].receipts.length, 0)
    evidence.requiredProviderFailure = failed
    checks.push("Required provider failure retained unknown ownership without model or stage progress")
    assert.deepEqual(errors, [])
    evidence.checks = checks
    evidence.requests = requests
    evidence.complete = true
    console.log("PASS " + checks.join("\nPASS "))
  } finally {
    artifact("evidence.json", { ...evidence, checks, errors, requests })
    if (app) await app.close()
    await new Promise<void>((done) => server.close(() => done()))
    assert.equal(createHash("sha256").update(readFileSync(candidate.path)).digest("hex"), candidate.sha256)
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
