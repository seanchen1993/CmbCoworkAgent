/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Electron transport fixture. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment, compositionPlugin } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR, "Reviewed packaged directory required")
assert(process.env.EXPECTED_ASAR_SHA256, "Reviewed EXPECTED_ASAR_SHA256 required")
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const asar = join(resolve(process.env.CMB_MODS_PACKAGED_DIR), "resources/app.asar")
const asarSha256 = hash(readFileSync(asar))
assert.equal(asarSha256, process.env.EXPECTED_ASAR_SHA256)
const artifacts = resolve(
  process.env.CMB_NATIVE_IMPORT_ARTIFACTS ??
    join(root, "output/native-plugin-import-20261013", `packaged-${randomUUID()}`)
)
assert(!existsSync(artifacts), "Evidence directory must be new")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const source = "C:/ai/autobiz_kanban"
function protectedFiles(directory: string) {
  const paths: string[] = ["plugin.json"]
  assert(existsSync(join(directory, "plugin.json")), "Original manifest must exist")
  function walk(folder: string) {
    for (const entry of readdirSync(join(directory, folder), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), "Protected hook tree must not contain symlinks")
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  walk("hooks")
  return Object.fromEntries(
    paths
      .sort()
      .map((path) => [path.replace(/\\/g, "/"), hash(readFileSync(join(directory, path)))])
  )
}
function trackedSnapshot() {
  const files = execFileSync("git", ["-C", source, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
  const digest = hash(
    files
      .sort()
      .map(
        (path) =>
          `${path}\0${existsSync(join(source, path)) ? hash(readFileSync(join(source, path))) : "missing"}`
      )
      .join("\n")
  )
  const status = execFileSync(
    "git",
    ["-C", source, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" }
  )
  return { digest, statusDigest: hash(status), trackedClean: status.length === 0 }
}
const sourceBefore = protectedFiles(source)
const trackedBefore = trackedSnapshot()
assert(
  trackedBefore.trackedClean,
  "Original tracked source must start clean; never repair it in this test"
)
const errors: string[] = []
const checks: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
async function picker(path: string | null) {
  await app!.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => {
      dialog.showOpenDialog = original
      return { canceled: path === null, filePaths: path ? [path] : [] }
    }) as typeof dialog.showOpenDialog
  }, path)
}
async function installedView() {
  await page!.getByRole("button", { name: "添加功能", exact: true }).click()
  await page!
    .getByRole("navigation", { name: "灵件工作区" })
    .getByRole("button", { name: "我已添加", exact: true })
    .click()
  await page!.getByRole("region", { name: "已安装插件", exact: true }).waitFor()
}
async function main() {
  try {
    app = await createModsCoreLauncher(root, isolated, env, artifacts)(60000)
    await app.evaluate(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    // Only offline network/feature-manifest transport is substituted; all business IPC remains real.
    await app.evaluate(async ({ session }) => {
      const http = process.getBuiltinModule("http")
      const https = process.getBuiltinModule("https")
      const { PassThrough } = process.getBuiltinModule("stream")
      const { EventEmitter } = process.getBuiltinModule("events")
      const net = process.getBuiltinModule("net")
      const socketConnect = net.Socket.prototype.connect
      net.Socket.prototype.connect = function (...args: any[]) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0]
        const host =
          typeof options === "object"
            ? (options.host ?? options.hostname)
            : typeof args[1] === "string" && typeof options === "number"
              ? args[1]
              : undefined
        if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
          queueMicrotask(() => this.emit("error", Error("OFFLINE_FIXTURE_EXTERNAL_SOCKET_BLOCKED")))
          return this
        }
        return socketConnect.apply(this, args as any)
      } as typeof socketConnect
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["http://*/*", "https://*/*"] },
        (details, callback) => {
          callback({
            cancel: !["127.0.0.1", "localhost", "::1"].includes(new URL(details.url).hostname)
          })
        }
      )
      const manifest = {
        version: "0.0.0",
        featureGates: {
          projectMode: {
            enabled: true,
            rolloutPercent: 100,
            includeAnonymous: true
          }
        }
      }
      const patch = (module: any) => {
        const original = module.request
        module.request = (url: any, options: any, callback: any) => {
          const target =
            typeof url === "string" || url instanceof URL
              ? new URL(url)
              : new URL(
                  `${url.protocol || "https:"}//${url.hostname || url.host}${url.path || "/"}`
                )
          if (["127.0.0.1", "localhost", "::1"].includes(target.hostname))
            return original(url, options, callback)
          const request: any = new EventEmitter()
          request.write = () => true
          request.setTimeout = () => request
          request.destroy = () => request
          request.end = () =>
            queueMicrotask(() => {
              if (
                target.pathname.endsWith("/download") &&
                target.searchParams.get("file")?.includes("latest")
              ) {
                const response: any = new PassThrough()
                response.statusCode = 200
                ;(typeof options === "function" ? options : callback)?.(response)
                request.emit("response", response)
                response.end(JSON.stringify(manifest))
              } else request.emit("error", Error("OFFLINE_FIXTURE_EXTERNAL_NETWORK_BLOCKED"))
            })
          return request
        }
      }
      patch(http)
      patch(https)
      const fetch = globalThis.fetch
      globalThis.fetch = ((url: any, ...args: any[]) => {
        const target = new URL(typeof url === "string" ? url : (url.url ?? String(url)))
        if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname))
          return Promise.reject(Error("OFFLINE_FIXTURE_EXTERNAL_NETWORK_BLOCKED"))
        return fetch(url, ...args)
      }) as typeof fetch
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.api?.plugins))
    assert(
      (
        await page.evaluate(() =>
          window.api.featureGates.isEnabled("projectMode", { refresh: true })
        )
      ).enabled
    )
    await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "原生插件导入验收",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
    }, workspace)
    await page.reload()
    await page.getByText("原生插件导入验收", { exact: true }).first().click()
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await installedView()
    await picker(source)
    await page.getByRole("button", { name: "从文件夹安装", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "尚未启用" }).waitFor()
    const original = (await page.evaluate(() => window.api.plugins.list())).find(
      (p) => p.name === JSON.parse(readFileSync(join(source, "plugin.json"), "utf8")).name
    )
    assert(original)
    assert.equal(original.enabled, false)
    assert.equal(original.hasProjectMode, true)
    assert((original.hookCount ?? 0) > 0)
    assert.equal(original.modCount ?? 0, 0)
    assert.deepEqual(protectedFiles(original.path), sourceBefore)
    assert.deepEqual(protectedFiles(source), sourceBefore)
    assert.deepEqual(trackedSnapshot(), trackedBefore)
    checks.push("raw-original-directory-ui-import-disabled-real-parser-copy-exact-manifest-hooks")
    await page.screenshot({ path: join(artifacts, "raw-original-disabled.png"), fullPage: true })
    const beforeIds = (await page.evaluate(() => window.api.plugins.list())).map((p) => p.id).sort()
    await picker(null)
    await page.getByRole("button", { name: "从文件夹安装", exact: true }).click()
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>("button:disabled") ||
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "从文件夹安装" && !b.disabled
        )
    )
    const invalid = join(isolated, "invalid-empty")
    mkdirSync(invalid)
    await picker(invalid)
    await page.getByRole("button", { name: "从文件夹安装", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.deepEqual(
      (await page.evaluate(() => window.api.plugins.list())).map((p) => p.id).sort(),
      beforeIds
    )
    checks.push("picker-cancel-invalid-package-preserve-catalog")
    const fixture = join(isolated, "native-project")
    mkdirSync(join(fixture, "skills/demo"), { recursive: true })
    mkdirSync(join(fixture, "board_core"))
    writeFileSync(
      join(fixture, "plugin.json"),
      JSON.stringify({
        name: "Native local project fixture",
        version: "1.0.0",
        description: "Offline navigation fixture"
      })
    )
    writeFileSync(
      join(fixture, "skills/demo/SKILL.md"),
      "---\nname: local-demo\ndescription: Offline explanation only\n---\nExplain the selected local project. Never execute tools.\n"
    )
    writeFileSync(join(fixture, "board_core/board_config.json"), JSON.stringify({ apiVersion: 1 }))
    await picker(fixture)
    await page.getByRole("button", { name: "从文件夹安装", exact: true }).click()
    const card = page.getByRole("article", { name: "Native local project fixture", exact: true })
    await card.getByRole("button", { name: "启用插件", exact: true }).waitFor()
    const mini = (await page.evaluate(() => window.api.plugins.list())).find(
      (p) => p.name === "Native local project fixture"
    )!
    assert(mini && !mini.enabled && mini.hasProjectMode)
    await card.getByRole("button", { name: "设置使用", exact: true }).click()
    await page.getByRole("heading", { name: mini.name, exact: true }).waitFor()
    await page.getByRole("button", { name: "编辑文件", exact: true }).waitFor()
    await installedView()
    await card.getByRole("button", { name: "启用插件", exact: true }).click()
    await card.getByRole("button", { name: "停用插件", exact: true }).waitFor()
    assert.equal(
      (await page.evaluate(() => window.api.plugins.list())).find((p) => p.id === original.id)!
        .enabled,
      false
    )
    await card.getByRole("button", { name: "新建项目", exact: true }).click()
    await page
      .getByRole("region", { name: "为新插件创建项目" })
      .getByRole("button", { name: "填写新项目" })
      .click()
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true })
    await dialog.getByRole("button", { name: new RegExp(`选择插件，当前：${mini.name}`) }).waitFor()
    await page.screenshot({
      path: join(artifacts, "native-project-preselected.png"),
      fullPage: true
    })
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    checks.push(
      "local-native-explicit-enable-settings-detail-project-preselection-no-project-execution"
    )
    // Reload chooses the real persisted conversation, avoiding production store injection.
    await page.reload()
    await page.getByText("原生插件导入验收", { exact: true }).first().click()
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await installedView()
    await card.getByRole("button", { name: "从此插件创建", exact: true }).click()
    const derivation = page.getByRole("region", { name: "从已有插件创建", exact: true })
    await derivation
      .getByText(`已选择 ${mini.name}，会复制其中的技能说明、脚本和原有检查规则。`, { exact: true })
      .waitFor()
    assert.equal(await derivation.locator(`option[value="${mini.id}"]`).textContent(), mini.name)
    checks.push("actual-source-handoff-inspect-selected-plugin")
    await page.screenshot({ path: join(artifacts, "native-source-inspected.png"), fullPage: true })
    await installedView()
    const mixed = new AdmZip(Buffer.from(compositionPlugin("composition-a")))
    mixed.addFile(
      "skills/demo/SKILL.md",
      Buffer.from("---\nname: mixed-demo\ndescription: Local skill\n---\nExplain only.")
    )
    await page
      .locator("input[type=file]")
      .setInputFiles({ name: "mixed.zip", mimeType: "application/zip", buffer: mixed.toBuffer() })
    await page.getByRole("article", { name: "composition-a", exact: true }).waitFor()
    const mixedMeta = (await page.evaluate(() => window.api.plugins.list())).find(
      (p) => p.name === "composition-a"
    )!
    assert((mixedMeta.modCount ?? 0) > 0 && mixedMeta.skillCount > 0)
    await page.getByRole("button", { name: "安装示范灵件", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "示范灵件" }).waitFor()
    assert(
      (await page.evaluate(() => window.api.plugins.list())).filter((p) => (p.modCount ?? 0) > 0)
        .length > 1
    )
    checks.push("mixed-zip-and-official-module-installation-no-grant-no-execution")
    assert.equal(
      (await page.evaluate(() => window.api.plugins.list())).find((p) => p.id === original.id)!
        .enabled,
      false
    )
    assert.deepEqual(errors, [])
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await app?.close()
    const trackedAfter = trackedSnapshot(),
      sourceAfter = protectedFiles(source)
    const sourceUnchanged =
      JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) &&
      JSON.stringify(trackedAfter) === JSON.stringify(trackedBefore)
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          passed: errors.length === 0 && sourceUnchanged,
          asarSha256,
          asarAfter: hash(readFileSync(asar)),
          isolated,
          workspace,
          checks,
          errors,
          sourceUnchanged,
          trackedBefore,
          trackedAfter,
          protectedSourceHashes: sourceBefore,
          limitations: [
            "Original AutoBiz stays disabled; no enterprise MCP is activated",
            "Project form preselection only; creation and original AutoBiz execution covered by separate suite",
            "Only dialog picker and offline feature manifest transport are substituted; real packaged business APIs",
            "No MCP file contents or credentials recorded"
          ]
        },
        null,
        2
      )
    )
    assert(sourceUnchanged, "Source tracked files or protected files changed")
    assert.equal(hash(readFileSync(asar)), asarSha256)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
