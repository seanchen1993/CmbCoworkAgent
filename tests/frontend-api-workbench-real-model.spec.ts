/** Explicit opt-in: actual configured model, native chat tools and disposable source project. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { once } from "node:events"
import { _electron, type ElectronApplication, type Page } from "playwright"
import AdmZip from "adm-zip"
import { startRealModelRelay } from "./support/mods-real-model-relay"

const root = resolve(__dirname, "..")
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]
  )
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
function requireBaseline(value: unknown, label: string): asserts value is Record<string, string> {
  assert(value && typeof value === "object" && !Array.isArray(value), label)
  const entries = Object.entries(value)
  assert(
    entries.length > 0 &&
      entries.every(([, digest]) => typeof digest === "string" && /^[a-f\d]{64}$/i.test(digest)),
    label
  )
}

async function main() {
  if (process.env.CMB_WORKBENCH_REAL_MODEL !== "1")
    throw Error("REAL_MODEL_EXPLICIT_OPT_IN_REQUIRED")
  const output = resolve(
    process.env.CMB_WORKBENCH_REAL_OUTPUT || "output/frontend-api-workbench-real-model"
  )
  mkdirSync(output, { recursive: true })
  const report: Record<string, unknown> = {
    passed: false,
    scope: "Real provider + native Electron + actual workbench submit button"
  }
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let relay: Awaited<ReturnType<typeof startRealModelRelay>> | undefined
  let server: import("node:http").Server | undefined
  let threadId = ""
  let project = ""
  const deadline = Date.now() + 15 * 60_000
  const watchdog = setTimeout(() => {
    void app?.close().catch(() => {})
  }, 15 * 60_000)
  const record = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2))
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      cwd: project,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000
    })
    return { exitCode: result.status, output: (result.stdout + result.stderr).slice(-16000) }
  }
  try {
    const configuration = process.env.CMB_COWORK_AGENT_HOME || join(homedir(), ".cmbcoworkagent")
    const settings = JSON.parse(readFileSync(join(configuration, "settings.json"), "utf8"))
    const modelId =
      process.env.CMB_WORKBENCH_MODEL_ID ||
      String(settings.defaultModel || "").replace(/^custom:/, "")
    const model = JSON.parse(readFileSync(join(configuration, "custom-models.json"), "utf8")).find(
      (entry: { id: string }) => entry.id === modelId
    )
    if (!model) throw Error("CONFIGURED_CUSTOM_MODEL_UNAVAILABLE")
    const keyName =
      "CUSTOM_API_KEY__" + createHash("sha256").update(modelId.trim()).digest("hex").slice(0, 12)
    const entries = readFileSync(join(configuration, ".env"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      })
    const key = Object.fromEntries(entries)[keyName] || process.env[keyName]
    if (!key) throw Error("CONFIGURED_CREDENTIAL_UNAVAILABLE")
    report.model = { id: modelId, model: model.model, protocol: "OpenAI-compatible HTTPS relay" }
    relay = await startRealModelRelay({
      baseUrl: model.baseUrl,
      model: model.model,
      apiKey: key,
      requestLimit: 50
    })
    report.requests = relay.metrics
    const resumeFile = process.env.CMB_WORKBENCH_RESUME_REPORT
    const previous = resumeFile ? JSON.parse(readFileSync(resolve(resumeFile), "utf8")) : undefined
    const isolated: string =
      previous?.isolated || mkdtempSync(join(tmpdir(), "frontend-workbench-model-"))
    assert(
      resolve(isolated).startsWith(resolve(tmpdir()) + sep + "frontend-workbench-model-"),
      "RESUME_MUST_USE_DISPOSABLE_ACCEPTANCE_DIRECTORY"
    )
    project = join(isolated, "workspace")
    if (!previous) cpSync(join(root, "examples/frontend-api-starter"), project, { recursive: true })
    report.isolated = isolated
    if (previous) report.resumedFrom = resolve(resumeFile!)
    const originalProtectedPaths = previous
      ? []
      : files(project).filter((file) => {
          const local = relative(project, file).replaceAll("\\", "/")
          return (
            (!local.startsWith("src/") && !local.startsWith("public/")) ||
            local.startsWith("public/vendor/")
          )
        })
    const protectedBefore: Record<string, string> =
      previous?.protectedBefore ||
      Object.fromEntries(
        originalProtectedPaths.map((file) => [relative(project, file), hash(file)])
      )
    if (previous) {
      requireBaseline(previous.sourceBefore, "RESUME_REQUIRES_ORIGINAL_SOURCE_HASHES")
      requireBaseline(previous.protectedBefore, "RESUME_REQUIRES_ORIGINAL_PROTECTED_HASHES")
    }
    const sourceBefore: Record<string, string> =
      previous?.sourceBefore ||
      Object.fromEntries(
        files(join(project, "src")).map((file) => [relative(project, file), hash(file)])
      )
    for (const file of [...Object.keys(protectedBefore), ...Object.keys(sourceBefore)]) {
      assert(
        !isAbsolute(file) &&
          !file.includes(":") &&
          file.split(/[\\/]/).every((part) => part && part !== "." && part !== ".."),
        "UNSAFE_BASELINE_PATH"
      )
    }
    const protectedPaths = Object.keys(protectedBefore).map((file) => join(project, file))
    report.sourceBefore = sourceBefore
    report.protectedBefore = protectedBefore
    report.initial = previous?.initial || run(["--test", "tests/acceptance.test.mjs"])
    assert.notEqual(
      (report.initial as { exitCode: number }).exitCode,
      0,
      "Starter must need real implementation"
    )
    const createDemoServer = createRequire(join(project, "package.json"))(
      join(project, "server.cjs")
    ).createDemoServer
    server = createDemoServer()
    server!.listen(0, "127.0.0.1")
    await once(server!, "listening")
    const address = server!.address()
    assert(address && typeof address !== "string")
    const url = `http://127.0.0.1:${address.port}`
    report.server = { url, owner: "acceptance harness", cleanup: "finally closes server" }
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value &&
        /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
          name
        )
      )
        env[name] = value
    }
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
    writeFileSync(
      join(env.CMB_COWORK_AGENT_HOME, "browser-cdp-config.json"),
      JSON.stringify({ enabled: true, profileImportEnabled: false })
    )
    const binary = createRequire(join(root, "package.json"))("electron") as string
    Object.assign(env, {
      CMB_E2E_DISABLE_GPU: "1",
      CMB_E2E_ELECTRON_BIN: binary,
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      npm_config_cache: join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"),
        "npm-cache"
      )
    })
    app = await _electron.launch({
      executablePath: join(root, "tests/support/electron-launcher.cmd"),
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    await app.firstWindow()
    // External login is unrelated to this isolated local-model test. No tool/approval handler is replaced.
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    async function until(check: () => Promise<boolean>, label: string, timeout = 60_000) {
      const stop = Math.min(deadline, Date.now() + timeout)
      while (Date.now() < stop) {
        if (await check()) return
        await pause(300)
      }
      throw Error("ACCEPTANCE_TIMEOUT: " + label)
    }
    await until(async () => {
      for (const candidate of app!.windows()) {
        if (await candidate.evaluate(() => Boolean(window.api?.mods)).catch(() => false)) {
          page = candidate
          return true
        }
      }
      return false
    }, "production preload")
    await page!.addInitScript("window.__name = value => value")
    await page!.evaluate("window.__name = value => value")
    await page!.evaluate(
      async ({ relayUrl, modelName, maxTokens, maxOutputTokens }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.models.setCustomConfig({
          id: "workbench-acceptance",
          name: "Current configured model (isolated)",
          baseUrl: relayUrl,
          model: modelName,
          apiKey: "isolated-relay",
          maxTokens,
          maxOutputTokens
        })
        await window.api.models.setDefault("custom:workbench-acceptance")
      },
      {
        relayUrl: relay.url,
        modelName: model.model,
        maxTokens: model.maxTokens || 128000,
        maxOutputTokens: model.maxOutputTokens || 8192
      }
    )
    threadId =
      previous?.threadId ||
      (await page!.evaluate(async (project) => {
        const thread = await window.api.threads.create({
          title: "Frontend implementation acceptance",
          workspacePath: project,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, project)
        await window.api.threads.patchMetadata(thread.thread_id, {
          set: { model: "custom:workbench-acceptance", subagentsEnabled: false }
        })
        await window.api.mods.configure(thread.thread_id, true, true)
        return thread.thread_id
      }, project))
    report.threadId = threadId
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      readFileSync(join(root, "examples/frontend-api-workbench/plugin.json"))
    )
    zip.addLocalFolder(join(root, "examples/frontend-api-workbench/hooks"), "hooks")
    const installed = await page!.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "frontend-api-workbench.zip",
          "local"
        ),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const status = await page!.evaluate((id) => window.api.mods.status(id), threadId)
    const plugin = status.functionMods?.find((item) => item.name === "frontend-api-workbench")
    assert(plugin?.digest, "Installed plugin must be discoverable")
    await page!.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest }
    )
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.getByText("Frontend implementation acceptance", { exact: true }).first().click()
    const chat = page!.locator(`[data-chat-thread-id="${threadId}"]`)
    await chat.getByRole("button", { name: "使用当前目录", exact: true }).click()
    await chat.getByLabel("页面地址", { exact: true }).fill(url + "/")
    await chat.getByLabel("接口文档", { exact: true }).fill(join(project, "docs/api-correct.txt"))
    if (!(await chat.getByLabel("本次需求", { exact: true }).isVisible())) {
      await chat.getByRole("button", { name: /^补充需求(?:（可选）| · 已填写)$/ }).click()
    }
    await chat
      .getByLabel("本次需求", { exact: true })
      .fill(
        "按 TASK.md 完成半成品。服务由验收程序在填写的地址运行，可复用，不要再启动或停止服务。只修改 src 和必要的 public 页面。运行 npm test 和 npm run build，再用内置浏览器验证页面、筛选、翻页、详情、库存与错误状态；发现问题继续修复复测。不可改契约、测试或后端。命令尽量直接使用 npm test、npm run build，当前目录就是项目。"
      )
    await page!.screenshot({ path: join(output, "before-submit.png") })
    await chat.getByRole("button", { name: "补齐代码并联调", exact: true }).click()
    report.submittedVia = "real ChatHeader button"
    record()
    await until(async () => relay!.metrics.length > 0, "real provider receives prompt")
    let settled = 0
    let pendingManual = ""
    let lastCheckpoint = 0
    const approvals: Array<{ kind: string; target: string }> = []
    report.approvals = approvals
    await until(
      async () => {
        // Approve only task-scoped source edits and the existing immutable check scripts.
        const allow = chat.getByRole("button", { name: "允许", exact: true })
        if (await allow.count()) {
          const text = await allow.first().locator("../..").innerText()
          const target = /^(?:写入|编辑): (.+)$/m.exec(text)?.[1]
          const resolved = target ? resolve(project, target) : ""
          const local = relative(project, resolved)
          assert(
            resolved && !local.startsWith("..") && !local.includes(":"),
            "SOURCE_APPROVAL_OUTSIDE_PROJECT"
          )
          assert(
            local.startsWith("src" + sep) ||
              (local.startsWith("public" + sep) &&
                !local.startsWith("public" + sep + "vendor" + sep)),
            "SOURCE_APPROVAL_OUTSIDE_WRITABLE_AREA"
          )
          approvals.push({ kind: "file", target: local })
          const clicked = await allow.first().evaluate((node, expected) => {
            const text = node.parentElement!.parentElement!.innerText
            if (/^(?:写入|编辑): (.+)$/m.exec(text)?.[1] !== expected) return false
            ;(node as HTMLButtonElement).click()
            return true
          }, target)
          if (!clicked) return false
        }
        const execute = chat.getByRole("button", { name: "运行", exact: true })
        if (await execute.count()) {
          const command = (await execute.first().locator("../..").locator("pre").innerText()).trim()
          report.pendingCommand = command
          const knownSegments = new Set([
            "pwd",
            "ls -la",
            "git status --short",
            "git status --porcelain",
            "git status --short 2>&1 | head -20",
            "git diff -- src public",
            "node --version",
            "npm --version",
            `curl -s -m 3 ${url}/health`,
            "echo",
            "npm test",
            "npm run test",
            "npm run build",
            "node --test tests/acceptance.test.mjs",
            "node scripts/build.mjs"
          ])
          // Every segment must exactly match a reviewed command; no wildcards or shell evaluation.
          const segments = command.split(/\s*(?:&&|;|\r?\n)\s*/)
          const prechecked =
            segments.length > 0 && segments.every((segment) => knownSegments.has(segment))
          const manualFile = join(output, "reviewed-commands.json")
          const reviewed: unknown = existsSync(manualFile)
            ? JSON.parse(readFileSync(manualFile, "utf8"))
            : []
          const manual = Array.isArray(reviewed) && reviewed.includes(command)
          if (!prechecked && !manual) {
            if (pendingManual !== command) {
              pendingManual = command
              writeFileSync(
                join(output, "pending-command.json"),
                JSON.stringify({ command, project, url }, null, 2)
              )
              record()
              console.log("PENDING_COMMAND_REVIEW: " + command)
            }
            settled = 0
            return false
          }
          approvals.push({ kind: "command", target: command })
          const clicked = await execute.first().evaluate((node, expected) => {
            const text = node.parentElement!.parentElement!.querySelector("pre")?.innerText.trim()
            if (text !== expected) return false
            ;(node as HTMLButtonElement).click()
            return true
          }, command)
          if (!clicked) return false
          if (pendingManual) {
            pendingManual = ""
            writeFileSync(join(output, "pending-command.json"), "null\n")
          }
        }
        if (Date.now() - lastCheckpoint > 15000) {
          record()
          lastCheckpoint = Date.now()
        }
        if (await chat.getByText("代理出错", { exact: true }).count())
          throw Error("NATIVE_AGENT_ERROR")
        if (await chat.getByRole("button", { name: "无沙箱重试", exact: true }).count())
          throw Error("NATIVE_SANDBOX_RETRY_REQUIRES_REVIEW")
        const active = await chat.getByRole("button", { name: "停止生成", exact: true }).count()
        const receiving = relay!.metrics.some((item) => item.elapsedMs === 0)
        settled = active || receiving ? 0 : settled + 1
        return settled >= 15
      },
      "model implements and verifies",
      12 * 60_000
    )
    const messages = await page!.evaluate((id) => window.api.threads.getMessages(id), threadId)
    const toolCalls = messages.flatMap((message) => message.tool_calls ?? [])
    report.toolCalls = toolCalls.map((call) => ({ name: call.name, id: call.id }))
    writeFileSync(join(output, "transcript.json"), JSON.stringify(messages, null, 2))
    report.finalChecks = run(["--test", "tests/acceptance.test.mjs"])
    report.build = run(["scripts/build.mjs"])
    report.protectedAfter = Object.fromEntries(
      protectedPaths.map((file) => [
        relative(project, file),
        existsSync(file) ? hash(file) : "missing"
      ])
    )
    assert.deepEqual(
      report.protectedAfter,
      protectedBefore,
      "Model must not weaken the backend, contract or tests"
    )
    const changed = Object.entries(sourceBefore)
      .filter(
        ([file, before]) => !existsSync(join(project, file)) || hash(join(project, file)) !== before
      )
      .map(([file]) => file)
    report.changedSource = changed
    assert(changed.length > 0, "Real model must modify source")
    assert.equal(
      (report.finalChecks as { exitCode: number }).exitCode,
      0,
      "Independent source acceptance must pass"
    )
    assert.equal((report.build as { exitCode: number }).exitCode, 0, "Build must pass")
    const browserEvidence = toolCalls
      .filter((call) => /browser_/i.test(call.name))
      .map((call) => {
        const results = messages.filter(
          (message) => message.role === "tool" && message.tool_call_id === call.id
        )
        const successful = results.filter(
          (message) =>
            message.status === "success" &&
            !/^### Error\b/m.test(
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content)
            )
        )
        return {
          name: call.name,
          id: call.id,
          args: call.args,
          successful: successful.length > 0,
          result: successful.map((message) => message.content)
        }
      })
    report.browserEvidence = browserEvidence
    report.modelBrowserVerified =
      browserEvidence.some(
        (call) =>
          call.successful && /browser_navigate$/.test(call.name) && call.args.url === url + "/"
      ) &&
      browserEvidence.some(
        (call) => call.successful && /browser_(click|select_option|type|evaluate)$/.test(call.name)
      )
    report.modelBrowserCoverageRequiresTranscriptReview = true
    assert(
      report.modelBrowserVerified,
      "Model must navigate the actual target and successfully interact"
    )
    clearTimeout(watchdog)
    const independentOutput = join(output, "independent-browser")
    const independent = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/tsx/dist/cli.mjs"),
        join(root, "tests/frontend-api-workbench-completed-source.spec.ts")
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 180000,
        env: {
          ...process.env,
          CMB_WORKBENCH_COMPLETED_PROJECT: project,
          CMB_WORKBENCH_BROWSER_OUTPUT: independentOutput
        }
      }
    )
    report.independentBrowser = {
      exitCode: independent.status,
      output: (independent.stdout + independent.stderr).slice(-12000),
      evidence: independentOutput
    }
    assert.equal(independent.status, 0, "Independent full browser acceptance must pass")
    await page!.screenshot({ path: join(output, "completed-chat.png") })
    report.passed = true
    console.log("PASS real model workbench: source edits, protected acceptance, build and browser")
  } catch (error) {
    report.error =
      error instanceof Error ? error.message.slice(0, 500) : "REAL_MODEL_ACCEPTANCE_FAILED"
    if (page && threadId) {
      const messages = await page
        .evaluate((id) => window.api.threads.getMessages(id), threadId)
        .catch(() => [])
      report.toolCalls = messages
        .flatMap((message) => message.tool_calls ?? [])
        .map((call) => ({ name: call.name, id: call.id }))
      writeFileSync(join(output, "transcript.json"), JSON.stringify(messages, null, 2))
      await page.screenshot({ path: join(output, "blocked.png") }).catch(() => {})
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch(() => {})
    await relay?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((done) => server!.close(() => done()))
    }
    record()
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "REAL_MODEL_ACCEPTANCE_FAILED")
  process.exitCode = 1
})
