import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"

export async function verifyLinkFallback(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "link-fallback")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Link compatibility",
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
    Buffer.from(JSON.stringify({ name: "link-fallback", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let count=0,faults=0;
    on("session.start",async($,e,next)=>{await $.command.register({name:"links-open",description:"Open links",immediate:true});await $.command.register({name:"links-state",description:"Read links",immediate:true});return next(e)});
    on("command.run",{command:"links-open"},async($)=>{await $.ui.open({id:"board",title:"Link compatibility"});return {}});
    on("command.run",{command:"links-state"},()=>({text:JSON.stringify({count,faults})}));
    on("ui.fault",($,e,next)=>{faults++;return next(e)});
    on("ui.render",{component:"AbovePrompt"},($,e)=>{const {Link}=$.ui.resolve(e);return Link({href:"file:///C:/guide",label:"Above prompt plain"})});
    on("ui.render",{component:"Pane"},($,e)=>{
      const {Box,Text,Link,Button,Client}=$.ui.resolve(e);
      return Box({children:[Text({children:"Sibling remains"}),Link({href:"javascript:alert(1)",label:"Plain unsafe"}),
        Link({href:"https:///example.com",label:"Plain malformed"}),
        Link({href:"",label:"Plain blank"}),Link({href:"https://example.com",label:"Safe HTTPS"}),
        Button({key:"count",label:"Sibling count:"+count,onPress:async()=>{count++;await $.ui.invalidate("ui.render")}}),
        Client({key:"local",module:"./surface.tsx"})]})
    })
  }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Surface(_,s){
    const {Box,Link,Button}=s.elements;
    return Box({children:[Link({href:"file:///C:/private",label:"Client plain unsafe"}),
      Button({key:"count",label:"Client count:"+(s.state||0),onPress(){s.setState((s.state||0)+1)}})]})
  }`)
  )
  const installed = await page.evaluate(
    (data) => window.api.plugins.install(new Uint8Array(data).buffer, "link-fallback.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const row = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "link-fallback"
  )!
  assert(row?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: row.pluginId, digest: row.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Link compatibility", { exact: true }).first().click()
  await openModsResults(page)
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
          (row) => row.id === job.id && ["succeeded", "failed"].includes(row.state)
        ),
      command
    )
    const settled = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
      (row) => row.id === job.id
    )!
    assert.equal(settled.state, "succeeded", settled.error)
    return settled
  }
  const count = requests.length
  await run("links-open")
  const pane = page.locator('[data-function-pane-key="link-fallback:board"]')
  await until(
    async () => await pane.getByText("Client plain unsafe", { exact: true }).isVisible(),
    "installed Client plain link"
  )
  for (const label of ["Plain unsafe", "Plain malformed", "Plain blank", "Client plain unsafe"]) {
    const text = pane.getByText(label, { exact: true })
    assert.equal(await text.evaluate((node) => node.closest("a") !== null), false)
    assert.equal(await text.getAttribute("tabindex"), null)
    await text.click()
  }
  assert.equal(await pane.getByRole("link").count(), 1)
  assert.equal(
    await pane.getByRole("link", { name: "Safe HTTPS", exact: true }).getAttribute("href"),
    "https://example.com"
  )
  pass(
    "installed unsafe and blank Pane/Client links are plain while safe HTTPS keeps its original spelling"
  )
  await pane.getByRole("button", { name: "Sibling count:0", exact: true }).click()
  await until(
    async () =>
      await pane.getByRole("button", { name: "Sibling count:1", exact: true }).isVisible(),
    "normal sibling control"
  )
  await pane.getByRole("button", { name: "Client count:0", exact: true }).click()
  await until(
    async () => await pane.getByRole("button", { name: "Client count:1", exact: true }).isVisible(),
    "normal Client state"
  )
  pass("actual sibling callback and Client local state continue without component fault or reload")
  await until(
    async () =>
      await page
        .locator('[data-function-site="AbovePrompt"]')
        .getByText("Above prompt plain", { exact: true })
        .isVisible(),
    "actual above prompt"
  )
  assert.equal(
    await page.locator('[data-function-site="AbovePrompt"]').getByRole("link").count(),
    0
  )
  pass("the same fallback works in the actual native AbovePrompt slot")
  const stateResult = await run("links-state")
  assert.deepEqual(JSON.parse(stateResult.result!.text), { count: 1, faults: 0 })
  const commands = await page.evaluate((id) => window.api.mods.commands(id), id)
  assert(commands.length > 0)
  const logs = await page.evaluate((id) => window.api.mods.logs(id), id)
  assert.equal(
    logs.some(
      (row) => row.text.includes("MODS_UI_TREE_INVALID") || row.text.includes("MODS_CLIENT_FAILED")
    ),
    false
  )
  assert.equal(requests.length, count)
  await page.screenshot({ path: join(artifacts, "links-plain-siblings.png") })
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "link-fallback"), id)
  await until(async () => (await pane.count()) === 0, "revoke removes link Pane")
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original composer remains usable")
  assert.equal(await composer.inputValue(), "Original composer remains usable")
  assert.equal(requests.length, count)
  writeFileSync(
    join(artifacts, "link-evidence.json"),
    JSON.stringify(
      {
        stateResult,
        requestsBefore: count,
        requestsAfter: requests.length,
        scope:
          "Actual Electron install/grant/utility/DOM, unsafe clicks only; no OS external opening claim"
      },
      null,
      2
    )
  )
  pass("revocation removes actual link surfaces while original composer and provider count remain")
}
