import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import type { ModUiChangeEvent } from "../../src/shared/mods/types"

type ObservedWindow = Window & { __modsUiChanges?: ModUiChangeEvent[] }
export async function verifyUiNotification(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "ui-notification")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "UI notifications",
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
    Buffer.from(JSON.stringify({ name: "ui-notification", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let version=0;
    on("session.start",async($,e,next)=>{for(const name of ["notify-open","notify-redraw"])await $.command.register({name,description:name,immediate:true});return next(e)});
    on("command.run",{command:"notify-open"},async($)=>{await $.ui.open({id:"local",title:"Local Client"});return {text:"original command result"}});
    on("command.run",{command:"notify-redraw"},($)=>{version++;$.ui.invalidate("ui.render");return {text:"original redraw result"}});
    on("ui.render",{component:"Pane",requestId:"local"},($,e)=>{const {Client}=$.ui.resolve(e);return <Client key="counter" module="./surface.tsx"/>});
    on("ui.render",{component:"PromptHint"},($,e)=>$.ui.resolve(e).Text({children:["SCOPED_HINT_"+version]}));
    on("ui.render",{component:"CommandOutput"},($,e)=>$.ui.resolve(e).Text({children:["SCOPED_OUTPUT_"+version]}))
  }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Surface(props,s){
    const {Box,Text,Button}=s.elements;return <Box><Text>LOCAL_COUNT_{s.state||0}</Text>
    <Button key="counter" label="Increment local counter" onPress={()=>s.setState((s.state||0)+1)}/></Box>
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "ui-notification.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "ui-notification"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI notifications", { exact: true }).first().click()
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
  }
  const composer = page.locator("textarea.composer-textarea")
  const pane = () => page.locator('[data-function-pane="local"]')
  await run("notify-open")
  await pane().getByText("LOCAL_COUNT_0", { exact: true }).waitFor()
  await until(
    async () => (await composer.getAttribute("placeholder")) === "SCOPED_HINT_0",
    "original hint rendered"
  )
  await page.getByText("SCOPED_OUTPUT_0", { exact: true }).first().waitFor()
  // Observe the public IPC notification only; do not replace the bridge or its consumers.
  await page.waitForTimeout(150)
  await page.evaluate((id) => {
    const host = window as ObservedWindow
    host.__modsUiChanges = []
    window.api.mods.onCardsChanged((event) => {
      if (event.threadId === id && host.__modsUiChanges!.length < 100)
        host.__modsUiChanges!.push(event)
    })
  }, id)
  const changes = () => page.evaluate(() => (window as ObservedWindow).__modsUiChanges!)
  for (let count = 1; count <= 3; count++) {
    await pane().getByRole("button", { name: "Increment local counter", exact: true }).click()
    await pane()
      .getByText("LOCAL_COUNT_" + count, { exact: true })
      .waitFor()
    await until(async () => (await changes()).length >= count, "scoped Client IPC notification")
  }
  assert(
    (await changes()).every((event) => event.scope === "panes"),
    JSON.stringify(await changes())
  )
  assert.equal(await composer.getAttribute("placeholder"), "SCOPED_HINT_0")
  await page.getByText("SCOPED_OUTPUT_0", { exact: true }).first().waitFor()
  pass(
    "actual Client redraws publish panes-only IPC while unrelated hint and command presentation remain stable"
  )
  await page.evaluate(() => {
    ;(window as ObservedWindow).__modsUiChanges = []
  })
  await run("notify-redraw")
  await until(
    async () => (await composer.getAttribute("placeholder")) === "SCOPED_HINT_1",
    "explicit invalidation refreshes hint"
  )
  await page.getByText("SCOPED_OUTPUT_1", { exact: true }).first().waitFor()
  assert((await changes()).some((event) => event.scope === undefined))
  await pane().getByText("LOCAL_COUNT_3", { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, "scoped-notification-visible.png") })
  pass(
    "explicit SDK invalidation still broadcasts globally and updates actual cached sites without resetting Client state"
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI notifications", { exact: true }).first().click()
  await pane().getByText("LOCAL_COUNT_3", { exact: true }).waitFor()
  await until(
    async () => (await composer.getAttribute("placeholder")) === "SCOPED_HINT_1",
    "reloaded site renders current state"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane().count()) === 0, "off removes Client")
  await until(
    async () => (await composer.getAttribute("placeholder")) !== "SCOPED_HINT_1",
    "off restores native hint"
  )
  await page.getByText("original command result", { exact: true }).first().waitFor()
  await composer.fill("Original composer after scoped notifications")
  assert.equal(await composer.inputValue(), "Original composer after scoped notifications")
  await page.screenshot({ path: join(artifacts, "scoped-notification-off.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass(
    "renderer reload and global-off configuration preserve native hint, command evidence and composer behavior"
  )
}
