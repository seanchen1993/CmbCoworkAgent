/** Real final ASAR, native sidebar/button/approval and actual read-only collector.
 * COMPOSITION_E2E_PACKAGED_DIR=<app> npx tsx tests/worktree-progress-packaged.spec.ts
 *   --plugin <assembled.zip> --observer-source <portable observer source>
 */
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const execute = promisify(execFile)
const root = resolve(__dirname, "..")
const argument = (name: string) => {
  const at = process.argv.indexOf(name)
  assert(at >= 0 && process.argv[at + 1], `Explicit ${name} required`)
  return resolve(process.argv[at + 1])
}
const zipPath = argument("--plugin")
const observerSource = argument("--observer-source")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit final ASAR required")
const fixture = projectCompositionEnvironment(root)
const candidate = projectCompositionCandidate(root)
let app: ElectronApplication | undefined
let page: Page | undefined

async function main() {
  const watchdog = setTimeout(() => void app?.close(), 180000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const zipBytes = readFileSync(zipPath)
    const zip = new AdmZip(zipBytes)
    const manifest = JSON.parse(zip.readAsText("plugin.json"))
    assert.equal(
      zip.readAsText("mods/business/autobiz.worktree-progress/inspect.py"),
      readFileSync(
        join(observerSource, "mods/business/autobiz.worktree-progress/inspect.py"),
        "utf8"
      )
    )
    const installed = await page.evaluate(
      ({ bytes }) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "observer-demo.zip", "local"),
      { bytes: [...zipBytes] }
    )
    assert(installed.success, installed.error)
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (row) => row.name === manifest.name
    )!
    assert(plugin)
    await page.evaluate((id) => window.api.plugins.setEnabled(id, true), plugin.id)
    const prepared = await execute(
      "python",
      [
        "-B",
        "-X",
        "utf8",
        join(observerSource, "demo/prepare.py"),
        "--plugin-root",
        plugin.path,
        "--target",
        join(fixture.isolated, "controlled-demo")
      ],
      { maxBuffer: 1024 * 1024 }
    )
    const demo = JSON.parse(prepared.stdout)
    await app.evaluate(
      ({ dialog }, { workspace, script }) => {
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string; detail?: string }
          const position = options.detail?.indexOf("{") ?? -1
          const request = position >= 0 ? JSON.parse(options.detail!.slice(position)) : {}
          const allowed =
            options.title === "批准插件运行本机命令" &&
            Array.isArray(request.argv) &&
            request.argv.length === 7 &&
            JSON.stringify(request.argv.slice(0, 4)) ===
              JSON.stringify(["python", "-B", "-X", "utf8"]) &&
            String(request.argv[4]).replace(/\\/g, "/").toLowerCase() ===
              script.replace(/\\/g, "/").toLowerCase() &&
            request.argv[5] === "--workspace" &&
            String(request.argv[6]).replace(/\\/g, "/").toLowerCase() ===
              workspace.replace(/\\/g, "/").toLowerCase() &&
            String(request.cwd).replace(/\\/g, "/").toLowerCase() ===
              workspace.replace(/\\/g, "/").toLowerCase()
          const state = globalThis as typeof globalThis & { observerApprovals?: unknown[] }
          ;(state.observerApprovals ??= []).push({ allowed, title: options.title, request })
          return { response: allowed ? 1 : 0, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
      },
      {
        workspace: demo.workspace,
        script: join(plugin.path, "mods/business/autobiz.worktree-progress/inspect.py")
      }
    )
    const scope = await page.evaluate(async (workspace) => {
      await window.api.mods.configureGlobal(true)
      const thread = await window.api.threads.create({
        title: "Worktree observer actual UI",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      const initial = await window.api.mods.status(thread.thread_id)
      await window.api.mods.configure(thread.thread_id, true, true, initial.workspace)
      const status = await window.api.mods.status(thread.thread_id)
      for (const entry of status.functionMods ?? [])
        if (entry.state === "needs-approval" && entry.digest)
          await window.api.mods.approveFunction(
            thread.thread_id,
            entry.pluginId,
            entry.digest,
            status.workspace
          )
      await window.api.mods.commands(thread.thread_id)
      return { threadId: thread.thread_id, workspace: status.workspace }
    }, demo.workspace)
    await page.reload()
    await page.getByText("Worktree observer actual UI", { exact: true }).first().click()
    await page.locator(`[data-platform-workspace="${scope.threadId}"]`).waitFor()
    const sidebar = page.getByRole("complementary", { name: "扩展侧栏", exact: true })
    await sidebar.getByRole("button", { name: "并行 Worktree 进度", exact: true }).waitFor()
    await page.screenshot({ path: join(fixture.isolated, "observer-sidebar-entry.png") })
    await sidebar.getByRole("button", { name: "并行 Worktree 进度", exact: true }).click()
    const panel = page.getByRole("region", { name: "并行 Worktree 进度", exact: true })
    await panel
      .getByRole("button", { name: "刷新真实 Worktree 进度（保留执行审批）", exact: true })
      .waitFor()
    const before = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { observerApprovals?: unknown[] }).observerApprovals ??
        []
    )
    assert.equal(before.length, 0, "Opening the real native surface does not execute a process")
    await panel
      .getByRole("button", { name: "刷新真实 Worktree 进度（保留执行审批）", exact: true })
      .click()
    await panel.getByRole("table").getByRole("row").filter({ hasText: "B001" }).waitFor()
    await panel.getByRole("table").getByRole("row").filter({ hasText: "B002" }).waitFor()
    assert.match(await panel.innerText(), /todo:1/)
    assert.match(await panel.innerText(), /prepare:passed \(bytes_match\)/)
    assert.match(await panel.innerText(), /review:pending/)
    const approvals = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { observerApprovals?: Array<{ allowed: boolean }> })
          .observerApprovals ?? []
    )
    assert.equal(approvals.length, 1)
    assert(approvals[0].allowed)
    const catalog = await page.evaluate(
      (id) => window.api.mods.platformSurfaceList(id),
      scope.threadId
    )
    const entry = catalog.entries.find((item) => item.ref.id === "autobiz.worktree-progress")!
    assert(entry && entry.ref.provider === plugin.name && entry.placement === "sidebar")
    await panel.getByRole("table").scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(fixture.isolated, "observer-real-worktrees.png") })
    await panel.screenshot({ path: join(fixture.isolated, "observer-progress-panel.png") })
    const evidence = {
      candidate,
      plugin: { name: plugin.name, id: plugin.id, path: plugin.path },
      demo,
      scope,
      entry,
      approvals,
      displayed: await panel.innerText(),
      isolated: fixture.isolated,
      actualEntry:
        "真实本地聊天 → 扩展侧栏 → 并行 Worktree 进度 → 刷新真实 Worktree 进度（原生批准本次命令）",
      limits:
        "Actual final ASAR/native UI/process approval/original scheduler/Git/collector; controlled input, no full model Code, Review, UTest, merge or business acceptance."
    }
    const output = resolve("output/demo-readiness-20261016")
    mkdirSync(output, { recursive: true })
    writeFileSync(
      join(output, "worktree-progress-packaged-ui.json"),
      JSON.stringify(evidence, null, 2)
    )
    writeFileSync(join(fixture.isolated, "evidence.json"), JSON.stringify(evidence, null, 2))
    console.log(`PASS final packaged native Worktree observer UI: ${fixture.isolated}`)
  } catch (error) {
    await page?.screenshot({ path: join(fixture.isolated, "observer-failure.png") }).catch(() => {})
    if (page)
      writeFileSync(
        join(fixture.isolated, "observer-failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      )
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
