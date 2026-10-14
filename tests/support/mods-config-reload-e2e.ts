import assert from "node:assert/strict"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Real preload, SQLite and utility-process guest; no model or permission substitutes. */
export async function verifyConfigurationReload(
  page: Page,
  threadId: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  whileStopped: () => Promise<void>
) {
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name: "configuration-reload-demo",
        userConfig: {
          tone: {
            type: "string",
            title: "重载风格",
            description: "保存后重新加载当前组合采用新风格",
            default: "warm"
          }
        }
      })
    )
  )
  zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on,options){
    on("session.start",async($,e,next)=>{
      await $.store.set("actual-startup",options.tone);
      if(options.tone==="broken")try{await $.tool.call({name:"nonexistent",input:{}})}catch{}
      await $.command.register({name:"reload-read",description:options.tone,immediate:true});
      return next(e)
    });on("command.run",{command:"reload-read"},async($)=>({text:options.tone}))
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "config-reload-demo.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((row) => row.name === "configuration-reload-demo")!
  assert(mod?.digest)
  await page.evaluate(
    ({ threadId, mod }) => window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!),
    { threadId, mod }
  )
  const commands = () => page.evaluate((id) => window.api.mods.commands(id), threadId)
  assert.equal((await commands()).find((row) => row.command === "reload-read")?.name, "warm")
  await page.getByText("插件参数安全应用", { exact: true }).first().click()
  await page.getByRole("button", { name: "自定义设置", exact: true }).click()
  await page.getByRole("button", { name: "Function Mods", exact: true }).click()
  const form = page.locator(`[data-function-user-config="${mod.pluginId}"]`)
  await form.locator("summary").click()
  await form.getByLabel("重载风格").fill("formal")
  await form.getByRole("button", { name: "保存", exact: true }).click()
  await until(async () => {
    const view = await page.evaluate(
      ({ threadId, mod }) => window.api.mods.userConfig(threadId, mod.pluginId),
      { threadId, mod }
    )
    return view.state === "failed" && view.savedRevision === 1 && view.effectiveRevision === 0
  }, "effectsful startup cannot be privately retried while the original instance is retained")
  assert.equal((await commands()).find((row) => row.command === "reload-read")?.name, "warm")
  pass("Real parameter save retains old effectsful startup until native explicit reload")
  const reload = form.getByRole("button", { name: "重新加载当前组合", exact: true })
  await reload.click()
  await form.getByRole("status").filter({ hasText: "当前对话已应用" }).waitFor()
  assert.equal((await commands()).find((row) => row.command === "reload-read")?.name, "formal")
  await page.screenshot({ path: join(artifacts, "configuration-reloaded.png"), fullPage: true })
  pass(
    "Actual parameter form reloads the complete current chain and adopts the new register snapshot"
  )
  await form.getByLabel("重载风格").fill("broken")
  await form.getByRole("button", { name: "保存", exact: true }).click()
  await until(async () => {
    const view = await page.evaluate(
      ({ threadId, mod }) => window.api.mods.userConfig(threadId, mod.pluginId),
      { threadId, mod }
    )
    return view.state === "failed" && view.savedRevision === 2
  }, "second saved version awaits an explicit restart")
  await reload.click()
  await form.getByRole("status").filter({ hasText: "当前组合已停用" }).waitFor()
  assert.deepEqual(await commands(), [])
  await page.screenshot({
    path: join(artifacts, "configuration-reload-stopped.png"),
    fullPage: true
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  const stopped = await page.evaluate(
    ({ threadId, mod }) => window.api.mods.userConfig(threadId, mod.pluginId),
    { threadId, mod }
  )
  assert.equal(stopped.state, "stopped")
  assert.deepEqual(await commands(), [])
  pass("A caught real startup rejection shows stopped and renderer reload does not replay effects")
  await whileStopped()
  const saved = await page.evaluate(
    ({ threadId, stopped }) => window.api.mods.saveUserConfig(threadId, stopped, "tone", "formal"),
    { threadId, stopped }
  )
  assert.equal(saved.state, "stopped")
  const result = await page.evaluate(
    ({ threadId, saved }) => window.api.mods.reloadUserConfig(threadId, saved),
    { threadId, saved }
  )
  assert.equal(result.state, "applied")
  assert.equal((await commands()).find((row) => row.command === "reload-read")?.name, "formal")
  pass(
    "Saving a repaired value retains stopped; an explicit native retry restores the complete chain"
  )
}
