import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Real Claw UI/IPC, zero uploaded modules and the production builtin guest pipeline. */
export async function verifyBuiltinContextMeter(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "builtin-context-meter")
  mkdirSync(project)
  const title = "内置上下文计量验收"
  const threadId = await page.evaluate(
    async ({ project, title }) => {
      const thread = await window.api.threads.create({
        title,
        workspacePath: project,
        agentMode: "normal"
      })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    },
    { project, title }
  )
  const view = () => page.evaluate((id) => window.api.mods.clawView(id), threadId)
  const above = page.locator('[data-function-site="AbovePrompt"]')
  const meter = () => above.innerText()
  const edit = async () => {
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "我的 Claw", exact: true }).click()
    await page.getByLabel("Claw 组合名称").waitFor()
  }
  const saveAndApply = async () => {
    await page.getByRole("button", { name: "保存能力组合", exact: true }).click()
    await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
  }
  const chat = () => page.getByRole("button", { name: "回到聊天使用", exact: true }).click()
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText(title, { exact: true }).first().click()
  assert.deepEqual((await view()).capabilities, [])
  assert.equal((await view()).active?.builtins?.contextMeter === true, false)
  await edit()
  assert.equal(await page.getByLabel("启用聊天容量提示").isChecked(), false)
  await page.getByLabel("Claw 组合名称").fill("只有内置计量")
  await page.getByLabel("启用聊天容量提示").check()
  await saveAndApply()
  assert.deepEqual((await view()).active?.capabilities, [])
  assert.equal((await view()).active?.builtins?.contextMeter, true)
  await chat()
  const first = requests.length
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("[mods-builtin-context-meter] Show a short reply for this actual session.")
  await composer.press("Enter")
  await until(
    async () =>
      requests.length > first &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0 &&
      /上下文.*\d+ \/ \d+ tokens/.test(await meter()),
    "zero-plugin builtin actual context display"
  )
  const originalMeter = await meter()
  assert.deepEqual((await view()).capabilities, [])
  await page.screenshot({ path: join(artifacts, "builtin-zero-plugin.png") })
  pass(
    "Zero uploaded plugins: Claw opt-in starts the real builtin and renders actual session context"
  )

  await edit()
  await page.getByLabel("启用聊天容量提示").uncheck()
  await page.getByRole("button", { name: "保存能力组合", exact: true }).click()
  assert.equal((await view()).active?.builtins?.contextMeter, true)
  await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  await page.getByText("关闭内置上下文计量", { exact: true }).waitFor()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await chat()
  await until(async () => !(await meter()).includes("tokens"), "disabled builtin clears drawing")
  pass("Saving an off draft preserves the applied snapshot; applying it clears the old builtin UI")

  for (const [name, hook] of [
    [
      "builtin-ui-wrap",
      `on("ui.render",{component:"AbovePrompt"},async($,e,next)=>{
      const tree=await next(e)
      return $.ui.resolve(e).Box({children:[$.ui.resolve(e).Text({children:"BUILTIN_WRAP:"}),tree]})
    })`
    ],
    [
      "builtin-ui-replace",
      `on("ui.render",{component:"AbovePrompt"},($,e)=>
      $.ui.resolve(e).Text({children:"BUILTIN_USER_REPLACEMENT"}))`
    ]
  ]) {
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name, version: "1.0.0", tier: "builtin" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
    zip.addFile("hooks/register.ts", Buffer.from(`export function register(on){${hook}}`))
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "builtin-ui.zip",
          "local",
          undefined,
          true
        ),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    await page.evaluate(
      async ({ threadId, name }) => {
        const row = (await window.api.mods.status(threadId)).functionMods!.find(
          (item) => item.name === name
        )!
        await window.api.mods.approveFunction(threadId, row.pluginId, row.digest!)
      },
      { threadId, name }
    )
  }
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText(title, { exact: true }).first().click()
  await edit()
  await page.getByLabel("启用聊天容量提示").check()
  await page.getByLabel("选择能力 builtin-ui-wrap", { exact: true }).check()
  await saveAndApply()
  await chat()
  // Reload/apply invalidates the prior runtime request. Bind a new actual model request;
  // a retained historical count must not be promoted to current-window evidence.
  const wrappedRequest = requests.length
  await composer.fill("[mods-builtin-context-meter] Refresh actual context for the applied wrapper.")
  await composer.press("Enter")
  await until(
    async () => requests.length > wrappedRequest &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0 &&
      /^BUILTIN_WRAP:上下文/.test((await meter()).replace(/\s+/g, "")),
    "user wraps builtin through next"
  )
  pass("An approved user Hook wraps the builtin's real AbovePrompt result through next")
  await edit()
  await page.getByLabel("选择能力 builtin-ui-replace", { exact: true }).check()
  await saveAndApply()
  await chat()
  await until(
    async () => (await meter()).replace(/\s+/g, "") === "BUILTIN_WRAP:BUILTIN_USER_REPLACEMENT",
    "saved wrapper-first order"
  )
  await edit()
  await page.getByLabel("上移能力 builtin-ui-replace", { exact: true }).click()
  await page.getByRole("button", { name: "保存能力组合", exact: true }).click()
  await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  await page
    .getByText("调整插件顺序：builtin-ui-replace → builtin-ui-wrap", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  assert.deepEqual(
    (await view()).active?.capabilities.map((item) => item.name),
    ["builtin-ui-replace", "builtin-ui-wrap"]
  )
  await chat()
  await until(
    async () => (await meter()) === "BUILTIN_USER_REPLACEMENT",
    "user replaces builtin in saved order"
  )
  await page.screenshot({ path: join(artifacts, "builtin-user-replacement.png") })
  pass("Saved Claw order changes the real Hook chain; a user Hook directly replaces the builtin")
  writeFileSync(
    join(artifacts, "builtin-context-meter.json"),
    JSON.stringify(
      {
        originalMeter,
        applied: (await view()).active,
        final: await meter()
      },
      null,
      2
    )
  )
}
