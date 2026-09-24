import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Real Client input/press IPC overlap. The guest delays handlers through the approved clock SDK. */
export async function verifyClientBusy(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "client-busy")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Client busy",
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
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "client-busy", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"busy-open",description:"Open busy regression",immediate:true});return next(e)
    });
    on("command.run",{command:"busy-open"},async($)=>{await $.ui.open({id:"busy-board",title:"Client busy"});return {}});
    on("ui.render",{component:"Pane",requestId:"busy-board"},async($,e)=>{
      const {Client}=$.ui.resolve(e);return <Client key="surface" module="./surface.tsx" props={{count:await $.store.get("count")||0}}/>
    });
    on("ui.input",{component:"Pane",element:"note"},async($,e,next)=>{
      if(e.kind==="change"){$.ui.log("BUSY_INPUT_WAIT");await $.clock.sleep(1000)}
      return next(e)
    });
    on("ui.press",{component:"Pane",element:"increment"},async($,e,next)=>{
      $.ui.log("BUSY_PRESS_WAIT");await $.clock.sleep(2000);return next(e)
    });
    on("ui.message",{element:"surface"},async($)=>{
      const count=(await $.store.get("count")||0)+1;await $.store.set("count",count);return {props:{count}}
    })
  }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Board(props,s){
    const {Box,Text,Input,Button}=s.elements;
    if(s.state===undefined)s.setState({note:""});
    return <Box flexDirection="column">
      <Text>BUSY_ACK:{props.count}</Text>
      <Input key="note" label="Busy note" value={s.state.note} onInput={note=>s.setState({note})} onSubmit={()=>{}}/>
      <Button key="increment" label="Busy increment" onPress={()=>s.post({increment:true})}/>
    </Box>
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "client-busy.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "client-busy"
  )!
  assert(mod.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Client busy", { exact: true }).first().click()
  const open = async () => {
    const command = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
      (row) => row.command === "busy-open"
    )!
    assert(command)
    const job = await page.evaluate(
      ({ id, command }) => window.api.mods.enqueue(id, command, { text: "" }),
      { id, command }
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
          (row) => row.id === job.id && row.state === "succeeded"
        ),
      "busy board opened"
    )
  }
  const pane = page.locator('[data-function-pane="busy-board"]')
  const button = pane.getByRole("button", { name: "Busy increment", exact: true })
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), id)
  const logCount = async (text: string) => (await logs()).filter((row) => row.text === text).length
  await open()
  await pane.getByText("BUSY_ACK:0", { exact: true }).waitFor()
  await pane.getByRole("textbox", { name: "Busy note", exact: true }).fill("overlapping input")
  await until(async () => (await logCount("BUSY_INPUT_WAIT")) === 1, "input is pending")
  await button.click()
  await until(async () => (await logCount("BUSY_PRESS_WAIT")) === 1, "press follows pending input")
  const prematurelyUnlocked = await button.evaluate(async (button) => {
    // Observe the late input reply for a bounded interval inside the guest's 2s press delay.
    const end = performance.now() + 250
    do {
      if (button.getAttribute("aria-disabled") !== "true") return true
      await new Promise(requestAnimationFrame)
    } while (performance.now() < end)
    return false
  })
  assert.equal(prematurelyUnlocked, false, "late input must not unlock pending press")
  assert.equal(await pane.getByText("BUSY_ACK:1", { exact: true }).count(), 0)
  await page.screenshot({ path: join(artifacts, "client-busy-pending.png") })
  await pane.getByText("BUSY_ACK:1", { exact: true }).waitFor()
  await until(
    async () => (await button.getAttribute("aria-disabled")) === null,
    "completed press unlocks controls"
  )
  pass("late real input completion keeps a pending Client press busy until host acknowledgement")

  const previous = await pane
    .locator("[data-function-client-instance]")
    .getAttribute("data-function-client-instance")
  await button.click()
  await until(async () => (await logCount("BUSY_PRESS_WAIT")) === 2, "second press is pending")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane.count()) === 0, "off removes pending Client")
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("original composer remains available")
  assert.equal(await composer.inputValue(), "original composer remains available")
  pass("off cancels pending Client control and restores the original composer")

  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await open()
  await pane.getByText("BUSY_ACK:1", { exact: true }).waitFor()
  assert.notEqual(
    await pane
      .locator("[data-function-client-instance]")
      .getAttribute("data-function-client-instance"),
    previous
  )
  assert.equal(await button.getAttribute("aria-disabled"), null)
  await button.click()
  await pane.getByText("BUSY_ACK:2", { exact: true }).waitFor()
  await until(
    async () => (await button.getAttribute("aria-disabled")) === null,
    "new Client finishes its own control"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane.count()) === 0, "off removes new Client")
  pass(
    "replacement Client has independent busy state and cancelled old press does not advance store"
  )
  // Leave the original suite switch state for the next independently configured project.
  await page.evaluate(() => window.api.mods.configureGlobal(true))
}
