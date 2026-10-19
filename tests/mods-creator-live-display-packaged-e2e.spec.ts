/** A21: a physical native background business continues through an idle display-only switch. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { NATIVE_WORKFLOW_OBSERVER_SOURCE } from "./support/native-workflow-observer-fixture"
import { liveDisplayFiles as files } from "./support/creator-live-display-fixture"
import {
  createHeadlessProjectCompositionLaunch, projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const pathKey = Object.keys(fixture.env).find(key => key.toLowerCase() === "path") ?? "PATH"
fixture.env[pathKey] = dirname(process.execPath) + ";" + (fixture.env[pathKey] ?? "")
const stateFile = join(fixture.workspace, "a21-business-state.json")
const inputFile = join(fixture.workspace, "a21-input.txt")
const journalFile = join(fixture.workspace, "a21-business-journal.jsonl")
const outputFile = join(fixture.workspace, "a21-delivery.json")
const releaseFile = join(fixture.workspace, "a21-release")
const scriptFile = join(fixture.workspace, "a21-business.mjs")
writeFileSync(stateFile, JSON.stringify({ status: "idle" }))
writeFileSync(inputFile, "A21 original business input must remain unchanged\n")
writeFileSync(scriptFile, `import {readFileSync,writeFileSync,appendFileSync,existsSync,renameSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";import {join} from "node:path";
const root=process.argv[2],runId=randomUUID(),startedAt=Date.now(),pid=process.pid;
const input=readFileSync(join(root,"a21-input.txt")),inputSha=createHash("sha256").update(input).digest("hex");
const state={runId,pid,startedAt,status:"running",inputSha};let sequence=0;
const publish=value=>{const path=join(root,"a21-business-state.json");writeFileSync(path+".next",JSON.stringify(value));renameSync(path+".next",path)};
const record=event=>appendFileSync(join(root,"a21-business-journal.jsonl"),JSON.stringify({event,runId,pid,sequence:sequence++})+"\\n");
record("start");publish(state);
const timer=setInterval(()=>{record("heartbeat");if(!existsSync(join(root,"a21-release")))return;
clearInterval(timer);if(createHash("sha256").update(readFileSync(join(root,"a21-input.txt"))).digest("hex")!==inputSha)throw Error("INPUT_CHANGED");
writeFileSync(join(root,"a21-delivery.json"),JSON.stringify({runId,pid,inputSha,deliveries:1}));record("complete");
publish({...state,status:"completed"});console.log("A21_BUSINESS_COMPLETE "+runId);},200);
`)
const quoted = (path: string) => { assert(!path.includes("'")); return "'" + path.replaceAll("\\", "/") + "'" }
const businessCommand = `node ${quoted(scriptFile)} ${quoted(fixture.workspace)}`
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const sourceDigests = { input: digest(inputFile), script: digest(scriptFile) }
type BusinessState = { status: string; runId?: string; pid?: number; startedAt?: number; inputSha?: string }
const state = (): BusinessState => JSON.parse(readFileSync(stateFile, "utf8"))
const rows = (): Array<{ event: string; runId: string; pid: number; sequence: number }> =>
  existsSync(journalFile) ? readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row)) : []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const releaseBusiness = () => writeFileSync(releaseFile, "complete the original business once\n")
const errors: string[] = [], requests: unknown[] = [], approvals: unknown[] = []
const timeline: Array<{ event: string; at: number; value?: unknown }> = []
let app: ElectronApplication | undefined, page: Page | undefined, passed = false
let releasePatch!: () => void, patchStaged = false, executeCalls = 0, taskId = ""
const patchGate = new Promise<void>(done => { releasePatch = done })
const artifact = (name: string, value: unknown) => writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))
const record = (event: string, value?: unknown) => timeline.push({ event, at: Date.now(), value })
function companionZip() {
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "native-workflow-reader", version: "1.0.0", mods: "mods/manifest.json" })))
  zip.addFile("mods/manifest.json", Buffer.from(JSON.stringify({ apiVersion: "cmb.mods/v2", id: "native-workflow-reader", entry: "main.js" })))
  zip.addFile("mods/main.js", Buffer.from(NATIVE_WORKFLOW_OBSERVER_SOURCE))
  return [...zip.toBuffer()]
}
const contentText = (value: unknown): string => typeof value === "string" ? value :
  Array.isArray(value) ? value.map(row => contentText(row?.text)).join("\n") : ""
const server = createServer(async (request, response) => {
  let raw = ""
  try {
    assert.equal(request.url, "/v1/chat/completions")
    for await (const bytes of request) { raw += bytes; assert(raw.length < 4_000_000) }
    const body = JSON.parse(raw)
    requests.push(body); assert(requests.length <= 24)
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const last = messages.findLastIndex(row => row.role === "user")
    const prompt = contentText(messages[last]?.content)
    const results = messages.slice(last + 1).filter(row => row.role === "tool")
    let name: string | undefined, args: Record<string, unknown> = {}, text = ""
    if (prompt.includes("Create a compact continuation handoff")) {
      text = "A21: preserve the background native business, original inputs, grants and display draft; follow the current request."
    } else if (/A21_CREATE_DISPLAY|A21_PATCH_DISPLAY/.test(prompt)) {
      const patched = prompt.includes("A21_PATCH_DISPLAY")
      if (!results.length) {
        name = "mod_authoring"
        args = { action: "submit", id: "a21-display", name: "任务耗时卡", revision: patched ? 1 : 0, files: files(patched) }
      } else {
        const result = JSON.parse(contentText(results[0].content))
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.result.check.valid, true, JSON.stringify(result))
        if (patched) { record("patch-submitted-tail-blocked", result); patchStaged = true; await patchGate }
        text = patched ? "A21_PATCH_READY" : "A21_CREATE_READY"
      }
    } else if (prompt.includes("A21_START_BUSINESS")) {
      if (!results.length) {
        assert.equal(++executeCalls, 1, "The native business execute call must never replay")
        name = "execute"; args = { command: businessCommand, run_in_background: true }
      } else {
        const match = /Background task started \(id: ([^)]+)\)/.exec(JSON.stringify(results))
        assert(match, "Original execute must return an actual background task identity: " + JSON.stringify(results))
        taskId = match[1]
        text = "A21_BUSINESS_LAUNCHED"
      }
    } else if (prompt.includes("A21_FINISH_BUSINESS")) {
      assert(taskId)
      if (!results.length) { name = "task_output"; args = { task_id: taskId, block: true, timeout: 10000 } }
      else {
        assert(JSON.stringify(results).includes("A21_BUSINESS_COMPLETE"), JSON.stringify(results))
        text = "A21_ORIGINAL_BUSINESS_COMPLETED"
      }
    } else throw Error("Unexpected model prompt: " + prompt.slice(0, 200))
    if (name) assert((body.tools ?? []).some((tool: { function: { name: string } }) => tool.function.name === name), `Missing original tool: ${name}`)
    record("model-response", { name, text, prompt: prompt.slice(0, 80) })
    if (!body.stream) {
      assert(!name)
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "a21", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      })); return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `a21-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: text }
    for (const value of [{ delta, finish_reason: null }, { delta: {}, finish_reason: name ? "tool_calls" : "stop" }])
      response.write(`data: ${JSON.stringify({ id: "a21", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, ...value }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error)); artifact("rejected-model-request.json", { error: String(error), raw })
    response.writeHead(500).end("fixture rejected")
  }
})
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [])
    const value = await read(); if (test(value)) return value
    await new Promise(done => setTimeout(done, 100))
  }
  throw Error("Original A21 deadline exceeded: " + label)
}
async function main() {
  let diagnosticThreadId: string | undefined
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address(); assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => { releasePatch(); releaseBusiness(); void app?.close() }, 360_000)
  const evidence: Record<string, unknown> = { candidate, sourceDigests, limitations: [
    "Loopback controls only model choices and response timing. Original Electron UI, authoring compiler, native execute authorization/background job/process, task_output and actual business files are used.",
    "This uses the existing ordinary-local-thread creator scope; it does not claim creator support inside a Workflow-mode conversation. Actual dual-worktree execution has a separate acceptance fixture.",
    "Only the display label changes at the original idle point; no running business implementation is hot-replaced. Required Hook enforcement has separate original-runner integration evidence.",
    "The fixture responds to the exact native Sandbox approval through its existing trusted IPC; this is a test-harness response, not a claim of OS automation or human business acceptance."
  ] }
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, { unobtrusivePresentation: true })()
    for (const [name, stream] of [["stdout", app.process().stdout], ["stderr", app.process().stderr]] as const)
      stream?.on("data", bytes => appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes))
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const scope = await page.evaluate(async ({ workspace, url, bytes }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.sandbox.setYoloMode(false)
      await window.api.models.setCustomConfig({ id: "a21-loopback", name: "A21 isolated model", baseUrl: url, model: "a21-loopback", apiKey: "private-fixture", maxTokens: 64000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:a21-loopback")
      await window.api.mods.configureGlobal(true)
      const installed = await window.api.plugins.install(new Uint8Array(bytes).buffer, "a21-companion.zip", "local", undefined, true)
      if (!installed.success || !installed.pluginId) throw Error(JSON.stringify(installed))
      const thread = await window.api.threads.create({ title: "A21 live business display", workspacePath: workspace, agentMode: "normal" })
      await window.api.workspace.set(thread.thread_id, workspace)
      await window.api.mods.configure(thread.thread_id, true, true)
      const source = (await window.api.mods.status(thread.thread_id)).functionMods!.find(row => row.pluginId === installed.pluginId)!
      await window.api.mods.approveFunction(thread.thread_id, source.pluginId, source.digest!)
      const current = await window.api.mods.status(thread.thread_id)
      const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
      await window.api.mods.development.setEnabled({ ...scope, enabled: true })
      return { ...scope, companionId: installed.pluginId }
    }, { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1`, bytes: companionZip() })
    diagnosticThreadId = scope.threadId
    await page.reload()
    await page.getByText("A21 live business display", { exact: true }).first().click()
    const send = async (value: string) => {
      await page!.keyboard.press("Escape")
      await page!.locator("textarea.composer-textarea").fill(value)
      await page!.getByRole("button", { name: "发送消息", exact: true }).click()
    }
    const status = () => page!.evaluate(id => window.api.mods.development.status({ threadId: id }), scope.threadId)
    const functions = () => page!.evaluate(id => window.api.mods.status(id), scope.threadId)
    const card = page.locator('[data-function-site="AbovePrompt"] > div:not([data-function-site-cached])')
    await send("A21_CREATE_DISPLAY 制作只读任务耗时卡，读取本地业务状态文件并显示耗时，保留现有功能。")
    await until(status, value => value.trials[0]?.phase === "needs-approval", "original display confirmation")
    await page.getByRole("button", { name: "确认并应用到这段聊天", exact: true }).click()
    await until(status, value => value.trials[0]?.phase === "active", "initial display active")
    await card.getByText(/^A21 耗时卡 · /).waitFor({ timeout: 90_000 })
    const before = await functions()
    const companion = before.functionMods!.find(row => row.pluginId === scope.companionId)!
    evidence.before = before
    await send("A21_START_BUSINESS 执行已准备好的本地业务脚本，后台运行直到收到完成闸门，保留原输入。")
    await until(async () => {
      const pending = await page!.evaluate(id => window.api.sandbox.getPendingApprovals(id), scope.threadId)
      for (const row of pending) {
        const approval = row as { id: string; tool_call: { id: string; name: string; args: { command?: string } } }
        if (approvals.some(value => (value as { id: string }).id === approval.id)) continue
        assert.equal(approval.tool_call.name, "execute")
        assert.equal(approval.tool_call.args.command, businessCommand)
        approvals.push(approval)
        await page!.evaluate(approval => window.api.sandbox.sendApprovalDecision({ requestId: approval.id, type: "approve", tool_call_id: approval.tool_call.id }), approval)
      }
      return state()
    }, value => value.status === "running", "original native business physically started")
    await page.getByText("A21_BUSINESS_LAUNCHED", { exact: true }).waitFor({ timeout: 90_000 })
    const original = state(); assert(original.pid && original.runId)
    assert(alive(original.pid)); assert.equal(executeCalls, 1)
    await until(async () => rows(), values => values.filter(row => row.event === "heartbeat").length >= 2, "physical business IO before patch")
    const beforeRows = rows().length
    evidence.businessBeforePatch = { state: original, journal: rows(), taskId }
    await send("A21_PATCH_DISPLAY 只把耗时卡标题改为累计耗时卡，保留原业务、输入、权限和状态，不重新执行业务。")
    await until(async () => patchStaged, Boolean, "patch tool completed before held tail")
    const queued = await until(status, value => value.trials[0]?.phase === "queued" && value.trials[0]?.activeRevision === 1, "old active display retained")
    assert.equal(queued.trials[0].waitingReason, "turn-finishing")
    const creator = page.getByRole("region", { name: "灵件对话创作", exact: true })
    const opener = page.getByRole("button", { name: "灵件试用中", exact: true })
    if (!(await creator.isVisible()) && await opener.getAttribute("aria-expanded") === "false") await opener.click()
    await creator.waitFor({ timeout: 20_000 })
    await page.getByText("正在等待本轮制作结束，完成后会切换到新版本。", { exact: true }).waitFor()
    await card.getByText(/^A21 耗时卡 · /).waitFor()
    assert.equal(await card.getByText(/^A21 累计耗时卡 · /).count(), 0)
    const waitingAt = Date.now()
    evidence.queued = { status: queued, notice: await creator.innerText(), card: await card.innerText() }
    await page.screenshot({ path: join(fixture.isolated, "a21-safe-switch-waiting.png"), timeout: 10_000 })
    record("native-safe-switch-waiting", state())
    assert.equal(state().runId, original.runId); assert(alive(original.pid)); assert(!existsSync(outputFile))
    releasePatch()
    await until(status, value => value.trials[0]?.phase === "active" && value.trials[0]?.activeRevision === 2, "original idle switch")
    await card.getByText(/^A21 累计耗时卡 · .* · running$/).waitFor({ timeout: 90_000 })
    record("display-safe-switch-applied", { waitingMs: Date.now() - waitingAt, state: state() })
    evidence.appliedUi = await card.innerText()
    await page.screenshot({ path: join(fixture.isolated, "a21-display-applied-business-running.png"), timeout: 10_000 })
    assert.deepEqual((await functions()).functionMods!.find(row => row.pluginId === scope.companionId), companion)
    assert.deepEqual(state(), original); assert(alive(original.pid)); assert(!existsSync(outputFile)); assert.equal(executeCalls, 1)
    assert(rows().length > beforeRows, "The same original process must continue physical business IO during the edit")
    assert.equal(rows().filter(row => row.event === "start").length, 1)
    assert.deepEqual({ input: digest(inputFile), script: digest(scriptFile) }, sourceDigests)
    releaseBusiness()
    await until(async () => state(), value => value.status === "completed", "original business completes once")
    await until(async () => alive(original.pid!), value => !value, "original business PID exits")
    const output = JSON.parse(readFileSync(outputFile, "utf8"))
    assert.deepEqual(output, { runId: original.runId, pid: original.pid, inputSha: sourceDigests.input, deliveries: 1 })
    assert.equal(rows().filter(row => row.event === "complete").length, 1)
    assert(rows().every(row => row.runId === original.runId && row.pid === original.pid))
    await send("A21_FINISH_BUSINESS 核对原后台任务的真实输出，不重新启动业务。")
    await page.getByText("A21_ORIGINAL_BUSINESS_COMPLETED", { exact: true }).waitFor({ timeout: 90_000 })
    assert.equal(executeCalls, 1)
    evidence.completed = { state: state(), journal: rows(), output, outputSha: digest(outputFile), taskId }
    passed = true
  } catch (error) {
    evidence.failure = String(error)
    // Observe the original failed gate before finally releases either real business hold.
    // No mount, approval, retry, source change or deadline extension is performed here.
    if (page) {
      const observe = async (name: string, read: () => Promise<unknown>) => {
        try { return { name, value: await read() } }
        catch (cause) { return { name, error: String(cause) } }
      }
      evidence.failureDiagnostics = await Promise.all([
        observe("native-status", async () => page!.evaluate(async threadId => ({
          development: await window.api.mods.development.status({ threadId }),
          runtimes: await window.api.mods.runtimeSessions(threadId)
        }), diagnosticThreadId!)),
        observe("live-dom", async () => page!.evaluate(() => ({
          visibility: document.visibilityState,
          text: (document.body.textContent ?? "").slice(-32768),
          sites: [...document.querySelectorAll('[data-function-site="AbovePrompt"]')]
            .slice(0, 4).map(element => ({
              html: element.outerHTML.slice(0, 65536),
              rect: element.getBoundingClientRect().toJSON(),
              ancestors: (() => {
                const values: unknown[] = []
                for (let parent = element.parentElement; parent && values.length < 8;
                  parent = parent.parentElement) {
                  const style = getComputedStyle(parent)
                  values.push({ tag: parent.tagName, class: parent.className,
                    display: style.display, visibility: style.visibility,
                    overflow: style.overflow, rect: parent.getBoundingClientRect().toJSON() })
                }
                return values
              })()
            }))
        }))),
        observe("screenshot", async () => {
          const path = join(fixture.isolated, "a21-failure.png")
          await page!.screenshot({ path, timeout: 10000 })
          return path
        })
      ])
    }
    throw error
  } finally {
    clearTimeout(watchdog); releasePatch(); releaseBusiness()
    artifact("a21-evidence.json", { ...evidence, passed, timeline, executeCalls, approvals, errors })
    artifact("models.json", requests)
    await app?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    assert.deepEqual(projectCompositionCandidate(root), candidate)
    console.log(JSON.stringify({ passed, candidate, evidence: join(fixture.isolated, "a21-evidence.json") }))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
