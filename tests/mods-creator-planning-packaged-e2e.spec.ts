/** Original packaged install, grants, creator selection, Guest and model path; no mocked IPC. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit packaged candidate required")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const requests: Array<{ prompt: string; system: string; tools: string[] }> = []
const steps: unknown[] = []
const errors: string[] = []
let app: ElectronApplication | undefined
let passed = false
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of req) raw += chunk
    assert(raw.length < 3000000)
    const body = JSON.parse(raw)
    assert(requests.length < 15)
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const prompt = JSON.stringify(messages.findLast((row) => row.role === "user"))
    const system = messages
      .filter((row) => row.role === "system")
      .map((row) => JSON.stringify(row.content))
      .join("\n")
    const tools = Array.isArray(body.tools)
      ? body.tools.map((row: { function: { name: string } }) => row.function.name)
      : []
    for (const tool of ["mod_authoring", "mod_composition", "mod_configuration", "mod_business"])
      assert(tools.includes(tool), `Native creator tool missing: ${tool}`)
    assert(!tools.some((name: string) => name.includes("planning")))
    assert(system.includes("本轮提供原生工具"), "Required native authoring guidance retained")
    requests.push({ prompt, system, tools })
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const value of [
      {
        delta: { role: "assistant", content: `PLANNING_DONE_${requests.length}` },
        finish_reason: null
      },
      { delta: {}, finish_reason: "stop" }
    ])
      res.write(
        `data: ${JSON.stringify({ id: "planning", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, ...value }] })}\n\n`
      )
    res.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    res.writeHead(500).end("fixture rejected")
  }
})
function zip(name: string, body: string) {
  const value = new AdmZip()
  value.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", mods: "mods/manifest.json" }))
  )
  value.addFile(
    "mods/manifest.json",
    Buffer.from(JSON.stringify({ apiVersion: "cmb.mods/v2", id: name, entry: "main.ts" }))
  )
  value.addFile("mods/main.ts", Buffer.from(body))
  return [...value.toBuffer()]
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 240000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    const page = await app.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    const scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "planning-loopback",
          name: "规划策略隔离验收",
          baseUrl: url,
          model: "planning-loopback",
          apiKey: "local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:planning-loopback")
        const thread = await window.api.threads.create({
          title: "Creator planning acceptance",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        await window.api.mods.development.setMode({ ...scope, mode: "creator" })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.getByText("Creator planning acceptance", { exact: true }).first().click()
    const install = async (name: string, body: string) =>
      page.evaluate(
        async ({ bytes, name, scope }) => {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            `${name}.zip`,
            "local",
            undefined,
            true
          )
          if (!result.success || !result.pluginId) throw Error(JSON.stringify(result))
          const enabled = await window.api.plugins.setEnabled(result.pluginId, true)
          if (!enabled.success) throw Error(JSON.stringify(enabled))
          const current = await window.api.mods.status(scope.threadId)
          const item = current.functionMods?.find((row) => row.pluginId === result.pluginId)
          if (!item?.digest) throw Error(JSON.stringify(current))
          await window.api.mods.approveFunction(
            scope.threadId,
            result.pluginId,
            item.digest,
            scope.expectedWorkspace
          )
          return { pluginId: result.pluginId, name: item.name, digest: item.digest }
        },
        { bytes: zip(name, body), name, scope }
      )
    const a = await install(
      "creator-review-first",
      readFileSync(join(root, "examples/mods-creator-planning/mods/main.ts"), "utf8")
    )
    const b = await install(
      "creator-compose-first",
      'export function register(on){on("prompt.section",{name:"creator.planning"},async()=>({text:"PLANNING_B_ONLY:优先以现有能力组合验证需求。"}))}'
    )
    const catalog = () =>
      page.evaluate((input) => window.api.mods.development.planningCatalog!(input), scope)
    const select = async (selected: typeof a | null) => {
      const current = await catalog()
      const result = await page.evaluate(
        (input) => window.api.mods.development.selectPlanning!(input),
        { ...scope, expectedRevision: current.status.revision, selected }
      )
      steps.push(result)
      return result
    }
    const send = async (stage: string, advice: "a" | "b" | "none") => {
      const count = requests.length
      const workspace = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
      if (await workspace.isVisible())
        await workspace.getByRole("button", { name: "Close", exact: true }).click()
      await page
        .locator("textarea.composer-textarea")
        .fill(`PLANNING_STAGE_${stage}:只解释下一步，不执行工具。`)
      await page.getByRole("button", { name: "发送消息", exact: true }).click()
      await page
        .getByText(`PLANNING_DONE_${count + 1}`, { exact: true })
        .waitFor({ timeout: 60000 })
      await page.getByRole("button", { name: "发送消息", exact: true }).waitFor()
      const row = requests[count]!
      assert(row.prompt.includes(stage))
      const adviceIndex = row.system.indexOf("用户选择的可选规划建议")
      if (advice === "none") assert.equal(adviceIndex, -1)
      if (advice === "a") assert(row.system.includes("先明确用户希望观察的效果与验收方法"))
      if (advice === "b") assert(row.system.includes("PLANNING_B_ONLY"))
      assert.equal(requests.length, count + 1)
    }
    await send("NATIVE", "none")
    assert.equal((await select(a)).status.state, "ready")
    await send("SELECT_A", "a")
    assert.equal((await select(b)).status.selected?.pluginId, b.pluginId)
    await send("REPLACE_B", "b")
    await page.evaluate((id) => window.api.plugins.setEnabled(id, false), b.pluginId)
    assert.equal((await catalog()).status.state, "fallback")
    await send("DISABLED_FALLBACK", "none")
    assert.equal((await select(null)).status.state, "native")
    await select(a)
    const installed = await page.evaluate(() => window.api.plugins.list())
    const owned = installed.find((row) => row.id === a.pluginId)!
    assert(
      resolve(owned.path).startsWith(resolve(fixture.isolated) + "\\"),
      "Only owned test installation may be changed"
    )
    writeFileSync(
      join(owned.path, "mods/main.ts"),
      'export function register(){throw Error("owned-test-corruption")}'
    )
    assert.equal((await catalog()).status.state, "fallback")
    await send("CORRUPT_FALLBACK", "none")
    assert.equal((await select(null)).status.state, "native")
    await page.evaluate((id) => window.api.plugins.setEnabled(id, true), b.pluginId)
    await select(b)
    assert.equal(
      (await page.evaluate((id) => window.api.plugins.delete(id), b.pluginId)).success,
      true
    )
    assert.equal((await catalog()).status.state, "fallback")
    await send("UNINSTALLED_FALLBACK", "none")
    assert.equal((await select(null)).status.state, "native")
    await send("WITHDRAWN_NATIVE", "none")
    assert.equal(errors.length, 0)
    passed = true
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch(() => {})
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify({ passed, candidate, steps, requests, errors }, null, 2)
    )
  }
  console.log(
    JSON.stringify({ passed, candidate, requests: requests.length, artifact: fixture.isolated })
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
