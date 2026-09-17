/** Real Electron, production IPC/React, SQLite, QuickJS utility process and LocalSandbox.
 * Tool probes use the real ingress; model scenarios use a local HTTP producer and real agent loop.
 * Native confirmation is answered by the test; no external model/API is used.
 */
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { _electron, type ElectronApplication, type Page } from "playwright"
import { startModsModelServer } from "./support/mods-model-server"
import AdmZip from "adm-zip"

const root = resolve(__dirname, "..")
const localRequire = createRequire(join(root, "package.json"))
const packagedDir = process.env.CMB_MODS_PACKAGED_DIR
const binary = packagedDir
  ? join(resolve(packagedDir), "CMBDevClaw.exe")
  : (localRequire("electron") as string)
const isolated = mkdtempSync(join(tmpdir(), "cmb-mods-e2e-"))
const artifacts = join(root, "output/mods-validation", packagedDir ? "packaged-e2e" : "e2e")
mkdirSync(artifacts, { recursive: true })
const workspace = join(isolated, "workspace")
mkdirSync(workspace)
writeFileSync(
  join(workspace, "package.json"),
  JSON.stringify({ scripts: { test: "node verify.cjs" } })
)
writeFileSync(
  join(workspace, "verify.cjs"),
  'require("fs").appendFileSync("verified.txt", "once\\n"); console.log("PROJECT_VERIFIED")'
)
writeFileSync(join(workspace, "secret.txt"), "sk-private-fixture-123456789")
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (
    value &&
    /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
      key
    )
  )
    env[key] = value
}
for (const [key, folder] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  CMB_COWORK_AGENT_HOME: "data",
  TEMP: "temp",
  TMP: "temp"
})) {
  env[key] = join(isolated, folder)
  mkdirSync(env[key], { recursive: true })
}
Object.assign(env, {
  CMB_E2E_DISABLE_GPU: "1",
  CMB_E2E_ELECTRON_BIN: binary,
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost"
})
const checks: string[] = []
const timings: Record<string, unknown> = {}
let app: ElectronApplication | undefined
let page: Page | undefined
let modelServer: Awaited<ReturnType<typeof startModsModelServer>> | undefined
const pass = (name: string) => {
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error(`Timeout: ${label}`)
}
async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("E2E deadline exceeded")
    void app?.close()
  }, 120_000)
  try {
    console.log("STEP launch")
    app = await _electron.launch({
      executablePath: join(root, "tests/support/electron-launcher.cmd"),
      args: [
        ...(packagedDir ? [] : [join(root, "out/main/index.js")]),
        `--user-data-dir=${join(isolated, "electron")}`
      ],
      cwd: root,
      env,
      timeout: 60_000
    })
    // Match existing Electron suites: prevent corporate SSO navigation in an
    // isolated offline test profile. Mods IPC and runtime remain production code.
    // Production registers its IPC handlers before creating the main window.
    await app.firstWindow()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
    })
    await until(async () => {
      for (const candidate of app!.windows())
        if (await candidate.evaluate(() => Boolean(window.api?.mods)).catch(() => false)) {
          page = candidate
          return true
        }
      return false
    }, "production preload")
    await page!.addInitScript("window.__name = value => value")
    console.log("STEP preload ready")
    const threadId = await page!.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Mods E2E",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    if (packagedDir) {
      const packaged = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath()
      }))
      assert.equal(packaged.packaged, true)
      assert(packaged.path.endsWith("app.asar"))
      const asar = localRequire("@electron/asar") as {
        listPackage(path: string): string[]
      }
      const files = asar.listPackage(packaged.path).map((file) => file.replace(/\\/g, "/"))
      assert(files.some((file) => file.endsWith("/out/main/mod-host.js")))
      assert(!files.some((file) => file.endsWith("/mods-e2e.js")))
      assert(files.some((file) => file.endsWith(".wasm") && file.includes("/@jitl/")))
      pass("production ASAR starts without a test entry and contains the isolated runtime")
      await page!.evaluate(() => window.api.mods.installExamples())
      const initial = await page!.evaluate((id) => window.api.mods.status(id), threadId)
      assert.equal(initial.enabled, false)
      assert.equal(initial.mods.length, 2)
      for (const mod of initial.mods) {
        if (mod.state === "invalid") {
          console.error(
            await app.evaluate(async ({ app }) => {
              try {
                const { createRequire } = process.getBuiltinModule("node:module")
                const compiler = createRequire(app.getAppPath() + "/package.json")("esbuild")
                await compiler.build({ stdin: { contents: "export default {}" }, write: false })
                return "Packaged compiler probe passed"
              } catch (error) {
                return String(error)
              }
            })
          )
        }
        assert.equal(mod.state, "needs-approval", JSON.stringify(mod))
        await page!.evaluate(
          ({ threadId, pluginId, digest }) => window.api.mods.approve(threadId, pluginId, digest),
          { threadId, pluginId: mod.pluginId, digest: mod.digest! }
        )
      }
      await page!.evaluate((id) => window.api.mods.configure(id, true, true), threadId)
      const approved = await page!.evaluate((id) => window.api.mods.status(id), threadId)
      assert(approved.mods.every((mod) => mod.state === "ready"))
      pass("packaged esbuild and QuickJS compile and validate both bundled examples")
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({
          response: 1,
          checkboxChecked: false
        })) as typeof dialog.showMessageBox
      })
      await page!.reload({ waitUntil: "domcontentloaded" })
      await page!.getByText("Mods E2E", { exact: true }).first().click()
      await page!.locator("textarea.composer-textarea").fill("/mod project-quality:verify {}")
      await page!.locator("textarea.composer-textarea").press("Enter")
      await until(
        async () => existsSync(join(workspace, "verified.txt")),
        "packaged cold command writes through real native tool"
      )
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
            (job) => job.state === "succeeded"
          ),
        "packaged command terminal state"
      )
      assert.equal(readFileSync(join(workspace, "verified.txt"), "utf8"), "once\n")
      await page!.getByRole("button", { name: "查看测试报告", exact: true }).click()
      const preview = page!.locator("[data-mod-cards] pre[aria-live='polite']").last()
      await until(
        async () =>
          (await preview.count()) > 0 && (await preview.innerText()).includes("项目测试结果"),
        "packaged report content arrives through production IPC"
      )
      assert((await preview.innerText()).includes("PROJECT_VERIFIED"))
      const exported = join(workspace, "exported-report.txt")
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath
        })) as typeof dialog.showSaveDialog
      }, exported)
      await page!.getByRole("button", { name: "导出文本", exact: true }).click()
      await until(async () => existsSync(exported), "packaged report export creates a real file")
      assert(readFileSync(exported, "utf8").includes("PROJECT_VERIFIED"))
      await preview.scrollIntoViewIfNeeded()
      await page!.screenshot({ path: join(artifacts, "cold-command.png") })
      pass(
        "packaged cold session executes a real approved command and previews/exports its report without a model or test bridge"
      )
      await page!.getByRole("button", { name: "自定义", exact: true }).click()
      await page!.getByRole("button", { name: "插件", exact: true }).click()
      await page!.locator("[data-mods-settings]").waitFor()
      await page!.screenshot({ path: join(artifacts, "settings.png") })
      pass("packaged preload and React settings retain project grants after reload")
      return
    }
    const scope = { workspace, threadId, turnId: "mods-e2e-turn" }
    const bridge = join(root, "out/main/mods-e2e.js")
    console.log("STEP load fixture")
    await app.evaluate(async ({ dialog }, entry) => {
      const { createRequire } = process.getBuiltinModule("node:module")
      Object.assign(globalThis, { modsFixture: createRequire(entry)(entry), modsConfirmations: [] })
      dialog.showMessageBox = (async (_window, options) => {
        ;(globalThis as unknown as { modsConfirmations: unknown[] }).modsConfirmations.push(options)
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    }, bridge)
    console.log("STEP fixture ready")
    const run = (id: string, name: string, args: Record<string, unknown>) =>
      app!.evaluate(
        async (_electron, input) => {
          return (
            globalThis as unknown as {
              modsFixture: { runTool(...args: unknown[]): Promise<unknown> }
            }
          ).modsFixture.runTool(input.scope, input.id, input.name, input.args)
        },
        { scope, id, name, args }
      )
    const benchmark = () =>
      app!.evaluate(
        async (_electron, scope) =>
          (
            globalThis as unknown as {
              modsFixture: { benchmark(scope: unknown): Promise<unknown> }
            }
          ).modsFixture.benchmark(scope),
        scope
      )
    timings.disabled = await benchmark()
    timings.disabledReadComparison = await app.evaluate(
      async (_electron, scope) =>
        (
          globalThis as unknown as {
            modsFixture: { disabledReadBenchmark(scope: unknown): Promise<unknown> }
          }
        ).modsFixture.disabledReadBenchmark(scope),
      scope
    )
    console.log("STEP benchmark ready")
    await run("before", "write_file", { file_path: join(workspace, "before.txt"), content: "off" })
    assert.equal(readFileSync(join(workspace, "before.txt"), "utf8"), "off")
    pass("disabled tools retain existing behavior")
    await page!.evaluate(() => window.api.mods.installExamples())
    const status = await page!.evaluate((thread) => window.api.mods.status(thread), threadId)
    assert.equal(status.mods.length, 2)
    for (const mod of status.mods) {
      assert.equal(mod.state, "needs-approval")
      await page!.evaluate(
        async ({ threadId, pluginId, digest }) =>
          window.api.mods.approve(threadId, pluginId, digest),
        { threadId, pluginId: mod.pluginId, digest: mod.digest! }
      )
    }
    await page!.evaluate((thread) => window.api.mods.configure(thread, true, true), threadId)
    pass("production plugin installation and per-project digest grants")
    const contexts = await app.evaluate(
      async (_electron, scope) =>
        (
          globalThis as unknown as { modsFixture: { context(scope: unknown): Promise<string[]> } }
        ).modsFixture.context(scope),
      scope
    )
    assert(contexts.join("\n").includes("修改代码后运行相关测试"))
    pass("context executes in the real isolated runtime")
    await assert.rejects(
      run("denied", "write_file", { file_path: join(workspace, ".env"), content: "must-not-write" })
    )
    assert.equal(existsSync(join(workspace, ".env")), false)
    pass("tool middleware denial prevents a real filesystem write")
    const result = await run("approved", "write_file", {
      file_path: join(workspace, "proof.txt"),
      content: "written"
    })
    assert.equal(readFileSync(join(workspace, "proof.txt"), "utf8"), "written")
    const secret = await run("filtered", "read_file", { file_path: join(workspace, "secret.txt") })
    assert(!JSON.stringify(secret).includes("sk-private-fixture"))
    assert(JSON.stringify(secret).includes("[REDACTED]"))
    pass("actual file output is filtered before publication")
    await page!.evaluate(
      async ({ threadId, result }) => {
        await window.api.threads.appendMessages(threadId, [
          {
            id: "mods-request",
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "approved",
                name: "write_file",
                args: { file_path: "proof.txt", content: "written" }
              }
            ]
          },
          {
            id: "mods-response",
            role: "tool",
            name: "write_file",
            tool_call_id: "approved",
            content: JSON.stringify(result)
          }
        ])
      },
      { threadId, result }
    )
    const publishedCards = await page!.evaluate(
      (thread) => window.api.mods.cards(thread, "approved"),
      threadId
    )
    assert(publishedCards.some((card) => card.modId === "project-quality"))
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    const card = page!.locator('[data-mod-card="project-quality"]').first()
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole("button", { name: "运行项目测试" }).click()
    await until(
      async () => existsSync(join(workspace, "verified.txt")),
      "approved card command executes npm test"
    )
    await until(
      async () =>
        (await page!.locator("[data-mod-cards]").first().innerText()).includes("PROJECT_VERIFIED"),
      "command result displayed"
    )
    assert.equal(readFileSync(join(workspace, "verified.txt"), "utf8"), "once\n")
    assert.equal(
      await app.evaluate(
        () => (globalThis as unknown as { modsConfirmations: unknown[] }).modsConfirmations.length
      ),
      1
    )
    await page!.screenshot({ path: join(artifacts, "card-command.png") })
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    await page!.locator('[data-mod-card="project-quality"]').first().waitFor()
    assert(
      await page!
        .locator('[data-mod-card="project-quality"]')
        .first()
        .getByRole("button", { name: "运行项目测试" })
        .isDisabled()
    )
    pass("real React card executes once through host approval and stays consumed after reload")
    await app.evaluate(
      (_electron, threadId) =>
        (
          globalThis as unknown as {
            modsFixture: { setThreadBusy(id: string, busy: boolean): void }
          }
        ).modsFixture.setThreadBusy(threadId, true),
      threadId
    )
    const composer = page!.locator("textarea.composer-textarea")
    await composer.fill("/mod")
    await page!.getByText("project-quality:verify", { exact: true }).first().waitFor()
    await composer.fill("/mod project-quality:verify {}")
    await composer.press("Enter")
    await page!.locator('[data-mod-job-state="queued"]').waitFor()
    assert.equal(readFileSync(join(workspace, "verified.txt"), "utf8"), "once\n")
    await app.evaluate(
      (_electron, threadId) =>
        (
          globalThis as unknown as {
            modsFixture: { setThreadBusy(id: string, busy: boolean): void }
          }
        ).modsFixture.setThreadBusy(threadId, false),
      threadId
    )
    await until(
      async () => readFileSync(join(workspace, "verified.txt"), "utf8") === "once\nonce\n",
      "slash command executes once after releasing model lease"
    )
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).filter(
          (job) => job.state === "succeeded"
        ).length >= 2,
      "command jobs settle"
    )
    await page!.getByRole("button", { name: "查看测试报告", exact: true }).last().click()
    const reportPreview = page!.locator("[data-mod-cards] pre[aria-live='polite']").last()
    await until(
      async () =>
        (await reportPreview.count()) > 0 &&
        (await reportPreview.innerText()).includes("项目测试结果"),
      "report content arrives through production IPC"
    )
    assert((await reportPreview.innerText()).includes("PROJECT_VERIFIED"))
    await reportPreview.scrollIntoViewIfNeeded()
    await page!.screenshot({ path: join(artifacts, "commands-and-report.png") })
    const summaryCards = await page!.evaluate((id) => window.api.mods.cards(id, ""), threadId)
    const references = JSON.stringify(summaryCards)
    assert(references.includes("artifact-link"))
    pass("real slash command queues behind model lease and publishes a scoped text report")
    await app.evaluate(
      (_electron, threadId) =>
        (
          globalThis as unknown as {
            modsFixture: { setThreadBusy(id: string, busy: boolean): void }
          }
        ).modsFixture.setThreadBusy(threadId, true),
      threadId
    )
    await composer.fill("/mod project-quality:verify {}")
    await composer.press("Enter")
    await page!
      .locator('[data-mod-job-state="queued"]')
      .getByRole("button", { name: "取消排队" })
      .click()
    await page!.locator('[data-mod-job-state="cancelled"]').waitFor({ state: "attached" })
    await app.evaluate(
      (_electron, threadId) =>
        (
          globalThis as unknown as {
            modsFixture: { setThreadBusy(id: string, busy: boolean): void }
          }
        ).modsFixture.setThreadBusy(threadId, false),
      threadId
    )
    assert.equal(readFileSync(join(workspace, "verified.txt"), "utf8"), "once\nonce\n")
    await app.evaluate(
      async (_electron, threadId) =>
        (
          globalThis as unknown as { modsFixture: { finishTurn(id: string): Promise<void> } }
        ).modsFixture.finishTurn(threadId),
      threadId
    )
    assert(
      (
        await page!.evaluate((id) => window.api.mods.cards(id, "turn:mods-e2e-turn"), threadId)
      ).some((card) => card.slot === "turn.summary")
    )
    pass(
      "queued cancellation prevents execution and turn summary comes from durable execution facts"
    )
    const policy = await app.evaluate(
      async (_electron, scope) =>
        (
          globalThis as unknown as {
            modsFixture: {
              managedPolicyProbe(scope: unknown): Promise<{
                required: boolean
                blocked: boolean
                executions: number
                result: unknown
                rebuilt: string
              }>
            }
          }
        ).modsFixture.managedPolicyProbe(scope),
      scope
    )
    assert(policy.required && policy.blocked && policy.executions === 0)
    assert(!JSON.stringify(policy.result).includes("corporate-sensitive-fixture"))
    assert(!JSON.stringify(policy.result).includes("do-not-publish"))
    assert.equal(policy.rebuilt, "[REDACTED]")
    pass(
      "separate managed policy process enforces mandatory admission, complete filtering and rebuild"
    )
    const coldId = await page!.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Mods cold start",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string; id?: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Mods cold start", { exact: true }).first().click()
    await page!.locator("textarea.composer-textarea").fill("/mod project-quality:verify {}")
    await page!.locator("textarea.composer-textarea").press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), coldId)).some(
          (job) => job.state === "succeeded"
        ),
      "cold project command completes without a model turn"
    )
    assert.equal(readFileSync(join(workspace, "verified.txt"), "utf8"), "once\nonce\nonce\n")
    await page!.screenshot({ path: join(artifacts, "cold-command.png") })
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    pass(
      "fresh project session runs native Mods commands with inherited sandbox settings and explicit approval"
    )
    const mcp = await app.evaluate(
      async (_electron, input) =>
        (
          globalThis as unknown as {
            modsFixture: {
              mcpProbe(
                scope: unknown,
                node: string,
                server: string
              ): Promise<{
                direct: unknown
                eager: unknown
                callbacks: unknown[]
                lostReply: boolean
                audit: Array<{ status: string }>
              }>
            }
          }
        ).modsFixture.mcpProbe(input.scope, input.node, input.server),
      { scope, node: process.execPath, server: join(root, "tests/support/mods-mcp-server.mjs") }
    )
    assert(mcp.lostReply)
    assert.equal(
      readFileSync(join(workspace, "mcp-counter.txt"), "utf8"),
      "echo\necho\ndisconnect\n"
    )
    assert(!JSON.stringify([mcp.direct, mcp.eager, mcp.callbacks]).includes("sk-mcp-fixture"))
    assert(mcp.callbacks.length > 0)
    assert.equal(mcp.audit.filter((row) => row.status === "unknown").length, 1)
    pass(
      "real MCP stdio discovery and eager/direct calls filter all projections; lost write reply is not retried"
    )
    timings.enabled = await benchmark()
    timings.noop1000 = await app.evaluate(
      async (_electron, scope) =>
        (
          globalThis as unknown as {
            modsFixture: { noopBenchmark(scope: unknown): Promise<unknown> }
          }
        ).modsFixture.noopBenchmark(scope),
      scope
    )
    await app.evaluate(() =>
      (globalThis as unknown as { modsFixture: { stopRuntime(): void } }).modsFixture.stopRuntime()
    )
    await run("recovered", "write_file", {
      file_path: join(workspace, "recovered.txt"),
      content: "recovered"
    })
    assert.equal(readFileSync(join(workspace, "recovered.txt"), "utf8"), "recovered")
    pass("runtime death is recovered by rebuilding approved snapshots")
    await page!.evaluate(
      (threadId) => window.api.mods.revoke(threadId, "project-quality"),
      threadId
    )
    const revokedCards = await page!.evaluate(
      (thread) => window.api.mods.cards(thread, "recovered"),
      threadId
    )
    assert(!JSON.stringify(revokedCards).includes("actionId"))
    pass("revocation invalidates existing cards")
    await page!.getByRole("button", { name: "自定义", exact: true }).click()
    await page!.getByRole("button", { name: "插件", exact: true }).click()
    await page!.locator("[data-mods-settings]").waitFor()
    await page!.locator("[data-mods-audit] > summary").click()
    await page!.getByText("审计摘要", { exact: true }).first().waitFor()
    await page!.screenshot({ path: join(artifacts, "settings.png") })
    pass("production settings panel renders project grants")
    const functionSettings = page!.locator('[data-function-mod-id="function-commands"]')
    await functionSettings.waitFor()
    await functionSettings.getByRole("button", { name: "授权以上能力", exact: true }).click()
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.status(id), threadId)).functionMods?.some(
          (mod) => mod.name === "function-commands" && mod.state === "ready"
        ) === true,
      "function plugin approved through React"
    )
    const foundationZip = new AdmZip()
    foundationZip.addLocalFolder(join(root, "tests/fixtures/mods-v2/host-foundation"))
    const installed = await page!.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "host-foundation.zip", "local"),
      [...foundationZip.toBuffer()]
    )
    assert.equal(installed.success, true, installed.error)
    const foundationMod = (
      await page!.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((mod) => mod.name === "host-foundation")!
    assert.ok(foundationMod?.digest)
    // Approve fixtures before measuring session state: grants deliberately invalidate all VMs.
    await page!.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: foundationMod.pluginId, digest: foundationMod.digest }
    )
    await page!.screenshot({ path: join(artifacts, "function-grant.png") })
    await page!.getByRole("button", { name: "返回会话", exact: true }).click()
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    const functionComposer = page!.locator("textarea.composer-textarea")
    await functionComposer.fill("/claw")
    await page!.getByText("claw-info", { exact: true }).first().waitFor()
    const functionCommand = (
      await page!.evaluate((id) => window.api.mods.commands(id), threadId)
    ).find(
      (command) => command.modId === "function:function-commands" && command.command === "claw-info"
    )!
    assert.equal(functionCommand.command, "claw-info")
    await app.evaluate(
      (_electron, id) =>
        (
          globalThis as unknown as {
            modsFixture: { setThreadBusy(id: string, busy: boolean): void }
          }
        ).modsFixture.setThreadBusy(id, true),
      threadId
    )
    for (const count of [1, 2]) {
      await functionComposer.fill(`/claw-info 查询${count}`)
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
            (job) =>
              job.command === "claw-info" &&
              job.state === "succeeded" &&
              job.result?.text.includes(`本次会话查询：${count}`) === true
          ),
        "immediate function command completes while model lease is held"
      )
    }
    await app.evaluate(
      (_electron, id) =>
        (
          globalThis as unknown as {
            modsFixture: { setThreadBusy(id: string, busy: boolean): void }
          }
        ).modsFixture.setThreadBusy(id, false),
      threadId
    )
    const functionResult = page!
      .locator("[data-mod-jobs] pre")
      .filter({ hasText: "本次会话查询：2" })
    await functionResult.waitFor({ state: "visible" })
    await functionResult.scrollIntoViewIfNeeded()
    await page!.screenshot({ path: join(artifacts, "function-command.png") })
    pass(
      "standard function plugin grants, direct text commands, persistent state and immediate queries work through production UI"
    )
    const toolConfirmationsBefore = await app.evaluate(
      () => (globalThis as unknown as { modsConfirmations: unknown[] }).modsConfirmations.length
    )
    await functionComposer.fill("/claw-tool-write E2E SDK body")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) => job.command === "claw-tool-write" && job.state === "succeeded"
        ),
      "function SDK write completes"
    )
    assert.equal(
      readFileSync(join(workspace, "mods-sdk-note.txt"), "utf8"),
      "# Claw Mods 记录\n\nE2E SDK body\n"
    )
    const toolConfirmations = await app.evaluate(
      () =>
        (globalThis as unknown as { modsConfirmations: Array<{ message: string; detail: string }> })
          .modsConfirmations
    )
    assert(toolConfirmations.length > toolConfirmationsBefore)
    assert(
      toolConfirmations
        .slice(toolConfirmationsBefore)
        .some(
          (c) =>
            c.message.includes("function:function-commands") && c.detail.includes("Claw Mods 记录")
        )
    )
    await functionComposer.fill("/claw-tool-read mods-sdk-note.txt")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) =>
            job.command === "claw-tool-read" &&
            job.state === "succeeded" &&
            job.result?.text.includes("E2E SDK body") === true
        ),
      "function SDK reads real written file"
    )
    pass(
      "function tool SDK executes a real queued write, approves hook-rewritten final input, and reads through native adapters"
    )
    // Native write_file creates a file; editing an existing file uses edit_file.
    // Preserve the warm-session artifact and give the cold create its own destination.
    renameSync(join(workspace, "mods-sdk-note.txt"), join(workspace, "warm-sdk-note.txt"))
    const coldFunctionId = await page!.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Function SDK cold start",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Function SDK cold start", { exact: true }).first().click()
    const permissionApprovals = await app.evaluate(
      () => (globalThis as unknown as { modsConfirmations: unknown[] }).modsConfirmations.length
    )
    const permissionAudit = await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)
    for (const [input, decision] of [
      [{ tool: "read_file", input: { file_path: "secret.txt" } }, "allow"],
      [
        { tool: "write_file", input: { file_path: "permission-never.txt", content: "never" } },
        "ask"
      ]
    ] as const) {
      const before = (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).map(
        (job) => job.id
      )
      await functionComposer.fill(`/claw-check ${JSON.stringify(input)}`)
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).some(
            (job) =>
              !before.includes(job.id) &&
              job.command === "claw-check" &&
              job.state === "succeeded" &&
              JSON.parse(job.result?.text ?? "{}").decision === decision
          ),
        "cold pure permission query"
      )
    }
    assert(!existsSync(join(workspace, "permission-never.txt")))
    assert.equal(
      await app.evaluate(
        () => (globalThis as unknown as { modsConfirmations: unknown[] }).modsConfirmations.length
      ),
      permissionApprovals
    )
    const permissionAfter = await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)
    assert.deepEqual(
      permissionAfter.map((row) => row.callId),
      permissionAudit.map((row) => row.callId)
    )
    await page!.screenshot({ path: join(artifacts, "function-tool-permission.png") })
    pass(
      "cold permission queries return allow/ask with no tool, file, approval or execution receipt"
    )
    writeFileSync(join(workspace, "permission-asked.txt"), "ASKED_READ_OK")
    writeFileSync(join(workspace, "permission-blocked.txt"), "MUST_NOT_READ")
    for (const file of ["permission-asked.txt", "permission-blocked.txt"]) {
      await functionComposer.fill(`/claw-tool-read ${file}`)
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)).some(
            (row) =>
              row.identity?.threadId === coldFunctionId &&
              row.toolId === "host:read_file" &&
              row.status === (file.includes("asked") ? "succeeded" : "not_started")
          ),
        "actual permission verdict"
      )
    }
    const permissionDialogs = await app.evaluate(
      () =>
        (
          globalThis as unknown as {
            modsConfirmations: Array<{ detail: string }>
          }
        ).modsConfirmations
    )
    assert(
      permissionDialogs.some((item) =>
        item.detail.includes("Permission fixture asks function-commands")
      )
    )
    assert(
      !(await page!
        .locator("body")
        .innerText()
        .then((text) => text.includes("MUST_NOT_READ")))
    )
    pass("actual native reads honor permission ask/deny and expose the protected approval reason")
    await functionComposer.fill("/foundation-native ")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).some(
          (job) =>
            job.command === "foundation-native" &&
            job.state === "succeeded" &&
            job.result?.text.includes("REDACTED")
        ),
      "concurrent cold native SDK calls"
    )
    const nativeParent = (
      await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)
    ).find(
      (row) =>
        row.identity?.threadId === coldFunctionId &&
        row.toolId === "function:mcp__host-foundation__probe"
    )!
    const nativeChildren = (
      await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)
    ).filter((row) => row.identity?.parentCallId === nativeParent.callId)
    assert.equal(nativeChildren.length, 2)
    assert(
      nativeChildren.every(
        (row) =>
          row.status === "succeeded" && row.identity?.turnId === nativeParent.identity?.turnId
      )
    )
    pass(
      "concurrent cold native SDK reads retain parent identity and release their temporary adapters"
    )
    const executionWorkspace = join(isolated, "execution-worktree")
    mkdirSync(executionWorkspace)
    writeFileSync(join(workspace, "scope-note.txt"), "GRANT_PROJECT_CONTENT")
    writeFileSync(join(executionWorkspace, "scope-note.txt"), "EXECUTION_ROOT_OK")
    writeFileSync(join(executionWorkspace, ".git"), "PRIVATE_WORKTREE_POINTER")
    await app.evaluate(
      (_electron, input) =>
        (
          globalThis as unknown as {
            modsFixture: { bindExecutionScope(scope: unknown, root: string): void }
          }
        ).modsFixture.bindExecutionScope(input.scope, input.root),
      {
        scope: { workspace, threadId: coldFunctionId, turnId: "mods-execution-scope" },
        root: executionWorkspace
      }
    )
    try {
      const beforeScope = await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)
      await functionComposer.fill("/foundation-scope ")
      await page!
        .locator("form")
        .filter({ has: page!.locator("textarea.composer-textarea") })
        .locator('button[type="submit"]')
        .click()
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).some(
            (job) => job.command === "foundation-scope" && job.state === "succeeded"
          ),
        "isolated SDK execution scope"
      )
      const job = (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).find(
        (job) => job.command === "foundation-scope"
      )!
      const value = JSON.parse(job.result!.text)
      assert.equal(value.cwd.toLowerCase(), executionWorkspace.toLowerCase())
      assert.equal(value.file, "EXECUTION_ROOT_OK")
      assert.equal(value.git, false)
      assert.deepEqual(
        value.entries.map((entry: { name: string }) => entry.name),
        ["scope-note.txt"]
      )
      assert(value.native.text.includes("EXECUTION_ROOT_OK"))
      assert.equal(value.permission.decision, "deny")
      assert.match(value.blocked, /MODS_RUNTIME_TOOL_DENIED/)
      assert.doesNotMatch(JSON.stringify(value), /GRANT_PROJECT_CONTENT|PRIVATE_WORKTREE_POINTER/)
      const audit = (
        await page!.evaluate((id) => window.api.mods.audit(id), coldFunctionId)
      ).filter((row) => !beforeScope.some((prior) => prior.callId === row.callId))
      assert.equal(audit.length, 1)
      assert.equal(audit[0].toolId, "host:read_file")
      assert.equal(audit[0].identity!.workspace.toLowerCase(), workspace.toLowerCase())
      await page!.screenshot({ path: join(artifacts, "function-execution-scope.png") })
      pass(
        "real native and file SDKs use the execution root, keep project grants and reject runtime-blocked tools without execution"
      )
    } finally {
      await app.evaluate(
        (_electron, id) =>
          (
            globalThis as unknown as { modsFixture: { releaseExecutionScope(id: string): void } }
          ).modsFixture.releaseExecutionScope(id),
        coldFunctionId
      )
    }
    await functionComposer.fill("/claw-tool-write COLD SDK body")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).some(
          (job) => job.command === "claw-tool-write" && job.state === "succeeded"
        ),
      "cold function SDK write completes"
    )
    assert.equal(
      readFileSync(join(workspace, "mods-sdk-note.txt"), "utf8"),
      "# Claw Mods 记录\n\nCOLD SDK body\n"
    )
    await functionComposer.fill("/claw-tool-read mods-sdk-note.txt")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), coldFunctionId)).some(
          (job) =>
            job.command === "claw-tool-read" &&
            job.state === "succeeded" &&
            job.result?.text.includes("COLD SDK body") === true
        ),
      "cold function SDK read rebinds expired command context"
    )
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    pass(
      "function SDK creates and refreshes native tool context in a cold session with no model turn"
    )
    modelServer = await startModsModelServer()
    await page!.evaluate(async (baseUrl) => {
      await window.api.models.setCustomConfig({
        id: "mods-model-fixture",
        name: "Mods protocol fixture",
        baseUrl,
        model: "gpt-4",
        apiKey: "fixture-key",
        maxTokens: 32000,
        maxOutputTokens: 4096
      })
      await window.api.models.setDefault("custom:mods-model-fixture")
    }, modelServer.url)
    await functionComposer.fill("/claw-ask 模型 SDK 协议回检")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) =>
            job.command === "claw-ask" &&
            job.state === "succeeded" &&
            job.result?.text === "SDK_MODEL_OK [REDACTED]"
        ),
      "model SDK publishes protected text"
    )
    assert.equal(modelServer.requests.length, 1)
    const modelRequest = modelServer.requests[0]
    assert.equal(modelRequest.max_tokens, 512)
    assert.deepEqual(
      modelRequest.messages.map((message) => message.role),
      ["system", "user"]
    )
    assert.equal(modelRequest.messages[1].content, "模型 SDK 协议回检")
    assert.equal(modelRequest.tools, undefined)
    const modelAudit = (await page!.evaluate((id) => window.api.mods.audit(id), threadId)).find(
      (row) => row.toolId === "model.complete"
    )!
    assert.equal(modelAudit.status, "succeeded")
    assert.deepEqual(modelAudit.modelUsage, {
      modelRef: "custom:mods-model-fixture",
      outputTokenLimit: 512,
      inputTokens: 12,
      outputTokens: 3
    })
    await page!.screenshot({ path: join(artifacts, "function-model.png") })
    pass(
      "function model SDK uses production settings and HTTP client, excludes history/tools, protects text and accounts provider usage"
    )
    await functionComposer.fill("/claw-ask [stall]")
    await functionComposer.press("Enter")
    await until(async () => modelServer!.requests.length === 2, "stalled model reaches the server")
    const modelJob = (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).find(
      (job) => job.command === "claw-ask" && job.state === "running"
    )!
    assert.ok(modelJob)
    await page!.evaluate(({ id, job }) => window.api.mods.cancelJob(id, job), {
      id: threadId,
      job: modelJob.id
    })
    await until(
      async () => modelServer!.closedStalls() === 1,
      "cancellation closes real HTTP stream"
    )
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).find(
          (job) => job.id === modelJob.id
        )?.state === "unknown",
      "cancelled started model is not falsely marked unexecuted"
    )
    assert.equal(modelServer.requests.length, 2)
    pass(
      "cancelling a function model command closes its provider stream and preserves uncertain execution without retry"
    )
    const modelToolsThread = await page!.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Function model tools",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Function model tools", { exact: true }).first().click()
    await functionComposer.fill("/claw-tool-hooks on")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), modelToolsThread)).some(
          (job) => job.command === "claw-tool-hooks" && job.state === "succeeded"
        ),
      "enable model tool hooks"
    )
    await functionComposer.fill("[mods-tool-rewrite] 请读取 claw-notes。")
    await functionComposer.press("Enter")
    await page!.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).first().waitFor({ timeout: 30000 })
    const toolModelRequests = modelServer.requests.filter((request) => Array.isArray(request.tools))
    const afterRead = toolModelRequests.find((request) => request.messages.at(-1)?.role === "tool")
    assert.ok(afterRead, "agent sends a second model request after the actual tool")
    writeFileSync(
      join(artifacts, "function-model-tool-protocol.json"),
      JSON.stringify(
        afterRead.messages.map((message) => ({
          role: message.role,
          contentKind: typeof message.content,
          hasReminder: JSON.stringify(message.content).includes("本轮读取已通过自定义 Claw 检查。"),
          hasFileContents: JSON.stringify(message.content).includes("COLD SDK body")
        })),
        null,
        2
      )
    )
    assert.ok(
      afterRead.messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content).includes("本轮读取已通过自定义 Claw 检查。")
      )
    )
    assert.ok(
      afterRead.messages.some(
        (message) =>
          message.role === "tool" && JSON.stringify(message.content).includes("COLD SDK body")
      )
    )
    assert.equal(
      await page!.getByText("本轮读取已通过自定义 Claw 检查。", { exact: true }).count(),
      0
    )
    const modelToolsAudit = await page!.evaluate(
      (id) => window.api.mods.audit(id),
      modelToolsThread
    )
    assert.ok(
      modelToolsAudit.some(
        (row) =>
          row.identity?.threadId === modelToolsThread &&
          row.identity?.toolCallId === "mods-model-read" &&
          row.toolId === "host:read_file" &&
          row.status === "succeeded"
      )
    )
    await page!.screenshot({ path: join(artifacts, "function-model-tool.png") })
    pass(
      "normal agent HTTP tool call enters function hooks, rewrites the real read and receives hidden context"
    )
    await functionComposer.fill("[mods-tool-deny] 请读取 claw-blocked。")
    await functionComposer.press("Enter")
    await page!
      .getByText("MODEL_TOOL_DENIED_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 })
    const afterDeny = modelServer.requests.find(
      (request) =>
        Array.isArray(request.tools) &&
        request.messages.at(-1)?.role === "tool" &&
        JSON.stringify(request.messages.at(-1)?.content).includes("此路径已被 Claw Mod 拒绝读取。")
    )
    assert.ok(afterDeny)
    const deniedAudit = await page!.evaluate((id) => window.api.mods.audit(id), modelToolsThread)
    assert.equal(
      deniedAudit.filter((row) => row.identity?.toolCallId === "mods-model-deny").length,
      0
    )
    pass("model tool denial becomes a tool error with zero native executions")
    const registryThread = await page!.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Registered tools",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Registered tools", { exact: true }).first().click()
    const mcpConnector = await app.evaluate(
      (_electron, input) =>
        (
          globalThis as unknown as {
            modsFixture: {
              startFunctionMcpFixture(
                workspace: string,
                node: string,
                server: string
              ): Promise<string>
            }
          }
        ).modsFixture.startFunctionMcpFixture(input.workspace, input.node, input.server),
      { workspace, node: process.execPath, server: join(root, "tests/support/mods-mcp-server.mjs") }
    )
    try {
      const requestsBeforeMcp = modelServer.requests.length
      const approvalsBeforeMcp = await app.evaluate(
        () => (globalThis as unknown as { modsConfirmations: unknown[] }).modsConfirmations.length
      )
      await functionComposer.fill(
        '/claw-mcp {"server":"Mods SDK fixture","tool":"mods_echo","args":{}}'
      )
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
            (job) =>
              job.command === "claw-mcp" &&
              job.state === "succeeded" &&
              job.result?.text.includes("structuredContent")
          ),
        "cold command calls real MCP without a model"
      )
      assert.equal(modelServer.requests.length, requestsBeforeMcp)
      assert.equal(readFileSync(join(workspace, "mcp-sdk-counter.txt"), "utf8"), "echo\n")
      const sdkJob = (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).find(
        (job) => job.command === "claw-mcp"
      )!
      const sdkResult = JSON.parse(sdkJob.result!.text)
      assert.equal(sdkResult.isError, false)
      assert.equal(sdkResult.content[0].type, "text")
      assert.ok(sdkResult.structuredContent)
      assert.doesNotMatch(JSON.stringify(sdkJob), /sk-mcp-fixture/)
      const approvals = await app.evaluate(
        () =>
          (
            globalThis as unknown as {
              modsConfirmations: Array<{ message: string; detail: string }>
            }
          ).modsConfirmations
      )
      assert(
        approvals
          .slice(approvalsBeforeMcp)
          .some((c) => c.message.includes("function:function-commands"))
      )
      const sdkAudit = (
        await page!.evaluate((id) => window.api.mods.audit(id), registryThread)
      ).filter((row) => row.identity?.threadId === registryThread && row.toolId.startsWith("mcp:"))
      assert.equal(sdkAudit.length, 1)
      assert.equal(sdkAudit[0].status, "succeeded")
      assert.equal(sdkAudit[0].publication, "published")
      assert.match(sdkAudit[0].identity!.turnId, /^function-mcp:/)
      assert.doesNotMatch(await page!.locator("body").innerText(), /sk-mcp-fixture/)
      await page!.screenshot({ path: join(artifacts, "function-mcp-sdk.png") })
      pass(
        "cold UI command uses real MCP stdio, final approval, protected raw blocks and one receipt without model traffic"
      )
      await functionComposer.fill('/claw-mcp {"server":"Mods SDK fixture","tool":"mods_error"}')
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
            (job) =>
              job.command === "claw-mcp" &&
              job.state === "succeeded" &&
              job.result?.text.includes('"isError":true')
          ),
        "MCP protocol errors retain failed status"
      )
      assert.equal(readFileSync(join(workspace, "mcp-sdk-counter.txt"), "utf8"), "echo\nerror\n")
      const failedMcp = (
        await page!.evaluate((id) => window.api.mods.audit(id), registryThread)
      ).find(
        (row) => row.identity?.threadId === registryThread && row.toolId.endsWith("mods_error")
      )
      assert.ok(failedMcp)
      assert.equal(failedMcp.status, "failed")
      assert.equal(failedMcp.publication, "published")
      assert.doesNotMatch(await page!.locator("body").innerText(), /sk-mcp-fixture/)
      assert.equal(modelServer.requests.length, requestsBeforeMcp)
      pass(
        "MCP error result and resource block remain policy-protected with a failed execution receipt"
      )
      await functionComposer.fill("/foundation-mcp ")
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
            (job) =>
              job.command === "foundation-mcp" &&
              job.state === "succeeded" &&
              job.result?.text.includes("structuredContent")
          ),
        "registered tool calls MCP in a cold command"
      )
      const nestedAudit = await page!.evaluate((id) => window.api.mods.audit(id), registryThread)
      const nestedParent = nestedAudit.find(
        (row) =>
          row.identity?.threadId === registryThread &&
          row.toolId === "function:mcp__host-foundation__probe" &&
          row.identity?.origin === "mod"
      )!
      assert.ok(nestedParent)
      const nestedChildren = nestedAudit.filter(
        (row) => row.identity?.parentCallId === nestedParent.identity!.callId
      )!
      assert.equal(nestedChildren.length, 2)
      for (const child of nestedChildren) {
        assert.equal(child.identity!.turnId, nestedParent.identity!.turnId)
        assert.equal(child.identity!.modId, "function:host-foundation")
        assert.equal(child.publication, "published")
        assert.equal(child.status, "succeeded")
      }
      assert.equal(
        readFileSync(join(workspace, "mcp-sdk-counter.txt"), "utf8"),
        "echo\nerror\necho\necho\n"
      )
      assert.equal(modelServer.requests.length, requestsBeforeMcp)
      pass(
        "cold command to registered tool to MCP retains the real parent turn, owner and execution receipt"
      )
      await functionComposer.fill(
        '/claw-mcp {"server":"Mods SDK fixture","tool":"mods_route","args":{"text":"named"}}'
      )
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
            (job) =>
              job.command === "claw-mcp" &&
              job.state === "succeeded" &&
              job.result?.text.includes("named:function-commands:rewritten")
          ),
        "named MCP SDK enters tool hooks and permits a nested native read"
      )
      await functionComposer.fill("/foundation-mcp-direct ")
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
            (job) =>
              job.command === "foundation-mcp-direct" &&
              job.state === "succeeded" &&
              job.result?.text.includes("direct:host-foundation:rewritten")
          ),
        "direct MCP tool call uses the same hook and scoped name"
      )
      const directJob = (
        await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)
      ).find((job) => job.command === "foundation-mcp-direct")!
      const directResult = JSON.parse(directJob.result!.text)
      assert.equal(directResult.permission.decision, "ask")
      assert.ok(Array.isArray(directResult.answer.result))
      assert.doesNotMatch(directJob.result!.text, /sk-mcp-fixture/)
      const beforeRouteDeny = readFileSync(join(workspace, "mcp-sdk-counter.txt"), "utf8")
      assert.equal(
        beforeRouteDeny,
        "echo\nerror\necho\necho\nroute:named:function-commands:rewritten\nroute:direct:host-foundation:rewritten\n"
      )
      await functionComposer.fill(
        '/claw-mcp {"server":"Mods SDK fixture","tool":"mods_route","args":{"text":"deny"}}'
      )
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
            (job) =>
              job.command === "claw-mcp" &&
              job.state === "succeeded" &&
              job.result?.text.includes("MCP route fixture denied")
          ),
        "tool-hook denial rejects the named MCP SDK promise"
      )
      assert.equal(readFileSync(join(workspace, "mcp-sdk-counter.txt"), "utf8"), beforeRouteDeny)
      assert.equal(modelServer.requests.length, requestsBeforeMcp)
      pass(
        "named and direct MCP SDK calls share tool hooks, final arguments, scoped permission and nested native reads without a model"
      )
      await app.evaluate(({ dialog }, id) => {
        const original = dialog.showMessageBox
        dialog.showMessageBox = (async (...args: unknown[]) => {
          dialog.showMessageBox = original
          const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args)
          ;(
            globalThis as unknown as {
              modsFixture: { removeFunctionMcpConfiguration(id: string): void }
            }
          ).modsFixture.removeFunctionMcpConfiguration(id)
          return result
        }) as typeof dialog.showMessageBox
      }, mcpConnector)
      await functionComposer.fill('/claw-mcp {"server":"Mods SDK fixture","tool":"mods_echo"}')
      await functionComposer.press("Enter")
      await until(
        async () =>
          (await page!.evaluate((id) => window.api.mods.audit(id), registryThread)).some(
            (row) =>
              row.identity?.threadId === registryThread &&
              row.toolId.startsWith("mcp:") &&
              row.publication === "blocked"
          ),
        "connection settings changed during approval block transport"
      )
      assert.equal(readFileSync(join(workspace, "mcp-sdk-counter.txt"), "utf8"), beforeRouteDeny)
      assert.equal(modelServer.requests.length, requestsBeforeMcp)
      pass(
        "deleting MCP configuration during real approval cannot reuse a cached connection or repeat a side effect"
      )
    } finally {
      await app.evaluate(
        (_electron, id) =>
          (
            globalThis as unknown as {
              modsFixture: { stopFunctionMcpFixture(id: string): Promise<void> }
            }
          ).modsFixture.stopFunctionMcpFixture(id),
        mcpConnector
      )
    }
    await functionComposer.fill("[mods-registered] 请调用自定义工具查看项目概览。")
    await functionComposer.press("Enter")
    await page!.getByText("REGISTERED_TOOL_OK", { exact: true }).first().waitFor({ timeout: 30000 })
    const registryRequests = modelServer.requests.filter((request) =>
      JSON.stringify(request.messages).includes("[mods-registered]")
    )
    const advertised = (
      registryRequests[0].tools as Array<{ function: { name: string; parameters: unknown } }>
    ).find((tool) => tool.function.name === "mcp__function-commands__project_brief")
    assert.ok(advertised, "registered tool is in the first real provider request")
    assert.deepEqual(advertised.function.parameters, {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      additionalProperties: false
    })
    const registryResult = registryRequests.find(
      (request) => request.messages.at(-1)?.role === "tool"
    )
    assert.ok(registryResult)
    assert.match(JSON.stringify(registryResult.messages.at(-1)?.content), /files/)
    assert.ok(
      registryResult.messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content).includes("项目概览来自当前项目目录")
      )
    )
    const registryAudit = await page!.evaluate((id) => window.api.mods.audit(id), registryThread)
    assert.ok(
      registryAudit.some(
        (row) =>
          row.identity?.toolCallId === "registered-model" &&
          row.toolId === "function:mcp__function-commands__project_brief" &&
          row.status === "succeeded" &&
          row.publication === "published"
      )
    )
    assert.notEqual(
      registryAudit.find((row) => row.identity?.toolCallId === "registered-model")?.identity
        ?.turnId,
      `function-tool:${registryThread}`,
      "model tool receipt retains the host turn for the durable turn summary"
    )
    await page!.screenshot({ path: join(artifacts, "function-registered-tool.png") })
    pass(
      "cold model prompt advertises custom schema, executes the registered tool and records protected publication"
    )
    await functionComposer.fill("/claw-tools ")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
          (job) =>
            job.command === "claw-tools" &&
            job.state === "succeeded" &&
            job.result?.text.includes("mcp__function-commands__project_brief") &&
            job.result.text.includes("read_file")
        ),
      "SDK lists actual model tools and custom tools"
    )
    await functionComposer.fill("/claw-brief ")
    await functionComposer.press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), registryThread)).some(
          (job) =>
            job.command === "claw-brief" &&
            job.state === "succeeded" &&
            job.result?.text.includes("files")
        ),
      "command calls the same registered tool"
    )
    pass(
      "SDK discovers native and custom model tools and calls a registered tool from a direct command"
    )
    await functionComposer.fill("[mods-registered-invalid] 请测试错误参数。")
    await functionComposer.press("Enter")
    await page!
      .getByText("REGISTERED_TOOL_INVALID_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 })
    const invalidRegistry = modelServer.requests.find(
      (request) =>
        JSON.stringify(request.messages).includes("[mods-registered-invalid]") &&
        request.messages.at(-1)?.role === "tool"
    )
    assert.match(
      JSON.stringify(invalidRegistry?.messages.at(-1)?.content),
      /MODS_REGISTERED_TOOL_INPUT/
    )
    assert.equal(
      (await page!.evaluate((id) => window.api.mods.audit(id), registryThread)).filter(
        (row) => row.identity?.toolCallId === "registered-invalid"
      ).length,
      0
    )
    pass("model schema violations produce tool errors before the custom handler executes")
    await functionComposer.fill("[mods-registered-denied] 请验证注册工具的权限拒绝。")
    await functionComposer.press("Enter")
    await page!
      .getByText("REGISTERED_PERMISSION_DENIED_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 })
    const deniedRegistered = modelServer.requests.find(
      (request) =>
        JSON.stringify(request.messages).includes("[mods-registered-denied]") &&
        request.messages.at(-1)?.role === "tool"
    )
    assert(deniedRegistered)
    assert.match(
      JSON.stringify(deniedRegistered.messages.at(-1)?.content),
      /Permission fixture rejected registered tool/
    )
    assert.doesNotMatch(JSON.stringify(deniedRegistered), /sk-permission-fixture/)
    assert(
      !(await page!.evaluate((id) => window.api.mods.audit(id), registryThread)).some(
        (row) => row.identity?.toolCallId === "registered-denied"
      )
    )
    pass(
      "registered permission rejection becomes a protected model tool error with no guest execution receipt"
    )
    const beforeFoundation = modelServer.requests.length
    await functionComposer.fill("[mods-foundation] 请读取项目备注并用自定义工具总结。")
    await functionComposer.press("Enter")
    await page!.getByText("HOST_FOUNDATION_OK", { exact: true }).first().waitFor({ timeout: 30000 })
    const foundationRequests = modelServer.requests.slice(beforeFoundation)
    const nestedCompletion = foundationRequests.find((request) => !Array.isArray(request.tools))!
    assert.ok(nestedCompletion, "registered guest calls the real configured model client")
    assert.match(JSON.stringify(nestedCompletion.messages), /REDACTED/)
    assert.doesNotMatch(JSON.stringify(foundationRequests), /sk-private-fixture/)
    const foundationAudit = await page!.evaluate((id) => window.api.mods.audit(id), registryThread)
    const foundationParent = foundationAudit.find(
      (row) => row.identity?.toolCallId === "foundation-model"
    )!
    assert.ok(foundationParent?.identity)
    const children = foundationAudit.filter(
      (row) => row.identity?.parentCallId === foundationParent.identity!.callId
    )
    assert.deepEqual(children.map((row) => row.toolId).sort(), ["host:read_file", "model.complete"])
    for (const row of [foundationParent, ...children]) {
      assert.equal(row.status, "succeeded")
      assert.equal(row.publication, "published")
      assert.equal(row.identity?.turnId, foundationParent.identity.turnId)
      assert.equal(row.identity?.agentId, "main")
    }
    assert.equal(
      children.find((row) => row.toolId === "model.complete")?.modelUsage?.outputTokenLimit,
      64
    )
    assert.doesNotMatch(
      await page!.locator("body").innerText(),
      /sk-private-fixture/,
      "nested provider tokens must never bypass protection through the parent agent stream"
    )
    const foundationMessages = await page!.evaluate(
      (id) => window.api.threads.getMessages(id),
      registryThread
    )
    assert.doesNotMatch(
      JSON.stringify(foundationMessages),
      /sk-private-fixture/,
      "nested provider tokens must not enter persisted conversation messages"
    )
    await page!.screenshot({ path: join(artifacts, "function-host-foundation.png") })
    pass(
      "registered tool, native SDK read and model completion share the real turn and parent receipts across utilityProcess"
    )
    const beforeChild = modelServer.requests.length
    await functionComposer.fill("[mods-child] 请通过 Explore 子代理调用注册工具。")
    await functionComposer.press("Enter")
    await page!.getByText("MODS_CHILD_OK", { exact: true }).first().waitFor({ timeout: 30000 })
    const childRequests = modelServer.requests.slice(beforeChild)
    writeFileSync(
      join(artifacts, "function-child-protocol.json"),
      JSON.stringify(childRequests, null, 2)
    )
    const childReply = childRequests.find(
      (request) =>
        request.messages.at(-1)?.role === "tool" &&
        String(request.messages.at(-1)?.content).includes('"agentId":"mods-child-task"')
    )
    assert.ok(childReply, "real child model receives its registered-tool result")
    const childValue = JSON.parse(String(childReply.messages.at(-1)!.content))
    assert.equal(childValue.agentId, "mods-child-task")
    assert.equal(resolve(childValue.cwd).toLowerCase(), resolve(workspace).toLowerCase())
    assert.match(childValue.file, /REDACTED/)
    assert.match(childValue.native.text, /REDACTED/)
    assert.equal(childValue.readPermission.decision, "allow")
    assert.equal(childValue.writePermission.decision, "deny")
    assert(
      !childValue.tools.some((tool: { name: string }) =>
        ["write_file", "edit_file"].includes(tool.name)
      )
    )
    assert(
      childValue.tools.some((tool: { name: string }) => tool.name === "mcp__host-foundation__probe")
    )
    const childAudit = await page!.evaluate((id) => window.api.mods.audit(id), registryThread)
    const taskReceipt = childAudit.find((row) => row.identity?.toolCallId === "mods-child-task")!
    const registeredReceipt = childAudit.find(
      (row) => row.identity?.toolCallId === "mods-child-inspect"
    )!
    assert.ok(taskReceipt?.identity && registeredReceipt?.identity)
    assert.equal(registeredReceipt.identity.agentId, "mods-child-task")
    assert.equal(registeredReceipt.identity.parentCallId, taskReceipt.identity.callId)
    const sdkReceipts = childAudit.filter(
      (row) => row.identity?.parentCallId === registeredReceipt.identity!.callId
    )
    assert.equal(sdkReceipts.length, 1)
    assert.equal(sdkReceipts[0].toolId, "host:read_file")
    for (const row of [registeredReceipt, ...sdkReceipts]) {
      assert.equal(row.identity?.agentId, "mods-child-task")
      assert.equal(row.identity?.turnId, taskReceipt.identity.turnId)
      assert.equal(row.status, "succeeded")
      assert.equal(row.publication, "published")
    }
    assert.doesNotMatch(JSON.stringify(childRequests), /sk-private-fixture/)
    assert.doesNotMatch(await page!.locator("body").innerText(), /sk-private-fixture/)
    assert(!existsSync(join(workspace, "blocked.txt")))
    await page!.screenshot({ path: join(artifacts, "function-child-authority.png") })
    pass(
      "real Explore task uses scoped registered tools and file SDK across utilityProcess with protected parent/child receipts"
    )
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    for (const path of ["secret.txt", "../outside.txt"]) {
      await functionComposer.fill(`/claw-files ${path}`)
      await functionComposer.press("Enter")
      await until(async () => {
        const jobs = await page!.evaluate((id) => window.api.mods.jobs(id), threadId)
        if (path === "secret.txt")
          return jobs.some(
            (job) =>
              job.command === "claw-files" &&
              job.state === "succeeded" &&
              job.result?.text.includes("[REDACTED]") === true &&
              !job.result.text.includes("sk-private-fixture")
          )
        return jobs.some(
          (job) =>
            job.command === "claw-files" &&
            job.state === "failed" &&
            job.error === "MODS_FS_OUTSIDE_PROJECT"
        )
      }, "function file reads protect content and reject project escape")
    }
    await page!
      .getByText("无法读取项目目录之外的文件。请使用本项目内的路径。", { exact: true })
      .waitFor()
    await page!.screenshot({ path: join(artifacts, "function-files.png") })
    pass("function file command reads the real project through protection and refuses traversal")
    await functionComposer.fill("/claw-board ")
    await functionComposer.press("Enter")
    const board = page!.locator('[data-function-pane="claw-board"]')
    await board.waitFor({ state: "visible" })
    await board.getByText("点击次数：0", { exact: true }).waitFor()
    const oldPane = (await page!.evaluate((id) => window.api.mods.panes(id), threadId))[0]
    for (const count of [1, 2]) {
      await board.getByRole("button", { name: "加一", exact: true }).click()
      await board.getByText(`点击次数：${count}`, { exact: true }).waitFor()
    }
    await board.getByRole("textbox", { name: "项目备注", exact: true }).fill("这是保存到项目的偏好")
    await board.getByRole("button", { name: "保存备注", exact: true }).click()
    await board.getByText("备注：这是保存到项目的偏好 · 视图：检视", { exact: true }).waitFor()
    await board.getByRole("combobox", { name: "面板视图", exact: true }).selectOption("build")
    await board.getByText("备注：这是保存到项目的偏好 · 视图：构建", { exact: true }).waitFor()
    const jobsBeforeButton = new Set(
      (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).map((job) => job.id)
    )
    await board.getByRole("button", { name: "查看项目文件", exact: true }).click()
    await until(async () => {
      const jobs = await page!.evaluate((id) => window.api.mods.jobs(id), threadId)
      return jobs.some(
        (job) =>
          !jobsBeforeButton.has(job.id) && job.command === "claw-files" && job.state === "succeeded"
      )
    }, "pane button uses the physical command queue")
    await board.getByText(/secret\.txt/).waitFor()
    pass("pane callback launches a real command through the shared queue and renders its result")
    assert.equal(
      await page!.evaluate(
        async ({ id, pane }) => {
          try {
            await window.api.mods.paneAct(id, {
              pane: pane.key,
              generation: pane.generation,
              intentId: crypto.randomUUID(),
              plugin: pane.plugin,
              handle: 0,
              kind: "close"
            })
            return false
          } catch {
            return true
          }
        },
        { id: threadId, pane: oldPane }
      ),
      true
    )
    await board.scrollIntoViewIfNeeded()
    await page!.screenshot({ path: join(artifacts, "function-pane.png") })
    await board.getByRole("button", { name: "关闭 我的 Claw", exact: true }).click()
    await board.waitFor({ state: "detached" })
    await functionComposer.fill("/claw-client ")
    await functionComposer.press("Enter")
    const clientPane = page!.locator('[data-function-pane="claw-client"]')
    const clientRegion = clientPane.locator('[data-function-client="workbench"]')
    await clientRegion.getByText(/本地计数：0/).waitFor()
    await clientRegion.getByRole("button", { name: "本地加一", exact: true }).click()
    await clientRegion.getByText(/宿主已收到点击.*本地计数：1/).waitFor()
    await clientRegion.getByRole("button", { name: "重绘面板", exact: true }).click()
    await clientRegion.getByText(/交互组件.*本地计数：1/).waitFor()
    await clientRegion
      .getByRole("textbox", { name: "组件备注", exact: true })
      .fill("Client 本地状态")
    await clientRegion.getByRole("button", { name: "确认", exact: true }).click()
    await clientRegion
      .getByRole("combobox", { name: "组件模式", exact: true })
      .selectOption("build")
    await clientRegion.getByText("备注：Client 本地状态 · 模式：构建", { exact: true }).waitFor()
    await clientRegion.focus()
    await clientRegion.press("ArrowUp")
    await clientRegion.getByText(/本地计数：2/).waitFor()
    await clientRegion.getByText(/时钟：[1-9].*尺寸：[1-9]/).waitFor()
    await clientRegion.press("Escape")
    assert.equal(await clientRegion.evaluate((el) => document.activeElement === el), false)
    const clientSnapshot = (await page!.evaluate((id) => window.api.mods.panes(id), threadId)).find(
      (p) => p.id === "claw-client"
    )!.clients![0]
    await page!.screenshot({ path: join(artifacts, "function-client.png") })
    await clientPane.getByRole("button", { name: "关闭 Claw 交互工作台", exact: true }).click()
    await clientPane.waitFor({ state: "detached" })
    assert.equal(
      await page!.evaluate(
        async ({ threadId, client }) => {
          try {
            await window.api.mods.clientAct(threadId, {
              pane: "function-commands:claw-client",
              instance: client.id,
              intentId: crypto.randomUUID(),
              kind: "key",
              value: { key: "up" }
            })
            return false
          } catch {
            return true
          }
        },
        { threadId, client: clientSnapshot }
      ),
      true
    )
    pass(
      "isolated Client renders real controls, persists state across parent redraw, posts to hooks, measures and ticks, then rejects unmounted input"
    )
    await functionComposer.fill("/claw-board ")
    await functionComposer.press("Enter")
    await board.getByText("点击次数：2", { exact: true }).waitFor()
    pass(
      "TSX pane presses, input, selection, close/reopen and stale drawing rejection work through production React and IPC"
    )
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    await page!
      .locator('[data-function-pane="claw-board"]')
      .getByText("点击次数：2", { exact: true })
      .waitFor()
    await page!.locator("textarea.composer-textarea").fill("/claw-info 重载后")
    await page!.locator("textarea.composer-textarea").press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) =>
            job.command === "claw-info" &&
            job.state === "succeeded" &&
            job.result?.text.includes("本次会话查询：3") === true
        ),
      "renderer reload keeps function session state"
    )
    await app.close()
    page = undefined
    app = await _electron.launch({
      executablePath: join(root, "tests/support/electron-launcher.cmd"),
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    await app.firstWindow()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
    })
    await until(async () => {
      for (const candidate of app!.windows())
        if (await candidate.evaluate(() => Boolean(window.api?.mods)).catch(() => false)) {
          page = candidate
          return true
        }
      return false
    }, "production preload after process restart")
    await page!.addInitScript("window.__name = value => value")
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    assert.equal(
      await page!.evaluate(
        async ({ id, descriptor }) => {
          try {
            await window.api.mods.enqueue(id, descriptor, { text: "old runtime" })
            return false
          } catch {
            return true
          }
        },
        { id: threadId, descriptor: functionCommand }
      ),
      true
    )
    await page!.locator("textarea.composer-textarea").fill("/claw")
    await page!.getByText("claw-info", { exact: true }).first().waitFor()
    await page!.locator("textarea.composer-textarea").fill("/claw-info ")
    await page!.locator("textarea.composer-textarea").press("Enter")
    await until(
      async () =>
        (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) =>
            job.command === "claw-info" &&
            job.state === "succeeded" &&
            job.result?.text.includes("本次会话查询：1") === true &&
            job.result.text.includes("备注：重载后")
        ),
      "process restart recreates closure state but preserves the plugin preference"
    )
    await page!.screenshot({ path: join(artifacts, "function-restart.png") })
    pass(
      "application restart retains plugin preferences and grants while invalidating old runtime descriptors"
    )
    await page!.locator("textarea.composer-textarea").fill("/claw-board ")
    await page!.locator("textarea.composer-textarea").press("Enter")
    await page!
      .locator('[data-function-pane="claw-board"]')
      .getByText("点击次数：2", { exact: true })
      .waitFor()
    await page!
      .locator('[data-function-pane="claw-board"]')
      .getByText("备注：这是保存到项目的偏好 · 视图：构建", { exact: true })
      .waitFor()
    pass("pane preferences survive renderer reload and complete application restart")
    await page!.getByRole("button", { name: "自定义", exact: true }).click()
    await page!.getByRole("button", { name: "插件", exact: true }).click()
    await page!
      .locator('[data-function-mod-id="function-commands"]')
      .getByRole("button", { name: "撤销权限", exact: true })
      .click()
    await until(
      async () =>
        !(await page!.evaluate((id) => window.api.mods.commands(id), threadId)).some(
          (command) => command.modId === "function:function-commands"
        ),
      "revoked function commands disappear"
    )
    assert(
      (await page!.evaluate((id) => window.api.mods.commands(id), threadId)).some(
        (command) => command.modId === "function:host-foundation"
      ),
      "revoking one plugin preserves another approved plugin's commands"
    )
    await page!.getByRole("button", { name: "返回会话", exact: true }).click()
    await page!.getByText("Registered tools", { exact: true }).first().click()
    await page!
      .locator("textarea.composer-textarea")
      .fill("[mods-registered-removed] 请确认撤权后的工具列表。")
    // Switching a restored thread hydrates history asynchronously. A raw Enter can
    // reach the submit guard before it is ready; click waits for the real control.
    await page!
      .locator("form")
      .filter({ has: page!.locator("textarea.composer-textarea") })
      .locator('button[type="submit"]')
      .click()
    await page!
      .getByText("REGISTERED_TOOL_REMOVED_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 })
    const removedRegistry = modelServer.requests.find((request) =>
      JSON.stringify(request.messages).includes("[mods-registered-removed]")
    )
    assert.ok(removedRegistry)
    assert.equal(
      JSON.stringify(removedRegistry.tools).includes("mcp__function-commands__project_brief"),
      false
    )
    pass("revoking a plugin removes its custom tools from the next production model request")
    assert.equal(
      await page!.evaluate(
        async ({ id, descriptor }) => {
          try {
            await window.api.mods.enqueue(id, descriptor, { text: "stale" })
            return false
          } catch {
            return true
          }
        },
        { id: threadId, descriptor: functionCommand }
      ),
      true
    )
    pass(
      "renderer reload preserves function state; revoking a digest removes commands and rejects stale execution"
    )
    assert.deepEqual(await page!.evaluate((id) => window.api.mods.panes(id), threadId), [])
    console.log(JSON.stringify({ checks, timings, isolated }, null, 2))
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify({ checks, timings, isolated }, null, 2)
    )
    await app?.close()
    await modelServer?.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
