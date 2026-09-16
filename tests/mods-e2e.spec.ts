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
      await page!.screenshot({ path: join(artifacts, "cold-command.png") })
      pass(
        "packaged cold session executes a real approved command and previews its report without a model or test bridge"
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
