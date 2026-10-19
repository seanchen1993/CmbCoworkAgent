/** Real composer/model/transcript regression; unapproved modules never execute.
 * COMPOSITION_E2E_PACKAGED_DIR=<app> npx tsx tests/function-sites-empty-runtime-packaged.spec.ts
 * Optional --expect-retired records the known old-candidate defect and expects reproduction.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit ASAR candidate required")
const expectedBroken = process.argv.includes("--expect-retired")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const requests: unknown[] = []
const results: Array<Record<string, unknown>> = []
const failures: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  assert.equal(body.model, "empty-function-runtime-regression")
  requests.push({ index: requests.length + 1, model: body.model })
  const answer = `FUNCTION_SITE_ACTUAL_ANSWER_${requests.length}`
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const text of [answer.slice(0, 14), answer.slice(14)]) {
    response.write(
      `data: ${JSON.stringify({
        id: "sites",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
      })}\n\n`
    )
    await pause(40)
  }
  response.write(
    `data: ${JSON.stringify({
      id: "sites",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`
  )
  response.end("data: [DONE]\n\n")
})

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 240000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(
        JSON.stringify({
          name: "unapproved-message-module",
          version: "1.0.0",
          hooks: "hooks/hooks.json"
        })
      )
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(
        `export function register(on){on("session.start",{},()=>{throw Error("UNAPPROVED_MODULE_MUST_NEVER_EXECUTE")})}`
      )
    )
    const install = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "unapproved-message-module.zip",
          "local"
        ),
      [...zip.toBuffer()]
    )
    assert(install.success, install.error)
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (item) => item.name === "unapproved-message-module"
    )!
    assert(plugin)
    await page.evaluate(
      async ({ id, url }) => {
        await window.api.plugins.setEnabled(id, true)
        await window.api.mods.configureGlobal(true)
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "empty-function-runtime-regression",
          name: "Local transcript regression",
          baseUrl: url,
          apiKey: "isolated-loopback",
          model: "empty-function-runtime-regression",
          maxTokens: 64000,
          maxOutputTokens: 1024
        })
        await window.api.models.setDefault("custom:empty-function-runtime-regression")
      },
      { id: plugin.id, url: `http://127.0.0.1:${address.port}/v1` }
    )
    for (const [index, scenario] of ["needs-approval", "empty-claw", "all-disabled"].entries()) {
      const workspace = join(fixture.workspace, scenario)
      mkdirSync(workspace)
      const id = await page.evaluate(
        async ({ workspace, scenario, profileId, pluginId }) => {
          const thread = await window.api.threads.create({
            title: `Transcript ${scenario}`,
            workspacePath: workspace,
            agentMode: "normal"
          })
          await window.api.workspace.set(thread.thread_id, workspace)
          const initial = await window.api.mods.status(thread.thread_id)
          await window.api.mods.configure(thread.thread_id, true, true, initial.workspace)
          if (scenario === "empty-claw") {
            let view = await window.api.mods.clawView(thread.thread_id)
            view = await window.api.mods.clawChange(thread.thread_id, {
              kind: "save",
              workspace: view.workspace,
              revision: view.revision,
              profile: {
                id: profileId,
                name: "Explicit empty selection",
                capabilities: [],
                builtins: { contextMeter: false },
                skills: { mode: "selected", items: [] },
                mcp: { mode: "selected", items: [] }
              }
            })
            await window.api.mods.clawChange(thread.thread_id, {
              kind: "apply",
              id: profileId,
              workspace: view.workspace,
              revision: view.revision,
              bindingRevision: view.bindingRevision
            })
          }
          if (scenario === "all-disabled") {
            await window.api.plugins.setEnabled(pluginId, false)
            await window.api.mods.configureGlobal(false)
          }
          return thread.thread_id
        },
        { workspace, scenario, profileId: randomUUID(), pluginId: plugin.id }
      )
      const status = await page.evaluate((thread) => window.api.mods.status(thread), id)
      if (scenario === "needs-approval")
        assert(
          status.functionMods?.some(
            (item) => item.name === plugin.name && item.state === "needs-approval"
          ),
          JSON.stringify(status)
        )
      await page.reload()
      await page.getByText(`Transcript ${scenario}`, { exact: true }).first().click()
      const question = `FUNCTION_SITE_ACTUAL_QUESTION_${index + 1}`
      const answer = `FUNCTION_SITE_ACTUAL_ANSWER_${index + 1}`
      await page.locator("textarea.composer-textarea").fill(question)
      await page.getByRole("button", { name: "发送消息", exact: true }).click()
      let persisted = false
      for (let attempt = 0; attempt < 160; attempt++) {
        const messages = await page.evaluate((thread) => window.api.threads.getMessages(thread), id)
        if (JSON.stringify(messages).includes(answer)) {
          persisted = true
          break
        }
        await pause(125)
      }
      assert(persisted, `Actual model answer must persist for ${scenario}`)
      await page.getByRole("button", { name: "发送消息", exact: true }).waitFor()
      const observed: unknown[] = []
      const startedObserving = Date.now()
      let body = ""
      for (let attempt = 0; attempt < 150; attempt++) {
        body = await page.locator("body").innerText()
        observed.push({
          elapsedMs: Date.now() - startedObserving,
          question: body.includes(question),
          answer: body.includes(answer),
          unavailable: body.includes("当前界面暂不可用")
        })
        if (body.includes(question) && body.includes(answer) && !body.includes("当前界面暂不可用"))
          break
        await pause(100)
      }
      const display = {
        question: body.includes(question),
        answer: body.includes(answer),
        unavailable: body.includes("当前界面暂不可用"),
        unapprovedExecuted: body.includes("UNAPPROVED_MODULE_MUST_NEVER_EXECUTE")
      }
      const beforeReloadGood =
        display.question && display.answer && !display.unavailable && !display.unapprovedExecuted
      const beforeReload = await page.evaluate(
        async (thread) => ({
          runtime: await window.api.mods.runtimeSessions(thread),
          status: await window.api.mods.status(thread),
          sites: Array.from(document.querySelectorAll("[data-function-site]")).map((node) => ({
            site: node.getAttribute("data-function-site"),
            busy: node.getAttribute("aria-busy"),
            text: (node.textContent ?? "").slice(0, 200)
          })),
          list: Array.from(document.querySelectorAll('[data-testid="virtuoso-item-list"]')).map(
            (node) => ({
              children: node.children.length,
              text: (node.textContent ?? "").slice(0, 400),
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height
            })
          ),
          stopButtons: Array.from(document.querySelectorAll('[aria-label="停止生成"]')).length
        }),
        id
      )
      writeFileSync(join(fixture.isolated, `${scenario}.txt`), body)
      await page
        .screenshot({
          path: join(fixture.isolated, `${scenario}.png`),
          timeout: 3000,
          animations: "disabled"
        })
        .catch(() => {})
      await page.reload()
      await page.getByText(`Transcript ${scenario}`, { exact: true }).first().click()
      await page.locator("textarea.composer-textarea").waitFor()
      await pause(1250)
      const rehydratedBody = await page.locator("body").innerText()
      const rehydrated = {
        question: rehydratedBody.includes(question),
        answer: rehydratedBody.includes(answer),
        unavailable: rehydratedBody.includes("当前界面暂不可用"),
        unapprovedExecuted: rehydratedBody.includes("UNAPPROVED_MODULE_MUST_NEVER_EXECUTE")
      }
      const good =
        beforeReloadGood &&
        rehydrated.question &&
        rehydrated.answer &&
        !rehydrated.unavailable &&
        !rehydrated.unapprovedExecuted
      if (!good) failures.push(scenario)
      const runtime = await page.evaluate((thread) => window.api.mods.runtimeSessions(thread), id)
      results.push({
        scenario,
        status,
        persisted,
        display,
        observed,
        beforeReload,
        rehydrated,
        good,
        runtime
      })
      writeFileSync(join(fixture.isolated, `${scenario}-reopened.txt`), rehydratedBody)
      await page
        .screenshot({
          path: join(fixture.isolated, `${scenario}-reopened.png`),
          timeout: 3000,
          animations: "disabled"
        })
        .catch(() => {})
      assert.equal(requests.length, index + 1, "Exactly one actual request per composer submission")
    }
    const evidence = {
      candidate,
      isolated: fixture.isolated,
      expectedBroken,
      requests,
      results,
      failures,
      limits:
        "Real isolated packaged composer/loopback model/turn.step/persistence/transcript. No plugin grants, plugin execution or user data changes."
    }
    const output = resolve("output/demo-readiness-20261016")
    mkdirSync(output, { recursive: true })
    const name = `function-sites-empty-runtime-${expectedBroken ? "before" : "after"}.json`
    writeFileSync(join(output, name), JSON.stringify(evidence, null, 2))
    writeFileSync(join(fixture.isolated, "evidence.json"), JSON.stringify(evidence, null, 2))
    if (expectedBroken)
      assert(
        failures.includes("needs-approval"),
        "Old candidate must reproduce the reported retired-site rendering defect"
      )
    else
      assert.deepEqual(
        failures,
        [],
        `User and assistant must remain readable: ${failures.join(", ")}`
      )
    console.log(
      `PASS ${expectedBroken ? "old defect reproduced" : "native transcript regression"}: ${fixture.isolated}`
    )
  } catch (error) {
    await page
      ?.screenshot({ path: join(fixture.isolated, "failure.png"), timeout: 3000 })
      .catch(() => {})
    if (page)
      writeFileSync(
        join(fixture.isolated, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      )
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
