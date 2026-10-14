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
    let child,limited;
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
    on("turn.complete",async($,e,next)=>{if(e.agentId===limited){await $.store.set("limited",e)}else if(e.agentId===child){await $.store.set("completed",e);$.ui.log("SPAWN_COMPLETED "+e.answer)}return next(e)});
    on("command.run",{command:"spawn-inspect"},async($,e)=>{
      if(e.args==="send")return {text:JSON.stringify(await $.session.send({to:{agentId:child},text:"PEER_BACKGROUND_REVIEW"}))};
      return {text:JSON.stringify({child:await $.store.get("child"),agents:await $.agent.list(),completed:await $.store.get("completed"),limited:await $.store.get("limited")})}
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
  const command = async (text = "") => {
    const jobId = await page.evaluate(
      async ({ id, text }) => {
        const descriptor = (await window.api.mods.commands(id)).find(
          (item) => item.command === "spawn-inspect"
        )!
        return (await window.api.mods.enqueue(id, descriptor, { text })).id
      },
      { id, text }
    )
    let result = ""
    await until(async () => {
      const job = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
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
  const coldId = await page.evaluate(async (project) => {
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
    await window.api.mods.enqueue(id, descriptor, { text: "cold" })
    return id
  }, project)
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
}
