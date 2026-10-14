import { openModsResults } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { URL_PROBE_SOURCE, expectedUrlProbe } from "./function-url-probe"

export async function verifyUrl(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "guest-url")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Guest URL",
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
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "guest-url", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`${URL_PROBE_SOURCE}
    export function register(on){
      on("session.start",async($,e,next)=>{for(const name of ["url-inspect","url-open"])await $.command.register({name,description:name,immediate:true});return next(e)});
      on("command.run",{command:"url-inspect"},async $=>{const before=urlProbe();await $.session.id();return {text:JSON.stringify({before,after:urlProbe()})}});
      on("command.run",{command:"url-open"},async $=>{await $.ui.open({id:"url",title:"Guest URL"});return {}});
      on("ui.render",{component:"Pane",requestId:"url"},($,e)=>{const {Client}=$.ui.resolve(e);return <Client key="URL" module="./surface.tsx"/>})
    }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`${URL_PROBE_SOURCE}
    export default function Surface(_,s){const {Text,Button}=s.elements;
      return <><Text>{"URL_PROBE:"+JSON.stringify(urlProbe())}</Text>
        <Text>{"URL_COUNT_"+(s.state||0)}</Text>
        <Button key="increment" label="Update URL in Client" onPress={()=>{
          const url=new URL("https://example.com/?count="+String((s.state||0)+1));
          s.setState(Number(url.searchParams.get("count")));
        }}/></>
    }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "guest-url.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "guest-url"
  )!
  assert(mod?.digest)
  const approve = () =>
    page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest! }
    )
  await approve()
  const select = async () => {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Guest URL", { exact: true }).first().click()
    await openModsResults(page)
  }
  await select()
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
          (row) =>
            row.id === job.id &&
            ["succeeded", "failed", "cancelled", "interrupted"].includes(row.state)
        ),
      command
    )
    const result = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
      (row) => row.id === job.id
    )!
    assert.equal(result.state, "succeeded", JSON.stringify(result))
    return result
  }
  const evidence = JSON.parse((await run("url-inspect")).result!.text)
  assert.deepEqual(evidence, { before: expectedUrlProbe(), after: expectedUrlProbe() })
  pass("approved guest URL matches native vectors before and after a real SDK continuation")
  await run("url-open")
  const pane = () => page.locator('[data-function-pane="url"]')
  const client = pane().getByText(/^URL_PROBE:/)
  await client.waitFor()
  const clientEvidence = JSON.parse((await client.innerText()).slice("URL_PROBE:".length))
  assert.deepEqual(clientEvidence, expectedUrlProbe())
  await pane().getByRole("button", { name: "Update URL in Client", exact: true }).click()
  await pane().getByText("URL_COUNT_1", { exact: true }).waitFor()
  writeFileSync(
    join(artifacts, "url-evidence.json"),
    JSON.stringify({ evidence, clientEvidence }, null, 2)
  )
  await page.screenshot({ path: join(artifacts, "url-client.png") })
  pass(
    "isolated Client URL handles standard vectors and actual button callbacks without host globals"
  )
  await select()
  await pane().getByText("URL_COUNT_1", { exact: true }).waitFor()
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "guest-url"), id)
  await until(async () => (await pane().count()) === 0, "revocation removes the URL Client")
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "guest-url"
    )!.state,
    "needs-approval"
  )
  await approve()
  await run("url-open")
  await pane().getByText("URL_COUNT_0", { exact: true }).waitFor()
  pass("reload retains the live Client and durable revocation rebuilds a fresh URL instance")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane().count()) === 0, "off removes URL controls")
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original composer with URLs off")
  assert.equal(await composer.inputValue(), "Original composer with URLs off")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass("Mods off removes URL commands and leaves the original composer usable")
}
