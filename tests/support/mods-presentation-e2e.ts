import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { formatSkillUseBlock } from "../../src/shared/skill-use-block"

/** Production ZIP, utility-process QuickJS and the actual mounted React textarea. */
export async function verifyPresentation(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "presentation-project")
  mkdirSync(project)
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Mods 草稿与展示链路",
      workspacePath: project,
      agentMode: "normal"
    })
    const id = (thread as unknown as { thread_id: string }).thread_id
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
      JSON.stringify({ name: "presentation-chain", version: "1.0.0", skills: ["./skills"] })
    )
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "skills/presentation-review/SKILL.md",
    Buffer.from(
      "---\nname: presentation-review\ndescription: Presentation lifecycle verification\n---\nPRESENTATION_SKILL_BEGIN\n" +
        "Read the actual project and report only observed facts.\n".repeat(100) +
        "PRESENTATION_SKILL_TAIL\n"
    )
  )
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"draft-io",description:"Read or fill the current draft",immediate:true});return next(e)});
    on("command.run",{command:"draft-io"},async($,e)=>{
      const input=JSON.parse(e.args);const before=await $.prompt.read();
      if(input.action==="read")return {text:"DRAFT_RESULT:"+JSON.stringify(before)};
      const result=await $.prompt.fill({text:input.text,mode:input.mode||"replace"});
      return {text:"DRAFT_RESULT:"+JSON.stringify(result)}
    });
    on("prompt.fill",async($,e,next)=>{
      if(e.text==="CAS_STALE"||e.text==="REVOKED_STALE"){
        $.ui.log("PRESENTATION_FILL_WAIT:"+e.text);await $.clock.sleep(2500)
      }
      return next(e)
    });
    on("skill.prompt",async($,e)=>{
      $.ui.log("PRESENTATION_SKILL_BODY:"+JSON.stringify({head:e.text.includes("PRESENTATION_SKILL_BEGIN"),tail:e.text.includes("PRESENTATION_SKILL_TAIL")}));
      return {...e,text:e.text+"\\nPRESENTATION_SKILL_TRANSFORM"}
    });
    on("tool.describe",async($,e)=>({...e,description:e.description+" PRESENTATION_TOOL_TRANSFORM"}));
    on("prompt.section",async($,e,next)=>{const out=await next(e);return {text:out.text===null?null:out.text+"\\nPRESENTATION_SECTION_TRANSFORM"}});
    on("prompt.compose",async($,e)=>{
      const out=await $.prompt.compose();
      $.ui.log("PRESENTATION_COMPOSE_FACTS:"+JSON.stringify(e));
      return {sections:[{id:"presentation-chain:policy",text:"PRESENTATION_COMPOSE_POLICY",scope:"shared"},...out.sections]}
    });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "presentation-chain.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((row) => row.name === "presentation-chain")!
  assert(mod?.digest)
  await page.evaluate(
    ({ threadId, mod }) => window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!),
    { threadId, mod }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Mods 草稿与展示链路", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  await composer.waitFor({ state: "visible" })
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
  const enqueue = async (input: Record<string, unknown>) =>
    page.evaluate(
      async ({ threadId, input }) => {
        const descriptor = (await window.api.mods.commands(threadId)).find(
          (command) => command.command === "draft-io"
        )
        if (!descriptor) throw Error("Draft command unavailable")
        return window.api.mods.enqueue(threadId, descriptor, { text: JSON.stringify(input) })
      },
      { threadId, input }
    )
  const finish = async (id: string) => {
    await until(
      async () =>
        (await jobs()).some((job) => job.id === id && !["queued", "running"].includes(job.state)),
      "draft command finished"
    )
    return (await jobs()).find((job) => job.id === id)!
  }
  const result = async (input: Record<string, unknown>) => {
    const job = await finish((await enqueue(input)).id)
    assert(job.result?.text?.startsWith("DRAFT_RESULT:"), JSON.stringify(job))
    return JSON.parse(job.result.text.slice("DRAFT_RESULT:".length))
  }
  const evidence: Record<string, unknown> = {}
  const beforeRequests = requests.length
  await composer.fill("用户原始草稿😀")
  evidence.read = await result({ action: "read" })
  assert.equal((evidence.read as { text: string }).text, "用户原始草稿😀")
  evidence.fill = await result({ action: "fill", text: "插件写入的待确认草稿😀" })
  assert.equal((evidence.fill as { isFilled: boolean }).isFilled, true)
  assert.equal(await composer.inputValue(), "插件写入的待确认草稿😀")
  assert.equal(requests.length, beforeRequests)
  pass(
    "QuickJS prompt.read/fill reads and edits the real React draft without sending a model request"
  )
  await page.screenshot({ path: join(artifacts, "presentation-draft-filled.png") })

  await composer.fill("CAS_CAPTURED")
  const pending = await enqueue({ action: "fill", text: "CAS_STALE" })
  await until(
    async () => (await logs()).some((row) => row.text === "PRESENTATION_FILL_WAIT:CAS_STALE"),
    "fill hook waits after capturing actual draft"
  )
  await composer.fill("用户继续输入，必须保留😀")
  const conflict = await finish(pending.id)
  assert(conflict.result?.text?.startsWith("DRAFT_RESULT:"), JSON.stringify(conflict))
  evidence.conflict = JSON.parse(conflict.result.text.slice("DRAFT_RESULT:".length))
  assert.equal((evidence.conflict as { isFilled: boolean }).isFilled, false)
  assert.equal(await composer.inputValue(), "用户继续输入，必须保留😀")
  assert.equal(requests.length, beforeRequests)
  pass(
    "A waiting real prompt.fill hook cannot overwrite subsequent user typing because its draft revision is stale"
  )
  await page.screenshot({ path: join(artifacts, "presentation-draft-conflict.png") })

  const skill = (await page.evaluate(() => window.api.skills.listPlugins())).find(
    (item) => item.name === "presentation-review"
  )!
  assert(skill)
  const first = requests.length
  await composer.fill(
    "[mods-presentation-skill] Review the selected presentation skill.\n\n" +
      formatSkillUseBlock({ name: skill.name, path: skill.path })
  )
  await composer.press("Enter")
  await until(
    async () =>
      requests
        .slice(first)
        .some((request) => JSON.stringify(request).includes("PRESENTATION_SKILL_TRANSFORM")) &&
      (await page.getByText("PRESENTATION_SKILL_READ_DONE", { exact: true }).count()) > 0 &&
      !(await page.getByRole("button", { name: "停止生成", exact: true }).count()),
    "expanded Skill reaches real model request"
  )
  writeFileSync(
    join(artifacts, "presentation-model-requests.json"),
    JSON.stringify(requests.slice(first), null, 2)
  )
  const request = requests
    .slice(first)
    .find((request) => JSON.stringify(request).includes("PRESENTATION_SKILL_TRANSFORM")) as {
    messages: unknown
    tools?: { function?: { name: string; description?: string; parameters?: unknown } }[]
  }
  assert(JSON.stringify(request.messages).includes("PRESENTATION_SKILL_TRANSFORM"))
  const promptLogs = await logs()
  writeFileSync(join(artifacts, "presentation-ui-logs.json"), JSON.stringify(promptLogs, null, 2))
  const bodyLogs = promptLogs.filter((row) => row.text.startsWith("PRESENTATION_SKILL_BODY:"))
  assert(bodyLogs.length > 0)
  assert(
    bodyLogs.every((row) => {
      const value = JSON.parse(row.text.slice("PRESENTATION_SKILL_BODY:".length))
      return value.head === true && value.tail === true
    })
  )
  const readTool = request.tools?.find((tool) => tool.function?.name === "read_file")
  assert(
    readTool?.function?.description?.includes("PRESENTATION_TOOL_TRANSFORM"),
    JSON.stringify(request.tools)
  )
  assert(readTool.function.parameters)
  const modelText = JSON.stringify(request.messages)
  assert(modelText.includes("PRESENTATION_SECTION_TRANSFORM"))
  assert(modelText.includes("PRESENTATION_COMPOSE_POLICY"))
  const composition = (await logs()).find(row => row.text.startsWith("PRESENTATION_COMPOSE_FACTS:"))
  assert(composition)
  assert(JSON.parse(composition.text.slice("PRESENTATION_COMPOSE_FACTS:".length)).tools.includes("read_file"))
  pass("Installed compose SDK and section Hooks transform the real provider prompt with actual tools and no recursive self-call")
  evidence.modelRequest = request
  pass(
    "Real model input receives the full transformed installed Skill and tool descriptions while tool identity/schema remain present"
  )
  await page.screenshot({ path: join(artifacts, "presentation-model-boundary.png") })

  await composer.fill("撤权后应保留的用户草稿")
  const revoked = await enqueue({ action: "fill", text: "REVOKED_STALE" })
  await until(
    async () => (await logs()).some((row) => row.text === "PRESENTATION_FILL_WAIT:REVOKED_STALE"),
    "revocation fill hook waits"
  )
  await page.evaluate(({ threadId, name }) => window.api.mods.revokeFunction(threadId, name), {
    threadId,
    name: mod.name
  })
  await finish(revoked.id)
  assert.equal(await composer.inputValue(), "撤权后应保留的用户草稿")
  pass("Revoking the real plugin during its fill hook prevents a late composer write")
  evidence.jobs = await jobs()
  writeFileSync(join(artifacts, "presentation-evidence.json"), JSON.stringify(evidence, null, 2))
}
