/** Production IPC + renderer, isolated profile and loopback model; never uses user credentials. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const fixture = projectCompositionEnvironment(root)
const candidate = projectCompositionCandidate(root)
const model = "uninstall-loopback"
const title = "Mods uninstall regression"
let app: ElectronApplication | undefined
let page: Page | undefined
let requests = 0
let phase = "before"
let entered = Promise.withResolvers<void>()
let resume = Promise.withResolvers<void>()
const errors: string[] = []
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) raw += chunk
    assert.equal(JSON.parse(raw).model, model)
    assert(++requests <= 3, "Uninstall must not replay a model request")
    if (phase === "during") {
      entered.resolve()
      await resume.promise
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content: `UNINSTALL_ANSWER_${phase}` }, null],
      [{}, "stop"]
    ])
      response.write(
        `data: ${JSON.stringify({
          id: `uninstall-${requests}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`
      )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

function plugin(name: string) {
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.tsx"]}'))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on) {
    on("ui.render", {component:"AbovePrompt"}, async ($,e,next) => {
      const {Box,Text}=$.ui.resolve(e)
      const body = await next(e)
      return <Box><Text>${name}</Text>{body}</Box>
    })
  }`)
  )
  return [...zip.toBuffer()]
}

async function readable(value: string) {
  assert(page)
  await page.waitForFunction((text) => document.body.innerText.includes(text), value)
}

async function ask(name: string, retire?: () => Promise<void>) {
  assert(page)
  phase = name
  entered = Promise.withResolvers<void>()
  resume = Promise.withResolvers<void>()
  await page.locator("textarea.composer-textarea").fill(`UNINSTALL_QUESTION_${name}`)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  if (retire) {
    await Promise.race([
      entered.promise,
      new Promise((_, reject) => setTimeout(() => reject(Error("model was not reached")), 30000))
    ])
    await retire()
    resume.resolve()
  }
  await readable(`UNINSTALL_ANSWER_${name}`)
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor()
  assert.deepEqual(errors, [])
}

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => {
    resume.resolve()
    void app?.close()
  }, 180000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => !!window.api?.mods)
    const ids = await page.evaluate(
      async ({ workspace, model, url, title, packages }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: model,
          name: model,
          baseUrl: url,
          apiKey: "loopback-only",
          model,
          maxTokens: 64000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:" + model)
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = thread.thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configureGlobal(true)
        const initial = await window.api.mods.status(id)
        await window.api.mods.configure(id, true, true, initial.workspace)
        const capabilities: Array<{ pluginId: string; name: string; digest: string }> = []
        for (const bytes of packages) {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "test.zip",
            "local"
          )
          if (!result.success) throw Error(result.error)
        }
        for (const source of await window.api.plugins.list()) {
          await window.api.plugins.setEnabled(source.id, true)
          const status = await window.api.mods.status(id)
          const compiled = status.functionMods!.find((item) => item.pluginId === source.id)!
          await window.api.mods.approveFunction(id, source.id, compiled.digest!, status.workspace)
          capabilities.push({ pluginId: source.id, name: compiled.name, digest: compiled.digest! })
        }
        const before = await window.api.mods.clawView(id)
        const saved = await window.api.mods.clawChange(id, {
          kind: "save",
          workspace: before.workspace,
          revision: before.revision,
          profile: { id: "uninstall", name: "Two Mods", capabilities }
        })
        await window.api.mods.clawChange(id, {
          kind: "apply",
          workspace: saved.workspace,
          revision: saved.revision,
          id: "uninstall",
          bindingRevision: saved.bindingRevision
        })
        return {
          thread: id,
          removed: capabilities.find((item) => item.name === "uninstall-target")!.pluginId,
          retained: capabilities.find((item) => item.name === "uninstall-retained")!.pluginId
        }
      },
      {
        workspace: fixture.workspace,
        model,
        title,
        url: `http://127.0.0.1:${address.port}/v1`,
        packages: [plugin("uninstall-target"), plugin("uninstall-retained")]
      }
    )
    await page.reload()
    await page.getByText(title, { exact: true }).first().click()
    await readable("uninstall-target")
    await readable("uninstall-retained")
    await ask("before")
    await ask("during", async () => {
      await page!.getByRole("button", { name: "自定义设置", exact: true }).click()
      const advanced = page!.getByRole("button", { name: "高级自定义", exact: true })
      if ((await advanced.getAttribute("aria-expanded")) === "false") await advanced.click()
      await page!.getByRole("button", { name: "灵件管理", exact: true }).click()
      await page!
        .getByRole("navigation", { name: "灵件工作区" })
        .getByRole("button", { name: "我已添加", exact: true })
        .click()
      const row = page!.locator(`[data-installed-mod-id="${ids.removed}"]`)
      await row.getByRole("button", { name: "卸载", exact: true }).click()
      await page!
        .getByRole("dialog", { name: "卸载插件", exact: true })
        .getByRole("button", { name: "确认卸载", exact: true })
        .click()
      await row.waitFor({ state: "detached" })
      await page!.keyboard.press("Escape")
    })
    await readable("UNINSTALL_ANSWER_before")
    await readable("uninstall-retained")
    await ask("after")
    await page.reload()
    await page.getByText(title, { exact: true }).first().click()
    for (const name of ["before", "during", "after"]) {
      await readable(`UNINSTALL_QUESTION_${name}`)
      await readable(`UNINSTALL_ANSWER_${name}`)
    }
    const view = await page.evaluate((id) => window.api.mods.clawView(id), ids.thread)
    assert.deepEqual(view.issues, [])
    assert.deepEqual(
      view.active?.capabilities.map((item) => item.pluginId),
      [ids.retained]
    )
    assert.equal(view.profiles[0].capabilities.length, 2, "Saved template remains reviewable")
    const body = await page.locator("body").innerText()
    assert(!body.includes("当前界面暂不可用"))
    assert(!body.includes("灵件显示更新失败"))
    assert.equal(requests, 3)
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          candidate,
          requests,
          ids,
          view,
          scope:
            "Live uninstall during native model; history, next turn, unrelated Mod and renderer reload"
        },
        null,
        2
      )
    )
    await page.screenshot({
      path: join(fixture.isolated, "after-uninstall.png"),
      animations: "disabled"
    })
    console.log(`PASS uninstall conversation: ${fixture.isolated}`)
  } catch (error) {
    writeFileSync(
      join(fixture.isolated, "failure.json"),
      JSON.stringify({ candidate, requests, errors, error: String(error) })
    )
    if (page)
      writeFileSync(
        join(fixture.isolated, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      )
    throw error
  } finally {
    resume.resolve()
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
