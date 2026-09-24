import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyPublicJsx(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "public-jsx")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Public JSX",
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
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "public-jsx", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let count=0;
    on("session.start",async($,e,next)=>{for(const name of ["jsx-open","jsx-inspect"])await $.command.register({name,description:name,immediate:true});return next(e)});
    on("command.run",{command:"jsx-open"},async($)=>{await $.ui.open({id:"jsx",title:"Public JSX"});return {}});
    on("command.run",{command:"jsx-inspect"},()=>({text:JSON.stringify({h:typeof h,Fragment:typeof Fragment})}));
    on("ui.render",{component:"Pane",requestId:"jsx"},($,e)=>{
      const {Text,Button,Client}=$.ui.resolve(e);
      return h(Fragment,null,h(Text,null,"PUBLIC_HOST_"+count),
        h(Button,{key:"increment",label:"Increment public host",onPress(){count++;$.ui.invalidate("ui.render")}}),
        <><Text>COMPILED_HOOK_A</Text><Text>COMPILED_HOOK_B</Text></>,
        h(Client,{key:"surface",module:"./surface.tsx"}))
    })
  }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Surface(props,s){
    const {Text,Button}=s.elements;
    return h(Fragment,null,h(Text,null,"PUBLIC_CLIENT_"+(s.state||0)),
      h(Button,{key:"local",label:"Increment public Client",onPress(){s.setState((s.state||0)+1)}}),
      <><Text>COMPILED_CLIENT_A</Text><Text>COMPILED_CLIENT_B</Text></>)
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "public-jsx.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "public-jsx"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Public JSX", { exact: true }).first().click()
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
  assert.deepEqual(JSON.parse((await run("jsx-inspect")).result!.text), {
    h: "function",
    Fragment: "function"
  })
  await run("jsx-open")
  const pane = () => page.locator('[data-function-pane="jsx"]')
  await pane().getByText("PUBLIC_HOST_0", { exact: true }).waitFor()
  await pane().getByText("PUBLIC_CLIENT_0", { exact: true }).waitFor()
  const vertical = async (first: string, second: string) => {
    const a = await pane().getByText(first, { exact: true }).boundingBox()
    const b = await pane().getByText(second, { exact: true }).boundingBox()
    assert(a && b)
    assert(b.y >= a.y + a.height, JSON.stringify({ first, second, a, b }))
  }
  await vertical("COMPILED_HOOK_A", "COMPILED_HOOK_B")
  await vertical("COMPILED_CLIENT_A", "COMPILED_CLIENT_B")
  const layout = await pane().evaluate((section) => {
    const root = section.querySelector("[data-function-pane-body] > div")!
    const client = section.querySelector("[data-function-client-instance] > div")!
    return {
      host: getComputedStyle(root).flexDirection,
      client: getComputedStyle(client).flexDirection
    }
  })
  assert.deepEqual(layout, { host: "column", client: "column" })
  pass(
    "public h and Fragment render in real hooks and Client VMs; compiled fragments keep actual column layout"
  )
  await pane().getByRole("button", { name: "Increment public Client", exact: true }).click()
  await pane().getByText("PUBLIC_CLIENT_1", { exact: true }).waitFor()
  await pane().getByRole("button", { name: "Increment public host", exact: true }).click()
  await pane().getByText("PUBLIC_HOST_1", { exact: true }).waitFor()
  await pane().getByText("PUBLIC_CLIENT_1", { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, "public-jsx-controls.png") })
  pass("public factory callbacks retain real host ownership and Client state across parent redraw")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Public JSX", { exact: true }).first().click()
  await pane().getByText("PUBLIC_HOST_1", { exact: true }).waitFor()
  await pane().getByText("PUBLIC_CLIENT_1", { exact: true }).waitFor()
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "public-jsx"), id)
  await until(async () => (await pane().count()) === 0, "revoked public factory Pane removed")
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "public-jsx"
    )!.state,
    "needs-approval"
  )
  pass("renderer reload keeps live factory state and durable revocation removes its real controls")
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await run("jsx-open")
  await pane().getByText("PUBLIC_HOST_0", { exact: true }).waitFor()
  await pane().getByText("PUBLIC_CLIENT_0", { exact: true }).waitFor()
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane().count()) === 0, "off removes fresh factory controls")
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original composer with JSX off")
  assert.equal(await composer.inputValue(), "Original composer with JSX off")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  await page.screenshot({ path: join(artifacts, "public-jsx-off.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass("off removes executable plugin commands and preserves the original composer")
}
