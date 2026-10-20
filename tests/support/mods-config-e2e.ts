import { openModUserConfig, openModsSettings } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { verifyConfigurationReload } from "./mods-config-reload-e2e"

/** Real SQLite, IPC, utility guest, physical graph lease and logical turn completion. */
export async function verifyConfiguration(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
) {
  let response: ServerResponse | undefined
  let calls = 0
  const server = createServer(async (request, result) => {
    for await (const chunk of request) void chunk
    calls++
    response = result
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    const id = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.models.setCustomConfig({
          id: "config-fixture",
          name: "Config fixture",
          model: "gpt-4",
          baseUrl: url,
          apiKey: "fixture-key",
          maxTokens: 32000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:config-fixture")
        const thread = await window.api.threads.create({
          title: "插件参数安全应用",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.threads.patchMetadata(id, { set: { model: "custom:config-fixture" } })
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(
        JSON.stringify({
          name: "configuration-demo",
          userConfig: {
            tone: {
              type: "string",
              title: "回复风格",
              description: "用于这个插件的下一次任务",
              default: "warm"
            },
            flag: {
              type: "boolean",
              title: "启用检查",
              description: "保留关闭这个合法值",
              default: false
            },
            budget: {
              type: "number",
              title: "检查上限",
              description: "保留零这个合法值",
              default: 0
            },
            files: {
              type: "string",
              multiple: true,
              title: "检查列表",
              description: "逐项保持原文",
              default: ["one,two", "line\nbreak"]
            },
            legacy: {
              type: "string",
              multiple: true,
              title: "原有单项",
              description: "保存前保持原值",
              default: "old,scalar\nvalue"
            },
            report: {
              type: "file",
              title: "报告文件",
              description: "指定路径不增加文件权限"
            },
            folder: {
              type: "directory",
              title: "检查目录",
              description: "指定目录不改变项目"
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
        await $.state.get({plugin:"configuration-demo",key:"startup-read"});
        await $.command.register({name:"config-read",description:JSON.stringify(options),immediate:true});return next(e)});
      on("config.describe",async($,e,next)=>{const row=await next(e);
        return e.key==="gitChangeNoticeEnabled"?{...row,description:"配置模组提供的真实帮助"}:row});
      on("command.run",async($)=>({text:JSON.stringify(options)}))
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "config-demo.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "configuration-demo"
    )!
    assert(mod?.digest)
    const initial = await page.evaluate(
      ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
      { id, mod }
    )
    assert.equal(initial.state, "inactive")
    assert.equal(initial.fields.find((field) => field.key === "flag")?.value, false)
    assert.equal(initial.fields.find((field) => field.key === "budget")?.value, 0)
    pass(
      "Native author parameters are editable before approval and retain actual false/zero defaults"
    )
    await page.evaluate(
      ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
      { id, mod }
    )
    const commands = () => page.evaluate((id) => window.api.mods.commands(id), id)
    assert((await commands()).find((row) => row.command === "config-read")?.name.includes("warm"))
    const rows = await page.evaluate((id) => window.api.mods.configList(id), id)
    const git = rows.find((row) => row.key === "gitChangeNoticeEnabled")!
    assert.equal(git.description, "配置模组提供的真实帮助")
    const changed = await page.evaluate(
      ({ id, value }) => window.api.mods.configSet(id, "gitChangeNoticeEnabled", value),
      { id, value: !git.value }
    )
    assert.deepEqual(changed, { value: !git.value })
    assert.equal(await page.evaluate(() => window.electron.getGitChangeNoticeEnabled()), !git.value)
    pass(
      "Config hooks describe and change the same durable Git setting used by the original application"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("插件参数安全应用", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("Verify parameter application during a real task")
    await composer.press("Enter")
    await until(async () => calls === 1, "real graph entered the controlled model")
    const before = await page.evaluate(
      ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
      { id, mod }
    )
    const saved = await page.evaluate(
      ({ id, before }) => window.api.mods.saveUserConfig(id, before, "tone", "formal"),
      { id, before }
    )
    assert.equal(saved.state, "pending")
    assert.equal(saved.savedRevision, 1)
    assert.equal(saved.effectiveRevision, 0)
    assert((await commands()).find((row) => row.command === "config-read")?.name.includes("warm"))
    const retry = await page.evaluate(
      ({ id, saved }) => window.api.mods.applyUserConfig(id, saved),
      { id, saved }
    )
    assert.equal(retry.state, "pending")
    pass(
      "Real graph and logical turn preserve old parameters; saving ACK and explicit apply return without waiting for themselves"
    )
    assert(response)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      `data: ${JSON.stringify({
        id: "config-done",
        object: "chat.completion.chunk",
        model: "gpt-4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "CONFIG_TASK_DONE" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      })}\n\ndata: [DONE]\n\n`
    )
    await until(
      async () => (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "physical run and logical completion released"
    )
    await until(async () => {
      const view = await page.evaluate(
        ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
        { id, mod }
      )
      return view.state === "applied" && view.effectiveRevision === 1
    }, "automatic idle application without another command")
    assert((await commands()).find((row) => row.command === "config-read")?.name.includes("formal"))
    pass(
      "Actual idle callbacks adopt the new registration after original task cleanup without another user command"
    )
    await openModsSettings(page)
    const form = await openModUserConfig(page, mod.pluginId)
    await form.getByLabel("回复风格").waitFor()
    assert.equal(await form.getByLabel("回复风格").inputValue(), "formal")
    await form.getByRole("status").filter({ hasText: "当前对话已应用" }).waitFor()
    await page.screenshot({ path: join(artifacts, "configuration-applied.png"), fullPage: true })
    pass(
      "Real application settings show saved and applied parameters with clear usage instructions"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    const persisted = await page.evaluate(
      ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
      { id, mod }
    )
    assert.equal(persisted.savedRevision, 1)
    assert.equal(persisted.fields.find((field) => field.key === "tone")?.value, "formal")
    pass("Reloaded renderer reads the same actual SQLite revision and author value")
    await openModsSettings(page)
    const specialForm = await openModUserConfig(page, mod.pluginId)
    await specialForm.getByLabel("检查列表 第 1 项", { exact: true }).waitFor()
    assert.equal(
      await specialForm.getByLabel("原有单项 第 1 项", { exact: true }).inputValue(),
      "old,scalar\nvalue"
    )
    const list = specialForm.locator('[data-config-list="files"]').locator("xpath=../..")
    await specialForm
      .getByLabel("检查列表 第 1 项", { exact: true })
      .fill("actual,comma\nactual newline")
    await list.getByRole("button", { name: "添加一项", exact: true }).click()
    await list.getByRole("button", { name: "保存", exact: true }).click()
    await until(async () => {
      const view = await page.evaluate(
        ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
        { id, mod }
      )
      return view.savedRevision === 2 && view.state === "applied"
    }, "actual list save adopted")
    const fileRow = specialForm.getByLabel("报告文件", { exact: true }).locator("xpath=../..")
    await specialForm.getByLabel("报告文件", { exact: true }).fill(join(workspace, "report.txt"))
    await fileRow.getByRole("button", { name: "保存", exact: true }).click()
    await until(async () => {
      const view = await page.evaluate(
        ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
        { id, mod }
      )
      return view.savedRevision === 3 && view.state === "applied"
    }, "actual file row save adopted")
    const options = JSON.parse(
      (await commands()).find((row) => row.command === "config-read")!.name
    )
    assert.deepEqual(options.files, ["actual,comma\nactual newline", "line\nbreak", ""])
    assert.equal(options.legacy, "old,scalar\nvalue")
    assert.equal(options.report, join(workspace, "report.txt"))
    assert.equal(options.folder, "")
    const actualRows = await page.evaluate((id) => window.api.mods.configList(id), id)
    assert.equal(actualRows.find((row) => row.key === "configuration-demo.report")?.kind, "text")
    assert.equal(
      actualRows.some((row) => row.key === "configuration-demo.files"),
      false
    )
    await page.screenshot({
      path: join(artifacts, "configuration-special-parameters.png"),
      fullPage: true
    })
    pass(
      "Actual React list/file saves, SQLite revisions, utility guest register options and ordinary SDK row eligibility agree"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    const listPersisted = await page.evaluate(
      ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
      { id, mod }
    )
    assert.equal(listPersisted.savedRevision, 3)
    assert.deepEqual(
      listPersisted.fields.find((field) => field.key === "files")?.value,
      options.files
    )
    pass(
      "Actual special parameter values persist across renderer reload without splitting legacy scalar options"
    )
    await verifyConfigurationReload(page, id, artifacts, until, pass, async () => {
      await page.getByText("插件参数安全应用", { exact: true }).first().click()
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill("Continue ordinary chat after the component startup failed")
      await composer.press("Enter")
      await until(
        async () => calls === 2,
        "stopped combination still enters the real ordinary graph"
      )
      assert(response)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        `data: ${JSON.stringify({
          id: "stopped-chat",
          object: "chat.completion.chunk",
          model: "gpt-4",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "CONFIG_STOPPED_CHAT_DONE" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        })}\n\ndata: [DONE]\n\n`
      )
      await until(
        async () =>
          (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
        "ordinary task after failed startup completes"
      )
      await page.getByText("CONFIG_STOPPED_CHAT_DONE", { exact: true }).first().waitFor()
      pass("A stopped combination still completes a real ordinary chat without replaying startup")
    })
  } finally {
    response?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
