/** Built production renderer/preload/IPC/startAgentRun, with a loopback provider only.
 * No business IPC is mocked. Presentation suppression is not ASAR acceptance.
 * Run after the coordinator's candidate build; all mutable state is under output/.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join, relative, isAbsolute } from "node:path"
import type { ElectronApplication } from "playwright"
import { runCompositionHandoffScenario } from "./support/project-composition-handoff-scenario"
import { runCompositionLongSession } from "./support/project-composition-long-session"
import {
  compositionParentAdapter,
  compositionHostFlow,
  compositionStandaloneSkill,
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const fixture = projectCompositionEnvironment(root)
const candidate = projectCompositionCandidate(root)
const observations: Array<{ prompt: string; alpha: boolean; beta: boolean }> = []
const errors: string[] = []
const captureWarnings: string[] = []
const handoffOnly = process.env.COMPOSITION_E2E_HANDOFF_ONLY === "1"
const longOnly = process.env.COMPOSITION_E2E_LONG_ONLY === "1"
const longTurns = process.env.COMPOSITION_E2E_LONG_DIAGNOSTIC === "1" ? 5 : 20
let longSessionTimings: Awaited<ReturnType<typeof runCompositionLongSession>> = []
const handoffRequests: Array<{ reader: boolean; tool?: string }> = []
const hostRequests: Array<{ goal: string; wrote: boolean; workspace: string }> = []
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    assert.equal(request.method, "POST")
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      assert(bytes < 2 * 1024 * 1024)
      chunks.push(Buffer.from(chunk))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    assert.equal(body.model, "composition-loopback")
    assert(observations.length < (longOnly ? 24 : 12), "No uncontrolled inference retries")
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const prompt = JSON.stringify(messages.filter((message) => message.role === "user").at(-1))
    const instructions = JSON.stringify(messages.filter((message) => message.role !== "user"))
    if (
      handoffOnly &&
      prompt.includes("HANDOFF") &&
      instructions.includes("composition-reader-report")
    ) {
      assert(handoffRequests.length < 12)
      assert(
        !instructions.includes("composition-host-report"),
        "Reader only receives its exact source"
      )
      const parts = messages.flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : Array.isArray(message.content)
            ? message.content.map((part) => part?.text ?? "")
            : []
      )
      const workspace = /The workspace root is: ([^\r\n]+)/
        .exec(parts.join("\n"))?.[1]
        ?.trim()
        .replace(/^`|`$/g, "")
      assert(workspace)
      const below = relative(fixture.isolated, workspace)
      assert(below && !below.startsWith("..") && !isAbsolute(below))
      const toolResults = messages.filter((message) => message.role === "tool")
      let name: string | undefined
      if (!toolResults.length) name = "read_file"
      else if (toolResults.length === 1) {
        assert(
          String(toolResults[0].content).includes("# Verified isolated report"),
          "Second original model turn must receive the actual mapped first-flow artifact"
        )
        name = "write_file"
      } else assert.match(String(toolResults.at(-1)?.content), /^Successfully wrote/)
      handoffRequests.push({ reader: true, tool: name })
      const delta = name
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `handoff-${name}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(
                    name === "read_file"
                      ? { file_path: join(workspace, "incoming/report.md") }
                      : {
                          file_path: join(workspace, "summary.md"),
                          content: "Verified received report through original read_file"
                        }
                  )
                }
              }
            ]
          }
        : { role: "assistant", content: "HANDOFF_READER_DONE" }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        `data: ${JSON.stringify({ id: "handoff", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ id: "handoff", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\n`
      )
      response.end("data: [DONE]\n\n")
      return
    }
    if (prompt.includes("HOST_GOAL verify isolated report")) {
      assert(hostRequests.length < 4)
      assert(
        instructions.includes("composition-host-report"),
        "Real selected stage skill reaches provider"
      )
      assert(
        !instructions.includes("composition-alpha") && !instructions.includes("composition-beta"),
        "A complete-flow unit must not inherit unrelated parent chat capabilities"
      )
      const text = messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map((part) => part?.text ?? "").join("\n")
              : ""
        )
        .join("\n")
      const workspace = /The workspace root is: ([^\r\n]+)/
        .exec(text)?.[1]
        ?.trim()
        .replace(/^`|`$/g, "")
      assert(workspace, "Host isolated unit workspace is available to the native model")
      const below = relative(fixture.isolated, workspace)
      assert(
        below && !below.startsWith("..") && !isAbsolute(below),
        `Never write outside owned fixture: ${JSON.stringify(workspace)}`
      )
      const result = messages.find((message) => message.role === "tool")
      const rejectTool = prompt.includes("REJECT_TOOL")
      const wrote = Boolean(result && !rejectTool)
      if (result && !rejectTool)
        assert.match(String(result.content), /^Successfully wrote to '.+'$/s)
      if (result && rejectTool) assert.doesNotMatch(String(result.content), /^Successfully wrote/)
      hostRequests.push({ goal: prompt, wrote, workspace })
      if (handoffOnly)
        handoffRequests.push({ reader: false, tool: result ? undefined : "write_file" })
      const delta = result
        ? { role: "assistant", content: rejectTool ? "HOST_TOOL_DENIED" : "HOST_REPORT_WRITTEN" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "composition-write-report",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    file_path: join(workspace, "report.md"),
                    content: "# Verified isolated report\nHOST_GOAL verify isolated report\n"
                  })
                }
              }
            ]
          }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        `data: ${JSON.stringify({ id: "composition-host", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ id: "composition-host", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: result ? "stop" : "tool_calls" }] })}\n\n`
      )
      response.end("data: [DONE]\n\n")
      return
    }
    observations.push({
      prompt,
      alpha: instructions.includes("composition-alpha"),
      beta: instructions.includes("composition-beta")
    })
    response.writeHead(200, { "content-type": "text/event-stream" })
    const longTurn = /LONG_TURN_(\d+)/.exec(prompt)?.[1]
    const token = longTurn
      ? `LONG_DONE_${longTurn}\n\n${Array.from({ length: 64 }, (_, index) => `段落 ${index + 1}：隔离长会话内容连续展示，验证流式回答、滚动与切换后的恢复。`).join("\n\n")}`
      : prompt.includes("NORMAL_TURN")
        ? "COMPOSITION_NORMAL_DONE"
        : prompt.includes("SECOND_TURN")
          ? "COMPOSITION_SECOND_DONE"
          : "COMPOSITION_FIRST_DONE"
    const fragments = longTurn
      ? token.match(/[\s\S]{1,128}/g)!
      : [token.slice(0, 12), token.slice(12)]
    for (const content of fragments) {
      response.write(
        `data: ${JSON.stringify({ id: "composition-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`
      )
      await new Promise((done) => setTimeout(done, 60))
    }
    response.write(
      `data: ${JSON.stringify({ id: "composition-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("fixture rejected unexpected request")
  }
})

let app: ElectronApplication | undefined
const watchdog = setTimeout(
  () => {
    void app?.close()
  },
  longOnly ? 600000 : 300000
)
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, { offscreen: longOnly })()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    const page = await app.firstWindow().catch(async (cause) => {
      try {
        const surfaces = await app!.evaluate(({ app, BrowserWindow, webContents }) => ({
          ready: app.isReady(),
          appPath: app.getAppPath(),
          windows: BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            contents: window.webContents.id,
            url: window.webContents.getURL()
          })),
          contents: webContents.getAllWebContents().map((contents) => ({
            id: contents.id,
            type: contents.getType(),
            url: contents.getURL()
          }))
        }))
        writeFileSync(
          join(fixture.isolated, "startup-surfaces.json"),
          JSON.stringify(surfaces, null, 2)
        )
      } catch {
        /* Preserve the original startup failure if the process already exited. */
      }
      throw cause
    })
    if (!longOnly) {
      const nativeWindows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.webContents.id)
      )
      assert(
        nativeWindows.length > 0,
        "Approval journeys require the original native BrowserWindow registry"
      )
    }
    page.setDefaultTimeout(30000)
    await page.waitForFunction(() => Boolean(window.api?.projectComposition))
    const installed = [
      compositionParentAdapter(process.execPath),
      compositionStandaloneSkill("composition-alpha", "整理项目资料"),
      compositionStandaloneSkill("composition-beta", "检查项目文档"),
      compositionHostFlow(),
      ...(handoffOnly ? [compositionHostFlow(true)] : [])
    ]
    const scope = await page.evaluate(
      async ({ installed, workspace, url }) => {
        for (const bytes of installed) {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "fixture.zip",
            "local"
          )
          if (!result.success) throw Error(`Fixture installation rejected: ${result.error}`)
        }
        const parent = (await window.api.plugins.list()).find(
          (item) => item.name === "composition-parent-fixture"
        )
        if (!parent) throw Error("Parent fixture installation failed")
        const project = await window.api.harnessBoard.createProject({
          adapterId: parent.id,
          adapterType: "plugin",
          name: "Composition IPC Project",
          projectCode: "COMPOSITIONIPC",
          projectFromLean: false,
          projectDir: "composition-project",
          description: "Isolated real IPC acceptance",
          systemId: "fixture",
          systemName: "Fixture",
          workspacePath: workspace
        })
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "composition-loopback",
          name: "隔离组合模型",
          baseUrl: url,
          model: "composition-loopback",
          apiKey: "local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:composition-loopback")
        const thread = await window.api.threads.create({
          title: "Composition IPC Session",
          workspacePath: workspace,
          agentMode: "normal",
          harnessProjectSession: { projectId: project.projectId, kind: "knowledge" }
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return {
          threadId: thread.thread_id,
          projectId: project.projectId,
          expectedWorkspace: workspace
        }
      },
      { installed, workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "项目模式使用引导", exact: true }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "知道了，不再提示", exact: true }).click()
      }
    )
    const projects = page.getByRole("tab", { name: "项目模式", exact: true })
    const back = page.getByRole("button", { name: "返回会话", exact: true })
    await Promise.race([projects.waitFor(), back.waitFor()])
    if (await back.isVisible()) await back.click()
    await projects.click()
    await page.getByText("Composition IPC Session", { exact: true }).first().click()

    if (longOnly) {
      longSessionTimings = await runCompositionLongSession(
        page,
        scope.threadId,
        fixture.workspace,
        longTurns
      )
      assert.equal(observations.length, longTurns)
      assert.equal(errors.length, 0, errors.join("\n"))
      await page
        .screenshot({ path: join(fixture.isolated, "long-session-final.png"), timeout: 5000 })
        .catch((error) => captureWarnings.push(String(error)))
      console.log(
        `PASS real long session ${longTurns} streamed turns and ${Math.floor(longTurns / 5)} mode switches: ${fixture.isolated}`
      )
      return
    }

    if (handoffOnly) {
      await runCompositionHandoffScenario(page, handoffRequests)
      assert.equal(errors.length, 0, errors.join("\n"))
      await page
        .screenshot({
          path: join(fixture.isolated, "predecessor-failure-blocked.png"),
          timeout: 5000
        })
        .catch((error) => captureWarnings.push(String(error)))
      console.log(
        `PASS real ordered flows, mapped read_file handoff, failed predecessor isolation: ${fixture.isolated}`
      )
      return
    }

    await page.getByRole("button", { name: "项目能力", exact: true }).click()
    await page.getByRole("checkbox", { name: /整理项目资料/ }).check()
    await page.getByRole("checkbox", { name: /检查项目文档/ }).check()
    assert.equal(
      (await page.evaluate((scope) => window.api.projectComposition.readCapabilities(scope), scope))
        .sources.length,
      0
    )
    await page.getByRole("button", { name: "预览对话能力", exact: true }).click()
    await page.getByRole("button", { name: "确认应用对话能力", exact: true }).click()
    await page
      .getByText("项目对话能力已应用。后续消息将使用已确认的能力配置。", { exact: true })
      .waitFor()
    assert.equal(
      (await page.evaluate((scope) => window.api.projectComposition.readCapabilities(scope), scope))
        .sources.length,
      2
    )
    await page.setViewportSize({ width: 375, height: 812 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false
    )
    await page.screenshot({ path: join(fixture.isolated, "capabilities-375.png") })
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 1280, height: 900 })
    for (const [prompt, answer] of [
      ["FIRST_TURN isolated evidence", "COMPOSITION_FIRST_DONE"],
      ["SECOND_TURN isolated continuation", "COMPOSITION_SECOND_DONE"]
    ]) {
      await page.locator("textarea.composer-textarea").fill(prompt)
      await page.getByRole("button", { name: "发送消息", exact: true }).click()
      await page.getByText(answer, { exact: true }).waitFor({ timeout: 60000 })
      await page.waitForFunction(
        () => !document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled
      )
      const messages = await page.evaluate(
        (id) => window.api.threads.getMessages(id),
        scope.threadId
      )
      assert.equal(
        messages.filter(
          (message) =>
            message.role === "assistant" && JSON.stringify(message.content).includes(answer)
        ).length,
        1,
        "Exactly one persisted assistant response per turn"
      )
    }
    assert.equal(observations.length, 2)
    assert(
      observations.every((item) => item.alpha && item.beta),
      "Both selected installed skills reach the original startAgentRun provider"
    )
    assert.equal(errors.length, 0, errors.join("\n"))
    await page.screenshot({ path: join(fixture.isolated, "real-project-session.png") })
    const normalId = await page.evaluate(async (workspace) => {
      const normal = await window.api.threads.create({
        title: "Composition normal isolation",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(normal.thread_id, workspace)
      return normal.thread_id
    }, fixture.workspace)
    const denied = await page.evaluate(
      async ({ scope, normalId }) => {
        try {
          await window.api.projectComposition.catalog({ ...scope, threadId: normalId })
          return false
        } catch {
          return true
        }
      },
      { scope, normalId }
    )
    assert(denied, "Ordinary conversation cannot claim project catalog using a renderer project id")
    await page.reload()
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()
    await page.getByText("Composition normal isolation", { exact: true }).first().click()
    assert.equal(await page.getByRole("button", { name: "项目能力", exact: true }).count(), 0)
    await page.locator("textarea.composer-textarea").fill("NORMAL_TURN ordinary isolation")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByText("COMPOSITION_NORMAL_DONE", { exact: true }).waitFor({ timeout: 60000 })
    assert.equal(observations.length, 3)
    assert.equal(observations[2].alpha, false, "Ordinary chat must not inherit project-only alpha")
    assert.equal(observations[2].beta, false, "Ordinary chat must not inherit project-only beta")

    if (process.env.COMPOSITION_E2E_CHAT_ONLY === "1") {
      console.log(
        `PASS real project chat capability scope + ordinary isolation only: ${fixture.isolated}`
      )
      return
    }

    await page.getByRole("tab", { name: "项目模式", exact: true }).click()
    await page.getByText("Composition IPC Session", { exact: true }).first().click()

    await page.getByRole("button", { name: "项目能力", exact: true }).click()
    await page.getByRole("button", { name: /添加 隔离报告流程/ }).click()
    await page
      .getByRole("textbox", { name: "这次要做什么" })
      .fill("HOST_GOAL verify isolated report")
    await page.getByRole("button", { name: "检查并预览组合", exact: true }).click()
    await page.getByText("任务：HOST_GOAL verify isolated report", { exact: true }).waitFor()
    await page.getByRole("button", { name: "确认并启动", exact: true }).click()
    await page.getByRole("region", { name: "原流程审批" }).waitFor({ timeout: 60000 })
    assert.equal(hostRequests.length, 0, "Original human gate must precede model/tool execution")
    assert.equal(await page.getByText("运行过程 · 已完成", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "批准此阶段", exact: true }).click()
    await page.getByRole("button", { name: "确认批准", exact: true }).click()
    await page.getByRole("button", { name: "核对并恢复", exact: true }).click()
    const nativeApproval = page.getByRole("region", { name: "原工具操作确认" })
    await nativeApproval.waitFor({ timeout: 30000 })
    assert.equal(hostRequests.length, 1, "Original tool is still waiting for a user decision")
    await nativeApproval
      .getByText(`文件：${join(hostRequests[0].workspace, "report.md")}`, { exact: true })
      .waitFor()
    await nativeApproval.getByRole("button", { name: "允许本次操作", exact: true }).click()
    await page.getByText("运行过程 · 已完成", { exact: true }).waitFor({ timeout: 30000 })
    assert.equal(hostRequests.length, 2)
    assert.equal(hostRequests[1].wrote, true)
    await page.getByRole("button", { name: /^查看结果 / }).click()
    await page.getByText(/# Verified isolated report/).waitFor()
    await page
      .screenshot({ path: join(fixture.isolated, "host-artifact.png"), timeout: 5000 })
      .catch((error) => captureWarnings.push(String(error)))
    await page.keyboard.press("Escape")
    await page
      .getByRole("textbox", { name: "这次要做什么" })
      .fill("HOST_GOAL verify isolated report REJECT_TOOL")
    await page.getByRole("button", { name: "检查并预览组合", exact: true }).click()
    await page.getByRole("button", { name: "确认并启动", exact: true }).click()
    await page.getByRole("region", { name: "原流程审批" }).waitFor({ timeout: 60000 })
    assert.equal(hostRequests.length, 2)
    await page.getByRole("button", { name: "批准此阶段", exact: true }).click()
    await page.getByRole("button", { name: "确认批准", exact: true }).click()
    await page.getByRole("button", { name: "核对并恢复", exact: true }).click()
    await nativeApproval.waitFor({ timeout: 30000 })
    assert.equal(hostRequests.length, 3)
    await nativeApproval.getByRole("button", { name: "拒绝本次操作", exact: true }).click()
    await page.getByText("运行过程 · 执行失败", { exact: true }).waitFor({ timeout: 30000 })
    assert.equal(await page.getByText("运行过程 · 已完成", { exact: true }).count(), 0)
    assert.equal(existsSync(join(hostRequests[2].workspace, "report.md")), false)
    assert.equal(errors.length, 0, errors.join("\n"))
    await page
      .screenshot({ path: join(fixture.isolated, "host-tool-rejected.png"), timeout: 5000 })
      .catch((error) => captureWarnings.push(String(error)))
    await page.keyboard.press("Escape")
    if (process.env.COMPOSITION_E2E_DOCS === "1") {
      await page.getByRole("button", { name: "项目列表", exact: true }).first().click()
      await page.getByRole("link", { name: /使用说明/ }).first().click()
      const documentation = page.getByRole("dialog", { name: "DevClaw Sparks 官方说明" })
      await documentation.waitFor()
      for (const name of ["项目会话标题栏的项目能力入口", "窄屏下的项目能力选择面板"]) {
        const image = documentation.getByRole("img", { name, exact: true })
        await image.scrollIntoViewIfNeeded()
        await image.evaluate((element: HTMLImageElement) => element.decode())
        assert.ok(await image.evaluate((element: HTMLImageElement) => element.naturalWidth > 300))
      }
      assert.equal(await documentation.getByRole("img", { name: /图片无法显示/ }).count(), 0)
      await documentation.getByRole("heading", { name: "例子：AutoBiz 开发，再整理项目文档", exact: true }).waitFor()
      await page.screenshot({ path: join(fixture.isolated, "packaged-project-guide.png"), timeout: 5000 })
        .catch((error) => captureWarnings.push(String(error)))
      await page.keyboard.press("Escape")
      console.log("PASS packaged documentation entry: two composition images decoded, no fallback")
    }
    console.log(`PASS real project composition IPC + renderer + startAgentRun: ${fixture.isolated}`)
  } catch (error) {
    const page = app?.windows()[0]
    if (page) {
      await page
        .screenshot({ path: join(fixture.isolated, "failure.png"), timeout: 5000 })
        .catch(() => {})
      writeFileSync(
        join(fixture.isolated, "failure-ui.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "page unavailable")
      )
    }
    errors.push(String(error))
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify(
        {
          execution: candidate.execution,
          candidate,
          testMode: longOnly
            ? "long-session-and-mode-switches"
            : handoffOnly
              ? "ordered-flows-and-handoff"
              : process.env.COMPOSITION_E2E_CHAT_ONLY === "1"
                ? "chat-scope-only"
                : "chat-and-host-flow",
          observations,
          hostRequests,
          handoffRequests,
          longSessionTimings,
          captureWarnings,
          errors
        },
        null,
        2
      )
    )
    assert.deepEqual(projectCompositionCandidate(root), candidate, "Candidate changed during E2E")
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
