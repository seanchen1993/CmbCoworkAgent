import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyUiInvalidate(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "ui-invalidate")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "UI invalidation",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "ui-invalidation", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let revision=0;
    on("session.start",async($,e,next)=>{
      for(const name of ["inv-open","inv-redraw","inv-mode","inv-state"])
        await $.command.register({name,description:name,immediate:true});return next(e)
    });
    on("command.run",{command:"inv-open"},async($)=>{await $.ui.open({id:"invalidation",title:"Invalidation"});return {}});
    on("command.run",{command:"inv-mode"},async($,e)=>{await $.store.set("mode",e.args);return {}});
    on("command.run",{command:"inv-state"},async($)=>({text:JSON.stringify({
      calls:await $.store.get("calls")||0,after:await $.store.get("after")||0,input:await $.store.get("input")
    })}));
    on("command.run",{command:"inv-redraw"},($)=>{revision++;$.ui.invalidate("ui.render");return {text:"requested"}});
    on("ui.render",{component:"Pane",requestId:"invalidation"},($,e)=>{
      const {Text}=$.ui.resolve(e);return <Text>INVALIDATION_DRAW_{revision}</Text>
    });
    on("ui.invalidate",async($,e,next)=>{
      await $.store.set("calls",(await $.store.get("calls")||0)+1);await $.store.set("input",e);
      const mode=await $.store.get("mode");
      if(mode==="deny")return {deny:""};
      if(mode==="delay")await $.clock.sleep(5000);
      const value=await next(e);await $.store.set("after",(await $.store.get("after")||0)+1);return value
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "ui-invalidation.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (mod) => mod.name === "ui-invalidation"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI invalidation", { exact: true }).first().click()
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), id)
  const enqueue = async (command: string, text = "") => {
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
      (row) => row.command === command
    )!
    assert(descriptor)
    return page.evaluate(
      ({ id, descriptor, text }) => window.api.mods.enqueue(id, descriptor, { text }),
      { id, descriptor, text }
    )
  }
  const run = async (command: string, text = "") => {
    const job = await enqueue(command, text)
    await until(
      async () => (await jobs()).some((row) => row.id === job.id && row.state === "succeeded"),
      command
    )
    return (await jobs()).find((row) => row.id === job.id)!
  }
  const state = async () =>
    JSON.parse((await run("inv-state")).result!.text) as {
      calls: number
      after: number
      input?: unknown
    }
  const pane = () => page.locator('[data-function-pane="invalidation"]')
  await run("inv-open")
  await pane().getByText("INVALIDATION_DRAW_0", { exact: true }).waitFor()
  await run("inv-redraw")
  await pane().getByText("INVALIDATION_DRAW_1", { exact: true }).waitFor()
  assert.deepEqual(await state(), { calls: 1, after: 1, input: { event: "ui.render" } })
  pass("real void invalidation SDK enters its operation hook and redraws the live Pane")
  await run("inv-mode", "deny")
  const before = (await page.evaluate((id) => window.api.mods.panes(id), id)).find(
    (row) => row.id === "invalidation"
  )!.generation
  await run("inv-redraw")
  assert.deepEqual(await state(), { calls: 2, after: 1, input: { event: "ui.render" } })
  assert.equal(
    (await page.evaluate((id) => window.api.mods.panes(id), id)).find(
      (row) => row.id === "invalidation"
    )!.generation,
    before
  )
  await pane().getByText("INVALIDATION_DRAW_1", { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, "ui-invalidation-denied.png") })
  pass("an empty before-next deny preserves the current real drawing and skips core")
  await run("inv-mode", "delay")
  const delayed = await enqueue("inv-redraw")
  await until(async () => (await state()).calls === 3, "delayed operation entered")
  await page.evaluate(({ id, job }) => window.api.mods.cancelJob(id, job), { id, job: delayed.id })
  await until(
    async () => (await jobs()).some((row) => row.id === delayed.id && row.state === "unknown"),
    "invalidation cancelled"
  )
  const cancelledJob = (await jobs()).find((row) => row.id === delayed.id)!
  assert.equal(cancelledJob.error, "MODS_CANCELLED")
  assert.equal(cancelledJob.result, undefined)
  // Wait beyond the actual hook delay to detect late publication, not merely an early unchanged frame.
  await page.waitForTimeout(5200)
  assert.equal((await state()).after, 1)
  assert.equal(
    (await page.evaluate((id) => window.api.mods.panes(id), id)).find(
      (row) => row.id === "invalidation"
    )!.generation,
    before
  )
  pass(
    "original job cancellation prevents a delayed invalidation from publishing after its deadline"
  )
  const revoked = await enqueue("inv-redraw")
  await until(async () => (await state()).calls === 4, "revoked operation entered")
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "ui-invalidation"), id)
  await until(
    async () =>
      (await jobs()).some(
        (row) => row.id === revoked.id && !["queued", "running"].includes(row.state)
      ),
    "revoked operation settled"
  )
  const revokedJob = (await jobs()).find((row) => row.id === revoked.id)!
  assert.equal(revokedJob.state, "failed")
  assert.equal(revokedJob.error, "MODS_CANCELLED")
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (mod) => mod.name === "ui-invalidation"
    )!.state,
    "needs-approval"
  )
  await until(async () => (await pane().count()) === 0, "revocation removes Pane")
  pass("durable revocation cancels the original operation and removes its Pane")
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await run("inv-open")
  await pane().getByText("INVALIDATION_DRAW_0", { exact: true }).waitFor()
  const disabled = await enqueue("inv-redraw")
  await until(async () => (await state()).calls === 5, "operation pending before global off")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(
    async () =>
      (await jobs()).some(
        (row) => row.id === disabled.id && !["queued", "running"].includes(row.state)
      ),
    "disabled operation settled"
  )
  const disabledJob = (await jobs()).find((row) => row.id === disabled.id)!
  assert.equal(disabledJob.state, "failed")
  assert.equal(disabledJob.error, "MODS_CANCELLED")
  assert.equal(disabledJob.result, undefined)
  await page.waitForTimeout(5200)
  await until(async () => (await pane().count()) === 0, "global off removes pending Pane")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), id), [])
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original composer after invalidation off")
  assert.equal(await composer.inputValue(), "Original composer after invalidation off")
  await page.screenshot({ path: join(artifacts, "ui-invalidation-off.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  assert.equal((await state()).after, 1)
  assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), id), [])
  pass(
    "global off cancels a pending invalidation without late publication and preserves the native composer"
  )
}
