import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import type { FunctionAgentInfo } from "../../src/shared/mods/v2/agent-list"

export async function verifyAgentList(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "agent-list-project")
  mkdirSync(project)
  writeFileSync(join(project, "claw-notes"), "AGENT_LIST_ORIGINAL_OFF_READ")
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Agent instances E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id?: string; id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: true }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "agent-instances", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"agent-instances",description:"Actual child instances",immediate:true});
      await $.tool.register({name:"probe",description:"Inspect active task instances"});return next(e)
    });
    on("tool.call",{tool:"mcp__agent-instances__probe"},async($)=>{
      const agents=await $.agent.list();await $.store.set("running",agents);return {result:{agents}}
    });
    on("command.run",{command:"agent-instances"},async($,e)=>{
      try{
        if(e.args==="delay"){$.ui.log("AGENT_LIST_WAIT");await $.clock.sleep(1500)}
        return {text:JSON.stringify({current:await $.agent.list(),running:await $.store.get("running")})}
      }catch(error){return {text:"ERROR:"+(error.code||error.message)}}
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "agent-instances.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "agent-instances"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Agent instances E2E", { exact: true }).first().click()
  const enqueue = (text = "") =>
    page.evaluate(
      async ({ id, text }) => {
        const command = (await window.api.mods.commands(id)).find(
          (row) => row.command === "agent-instances"
        )
        if (!command) throw Error("missing agent list command")
        return (await window.api.mods.enqueue(id, command, { text })).id
      },
      { id, text }
    )
  const inspect = async () => {
    const jobId = await enqueue()
    let text = ""
    await until(async () => {
      const job = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
        (row) => row.id === jobId
      )
      if (job?.state === "failed") throw Error(job.error)
      if (job?.state !== "succeeded") return false
      text = job.result?.text ?? ""
      return true
    }, "instance query settled")
    assert.doesNotMatch(text, /^ERROR:/)
    return JSON.parse(text) as { current: FunctionAgentInfo[]; running?: FunctionAgentInfo[] }
  }
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
  }
  const idle = async () =>
    (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
  const completedAnswers = () =>
    page.evaluate(async (id) => {
      const messages = await window.api.threads.getMessages(id)
      return messages
        .filter((message) => {
          if (message.role !== "assistant") return false
          return typeof message.content === "string"
            ? message.content === "MODS_CHILD_OK"
            : message.content.some(
                (block) => block.type === "text" && block.text === "MODS_CHILD_OK"
              )
        })
        .map((message) => message.id)
    }, id)
  const task = async (suffix = "") => {
    // Virtualized historical rows may unmount when the new answer arrives.
    const before = new Set(await completedAnswers())
    await send("[mods-child] [mods-agent-list] " + suffix)
    await until(
      async () =>
        (await idle()) && (await completedAnswers()).some((messageId) => !before.has(messageId)),
      "actual child task durably finished"
    )
    await page.getByText("MODS_CHILD_OK", { exact: true }).last().waitFor()
  }
  const start = requests.length
  assert.deepEqual((await inspect()).current, [])
  assert.equal(requests.length, start)
  pass("cold agent.list returns observed instances without inventing agents or calling a model")
  await task()
  const completed = await inspect()
  assert.equal(completed.current.length, 1)
  assert.equal(completed.current[0].id, "mods-child-task")
  assert.equal(completed.current[0].type, "Explore")
  assert.equal(completed.current[0].status, "completed")
  assert.equal(completed.current[0].parentId, undefined)
  assert(completed.current[0].description.includes("[mods-child-worker]"))
  assert.equal(completed.running?.[0].status, "running")
  assert.equal(completed.running?.[0].id, completed.current[0].id)
  const audit = await page.evaluate((id) => window.api.mods.audit(id), id)
  assert(
    audit.some(
      (row) => row.identity?.agentId === completed.current[0].id && row.status === "succeeded"
    )
  )
  await page.screenshot({ path: join(artifacts, "agent-instances-completed.png") })
  writeFileSync(
    join(artifacts, "agent-instances-completed.json"),
    JSON.stringify({ completed, audit }, null, 2)
  )
  pass("actual shared child queries its running instance and the same native id settles completed")
  await task("[child-refusal]")
  assert.equal((await inspect()).current[0].status, "failed")
  pass(
    "a real child provider refusal is listed failed while the parent retains its normal completion"
  )
  const beforeStall = requests.length
  await send("[mods-child] [mods-agent-list] [child-stall]")
  await until(
    async () =>
      requests.slice(beforeStall).some((request) => {
        const body = request as { messages?: Array<{ role: string }> }
        return (
          body.messages?.at(-1)?.role === "tool" &&
          JSON.stringify(body).includes("[mods-child-worker] [mods-agent-list] [stall]")
        )
      }),
    "actual child stream is pending"
  )
  assert.equal((await inspect()).current[0].status, "running")
  await page.getByRole("button", { name: "停止生成", exact: true }).click()
  await until(idle, "original stop settles child")
  assert.equal((await inspect()).current[0].status, "killed")
  pass("original cancellation marks the live child killed and permits a later metadata query")
  await page.reload({ waitUntil: "domcontentloaded" })
  assert.equal((await inspect()).current[0].status, "killed")
  pass("renderer reload reads host task facts without fabricating a resumed running task")
  const delayedJob = await enqueue("delay")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.logs(id), id)).some(
        (row) => row.text === "AGENT_LIST_WAIT"
      ),
    "query awaits revoke"
  )
  await page.evaluate(({ id, name }) => window.api.mods.revokeFunction(id, name), {
    id,
    name: mod.name
  })
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods?.find(
      (row) => row.name === mod.name
    )?.state,
    "needs-approval"
  )

  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), id)).every(
        (job) => job.state !== "queued" && job.state !== "running"
      ),
    "revoked query cancelled"
  )
  const cancelled = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
    (job) => job.id === delayedJob
  )
  assert.equal(cancelled?.state, "failed")
  assert.equal(cancelled?.error, "MODS_CANCELLED")
  assert.equal(cancelled?.result, undefined)
  assert(
    !(await page.evaluate((id) => window.api.mods.commands(id), id)).some(
      (row) => row.command === "agent-instances"
    )
  )
  pass("revocation cancels the delayed SDK query and removes the original command descriptor")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  try {
    const before = requests.length
    await task()
    assert(JSON.stringify(requests.slice(before)).includes("AGENT_LIST_ORIGINAL_OFF_READ"))
    await page.screenshot({ path: join(artifacts, "agent-instances-off.png") })
    pass("Mods off preserves native child execution and file reading without instance hooks")
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
