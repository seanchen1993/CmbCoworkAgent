/** Real packaged creator entry, native catalog calls and scope isolation; no user profile. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { normalizeWorkspacePathKey } from "../src/shared/workspace-path"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(
  process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.MOD_AUTHORING_BUILT_PREVIEW === "1",
  "Select an explicit ASAR candidate or the built-output fixture preflight"
)
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const guide = "## 当前对话：创造者模式（Mods / Sparks）"
const model = "mod-authoring-native-regression"
const savedComposition = "原生保存组合验证"
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const requests: Array<Record<string, unknown>> = []
const results: Array<Record<string, unknown>> = []
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let phase = "unstarted"
let phaseRequests = 0

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      assert(raw.length < 8_000_000)
    }
    const body = JSON.parse(raw)
    assert.equal(body.model, model)
    assert(requests.length < 12, "No unexpected retry/background model request")
    const index = ++phaseRequests
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const system = JSON.stringify(messages.filter((message) => message.role === "system"))
    const tools = (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name)
    const enabled = phase === "enabled"
    const observation = {
      phase,
      index,
      hasGuide: system.includes(guide),
      hasNativeTool: tools.includes("mod_authoring"),
      hasCompositionTool: tools.includes("mod_composition"),
      tools,
      toolResults: messages.filter((message) => message.role === "tool")
    }
    requests.push(observation)
    writeFileSync(join(fixture.isolated, `model-request-${requests.length}.json`), raw)
    assert.equal(observation.hasGuide, enabled, `Host guidance scope: ${phase}`)
    assert.equal(observation.hasNativeTool, enabled, `Native tool scope: ${phase}`)
    assert.equal(observation.hasCompositionTool, enabled, `Composition tool scope: ${phase}`)
    const nativeResults = observation.toolResults.map((message) => JSON.parse(
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ type?: string; text?: string }>)
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n")
    ))
    if (enabled && index > 1) {
      assert(nativeResults.some((value) => value.ok === true && value.result?.contract === "cmb-desktop-authoring-v2"))
      if (index === 3) {
        assert(nativeResults.some((value) =>
          value.ok === true && value.result?.section === "types" &&
          value.result.content.includes('declare module "claude-code"') &&
          value.result.nextCursor > 0
        ))
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    let toolArgs: Record<string, unknown> | null =
      enabled && index === 1
        ? { action: "catalog" }
        : enabled && index === 2
          ? { action: "catalog", catalogSection: "types", cursor: 0 }
          : null
    if (enabled && index === 3) toolArgs = { action: "list" }
    if (enabled && index === 4) {
      const catalog = nativeResults.findLast((value) =>
        value.ok === true && typeof value.result?.catalogToken === "string")
      assert(catalog, "Native composition catalog returns a usable exact-source token")
      toolArgs = { action: "stage", catalogToken: catalog.result.catalogToken,
        name: "原生对话组合验证", capabilities: [] }
    }
    if (enabled && index === 5) {
      assert(nativeResults.some((value) => value.ok === true && value.result?.phase === "queued"))
      const catalog = nativeResults.findLast((value) =>
        value.ok === true && typeof value.result?.catalogToken === "string")
      assert(catalog)
      toolArgs = { action: "save", savedName: savedComposition, savedRevision: 0,
        catalogToken: catalog.result.catalogToken }
    }
    if (enabled && index === 6) {
      const saved = nativeResults.findLast((value) => value.ok === true &&
        value.result?.name === savedComposition && value.result?.revision === 1)
      assert(saved, "The current composition is saved through the native tool")
      toolArgs = { action: "apply_saved", savedName: savedComposition,
        savedRevision: saved.result.revision }
    }
    if (enabled && index === 7)
      assert(nativeResults.some((value) => value.ok === true && value.result?.phase === "queued"))
    response.write(
      `data: ${JSON.stringify({
        id: `authoring-${requests.length}`,
        object: "chat.completion.chunk",
        model,
        choices: [{
          index: 0,
          delta: toolArgs
            ? { role: "assistant", tool_calls: [{
                index: 0,
                id: `authoring-call-${index}`,
                type: "function",
                function: { name: enabled && index >= 3 ? "mod_composition" : "mod_authoring",
                  arguments: JSON.stringify(toolArgs) }
              }] }
            : { role: "assistant", content: `AUTHORING_NATIVE_ANSWER_${phase}` },
          finish_reason: null
        }]
      })}\n\n`
    )
    await pause(30)
    response.write(
      `data: ${JSON.stringify({
        id: `authoring-${requests.length}`,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: toolArgs ? "tool_calls" : "stop" }]
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

async function snapshot(name: string) {
  assert(page)
  writeFileSync(join(fixture.isolated, `${name}.txt`), await page.locator("body").innerText())
  await page.screenshot({
    path: join(fixture.isolated, `${name}.png`), timeout: 3000, animations: "disabled"
  }).catch(() => {})
}

async function select(title: string) {
  assert(page)
  await page.reload()
  await page.getByText(title, { exact: true }).first().click()
  await page.locator("textarea.composer-textarea").waitFor()
}

async function turn(threadId: string, name: string) {
  assert(page)
  phase = name
  phaseRequests = 0
  const question = `AUTHORING_NATIVE_QUESTION_${name}`
  const answer = `AUTHORING_NATIVE_ANSWER_${name}`
  await page.locator("textarea.composer-textarea").fill(question)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  let persisted = false
  for (let attempt = 0; attempt < 200; attempt++) {
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    if (JSON.stringify(messages).includes(answer)) {
      persisted = true
      break
    }
    assert.deepEqual(errors, [], "Loopback must not mask failed native tool assertions")
    await pause(100)
  }
  assert(persisted, `Actual answer persisted: ${name}`)
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor()
  let readable = false
  for (let attempt = 0; attempt < 150; attempt++) {
    const body = await page.locator("body").innerText()
    if (body.includes(question) && body.includes(answer)) {
      readable = true
      break
    }
    await pause(100)
  }
  assert(readable, `Actual transcript readable: ${name}`)
  assert.equal(phaseRequests, name === "enabled" ? 7 : 1)
  const status = await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId)
  results.push({ name, persisted, readable, phaseRequests, status })
  await snapshot(name)
}

async function enableThroughUi(threadId: string) {
  assert(page)
  await page.getByRole("button", { name: "创造者模式", exact: true }).click()
  await page.getByRole("button", { name: "创造者模式", exact: true, pressed: true }).waitFor()
  const status = await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId)
  assert.equal(status.enabled, true)
  assert.equal(status.mode, "creator")
  assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
  assert.equal(await page.evaluate((id) => window.api.mods.status(id).then((value) => value.enabled), threadId), true)
  assert.equal(await page.getByRole("button", { name: "开启灵件并开始制作", exact: true }).count(), 0)
}

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 180000)
  console.log(`Authoring isolated profile: ${fixture.isolated}`)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, { unobtrusivePresentation: true })()
    app.process().stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app.process().stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const workspace2 = join(fixture.isolated, "other-workspace")
    mkdirSync(workspace2)
    const scope = await page.evaluate(async ({ url, workspace, model }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.models.setCustomConfig({
        id: model, name: "Local authoring boundary", baseUrl: url,
        apiKey: "isolated-loopback", model, maxTokens: 64000, maxOutputTokens: 2048
      })
      await window.api.models.setDefault("custom:" + model)
      const first = await window.api.threads.create({
        title: "Authoring native creator", workspacePath: workspace, agentMode: "normal"
      })
      const second = await window.api.threads.create({
        title: "Authoring isolated sibling", workspacePath: workspace, agentMode: "normal"
      })
      const third = await window.api.threads.create({
        title: "Authoring workspace switch", workspacePath: workspace, agentMode: "normal"
      })
      await window.api.workspace.set(first.thread_id, workspace)
      await window.api.workspace.set(second.thread_id, workspace)
      await window.api.workspace.set(third.thread_id, workspace)
      return { first: first.thread_id, second: second.thread_id, third: third.thread_id }
    }, { url: `http://127.0.0.1:${address.port}/v1`, workspace: fixture.workspace, model })
    await select("Authoring native creator")
    const initial = await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), scope.first)
    assert.equal(initial.enabled, false)
    const initialGlobal = await page.evaluate(() => window.api.mods.globalEnabled())
    await page.getByRole("button", { name: "Mod 状态", exact: true }).click()
    await page.getByRole("button", { name: "刷新状态", exact: true }).waitFor()
    assert.equal((await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), scope.first)).enabled, false)
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), initialGlobal)
    await snapshot("outer-popover-only")
    await page.keyboard.press("Escape")
    await turn(scope.first, "outer-only")
    await enableThroughUi(scope.first)
    await turn(scope.first, "enabled")
    let composition = await page.evaluate((id) =>
      window.api.mods.development.status({ threadId: id }).then((state) => state.composition),
    scope.first)
    for (let attempt = 0; attempt < 100 &&
      composition && ["queued", "applying"].includes(composition.phase); attempt++) {
      await pause(100)
      composition = await page.evaluate((id) =>
        window.api.mods.development.status({ threadId: id }).then((state) => state.composition),
      scope.first)
    }
    assert.equal(composition?.phase, "active", JSON.stringify(composition))
    assert(composition)
    assert.equal(composition.savedName, savedComposition)
    assert.equal(composition.canUndo, true, "Applied native composition exposes its undo receipt")
    const beforeUndo = await page.evaluate((id) => window.api.mods.clawView(id), scope.first)
    assert(beforeUndo.active, "An explicit empty profile differs from inherited defaults")
    assert.equal(beforeUndo.active.capabilities.length, 0)
    await page.getByRole("button", { name: "普通模式", exact: true }).click()
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    const ordinary = await page.evaluate((id) =>
      window.api.mods.development.status({ threadId: id }), scope.first)
    assert.equal(ordinary.mode, "normal")
    assert.equal(ordinary.enabled, true, "Ordinary mode keeps the development runtime enabled")
    const requestsBeforeUndo = requests.length
    await page.getByRole("button", { name: "组合已应用", exact: true }).click()
    await page.getByRole("button", { name: "撤销这次组合", exact: true }).click()
    let restored = await page.evaluate(async (id) => ({
      status: await window.api.mods.development.status({ threadId: id }),
      binding: await window.api.mods.clawView(id)
    }), scope.first)
    for (let attempt = 0; attempt < 150 &&
      (restored.status.composition?.phase !== "active" || restored.binding.active !== null);
      attempt++) {
      assert.notEqual(restored.status.composition?.phase, "failed", JSON.stringify(restored))
      await pause(100)
      restored = await page.evaluate(async (id) => ({
        status: await window.api.mods.development.status({ threadId: id }),
        binding: await window.api.mods.clawView(id)
      }), scope.first)
    }
    assert.equal(restored.status.composition?.phase, "active", JSON.stringify(restored))
    assert.equal(restored.binding.active, null, "Native UI undo restores actual null inheritance")
    assert.equal(restored.status.mode, "normal", "Undo remains available in ordinary mode")
    assert.equal(restored.status.enabled, true, "Undo preserves the enabled runtime")
    assert.equal(requests.length, requestsBeforeUndo, "Native UI undo sends no model request")
    results.push({ name: "native-save-apply-and-normal-undo", beforeUndo, restored })
    await snapshot("composition-undo-normal")
    await page.keyboard.press("Escape")
    await turn(scope.first, "normal")
    await enableThroughUi(scope.first)
    await select("Authoring isolated sibling")
    assert.equal((await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), scope.second)).enabled, false)
    await turn(scope.second, "other-chat")
    await select("Authoring native creator")
    await page.getByRole("button", { name: /^(Mod 状态|组合已应用)$/ }).click()
    await page.locator("summary").filter({ hasText: "创作选项" }).click()
    await page.getByRole("button", { name: "结束创作并停止本会话试用", exact: true }).click()
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    assert.equal((await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), scope.first)).enabled, false)
    await page.keyboard.press("Escape")
    await turn(scope.first, "closed")
    assert.equal(await page.getByLabel("本次使用的步骤").isVisible(), false)
    const overviewRequests = requests.length
    await page.locator("textarea.composer-textarea").fill("保留这段尚未发送的需求")
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    await page.getByRole("tab", { name: "当前任务", exact: true }).click()
    const overview = page.getByRole("region", { name: "聊天任务状态", exact: true })
    await overview.getByText("已回复", { exact: true }).waitFor()
    assert.equal(await overview.getByRole("button", { name: "继续原任务" }).count(), 0)
    await snapshot("ordinary-task-overview")
    await overview.getByRole("button", { name: "回到聊天", exact: true }).click()
    assert.equal(await page.locator("textarea.composer-textarea").inputValue(), "保留这段尚未发送的需求")
    assert.equal(await page.locator("textarea.composer-textarea").evaluate(element => element === document.activeElement), true)
    assert.equal(requests.length, overviewRequests, "Opening task progress must not invoke the model")
    results.push({ name: "ordinary-task-overview", noPresetRequired: true, draftPreserved: true })
    await page.locator("textarea.composer-textarea").fill("")
    // The real workspace picker prevents re-binding a nonempty transcript. Use another empty
    // ordinary chat, enable through the same UI, then switch before its first message.
    await select("Authoring workspace switch")
    await enableThroughUi(scope.third)
    await page.evaluate(({ id, workspace }) => window.api.workspace.set(id, workspace), { id: scope.third, workspace: workspace2 })
    await select("Authoring workspace switch")
    const changed = await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), scope.third)
    assert.equal(changed.enabled, false)
    assert.equal(normalizeWorkspacePathKey(changed.workspace), normalizeWorkspacePathKey(workspace2))
    await turn(scope.third, "other-workspace")
    assert.deepEqual(errors, [])
    assert.equal(requests.length, 12)
    const evidence = {
      candidate, isolated: fixture.isolated, scope, results, requests, errors,
      limits: "Clean packaged profile and real composer/model requests/native catalog+types, saved empty composition application and ordinary-mode UI undo to null inheritance; no personal skills, source checkout exposure, trial/install/approval or user data. Popup dismissal alone preserves enabled creation; explicit end creation removes it."
    }
    const output = join(root, "output/demo-readiness-20261016")
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, "mod-authoring-guidance-packaged.json"), JSON.stringify(evidence, null, 2))
    writeFileSync(join(fixture.isolated, "evidence.json"), JSON.stringify(evidence, null, 2))
    console.log(`PASS ${candidate.execution} native authoring guidance, catalog/types and scope isolation: ${fixture.isolated}`)
  } catch (error) {
    writeFileSync(join(fixture.isolated, "failed-observations.json"), JSON.stringify({ candidate, requests, results, errors, error: String(error) }, null, 2))
    if (page) await snapshot("failure").catch(() => {})
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
