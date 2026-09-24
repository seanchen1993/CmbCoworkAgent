import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { BASE64_PROBE_SOURCE, expectedBase64Probe } from "../fixtures/mods-v2/base64-probes"

export async function verifyBase64(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "guest-base64")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Guest Base64",
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
    Buffer.from(JSON.stringify({ name: "guest-base64", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`${BASE64_PROBE_SOURCE}
    export function register(on){
      on("session.start",async($,e,next)=>{for(const name of ["base64-inspect","base64-open"])await $.command.register({name,description:name,immediate:true});return next(e)});
      on("command.run",{command:"base64-inspect"},async $=>{const before=base64Probe();await $.session.id();return {text:JSON.stringify({before,after:base64Probe()})}});
      on("command.run",{command:"base64-open"},async $=>{await $.ui.open({id:"base64",title:"Guest Base64"});return {}});
      on("ui.render",{component:"Pane",requestId:"base64"},($,e)=>{const {Client}=$.ui.resolve(e);return <Client key="codec" module="./surface.tsx"/>})
    }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`${BASE64_PROBE_SOURCE}
    export default function Surface(_,s){const {Text,Button}=s.elements;
      return <><Text>{"BASE64_PROBE:"+JSON.stringify(base64Probe())}</Text>
        <Text>{"BASE64_COUNT_"+(s.state||0)}</Text>
        <Button key="increment" label="Decode in Client" onPress={()=>s.setState(Number(atob(btoa(String((s.state||0)+1)))))}/></>
    }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "guest-base64.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "guest-base64"
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
    await page.getByText("Guest Base64", { exact: true }).first().click()
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
  const evidence = JSON.parse((await run("base64-inspect")).result!.text)
  assert.deepEqual(evidence, { before: expectedBase64Probe(), after: expectedBase64Probe() })
  pass("approved guest base64 matches native vectors before and after a real SDK continuation")
  await run("base64-open")
  const pane = () => page.locator('[data-function-pane="base64"]')
  const client = pane().getByText(/^BASE64_PROBE:/)
  await client.waitFor()
  const clientEvidence = JSON.parse((await client.innerText()).slice("BASE64_PROBE:".length))
  assert.deepEqual(clientEvidence, expectedBase64Probe())
  await pane().getByRole("button", { name: "Decode in Client", exact: true }).click()
  await pane().getByText("BASE64_COUNT_1", { exact: true }).waitFor()
  writeFileSync(
    join(artifacts, "base64-evidence.json"),
    JSON.stringify({ evidence, clientEvidence }, null, 2)
  )
  await page.screenshot({ path: join(artifacts, "base64-client.png") })
  pass(
    "isolated Client base64 handles byte vectors and actual button callbacks without host globals"
  )
  await select()
  await pane().getByText("BASE64_COUNT_1", { exact: true }).waitFor()
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "guest-base64"), id)
  await until(async () => (await pane().count()) === 0, "revocation removes the codec Client")
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "guest-base64"
    )!.state,
    "needs-approval"
  )
  await approve()
  await run("base64-open")
  await pane().getByText("BASE64_COUNT_0", { exact: true }).waitFor()
  pass("reload retains the live Client and durable revocation rebuilds a fresh codec instance")
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane().count()) === 0, "off removes codec controls")
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original composer with codecs off")
  assert.equal(await composer.inputValue(), "Original composer with codecs off")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass("Mods off removes codec commands and leaves the original composer usable")
}
