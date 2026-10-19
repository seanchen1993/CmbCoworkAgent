import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

export async function verifyAgentSpawn(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
) {
  const project = join(workspace, "agent-spawn-project")
  mkdirSync(project)
  writeFileSync(join(project, "notes.txt"), "Native child read fixture")
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (_window, options) => {
      const text = JSON.stringify(options)
      if (!text.includes("agent.spawn")) throw Error("UNEXPECTED_SPAWN_APPROVAL: " + text)
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  const id = await page.evaluate(async (project) => {
    const row = await window.api.threads.create({
      title: "Independent agent spawn E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id = (row as unknown as { thread_id: string }).thread_id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, { set: { model: "custom:mods-model-fixture" } })
    await window.api.mods.configure(id, true, false)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "spawn-e2e", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    let child,limited,readSequence=0;
    on("session.start",async($,e,next)=>{
      await $.tool.register({name:"launch",description:"Start an independent review agent"});
      await $.agent.register({name:"reviewer",description:"Read-only review",prompt:"REGISTERED_REVIEW_ROLE",tools:["Read"],maxTurns:3,omitClaudeMd:true});
      await $.agent.register({name:"limited",description:"One model turn",prompt:"REGISTERED_LIMIT_ROLE",tools:["Read"],maxTurns:1,omitClaudeMd:true});
      await $.agent.register({name:"summary",description:"No-tool review",prompt:"REGISTERED_COLD_ROLE",tools:[],maxTurns:2,omitClaudeMd:true});
      await $.command.register({name:"spawn-cold",description:"Start a review in a new conversation"});
      await $.command.register({name:"spawn-inspect",description:"Inspect background agent",immediate:true});return next(e)
    });
    on("tool.call",{tool:"mcp__spawn-e2e__launch"},async($)=>{
      limited=(await $.agent.spawn({prompt:"[mods-spawn-limit] Read notes.txt repeatedly.",description:"Limited E2E reviewer",subagentType:"spawn-e2e:limited"})).agentId;
      const result=await $.agent.spawn({prompt:"[mods-spawn-child] Read notes.txt then finish.",description:"Independent E2E reviewer",subagentType:"spawn-e2e:reviewer"});
      child=result.agentId;await $.store.set("child",child);return {result:{started:child}}
    });
    on("tool.call",{tool:"Read"},async($,e,next)=>{
      const sequence=++readSequence;
      const result=await next(e);
      await $.store.set("read-event:"+e.agentId+":"+sequence,{agentId:e.agentId,tool:e.tool,
        toolUseId:e.tool_use_id,nextReturned:true,isError:result.isError===true,text:result.text});
      return result
    });
    on("turn.complete",async($,e,next)=>{if(e.agentId===limited){await $.store.set("limited",e)}else if(e.agentId===child){await $.store.set("completed",e);$.ui.log("SPAWN_COMPLETED "+e.answer)}return next(e)});
    on("command.run",{command:"spawn-inspect"},async($,e)=>{
      if(e.args==="send")return {text:JSON.stringify(await $.session.send({to:{agentId:child},text:"PEER_BACKGROUND_REVIEW"}))};
      const readEvents=await Promise.all((await $.store.keys()).filter(key=>key.startsWith("read-event:")).map(key=>$.store.get(key)));
      return {text:JSON.stringify({child:await $.store.get("child"),agents:await $.agent.list(),completed:await $.store.get("completed"),limited:await $.store.get("limited"),readEvents})}
    });
    on("command.run",{command:"spawn-cold"},async($)=>{try{const result=await $.agent.spawn({prompt:"[mods-spawn-cold] Review this supplied diff.",subagentType:"spawn-e2e:summary"});child=result.agentId;return {text:JSON.stringify(result)}}catch(error){return {text:JSON.stringify({failure:String(error)})}}})
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "spawn-e2e.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const status = await page.evaluate((id) => window.api.mods.status(id), id)
  const mod = status.functionMods!.find((item) => item.name === "spawn-e2e")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Independent agent spawn E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill(
    "[mods-spawn-parent] Launch one independent review agent, then finish immediately."
  )
  await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
  await until(
    async () =>
      (await page.getByText("SPAWN_PARENT_DONE", { exact: true }).count()) > 0 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "parent finishes independently"
  )
  const parentRequests = requests.filter((value) => {
    const body = value as { messages?: Array<{ role?: string; content?: unknown }> }
    return body.messages?.some(
      (message) =>
        message.role === "user" &&
        (message.content ===
          "[mods-spawn-parent] Launch one independent review agent, then finish immediately." ||
          (Array.isArray(message.content) &&
            message.content.map((part) => (part?.type === "text" ? part.text : "")).join("") ===
              "[mods-spawn-parent] Launch one independent review agent, then finish immediately."))
    )
  })
  writeFileSync(
    join(artifacts, "agent-spawn-parent-protocol.json"),
    JSON.stringify({ parentThreadId: id, requests: parentRequests }, null, 2)
  )
  assert.equal(parentRequests.length, 3, "Actual parent search, launch and answer requests")
  const command = async (text = "", targetId = id) => {
    const jobId = await page.evaluate(
      async ({ id, text }) => {
        const descriptor = (await window.api.mods.commands(id)).find(
          (item) => item.command === "spawn-inspect"
        )!
        return (await window.api.mods.enqueue(id, descriptor, { text })).id
      },
      { id: targetId, text }
    )
    let result = ""
    await until(async () => {
      const job = (await page.evaluate((id) => window.api.mods.jobs(id), targetId)).find(
        (item) => item.id === jobId
      )
      if (job?.state === "failed") throw Error(job.error)
      if (job?.state !== "succeeded") return false
      result = job.result?.text ?? ""
      return true
    }, "spawn inspection")
    return JSON.parse(result)
  }
  const running = await command()
  assert.equal(
    running.agents.find((agent: { id: string }) => agent.id === running.child)?.status,
    "running"
  )
  assert.equal((await command("send")).isDelivered, true)
  pass(
    "native approval starts a separate child; it stays running after the parent turn ends and accepts an addressed peer message"
  )
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.logs(id), id)).some((entry) =>
        entry.text.includes("SPAWN_COMPLETED SPAWN_CHILD_DONE")
      ),
    "independent child completes"
  ).catch(async (error) => {
    writeFileSync(
      join(artifacts, "agent-spawn-failure.json"),
      JSON.stringify(
        {
          state: await command(),
          requests,
          logs: await page.evaluate((id) => window.api.mods.logs(id), id),
          audit: await page.evaluate((id) => window.api.mods.audit(id), id)
        },
        null,
        2
      )
    )
    throw error
  })
  const completed = await command()
  assert.equal(
    completed.agents.find((agent: { id: string }) => agent.id === completed.child)?.status,
    "completed"
  )
  assert.equal(completed.completed.agentId, completed.child)
  assert.equal(completed.completed.answer, "SPAWN_CHILD_DONE")
  assert.equal(completed.limited.reason, "error")
  const childRequests = requests.filter((request) =>
    JSON.stringify(request).includes("[mods-spawn-child]")
  )
  assert(childRequests.length >= 2)
  assert(
    childRequests.every((request) => JSON.stringify(request).includes("REGISTERED_REVIEW_ROLE"))
  )
  assert.equal(
    requests.filter((request) => JSON.stringify(request).includes("[mods-spawn-limit]")).length,
    1
  )
  assert(!existsSync(join(project, "unauthorized.txt")))
  assert(
    childRequests.some((request) => JSON.stringify(request).includes("MODS_RUNTIME_TOOL_DENIED"))
  )
  assert(
    requests.some(
      (request) =>
        JSON.stringify(request).includes("untrusted-peer-data") &&
        JSON.stringify(request).includes("PEER_BACKGROUND_REVIEW")
    )
  )
  const peers = await page.evaluate((id) => window.api.mods.peerMessages(id), id)
  assert(
    peers.some(
      (record) => record.text === "PEER_BACKGROUND_REVIEW" && record.status === "delivered"
    )
  )
  const messages = await page.evaluate((id) => window.api.threads.getMessages(id), id)
  assert.equal(messages.filter((message) => message.role === "user").length, 1)
  const audit = await page.evaluate((id) => window.api.mods.audit(id), id)
  assert(audit.some((entry) => entry.toolId === "agent.spawn" && entry.status === "succeeded"))
  await page.locator("[data-function-peer-messages] summary").click()
  await page.screenshot({ path: join(artifacts, "agent-spawn-peer.png") })
  writeFileSync(
    join(artifacts, "agent-spawn.json"),
    JSON.stringify({ running, completed, peers, audit }, null, 2)
  )
  pass(
    "registered roles enforce real tool allowlists and maxTurns; child consumes peer context and publishes completion without a new user turn"
  )
  const coldStartIdentity = await page.evaluate(async (project) => {
    const row = await window.api.threads.create({
      title: "Cold review command",
      workspacePath: project,
      agentMode: "normal"
    })
    const id = (row as unknown as { thread_id: string }).thread_id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, { set: { model: "custom:mods-model-fixture" } })
    const descriptor = (await window.api.mods.commands(id)).find(
      (entry) => entry.command === "spawn-cold"
    )!
    const job = await window.api.mods.enqueue(id, descriptor, { text: "cold" })
    return { threadId: id, jobId: job.id }
  }, project)
  const coldId = coldStartIdentity.threadId
  await until(async () => {
    const jobs = await page.evaluate((id) => window.api.mods.jobs(id), coldId)
    const failed = jobs.find((job) => job.state === "failed")
    if (failed) throw Error("Cold command: " + failed.error)
    const finished = jobs.find((job) => job.state === "succeeded")
    if (finished) {
      const result = JSON.parse(finished.result?.text || "{}")
      if (result.failure || result.deny)
        throw Error("Cold command: " + (result.failure || result.deny))
    }
    return (await page.evaluate((id) => window.api.mods.logs(id), coldId)).some((entry) =>
      entry.text.includes("SPAWN_COMPLETED SPAWN_COLD_DONE")
    )
  }, "cold command child completes").catch(async (error) => {
    writeFileSync(
      join(artifacts, "agent-cold-failure.json"),
      JSON.stringify(
        {
          requests,
          jobs: await page.evaluate((id) => window.api.mods.jobs(id), coldId),
          logs: await page.evaluate((id) => window.api.mods.logs(id), coldId)
        },
        null,
        2
      )
    )
    throw error
  })
  assert.equal(
    (await page.evaluate((id) => window.api.threads.getMessages(id), coldId)).filter(
      (message) => message.role === "user"
    ).length,
    0
  )
  pass(
    "a new conversation can run the registered no-tool review from a command before any model turn"
  )
  const cold = await command("", coldId)
  const coldJobs = await page.evaluate((id) => window.api.mods.jobs(id), coldId)
  const coldStart = coldJobs.find(
    (job) => job.id === coldStartIdentity.jobId && job.state === "succeeded"
  )
  assert(coldStart?.result?.text, "Original cold startup result must identify its actual agent")
  const coldAgent = JSON.parse(coldStart.result.text).agentId
  assert.equal(cold.completed.agentId, coldAgent)
  const completionRows = [
    {
      role: "reviewer",
      event: completed.completed,
      prompt: "[mods-spawn-child] Read notes.txt then finish.",
      requested: 2,
      http: 3,
      outcome: "success",
      reads: 1
    },
    {
      role: "limited",
      event: completed.limited,
      prompt: "[mods-spawn-limit] Read notes.txt repeatedly.",
      requested: 1,
      http: 1,
      outcome: "error",
      reads: 1
    },
    {
      role: "cold",
      event: cold.completed,
      prompt: "[mods-spawn-cold] Review this supplied diff.",
      requested: 0,
      http: 1,
      outcome: "success",
      reads: 0
    }
  ]
  const traceEvidence: unknown[] = []
  await until(async () => {
    const parentTraces = await page.evaluate(
      (id) => window.api.optimizer.getTraces({ threadId: id }),
      id
    )
    const parent = parentTraces.find(
      (trace) =>
        trace.traceKind === "root" &&
        trace.userMessage ===
          "[mods-spawn-parent] Launch one independent review agent, then finish immediately."
    )
    if (!parent) return false
    const summaries = await page.evaluate(() => window.api.optimizer.getTraces({ limit: 16 }))
    traceEvidence.length = 0
    for (const row of completionRows) {
      assert.equal(typeof row.event.turnId, "string")
      const summary = summaries.find((trace) => trace.subagentRunId === row.event.turnId)
      if (!summary) return false
      const trace = await page.evaluate(
        (id) => window.api.optimizer.getTraceDetail(id),
        summary.traceId
      )
      if (!trace) return false
      assert.equal(trace.traceKind, "subagent")
      assert.equal(trace.executionMode, "normal")
      assert.equal(trace.subagentKind, undefined)
      assert.equal(trace.threadId, trace.subagentThreadId)
      assert.equal(trace.outcome, row.outcome)
      assert.equal(trace.totalToolCalls, row.requested)
      const scopedHttp = requests.filter((value) => {
        const body = value as { messages?: Array<{ role?: string; content?: unknown }> }
        return body.messages?.some(
          (message) =>
            message.role === "user" &&
            (message.content === row.prompt ||
              (Array.isArray(message.content) &&
                message.content.map((part) => (part?.type === "text" ? part.text : "")).join("") ===
                  row.prompt))
        )
      })
      assert.equal(scopedHttp.length, row.http, `${row.role} actual provider requests`)
      assert.equal(
        trace.modelCalls?.length,
        scopedHttp.length,
        `${row.role} separate logical calls`
      )
      if (row.role === "cold") {
        assert.equal(trace.parentTraceId, undefined)
        assert.equal(trace.rootTraceId, trace.traceId)
        assert.equal(trace.rootThreadId, trace.threadId)
      } else {
        assert.equal(trace.parentTraceId, parent.traceId)
        assert.equal(trace.parentThreadId, id)
        assert.equal(trace.rootTraceId, parent.rootTraceId)
      }
      const observed = cold.readEvents.filter(
        (event: { agentId: string }) => event.agentId === row.event.agentId
      )
      assert.equal(observed.length, row.reads, `${row.role} public Read event observations`)
      for (const event of observed) {
        assert.equal(event.tool, "Read")
        assert.equal(event.nextReturned, true)
        assert.equal(event.isError, false)
        assert.equal(typeof event.text, "string")
        assert(event.text.includes("Native child read fixture"))
        const call = trace.nodes?.find(
          (node) => node.type === "tool" && node.metadata?.toolCallId === event.toolUseId
        )
        assert(call, "Actual public Read event must match original trace tool call")
        const result = trace.nodes?.find(
          (node) => node.type === "tool_result" && node.parentId === call.id
        )
        assert.equal(result?.status, "success")
        assert(JSON.stringify(result?.output).includes("Native child read fixture"))
      }
      const denied =
        trace.nodes?.filter(
          (node) =>
            node.type === "tool_result" &&
            node.status === "error" &&
            JSON.stringify(node.output).includes("MODS_RUNTIME_TOOL_DENIED")
        ) ?? []
      assert.equal(denied.length, row.role === "reviewer" ? 1 : 0)
      traceEvidence.push({
        role: row.role,
        agentId: row.event.agentId,
        turnId: row.event.turnId,
        traceId: trace.traceId,
        threadId: trace.threadId,
        parentTraceId: trace.parentTraceId,
        rootTraceId: trace.rootTraceId,
        outcome: trace.outcome,
        requestedToolCalls: trace.totalToolCalls,
        observedReadEvents: observed.length,
        confirmedReadSuccesses: observed.length,
        deniedWriteResults: denied.length,
        actualHttpRequests: scopedHttp.length,
        logicalModelCalls: trace.modelCalls?.length,
        events: observed
      })
    }
    return true
  }, "SDK child native traces and public tool observations")
  writeFileSync(
    join(artifacts, "agent-spawn-trace.json"),
    JSON.stringify(
      {
        complete: true,
        parentThreadId: id,
        coldParentThreadId: coldId,
        reader: "original optimizer IPC; OS-protected native storage; no DB or plaintext override",
        children: traceEvidence
      },
      null,
      2
    )
  )
  pass(
    "each actual SDK child has an original native trace; requested tools, observed Read events, results and provider requests remain distinct"
  )
}
