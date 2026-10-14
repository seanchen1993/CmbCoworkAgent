import { openModsResults } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import {
  EXPECTED_STANDARD_GLOBALS_PROBE,
  STANDARD_GLOBALS_PROBE_SOURCE
} from "./function-standard-globals-probe"

export async function verifyStandardGlobals(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "standard-globals")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Standard Globals",
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
    Buffer.from(JSON.stringify({ name: "standard-globals", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`${STANDARD_GLOBALS_PROBE_SOURCE}
    export function register(on){
      on("session.start",async($,e,next)=>{for(const name of ["standard-check","standard-open"])
        await $.command.register({name,description:name,immediate:true});return next(e)});
      on("command.run",{command:"standard-check"},async $=>{const before=await standardGlobalsProbe();
        await $.session.id();return {text:JSON.stringify({before,after:await standardGlobalsProbe()})}});
      on("command.run",{command:"standard-open"},async $=>{await $.ui.open({id:"standard",title:"Standard Globals"});return {}});
      on("ui.render",{component:"Pane",requestId:"standard"},($,e)=>{const {Client}=$.ui.resolve(e);
        return <Client key="standard" module="./surface.tsx"/>})
    }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`${STANDARD_GLOBALS_PROBE_SOURCE}
    let evidence;standardGlobalsProbe().then(value=>{evidence=value});
    export default function Surface(_,s){const {Text,Button}=s.elements;
      return <><Text>{"STANDARD:"+JSON.stringify(s.state||null)}</Text>
        <Button key="check" label="Check standard globals" onPress={()=>{
          s.setState(evidence);
        }}/></>
    }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "standard-globals.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "standard-globals"
  )!
  assert(mod?.digest)
  const approve = () =>
    page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest! }
    )
  await approve()
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Standard Globals", { exact: true }).first().click()
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
  const evidence = JSON.parse((await run("standard-check")).result!.text)
  assert.deepEqual(evidence, {
    before: EXPECTED_STANDARD_GLOBALS_PROBE,
    after: EXPECTED_STANDARD_GLOBALS_PROBE
  })
  pass("standard globals and digest vectors survive a real SDK continuation")
  await run("standard-open")
  const pane = () => page.locator('[data-function-pane="standard"]')
  await pane().getByRole("button", { name: "Check standard globals", exact: true }).click()
  await until(
    async () =>
      !(
        await pane()
          .getByText(/^STANDARD:/)
          .innerText()
      ).endsWith("null"),
    "Client standard globals"
  )
  const clientEvidence = JSON.parse(
    (
      await pane()
        .getByText(/^STANDARD:/)
        .innerText()
    ).slice("STANDARD:".length)
  )
  assert.deepEqual(clientEvidence, EXPECTED_STANDARD_GLOBALS_PROBE)
  await page.screenshot({ path: join(artifacts, "standard-globals-client.png") })
  writeFileSync(
    join(artifacts, "standard-globals-evidence.json"),
    JSON.stringify({ evidence, clientEvidence }, null, 2)
  )
  pass("Client standard globals and precomputed asynchronous digest work from an actual button")
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "standard-globals"), id)
  await until(async () => (await pane().count()) === 0, "revocation removes standard Client")
  await approve()
  await run("standard-open")
  await pane().getByText("STANDARD:null", { exact: true }).waitFor()
  pass("revocation disposes the environment and reapproval starts with fresh Client state")
}
