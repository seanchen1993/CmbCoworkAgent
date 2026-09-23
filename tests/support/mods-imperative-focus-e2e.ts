import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyImperativeFocus(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "imperative-focus-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Imperative focus E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "imperative-focus", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"focus-open",description:"Open focus test"});
      await $.command.register({name:"focus-request",description:"Request focus"});return next(e)
    });
    on("command.run",{command:"focus-open"},async($)=>{await $.ui.open({id:"focus-demo",title:"Imperative focus"});return {text:"FOCUS_OPENED"}});
    on("command.run",{command:"focus-request"},async($)=>({text:"COMMAND_FOCUS:"+JSON.stringify(await $.ui.focus({requestId:"focus-demo",key:"target"}))}));
    on("ui.input",async($,e,next)=>{await $.store.set("mode",e.value);return next(e)});
    on("ui.focus",async($,e,next)=>{
      const mode=await $.store.get("mode");
      if(mode==="delay"||mode==="reload"||mode==="revoke") { $.ui.log("WAIT:"+mode);await $.clock.sleep(1000) }
      const result=await next(mode==="rewrite"?{...e,element:"alternate"}:e);
      return mode==="empty-veto"?{deny:""}:mode==="veto"?{deny:"kept original focus"}:result
    });
    on("ui.render",{component:"Pane"},($,e)=>{
      const {Box,Input,Button}=$.ui.resolve(e);
      return Box({children:[
        Input({key:"source",label:"Focus source",onSubmit(){},onInput:async(value)=>{
          const result=await $.ui.focus({requestId:"focus-demo",key:"target"});
          $.ui.log("RESULT:"+value+":"+JSON.stringify(result))
        }}),
        Button({key:"button-source",label:"Focus by button",onPress:async()=>{
          $.ui.log("PRESS_WAIT");await $.clock.sleep(300);
          $.ui.log("PRESS_RESULT:"+JSON.stringify(await $.ui.focus({requestId:"focus-demo",key:"source"})))
        }}),
        Button({key:"target",label:"Focus target",onPress(){}}),
        Button({key:"alternate",label:"Focus alternate",onPress(){}})
      ]})
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "imperative-focus.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((row) => row.name === "imperative-focus")!
  assert(mod.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Imperative focus E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const send = async (text: string) => {
    await composer.fill(text)
    await submit.click()
  }
  const pane = page.locator('[data-function-pane="focus-demo"]')
  const source = pane.getByLabel("Focus source", { exact: true })
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const hasLog = async (prefix: string) => (await logs()).some((row) => row.text.startsWith(prefix))
  const focused = (key: string) =>
    page.evaluate(
      (key) => (document.activeElement as HTMLElement)?.dataset.functionControl === key,
      key
    )
  const modelCount = requests.length
  await send("/focus-open now")
  await source.waitFor()
  await source.fill("success")
  await until(() => hasLog("RESULT:success:{}"), "SDK receives an actual focus acknowledgement")
  assert(await focused("target"))
  await page.screenshot({ path: join(artifacts, "imperative-focus-success.png") })
  pass("imperative focus moves the real DOM and settles an awaiting guest callback without a model")

  const buttonSource = pane.getByRole("button", { name: "Focus by button", exact: true })
  await buttonSource.click()
  await until(() => hasLog("PRESS_WAIT"), "button callback is pending")
  await buttonSource.press("Enter")
  await until(() => hasLog("PRESS_RESULT:"), "button callback receives its focus result")
  assert(
    (await logs()).some((row) => row.text === "PRESS_RESULT:{}"),
    "busy controls must retain keyboard ownership for SDK focus"
  )
  assert.equal((await logs()).filter((row) => row.text === "PRESS_WAIT").length, 1)
  assert(await focused("source"))
  pass(
    "a busy button retains keyboard ownership for SDK focus while duplicate activation remains blocked"
  )

  await source.fill("veto")
  await until(() => hasLog('RESULT:veto:{"deny"'), "late hook veto remains authoritative")
  assert(await focused("source"))
  await source.fill("empty-veto")
  await until(() => hasLog('RESULT:empty-veto:{"deny":""}'), "empty denial also prevents DOM focus")
  assert(await focused("source"))
  pass("an explicit empty deny string preserves actual focus before the chain can move it")
  await source.fill("rewrite")
  await until(() => hasLog("RESULT:rewrite:{}"), "hook-rewritten target acknowledged")
  assert(await focused("alternate"))
  pass(
    "focus middleware can veto after next or select another owned drawn target before any DOM move"
  )

  await send("/focus-request now")
  await until(
    async () => (await page.getByText('COMMAND_FOCUS:{"deny"', { exact: false }).count()) > 0,
    "composer ownership refuses a command focus request"
  )
  assert(!(await focused("target")))
  pass("SDK focus refuses to steal keyboard ownership from the native composer")

  await source.fill("delay")
  await until(() => hasLog("WAIT:delay"), "focus hook waits")
  await composer.fill("keep typing")
  await until(() => hasLog('RESULT:delay:{"deny"'), "competing person intent invalidates focus")
  assert(await composer.evaluate((element) => document.activeElement === element))
  assert.equal(await composer.inputValue(), "keep typing")
  pass("a new person intent cancels a pending focus move and preserves native composer text")

  await source.fill("reload")
  await until(() => hasLog("WAIT:reload"), "reload focus hook waits")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Imperative focus E2E", { exact: true }).first().click()
  await until(
    () => hasLog('RESULT:reload:{"deny"'),
    "reload cannot replay a keyboard ownership acknowledgement"
  )
  assert(!(await focused("target")))
  pass("renderer reload cannot reuse a focus ownership probe from its previous lifecycle")

  await source.fill("revoke")
  await until(() => hasLog("WAIT:revoke"), "revocation focus hook waits")
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "imperative-focus"), threadId)
  await until(async () => (await pane.count()) === 0, "revocation removes the pending pane")
  assert(!(await focused("target")))
  assert.equal(requests.length, modelCount)
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), threadId), [])
  await composer.fill("native composer with Mods off")
  assert.equal(await composer.inputValue(), "native composer with Mods off")
  await page.screenshot({ path: join(artifacts, "imperative-focus-off.png") })
  writeFileSync(
    join(artifacts, "imperative-focus-evidence.json"),
    JSON.stringify(
      {
        actualDom: true,
        actualGuest: true,
        actualSession: true,
        lateVeto: true,
        emptyVeto: true,
        rewrittenTarget: true,
        composerOwnership: true,
        competingIntent: true,
        reload: true,
        revoke: true,
        off: true,
        modelRequests: requests.length - modelCount
      },
      null,
      2
    )
  )
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass(
    "revocation and global off remove pending focus UI while leaving the original composer usable"
  )
}
