import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { formatSkillUseBlock } from "../../src/shared/skill-use-block"

export async function verifyPromptExpansion(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "prompt-expansion-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Prompt expansion E2E",
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
    Buffer.from(
      JSON.stringify({ name: "prompt-expansion", version: "1.0.0", skills: ["./skills"] })
    )
  )
  zip.addFile(
    "skills/expansion-review/SKILL.md",
    Buffer.from(
      "---\nname: expansion-review\ndescription: Review expansion test\n---\nReview the provided task."
    )
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"expansion-mode",description:"Expansion test mode"});return next(e)});
    on("command.run",{command:"expansion-mode"},async($,e)=>{await $.store.set("mode",e.args);return {text:"EXPANSION_MODE:"+e.args}});
    on("classic.UserPromptExpansion",async($,e,next)=>{
      $.ui.log("EXPANSION_FACTS:"+JSON.stringify(e));
      const lower=await next(e);
      const mode=await $.store.get("mode");
      if(mode==="block")return {block:"EXPANSION_REQUIRES_REVIEW"};
      if(mode==="stall"){
        await $.model.complete({model:"custom:mods-model-fixture",prompt:"[stall] expansion review",maxTokens:64});
        $.ui.log("LATE_EXPANSION")
      }
      return {...lower,additionalContext:["EXPANSION_CHECKLIST_ACTUAL"]}
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "prompt-expansion.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "prompt-expansion")!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  const skill = (await page.evaluate(() => window.api.skills.listPlugins())).find(
    (s) => s.name === "expansion-review"
  )
  assert(skill, "installed real plugin skill must be discoverable")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Prompt expansion E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const stopped = async () =>
    (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
  const prompt =
    "Review the actual selected skill\n\n" +
    formatSkillUseBlock({ name: skill.name, path: skill.path })
  const start = requests.length
  await send(prompt)
  await until(
    async () => requests.length === start + 1 && (await stopped()),
    "actual expansion enters main model"
  )
  assert(JSON.stringify(requests[start]).includes("EXPANSION_CHECKLIST_ACTUAL"))
  const entries = (await logs()).filter((row) => row.text.startsWith("EXPANSION_FACTS:"))
  assert.equal(entries.length, 1)
  const facts = JSON.parse(entries[0].text.slice("EXPANSION_FACTS:".length))
  assert.equal(facts.command_name, "expansion-review")
  assert.equal(facts.command_source, "plugin")
  assert.equal(facts.expansion_type, "slash_command")
  assert.equal(facts.command_args, "Review the actual selected skill")
  assert.equal(facts.prompt, prompt)
  pass(
    "actual installed skill selection emits resolved expansion facts once and injects guest checklist into the real model request"
  )
  await page.screenshot({ path: join(artifacts, "prompt-expansion-on.png") })
  const setMode = async (mode: string) => {
    await send("/expansion-mode " + mode)
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) => job.result?.text === "EXPANSION_MODE:" + mode
        ),
      "set expansion mode " + mode
    )
  }
  await setMode("block")
  const blocked = requests.length
  await send(prompt)
  await until(
    async () =>
      (await page.getByText("EXPANSION_REQUIRES_REVIEW", { exact: false }).count()) > 0 &&
      (await stopped()),
    "expansion blocks before model"
  )
  assert.equal(requests.length, blocked)
  pass(
    "enabled expansion policy prevents the selected skill task from reaching the model and explains the missing review"
  )
  await page.screenshot({ path: join(artifacts, "prompt-expansion-blocked.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  const off = requests.length
  await send(prompt)
  await until(
    async () => requests.length === off + 1 && (await stopped()),
    "same selected skill proceeds with Mods off"
  )
  assert.deepEqual(await logs(), [])
  // Earlier successful turns remain in history; inspect only this turn's final user input.
  const offMessages = (requests[off] as { messages: Array<{ role: string; content: unknown }> })
    .messages
  const offInput = offMessages.findLast((m) => m.role === "user")
  assert(!JSON.stringify(offInput).includes("EXPANSION_CHECKLIST_ACTUAL"))
  assert(JSON.stringify(offInput).includes("expansion-review"))
  pass(
    "same selected skill with Mods off keeps the original input and makes one model request without an expansion gate"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await setMode("stall")
  for (const action of ["cancel", "revoke"] as const) {
    const first = requests.length,
      closed = closedStalls()
    await send(prompt)
    await until(
      async () => requests.length === first + 1,
      "expansion check enters real model transport"
    )
    assert(JSON.stringify(requests[first]).includes("[stall] expansion review"))
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else
      await page.evaluate((id) => window.api.mods.revokeFunction(id, "prompt-expansion"), threadId)
    await until(
      async () => closedStalls() > closed && (await stopped()),
      "expansion check cancels without main request"
    )
    assert.equal(requests.length, first + 1)
    assert(!(await logs()).some((row) => row.text === "LATE_EXPANSION"))
    pass(
      action +
        " aborts the real expansion review and prevents both a late context and main model invocation"
    )
  }
}
