import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"

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
      await $.command.register({name:"ui-log-long",description:"Full protected long log",immediate:true});
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
    on("command.run", {command:"ui-log-long"}, ($) => {
      const prefix="UI_LOG_LONG_INPUT:", tail=":UI_LOG_LONG_END";
      $.ui.log(prefix+"x".repeat(30000-prefix.length-tail.length)+tail);
      return {text:"long logged"};
    });
    on("ui.log", ($, e, next) => {
      if(e.text.startsWith("UI_LOG_LONG_INPUT:")) {
        if(e.text.length!==30000 || !e.text.endsWith(":UI_LOG_LONG_END")) throw Error("UI_LOG_LONG_HOOK_FULL_REQUIRED");
        return next({...e,text:"UI_LOG_LONG_HOOK:sk-ui-long-fixture-token-123456789:"+e.text});
      }
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
  const openLogs = async () => {
    await openModsResults(page)
    const summary = page
      .getByRole("complementary", { name: "任务进展", exact: true })
      .getByText("灵件日志 · 查看补充说明", { exact: true })
    if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
      await summary.click()
  }
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
    await openLogs()
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    before = requests.length
    await run("/ui-log-show now")
    await until(
      async () => (await page.evaluate((id) => window.api.mods.logs(id), threadId)).length === 1,
      "log published by real utility guest"
    )
    await until(
      async () => (await rail.count()) === 1 && (await rail.innerText()).includes("UI_LOG_VISIBLE"),
      "log appears in the expanded task results"
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
    await openLogs()
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
    const longBefore = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    const longRequests = requests.length
    await run("/ui-log-long now")
    await until(
      async () => (await page.evaluate((id) => window.api.mods.logs(id), threadId)).length === 23,
      "full protected long log settles after the original flood"
    )
    const longSnapshot = await page.evaluate((id) => window.api.mods.logs(id), threadId)
    const longRow = longSnapshot.find(row => row.text.startsWith("UI_LOG_LONG_HOOK:"))
    assert(longRow)
    const rawPrefix = "UI_LOG_LONG_INPUT:", rawTail = ":UI_LOG_LONG_END"
    const raw = rawPrefix + "x".repeat(30000 - rawPrefix.length - rawTail.length) + rawTail
    const expected = (`UI_LOG_LONG_HOOK:[REDACTED]:${raw}`).slice(0, 10000)
    assert.equal(longRow.plugin, "ui-log")
    assert.equal(longRow.text, expected)
    assert.equal(longRow.text.length, 10000)
    const renderedLong = rail.locator(`[data-function-log="${longRow.id}"]`)
    await until(async () => await renderedLong.count() === 1, "the actual long log row is rendered")
    const displayText = await renderedLong.evaluate(element => element.lastChild?.textContent ?? "")
    assert.equal(displayText, expected.slice(0, 2000))
    const debugChunks = () => readFileSync(logPath, "utf8").split(/\r?\n/).flatMap(line => {
      const match = /^\[[^\]\r\n]+\] \[INFO\] \[Function Mods chunk\] (.+)$/.exec(line)
      if (!match) return []
      const value: unknown = JSON.parse(match[1])
      assert(value && typeof value === "object" && !Array.isArray(value))
      const row = value as Record<string, unknown>
      assert.deepEqual(Object.keys(row), ["recordId", "index", "count", "plugin", "text"])
      assert(typeof row.recordId === "string" && typeof row.plugin === "string" &&
        typeof row.text === "string" && typeof row.index === "number" &&
        Number.isInteger(row.index) && typeof row.count === "number" && Number.isInteger(row.count))
      assert(row.count >= 1 && row.count <= 6 && row.index >= 1 && row.index <= row.count)
      assert(row.text.length <= 2000)
      assert(match[0].length < 16384)
      return [row as { recordId: string; index: number; count: number; plugin: string; text: string }]
    })
    await until(async () => {
      const rows = debugChunks()
      const head = rows.find(row => row.plugin === "ui-log" && row.index === 1 &&
        row.text.startsWith("UI_LOG_LONG_HOOK:"))
      return !!head && rows.filter(row => row.recordId === head.recordId).length === head.count
    }, "the real debug log flushes every protected long-text chunk")
    const rows = debugChunks()
    const heads = rows.filter(row => row.plugin === "ui-log" && row.index === 1 &&
      row.text.startsWith("UI_LOG_LONG_HOOK:"))
    assert.equal(heads.length, 1)
    const group = rows.filter(row => row.recordId === heads[0].recordId)
    assert.deepEqual(group.map(row => row.index), group.map((_, index) => index + 1))
    assert(group.every(row => row.plugin === "ui-log" && row.count === group.length))
    assert.equal(group.map(row => row.text).join(""), expected)
    assert.equal(requests.length, longRequests)
    assert.deepEqual(await page.evaluate((id) => window.api.threads.getMessages(id), threadId), longBefore)
    await page.screenshot({ path: join(artifacts, "ui-log-long-protected.png") })
    writeFileSync(join(artifacts, "ui-log-long-evidence.json"), JSON.stringify({
      method: "ui.log", inputLength: 30000, snapshotLength: longRow.text.length,
      displayLength: displayText.length, debugEqualsSnapshot: true,
      protectedBeforeTruncation: true, transcriptUnchanged: true,
      screenshot: "ui-log-long-protected.png"
    }, null, 2))
    pass("30k real Guest log reaches the full Hook and protection before exact 10k debug/snapshot and 2k desktop projection")
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
