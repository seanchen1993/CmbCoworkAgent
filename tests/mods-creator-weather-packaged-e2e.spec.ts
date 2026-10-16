/* Real packaged creator journey; loopback model supplies deterministic authoring/tool calls only. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { assertCreatorCreationMetrics, observeCreatorClicks, CREATOR_S1_GATES } from "./support/creator-s1-acceptance"
import { createHostReviewFlow } from "../src/shared/mods/flows/templates"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(
  process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1",
  "Explicit coordinator candidate or built preview required"
)
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const target = join(fixture.workspace, "weather-edit.txt")
writeFileSync(target, "before\n")
const source = `import type { Register } from "claude-code"
export const register: Register = (on) => {
  on("session.start", async ($, event, next) => {
    await $.command.register({name:"set-weather",description:"设置本地天气文字",argumentHint:"天气文字"})
    return next(event)
  })
  on("command.run", {command:"set-weather"}, async ($, event) => {
    await $.store.set("weather", event.args || "晴")
    return {text:"已设置天气：" + (event.args || "晴")}
  })
  on("tool.call", {tool:"edit_file"}, async ($, event, next) => {
    const result = await next(event)
    await $.store.set("calls", Number(await $.store.get("calls") || 0) + 1)
    $.ui.invalidate("ui.render")
    const note = "CREATOR_WEATHER:" + (await $.store.get("weather") || "未设置")
    await $.ui.toast(note)
    if (result && typeof result === "object" && !Array.isArray(result))
      return {...result, context:[note]}
    return result
  })
  on("ui.render", {component:"AbovePrompt"}, async ($, event) => {
    let weather = await $.store.get("forecast")
    if (!weather) {
      const response = await $.http.fetch("FORECAST_URL")
      if (!response.ok) throw Error("forecast unavailable")
      const forecast = JSON.parse(response.text)
      weather = forecast.temperature + "° " + forecast.forecast
      await $.store.set("forecast", weather)
    }
    const {Text} = $.ui.resolve(event)
    return Text({children:"工具计数：" + Number(await $.store.get("calls") || 0) + " · 天气：" + weather})
  })
}
`
const files = [
  {
    path: "plugin.json",
    text: JSON.stringify({
      name: "creator-weather-demo",
      version: "1.0.0",
      description: "隔离工具计数与 HTTP 天气预报演示",
      mods: "mods/manifest.json"
    })
  },
  {
    path: "mods/manifest.json",
    text: JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "creator-weather-demo",
      entry: "main.ts",
      modelProtocol: "result-v1"
    })
  },
  { path: "mods/main.ts", text: source }
]
const errors: string[] = []
const requests: unknown[] = []
let held = false
let release: (() => void) | undefined
let app: ElectronApplication | undefined
let page: Page | undefined
let passed = false
let forecastRequests = 0
const metrics: Record<string, unknown> = {}
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/forecast") {
      forecastRequests++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ temperature: 23, forecast: "晴" }))
      return
    }
    assert.equal(req.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
      assert(raw.length < 3000000)
    }
    const body = JSON.parse(raw)
    assert(requests.length < 24, "Bounded fixture requests")
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const userIndex = messages.findLastIndex((message) => message.role === "user")
    const prompt = JSON.stringify(messages[userIndex])
    const results = messages.slice(userIndex + 1).filter((message) => message.role === "tool")
    let tool: string | undefined
    let args: Record<string, unknown> | undefined
    let text = ""
    if (prompt.includes("CREATE_WEATHER")) {
      if (results.length < 3) {
        if (results.length === 1) {
          const failure = JSON.parse(String(results[0].content))
          assert.equal(failure.result.check.valid, false)
          assert(
            failure.result.check.diagnostics.some(
              (item: { file?: string }) => item.file === "mods/main.ts"
            )
          )
        }
        if (results.length === 2) {
          const failure = JSON.parse(String(results[1].content))
          assert.equal(failure.error, "MODS_RETURN_UNDEFINED")
          assert.equal(failure.target.revision, 2)
          assert.equal(failure.repair.remaining, 1)
          assert.equal(failure.diagnostics[0].event, "session.start")
        }
        tool = "mod_authoring"
        const fixed = files.find((file) => file.path === "mods/main.ts")!.text
        const contents =
          results.length === 0
            ? fixed.replace("    return next(event)\n  })", "  })")
            : results.length === 1
              ? fixed.replace("    return next(event)\n  })", "    return undefined as any\n  })")
              : fixed
        args = {
          action: "submit",
          id: "weather-demo",
          name: "工具计数和天气预报",
          revision: results.length,
          files: files.map((file) =>
            file.path === "mods/main.ts" ? { ...file, text: contents } : file
          )
        }
      } else {
        held = true
        await new Promise<void>((done) => {
          release = done
        })
        text = "CREATOR_DRAFT_READY"
      }
    } else if (prompt.includes("RESUME_WEATHER")) {
      if (!results.length) {
        tool = "mod_authoring"
        args = { action: "resume_trial", id: "weather-demo", revision: 3 }
      } else text = "CREATOR_RESUME_REVIEW_READY"
    } else if (prompt.includes("PERSIST_WEATHER")) {
      if (!results.length) {
        tool = "mod_authoring"
        args = { action: "request_reuse", id: "weather-demo", revision: 3 }
      } else text = "CREATOR_REUSE_REVIEW_READY"
    } else if (JSON.stringify(messages).includes("FIXED_FLOW_SCREENSHOT")) {
      if (!results.length) {
        tool = "structured_output"
        args = {
          passed: true,
          summary:
            "已整理本地天气文字示例的使用方式：设置文字后，编辑文件会显示通知。请确认本次说明。"
        }
      } else text = "已提交本步说明。"
    } else {
      assert(prompt.includes("EDIT_TRIAL") || prompt.includes("EDIT_FORMAL"), prompt)
      if (results.length === 0) {
        tool = "read_file"
        args = { file_path: target }
      } else if (results.length === 1) {
        tool = "edit_file"
        args = {
          file_path: target,
          old_string: prompt.includes("EDIT_TRIAL") ? "before" : "trial",
          new_string: prompt.includes("EDIT_TRIAL") ? "trial" : "formal"
        }
      } else {
        const rendered = JSON.stringify(messages.slice(userIndex + 1))
        requests.push({
          context: rendered,
          stage: prompt.includes("EDIT_TRIAL") ? "trial" : "formal"
        })
        text = prompt.includes("EDIT_TRIAL") ? "TRIAL_EDIT_DONE" : "FORMAL_EDIT_DONE"
      }
    }
    if (tool)
      assert(
        body.tools.some((entry: { function: { name: string } }) => entry.function.name === tool),
        `Missing actual tool ${tool}`
      )
    requests.push({ prompt, tool, args, resultCount: results.length, results })
    res.writeHead(200, { "content-type": "text/event-stream" })
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `creator-${requests.length}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) }
            }
          ]
        }
      : { role: "assistant", content: text }
    for (const value of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: tool ? "tool_calls" : "stop" }
    ])
      res.write(
        `data: ${JSON.stringify({ id: "creator", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, ...value }] })}\n\n`
      )
    res.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    res.writeHead(500).end("fixture rejected")
  }
})
async function poll<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string
): Promise<T> {
  for (let index = 0; index < 240; index++) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((done) => setTimeout(done, 250))
  }
  throw Error(`Timed out: ${label}`)
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const forecastUrl = `http://127.0.0.1:${address.port}/forecast`
  files.find((file) => file.path === "mods/main.ts")!.text = source.replace(
    "FORECAST_URL",
    forecastUrl
  )
  const watchdog = setTimeout(() => void app?.close(), 300000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    // Exercise the original native dialog admission with an exact fixture URL. No
    // global approval or dialog for any other target is accepted by this harness.
    await app.evaluate(({ dialog }, expectedUrl) => {
      const state = globalThis as typeof globalThis & {
        forecastApprovals?: {
          rows: Array<{
            message: string
            signal?: AbortSignal
            resolve(value: { response: number; checkboxChecked: boolean }): void
            decided: boolean
          }>
        }
      }
      state.forecastApprovals = { rows: [] }
      const original = dialog.showMessageBox.bind(dialog)
      dialog.showMessageBox = ((...args: unknown[]) => {
        const options = args.at(-1) as {
          title?: string
          message?: string
          detail?: string
          signal?: AbortSignal
        }
        if (options.title !== "批准插件网络请求")
          return (original as (...input: unknown[]) => unknown)(...args)
        const request = JSON.parse(options.detail ?? "{}")
        if (request.url !== expectedUrl || request.method !== "GET")
          throw Error("Unexpected forecast approval target")
        return new Promise((resolve) =>
          state.forecastApprovals!.rows.push({
            message: options.message ?? "",
            signal: options.signal,
            resolve,
            decided: false
          })
        )
      }) as typeof dialog.showMessageBox
    }, forecastUrl)
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(30000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "creator-loopback",
          name: "隔离制作模型",
          baseUrl: url,
          model: "creator-loopback",
          apiKey: "local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:creator-loopback")
        const thread = await window.api.threads.create({
          title: "Creator weather acceptance",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.getByText("Creator weather acceptance", { exact: true }).first().click()
    const status = () =>
      page!.evaluate((input) => window.api.mods.development.status(input), {
        threadId: scope.threadId
      })
    const send = async (text: string) => {
      await page!.locator("textarea.composer-textarea").fill(text)
      await page!.getByRole("button", { name: "发送消息", exact: true }).click()
    }
    const seeForecast = async () => {
      await poll(
        async () => {
          const pending = await app!.evaluate(() => {
            const state = globalThis as typeof globalThis & {
              forecastApprovals: {
                rows: Array<{
                  signal?: AbortSignal
                  resolve(value: { response: number; checkboxChecked: boolean }): void
                  decided: boolean
                }>
              }
            }
            return state.forecastApprovals.rows.filter((row) => !row.decided).length
          })
          if (pending) {
            await new Promise((resolve) => setTimeout(resolve, 350))
            await app!.evaluate(() => {
              const state = globalThis as typeof globalThis & {
                forecastApprovals: {
                  rows: Array<{
                    signal?: AbortSignal
                    resolve(value: { response: number; checkboxChecked: boolean }): void
                    decided: boolean
                  }>
                }
              }
              for (const row of state.forecastApprovals.rows.filter((row) => !row.decided)) {
                if (row.signal?.aborted)
                  throw Error("Forecast approval expired while awaiting the person")
                row.decided = true
                row.resolve({ response: 1, checkboxChecked: false })
              }
            })
          }
          return page!.getByText(/工具计数：\d+ · 天气：23° 晴/).isVisible()
        },
        Boolean,
        "automatic live HTTP forecast above composer"
      )
    }
    const clicks = await observeCreatorClicks(page)
    const creationStarted = Date.now()
    await send("CREATE_WEATHER 我想聊天框上面有个工具计数和天气预报")
    await poll(async () => held, Boolean, "authoring final response held")
    const needs = await poll(
      status,
      (value) => value.trials[0]?.phase === "needs-approval",
      "trial approval"
    )
    const trial = needs.trials[0]
    assert.equal(trial.revision, 3)
    assert.equal(forecastRequests, 0, "checking failed candidates must not perform HTTP")
    const approve = page.getByRole("button", { name: "确认并应用到这段聊天", exact: true })
    await approve.waitFor()
    const confirmationReady = Date.now()
    assert(await approve.isEnabled())
    assert.equal(await page.getByRole("checkbox").count(), 0)
    await approve.click()
    const confirmedAt = Date.now()
    const queued = await poll(
      status,
      (value) => value.trials[0]?.phase === "queued",
      "trial queued after explicit UI consent"
    )
    assert.equal(queued.trials[0].phase, "queued")
    assert.equal(queued.trials[0].waitingReason, "turn-finishing")
    await page.keyboard.press("Escape")
    release!()
    await page.getByText("CREATOR_DRAFT_READY", { exact: true }).waitFor({ timeout: 60000 })
    await poll(
      status,
      (value) => value.trials[0]?.phase === "active",
      "trial activated after physical completion"
    )
    await seeForecast()
    metrics.creation = { elapsedMs: Date.now() - creationStarted,
      candidateReadyMs: confirmationReady - creationStarted,
      confirmationMs: confirmedAt - confirmationReady,
      authoringCandidates: 3, submitClicks: 1, trialConfirmations: 1,
      nativeHttpConfirmations: 1, technicalPageVisits: 0 }
    Object.assign(metrics.creation as object, { clicks: await clicks.read() })
    assert.equal(forecastRequests, 1)
    const commands = () => page!.evaluate((id) => window.api.mods.commands(id), scope.threadId)
    const trialCommands = await commands()
    assert(
      trialCommands.some(
        (command) => command.command === "set-weather" && command.modId.startsWith("development:")
      )
    )
    await send("/set-weather 晴")
    await page.getByRole("button", { name: /插件命令有结果/ }).click()
    await page.getByText("命令与完成记录", { exact: true }).click()
    await poll(
      async () => page!.locator("body").innerText(),
      (text) => text.includes("已设置天气：晴"),
      "trial command"
    )
    await send("EDIT_TRIAL 修改隔离文件")
    await page.getByRole("button", { name: "允许", exact: true }).click()
    await page.getByText("CREATOR_WEATHER:晴", { exact: true }).waitFor()
    assert.equal(await page.getByText("CREATOR_WEATHER:晴", { exact: true }).count(), 1)
    await page.getByText("TRIAL_EDIT_DONE", { exact: true }).waitFor({ timeout: 60000 })
    assert.equal(readFileSync(target, "utf8"), "trial\n")
    await page.getByText("工具计数：1 · 天气：23° 晴", { exact: true }).waitFor()
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
    await page.getByRole("button", { name: "撤销这次修改", exact: true }).click()
    const undone = await poll(
      status,
      (value) => value.undo?.phase === "active" && value.trials[0]?.phase === "stopped",
      "first trial undo completed through native UI and IPC"
    )
    assert(!(await commands()).some((command) => command.modId.startsWith("development:")))
    writeFileSync(
      join(fixture.isolated, "trial-undo-receipt.json"),
      JSON.stringify(undone, null, 2)
    )
    await page.keyboard.press("Escape")
    await send("RESUME_WEATHER 恢复当前聊天保存的天气功能试用，重新请求我确认。")
    await page.getByText("CREATOR_RESUME_REVIEW_READY", { exact: true }).waitFor({ timeout: 60000 })
    await poll(
      status,
      (value) => value.trials[0]?.phase === "needs-approval",
      "resume requires fresh consent"
    )
    await approve.waitFor()
    assert(await approve.isEnabled())
    await approve.click()
    const resumed = await poll(
      status,
      (value) => value.trials[0]?.phase === "active",
      "trial resumed after explicit UI consent"
    )
    await seeForecast()
    assert(
      (await commands()).some(
        (command) => command.command === "set-weather" && command.modId.startsWith("development:")
      )
    )
    writeFileSync(
      join(fixture.isolated, "trial-resume-receipt.json"),
      JSON.stringify(resumed, null, 2)
    )
    await page.keyboard.press("Escape")
    await send("PERSIST_WEATHER 保存天气功能，在其他聊天也能复用，并应用到当前聊天。")
    const review = await poll(
      status,
      (value) => value.reuse?.phase === "needs-approval",
      "reuse review"
    )
    assert.equal(
      review.trials[0].phase,
      "active",
      "preparing reuse must preserve the running trial"
    )
    assert(
      review.reuse?.sourceDigest && review.reuse.compiledDigest && review.reuse.targetProfileDigest
    )
    await page.getByRole("button", { name: "确认保存并复用", exact: true }).click()
    const formal = await poll(
      status,
      (value) => value.reuse?.phase === "active",
      "one-confirmation formal reuse"
    )
    assert.equal(formal.trials[0].phase, "stopped")
    assert(formal.reuse?.installationId && formal.reuse.savedProfileId)
    await seeForecast()
    assert(!(await commands()).some((command) => command.modId.startsWith("development:")))
    writeFileSync(join(fixture.isolated, "formal-receipt.json"), JSON.stringify(formal, null, 2))
    await poll(
      commands,
      (items) =>
        items.some(
          (command) => command.command === "set-weather" && command.modId.startsWith("function:")
        ),
      "formal command registration"
    )
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    await page.getByRole("tab", { name: "高级设置", exact: true }).click()
    await page.getByRole("button", { name: /set-weather.*设置本地天气文字/ }).waitFor()
    assert.equal(
      await page.getByRole("tab", { name: "高级设置", exact: true }).getAttribute("aria-selected"),
      "true"
    )
    // Hidden native windows can stop issuing the animation frames Playwright's
    // stability check needs. Capture the actual surface without showing/focusing it.
    const captureAssistant = async (path: string) => {
      const box = await page!
        .getByRole("complementary", {
          name: "任务进展",
          exact: true
        })
        .boundingBox()
      assert(box && box.width > 0 && box.height > 0)
      const png = await app!.evaluate(
        async ({ BrowserWindow }, { url, box }) => {
          const window = BrowserWindow.getAllWindows().find(
            (item) => !item.isDestroyed() && item.webContents.getURL() === url
          )
          if (!window) throw Error("Assistant screenshot window missing")
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const image = await Promise.race([
              (async () => {
                // The first hidden capture wakes the compositor; allow its pending
                // DOM paint to commit before collecting the reviewed surface.
                await window.webContents.capturePage(undefined, {
                  stayHidden: true,
                  stayAwake: true
                })
                await new Promise((resolve) => setTimeout(resolve, 100))
                return window.webContents.capturePage(
                  {
                    x: Math.floor(box.x),
                    y: Math.floor(box.y),
                    width: Math.ceil(box.width),
                    height: Math.ceil(box.height)
                  },
                  { stayHidden: true, stayAwake: true }
                )
              })(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(Error("Assistant screenshot timed out")), 30000)
              })
            ])
            if (image.isEmpty()) throw Error("Assistant screenshot is empty")
            return image.toPNG().toString("base64")
          } finally {
            clearTimeout(timer)
          }
        },
        { url: page!.url(), box }
      )
      writeFileSync(path, Buffer.from(png, "base64"))
    }
    await captureAssistant(join(fixture.isolated, "formal-command.png"))
    assert.equal(
      await page.getByRole("tab", { name: "高级设置", exact: true }).getAttribute("aria-selected"),
      "true"
    )
    await send("/set-weather 多云")
    await page.getByRole("button", { name: /插件命令有结果/ }).click()
    const commandRecords = page
      .locator("details")
      .filter({ has: page.getByText("命令与完成记录", { exact: true }) })
    if (!(await commandRecords.evaluate((node) => (node as HTMLDetailsElement).open)))
      await page.getByText("命令与完成记录", { exact: true }).click()
    await poll(
      async () => page!.locator("body").innerText(),
      (text) => text.includes("已设置天气：多云"),
      "formal command"
    )
    await send("EDIT_FORMAL 修改隔离文件")
    await page.getByRole("button", { name: "允许", exact: true }).click()
    await page.getByText("CREATOR_WEATHER:多云", { exact: true }).waitFor()
    assert.equal(await page.getByText("CREATOR_WEATHER:多云", { exact: true }).count(), 1)
    await page.getByText("FORMAL_EDIT_DONE", { exact: true }).waitFor({ timeout: 60000 })
    assert.equal(readFileSync(target, "utf8"), "formal\n")
    const screenFlow = createHostReviewFlow("weather-guide")
    screenFlow.name = "整理使用说明与确认"
    screenFlow.steps[0].name = "整理使用说明"
    if (screenFlow.steps[0].kind === "agent")
      screenFlow.steps[0].prompt =
        "FIXED_FLOW_SCREENSHOT 仅整理本地天气文字的设置与编辑通知使用说明，不调用工具、不修改文件。"
    const saved = await page.evaluate(
      ({ id, definition }) => window.api.mods.flowSave(id, definition, 0),
      { id: scope.threadId, definition: screenFlow }
    )
    await page.getByRole("tab", { name: "高级设置", exact: true }).click()
    await page.getByText("高级：为下一条消息使用预设任务", { exact: true }).click()
    await page.getByRole("button", { name: "重新加载步骤", exact: true }).click()
    await page.getByLabel("本次使用的步骤").selectOption(`${saved.definition.id}:${saved.revision}`)
    await page
      .locator("textarea.composer-textarea")
      .fill("整理天气文字功能的使用说明，完成后由我确认。")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByRole("tab", { name: "当前任务", exact: true }).click()
    await page
      .getByRole("complementary", { name: "任务进展", exact: true })
      .getByRole("region", { name: "人工成果确认", exact: true })
      .waitFor({ timeout: 60000 })
    await captureAssistant(join(fixture.isolated, "current-assistant-run.png"))
    await page
      .getByRole("complementary", { name: "任务进展", exact: true })
      .getByRole("button", { name: "停止任务", exact: true })
      .click()
    assert.equal(errors.length, 0, errors.join("\n"))
    if (process.env.CREATOR_E2E_ACCEPTANCE === "1")
      assertCreatorCreationMetrics("weather", metrics.creation)
    passed = true
    console.log(`PASS creator trial→formal ${candidate.execution} journey: ${fixture.isolated}`)
  } catch (error) {
    errors.push(String(error))
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
    release?.()
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(fixture.isolated, "creator-evidence.json"),
      JSON.stringify(
        {
          passed,
          candidate,
          requests,
          forecastRequests,
          metrics,
          gates: process.env.CREATOR_E2E_ACCEPTANCE === "1" ? CREATOR_S1_GATES : "baseline-only",
          networkConsent:
            "Exact loopback URL native-dialog fixture; trial consent uses real renderer button",
          errors,
          scope: "Original application IPC + original tools + loopback model, isolated workspace"
        },
        null,
        2
      )
    )
    assert.deepEqual(projectCompositionCandidate(root), candidate)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
