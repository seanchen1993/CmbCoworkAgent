/** Real customer ZIPs, frozen production app, public IPC, real buttons and provider HTTP. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { ClawProfile } from "../src/shared/mods/claw"
import type { FlowDefinition } from "../src/shared/mods/flows/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "./support/mods-e2e-failures"
import { openModsFlowHistory, openModsResults } from "./support/mods-sidebar-navigation"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR?.trim(), "A real production package is required")
const requestedStarter = process.env.CMB_MODS_STARTER_DIR
assert(typeof requestedStarter === "string" && requestedStarter.trim(), "A starter is required")
const starter = resolve(requestedStarter)
const artifacts = resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS ?? "output/mods-main-starter-e2e")
assert(!existsSync(artifacts), "Use a fresh acceptance directory")
mkdirSync(artifacts, { recursive: true })
const manifest = JSON.parse(readFileSync(join(starter, "packages.json"), "utf8")) as {
  packages: Array<{
    name: string
    source: string
    file: string
    sha256: string
    files: Array<{ path: string; sha256: string }>
  }>
}
assert.deepEqual(
  manifest.packages.map((item) => item.name),
  ["mods-composition-board", "mods-composition-style", "component-review-kit"]
)
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const requiredFiles = [
  ["plugin.json", "hooks/hooks.json", "hooks/register.ts"],
  ["plugin.json", "hooks/hooks.json", "hooks/register.ts"],
  [
    ".claude-plugin/plugin.json",
    "mods/manifest.json",
    "mods/context.ts",
    "mods/input.ts",
    "mods/review.ts",
    "mods/report.ts",
    "README.md"
  ]
]
const bytes = manifest.packages.map((item, index) => {
  assert.equal(item.file, item.name + ".zip")
  assert.equal(
    item.source,
    "examples/" + (item.name === "component-review-kit" ? "mods-component-kit" : item.name)
  )
  const payload = readFileSync(join(starter, item.file))
  assert.equal(hash(payload), item.sha256)
  const archive = new AdmZip(payload)
  assert.deepEqual(item.files.map((file) => file.path).sort(), [...requiredFiles[index]].sort())
  assert.deepEqual(
    archive
      .getEntries()
      .map((entry: { entryName: string }) => entry.entryName)
      .sort(),
    item.files.map((file) => file.path).sort()
  )
  for (const file of item.files) {
    assert(!file.path.startsWith("/") && !file.path.split("/").includes(".."))
    const original = readFileSync(join(root, item.source, file.path))
    assert.equal(hash(original), file.sha256)
    assert.deepEqual(archive.readFile(file.path), original)
    assert.deepEqual(
      readFileSync(join(starter, "sources", item.source.slice(9), file.path)),
      original
    )
  }
  return [...payload]
})
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const checks: string[] = []
const pageErrors: string[] = []
const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = []
const providerAnswers: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
const pass = (label: string) => {
  checks.push(label)
  console.log("PASS " + label)
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("Timeout: " + label)
}
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    const input = body.messages.findLast((message: { role: string }) => message.role === "user")
    const text = "协议验收回显[" + requests.length + "]：" + String(input?.content)
    providerAnswers.push(text)
    const common = { id: "starter-" + requests.length, created: 1, model: body.model }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        "data: " +
          JSON.stringify({
            ...common,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }
            ]
          }) +
          "\n\n"
      )
      response.write(
        "data: " +
          JSON.stringify({
            ...common,
            object: "chat.completion.chunk",
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
          }) +
          "\n\ndata: [DONE]\n\n"
      )
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.write(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
        })
      )
    }
    response.end()
  } catch {
    if (!response.headersSent) response.writeHead(500)
    response.end("Starter protocol fixture failed")
  }
})

async function run(failures: unknown[]) {
  const watchdog = setTimeout(() => void app?.close(), 240_000)
  let completed = false
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", done)
    })
    const address = server.address()
    assert(address && typeof address === "object")
    const baseUrl = "http://127.0.0.1:" + address.port + "/v1"
    app = await launch(60_000)
    const appVersion = await app.evaluate(({ app }) => app.getVersion())
    assert(
      readFileSync(join(starter, "使用说明.txt"), "utf8").startsWith(
        `DIY Claw 入门示例 — 配合 CMBDevClaw ${appVersion} 主版本`
      ),
      "Starter guide must name the actual running package version"
    )
    page = await app.firstWindow()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.setDefaultTimeout(15_000)
    await page.addInitScript("window.__name = value => value")
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as {
        starterApprovalOriginal?: typeof dialog.showMessageBox
      }
      state.starterApprovalOriginal = dialog.showMessageBox
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawView))
    const id = await page.evaluate(
      async ({ workspace, baseUrl }) => {
        await window.api.mods.configureGlobal(true)
        for (const name of ["starter-a", "starter-b"])
          await window.api.models.setCustomConfig({
            id: name,
            name,
            baseUrl,
            model: name,
            apiKey: "isolated-starter-fixture",
            maxTokens: 32000,
            maxOutputTokens: 4096
          })
        await window.api.models.setDefault("custom:starter-a")
        const thread = await window.api.threads.create({
          title: "DIY 入门包验收",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { workspace, baseUrl }
    )
    for (let index = 0; index < manifest.packages.length; index++) {
      const installed = await page.evaluate(
        ({ payload, file }) =>
          window.api.plugins.install(new Uint8Array(payload).buffer, file, "local"),
        { payload: bytes[index], file: manifest.packages[index].file }
      )
      assert(installed.success, installed.error)
    }
    const plugins = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!
    const sources = manifest.packages.map((item) => {
      const source = plugins.find((entry) => entry.name === item.name)
      assert(source?.digest)
      return { pluginId: source.pluginId, name: source.name, digest: source.digest }
    })
    assert.equal(new Set(sources.map((source) => source.pluginId)).size, 3)
    for (const source of sources)
      await page.evaluate(
        ({ id, source }) => window.api.mods.approveFunction(id, source.pluginId, source.digest),
        { id, source }
      )
    pass(
      "Three customer ZIPs exactly match maintained source and install as independent approved sources"
    )
    const apply = (profile: ClawProfile) =>
      page!.evaluate(
        async ({ id, profileJson }) => {
          const profile = JSON.parse(profileJson) as ClawProfile
          let view = await window.api.mods.clawView(id)
          view = await window.api.mods.clawChange(id, {
            kind: "save",
            profile,
            revision: view.revision,
            workspace: view.workspace
          })
          view = await window.api.mods.clawChange(id, {
            kind: "apply",
            id: profile.id,
            revision: view.revision,
            workspace: view.workspace
          })
          return { bindingRevision: view.bindingRevision }
        },
        { id, profileJson: JSON.stringify(profile) }
      )
    const commands = () => page!.evaluate((id) => window.api.mods.commands(id), id)
    const runCommand = async (name: string, text = "") => {
      const descriptor = (await commands()).find((entry) => entry.command === name)
      assert(descriptor, "Selected command is actually registered")
      const job = await page!.evaluate(
        ({ id, descriptor, text }) => window.api.mods.enqueue(id, descriptor, { text }),
        { id, descriptor, text }
      )
      let final = job
      await until(async () => {
        final = (await page!.evaluate((id) => window.api.mods.jobs(id), id)).find(
          (entry) => entry.id === job.id
        )!
        return Boolean(final && !["queued", "running"].includes(final.state))
      }, "real command " + name)
      assert.equal(final.state, "succeeded", JSON.stringify(final))
      return final.result
    }
    const board = sources[0]
    const style = sources[1]
    const kit = sources[2]
    await apply({ id: "starter-board", name: "原看板", capabilities: [board] })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("DIY 入门包验收", { exact: true }).first().click()
    await openModsResults(page)
    const pane = page.locator('[data-function-pane="composition-board"]')
    const counter = async () => {
      const match = /已完成 (\d+) 次操作/.exec(await pane.innerText())
      assert(match, "The actual pane must expose its counter")
      return Number(match[1])
    }
    await runCommand("claw-board")
    await until(
      async () =>
        (await pane.count()) === 1 && (await pane.innerText()).includes("已完成 0 次操作"),
      "original customer pane"
    )
    await pane.getByRole("button", { name: "完成一次操作", exact: true }).click()
    await until(
      async () => (await pane.innerText()).includes("已完成 1 次操作"),
      "original callback"
    )
    await page.screenshot({ path: join(artifacts, "01-board.png") })
    pass("The actual board ZIP publishes its pane and the real button increments its guest counter")
    await apply({ id: "starter-styled", name: "看板＋样式", capabilities: [board, style] })
    await runCommand("claw-board")
    await until(
      async () =>
        (await pane.count()) === 1 && (await pane.innerText()).includes("组合版 · 已完成 "),
      "composed customer pane"
    )
    const styledBefore = await counter()
    assert((await pane.innerText()).includes("此按钮仍执行原看板的操作"))
    await pane.getByRole("button", { name: "执行 · 完成一次操作", exact: true }).click()
    await until(async () => (await counter()) === styledBefore + 1, "composed original callback")
    await page.screenshot({ path: join(artifacts, "02-composed.png") })
    pass(
      "Independent style ZIP changes constructors while its button still executes the board callback"
    )
    await apply({ id: "starter-plain", name: "移除样式", capabilities: [board] })
    await runCommand("claw-board")
    await until(
      async () =>
        (await pane.count()) === 1 &&
        !(await pane.innerText()).includes("组合版") &&
        (await pane.innerText()).includes("已完成 "),
      "restored original pane"
    )
    assert(!(await pane.innerText()).includes("组合版"))
    const restoredBefore = await counter()
    await pane.getByRole("button", { name: "完成一次操作", exact: true }).click()
    await until(async () => (await counter()) === restoredBefore + 1, "restored callback")
    assert.equal(requests.length, 0)
    pass(
      "Removing style restores the original live button with zero model requests throughout the UI demo"
    )
    const code = "function first(xs) { return xs[0].name }"
    const selectedKit = {
      ...kit,
      components: {
        mode: "selected" as const,
        ids: ["review", "context"],
        config: { review: { focus: "空数组与空值" } }
      }
    }
    await apply({
      id: "starter-review",
      name: "自选检视组件",
      capabilities: [board, selectedKit],
      models: { default: "custom:starter-a", roles: {} }
    })
    assert.deepEqual((await commands()).map((entry) => entry.command).sort(), [
      "claw-board",
      "component-help",
      "component-review"
    ])
    const review = await runCommand("component-review", code)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, "starter-a")
    assert(
      requests[0].messages.some(
        (message) => message.role === "user" && String(message.content).includes(code)
      )
    )
    assert(requests[0].messages.some((message) => String(message.content).includes("空数组与空值")))
    assert.equal(review?.text, providerAnswers[0])
    await until(
      () =>
        page!.locator("[data-mod-jobs]").getByText(providerAnswers[0], { exact: true }).isVisible(),
      "visible original model reply"
    )
    await page.screenshot({ path: join(artifacts, "03-selected-review.png") })
    pass(
      "Selected review plus its dependency registers real commands and calls the applied default model A"
    )
    const allKit = {
      ...selectedKit,
      components: { ...selectedKit.components, ids: ["review", "context", "report"] }
    }
    const actions = (await page.evaluate((id) => window.api.mods.flowCatalog(id), id)).actions!
    const action = (name: string) => {
      const item = actions.find(
        (entry) => entry.pluginId === kit.pluginId && entry.actionId === name
      )
      assert(item)
      return {
        pluginId: item.pluginId,
        plugin: item.plugin,
        digest: item.digest,
        actionId: item.actionId
      }
    }
    const definition: FlowDefinition = {
      schemaVersion: 2,
      execution: { kind: "host" },
      id: "starter-review-report",
      name: "文本检视与汇报",
      goal: "检视给定文本并整理实际模型结果",
      timeoutMs: 120000,
      maxExecutions: 3,
      steps: [
        {
          id: "review",
          name: "检视",
          kind: "plugin-action",
          enabled: true,
          ...action("review"),
          input: { text: code }
        },
        {
          id: "report",
          name: "汇报",
          kind: "plugin-action",
          enabled: true,
          ...action("report"),
          input: {},
          inputFrom: { stepId: "review" }
        }
      ]
    }
    const saved = await page.evaluate(
      ({ id, definitionJson }) =>
        window.api.mods.flowSave(id, JSON.parse(definitionJson) as FlowDefinition, 0),
      { id, definitionJson: JSON.stringify(definition) }
    )
    const binding = await apply({
      id: "starter-flow",
      name: "检视与汇报＋模型B",
      capabilities: [board, allKit],
      models: { default: "custom:starter-b", roles: {} },
      flow: saved
    })
    assert((await commands()).some((entry) => entry.command === "component-report"))
    assert.equal(requests.length, 1, "Saving and applying must not start either SDK call")
    const run = await page.evaluate(
      ({ id, revision }) => window.api.mods.clawStart(id, revision, "体验文本检视与汇报"),
      { id, revision: binding.bindingRevision }
    )
    let current = run
    await until(async () => {
      current = (await page!.evaluate(({ id, runId }) => window.api.mods.flowRun(id, runId), {
        id,
        runId: run.id
      }))!
      return ["complete", "failed", "cancelled", "interrupted", "waiting"].includes(current.status)
    }, "actual customer action flow")
    assert.equal(current.status, "complete", JSON.stringify(current))
    assert.equal(requests.length, 3)
    assert.equal(requests[1].model, "starter-b")
    assert.equal(requests[2].model, "starter-b")
    const firstOutput = current.attempts.find((entry) => entry.stepId === "review")?.result?.output
    assert.equal(firstOutput?.text, providerAnswers[1])
    assert(
      requests[2].messages.some(
        (message) => message.role === "user" && message.content === firstOutput?.text
      )
    )
    assert.equal(
      current.attempts.find((entry) => entry.stepId === "report")?.result?.output?.text,
      providerAnswers[2]
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("DIY 入门包验收", { exact: true }).first().click()
    const runPane = await openModsFlowHistory(page, run.id)
    for (const summary of await runPane.getByText("查看结果与证据", { exact: true }).all())
      await summary.click()
    const history = runPane.getByRole("list", { name: "步骤执行记录", exact: true })
    assert(await history.getByText(providerAnswers[1], { exact: true }).isVisible())
    assert(await history.getByText(providerAnswers[2], { exact: true }).isVisible())
    await page.screenshot({ path: join(artifacts, "04-action-flow.png") })
    pass(
      "Original kit actions pass the real review output object to report and both honor applied model B"
    )
    const old = (await commands()).find((entry) => entry.command === "component-report")!
    await apply({ id: "starter-removed", name: "移除组件包", capabilities: [board] })
    assert(!(await commands()).some((entry) => entry.command.startsWith("component-")))
    await assert.rejects(
      page.evaluate(({ id, old }) => window.api.mods.enqueue(id, old, { text: "must not run" }), {
        id,
        old
      }),
      /MODS_COMMAND_STALE/
    )
    const oldBoard = (await commands()).find((entry) => entry.command === "claw-board")!
    assert(oldBoard)
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await assert.rejects(
      page.evaluate(
        ({ id, oldBoard }) => window.api.mods.enqueue(id, oldBoard, { text: "must not run" }),
        { id, oldBoard }
      ),
      /MODS_DISABLED/
    )
    assert.equal(requests.length, 3)
    assert.deepEqual(pageErrors, [])
    pass(
      "Removed components and global OFF reject old public command references without another provider call"
    )
    completed = true
  } catch (error) {
    failures.push(error)
    await attemptModsE2eCleanup(failures, () =>
      page?.screenshot({
        path: join(artifacts, "failure.png")
      })
    )
  } finally {
    clearTimeout(watchdog)
    await attemptModsE2eCleanup(failures, () =>
      app?.evaluate(({ dialog }) => {
        const state = globalThis as unknown as {
          starterApprovalOriginal?: typeof dialog.showMessageBox
        }
        if (state.starterApprovalOriginal) dialog.showMessageBox = state.starterApprovalOriginal
        delete state.starterApprovalOriginal
      })
    )
    await attemptModsE2eCleanup(failures, () => app?.close())
    await attemptModsE2eCleanup(failures, async () => {
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
    })
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "report.json"),
        JSON.stringify(
          {
            passed: completed && failures.length === 0,
            isolated,
            checks,
            pageErrors,
            requests,
            sourceManifest: manifest,
            notCovered: ["customer installation", "online model quality", "real project tests"],
            fixtures: [
              "native tool authorization auto-answer",
              "offline SSO",
              "local echo provider"
            ]
          },
          null,
          2
        ) + "\n"
      )
    )
  }
}
void runModsE2eWithFailures(run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
