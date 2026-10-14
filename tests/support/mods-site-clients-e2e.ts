import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

/** Installed ZIP, real native IPC, utility-process Client VM and mounted production chat. */
export async function verifySiteClients(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "site-clients-project")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Site Clients E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id = (thread as unknown as { thread_id: string }).thread_id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: {
        model: "custom:mods-model-fixture",
        subagentsEnabled: false
      }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "site-clients", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    let mode="success",sequence=0,draws=0,messages=[],faults=[],fallback=new Set();
    on("session.start",async($,e,next)=>{
      for(const name of ["site-state","site-redraw","site-fail","site-question"])
        await $.command.register({name,description:name,...(name!=="site-question"?{immediate:true}:{})});return next(e)
    });
    on("command.run",{command:"site-state"},()=>({text:JSON.stringify({draws,messages,faults})}));
    on("command.run",{command:"site-redraw"},async($)=>{await $.ui.invalidate("ui.render");return {}});
    on("command.run",{command:"site-fail"},async($)=>{mode="run";sequence++;await $.ui.invalidate("ui.render");return {}});
    on("command.run",{command:"site-question"},async($)=>({text:"SITE_ANSWER:"+await $.ui.ask("Original site question?",{header:"Plan",options:["Careful","Fast"]})}));
    on("ui.render",($,e,next)=>{
      if(!["AbovePrompt","AssistantMessage","AskUserQuestion"].includes(e.component))return next(e);
      draws++;const {Client,Text}=$.ui.resolve(e);
      if(fallback.has(e.requestId))return Text({children:"Recovered "+e.component});
      return <Client key={e.component+sequence} module="./surface.tsx" props={{component:e.component,mode}}/>
    });
    on("ui.message",($,e)=>{messages.push(e);return {props:{component:e.component,mode:"success",label:"Acknowledged"}}});
    on("ui.fault",($,e)=>{faults.push(e);fallback.add(e.requestId);return {}});
  }`)
  )
  zip.addFile(
    "hooks/surface.tsx",
    Buffer.from(`export default function Surface(props,s){
    const {Box,Text,Button}=s.elements;
    return Box({children:[Text({children:props.component+" · "+(props.label||"Source")+" · count:"+(s.state||0)}),
      Button({key:"increment",label:"Increment "+props.component,onPress:async()=>{
        await Promise.resolve();if(props.mode==="run")throw Error("site run failure");
        s.setState((s.state||0)+1);s.post({count:s.state});
      }})]})
  }`)
  )
  const installed = await page.evaluate(
    (data) => window.api.plugins.install(new Uint8Array(data).buffer, "site-clients.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "site-clients"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
    { id, mod }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Site Clients E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const above = page.locator('[data-function-site="AbovePrompt"]')
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), id)
  const enqueue = async (command: string) =>
    page.evaluate(
      async ({ id, command }) => {
        const descriptor = (await window.api.mods.commands(id)).find(
          (row) => row.command === command
        )!
        return window.api.mods.enqueue(id, descriptor, { text: "" })
      },
      { id, command }
    )
  const run = async (command: string) => {
    const job = await enqueue(command)
    await until(
      async () => (await jobs()).some((row) => row.id === job.id && row.state === "succeeded"),
      command
    )
    return (await jobs()).find((row) => row.id === job.id)!
  }
  const state = async () => JSON.parse((await run("site-state")).result!.text)
  const before = requests.length
  await above.getByRole("button", { name: "Increment AbovePrompt", exact: true }).waitFor()
  const identity = await above
    .locator("[data-function-client-instance]")
    .getAttribute("data-function-client-instance")
  await page.evaluate((threadId) => {
    const probe = { events: [] as Array<{ threadId: string; scope?: string }> }
    const surface = window as unknown as { siteNotificationProbe: typeof probe }
    surface.siteNotificationProbe = probe
    window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) probe.events.push(event)
    })
  }, id)
  await above.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
  await until(
    async () => (await above.innerText()).includes("Acknowledged · count:1"),
    "actual site post accepted"
  )
  await page.waitForTimeout(200)
  const notification = await page.evaluate(
    () =>
      (
        window as unknown as {
          siteNotificationProbe: { events: Array<{ threadId: string; scope?: string }> }
        }
      ).siteNotificationProbe
  )
  assert(notification.events.length > 0)
  assert(notification.events.every((event) => event.scope?.startsWith("site:")))
  pass("actual utility/main/preload preserves the local site scope of Client frame notifications")
  let actual = await state()
  assert.equal(actual.messages.length, 1)
  assert.equal(actual.messages[0].component, "AbovePrompt")
  pass(
    "installed approved Client runs in actual AbovePrompt and sends its native site identity through utility IPC"
  )
  await run("site-redraw")
  await until(
    async () => (await above.innerText()).includes("Acknowledged · count:1"),
    "parent redraw retains actual state"
  )
  assert.equal(
    await above
      .locator("[data-function-client-instance]")
      .getAttribute("data-function-client-instance"),
    identity
  )
  await above.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
  await until(
    async () => (await above.innerText()).includes("count:2"),
    "fresh generation remains clickable"
  )
  assert.equal(requests.length, before)
  await page.screenshot({ path: join(artifacts, "site-client-above-prompt.png") })
  pass(
    "actual parent invalidation preserves Client VM, accepted props and state while the new generation remains interactive"
  )

  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { siteOriginalApproval: typeof dialog.showMessageBox }
    state.siteOriginalApproval = dialog.showMessageBox
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox
  })
  try {
    await composer.fill("/site-question now")
    await composer.press("Enter")
    const dialog = page.getByRole("dialog", { name: "需要用户输入" })
    try {
      await dialog.waitFor()
    } catch (error) {
      writeFileSync(
        join(artifacts, "site-question-diagnostics.json"),
        JSON.stringify(
          {
            status: await page.evaluate((id) => window.api.mods.status(id), id),
            commands: await page.evaluate((id) => window.api.mods.commands(id), id),
            jobs: await jobs(),
            logs: await page.evaluate((id) => window.api.mods.logs(id), id)
          },
          null,
          2
        )
      )
      throw error
    }
    const question = dialog.locator('[data-function-site="AskUserQuestion"]')
    await question.getByRole("button", { name: "Increment AskUserQuestion", exact: true }).click()
    await until(
      async () => (await question.innerText()).includes("count:1"),
      "actual question Client updates"
    )
    assert(!(await jobs()).some((row) => row.result?.text?.startsWith("SITE_ANSWER:")))
    assert((await dialog.innerText()).includes("Original site question?"))
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await page.screenshot({ path: join(artifacts, "site-client-native-question.png") })
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await jobs()).some((row) => row.result?.text === "SITE_ANSWER:Careful"),
      "native answer preserved"
    )
    assert.equal(requests.length, before)
    pass(
      "actual question Client supplements the original dialog without answering; native radio and submit still return Careful"
    )
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (
        globalThis as unknown as { siteOriginalApproval: typeof dialog.showMessageBox }
      ).siteOriginalApproval
    })
  }
  await run("site-fail")
  await until(async () => {
    const client = above.locator("[data-function-client-instance]")
    return (
      (await client.count()) === 1 &&
      (await client.getAttribute("data-function-client-instance")) !== identity
    )
  }, "new failure-mode Client is actually painted before clicking")
  await above.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
  await until(
    async () => (await above.innerText()).includes("Recovered AbovePrompt"),
    "notification paints actual fault fallback"
  )
  actual = await state()
  assert(
    actual.faults.some(
      (fault: Record<string, unknown>) => fault.component === "AbovePrompt" && fault.phase === "run"
    )
  )
  assert.equal(requests.length, before)
  pass(
    "actual site run failure notifies its fixed owner and automatically paints fallback without a manual snapshot query"
  )
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "site-clients"), id)
  await until(
    async () => (await above.locator("[data-function-client]").count()) === 0,
    "revoked actual site Client disappears"
  )
  await composer.fill("Original composer still works")
  assert.equal(await composer.inputValue(), "Original composer still works")
  assert.equal(requests.length, before)
  writeFileSync(
    join(artifacts, "site-clients-evidence.json"),
    JSON.stringify({ actual, providerRequests: requests.length - before }, null, 2)
  )
  pass(
    "actual revocation removes site Clients, preserves ordinary composer and sends no hidden provider request"
  )
  await composer.press("Enter")
  await until(
    async () => requests.length > before,
    "ordinary turn starts after site Client revocation"
  )
  await until(async () => {
    const messages = await page.evaluate((threadId) => window.api.threads.getMessages(threadId), id)
    return messages.some(
      (message) => message.role === "assistant" && message.content.includes("MODEL_OK")
    )
  }, "ordinary model reply remains visible after site Client revocation")
  pass(
    "actual original composer sends a normal model turn and receives its reply after site Client revocation"
  )
}
