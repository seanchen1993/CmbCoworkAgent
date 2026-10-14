import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

async function child(directory: string, baseUrl: string) {
  const owned = resolve(directory)
  assert.equal(dirname(owned), resolve(tmpdir()))
  assert(basename(owned).startsWith("cmb-evaluation-native-"))
  process.env.CMB_COWORK_AGENT_HOME = join(owned, "app")
  const storage = await import("../../src/main/storage")
  const db = await import("../../src/main/db")
  const { ModsManager, setModsManager } = await import("../../src/main/mods/manager")
  const { FunctionModsManager } = await import("../../src/main/mods/v2/manager")
  const { NativeFlowHost } = await import("../../src/main/mods/flows/native-host")
  const { FlowManager } = await import("../../src/main/mods/flows/manager")
  const { FlowStore } = await import("../../src/main/mods/flows/store")
  const { EvaluationStore } = await import("../../src/main/mods/evaluation/store")
  const { EvaluationRunner } = await import("../../src/main/mods/evaluation/runner")
  const runtime = await import("../../src/main/agent/runtime")
  await db.initializeDatabase()
  storage.setWindowsSandboxMode("none")
  storage.upsertCustomModelConfig({
    id: "evaluation-fixture",
    name: "fixture",
    model: "fixture",
    baseUrl,
    apiKey: "test-only",
    maxTokens: 32000,
    maxOutputTokens: 1024,
    temperature: 0.2,
    topP: 1,
    topK: 0
  })
  const mods = new ModsManager(
    join(owned, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const workspace = mods.workspaceKey(join(owned, "workspace"))
  mods.configure(workspace, true, false)
  storage.trustAllWorkspaceHooks(workspace)
  setModsManager(mods)
  const threadId = randomUUID()
  db.createThread(threadId, { workspacePath: workspace })
  const assertThread = (key: string, id: string) => {
    assert.equal(JSON.parse(db.getThreadCore(id)?.metadata ?? "null")?.workspacePath, key)
  }
  const functions = new FunctionModsManager(mods.store, {
    plugins: () => [],
    enabled: (key) => mods.isEnabled(key),
    publish: (key, value, signal) => mods.publish(key, value, undefined, signal),
    changed: () => {},
    assertThread
  })
  mods.attachFunctions({
    invalidate: (key) => functions.invalidate(key),
    closeThread: (id) => functions.closeThread(id),
    close: () => functions.close()
  })
  const history = new FlowStore(mods.store)
  const decisions = new Set<string>()
  let approvalFailure: unknown
  const host = new NativeFlowHost(mods, functions, {
    scope: (id) => {
      assertThread(workspace, id)
      return workspace
    },
    changed: () => {
      // A fixture-owned simulated click only; production EvaluationRunner never approves.
      for (const run of history.runs(workspace, threadId))
        if (run.pendingApproval && !decisions.has(run.pendingApproval.nonce)) {
          decisions.add(run.pendingApproval.nonce)
          void flows
            .decide(workspace, threadId, run.id, run.pendingApproval.nonce, true)
            .catch((error) => {
              approvalFailure = error
            })
        }
    }
  })
  const flows = new FlowManager(history, host)
  const store = new EvaluationStore(mods.store)
  const runner = new EvaluationRunner({
    flows,
    history,
    evidence: mods.store,
    store,
    provider: "controlled"
  })
  const scope = {
    workspace,
    threadId,
    signal: new AbortController().signal,
    assertCurrent: () => assertThread(workspace, threadId)
  }
  try {
    const create = (id: string) =>
      flows.save(
        workspace,
        {
          schemaVersion: 2,
          id,
          name: id,
          goal: "Update answer.txt and pass the fixed project test",
          execution: { kind: "host", profile: "workspace-files-v1" },
          timeoutMs: 20000,
          maxExecutions: 6,
          steps: [
            {
              id: "write",
              name: "Write",
              kind: "agent",
              enabled: true,
              prompt: id === "baseline" ? "BASELINE_WRITE" : "CANDIDATE_WRITE",
              modelId: "custom:evaluation-fixture"
            },
            { id: "check", name: "Test", kind: "check", check: "unit-test", enabled: true },
            {
              id: "approval",
              name: "Review",
              kind: "approval",
              prompt: "Fixture user confirms the virtual result",
              enabled: true
            }
          ]
        },
        0
      )
    const baseline = create("baseline"),
      candidate = create("candidate")
    const selection = (saved: typeof baseline) => ({
      id: saved.definition.id,
      revision: saved.revision,
      digest: saved.digest
    })
    const started = await runner.start(
      {
        threadId,
        expectedWorkspace: workspace,
        baseline: selection(baseline),
        candidate: selection(candidate),
        tasks: [
          {
            id: "answer-task",
            goal: "Put accepted in answer.txt. Actual npm test is the acceptance criterion."
          }
        ],
        budget: { timeoutMs: 50000, maxExecutions: 12 }
      },
      scope
    )
    await runner.wait(workspace, threadId, started.id)
    if (approvalFailure) throw approvalFailure
    const [result] = runner.list(scope)
    assert.equal(result.state, "complete", JSON.stringify(result))
    assert.equal(result.provider, "controlled")
    assert.equal(result.baseline.cases[0].result, "failed", JSON.stringify(result))
    assert.equal(result.candidate.cases[0].result, "passed", JSON.stringify(result))
    assert.equal(result.comparison.comparable, true, JSON.stringify(result))
    assert.deepEqual(result.comparison.improvements, ["answer-task"])
    assert.equal(result.comparison.canAutoApply, false)
    assert.equal(result.baseline.cases[0].modelCalls, 2)
    assert.equal(result.candidate.cases[0].modelCalls, 2)
    assert.equal(result.candidate.cases[0].inputTokens, null)
    assert(decisions.size >= 1)
    await writeFile(
      join(owned, "report.json"),
      JSON.stringify({ result, decisions: decisions.size, threadId, workspace })
    )
    console.log(
      "PASS controlled actual Native Flow evaluation; baseline fails npm, candidate passes, real receipts linked"
    )
  } finally {
    await runtime.closeRuntime()
    mods.close()
    setModsManager(undefined)
    await db.closeDatabase()
  }
}

async function main() {
  if (process.argv[2] === "--child") return child(process.argv[3], process.argv[4])
  if (process.argv[2] === "--read") {
    const directory = resolve(process.argv[3])
    assert.equal(dirname(directory), resolve(tmpdir()))
    assert(basename(directory).startsWith("cmb-evaluation-native-"))
    const prior = JSON.parse(await readFile(join(directory, "report.json"), "utf8"))
    const { ModControlStore } = await import("../../src/main/mods/control-store")
    const { EvaluationStore } = await import("../../src/main/mods/evaluation/store")
    const settings = new ModControlStore(join(directory, "control.sqlite"))
    try {
      const rows = new EvaluationStore(settings).list(prior.workspace, prior.threadId)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].state, "complete")
      assert.equal(rows[0].results.baseline[0].fact.result, "failed")
      assert.equal(rows[0].results.candidate[0].fact.result, "passed")
      assert.equal(rows[0].provider, "controlled")
      console.log(
        "PASS fresh Node process reads exact persisted evaluation without runtime startup"
      )
    } finally {
      settings.close()
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), "cmb-evaluation-native-"))
  await mkdir(join(directory, "workspace"))
  let calls = 0,
    checks = 0
  const server = createServer(async (request, response) => {
    if (request.url === "/check") {
      checks++
      response.end("checked")
      return
    }
    try {
      let text = ""
      for await (const chunk of request) text += chunk.toString()
      const body = JSON.parse(text)
      assert.equal(request.headers.authorization, "Bearer test-only")
      const prompt = body.messages.find(
        (message: { role: string }) => message.role === "user"
      ).content
      const after = body.messages.some((message: { role: string }) => message.role === "tool")
      const candidate = prompt.includes("CANDIDATE_WRITE")
      assert(candidate || prompt.includes("BASELINE_WRITE"))
      calls++
      const name = after ? "structured_output" : "virtual_write"
      const args = after
        ? { passed: true, summary: "Model claims success; only npm decides acceptance" }
        : { path: "answer.txt", content: candidate ? "accepted" : "incorrect" }
      response.setHeader("content-type", "text/event-stream")
      for (const frame of [
        {
          id: `call-${calls}`,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `tool-${calls}`,
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          id: `call-${calls}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
        },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
      ])
        response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end("data: [DONE]\n\n")
    } catch {
      response.statusCode = 500
      response.end("fixture assertion failed")
    }
  })
  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const { port } = server.address() as { port: number }
    await writeFile(
      join(directory, "workspace/package.json"),
      JSON.stringify({
        name: "evaluation-fixture",
        private: true,
        scripts: { test: "node check.cjs" }
      })
    )
    await writeFile(join(directory, "workspace/answer.txt"), "initial")
    await writeFile(
      join(directory, "workspace/check.cjs"),
      `const ok=require('fs').readFileSync('answer.txt','utf8')==='accepted';require('http').get('http://127.0.0.1:${port}/check',r=>{r.resume();r.on('end',()=>process.exit(ok?0:1))}).on('error',()=>process.exit(2))\n`
    )
    const processChild = spawn(
      process.execPath,
      [process.argv[1], "--child", directory, `http://127.0.0.1:${port}/v1`],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    )
    let output = ""
    processChild.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    processChild.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    const timer = setTimeout(() => processChild.kill(), 60000)
    const [code] = await once(processChild, "exit")
    clearTimeout(timer)
    console.log(output)
    assert.equal(code, 0)
    const readChild = spawn(process.execPath, [process.argv[1], "--read", directory], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let readOutput = ""
    readChild.stdout.on("data", (chunk) => {
      readOutput += chunk.toString()
    })
    readChild.stderr.on("data", (chunk) => {
      readOutput += chunk.toString()
    })
    const readTimer = setTimeout(() => readChild.kill(), 10000)
    const [readCode] = await once(readChild, "exit")
    clearTimeout(readTimer)
    console.log(readOutput)
    assert.equal(readCode, 0)
    assert.equal(calls, 4)
    assert(checks >= 3)
    assert.equal(await readFile(join(directory, "workspace/answer.txt"), "utf8"), "initial")
    console.log(
      `PASS controlled provider requests=${calls}, actual native npm checks=${checks}; original workspace unchanged`
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const owned = resolve(directory)
    assert.equal(dirname(owned), resolve(tmpdir()))
    assert(basename(owned).startsWith("cmb-evaluation-native-"))
    await rm(owned, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
