import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyInstructionsLoaded(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "instructions-loaded-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "batch-present.txt"), "ACTUAL_BATCH_FILE")
  writeFileSync(join(project, "AGENTS.md"), "INSTRUCTION_SOURCE_ACTUAL: respect project boundaries")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Instructions loaded E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "instructions-loaded", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"instructions-loaded",description:"Instruction mode"});return next(e)});
      on("command.run",{command:"instructions-loaded"},async($,e)=>{await $.store.set("mode",e.args);return {text:"INSTRUCTION_MODE:"+e.args}});
      on("classic.InstructionsLoaded",async($,e,next)=>{
        $.ui.log("INSTRUCTION_SOURCE:"+JSON.stringify(e));
        const lower=await next(e);
        if(await $.store.get("mode")==="stall") {
          await $.model.complete({model:"custom:mods-model-fixture",prompt:"[stall] instructions review",maxTokens:64});
          $.ui.log("LATE_INSTRUCTIONS_FINISH")
        }
        return await $.store.get("mode")==="block"?{block:"INSTRUCTIONS_BLOCKED_BEFORE_MODEL"}:lower
      })
    }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "instructions-loaded.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "instructions-loaded")!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Instructions loaded E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const prompt = "[mods-tool-batch] inspect both files"
  const first = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= first + 2 &&
      (await page.getByText("TOOL_BATCH_OK", { exact: true }).count()) > 0 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "loaded instructions reach actual model"
  )
  const entries = (await logs()).filter((row) => row.text.startsWith("INSTRUCTION_SOURCE:"))
  assert.equal(entries.length, 1)
  const source = JSON.parse(entries[0].text.slice("INSTRUCTION_SOURCE:".length))
  assert.equal(source.file_path, join(project, "AGENTS.md"))
  assert.equal(source.memory_type, "Project")
  assert.equal(source.load_reason, "session_start")
  assert(JSON.stringify(requests[first]).includes("INSTRUCTION_SOURCE_ACTUAL"))
  await page.screenshot({ path: join(artifacts, "instructions-loaded-on.png") })
  pass(
    "actual project instructions emit one provenance event before a multi-step main task and remain in the real model prompt"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  const off = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= off + 2 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "off original instructions task"
  )
  assert.deepEqual(await logs(), [])
  assert(JSON.stringify(requests[off]).includes("INSTRUCTION_SOURCE_ACTUAL"))
  pass("same task with Mods off retains original instruction injection without instruction hooks")
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await send("/instructions-loaded block")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
        (job) => job.result?.text === "INSTRUCTION_MODE:block"
      ),
    "block instruction mode"
  )
  const blocked = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= blocked + 2 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "observer cannot block main model"
  )
  assert.equal(requests.length, blocked + 2)
  assert.equal(
    await page.getByText("INSTRUCTIONS_BLOCKED_BEFORE_MODEL", { exact: false }).count(),
    0
  )
  pass(
    "InstructionsLoaded discards block output and preserves the original model flow as an observation event"
  )
  await send("/instructions-loaded stall")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
        (job) => job.result?.text === "INSTRUCTION_MODE:stall"
      ),
    "stall instruction mode"
  )
  for (const action of ["cancel", "revoke"] as const) {
    const start = requests.length,
      closed = closedStalls()
    await send("[stall] original main task")
    await until(
      async () => requests.length >= start + 2,
      "instruction check reaches real review transport"
    )
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else
      await page.evaluate(
        (id) => window.api.mods.revokeFunction(id, "instructions-loaded"),
        threadId
      )
    await until(
      async () =>
        closedStalls() >= closed + 2 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "instruction review cancels transport"
    )
    assert.equal(requests.length, start + 2)
    assert(!(await logs()).some((row) => row.text === "LATE_INSTRUCTIONS_FINISH"))
    pass(
      `${action} during actual instruction review closes both observation and main transports without a late observation`
    )
  }
}
