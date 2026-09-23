import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyImperativeScroll(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "imperative-scroll-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Imperative scroll E2E",
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
    Buffer.from(JSON.stringify({ name: "imperative-scroll", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"scroll-open",description:"Open scroll test"});
      await $.command.register({name:"scroll-go",description:"Scroll test"});return next(e)
    });
    on("command.run",{command:"scroll-open"},async($)=>{await $.ui.open({id:"scroll-demo",title:"Imperative scroll",rows:6});return {text:"SCROLL_OPENED"}});
    on("command.run",{command:"scroll-go"},async($,e)=>{
      const mode=e.args;await $.store.set("mode",mode);
      if(mode==="grow"){await $.store.set("extra",(await $.store.get("extra")||0)+30);$.ui.invalidate("ui.render");return {text:"SCROLL_GROWN"}}
      const args=mode==="key"?{to:{key:"last"},in:"scroll-demo",block:"center"}:
        mode==="foreign"?{to:"end",in:"foreign"}:{to:mode==="start"?"start":"end",in:"scroll-demo"};
      let result;try{result=await $.ui.scroll(args)}catch(error){result={error:error.code}}
      $.ui.log("RESULT:"+mode+":"+JSON.stringify(result));return {text:"SCROLL_RESULT:"+mode}
    });
    on("ui.scroll",async($,e,next)=>{
      if(!e.origin||e.origin.kind!=="plugin")return next(e);
      $.ui.log("GEOMETRY:"+JSON.stringify(e));
      const mode=await $.store.get("mode");
      if(mode==="delay"||mode==="reload"||mode==="revoke"){$.ui.log("WAIT:"+mode);await $.clock.sleep(1000)}
      const result=await next(mode==="rewrite"?{...e,offset:2}:e);
      return mode==="veto"?{deny:""}:result
    });
    on("ui.render",{component:"Pane"},async($,e)=>{
      const {Box,Text,Button}=$.ui.resolve(e);
      return Box({flexDirection:"column",children:[
        ...Array.from({length:60},(_,i)=>Text({children:"Measured scroll row "+i})),
        Button({key:"last",label:"Bottom target",onPress(){}}),
        ...Array.from({length:await $.store.get("extra")||0},(_,i)=>Text({children:"Appended scroll row "+i}))
      ]})
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "imperative-scroll.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((row) => row.name === "imperative-scroll")!
  assert(mod.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Imperative scroll E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const send = async (text: string) => {
    await composer.fill(text)
    await submit.click()
  }
  const pane = page.locator('[data-function-pane="scroll-demo"]')
  const body = pane.locator(".overflow-auto.text-sm")
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const result = async (mode: string) => {
    await until(
      async () => (await logs()).some((row) => row.text.startsWith(`RESULT:${mode}:`)),
      `scroll ${mode} result`
    )
    const value = (await logs()).findLast((row) => row.text.startsWith(`RESULT:${mode}:`))!
    const parsed = JSON.parse(value.text.slice(`RESULT:${mode}:`.length))
    writeFileSync(join(artifacts, `scroll-result-${mode}.json`), JSON.stringify(parsed, null, 2))
    return parsed
  }
  const position = () =>
    body.evaluate((element) => ({
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
      row: parseFloat(getComputedStyle(element).lineHeight)
    }))
  const count = requests.length
  await send("/scroll-open now")
  await body.waitFor()
  assert((await position()).max > 100)
  await send("/scroll-go end")
  assert.deepEqual(await result("end"), {})
  assert(Math.abs((await position()).top - (await position()).max) <= 1)
  pass(
    "imperative scroll measures and moves the actual owned Pane body through a real guest and session"
  )
  const beforeGrowth = await position()
  await send("/scroll-go grow")
  await until(async () => (await position()).max > beforeGrowth.max, "actual plugin drawing grows")
  await until(
    async () => Math.abs((await position()).top - (await position()).max) <= 1,
    "end follows growing content"
  )
  await body.hover()
  await page.mouse.wheel(0, -100)
  await until(
    async () => (await position()).top < (await position()).max - 50,
    "person leaves the bottom"
  )
  const stopped = await position()
  await send("/scroll-go grow")
  await until(async () => (await position()).max > stopped.max, "drawing grows after person scroll")
  assert.equal((await position()).top, stopped.top)
  pass("end follows real drawing growth until a person moves the body, then remains stopped")
  await send("/scroll-go start")
  assert.deepEqual(await result("start"), {})
  assert.equal((await position()).top, 0)
  await send("/scroll-go key")
  assert.deepEqual(await result("key"), {})
  const visible = await pane
    .getByRole("button", { name: "Bottom target", exact: true })
    .evaluate((element) => {
      const target = element.getBoundingClientRect(),
        body = element.closest(".overflow-auto")!.getBoundingClientRect()
      return target.top >= body.top - 1 && target.bottom <= body.bottom + 1
    })
  assert(visible)
  assert.equal(await pane.evaluate((element) => element.contains(document.activeElement)), false)
  pass("start and a native owned key resolve against real layout without moving keyboard focus")
  await send("/scroll-go rewrite")
  assert.deepEqual(await result("rewrite"), {})
  const rewritten = await position()
  assert(Math.abs(rewritten.top - 2 * rewritten.row) <= 1)
  await send("/scroll-go veto")
  assert.deepEqual(await result("veto"), { deny: "" })
  assert.equal((await position()).top, rewritten.top)
  await send("/scroll-go foreign")
  assert.equal(typeof (await result("foreign")).deny, "string")
  pass("only offset is mutable and a late empty veto or foreign target never moves the Pane")
  await send("/scroll-go delay")
  await until(
    async () => (await logs()).some((row) => row.text === "WAIT:delay"),
    "scroll hook waits"
  )
  await body.hover()
  await page.mouse.wheel(0, 100)
  await until(
    async () => (await position()).top > rewritten.top,
    "actual person wheel moves the body"
  )
  const moved = (await position()).top
  const competing = await result("delay")
  assert(
    typeof competing.deny === "string" || competing.error === "MODS_UI_SCROLL_STALE",
    JSON.stringify(competing)
  )
  assert.equal((await position()).top, moved)
  pass("a real wheel movement defeats an older pending plugin scroll")
  await send("/scroll-go reload")
  await until(
    async () => (await logs()).some((row) => row.text === "WAIT:reload"),
    "reload hook waits"
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Imperative scroll E2E", { exact: true }).first().click()
  assert.equal(typeof (await result("reload")).deny, "string")
  pass("a renderer reload cannot reuse a previous scroll measurement")
  await page.screenshot({ path: join(artifacts, "imperative-scroll-on.png") })
  await send("/scroll-go revoke")
  await until(
    async () => (await logs()).some((row) => row.text === "WAIT:revoke"),
    "revoke hook waits"
  )
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "imperative-scroll"), threadId)
  await until(async () => (await pane.count()) === 0, "revocation removes pending scroll site")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), threadId), [])
  await composer.fill("native composer with scroll Mods off")
  assert.equal(await composer.inputValue(), "native composer with scroll Mods off")
  assert.equal(requests.length, count)
  await page.screenshot({ path: join(artifacts, "imperative-scroll-off.png") })
  writeFileSync(
    join(artifacts, "imperative-scroll-evidence.json"),
    JSON.stringify(
      {
        actualDom: true,
        actualGuest: true,
        actualSession: true,
        lateVeto: true,
        rewrittenOffset: true,
        competingWheel: true,
        reload: true,
        revoke: true,
        off: true,
        modelRequests: requests.length - count
      },
      null,
      2
    )
  )
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass(
    "revocation and off remove scroll requests while original composer and model count remain unchanged"
  )
}
