/** Real packaged model → original workflow/subagents/worktrees → installed Guest public API. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { WorkflowRunObservation } from "../src/main/agent/workflow/observation"
import { NATIVE_WORKFLOW_OBSERVER_SOURCE } from "./support/native-workflow-observer-fixture"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const checks: string[] = [], errors: string[] = [], requests: unknown[] = []
const results = new Map<string, Record<string, unknown>>()
let app: ElectronApplication | undefined, page: Page, childRequests = 0
let failedNativeRun: unknown
let releaseChildren!: () => void, bothChildrenStarted!: () => void
const finishChildren = new Promise<void>((done) => { releaseChildren = done })
const childrenStarted = new Promise<void>((done) => { bothChildrenStarted = done })
const workflowScript = `export const meta={name:"native-public-api",description:"Two real isolated agents"}
return await Promise.all([0,1].map(i=>agent("WF_NATIVE_CHILD_TASK_"+i,{label:"native-child-"+i,isolation:"worktree"})))`
const artifact = (name: string, value: unknown) =>
  writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))
const delay = () => new Promise((done) => setTimeout(done, 100))
const text = (value: unknown): string => typeof value === "string" ? value :
  Array.isArray(value) ? value.map((entry) => text(entry?.text)).join("\n") : ""
function findResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try { return findResult(JSON.parse(value)) } catch { return undefined }
  }
  if (!value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  if (typeof row.fixture === "string" && row.fixture.startsWith("WF_OBSERVER_")) return row
  for (const nested of Object.values(row)) {
    const result = findResult(nested)
    if (result) return result
  }
  return undefined
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert(requests.length < 30)
    requests.push(body)
    const messages = body.messages as Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>
    const user = text(messages.findLast((message) => message.role === "user")?.content)
    let delta: Record<string, unknown> = { role: "assistant", content: "WF_NATIVE_DONE" }, calls = false
    if (/^WF_NATIVE_CHILD_TASK_[01]$/.test(user.trim())) {
      if (++childRequests === 2) bothChildrenStarted()
      await finishChildren
      delta.content = `Completed ${user.trim()} without changing the checkout`
    } else {
      for (const message of messages.filter((message) => message.role === "tool")) {
        const result = findResult(message.content)
        if (result) results.set(String(result.fixture), result)
      }
      const stage = /WF_PARENT_(LAUNCH|TERMINAL|ISOLATION)/.exec(user)?.[1]
      const toolCalls = messages.filter((message) => message.role === "assistant")
        .flatMap((message) => message.tool_calls ?? [])
      const lastUser = messages.findLastIndex((message) => message.role === "user")
      const currentCalls = messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? [])
      const observationCalled = currentCalls.some((call) => call.function.name.endsWith("__observe"))
      let name: string | undefined, args: Record<string, unknown> = {}
      if (stage === "LAUNCH" && !toolCalls.some((call) => call.function.name === "workflow")) {
        name = "workflow"
        args = { script: workflowScript, tokenBudget: 10000 }
      } else if (stage && !observationCalled) {
        if (stage === "LAUNCH") await childrenStarted
        name = "mcp__native_workflow_reader__observe"
        args = { stage: stage === "LAUNCH" ? "LIVE" : stage }
        const live = results.get("WF_OBSERVER_LIVE")
        if (stage !== "LAUNCH") {
          assert(live)
          args.subscriptionId = (live.subscription as { subscriptionId: string }).subscriptionId
          args.afterRevision = (live.subscription as { revision: number }).revision
          args.runId = (live.state as { value: { run: { runId: string } } }).value.run.runId
        }
      }
      if (name) {
        assert((body.tools ?? []).some((tool: { function: { name: string } }) => tool.function.name === name), `Real model tool missing: ${name}`)
        calls = true
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `native-call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const packet = (delta: unknown, finish_reason: string | null) => ({ id: `native-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
    response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
    response.write(`data: ${JSON.stringify({ ...packet({}, calls ? "tool_calls" : "stop"), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Native workflow fixture rejected")
  }
})

function plugin() {
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "native_workflow_reader", version: "1.0.0", mods: "mods/manifest.json" })))
  zip.addFile("mods/manifest.json", Buffer.from(JSON.stringify({ apiVersion: "cmb.mods/v2", id: "native_workflow_reader", entry: "main.ts" })))
  zip.addFile("mods/main.ts", Buffer.from(NATIVE_WORKFLOW_OBSERVER_SOURCE))
  return [...zip.toBuffer()]
}

async function send(threadId: string, stage: string) {
  await page.evaluate(({ threadId, stage }) => {
    const host = window as unknown as { workflowFixture: { done: boolean; events: unknown[]; error?: string } }
    host.workflowFixture = { done: false, events: [] }
    window.api.agent.invoke(threadId, `WF_PARENT_${stage}`, (event) => {
      host.workflowFixture.events.push(event)
      if (event.type === "error") host.workflowFixture.error = JSON.stringify(event)
      if (event.type === "done" || event.type === "error") host.workflowFixture.done = true
    }, "custom:native-workflow-loopback", "workflow")
  }, { threadId, stage })
  const deadline = Date.now() + 120000, approvals = new Set<string>()
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => (window as unknown as { workflowFixture: { done: boolean; events: unknown[]; error?: string } }).workflowFixture)
    if (state.done) {
      artifact(`stream-${stage}.json`, state)
      assert(!state.error, state.error)
      return
    }
    const pending = await page.evaluate((id) => window.api.sandbox.getPendingApprovals(id), threadId)
    for (const row of pending) {
      const approval = row as { id: string; tool_call: { id: string; name: string; args: { scriptPreview?: string } } }
      if (approvals.has(approval.id)) continue
      assert.equal(approval.tool_call.name, "workflow", JSON.stringify(approval))
      assert.equal(approval.tool_call.args.scriptPreview, workflowScript)
      await page.evaluate((row) => window.api.sandbox.sendApprovalDecision({ requestId: row.id, type: "approve", tool_call_id: row.tool_call.id }), approval)
      approvals.add(approval.id)
    }
    if (stage === "LAUNCH" && approvals.size) {
      const actual = await page.evaluate(async (id) => {
        const page = await window.api.workflows.listRuns(id, { limit: 1 })
        const summary = page.runs[0] as { runId: string } | undefined
        return summary ? window.api.workflows.getRun(id, summary.runId) : null
      }, threadId) as {
        status: string
        agents: Array<{ index: number; status: string; error?: string }>
        error?: string
      } | null
      if (actual && actual.status !== "running" && (
        actual.status !== "completed" || actual.agents.some((agent) => agent.status === "error")
      )) {
        failedNativeRun = actual
        artifact("native-run-failure.json", actual)
        throw Error(`Original workflow failed before both child models: ${JSON.stringify({
          status: actual.status, error: actual.error, agents: actual.agents
        })}`)
      }
    }
    await delay()
  }
  throw Error(`Original native turn timed out: ${stage}`)
}

async function main() {
  const git = (...args: string[]) => execFileSync("git", ["-C", fixture.workspace, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "--initial-branch=main")
  git("config", "user.name", "Native Workflow E2E")
  git("config", "user.email", "native@example.test")
  git("config", "core.autocrlf", "false")
  writeFileSync(join(fixture.workspace, "README.md"), "clean checkout\n")
  git("add", "README.md")
  git("commit", "-m", "fixture base")
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address === "object")
  const evidence: Record<string, unknown> = { candidate, isolated: fixture.isolated, limitations: ["Loopback controls only model text and response timing; no engine, runtime, provider, Guest or stored result is substituted.", "Natural completion and cleanup are covered here; cancellation has a separate original-engine physical-settlement integration regression."] }
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    evidence.application = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), executable: process.execPath }))
    assert.equal((evidence.application as { packaged: boolean }).packaged, Boolean(process.env.COMPOSITION_E2E_PACKAGED_DIR))
    for (const [name, stream] of [["stdout", app.process().stdout], ["stderr", app.process().stderr]] as const)
      stream?.on("data", (bytes) => appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes))
    page = await app.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.mods?.status))
    await page.evaluate(() => { (window as unknown as { __name: unknown }).__name = (value: unknown) => value })
    const ids = await page.evaluate(async ({ workspace, url, bytes }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.sandbox.setYoloMode(false)
      await window.api.models.setCustomConfig({ id: "native-workflow-loopback", name: "Native workflow evidence", baseUrl: url, model: "native-workflow-loopback", apiKey: "isolated-fixture", maxTokens: 64000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:native-workflow-loopback")
      await window.api.mods.configureGlobal(true)
      const installed = await window.api.plugins.install(new Uint8Array(bytes).buffer, "native-workflow-reader.zip", "local", undefined, true)
      if (!installed.success || !installed.pluginId) throw Error(JSON.stringify(installed))
      await window.api.plugins.setEnabled(installed.pluginId, true)
      const ids: string[] = []
      for (const title of ["Native workflow owner", "Native workflow isolation"]) {
        const thread = await window.api.threads.create({ title, workspacePath: workspace, agentMode: "workflow" })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configure(thread.thread_id, true, true)
        const source = (await window.api.mods.status(thread.thread_id)).functionMods!.find((row) => row.pluginId === installed.pluginId)!
        await window.api.mods.approveFunction(thread.thread_id, source.pluginId, source.digest!)
        ids.push(thread.thread_id)
      }
      return ids
    }, { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1`, bytes: plugin() })
    await send(ids[0], "LAUNCH")
    const live = results.get("WF_OBSERVER_LIVE")!
    assert(live, "Actual Guest tool result must reach the real model")
    const catalog = live.capabilities as { status: string; capabilities: Array<{ ref: { provider: string; id: string; version: string }; available: boolean }> }
    assert.equal(catalog.status, "ready")
    assert(catalog.capabilities.some((entry) => entry.available && entry.ref.provider === "native.workflow" && entry.ref.id === "runs" && entry.ref.version === "1.0.0"))
    assert(!JSON.stringify(live).includes("promptPreview"))
    assert(!JSON.stringify(live).includes('"journal"'))
    const observed = (live.state as { status: string; value: { activeRunId: string; run: WorkflowRunObservation } })
    assert.equal(observed.status, "ready")
    assert.equal(observed.value.activeRunId, observed.value.run.runId)
    assert.equal(childRequests, 2)
    assert.equal(observed.value.run.agents.length, 2)
    assert.equal(observed.value.run.worktrees.length, 2)
    assert.deepEqual(observed.value.run.worktrees.map((row) => row.agentIndex).sort(), observed.value.run.agents.map((row) => row.index).sort())
    for (const worktree of observed.value.run.worktrees) {
      assert(existsSync(join(worktree.directory, ".git")))
      assert.equal(readFileSync(join(worktree.directory, "README.md"), "utf8"), "clean checkout\n")
    }
    const pages = live.pages as Array<{ status: string; value: { found: boolean; run: WorkflowRunObservation } }>
    assert(pages.every((row) => row.status === "succeeded" && row.value.found))
    assert(pages.every((row) => Array.isArray(row.value.run.agents) &&
      Array.isArray(row.value.run.worktrees)),
    `Public inspect must preserve complete pagination rows: ${JSON.stringify(pages)}`)
    assert.deepEqual(pages.flatMap((row) => row.value.run.agents.map((agent) => agent.index)).sort(), observed.value.run.agents.map((agent) => agent.index).sort())
    assert.deepEqual(pages.flatMap((row) => row.value.run.worktrees.map((tree) => tree.agentIndex)).sort(), observed.value.run.worktrees.map((tree) => tree.agentIndex).sort())
    assert.equal(pages[0].value.run.nextAgentOffset, 1)
    assert.equal(pages[1].value.run.nextAgentOffset, null)
    assert.equal(pages[0].value.run.hasMore, true)
    assert.equal(pages[1].value.run.hasMore, false)
    checks.push("Original workflow tool approval and two real subagent HTTP runtimes provision two Git worktrees")
    checks.push("Installed Guest list/read/act inspect paginates actual native run/agentIndex/worktree associations")
    await send(ids[1], "ISOLATION")
    const isolated = results.get("WF_OBSERVER_ISOLATION")!
    assert.equal((isolated.state as { value: { run: unknown } }).value.run, null)
    assert.equal((isolated.foreign as { value: { found: boolean } }).value.found, false)
    assert.equal(isolated.rejection, "MODS_PLATFORM_SUBSCRIPTION_EXPIRED")
    checks.push("Same-workspace second conversation cannot read the first conversation's run or poll its subscription")
    releaseChildren()
    const end = Date.now() + 90000
    let original: { status: string } | undefined
    while (Date.now() < end) {
      original = await page.evaluate(({ thread, run }) => window.api.workflows.getRun(thread, run), { thread: ids[0], run: observed.value.run.runId }) as typeof original
      if (original?.status === "completed") break
      await delay()
    }
    assert.equal(original?.status, "completed")
    evidence.original = original
    await send(ids[0], "TERMINAL")
    const terminal = results.get("WF_OBSERVER_TERMINAL")!
    const finalState = (terminal.state as { value: { activeRunId: string | null; run: WorkflowRunObservation } }).value
    assert.equal(finalState.activeRunId, null)
    assert.equal(finalState.run.status, "completed")
    // The original ledger deletes clean checkout records on physical removal.
    assert.equal(finalState.run.worktrees.length, 0)
    for (const tree of observed.value.run.worktrees) {
      assert(!existsSync(tree.directory), "Clean worktree must be physically removed before final observation")
    }
    const poll = terminal.events as { resync: boolean; events: Array<{ value: { activeRunId: unknown; run?: { status: string } } }> }
    assert.equal(poll.resync, false, "The bounded fixture must consume events since its actual subscribed revision")
    const events = poll.events
    assert(events.some((event) => event.value.activeRunId === null && event.value.run?.status === "completed"), "Subscriber must receive final observation after lifecycle cleanup")
    assert.equal(terminal.releasedReason, "MODS_PLATFORM_SUBSCRIPTION_EXPIRED")
    assert.equal(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1)
    checks.push("Native completion physically removes both clean worktrees before terminal subscription observation")
    checks.push("Public unsubscribe releases the subscription and subsequent poll is rejected")
    assert.deepEqual(errors, [])
    evidence.passed = true
  } catch (error) {
    evidence.failure = String(error)
    throw error
  } finally {
    releaseChildren()
    Object.assign(evidence, {
      checks, errors, childRequests, results: Object.fromEntries(results), failedNativeRun
    })
    artifact("evidence.json", evidence)
    artifact("models.json", requests)
    await app?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    console.log(JSON.stringify({ candidate, evidence: join(fixture.isolated, "evidence.json"), checks }))
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
