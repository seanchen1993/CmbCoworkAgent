import { approveBusinessOperation } from "./support/mods-business-approval"
/** Explicit opt-in only. Uses a configured real model and disposable application data. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { _electron, type ElectronApplication, type Page } from "playwright"
import AdmZip from "adm-zip"
import { startRealModelRelay } from "./support/mods-real-model-relay"
import { businessAssertions, createBusinessProject } from "./support/mods-business-project"

const root = resolve(__dirname, "..")
const artifacts = resolve(
  process.env.CMB_MODS_DEMO_ARTIFACTS || "output/mods-v2-validation/2026-09-24-real-business-demo"
)
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
async function main() {
  if (process.env.CMB_MODS_REAL_MODEL_DEMO !== "1")
    throw Error("REAL_MODEL_DEMO_EXPLICIT_OPT_IN_REQUIRED")
  mkdirSync(artifacts, { recursive: true })
  const configurationRoot = process.env.CMB_COWORK_AGENT_HOME || join(homedir(), ".cmbcoworkagent")
  const modelId = process.env.CMB_MODS_DEMO_MODEL_ID || "claude"
  const model = JSON.parse(
    readFileSync(join(configurationRoot, "custom-models.json"), "utf8")
  ).find((entry: { id: string }) => entry.id === modelId)
  if (!model) throw Error("CONFIGURED_MODEL_UNAVAILABLE")
  const keyName =
    "CUSTOM_API_KEY__" + createHash("sha256").update(modelId.trim()).digest("hex").slice(0, 12)
  const entries = readFileSync(join(configurationRoot, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=")
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    })
  const key = Object.fromEntries(entries)[keyName] || process.env[keyName]
  if (!key) throw Error("CONFIGURED_CREDENTIAL_UNAVAILABLE")
  const relay = await startRealModelRelay({
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey: key
  })
  const isolated = mkdtempSync(join(tmpdir(), "cmb-mods-business-"))
  const project = join(isolated, "workspace")
  await createBusinessProject(project)
  const independent = join(artifacts, "independent-business-assertions.cjs")
  writeFileSync(independent, businessAssertions)
  const checkBusiness = () => {
    const result = spawnSync(process.execPath, [independent, project], {
      encoding: "utf8",
      windowsHide: true
    })
    return { exitCode: result.status, output: (result.stdout + result.stderr).slice(0, 16000) }
  }
  const protectedFiles = [
    "requirements.md",
    "business.spec.cjs",
    "package.json",
    ".autobizdevops/features/order-export/specs/orders/spec.md"
  ]
  const protectedHashes = Object.fromEntries(
    protectedFiles.map((file) => [file, hash(join(project, file))])
  )
  const initial = checkBusiness()
  assert.notEqual(initial.exitCode, 0, "seeded business defect must fail actual assertions")
  assert.match(
    initial.output,
    /filter and numeric ordering/,
    "baseline must fail a business assertion, not the runner"
  )
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env))
    if (
      value &&
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
        name
      )
    )
      env[name] = value
  for (const [name, folder] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "data",
    TEMP: "temp",
    TMP: "temp"
  })) {
    env[name] = join(isolated, folder)
    mkdirSync(env[name], { recursive: true })
  }
  const binary = createRequire(join(root, "package.json"))("electron") as string
  Object.assign(env, {
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const report: Record<string, unknown> = {
    modelId,
    isolated,
    initial,
    protectedHashes,
    metrics: relay.metrics,
    passed: false
  }
  async function until(check: () => Promise<boolean>, label: string, timeout = 60_000) {
    const deadline = performance.now() + timeout
    while (performance.now() < deadline) {
      if (page) {
        await approveBusinessOperation(page, project)
        const failure = page.getByText("代理出错", { exact: true })
        if (await failure.count()) {
          report.applicationError = (await page.locator("body").innerText()).slice(-5000)
          throw Error("DEMO_APPLICATION_TERMINAL_ERROR")
        }
      }
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw Error("DEMO_TIMEOUT: " + label)
  }
  const watchdog = setTimeout(() => {
    void app?.close()
  }, 1_200_000)
  try {
    app = await _electron.launch({
      executablePath: join(root, "tests/support/electron-launcher.cmd"),
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    await app.firstWindow()
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
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
    await page!.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    await page!.evaluate(
      async ({ url, modelName }) => {
        await window.api.mods.unlockFunction("admin123456")
        await window.api.mods.configureGlobal(true)
        await window.api.models.setCustomConfig({
          id: "business-demo",
          name: "Real business demo relay",
          baseUrl: url,
          model: modelName,
          apiKey: "isolated-relay-key",
          maxTokens: 128000,
          maxOutputTokens: 8192
        })
        await window.api.models.setDefault("custom:business-demo")
      },
      { url: relay.url, modelName: String(model.model) }
    )
    const threadId = await page!.evaluate(async (project) => {
      const thread = await window.api.threads.create({
        title: "Real order export demo",
        workspacePath: project,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:business-demo", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, project)
    report.threadId = threadId
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "business-review", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./review.ts"] })))
    zip.addFile(
      "hooks/review.ts",
      Buffer.from(`export function register(on) {
      on("completion.check", async ($) => {
        const requirements = await $.fs.read("requirements.md");
        const code = await $.fs.read("order-export.cjs");
        const review = await $.model.complete({model:"custom:business-demo",maxTokens:4096,
          system:"Review code against every requirement. Reply only PASS if correct, otherwise REVISE followed by at most 120 words of concrete defects. Your review is advisory; host tests determine acceptance.",
          prompt: requirements + "\\nCODE:\\n" + code});
        await $.ui.log("MODEL_REVIEW:" + review);
        if (!review.trim()) return {decision:"block",reason:"REAL_REVIEW_EMPTY_OUTPUT"};
        return /^PASS\\b/.test(review.trim()) ? {decision:"pass"} : {decision:"revise",reason:review.slice(0,7900)};
      })
    }`)
    )
    const installed = await page!.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "business-review.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const plugin = (
      await page!.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((p) => p.name === "business-review")!
    assert(plugin?.digest)
    await page!.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest! }
    )
    const configure = (mode: "off" | "repair") =>
      page!.evaluate(
        ({ id, plugin, mode }) =>
          window.api.mods.setCompletionPolicy(id, plugin, {
            mode,
            scope: "project",
            feature: "order-export",
            checks: ["code-review", "unit-test", "autobiz-validator"],
            maxRepairs: 2,
            timeoutMs: 600000,
            modelTokenBudget: 350000,
            autobizStartCheckpoint: "requirements_eval_in_progress"
          }),
        { id: threadId, plugin: plugin.name, mode }
      )
    await configure("off")
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Real order export demo", { exact: true }).first().click()
    const prompt =
      "本消息是订单 CSV 导出任务的提交尝试，不是新的实现指令。现在只回复“申请完成”，不要调用任何工具，也不要主动检查或修复。仅当随后收到宿主明确的 Completion gate requested revision / 完成门禁拒绝反馈，才按 requirements.md 修复 order-export.cjs、运行 npm test，并把逐条需求、代码和真实测试结果写入 .autobizdevops/features/order-export/REQUIREMENTS_EVAL.md，只有满足要求才写 verdict: PASS，然后再次完成。不得改需求、测试、package.json、状态文件或权限设置。"
    report.prompt = prompt
    const records = () => page!.evaluate((id) => window.api.mods.completionEvidence(id), threadId)
    const run = async (gated = false) => {
      const previous = new Set((await records()).map((row) => row.id))
      const before = relay.metrics.length
      await page!.locator("textarea.composer-textarea").fill(prompt)
      await page!
        .locator("form")
        .filter({ has: page!.locator("textarea.composer-textarea") })
        .locator('button[type="submit"]')
        .click()
      await until(async () => relay.metrics.length > before, "real provider receives turn")
      await until(
        async () => {
          if ((await page!.getByRole("button", { name: "停止生成", exact: true }).count()) !== 0)
            return false
          if (!gated) return relay.metrics.slice(before).some((row) => row.elapsedMs > 0)
          const fresh = (await records()).filter((row) => !previous.has(row.id))
          return (
            fresh.some((row) => row.phase === "state.transition" && row.status !== "running") ||
            fresh.some(
              (row) =>
                row.phase === "check.result" && ["block", "error", "cancelled"].includes(row.status)
            )
          )
        },
        "original agent settles",
        600000
      )
    }
    await run()
    report.off = {
      business: checkBusiness(),
      records: await records(),
      requests: relay.metrics.length
    }
    assert.notEqual((report.off as { business: { exitCode: number } }).business.exitCode, 0)
    assert.equal((await records()).length, 0)
    console.log("DEMO off completed with the seeded business defect and no gate")
    await page!.screenshot({ path: join(artifacts, "off.png") })
    await configure("repair")
    await run(true)
    const onRecords = await records()
    report.on = {
      business: checkBusiness(),
      records: onRecords,
      audit: await page!.evaluate((id) => window.api.mods.audit(id), threadId)
    }
    report.protectedAfter = Object.fromEntries(
      protectedFiles.map((file) => [file, hash(join(project, file))])
    )
    assert.deepEqual(
      report.protectedAfter,
      protectedHashes,
      "requirements and tests cannot be weakened"
    )
    assert.equal(
      (report.on as { business: { exitCode: number } }).business.exitCode,
      0,
      "independent business assertions must pass"
    )
    assert(
      onRecords.some((row) => row.phase === "repair.attempt"),
      "actual gate must request a repair"
    )
    assert(
      onRecords.some((row) => row.phase === "state.transition" && row.status === "pass"),
      "real validator and native transition must pass"
    )
    assert.equal(
      JSON.parse(readFileSync(join(project, ".autobizdevops/state.json"), "utf8")).features[
        "order-export"
      ].checkpoint,
      "requirements_eval_done"
    )
    const rail = page!.locator("[data-completion-evidence]")
    if ((await rail.count()) && !(await rail.getAttribute("open")))
      await rail.locator(":scope > summary").click()
    await page!.screenshot({ path: join(artifacts, "on.png") })
    report.passed = true
    console.log("DEMO real model repair, independent assertions and native checkpoint passed")
  } catch (error) {
    if (page && typeof report.threadId === "string")
      report.failureEvidence = await page
        .evaluate((id) => window.api.mods.completionEvidence(id), report.threadId)
        .catch(() => [])
    report.failureBusiness = checkBusiness()
    report.error = error instanceof Error ? error.message.slice(0, 500) : "DEMO_FAILED"
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch(() => {})
    await relay.close()
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(report, null, 2))
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "DEMO_FAILED")
  process.exitCode = 1
})
