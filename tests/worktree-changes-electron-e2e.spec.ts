/**
 * Run: npx tsx tests/worktree-changes-electron-e2e.spec.ts
 * Requires an already compiled candidate; never builds or packages the application.
 * WORKTREE_ACCEPTANCE_FILE_COUNT=500 adds unchanged tracked files for scale evidence.
 * WORKTREE_ACCEPTANCE_PARTIAL=1 includes a tracked sensitive file and a Git link.
 * WORKTREE_ACCEPTANCE_REPOSITORY=<prior run directory> reuses its exact Git worktree.
 * Actual Electron/IPC/runtime/Git; localhost model content, precise directory-dialog
 * answer and read-only lease observation are controlled fixtures, not manual UI evidence.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { MessageBoxOptions } from "electron"
import type { getLocalThreadRunLease } from "../src/main/agent/thread-run-lease"
import type { getModsManager } from "../src/main/mods/manager"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

type ObservedMain = typeof globalThis & {
  __directoryApprovals: Array<MessageBoxOptions & { allowed: boolean }>
  __worktreeLease: typeof getLocalThreadRunLease
  __worktreeGetManager: typeof getModsManager
  __worktreeObserve: <T>(read: () => T) => T
}

const root = resolve(__dirname, "..")
process.env.COMPOSITION_E2E_ARTIFACT_ROOT = join(root, "output/worktree-electron")
const f = projectCompositionEnvironment(root),
  build = projectCompositionCandidate(root)
assert(
  readFileSync(build.path, "utf8").includes("working-tree-conversion-not-applied"),
  "Compile the current safe Git inspection candidate first"
)
const fileCount = Number(process.env.WORKTREE_ACCEPTANCE_FILE_COUNT ?? 0)
assert(Number.isSafeInteger(fileCount) && fileCount >= 0 && fileCount <= 1000)
const reused = process.env.WORKTREE_ACCEPTANCE_REPOSITORY
const partialFixture = process.env.WORKTREE_ACCEPTANCE_PARTIAL === "1"
assert(!partialFixture || !reused, "Partial acceptance creates its own explicit fixture")
const repositoryFixture = reused ? resolve(reused) : f.isolated
const repo = join(repositoryFixture, "workspace", "repo"),
  linked = join(repositoryFixture, "linked")
if (!reused) mkdirSync(repo)
const env = {
  ...f.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_AUTHOR_NAME: "Acceptance",
  GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
  GIT_COMMITTER_NAME: "Acceptance",
  GIT_COMMITTER_EMAIL: "acceptance@example.invalid"
}
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env, encoding: "utf8", windowsHide: true }).trim()
if (!reused) {
  git("init", "-q")
  git("config", "core.autocrlf", "false")
  writeFileSync(join(repo, "one.txt"), "baseline one\n")
  writeFileSync(join(repo, "two.txt"), "baseline two\n")
  if (partialFixture) writeFileSync(join(repo, ".env"), "ENCRYPTED_FIXTURE_PLACEHOLDER=fixture\n")
  for (let index = 0; index < fileCount; index++)
    writeFileSync(join(repo, `scale-${index}.txt`), `unchanged ${index}\n`)
  git("add", ".")
  git("commit", "-qm", "base")
  if (partialFixture) {
    git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},nested`)
    git("commit", "-qm", "gitlink fixture")
  }
  git("worktree", "add", "--detach", linked, git("rev-parse", "HEAD"))
  writeFileSync(join(linked, "one.txt"), "linked real one\n")
  writeFileSync(join(linked, "two.txt"), "linked real two\n")
  writeFileSync(join(repo, "one.txt"), "original repository one\n")
}
const baseline = git("rev-parse", "HEAD")
const trackedFixtureFiles = git("ls-files", "-z").split("\0").filter(Boolean).length

let app: ElectronApplication | undefined,
  page: Page | undefined,
  threadId = ""
let releaseModel: (() => void) | undefined,
  modelStarted = false,
  passed = false
const rows: unknown[] = [],
  errors: string[] = []
const record = (value: unknown) => {
  rows.push(value)
  console.log(JSON.stringify(value))
}
const server = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        id: "fixed-title",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "工作树验收" }, finish_reason: "stop" }
        ]
      })
    )
    return
  }
  modelStarted = true
  response.writeHead(200, { "content-type": "text/event-stream" })
  const chunk = (content: string, finish: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: "held-real-runtime",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: { content }, finish_reason: finish }]
      })}\n\n`
    )
  chunk("业务任务保持运行，正在等待测试完成。\n\n")
  const timer = setInterval(() => chunk("任务仍在运行。\n\n"), 1500)
  await new Promise<void>((done) => {
    releaseModel = done
    response.once("close", done)
  })
  clearInterval(timer)
  if (!response.destroyed) {
    chunk("业务任务完成。", "stop")
    response.end("data: [DONE]\n\n")
  }
})
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string) {
  const end = Date.now() + 60_000
  while (Date.now() < end) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const port = (server.address() as { port: number }).port
  const launch = createHeadlessProjectCompositionLaunch(root, f, { unobtrusivePresentation: true })
  // Append only a read-only observation accessor to the loaded module in memory.
  // No candidate bytes, lifecycle functions, IPC handlers, authorization or provider are replaced.
  const bootstrap = join(f.isolated, "headless-main.cjs")
  const observation = `const fs=require('node:fs');const Module=require('node:module');
const worktreeObserver=new (require('node:async_hooks').AsyncResource)('worktree-acceptance-observer');
globalThis.__worktreeObserve=read=>worktreeObserver.runInAsyncScope(read);
const compile=Module.prototype._compile;
Module.prototype._compile=function(source,filename){
 if(filename===${JSON.stringify(build.path)}) source+='\\n;globalThis.__worktreeLease=getLocalThreadRunLease;globalThis.__worktreeGetManager=getModsManager;';
 return compile.call(this,source,filename);
};\n`
  writeFileSync(bootstrap, observation + readFileSync(bootstrap, "utf8"))
  try {
    app = await launch()
    app
      .process()
      .stderr?.on("data", (bytes) => appendFileSync(join(f.isolated, "stderr.log"), bytes))
    page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => !!window.api?.mods)
    await page.evaluate("window.__name = value => value")
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    await app.evaluate(({ dialog }, linked) => {
      const original = dialog.showMessageBox.bind(dialog)
      const observed = globalThis as ObservedMain
      observed.__directoryApprovals = []
      dialog.showMessageBox = (async (...args: Parameters<typeof dialog.showMessageBox>) => {
        const options = args.at(-1) as MessageBoxOptions
        if (options.title !== "查看代码变更") return Reflect.apply(original, dialog, args)
        const allowed = options.detail?.startsWith(linked + "\n") === true
        observed.__directoryApprovals.push({ allowed, ...options, signal: undefined })
        return { response: allowed ? 0 : 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    }, linked)
    const zip = new AdmZip()
    zip.addLocalFolder(join(root, "resources/native-compositions/worktree-changes"))
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "worktree-changes.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, JSON.stringify(installed))
    threadId = await page.evaluate(
      async ({ workspace, port }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "worktree-acceptance",
          name: "隔离固定内容模型",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "worktree-fixture",
          apiKey: "localhost-only",
          maxTokens: 128000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:worktree-acceptance")
        await window.api.mods.configureGlobal(true)
        const thread = await window.api.threads.create({
          title: "运行任务同时查看真实工作树",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        const initial = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, initial.workspace)
        const status = await window.api.mods.status(thread.thread_id)
        for (const plugin of status.functionMods ?? [])
          if (plugin.state === "needs-approval" && plugin.digest)
            await window.api.mods.approveFunction(
              thread.thread_id,
              plugin.pluginId,
              plugin.digest,
              status.workspace
            )
        return thread.thread_id
      },
      { workspace: repo, port }
    )
    await page.reload()
    await page.waitForFunction(() => !!window.api?.mods)
    await page.evaluate("window.__name = value => value")
    await page.getByText("运行任务同时查看真实工作树", { exact: true }).first().click()
    const cold = await page.evaluate((id) => window.api.mods.platformSurfaceList(id), threadId)
    record({ phase: "cold", catalog: cold })
    const prepare = page.getByRole("button", { name: "打开扩展视图", exact: true })
    if (await prepare.count()) await prepare.click()
    await page.getByRole("button", { name: "代码变更", exact: true }).waitFor()
    await page.locator("textarea.composer-textarea").fill("请保持任务运行，等待我的后续确认。")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until(
      async () => modelStarted,
      (value) => value,
      "original model runtime"
    )
    const snapshot = () =>
      app!.evaluate(
        async (_electron, args) => {
          const observed = globalThis as ObservedMain
          // CDP evaluates in whichever async frame Electron is currently running. Observe
          // from the startup context, never an incidental expired model/tool call scope.
          return observed.__worktreeObserve(async () => {
            const manager = observed.__worktreeGetManager()
            if (!manager) throw Error("ACTUAL_MODS_MANAGER_REQUIRED")
            const runtime = manager.functionRuntimeScope(args.workspace, args.id)
            runtime.assertLive()
            const policy = runtime.queryTool
              ? await runtime.queryTool("host:read_file", { file_path: args.path })
              : null
            runtime.assertLive()
            return {
              lease: observed.__worktreeLease(args.id),
              bound: runtime.bound,
              policy,
              approvals: observed.__directoryApprovals
            }
          })
        },
        { bundle: build.path, workspace: repo, id: threadId, path: join(linked, "one.txt") }
      )
    const before = await snapshot()
    record({ phase: "running-before", ...before })
    assert(before.lease && before.bound)
    await page.getByRole("button", { name: "代码变更", exact: true }).click()
    const region = page.getByRole("region", { name: "代码变更", exact: true })
    await region.waitFor()
    record({ phase: "open", text: await region.innerText() })
    const inputs = region.locator("input")
    await inputs.nth(0).fill(linked)
    await inputs.nth(0).press("Enter")
    await region
      .getByText("目录已选择。点击加载变更，由宿主核验读取权限。", { exact: true })
      .waitFor()
    await inputs.nth(1).fill(baseline)
    await inputs.nth(1).press("Enter")
    await region.getByText("起点已更新，点击加载变更。", { exact: true }).waitFor()
    const listStarted = performance.now()
    await region.getByRole("button", { name: "加载 / 刷新变更", exact: true }).click()
    await until(
      () => region.innerText(),
      (value) => value.includes("one.txt") || value.includes("读取失败"),
      "real worktree list"
    )
    record({
      phase: "loaded",
      milliseconds: performance.now() - listStarted,
      trackedFixtureFiles,
      text: await region.innerText(),
      state: await snapshot()
    })
    await page.screenshot({ path: join(f.isolated, "worktree-loaded.png"), fullPage: true })
    assert(
      !(await region.innerText()).includes("读取失败"),
      "The original runtime must authorize the selected real worktree"
    )
    if (partialFixture) {
      const visible = await region.innerText()
      assert(visible.includes("仅展示可读取范围：1 项受权限保护，1 个子模块未检查。"))
      assert(!visible.includes(".env") && !visible.includes("nested"))
      record({ phase: "partial-readable", denied: 1, gitlinks: 1, excludedNamesVisible: false })
    }
    const one = region.getByRole("button", { name: /修改 · one.txt/ })
    const two = region.getByRole("button", { name: /修改 · two.txt/ })
    let began = performance.now()
    await one.click()
    const firstResult = await until(
      () => region.innerText(),
      (value) => value.includes("+linked real one") || value.includes("读取失败"),
      "first diff"
    )
    assert(!firstResult.includes("读取失败"), firstResult)
    record({ phase: "first-diff", milliseconds: performance.now() - began })
    await region.getByText("+linked real one", { exact: false }).scrollIntoViewIfNeeded()
    const layout = await region.evaluate((region) => {
      const box = region.getBoundingClientRect()
      return {
        width: region.clientWidth,
        scrollWidth: region.scrollWidth,
        scrollLeft: region.scrollLeft,
        overflow: [...region.querySelectorAll("*")]
          .filter((element) => element.getBoundingClientRect().right > box.right + 1)
          .slice(0, 20)
          .map((element) => ({
            tag: element.tagName,
            text: element.textContent?.slice(0, 100),
            width: element.getBoundingClientRect().width,
            css: element.getAttribute("class"),
            style: element.getAttribute("style")
          }))
      }
    })
    record({ phase: "layout", value: layout })
    assert(
      layout.scrollWidth <= layout.width + 1,
      "The narrow surface must not scroll horizontally"
    )
    assert.equal(layout.scrollLeft, 0)
    await page.screenshot({ path: join(f.isolated, "worktree-real-diff.png"), fullPage: true })
    began = performance.now()
    record({ phase: "quick-request", file: "one.txt", milliseconds: performance.now() })
    await one.click()
    record({ phase: "quick-request", file: "two.txt", milliseconds: performance.now() })
    await two.click()
    const quickResult = await until(
      () => region.innerText(),
      (value) => value.includes("+linked real two") || value.includes("读取失败"),
      "quick switch"
    )
    assert(!quickResult.includes("读取失败"), quickResult)
    record({
      phase: "quick-switch",
      milliseconds: performance.now() - began,
      text: await region.innerText()
    })
    assert(!(await region.innerText()).includes("+linked real one"))
    await one.click()
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    await new Promise((done) => setTimeout(done, 1200))
    assert.equal(await region.count(), 0)
    const after = await snapshot()
    record({ phase: "running-after-close", ...after })
    assert.deepEqual(after.lease, before.lease)
    assert(after.bound)
    assert.equal(after.approvals.length, 1)
    await page.screenshot({ path: join(f.isolated, "task-survives-close.png"), fullPage: true })
    releaseModel?.()
    const completed = await until(
      () => page!.evaluate((id) => window.api.threads.getMessages(id), threadId),
      (messages) =>
        messages.some(
          (message) =>
            message.role === "assistant" &&
            JSON.stringify(message.content).includes("业务任务完成。")
        ),
      "original task persisted completion"
    )
    record({
      phase: "saved-done",
      assistantMessages: completed.filter((message) => message.role === "assistant").length
    })
    passed = true
  } catch (error) {
    record({ failure: String(error), stack: (error as Error).stack })
    if (page) {
      writeFileSync(join(f.isolated, "failure.html"), await page.content())
      await page.screenshot({ path: join(f.isolated, "failure.png"), fullPage: true })
    }
    throw error
  } finally {
    releaseModel?.()
    writeFileSync(
      join(f.isolated, "evidence.json"),
      JSON.stringify(
        {
          passed,
          build,
          threadId,
          repositoryFixture,
          partialFixture,
          rows,
          errors,
          boundary:
            "Real built Electron, public install/configuration/Surface IPC, original desktop runtime and real Git worktree. Model text is a held localhost fixture. Native directory dialog response injected only for the exact isolated linked directory; confirmation UI not manually validated. Read-only lease accessor appended in memory to loaded main module and invoked in a startup AsyncResource to avoid CDP inheriting unrelated model call scopes; no authorization/runtime logic replaced."
        },
        null,
        2
      )
    )
    try {
      await app?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
    console.log("Evidence: " + f.isolated)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
