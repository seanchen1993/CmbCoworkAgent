/** Real Electron, production IPC/React, SQLite, QuickJS utility process and LocalSandbox.
 * The model producer is replaced by deterministic calls through the real tool ingress.
 * Native confirmation is answered by the test; no external model/API is used.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { _electron, type ElectronApplication, type Page } from "playwright"

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
    await page!.screenshot({ path: join(artifacts, "function-grant.png") })
    await page!.getByRole("button", { name: "返回会话", exact: true }).click()
    await page!.getByText("Mods E2E", { exact: true }).first().click()
    const functionComposer = page!.locator("textarea.composer-textarea")
    await functionComposer.fill("/claw")
    await page!.getByText("claw-info", { exact: true }).first().waitFor()
    const [functionCommand] = (
      await page!.evaluate((id) => window.api.mods.commands(id), threadId)
    ).filter((command) => command.apiVersion === "cmb.mods/v2")
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
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Mods E2E", { exact: true }).first().click()
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
    await page!.getByRole("button", { name: "自定义", exact: true }).click()
    await page!.getByRole("button", { name: "插件", exact: true }).click()
    await page!
      .locator('[data-function-mod-id="function-commands"]')
      .getByRole("button", { name: "撤销权限", exact: true })
      .click()
    await until(
      async () =>
        !(await page!.evaluate((id) => window.api.mods.commands(id), threadId)).some(
          (command) => command.apiVersion === "cmb.mods/v2"
        ),
      "revoked function commands disappear"
    )
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
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
