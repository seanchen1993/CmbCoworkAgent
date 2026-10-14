import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"

export async function verifyHoldToasts(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "hold-toasts")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Hold notifications",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.mods.configure(id, true, true)
    await window.api.threads.appendMessages(id, [
      {
        id: "hold-objective",
        role: "user",
        content: "Review this objective",
        created_at: new Date().toISOString()
      }
    ])
    return id
  }, project)
  const sources = {
    "hold-author": `export function register(on){
      on("session.start",async($,e,next)=>{for(const name of ["hold-open","hold-release"])await $.command.register({name,description:name,immediate:true});return next(e)});
      on("command.run",{command:"hold-open"},async($)=>{await $.ui.open({id:"board",title:"Read this panel",holdToasts:true});return {}});
      on("command.run",{command:"hold-release"},async($)=>{await $.ui.open({id:"board",title:"Ordinary panel"});return {}});
      on("ui.render",{component:"Pane"},($,e)=>{const {Box,Text,Button}=$.ui.resolve(e);return Box({children:[Text({children:"Panel remains fully usable"}),Button({key:"close",label:"Finish reading",onPress:async()=>{await $.ui.close({id:"board"})}})]})});
    }`,
    "hold-notifier": `export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"hold-notify",description:"Send notification",immediate:true});return next(e)});
      on("command.run",{command:"hold-notify"},($)=>{$.ui.toast("WAITING_FOR_PANEL",{timeoutMs:1200});$.ui.status("PINNED_STAYS_VISIBLE");return {}});
    }`
  }
  for (const [name, source] of Object.entries(sources)) {
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
    zip.addFile("hooks/register.tsx", Buffer.from(source))
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "hold.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === name
    )!
    assert(mod?.digest)
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest! }
    )
  }
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Hold notifications", { exact: true }).first().click()
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
  }
  const baseline = requests.length
  await run("hold-open")
  const pane = page.locator('[data-function-pane-key="hold-author:board"]')
  await pane.getByText("Panel remains fully usable", { exact: true }).waitFor({ state: "visible" })
  assert.equal(await pane.getAttribute("data-function-hold-toasts"), "true")
  await page.waitForTimeout(150)
  await run("hold-notify")
  const queuedAt = Date.now()
  await page.getByText("PINNED_STAYS_VISIBLE", { exact: true }).waitFor({ state: "visible" })
  await page.getByText("Review this objective", { exact: true }).hover()
  await page.getByRole("button", { name: "设为 Goal", exact: true }).first().click()
  await page.waitForTimeout(1500)
  assert.equal(await page.getByText("WAITING_FOR_PANEL", { exact: true }).count(), 0)
  assert.equal(await page.getByText("已填入 Goal 草稿，确认后发送", { exact: true }).count(), 0)
  const pending = await page.evaluate((id) => window.api.mods.feedback(id), id)
  assert(pending.some((row) => row.kind === "toast" && row.text === "WAITING_FOR_PANEL"))
  const composer = page.locator("textarea.composer-textarea")
  assert((await composer.inputValue()).startsWith("/goal "))
  await page.screenshot({ path: join(artifacts, "notifications-held.png") })
  pass(
    "two installed real mods and actual Goal draft notification wait beyond timeout while status and draft remain usable"
  )
  await pane.getByRole("button", { name: "Finish reading", exact: true }).click()
  await page.getByText("WAITING_FOR_PANEL", { exact: true }).waitFor({ state: "visible" })
  const shownAt = Date.now()
  await page
    .getByText("已填入 Goal 草稿，确认后发送", { exact: true })
    .waitFor({ state: "visible" })
  await page.screenshot({ path: join(artifacts, "notifications-released.png") })
  await page.waitForTimeout(400)
  assert(await page.getByText("WAITING_FOR_PANEL", { exact: true }).isVisible())
  await until(
    async () => (await page.getByText("WAITING_FOR_PANEL", { exact: true }).count()) === 0,
    "actual shown toast expires"
  )
  const expiredAt = Date.now()
  assert(expiredAt - shownAt >= 600)
  await until(
    async () =>
      (await page.getByText("已填入 Goal 草稿，确认后发送", { exact: true }).count()) === 0,
    "actual core Sonner display expires"
  )
  assert(await page.getByText("PINNED_STAYS_VISIBLE", { exact: true }).isVisible())
  pass(
    "closing real pane releases plugin and core Sonner notifications, with a fresh actual main-process display duration"
  )
  await run("hold-open")
  await run("hold-notify")
  await page.waitForTimeout(1400)
  await run("hold-release")
  await until(
    async () => (await pane.getAttribute("data-function-hold-toasts")) === null,
    "open omission resets hold"
  )
  const toast = page
    .locator('[data-feedback-kind="toast"]')
    .filter({ hasText: "WAITING_FOR_PANEL" })
  await toast.waitFor({ state: "visible" })
  await toast.hover()
  await page.waitForTimeout(1500)
  assert(await toast.isVisible())
  await composer.hover()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].hide()
  })
  await page.waitForTimeout(1500)
  const hidden = await page.evaluate((id) => window.api.mods.feedback(id), id)
  assert(hidden.some((row) => row.kind === "toast" && row.text === "WAITING_FOR_PANEL"))
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].show()
  })
  await toast.waitFor({ state: "visible" })
  await toast.hover()
  pass(
    "actual hidden Electron window pauses native remaining time beyond timeout and resumes the same toast"
  )
  await toast.click()
  await until(
    async () =>
      !(await page.evaluate((id) => window.api.mods.feedback(id), id)).some(
        (row) => row.kind === "toast"
      ),
    "native published-id dismiss"
  )
  pass(
    "every actual open resets hold, hover pauses main clock, native dismiss removes only the toast"
  )
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "hold-author"), id)
  await until(async () => (await pane.count()) === 0, "revocation removes pane")
  await composer.fill("Ordinary composer still works")
  assert.equal(await composer.inputValue(), "Ordinary composer still works")
  assert.equal(requests.length, baseline)
  assert(
    !(await page.evaluate((id) => window.api.threads.getMessages(id), id)).some((row) =>
      String(row.content).includes("WAITING_FOR_PANEL")
    )
  )
  pass(
    "revocation and original composer survive, notifications create no model requests or conversation messages"
  )
  writeFileSync(
    join(artifacts, "hold-evidence.json"),
    JSON.stringify(
      {
        queuedAt,
        shownAt,
        expiredAt,
        heldWallMs: shownAt - queuedAt,
        observedDisplayMs: expiredAt - shownAt,
        providerCalls: requests.length - baseline,
        actualPlugins: 2,
        actualMainClock: true,
        actualGoalDraftAction: true,
        scope: "Actual Electron DOM presentation and main queue; no OS paint proof"
      },
      null,
      2
    )
  )
}
