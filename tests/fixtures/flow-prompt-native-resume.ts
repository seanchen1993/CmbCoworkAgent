import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

async function child(mode: string, directory: string, baseUrl: string) {
  const owned = resolve(directory)
  assert.equal(dirname(owned), resolve(tmpdir()))
  assert(basename(owned).startsWith("cmb-prompt-native-resume-"))
  process.env.CMB_COWORK_AGENT_HOME = join(owned, "app")
  const storage = await import("../../src/main/storage")
  const db = await import("../../src/main/db")
  const { ModsManager, setModsManager } = await import("../../src/main/mods/manager")
  const { FunctionModsManager } = await import("../../src/main/mods/v2/manager")
  const { NativeFlowHost } = await import("../../src/main/mods/flows/native-host")
  const { FlowManager } = await import("../../src/main/mods/flows/manager")
  const { FlowStore, flowDigest } = await import("../../src/main/mods/flows/store")
  const runtime = await import("../../src/main/agent/runtime")
  await db.initializeDatabase()
  storage.setWindowsSandboxMode("none")
  storage.upsertCustomModelConfig({
    id: "native-prompt",
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
  setModsManager(mods)
  let threadId: string
  let sourceId = ""
  if (mode === "start") {
    threadId = randomUUID()
    db.createThread(threadId, { workspacePath: workspace })
  } else {
    const saved = JSON.parse(readFileSync(join(owned, "interrupted.json"), "utf8"))
    threadId = saved.threadId
    sourceId = saved.sourceId
  }
  const functions = new FunctionModsManager(mods.store, {
    plugins: () => [],
    enabled: (key) => mods.isEnabled(key),
    publish: (key, value, signal) => mods.publish(key, value, undefined, signal),
    changed: () => {},
    assertThread: (key, id) => {
      const metadata = JSON.parse(db.getThreadCore(id)?.metadata ?? "null")
      assert.equal(metadata?.workspacePath, key)
    }
  })
  mods.attachFunctions({
    invalidate: (key) => functions.invalidate(key),
    closeThread: (id) => functions.closeThread(id),
    close: () => functions.close()
  })
  const store = new FlowStore(mods.store)
  let deciding = false
  let approvals = 0
  let resolveFinished!: () => void
  let rejectFinished!: (reason: unknown) => void
  const finished = new Promise<void>((done, fail) => {
    resolveFinished = done
    rejectFinished = fail
  })
  const host = new NativeFlowHost(mods, functions, {
    scope: (id) => {
      const metadata = JSON.parse(db.getThreadCore(id)?.metadata ?? "null")
      assert.equal(metadata?.workspacePath, workspace)
      return workspace
    },
    changed: () => {
      const rows = store.runs(workspace, threadId)
      const latest = mode === "resume" ? rows.find((row) => row.id !== sourceId) : rows[0]
      if (!latest) return
      if (
        mode === "start" &&
        latest.attempts.some((attempt) => attempt.stepId === "write" && attempt.status === "passed")
      ) {
        const receipt = latest.attempts.find((attempt) => attempt.stepId === "write")!
        assert(receipt.recoveryEvidence)
        writeFileSync(
          join(owned, "interrupted.json"),
          JSON.stringify({ threadId, sourceId: latest.id }),
          "utf8"
        )
        console.log("PASS first native receipt committed; simulate abrupt process exit")
        process.exit(0)
      }
      if (mode === "resume" && latest.id !== sourceId && latest.pendingApproval && !deciding) {
        deciding = true
        approvals++
        void flow
          .decide(workspace, threadId, latest.id, latest.pendingApproval.nonce, true)
          .then(() => {
            deciding = false
          }, rejectFinished)
      }
      if (["failed", "cancelled"].includes(latest.status)) {
        console.error("Native flow failure", JSON.stringify(latest))
        rejectFinished(Error(`NATIVE_FLOW_${latest.status}: ${latest.summary}`))
      }
      if (mode === "resume" && latest.id !== sourceId && latest.status === "complete") {
        assert.equal(latest.attempts.filter((attempt) => attempt.stepId === "write").length, 1)
        assert(latest.attempts.find((attempt) => attempt.stepId === "write")?.reusedFrom)
        assert(
          latest.attempts.some((attempt) => attempt.stepId === "review" && attempt.recoveryEvidence)
        )
        assert(approvals >= 1)
        writeFileSync(
          join(owned, "complete.json"),
          JSON.stringify({ approvals, run: latest }),
          "utf8"
        )
        resolveFinished()
      }
    }
  })
  const flow = new FlowManager(store, host)
  const timeout = setTimeout(() => rejectFinished(Error("NATIVE_FLOW_FIXTURE_TIMEOUT")), 40000)
  try {
    if (mode === "start") {
      const definition = flow.save(
        workspace,
        {
          schemaVersion: 2,
          id: "native-flow",
          name: "Native closed prompt flow",
          execution: { kind: "host", profile: "prompt-only-v1" },
          goal: "Write and review a text answer",
          timeoutMs: 60000,
          maxExecutions: 20,
          steps: [
            {
              id: "write",
              name: "Write",
              kind: "agent",
              enabled: true,
              prompt: "FIRST_WRITE",
              modelId: "custom:native-prompt"
            },
            {
              id: "review",
              name: "Review",
              kind: "agent",
              enabled: true,
              prompt: "SECOND_REVIEW",
              modelId: "custom:native-prompt"
            },
            { id: "check", name: "Unit test", kind: "check", check: "unit-test", enabled: true },
            {
              id: "approval",
              name: "Approval",
              kind: "approval",
              enabled: true,
              prompt: "Confirm final text"
            }
          ]
        },
        0
      )
      await flow.start(workspace, threadId, definition.definition.id, definition.revision)
    } else {
      const source = store.run(workspace, threadId, sourceId)!
      assert.equal(source.status, "running")
      await flow.resume(workspace, threadId, sourceId, flowDigest(source))
    }
    await finished
    console.log("PASS resumed native FlowManager completed with fresh check and approval")
  } finally {
    clearTimeout(timeout)
    await runtime.closeRuntime()
    mods.close()
    setModsManager(undefined)
    await db.closeDatabase()
  }
}

async function main() {
  if (process.argv[2] === "--child") return child(process.argv[3], process.argv[4], process.argv[5])
  const directory = await mkdtemp(join(tmpdir(), "cmb-prompt-native-resume-"))
  await mkdir(join(directory, "workspace"))
  let writes = 0,
    reviews = 0,
    checks = 0
  const server = createServer(async (request, response) => {
    if (request.url === "/check") {
      checks++
      response.end("checked")
      return
    }
    let text = ""
    for await (const chunk of request) text += chunk.toString()
    const body = JSON.parse(text)
    assert.equal(request.headers.authorization, "Bearer test-only")
    const prompt = body.messages.find(
      (message: { role: string }) => message.role === "user"
    ).content
    if (prompt.includes("FIRST_WRITE")) writes++
    else {
      reviews++
      assert(prompt.includes("kept original summary"))
      assert(prompt.includes("SECOND_REVIEW"))
    }
    const summary = prompt.includes("FIRST_WRITE") ? "kept original summary" : "review complete"
    response.setHeader("content-type", "text/event-stream")
    for (const frame of [
      {
        id: "native",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "result",
                  type: "function",
                  function: {
                    name: "structured_output",
                    arguments: JSON.stringify({ passed: true, summary })
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      {
        id: "native",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const { port } = server.address() as { port: number }
    await writeFile(
      join(directory, "workspace/package.json"),
      JSON.stringify({
        name: "flow-check-fixture",
        private: true,
        scripts: { test: "node check.cjs" }
      })
    )
    await writeFile(
      join(directory, "workspace/check.cjs"),
      `require('http').get('http://127.0.0.1:${port}/check', r => { r.resume(); r.on('end',()=>process.exit(r.statusCode===200?0:1)) }).on('error',()=>process.exit(1))\n`
    )
    for (const mode of ["start", "resume"]) {
      const processChild = spawn(
        process.execPath,
        [process.argv[1], "--child", mode, directory, `http://127.0.0.1:${port}/v1`],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      )
      let output = ""
      processChild.stdout.on("data", (chunk) => {
        output += chunk.toString()
      })
      processChild.stderr.on("data", (chunk) => {
        output += chunk.toString()
      })
      const kill = setTimeout(() => processChild.kill(), 45000)
      const [code] = await once(processChild, "exit")
      clearTimeout(kill)
      console.log(output)
      assert.equal(code, 0, `native ${mode} child failed`)
      if (mode === "start") {
        assert.equal(writes, 1)
        assert.equal(reviews, 0)
      }
    }
    const complete = JSON.parse(await readFile(join(directory, "complete.json"), "utf8"))
    assert.equal(writes, 1)
    assert.equal(reviews, 1)
    assert(checks >= 2, `selected and final native checks must rerun; observed ${checks}`)
    assert(complete.approvals >= 1)
    console.log(
      `PASS native process restart: write=${writes}, review=${reviews}, nativeChecks=${checks}, approvals=${complete.approvals}`
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const owned = resolve(directory)
    assert.equal(dirname(owned), resolve(tmpdir()))
    assert(basename(owned).startsWith("cmb-prompt-native-resume-"))
    await rm(owned, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
