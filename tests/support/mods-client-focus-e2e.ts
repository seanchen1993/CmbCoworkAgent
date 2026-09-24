import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyClientFocus(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "client-focus")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Client focus",
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
    Buffer.from(JSON.stringify({ name: "client-focus", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let mode="success";
    on("session.start",async($,e,next)=>{
      for(const name of ["cf-open","cf-request"])await $.command.register({name,description:name,immediate:true});return next(e)
    });
    on("command.run",{command:"cf-open"},async($)=>{await $.ui.open({id:"board",title:"Client focus"});return {}});
    on("command.run",{command:"cf-request"},async($)=>({text:JSON.stringify(await $.ui.focus({requestId:"board",key:"target"}))}));
    on("ui.render",{component:"Pane",requestId:"board"},($,e)=>{
      const {Box,Client,Button}=$.ui.resolve(e);return <Box>
        <Client key="surface" module="./surface.tsx"/>
        <Button key="native" label="Native to Client" onPress={async()=>{
          mode="native";$.ui.log("FOCUS:native:"+JSON.stringify(await $.ui.focus({requestId:"board",key:"target"})))
        }}/>
      </Box>
    });
    on("ui.message",{element:"surface"},async($,e)=>{
      mode=e.data.mode;const answer=await $.ui.focus({requestId:"board",key:"target"});
      $.ui.log("FOCUS:"+e.data.mode+":"+JSON.stringify(answer));return {}
    });
    on("ui.focus",{component:"Pane"},async($,e,next)=>{
      const current=mode;
      if(["race","reload","revoke","off"].includes(current)){$.ui.log("WAIT:"+current);await $.clock.sleep(1000)}
      const result=await next(current==="rewrite"?{...e,element:"native"}:e);
      return current==="veto"?{deny:""}:result
    })
  }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Surface(props,s){
    const {Box,Button,Input}=s.elements;
    return <Box>{["success","veto","rewrite","race","reload","revoke","off"].map(mode=>
      <Button key={mode} label={"Client "+mode} onPress={()=>s.post({mode})}/>)}
      <Input key="target" label="Client target" value="" onSubmit={()=>{}}/>
    </Box>
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "client-focus.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "client-focus"
  )!
  assert(mod?.digest)
  const digest = mod.digest
  const approve = () =>
    page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest }
    )
  await approve()
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Client focus", { exact: true }).first().click()
  const run = async (command: string) => {
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
      (row) => row.command === command
    )!
    assert(descriptor)
    const job = await page.evaluate(
      ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
      { id, descriptor }
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
          (row) => row.id === job.id && row.state === "succeeded"
        ),
      command
    )
    return (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
      (row) => row.id === job.id
    )!
  }
  const pane = () => page.locator('[data-function-pane="board"]')
  const composer = page.locator("textarea.composer-textarea")
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), id)
  const hasLog = async (text: string) => (await logs()).some((row) => row.text === text)
  const waitLog = (text: string) => until(() => hasLog(text), text)
  const result = async (mode: string) => {
    const prefix = "FOCUS:" + mode + ":"
    await until(async () => (await logs()).some((row) => row.text.startsWith(prefix)), prefix)
    return JSON.parse(
      (await logs()).find((row) => row.text.startsWith(prefix))!.text.slice(prefix.length)
    )
  }
  const click = (mode: string) =>
    pane()
      .getByRole("button", { name: "Client " + mode, exact: true })
      .click()
  const active = () =>
    page.evaluate(() => {
      const node = document.activeElement as HTMLElement
      return {
        key: node?.dataset.functionControl,
        handle: node?.dataset.functionHandle,
        client: node?.closest<HTMLElement>("[data-function-client-instance]")?.dataset
          .functionClientInstance
      }
    })
  const modelCount = requests.length
  await run("cf-open")
  await click("success")
  assert.deepEqual(await result("success"), {})
  const focused = await active()
  assert.equal(focused.key, "target")
  const snapshot = (await page.evaluate((id) => window.api.mods.panes(id), id))[0]
  assert.equal(focused.client, snapshot.clients![0].id)
  assert.match(focused.handle!, /^\d+$/)
  await page.screenshot({ path: join(artifacts, "client-focus-success.png") })
  pass(
    "actual Client post awaits parent SDK focus and receives a real DOM acknowledgement without queue deadlock"
  )
  await click("veto")
  assert.deepEqual(await result("veto"), { deny: "" })
  assert.equal((await active()).key, "veto")
  pass("after-next empty veto leaves focus on the original Client control")
  await click("rewrite")
  assert.deepEqual(await result("rewrite"), {})
  assert.equal((await active()).key, "native")
  assert.equal((await active()).client, undefined)
  await pane().getByRole("button", { name: "Native to Client", exact: true }).click()
  await waitLog("FOCUS:native:{}")
  assert.equal((await active()).key, "target")
  pass("owned focus moves both Client-to-native by hook rewrite and native-to-Client by SDK")
  await composer.fill("keep original composer")
  assert.equal(typeof JSON.parse((await run("cf-request")).result!.text).deny, "string")
  assert(await composer.evaluate((node) => document.activeElement === node))
  pass("Client focus requests cannot take keyboard ownership from the native composer")
  await click("race")
  await waitLog("WAIT:race")
  await composer.fill("person wins")
  assert.equal(typeof (await result("race")).deny, "string")
  assert(await composer.evaluate((node) => document.activeElement === node))
  assert.equal(await composer.inputValue(), "person wins")
  pass("person intent during a pending Client focus request preserves composer focus and text")
  await click("reload")
  await waitLog("WAIT:reload")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Client focus", { exact: true }).first().click()
  assert.equal(typeof (await result("reload")).deny, "string")
  assert.notEqual((await active()).key, "target")
  pass("renderer reload cannot replay the old Client focus ownership probe")
  await click("revoke")
  await waitLog("WAIT:revoke")
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "client-focus"), id)
  await until(async () => (await pane().count()) === 0, "revoked Client Pane removed")
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "client-focus"
    )!.state,
    "needs-approval"
  )
  pass("durable revocation removes a pending Client focus request and its actual Pane")
  await approve()
  await run("cf-open")
  await click("off")
  await waitLog("WAIT:off")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await page.waitForTimeout(1200)
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), id), [])
  await until(async () => (await pane().count()) === 0, "off removes pending Client Pane")
  await composer.fill("Original composer with Client focus off")
  assert.equal(await composer.inputValue(), "Original composer with Client focus off")
  assert.equal(requests.length, modelCount)
  await page.screenshot({ path: join(artifacts, "client-focus-off.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  assert.equal(await hasLog("FOCUS:off:{}"), false)
  pass(
    "global off aborts pending Client focus without a late success, extra model call or composer regression"
  )
}
