import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { CODEGEN_PROBE_COUNT, CODEGEN_PROBE_SOURCE } from "../fixtures/mods-v2/codegen-probes"

export async function verifyGuestCodegen(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "guest-codegen")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Guest code generation",
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
    Buffer.from(JSON.stringify({ name: "guest-codegen", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`${CODEGEN_PROBE_SOURCE}
    const initial=codegenProbe();
    export function register(on){
      on("session.start",async($,e,next)=>{for(const name of ["codegen-inspect","codegen-open"])await $.command.register({name,description:name,immediate:true});return next(e)});
      on("command.run",{command:"codegen-inspect"},async $=>{await $.session.id();return {text:JSON.stringify({initial,later:codegenProbe()})}});
      on("command.run",{command:"codegen-open"},async $=>{await $.ui.open({id:"codegen",title:"Guest code generation"});return {}});
      on("ui.render",{component:"Pane",requestId:"codegen"},($,e)=>{const {Client}=$.ui.resolve(e);return <Client key="guard" module="./surface.tsx"/>})
    }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`${CODEGEN_PROBE_SOURCE}
    export default function Surface(_,s){
      const {Text,Button}=s.elements;
      const blocked=codegenProbe().filter(r=>r.message==="MODS_CODE_GENERATION_DENIED").length;
      return <><Text>{"CLIENT_BLOCKED_"+blocked}</Text><Text>{"COUNTER_"+(s.state||0)}</Text>
        <Button key="increment" label="Increment guarded Client" onPress={()=>s.setState((s.state||0)+1)}/></>
    }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "guest-codegen.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "guest-codegen"
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
  await page.getByText("Guest code generation", { exact: true }).first().click()
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
  const denied = Array.from({ length: CODEGEN_PROBE_COUNT }, () => ({
    name: "TypeError",
    message: "MODS_CODE_GENERATION_DENIED"
  }))
  assert.deepEqual(JSON.parse((await run("codegen-inspect")).result!.text), {
    initial: denied,
    later: denied
  })
  pass(
    "installed hooks reject eval and constructor generation before registration and after actual SDK continuation"
  )
  await run("codegen-open")
  const pane = () => page.locator('[data-function-pane="codegen"]')
  await pane().getByText(`CLIENT_BLOCKED_${CODEGEN_PROBE_COUNT}`, { exact: true }).waitFor()
  await pane().getByRole("button", { name: "Increment guarded Client", exact: true }).click()
  await pane().getByText("COUNTER_1", { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, "guest-codegen-client.png") })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Guest code generation", { exact: true }).first().click()
  await pane().getByText("COUNTER_1", { exact: true }).waitFor()
  await pane().getByText(`CLIENT_BLOCKED_${CODEGEN_PROBE_COUNT}`, { exact: true }).waitFor()
  pass(
    "isolated Client rejects the same generation paths while real controls and reload preserve live state"
  )
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "guest-codegen"), id)
  await until(async () => (await pane().count()) === 0, "revoked guarded Client removed")
  assert.equal(
    (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "guest-codegen"
    )!.state,
    "needs-approval"
  )
  await approve()
  await run("codegen-open")
  await pane().getByText("COUNTER_0", { exact: true }).waitFor()
  await pane().getByText(`CLIENT_BLOCKED_${CODEGEN_PROBE_COUNT}`, { exact: true }).waitFor()
  pass(
    "durable revocation and reapproval create a fresh Client with the code generation restriction intact"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(async () => (await pane().count()) === 0, "off removes guarded Client")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original application with Mods off")
  assert.equal(await composer.inputValue(), "Original application with Mods off")
  // This boundary belongs to guest VMs; the application's normal JS execution still works.
  assert.equal(await page.evaluate(() => ((x) => x + 1)(41)), 42)
  await page.screenshot({ path: join(artifacts, "guest-codegen-off.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass(
    "global off removes executable Mods UI and commands while the original composer and application remain usable"
  )
}
