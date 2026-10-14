import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

/** Actual delete IPC, configured classic command, guests, SQLite and native before-quit. */
export async function verifySessionEnd(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  controlPath: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "session-end")
  mkdirSync(project, { recursive: true })
  const create = (title: string) =>
    page.evaluate(
      async ({ project, title }) => {
        const thread = await window.api.threads.create({
          title,
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, title }
    )
  const read = (key: string) => {
    const db = new DatabaseSync(controlPath, { readOnly: true })
    try {
      // Production owns workspace normalization. Select the exact UUID-keyed fixture row,
      // then verify its plugin namespace instead of duplicating Windows normalization.
      const rows = db
        .prepare("SELECT namespace,value FROM mods_function_state WHERE key=?")
        .all(key)
        .filter((row) => JSON.parse(String(row.namespace))[1] === "session-end-proof")
      assert(rows.length <= 1)
      const row = rows[0]
      return row ? JSON.parse(String(row.value)) : undefined
    } finally {
      db.close()
    }
  }
  const legacyFile = join(project, "classic-end.jsonl")
  const legacyScript = join(project, "classic-end.cjs")
  writeFileSync(
    legacyScript,
    `const fs=require("node:fs");let input="";
    process.stdin.on("data",chunk=>input+=chunk);
    process.stdin.on("end",()=>setTimeout(()=>{
      const e=JSON.parse(input);fs.appendFileSync(${JSON.stringify(legacyFile)},JSON.stringify({
        id:e.session_id,reason:e.reason})+"\\n");process.stdout.write("{}");
    },260));`
  )
  // Installed Plugin hooks require that Plugin to be active in the legacy skill scope.
  // This fixture uses the existing settings API for an actually enabled settings hook.
  const classicHook = await page.evaluate(
    ({ command, shell }) =>
      window.api.hooks.create({
        event: "SessionEnd",
        type: "command",
        enabled: true,
        command,
        shell,
        timeout: 3000
      }),
    {
      command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${legacyScript}"`,
      shell: process.platform === "win32" ? ("powershell" as const) : ("sh" as const)
    }
  )
  const plugin = new AdmZip()
  plugin.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "session-end-proof", version: "1.0.0" }))
  )
  plugin.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  plugin.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{
      const id=await $.session.id();await $.store.set("starts:"+id,(await $.store.get("starts:"+id)??0)+1);
      await $.command.register({name:"end-proof",description:"结束通知验证",immediate:true});return next(e);
    });
    on("command.run",{command:"end-proof"},async($)=>({text:"组件已经运行"}));
    on("classic.SessionEnd",async($,e,next)=>{
      await $.store.set("classic:"+e.session_id,true);return next(e);
    });
    on("session.end",async($,e,next)=>{
      const previous=await $.store.get("end:"+e.sessionId);
      const legacy=await $.fs.exists(${JSON.stringify(legacyFile)})?await $.fs.read(${JSON.stringify(legacyFile)}):"";
      await $.store.set("end:"+e.sessionId,{...e,count:(previous?.count??0)+1,
        classic:await $.store.get("classic:"+e.sessionId)??false,legacy,budget:next.budget});
      if(await $.store.get("hang:"+e.sessionId))await new Promise(()=>{});
      return next(e);
    });
  }`)
  )
  for (const [zip, name] of [[plugin, "session-end-proof"]] as const) {
    const installed = await page.evaluate(
      ({ bytes, name }) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, name + ".zip", "local"),
      { bytes: [...zip.toBuffer()], name }
    )
    assert(installed.success, installed.error)
  }
  const id = await create("会话结束实际验收")
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "session-end-proof"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
    { id, mod }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("会话结束实际验收", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Reply briefly to this session end verification.")
  await composer.press("Enter")
  await until(
    async () =>
      Boolean(read("starts:" + id)) &&
      !(await page.getByRole("button", { name: "停止生成", exact: true }).count()),
    "actual conversation completed"
  )
  await page.screenshot({ path: join(artifacts, "session-end-before-delete.png") })
  await page.evaluate((id) => window.api.threads.delete(id), id)
  const ended = read("end:" + id)
  assert.equal(ended?.reason, "clear")
  assert.equal(ended?.sessionId, id)
  assert.deepEqual(ended?.resume, { id })
  assert.equal(ended?.count, 1)
  assert.equal(ended?.classic, true)
  const legacyRows = (existsSync(legacyFile) ? readFileSync(legacyFile, "utf8") : "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row))
  assert.deepEqual(
    legacyRows.filter((row) => row.id === id),
    [{ id, reason: "clear" }]
  )
  assert(JSON.stringify(ended.legacy).includes(id))
  assert(ended.budget.ms > 1200 && ended.budget.ms <= 1500)
  pass(
    "Actual deletion completes the original configured command once before Mods observes the real ID and clear reason"
  )
  writeFileSync(join(artifacts, "session-end-delete-receipt.json"), JSON.stringify(ended, null, 2))

  const cold = await create("从未运行的组件")
  const startedCold = read("starts:" + cold)
  assert.equal(startedCold, undefined)
  await page.evaluate((id) => window.api.threads.delete(id), cold)
  assert.equal(read("starts:" + cold), undefined)
  assert.equal(read("end:" + cold), undefined)
  pass("Deleting a cold real thread never starts or notifies its approved component")

  const legacyQuit = await create("原退出脚本实际验证")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("原退出脚本实际验证", { exact: true }).first().click()
  const quitComposer = page.locator("textarea.composer-textarea")
  await quitComposer.fill("Reply briefly for the original shutdown verification.")
  await quitComposer.press("Enter")
  await until(
    async () =>
      Boolean(read("starts:" + legacyQuit)) &&
      !(await page.getByRole("button", { name: "停止生成", exact: true }).count()),
    "original shutdown conversation completed"
  )
  assert(
    (await page.evaluate(() => window.api.hooks.list())).some(
      (hook) => hook.id === classicHook.id && hook.enabled
    )
  )

  const quit = await create("仅组件命令创建的会话")
  const commands = await page.evaluate((id) => window.api.mods.commands(id), quit)
  assert(commands.some((command) => command.command === "end-proof"))
  assert.equal(read("starts:" + quit), 1)
  // Only the isolated fixture row is changed: no production API for forcing a hang.
  const db = new DatabaseSync(controlPath)
  try {
    const row = db
      .prepare("SELECT namespace FROM mods_function_state WHERE key=?")
      .all("starts:" + quit)
      .find((row) => JSON.parse(String(row.namespace))[1] === "session-end-proof")
    assert(row)
    db.prepare("INSERT INTO mods_function_state VALUES(?,?,?)").run(
      String(row.namespace),
      "hang:" + quit,
      "true"
    )
  } finally {
    db.close()
  }
  const began = performance.now()
  await app.close()
  const durationMs = performance.now() - began
  const quitReceipt = read("end:" + quit)
  assert.equal(quitReceipt?.reason, "logout")
  assert.equal(quitReceipt?.sessionId, quit)
  assert.equal(quitReceipt?.count, 1)
  const legacyQuitRows = readFileSync(legacyFile, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row))
  assert.deepEqual(
    legacyQuitRows.filter((row) => row.id === legacyQuit),
    [{ id: legacyQuit, reason: "logout" }]
  )
  assert(JSON.stringify(read("end:" + legacyQuit)?.legacy).includes(legacyQuit))
  pass(
    "Actual before-quit completes the original command with logout before notifying its Mods component"
  )
  assert(durationMs >= 1200 && durationMs < 10000)
  writeFileSync(
    join(artifacts, "session-end-quit-receipt.json"),
    JSON.stringify({ durationMs, receipt: quitReceipt }, null, 2)
  )
  pass(
    "Actual before-quit reaches a Mods-only session and bounds its hanging hook without replay or blocking application exit"
  )
}
