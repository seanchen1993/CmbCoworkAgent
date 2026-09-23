import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifySessionTitle(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "session-title-project")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Session title E2E",
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
    Buffer.from(JSON.stringify({ name: "session-title", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("classic.SessionStart",async($,e,next)=>{await next(e);return {sessionTitle:"Startup checked title"}});
    on("classic.UserPromptSubmit",async($,e,next)=>{
      const lower=await next(e);
      if(e.prompt.includes("[title-start-only]")) return lower;
      if(e.prompt.includes("[title-hold]")){
        $.ui.log("TITLE_WAITING");await $.clock.sleep(3000);$.ui.log("TITLE_COMPLETED");
        return {...lower,sessionTitle:"Late title must not win"}
      }
      if(e.prompt.includes("[title-stall]")){
        await $.model.complete({model:"custom:mods-model-fixture",prompt:"[stall] title review",maxTokens:64});
        $.ui.log("LATE_TITLE");return {sessionTitle:"Cancelled title"}
      }
      return {...lower,sessionTitle:"Prompt checked title"}
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "session-title.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (m) => m.name === "session-title"
  )!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Session title E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const readTitle = async () => (await page.evaluate((id) => window.api.threads.get(id), id))?.title
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), id)
  const stopped = async () =>
    (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
  let first = requests.length
  await send("[title-start-only] inspect this task")
  await until(
    async () =>
      requests.length === first + 1 &&
      (await stopped()) &&
      (await readTitle()) === "Startup checked title",
    "actual SessionStart updates title"
  )
  await until(
    async () => (await page.getByText("Startup checked title", { exact: true }).count()) > 0,
    "sidebar receives native thread refresh"
  )
  pass(
    "real classic SessionStart persists a title and refreshes the existing sidebar without extra model calls"
  )
  first = requests.length
  await send("[title-prompt] inspect next task")
  await until(
    async () =>
      requests.length === first + 1 &&
      (await stopped()) &&
      (await readTitle()) === "Prompt checked title",
    "actual prompt title"
  )
  assert(JSON.stringify(requests[first]).includes("[title-prompt] inspect next task"))
  pass("real UserPromptSubmit changes only the title while preserving the original model input")
  await page.screenshot({ path: join(artifacts, "session-title-on.png") })
  first = requests.length
  await send("[title-hold] concurrent rename")
  await until(
    async () => (await logs()).some((row) => row.text === "TITLE_WAITING"),
    "title proposal is pending"
  )
  await page.evaluate(async (id) => {
    await window.api.threads.update(id, { title: "Human temporary name" })
    await window.api.threads.update(id, { title: "Prompt checked title" })
  }, id)
  await until(
    async () =>
      requests.length === first + 1 &&
      (await stopped()) &&
      (await logs()).some((row) => row.text === "TITLE_COMPLETED"),
    "late title completed after human rename"
  )
  assert.equal(await readTitle(), "Prompt checked title")
  pass("real concurrent user A/B/A rename wins over a later guest title proposal")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Prompt checked title", { exact: true }).first().click()
  assert.equal(await readTitle(), "Prompt checked title")
  pass("committed title survives renderer reload through the original thread database")
  await page.evaluate(async (id) => {
    await window.api.mods.configureGlobal(false)
    await window.api.threads.update(id, { title: "Off title stays" })
  }, id)
  first = requests.length
  await send("[title-prompt] inspect next task")
  await until(async () => requests.length === first + 1 && (await stopped()), "off task unchanged")
  assert.equal(await readTitle(), "Off title stays")
  assert.deepEqual(await logs(), [])
  pass("same task with Mods off leaves the human title unchanged and creates no title hook work")
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  for (const action of ["cancel", "revoke"] as const) {
    first = requests.length
    const closed = closedStalls()
    await send("[title-stall] pending title")
    await until(async () => requests.length === first + 1, "title hook enters real model transport")
    assert(JSON.stringify(requests[first]).includes("[stall] title review"))
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else await page.evaluate((id) => window.api.mods.revokeFunction(id, "session-title"), id)
    await until(
      async () => closedStalls() > closed && (await stopped()),
      "stale title review aborts"
    )
    assert.equal(await readTitle(), "Off title stays")
    assert.equal(requests.length, first + 1)
    assert(!(await logs()).some((row) => row.text === "LATE_TITLE"))
    pass(
      action +
        " cancels the real title review without changing the title or invoking the main model"
    )
  }
}
