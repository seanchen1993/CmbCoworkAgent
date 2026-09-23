import assert from "node:assert/strict"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyUiLog(
  page: Page,
  workspace: string,
  artifacts: string,
  logPath: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "ui-log-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "UI log E2E",
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
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "ui-log", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
    on("session.start", async ($, e, next) => {
      await $.command.register({name:"ui-log-show",description:"Log channels",immediate:true});
      await $.command.register({name:"ui-log-nested",description:"Nested log",immediate:true});
      await $.command.register({name:"ui-log-flood",description:"Bounded log",immediate:true}); return next(e);
    });
    on("command.run", {command:"ui-log-show"}, ($) => {
      $.ui.log("UI_LOG_VISIBLE"); $.ui.log("UI_LOG_DEBUG",{to:"debug"}); $.ui.log("UI_LOG_REDIRECT");
      return {text:"logged"};
    });
    on("command.run", {command:"ui-log-nested"}, ($) => { $.ui.log("UI_LOG_OUTER"); return {text:"nested"}; });
    on("command.run", {command:"ui-log-flood"}, ($) => {
      for(let i=0;i<20;i++) $.ui.log("UI_LOG_LONG "+"x".repeat(9000)); return {text:"bounded"};
    });
    on("ui.log", ($, e, next) => {
      if(e.text==="UI_LOG_OUTER") $.ui.log("UI_LOG_NESTED", {to:"debug"});
      return next({...e,to:e.text==="UI_LOG_REDIRECT"?"debug":e.to});
    });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "ui-log.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "ui-log")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI log E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const rail = page.locator("[data-function-logs]")
  const run = async (text: string) => {
    await composer.fill(text)
    await submit.click()
  }
  const settle = async (before: number) =>
    until(
      async () =>
        requests.length > before &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "normal model turn settles"
    )
  try {
    let before = requests.length
    await run("请确认当前任务。[ui-log-initial]")
    await settle(before)
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    before = requests.length
    await run("/ui-log-show now")
    await until(
      async () => (await page.evaluate((id) => window.api.mods.logs(id), threadId)).length === 1,
      "log published by real utility guest"
    )
    await until(
      async () => (await rail.count()) === 1 && (await rail.innerText()).includes("UI_LOG_VISIBLE"),
      "log appears in conversation footer"
    )
    assert(!(await rail.innerText()).includes("UI_LOG_DEBUG"))
    assert(!(await rail.innerText()).includes("UI_LOG_REDIRECT"))
    await until(
      async () =>
        readFileSync(logPath, "utf8").includes("[Function Mods] [ui-log] UI_LOG_REDIRECT"),
      "debug sink receives rewritten line"
    )
    const debug = readFileSync(logPath, "utf8")
    const lines = ["UI_LOG_VISIBLE", "UI_LOG_DEBUG", "UI_LOG_REDIRECT"].map((text) =>
      debug.indexOf(`[Function Mods] [ui-log] ${text}`)
    )
    assert(lines[0] >= 0 && lines[0] < lines[1] && lines[1] < lines[2])
    assert.equal(requests.length, before)
    assert.deepEqual(
      await page.evaluate((id) => window.api.threads.getMessages(id), threadId),
      messages
    )
    await page.screenshot({ path: join(artifacts, "ui-log-channels.png") })
    pass(
      "real guest logs preserve order in the host debug log and only transcript-targeted lines appear in UI; stored messages stay unchanged"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("UI log E2E", { exact: true }).first().click()
    await until(async () => (await rail.count()) === 1, "renderer reload restores live session log")
    await run("/ui-log-nested now")
    await until(
      async () => readFileSync(logPath, "utf8").includes("[Function Mods] [ui-log] UI_LOG_NESTED"),
      "nested logging survives normal utility invocation retirement"
    )
    const nestedDebug = readFileSync(logPath, "utf8")
    assert(
      nestedDebug.indexOf("[Function Mods] [ui-log] UI_LOG_OUTER") <
        nestedDebug.indexOf("[Function Mods] [ui-log] UI_LOG_NESTED")
    )
    assert(!(await rail.innerText()).includes("UI_LOG_NESTED"))
    pass(
      "nested utility-process log hooks preserve order without recursion or premature frame cancellation"
    )
    await run("/ui-log-flood now")
    await until(
      async () => (await page.evaluate((id) => window.api.mods.logs(id), threadId)).length === 22,
      "bounded flood settles"
    )
    const bounds = await rail.boundingBox()
    assert(bounds && bounds.height <= 192)
    await composer.fill("native composer usable")
    assert.equal(await composer.inputValue(), "native composer usable")
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(async () => (await rail.count()) === 0, "off removes log rows")
    assert.deepEqual(await page.evaluate((id) => window.api.mods.logs(id), threadId), [])
    before = requests.length
    await run("请确认当前任务。[ui-log-off]")
    await settle(before)
    assert(!JSON.stringify(requests.slice(before)).includes("UI_LOG_VISIBLE"))
    assert.equal(await rail.count(), 0)
    pass(
      "bounded log history leaves the composer usable; off restores native turns without sending plugin log text to the model"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await page.evaluate((id) => window.api.mods.commands(id), threadId)
    assert.deepEqual(await page.evaluate((id) => window.api.mods.logs(id), threadId), [])
    await run("/ui-log-show now")
    await until(async () => (await rail.count()) === 1, "fresh session log")
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "ui-log"), threadId)
    await until(async () => (await rail.count()) === 0, "revocation removes log rows")
    pass(
      "runtime replacement starts a fresh log and revocation removes its presentation without changing historical model messages"
    )
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
