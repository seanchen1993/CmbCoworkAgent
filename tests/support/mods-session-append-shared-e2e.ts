import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { FUNCTION_HOST_REVISION } from "../../src/shared/mods/v2/contracts"
import { openModsResults } from "./mods-sidebar-navigation"

interface ModelRequest {
  messages: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function: { name: string } }>
}
interface SharedState {
  main?: { uuid: string }
  children: Array<{ id: string; slot: number; uuid: string; agents: Array<{
    id: string; type: string; status: string; description: string
  }> }>
  reads: Array<{ id: string; api: unknown; summary: unknown }>
  agents: Array<{ id: string; type: string; status: string; description: string }>
  errors: Array<{ code?: string; message: string }>
  buttons: number
  phases: Array<{ phase: string; slot: number; index: number; at: number }>
}

/** Actual native task graphs, two equal labels, SDK target selectors, HTTP and app SQLite. */
export async function verifySessionAppendShared(
  page: Page,
  workspace: string,
  databasePath: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication,
  observeLifecycle = true
): Promise<void> {
  const project = join(workspace, "session-append-shared-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "actual-task.txt"), "ACTUAL_SHARED_TASK_READ")
  const caption = "SHARED_APPEND_SAME_LABEL Inspect the current directory once and report."
  const mainNote = "SHARED_APPEND_DEFAULT_MAIN_NOTE"
  const firstUser = "SHARED_APPEND_RUN_FIRST"
  const laterUser = "SHARED_APPEND_PARENT_STILL_WORKS"
  const requests: Array<{ path: string; body: ModelRequest }> = []
  const labels: string[] = []
  const evidence: Record<string, unknown> = { revision: FUNCTION_HOST_REVISION,
    scope: "Actual known native shared task graphs and main/child SDK notes; no claim about opaque agents, fork recovery or all native producer doors",
    requests, labels, complete: false }
  const record = (label: string) => { labels.push(label); pass(label) }
  const childCounts = new Map<string, number>()
  const held = new Map<string, { response: ServerResponse; index: number }>()
  const finish = (response: ServerResponse, index: number, delta: unknown, reason: string) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    const id = `shared-append-response-${index}`
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
      model: "gpt-4", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
      model: "gpt-4", choices: [], usage: { prompt_tokens: 20, completion_tokens: 4,
        total_tokens: 24 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest
      assert(Array.isArray(body.messages))
      const path = request.url ?? "", index = requests.push({ path, body })
      if (path.startsWith("/child-")) {
        const count = (childCounts.get(path) ?? 0) + 1
        childCounts.set(path, count)
        assert(count <= 2, "A child model must not replay its native task/tool")
        if (count === 1) {
          held.set(path, { response, index })
          // Both real child authorities must remain live while their first HTTP calls overlap.
          if (held.size === 2) for (const [child, value] of held) finish(value.response, value.index,
            { role: "assistant", tool_calls: [{ index: 0, id: `ls-${child.split("/")[1]}`,
              type: "function", function: { name: "ls", arguments: JSON.stringify({ path: project }) } }] },
            "tool_calls")
          return
        }
        assert(body.messages.some(message => message.role === "tool"), "Actual ls result required")
        finish(response, index, { role: "assistant", content: `SHARED_APPEND_CHILD_DONE_${path.split("/")[1]}` }, "stop")
        return
      }
      assert(path.startsWith("/main/"))
      const user = body.messages.findLast(message => message.role === "user")
      if (JSON.stringify(user?.content).includes(laterUser)) {
        finish(response, index, { role: "assistant", content: "SHARED_APPEND_PARENT_OK" }, "stop")
      } else if (body.messages.some(message => message.role === "tool")) {
        finish(response, index, { role: "assistant", content: "SHARED_APPEND_MAIN_DONE" }, "stop")
      } else {
        assert(JSON.stringify(user?.content).includes(firstUser))
        assert(body.tools?.some(tool => tool.function.name === "task"))
        finish(response, index, { role: "assistant", tool_calls: [0, 1].map(slot => ({
          index: slot, id: `shared-task-${slot}`, type: "function", function: { name: "task",
            arguments: JSON.stringify({ subagent_type: "general-purpose", description: caption }) }
        })) }, "tool_calls")
      }
    } catch (error) {
      evidence.providerError = String(error)
      if (!response.headersSent) response.writeHead(500)
      response.end("Local shared session.append fixture failed")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`
  let threadId = ""
  let readPhaseState: (() => Promise<SharedState>) | undefined
  let lifecycleInstalled = false
  const lifecycleFailures: string[] = []
  evidence.lifecycleDiagnosticFailures = lifecycleFailures
  evidence.lifecycleObservation = observeLifecycle
    ? "development-observer"
    : "unavailable-production-package"
  const lifecycle = (phase: "start" | "read" | "stop"): Promise<unknown> => app.evaluate(
    (_electron, { entry, phase }) => {
      const { createRequire } = process.getBuiltinModule("node:module")
      const probe = createRequire(entry)(entry) as {
        observeNativeAppendLifecycle(): void
        readNativeAppendLifecycle(): unknown
        stopNativeAppendLifecycle(): void
      }
      if (phase === "start") return probe.observeNativeAppendLifecycle()
      if (phase === "stop") return probe.stopNativeAppendLifecycle()
      return probe.readNativeAppendLifecycle()
    }, { entry: fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)), phase }
  )
  try {
    if (observeLifecycle) {
      try {
        await lifecycle("start")
        lifecycleInstalled = true
      } catch {
        lifecycleFailures.push("start")
      }
    }
    threadId = await page.evaluate(async ({ project, base }) => {
      for (const slot of ["main", "child-1", "child-2"]) {
        const id = `shared-append-${slot}`
        await window.api.models.setCustomConfig({ id, name: id, baseUrl: `${base}/${slot}/v1`,
          model: "gpt-4", apiKey: "local-shared-fixture-key", maxTokens: 32000, maxOutputTokens: 512 })
      }
      await window.api.models.setDefault("custom:shared-append-main")
      const thread = await window.api.threads.create({ title: "Shared session append E2E",
        workspacePath: project, agentMode: "normal" })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:shared-append-main", subagentsEnabled: true }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, { project, base })
    evidence.threadId = threadId
    const source = String.raw`export function register(on){
      let main,children=[],reads=[],errors=[],phases=[],buttons=0,slots={},slotCount=0;
      on("session.start",async($,e,next)=>{
        for(const name of ["shared-open","shared-state","shared-retired"])
          await $.command.register({name,description:name,immediate:true});return next(e);
      });
      on("command.run",{command:"shared-open"},async($)=>{
        main=await $.session.append({message:{type:"user",content:[{type:"text",text:"${mainNote}"}]}});
        await $.ui.open({id:"shared-board",title:"Shared append"});return {};
      });
      on("command.run",{command:"shared-state"},async($)=>({text:JSON.stringify({
        main,children,reads,errors,phases,buttons,agents:await $.agent.list()
      })}));
      on("command.run",{command:"shared-retired"},async($)=>{
        try{await $.session.append({agentId:children[0].id,message:{type:"user",
          content:[{type:"text",text:"SHARED_APPEND_RETIRED_MUST_NOT_SAVE"}]}});
          return {text:JSON.stringify({accepted:true})};
        }catch(error){return {text:JSON.stringify({code:error.code,message:error.message})}};
      });
      on("turn.step",async function*($,e,next){
        if(!e.agentId||e.agentId==="main")return yield* next(e);
        if(!slots[e.agentId])slots[e.agentId]=++slotCount;
        const slot=slots[e.agentId];
        phases.push({phase:"child-step",slot,index:e.index,at:Date.now()});
        try{
          if(e.index===0){
            phases.push({phase:"agent-list-before",slot,index:e.index,at:Date.now()});
            const agents=await $.agent.list();
            phases.push({phase:"agent-list-after",slot,index:e.index,at:Date.now()});
            const own=agents.find(a=>a.id===e.agentId&&a.status==="running");
            if(!own)throw Error("ACTUAL_SHARED_AGENT_NOT_RUNNING");
            phases.push({phase:"sdk-append-before",slot,index:e.index,at:Date.now()});
            const value=await $.session.append({agentId:own.id,message:{type:"user",
              content:[{type:"text",text:"SHARED_APPEND_CHILD_NOTE:"+own.id}]}});
            phases.push({phase:"sdk-append-after",slot,index:e.index,at:Date.now()});
            children.push({id:own.id,slot,uuid:value.uuid,agents});
          }else if(e.index===1){
            phases.push({phase:"api-read-before",slot,index:e.index,at:Date.now()});
            const api=await $.session.messages({as:"api",agentId:e.agentId});
            phases.push({phase:"api-read-after",slot,index:e.index,at:Date.now()});
            phases.push({phase:"summary-read-before",slot,index:e.index,at:Date.now()});
            const summary=await $.session.messages({agentId:e.agentId});
            phases.push({phase:"summary-read-after",slot,index:e.index,at:Date.now()});
            reads.push({id:e.agentId,api,summary});
          }
        }catch(error){errors.push({code:error.code,message:error.message});throw error}
        phases.push({phase:"next-before",slot,index:e.index,at:Date.now()});
        return yield* next({...e,model:"custom:shared-append-child-"+slot});
      });
      on("ui.render",{component:"Pane",requestId:"shared-board"},($,e)=>{
        const {Box,Text,Button}=$.ui.resolve(e);
        return <Box flexDirection="column"><Text>{"Shared notes:"+children.length}</Text>
          <Button key="original" label={"Original shared button:"+buttons} onPress={async()=>{
            buttons++;await $.ui.invalidate("ui.render")}}/></Box>;
      });
    }`
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "session-append-shared", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
    zip.addFile("hooks/register.tsx", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "session-append-shared.zip"), bytes)
    const installed = await page.evaluate(bytes => window.api.plugins.install(
      new Uint8Array(bytes).buffer, "session-append-shared.zip", "local"), [...bytes])
    assert(installed.success, installed.error)
    const mod = (await page.evaluate(id => window.api.mods.status(id), threadId)).functionMods
      ?.find(row => row.name === "session-append-shared")
    assert(mod?.digest)
    await page.evaluate(({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: mod.pluginId, digest: mod.digest })
    record("actual current-digest approved source registers main and known shared task observers")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Shared session append E2E", { exact: true }).first().click()
    await openModsResults(page)
    const command = async (name: string) => {
      const descriptor = (await page.evaluate(id => window.api.mods.commands(id), threadId))
        .find(row => row.command === name)
      assert(descriptor, `Actual command missing: ${name}`)
      const job = await page.evaluate(({ id, descriptor }) => window.api.mods.enqueue(id, descriptor,
        { text: "" }), { id: threadId, descriptor })
      let text = ""
      await until(async () => {
        const current = (await page.evaluate(id => window.api.mods.jobs(id), threadId))
          .find(row => row.id === job.id)
        if (current?.state === "failed") throw Error(current.error)
        if (current?.state !== "succeeded") return false
        text = current.result?.text ?? ""
        return true
      }, name)
      return text
    }
    const state = async () => JSON.parse(await command("shared-state")) as SharedState
    readPhaseState = state
    const saved = () => page.evaluate(id => window.api.threads.getMessages(id), threadId)
    await command("shared-open")
    const pane = page.locator('[data-function-pane="shared-board"]')
    await until(async () => await pane.count() === 1 &&
      (await pane.innerText()).includes("Shared notes:0"), "actual native shared controls")
    const initial = await state()
    assert(initial.main?.uuid)
    assert.equal(requests.length, 0)
    assert((await saved()).some(row => row.id === initial.main!.uuid && row.function_row?.isMeta === true))
    record("omitted SDK target saves an actual main note without launching any task or model")
    const send = async (text: string, answer: string, watchdogMs = 30_000) => {
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill(text)
      const started = performance.now()
      const sampleCpuClock =
        watchdogMs === 60_000 &&
        process.env.CMB_MODS_E2E_MAIN_CPU_PROFILE === "1"
      const clockFailures: string[] = []
      if (sampleCpuClock) evidence.parentCpuClockDiagnosticFailures = clockFailures
      const readCpuClock = async (phase: "start" | "end") => {
        try {
          evidence[phase === "start" ? "parentCpuClockStart" : "parentCpuClockEnd"] =
            await app.evaluate(() => ({
              monotonicUs: Number(process.hrtime.bigint() / 1000n),
              wallTimeMs: Date.now()
            }))
        } catch {
          // Diagnostic clocks must never replace the original functional failure.
          clockFailures.push(phase)
        }
      }
      let completed = false
      try {
        if (sampleCpuClock) await readCpuClock("start")
        await composer.press("Enter")
        const check = async () => JSON.stringify(await saved()).includes(answer) &&
          (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
        const label = `actual parent ${answer}`
        if (watchdogMs === 30_000) {
          await until(check, label)
        } else {
          const deadline = started + watchdogMs
          while (performance.now() < deadline) {
            if (await check()) {
              completed = true
              break
            }
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          if (!completed) throw new Error(`Timeout: ${label}`)
        }
        completed = true
      } finally {
        if (watchdogMs === 60_000) {
          const elapsed = performance.now() - started
          evidence.parentTurnMs = elapsed
          evidence.parentExceeded30s = elapsed > 30_000
          evidence.parentTurnCompleted = completed
          if (sampleCpuClock) await readCpuClock("end")
        }
      }
    }
    // Composite functional watchdog; elapsed time remains evidence, not a latency improvement.
    await send(firstUser, "SHARED_APPEND_MAIN_DONE", 60_000)
    const actual = await state()
    evidence.state = actual
    assert.deepEqual(actual.errors, [])
    assert.equal(actual.children.length, 2)
    assert.equal(new Set(actual.children.map(child => child.id)).size, 2)
    assert.equal(new Set(actual.children.map(child => child.uuid)).size, 2)
    assert.equal(actual.reads.length, 2)
    assert(actual.children.every(child => /^mod-task:[0-9a-f-]{36}$/.test(child.id)))
    assert(actual.children.every(child => child.agents.some(agent => agent.id === child.id &&
      agent.status === "running" && agent.type === "general-purpose" && agent.description === caption)))
    assert(actual.children.some(child => child.agents.filter(agent =>
      agent.status === "running" && agent.description === caption).length === 2))
    record("two actual parallel tasks with identical labels expose distinct running native agent IDs")
    for (const child of actual.children) {
      const calls = requests.filter(row => row.path.startsWith(`/child-${child.slot}/`))
      assert.equal(calls.length, 2)
      const marker = `SHARED_APPEND_CHILD_NOTE:${child.id}`
      const foreign = `SHARED_APPEND_CHILD_NOTE:${actual.children.find(value => value.id !== child.id)!.id}`
      assert(!JSON.stringify(calls[0].body.messages).includes(marker))
      assert.equal(calls[1].body.messages.filter(message => JSON.stringify(message.content).includes(marker)).length, 1)
      assert(!JSON.stringify(calls).includes(foreign))
      assert(!JSON.stringify(calls).includes(mainNote))
      const read = actual.reads.find(value => value.id === child.id)
      assert(read)
      assert(JSON.stringify(read.api).includes(marker))
      assert(JSON.stringify(read.summary).includes(marker))
      assert(!JSON.stringify(read).includes(foreign))
    }
    assert.equal(requests.filter(row => row.path.startsWith("/main/")).length, 2)
    assert.equal(requests.length, 6)
    const first = requests[0].body.messages.map(message => JSON.stringify(message.content))
    const noteIndex = first.findIndex(value => value.includes(mainNote))
    const userIndex = first.findIndex(value => value.includes(firstUser))
    assert(noteIndex >= 0 && userIndex >= 0 && noteIndex < userIndex)
    assert(!JSON.stringify(requests.filter(row => row.path.startsWith("/main/"))).includes("SHARED_APPEND_CHILD_NOTE:"))
    record("each real child next HTTP request consumes only its addressed note once after actual ls, while main remains separate")
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = db.prepare(`SELECT r.uuid,r.conversation_id,c.kind,c.checkpoint_namespace,
        m.thread_id AS projection_thread_id,t.metadata
        FROM function_conversation_rows r JOIN function_conversations c USING(conversation_id)
        JOIN thread_messages m ON m.message_id=r.uuid JOIN threads t ON t.thread_id=m.thread_id
        WHERE r.uuid IN (?, ?, ?)`)
        .all(initial.main.uuid, ...actual.children.map(child => child.uuid))
      assert.equal(rows.length, 3)
      const children = rows.filter(row => row.kind === "child")
      assert.equal(children.length, 2)
      assert.equal(new Set(children.map(row => row.conversation_id)).size, 2)
      assert.equal(new Set(children.map(row => row.checkpoint_namespace)).size, 2)
      assert.equal(new Set(children.map(row => row.projection_thread_id)).size, 2)
      for (const child of children) {
        assert.notEqual(child.projection_thread_id, threadId)
        const metadata = JSON.parse(String(child.metadata))
        assert.equal(metadata.isInternalFlowRuntime, true)
        assert.equal(metadata.isFunctionConversationProjection, true)
        assert.equal(metadata.parentThreadId, threadId)
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM function_conversation_inbox WHERE conversation_id=?")
          .get(child.conversation_id)?.n, 0)
      }
      assert.equal(rows.find(row => row.kind === "main")?.projection_thread_id, threadId)
      assert(!(await saved()).some(row => actual.children.some(child => child.uuid === row.id)))
      evidence.canonicalRows = rows
    } finally { db.close() }
    record("real app SQLite keeps two child conversations/namespaces and distinct internal UI buckets without writing notes into main chat")
    const retired = JSON.parse(await command("shared-retired"))
    assert.equal(retired.code, "MODS_CONVERSATION_UNAVAILABLE", JSON.stringify(retired))
    assert(actual.children.every(child => actual.agents.some(agent => agent.id === child.id && agent.status === "completed")))
    evidence.retired = retired
    record("completed child IDs remain observable as completed but cannot admit a new SDK note")
    await pane.getByRole("button", { name: "Original shared button:0", exact: true }).click()
    await until(async () => (await pane.innerText()).includes("Original shared button:1"), "original shared callback")
    await send(laterUser, "SHARED_APPEND_PARENT_OK")
    assert.equal(requests.length, 7)
    assert(JSON.stringify(requests[6].body.messages).includes(laterUser))
    assert(!JSON.stringify(requests[6]).includes("SHARED_APPEND_RETIRED_MUST_NOT_SAVE"))
    assert.equal((await state()).buttons, 1)
    await page.screenshot({ path: join(artifacts, "session-append-shared-final.png") })
    record("original Button and next ordinary parent chat remain usable after child retirement, with no task replay")
    evidence.complete = true
  } catch (error) {
    evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    if (lifecycleInstalled) try {
      evidence.lifecycleBeforeDiagnostics = await lifecycle("read")
    } catch { lifecycleFailures.push("read-before-diagnostics") }
    if (readPhaseState) try {
      evidence.phaseState = await readPhaseState()
    } catch (diagnosticError) { evidence.phaseStateError = String(diagnosticError) }
    if (threadId) try {
      evidence.diagnostics = await page.evaluate(async id => Promise.allSettled([
        window.api.mods.jobs(id), window.api.mods.logs(id), window.api.mods.panes(id),
        window.api.threads.getMessages(id)
      ]), threadId)
    } catch (diagnosticError) { evidence.diagnosticError = String(diagnosticError) }
    throw error
  } finally {
    if (lifecycleInstalled) {
      try { evidence.lifecycleFinal = await lifecycle("read") }
      catch { lifecycleFailures.push("read-final") }
      try { await lifecycle("stop") }
      catch { lifecycleFailures.push("stop") }
    }
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    writeFileSync(join(artifacts, "session-append-shared-evidence.json"), JSON.stringify(evidence, null, 2))
  }
}
