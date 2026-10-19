/** Real ASAR native authoring survives retirement of an approved, loaded UI-only source. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { normalizeWorkspacePathKey } from "../src/shared/workspace-path"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Select the explicit unified ASAR candidate")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const guide = "## 当前对话：创造者模式（Mods / Sparks）"
const model = "mod-authoring-retired-ui-regression"
const pluginName = "authoring-scope-ui-only"
const marker = "AUTHORING_SCOPE_UI_GUEST"
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const requests: Array<Record<string, unknown>> = []
const results: Array<Record<string, unknown>> = []
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let phase = "unstarted"
let phaseRequests = 0
let markCatalogReturned!: () => void
let releaseTypesRequest = () => {}
let approvedUi: { pluginId: string; digest: string } | undefined
let catalogReturned = Promise.resolve()
let typesRequestReleased = Promise.resolve()
const isEnabledPhase = (name: string) => name === "enabled" || name === "enabled-revoked"
let loadedUi:
  | {
      pluginId: string
      digest: string
      owner: string
      pane: string
      generation: string
      plugin: string
      handle: number
    }
  | undefined

function nativeResults(messages: Array<{ role: string; content: unknown }>) {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) =>
      JSON.parse(
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ type?: string; text?: string }>)
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n")
      )
    )
}

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
    assert(requests.length < 14, "No unexpected model retry or background request")
    const index = ++phaseRequests
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const system = JSON.stringify(messages.filter((message) => message.role === "system"))
    const tools = (body.tools ?? []).map(
      (tool: { function?: { name?: string } }) => tool.function?.name
    )
    const enabled = isEnabledPhase(phase)
    const observation = {
      phase,
      index,
      hasGuide: system.includes(guide),
      hasNativeTool: tools.includes("mod_authoring"),
      tools,
      toolResults: messages.filter((message) => message.role === "tool")
    }
    requests.push(observation)
    writeFileSync(join(fixture.isolated, `model-request-${requests.length}.json`), raw)
    assert.equal(observation.hasGuide, enabled, `Authoring guidance scope: ${phase}`)
    assert.equal(observation.hasNativeTool, enabled, `Native tool scope: ${phase}`)
    if (enabled && index > 1) {
      const values = nativeResults(messages)
      assert(
        values.some(
          (value) => value.ok === true && value.result?.contract === "cmb-desktop-authoring-v2"
        )
      )
      if (index === 2) {
        // The first real native tool has completed. Keep this same native run pending
        // before the next native tool, and change the catalog through production IPC.
        markCatalogReturned()
        await typesRequestReleased
      }
      if (index === 3) {
        assert(
          values.some(
            (value) =>
              value.ok === true &&
              value.result?.section === "types" &&
              value.result.content.includes('declare module "claude-code"') &&
              value.result.nextCursor > 0
          )
        )
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const toolArgs =
      enabled && index === 1
        ? { action: "catalog" }
        : enabled && index === 2
          ? { action: "catalog", catalogSection: "types", cursor: 0 }
          : null
    response.write(
      `data: ${JSON.stringify({
        id: `scope-${requests.length}`,
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: toolArgs
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `scope-tool-${index}`,
                      type: "function",
                      function: { name: "mod_authoring", arguments: JSON.stringify(toolArgs) }
                    }
                  ]
                }
              : { role: "assistant", content: `AUTHORING_SCOPE_ANSWER_${phase}` },
            finish_reason: null
          }
        ]
      })}\n\n`
    )
    await pause(30)
    response.write(
      `data: ${JSON.stringify({
        id: `scope-${requests.length}`,
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
  await page
    .screenshot({
      path: join(fixture.isolated, `${name}.png`),
      timeout: 3000,
      animations: "disabled"
    })
    .catch(() => {})
}

async function select(title: string) {
  assert(page)
  await page.reload()
  await page.getByText(title, { exact: true }).first().click()
  await page.locator("textarea.composer-textarea").waitFor()
}

async function enableThroughUi(threadId: string) {
  assert(page)
  await page.getByRole("button", { name: "创造者模式", exact: true }).click()
  await page.getByRole("button", { name: "创造者模式", exact: true, pressed: true }).waitFor()
  assert.equal(
    (await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId))
      .enabled,
    true
  )
  assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
  assert.equal(
    await page.evaluate(
      (id) => window.api.mods.status(id).then((status) => status.enabled),
      threadId
    ),
    true
  )
}

async function installAndLoadUi(threadId: string) {
  assert(page)
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: pluginName, version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.tsx"]}'))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on){
    on("ui.render",{component:"AbovePrompt"},($,e)=>{
      const {Box,Text,Button}=$.ui.resolve(e);
      return <Box flexDirection="column"><Text>${marker}</Text>
        <Button key="retired-write" label="受控写入按钮（不执行）" onPress={async()=>{
          await $.fs.write("retired-write.txt","must-not-be-written")
        }}/></Box>
    })
  }`)
  )
  const installed = await page.evaluate(
    async ({ id, bytes, name }) => {
      const result = await window.api.plugins.install(
        new Uint8Array(bytes).buffer,
        "scope-ui.zip",
        "local"
      )
      if (!result.success) throw Error(result.error)
      const plugin = (await window.api.plugins.list()).find((row) => row.name === name)
      if (!plugin) throw Error("UI source not installed")
      const enabled = await window.api.plugins.setEnabled(plugin.id, true)
      if (!enabled.success) throw Error(enabled.error)
      const status = await window.api.mods.status(id)
      const source = status.functionMods!.find((row) => row.pluginId === plugin.id)
      if (!source?.digest) throw Error("UI source has no compiled digest")
      await window.api.mods.approveFunction(id, source.pluginId, source.digest, status.workspace)
      await window.api.mods.commands(id)
      return { pluginId: source.pluginId, digest: source.digest }
    },
    { id: threadId, bytes: [...zip.toBuffer()], name: pluginName }
  )
  await select("Authoring scope creator")
  await page.getByText(marker, { exact: true }).waitFor()
  approvedUi = installed
  await snapshot("approved-ui-loaded")
}

async function reloadApprovedUi(threadId: string) {
  assert(page && approvedUi)
  approvedUi = await page.evaluate(
    async ({ id, source }) => {
      const result = await window.api.plugins.setEnabled(source.pluginId, true)
      if (!result.success) throw Error(result.error)
      const status = await window.api.mods.status(id)
      const current = status.functionMods!.find((row) => row.pluginId === source.pluginId)
      if (!current?.digest) throw Error("Existing UI source digest disappeared")
      await window.api.mods.approveFunction(id, current.pluginId, current.digest, status.workspace)
      await window.api.mods.commands(id)
      return { pluginId: current.pluginId, digest: current.digest }
    },
    { id: threadId, source: approvedUi }
  )
  await select("Authoring scope creator")
  await page.getByText(marker, { exact: true }).waitFor()
  await snapshot("approved-ui-reloaded-before-revoke")
}

async function retireLoadedUi(threadId: string, retirement: "disable" | "revoke") {
  assert(page && approvedUi)
  const approved = approvedUi
  const disabled = await page.evaluate(
    async ({ id, approved, retirement, pluginName }) => {
      // Capture a valid action immediately before retirement, after the native catalog
      // tool actually returned. This cannot be an already-closed historical UI handle.
      const outcome = await window.api.mods.siteMountOutcome(id, "AbovePrompt")
      if (outcome.state !== "mounted") throw Error("Real UI source did not mount")
      const drawing = await window.api.mods.siteRender(id, outcome.owner, {
        isWorking: true,
        bodyColumns: 80,
        maxRows: 8
      })
      if (!drawing) throw Error("Real UI source did not render")
      type Tree = {
        type: string
        press?: { plugin: string; handle: number }
        children?: Array<Tree | string>
      }
      const find = (node: Tree | string): Tree | undefined =>
        typeof node === "string"
          ? undefined
          : node.type === "Button" && node.press
            ? node
            : node.children?.map(find).find(Boolean)
      const button = find(drawing.tree as Tree)
      if (!button?.press) throw Error("Real UI source did not register its action")
      const source = {
        ...approved,
        owner: outcome.owner,
        pane: drawing.key,
        generation: drawing.generation,
        plugin: button.press.plugin,
        handle: button.press.handle
      }
      if (retirement === "disable") {
        const result = await window.api.plugins.setEnabled(approved.pluginId, false)
        if (!result.success) throw Error(result.error)
      } else {
        await window.api.mods.revokeFunction(id, pluginName)
      }
      const plugin = (await window.api.plugins.list()).find((row) => row.id === source.pluginId)
      const status = await window.api.mods.status(id)
      let retiredActionError = ""
      try {
        await window.api.mods.siteAct(id, source.owner, {
          pane: source.pane,
          generation: source.generation,
          plugin: source.plugin,
          handle: source.handle,
          intentId: crypto.randomUUID(),
          kind: "press"
        })
      } catch (error) {
        retiredActionError = String(error)
      }
      return {
        source,
        enabled: plugin?.enabled,
        grantState: status.functionMods?.find((row) => row.pluginId === source.pluginId)?.state,
        retiredActionError,
        creator: await window.api.mods.development.status({ threadId: id })
      }
    },
    { id: threadId, approved, retirement, pluginName }
  )
  loadedUi = disabled.source
  assert.equal(disabled.enabled, retirement === "revoke", "Real plugin enabled state is preserved")
  if (retirement === "revoke") assert.equal(disabled.grantState, "needs-approval")
  assert(disabled.retiredActionError, "A captured action of the retired source must reject")
  assert.match(disabled.retiredActionError, /MODS_(UI_SITE_CLOSED|PLUGIN_CHANGED|SCOPE_CHANGED)/)
  assert.equal(
    disabled.creator.enabled,
    true,
    "Native creator remains enabled in the same physical run"
  )
  assert.equal(existsSync(join(fixture.workspace, "retired-write.txt")), false)
  results.push({
    name: `approved-loaded-source-${retirement}`,
    source: disabled.source,
    disabled,
    retiredWriteExists: false
  })
  releaseTypesRequest()
}

async function turn(threadId: string, name: string) {
  assert(page)
  phase = name
  phaseRequests = 0
  if (isEnabledPhase(name)) {
    catalogReturned = new Promise<void>((done) => {
      markCatalogReturned = done
    })
    typesRequestReleased = new Promise<void>((done) => {
      releaseTypesRequest = done
    })
  }
  const question = `AUTHORING_SCOPE_QUESTION_${name}`
  const answer = `AUTHORING_SCOPE_ANSWER_${name}`
  await page.locator("textarea.composer-textarea").fill(question)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  if (isEnabledPhase(name)) {
    await Promise.race([
      catalogReturned,
      pause(30000).then(() => {
        throw Error("Real native catalog did not return before source toggle")
      })
    ])
    await retireLoadedUi(threadId, name === "enabled" ? "disable" : "revoke")
  }
  let persisted = false
  for (let attempt = 0; attempt < 250; attempt++) {
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    if (JSON.stringify(messages).includes(answer)) {
      persisted = true
      break
    }
    assert.deepEqual(errors, [], "Loopback must not mask native tool failure")
    await pause(100)
  }
  assert(persisted, `Actual native answer persisted: ${name}`)
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
  assert(readable, `Actual transcript remains readable: ${name}`)
  assert.equal(phaseRequests, isEnabledPhase(name) ? 3 : 1, "No replay of native tool/model calls")
  const status = await page.evaluate(
    (id) => window.api.mods.development.status({ threadId: id }),
    threadId
  )
  results.push({ name, persisted, readable, phaseRequests, status })
  await snapshot(name)
}

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 180000)
  console.log(`Authoring scope isolated profile: ${fixture.isolated}`)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const workspace2 = join(fixture.isolated, "other-workspace")
    mkdirSync(workspace2)
    const scope = await page.evaluate(
      async ({ url, workspace, model }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: model,
          name: "Local authoring scope boundary",
          baseUrl: url,
          apiKey: "isolated-loopback",
          model,
          maxTokens: 64000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:" + model)
        const ids: string[] = []
        for (const title of [
          "Authoring scope creator",
          "Authoring scope sibling",
          "Authoring scope workspace"
        ]) {
          const thread = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          await window.api.workspace.set(thread.thread_id, workspace)
          ids.push(thread.thread_id)
        }
        return { first: ids[0], second: ids[1], third: ids[2] }
      },
      { url: `http://127.0.0.1:${address.port}/v1`, workspace: fixture.workspace, model }
    )
    await select("Authoring scope creator")
    assert.equal(
      (
        await page.evaluate(
          (id) => window.api.mods.development.status({ threadId: id }),
          scope.first
        )
      ).enabled,
      false
    )
    const initialGlobal = await page.evaluate(() => window.api.mods.globalEnabled())
    await page.getByRole("button", { name: "创作工作区", exact: true }).click()
    await page.getByRole("button", { name: "刷新状态", exact: true }).waitFor()
    assert.equal(
      (
        await page.evaluate(
          (id) => window.api.mods.development.status({ threadId: id }),
          scope.first
        )
      ).enabled,
      false
    )
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), initialGlobal)
    await snapshot("outer-popover-only")
    await page.keyboard.press("Escape")
    await turn(scope.first, "outer-only")
    await enableThroughUi(scope.first)
    await installAndLoadUi(scope.first)
    await turn(scope.first, "enabled")
    assert.equal(
      await page.getByText(marker, { exact: true }).count(),
      0,
      "Retired source UI unmounts"
    )
    await reloadApprovedUi(scope.first)
    await turn(scope.first, "enabled-revoked")
    assert.equal(await page.getByText(marker, { exact: true }).count(), 0)
    await select("Authoring scope sibling")
    assert.equal(
      (
        await page.evaluate(
          (id) => window.api.mods.development.status({ threadId: id }),
          scope.second
        )
      ).enabled,
      false
    )
    await turn(scope.second, "other-chat")
    await select("Authoring scope creator")
    await page.getByRole("button", { name: "创作工作区", exact: true }).click()
    await page.locator("summary").filter({ hasText: "创作选项" }).click()
    await page.getByRole("button", { name: "结束创作并停止本会话试用", exact: true }).click()
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    assert.equal(
      (
        await page.evaluate(
          (id) => window.api.mods.development.status({ threadId: id }),
          scope.first
        )
      ).enabled,
      false
    )
    await page.keyboard.press("Escape")
    await turn(scope.first, "closed")
    await select("Authoring scope workspace")
    await enableThroughUi(scope.third)
    await page.evaluate(({ id, workspace }) => window.api.workspace.set(id, workspace), {
      id: scope.third,
      workspace: workspace2
    })
    await select("Authoring scope workspace")
    const changed = await page.evaluate(
      (id) => window.api.mods.development.status({ threadId: id }),
      scope.third
    )
    assert.equal(changed.enabled, false)
    assert.equal(
      normalizeWorkspacePathKey(changed.workspace),
      normalizeWorkspacePathKey(workspace2)
    )
    await turn(scope.third, "other-workspace")
    assert.deepEqual(errors, [])
    assert.equal(requests.length, 10)
    assert.equal(existsSync(join(fixture.workspace, "retired-write.txt")), false)
    const asarSha256After = projectCompositionCandidate(root).sha256
    assert.equal(asarSha256After, candidate.sha256, "The tested unified ASAR remains unchanged")
    const evidence = {
      pass: true,
      candidate,
      asarSha256After,
      isolated: fixture.isolated,
      scope,
      loadedUi,
      results,
      requests,
      errors,
      controlledInput: "Local deterministic model protocol, no commercial model-quality claim",
      boundary:
        "In two real native creation runs: catalog returned, hold next provider response, disable or revoke an approved loaded UI-only source through production IPC, reject its old UI action, then execute native types and complete each answer exactly once.",
      limits:
        "Isolated application profile only. No user data or process. This checks one registered UI source with both disable and grant-revoke paths, plus five creator-isolation states; native write-approval revocation and other source fences have separate real-manager tests. No external write is attempted or replayed."
    }
    const output = join(root, "output/demo-readiness-20261016")
    mkdirSync(output, { recursive: true })
    writeFileSync(
      join(output, "mod-authoring-scope-packaged.json"),
      JSON.stringify(evidence, null, 2)
    )
    writeFileSync(join(fixture.isolated, "evidence.json"), JSON.stringify(evidence, null, 2))
    console.log(
      `PASS ${candidate.execution} native authoring survives approved loaded UI-only Mod retirement: ${fixture.isolated}`
    )
  } catch (error) {
    writeFileSync(
      join(fixture.isolated, "failed-observations.json"),
      JSON.stringify(
        { candidate, loadedUi, requests, results, errors, error: String(error) },
        null,
        2
      )
    )
    if (page) await snapshot("failure").catch(() => {})
    throw error
  } finally {
    releaseTypesRequest()
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
