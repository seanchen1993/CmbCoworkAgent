import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

export async function verifyUiNotice(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication
): Promise<void> {
  const project = join(workspace, "ui-notice-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "UI notice E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "ui-notice", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"ui-notice",description:"Dialog notice"});return next(e)});
    on("command.run",{command:"ui-notice"},async($,e)=>{
      if(e.args==="late") {$.ui.notice(await $.store.get("call"),"LATE_NOTICE");return {text:"LATE_ACCEPTED"}};
      await $.store.set("cleared",false);
      return {text:"NOTICE_ANSWER:"+await $.ui.ask("Notice question?",["Careful","Fast"])}
    }).catch(()=>({text:"NOTICE_REFUSED"}));
    on("tool.call",{tool:"request_user_input"},async($,e,next)=>{
      await $.store.set("call",e.tool_use_id);return next(e)
    });
    on("ui.render",{component:"AskUserQuestion"},async($,e)=>{
      const {Box,Button}= $.ui.resolve(e);
      const id=await $.store.get("call");
      if(!await $.store.get("cleared")) $.ui.notice(id,"NATIVE_NOTICE");
      return <Box><Button label="Clear plugin notice" onPress={async()=>{
        await $.store.set("cleared",true);$.ui.notice(id,undefined);$.ui.invalidate("ui.render")
      }}/></Box>
    });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "ui-notice.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "ui-notice")!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI notice E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const dialog = page.getByRole("dialog", { name: "需要用户输入" })
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
  const run = async (mode: string) => {
    await composer.fill(`/ui-notice ${mode}`)
    await composer.press("Enter")
  }
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { noticeApproval: typeof dialog.showMessageBox }
    state.noticeApproval = dialog.showMessageBox
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox
  })
  const before = requests.length
  const feedback = () => page.evaluate((id) => window.api.mods.feedback(id), threadId)
  try {
    await run("now")
    await until(
      async () => (await dialog.innerText()).includes("NATIVE_NOTICE"),
      "notice in acknowledged native dialog"
    )
    const entries = await feedback()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].kind, "notice")
    assert(entries[0].requestId && entries[0].toolUseId)
    assert.equal(
      await page.locator("[data-function-feedback]:not([data-function-dialog-notices])").count(),
      0
    )
    assert.equal(await dialog.getByRole("radio").count(), 2)
    await page.screenshot({ path: join(artifacts, "ui-notice-native.png") })
    await dialog.getByRole("button", { name: "Clear plugin notice", exact: true }).click()
    await until(async () => (await feedback()).length === 0, "explicit undefined removes notice")
    assert.equal(await dialog.count(), 1)
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "NOTICE_ANSWER:Careful"),
      "native answer intact"
    )
    assert.equal(requests.length, before)
    pass(
      "ui.notice binds an acknowledged native question and clears without changing answer controls or calling the model"
    )
    await run("late")
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "NOTICE_REFUSED"),
      "settled call refuses notice"
    )
    assert.deepEqual(await feedback(), [])
    pass("settled native call rejects a late void notice through the real guest catch boundary")
    await run("now")
    await until(async () => (await dialog.innerText()).includes("NATIVE_NOTICE"), "second notice")
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () => (await dialog.count()) === 0 && (await feedback()).length === 0,
      "off cleans dialog and notice"
    )
    pass("global off cancels the pending SDK question and removes its notices")
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await run("now")
    await until(
      async () => (await dialog.innerText()).includes("NATIVE_NOTICE"),
      "fresh runtime notice"
    )
    const fresh = await feedback()
    assert.notEqual(fresh[0].requestId, entries[0].requestId)
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "ui-notice"), threadId)
    await until(
      async () => (await dialog.count()) === 0 && (await feedback()).length === 0,
      "revoke cleans dialog and notice"
    )
    pass("runtime replacement binds a fresh request and revocation removes the pending notice")
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "ui-notice-pending-failure.png") })
    throw error
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { noticeApproval?: typeof dialog.showMessageBox }
      if (state.noticeApproval) dialog.showMessageBox = state.noticeApproval
      delete state.noticeApproval
    })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
