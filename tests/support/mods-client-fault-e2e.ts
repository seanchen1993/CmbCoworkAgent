import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"

export async function verifyClientFault(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "client-fault")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Client recovery",
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
    Buffer.from(JSON.stringify({ name: "client-fault", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let mode="render",faults=[],drawings=0,sequence=0,fallback=false;
    on("session.start",async($,e,next)=>{
      for(const name of ["fault-open","fault-mode","fault-state"])await $.command.register({name,description:name,immediate:true});return next(e)
    });
    on("command.run",{command:"fault-open"},async($)=>{await $.ui.open({id:"board",title:"Client recovery"});await $.ui.open({id:"healthy",title:"Healthy sibling"});return {}});
    on("command.run",{command:"fault-mode"},async($,e)=>{mode=e.args;fallback=false;sequence++;await $.ui.invalidate("ui.render");return {}});
    on("command.run",{command:"fault-state"},()=>({text:JSON.stringify({faults,drawings})}));
    on("ui.fault",async($,e,next)=>{
      faults.push(e);fallback=true;
      if(mode==="slow"){$.ui.log("FAULT_WAIT");await $.clock.sleep(1000)}
      $.ui.log("FAULT:"+JSON.stringify(e));return next(e)
    });
    on("ui.render",{component:"Pane"},($,e)=>{
      const {Client,Text}=$.ui.resolve(e);
      if(e.requestId==="healthy")return Text({children:"Healthy sibling remains"});
      if(e.requestId!=="board")return Text({children:""});
      drawings++;
      if(fallback&&mode!=="loop")return Text({children:"Fallback works"});
      if(mode==="load")return <Client key={"load-"+sequence} module="./load-fail.tsx"/>;
      return <Client key={"surface-"+sequence+(mode==="loop"?"-"+faults.length:"")} module="./surface.tsx" props={{mode}}/>
    })
  }`)
  )
  zip.addFile(
    "hooks/load-fail.tsx",
    Buffer.from(
      `throw Error("LOAD_FAILURE");export default function Surface(_,s){return s.elements.Text({children:"unreachable"})}`
    )
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Surface(props,s){
    if(["render","loop","slow"].includes(props.mode)||s.state==="draw-failed")throw Error("RENDER_FAILURE\\n"+"x".repeat(250));
    const {Button,Text}=s.elements;
    if(s.state==="done")return Text({children:"Async works"});
    return Button({key:"fail",label:"Run Client action",onPress:async()=>{
      await Promise.resolve();
      if(props.mode==="success"){s.setState("done");return}
      if(props.mode==="after-handler-render"){s.setState("draw-failed");return}
      throw Error("RUN_FAILURE")
    }})
  }`)
  )
  const installed = await page.evaluate(
    (data) => window.api.plugins.install(new Uint8Array(data).buffer, "client-fault.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const installedRow = (
    await page.evaluate((id) => window.api.mods.status(id), id)
  ).functionMods!.find((row) => row.name === "client-fault")!
  assert(installedRow?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: installedRow.pluginId, digest: installedRow.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Client recovery", { exact: true }).first().click()
  await openModsResults(page)
  const run = async (command: string, args = "") => {
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
      (row) => row.command === command
    )!
    assert(descriptor)
    const job = await page.evaluate(
      ({ id, descriptor, args }) => window.api.mods.enqueue(id, descriptor, { text: args }),
      { id, descriptor, args }
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
  const pane = page.locator('[data-function-pane="board"]')
  const state = async () =>
    JSON.parse((await run("fault-state")).result!.text) as {
      drawings: number
      faults: Array<Record<string, unknown>>
    }
  const evidence: unknown[] = []
  const count = requests.length
  await run("fault-open")
  await until(
    async () => await pane.getByText("Fallback works", { exact: true }).isVisible(),
    "first render failure recovers"
  )
  let actual = await state()
  assert.equal(actual.faults.length, 1)
  assert.equal(actual.faults[0].phase, "render")
  assert.equal(actual.drawings, 2)
  evidence.push(actual)
  assert(await page.getByText("Healthy sibling remains", { exact: true }).isVisible())
  await page.screenshot({ path: join(artifacts, "client-fault-render-recovered.png") })
  pass(
    "actual utility-process render fault notifies its owner and redraws fallback while a sibling Pane remains"
  )
  for (const mode of ["load", "run", "after-handler-render"]) {
    const before = actual.faults.length
    await run("fault-mode", mode)
    if (mode !== "load")
      await pane.getByRole("button", { name: "Run Client action", exact: true }).click()
    await until(async () => (await state()).faults.length === before + 1, mode + " actual fault delivered")
    await until(
      async () => await pane.getByText("Fallback works", { exact: true }).isVisible(),
      mode + " recovers"
    )
    actual = await state()
    assert.equal(actual.faults.length, before + 1)
    const fault = actual.faults.at(-1)!
    assert.equal(fault.phase, mode === "after-handler-render" ? "render" : mode)
    assert.equal(fault.surface, "desktop")
    assert.equal(fault.component, "Pane")
    assert.equal(fault.requestId, "board")
    assert.equal(typeof fault.reason, "string")
    assert((fault.reason as string).length <= 200)
    // eslint-disable-next-line no-control-regex -- Check the actual emitted reason has no controls.
    assert(!/[\u0000-\u001f\u007f-\u009f]/.test(fault.reason as string))
    evidence.push(actual)
    pass(
      "actual " +
        mode +
        " failure reports its native phase and recovers through the original Pane chain"
    )
  }
  await run("fault-mode", "success")
  await pane.getByRole("button", { name: "Run Client action", exact: true }).click()
  await until(
    async () => await pane.getByText("Async works", { exact: true }).isVisible(),
    "asynchronous Client state"
  )
  const successful = await state()
  assert.equal(successful.faults.length, actual.faults.length)
  await page.screenshot({ path: join(artifacts, "client-fault-async-success.png") })
  pass(
    "actual asynchronous Client listener settles and paints its changed local state without a false fault"
  )
  await run("fault-mode", "loop")
  await until(
    async () => (await state()).faults.length === actual.faults.length + 2,
    "fault-born instance heard"
  )
  actual = await state()
  await page.waitForTimeout(180)
  const settled = await state()
  assert.equal(settled.faults.length, actual.faults.length)
  assert.equal(settled.drawings, actual.drawings)
  evidence.push(settled)
  pass(
    "a newly born Client failing in the recovery drawing is heard without an infinite redraw loop"
  )
  await run("fault-mode", "slow")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.logs(id), id)).some(
        (row) => row.text === "FAULT_WAIT"
      ),
    "pending fault hook"
  )
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "client-fault"), id)
  await until(async () => (await pane.count()) === 0, "revocation removes faulty Pane")
  await page.waitForTimeout(1100)
  assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), id), [])
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Original composer remains usable")
  assert.equal(await composer.inputValue(), "Original composer remains usable")
  assert.equal(requests.length, count)
  await page.screenshot({ path: join(artifacts, "client-fault-revoked.png") })
  writeFileSync(join(artifacts, "client-fault-evidence.json"), JSON.stringify(evidence, null, 2))
  pass(
    "revocation cancels a pending fault notice and cannot recreate the old Pane; native composer and request count remain"
  )
}
