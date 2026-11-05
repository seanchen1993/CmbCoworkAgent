import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const require = createRequire(import.meta.url)
  const isolated = mkdtempSync(join(tmpdir(), "workflow-history-browser-"))
  const artifacts = join(root, "output/workflow-history")
  mkdirSync(artifacts, { recursive: true })
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets)
    .filter((name) => name.startsWith("index-") && name.endsWith(".css"))
    .sort((a, b) => statSync(join(assets, b)).size - statSync(join(assets, a)).size)[0]
  assert(css, "Run npm run build before the browser regression")
  const bundle = await build({
    entryPoints: [join(root, "tests/support/workflow-history-fixture.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    alias: { "@": join(root, "src/renderer/src") }
  })
  const html = join(isolated, "index.html")
  writeFileSync(
    html,
    `<html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css)).href}"></head><body><div id="root"></div></body></html>`
  )
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `const {app,BrowserWindow}=require("electron");app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-features","CalculateNativeWinOcclusion");app.whenReady().then(()=>new BrowserWindow({show:true,width:1100,height:900,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(html)}));`
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [entry, `--user-data-dir=${join(isolated, "profile")}`],
    env
  })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const render = async (mode: string, panel = false): Promise<void> => {
      await page.evaluate(
        ({ mode, panel }) => {
          ;(
            window as unknown as {
              renderWorkflowHistoryFixture: (mode: string, panel: boolean) => void
            }
          ).renderWorkflowHistoryFixture(mode, panel)
        },
        { mode, panel }
      )
    }
    const openDetails = async (): Promise<void> => {
      await page.getByRole("button", { name: /已完成的 worktree 工作流/ }).click()
    }
    const assertReadOnly = async (): Promise<void> => {
      await page.getByRole("alert").filter({ hasText: "暂为只读" }).waitFor()
      for (const name of ["Diff", "合并", "丢弃"]) {
        assert.equal(await page.getByRole("button", { name, exact: true }).isEnabled(), false)
      }
    }
    await openDetails()
    await assertReadOnly()
    await page.getByText("已保存的工作流结果", { exact: true }).waitFor()
    await page.getByRole("button", { name: "日志(1)", exact: true }).click()
    await page.getByText("工作流执行日志仍可查看", { exact: true }).waitFor()
    assert.equal(await page.getByText("未找到该运行记录。", { exact: true }).count(), 0)
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "worktree-read-only.png")
    })

    // Retry reads a fresh response and restores actions only after verification succeeds.
    await page.evaluate(() =>
      (
        window as unknown as { setWorkflowHistoryResponse: (mode: string) => void }
      ).setWorkflowHistoryResponse("healthy")
    )
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByText("已保存的工作流结果", { exact: true }).waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await page.getByRole("button", { name: "合并", exact: true }).isEnabled(), true)

    // A failed refresh keeps the previous readable result, but disables stale actions.
    await page.evaluate(() =>
      (
        window as unknown as { setWorkflowHistoryResponse: (mode: string) => void }
      ).setWorkflowHistoryResponse("error")
    )
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "加载运行详情失败" }).waitFor()
    await page.getByText("已保存的工作流结果", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "合并", exact: true }).isEnabled(), false)

    await render("error")
    await openDetails()
    await page.getByRole("alert").filter({ hasText: "加载运行详情失败" }).waitFor()
    assert.equal(await page.getByText("未找到该运行记录。", { exact: true }).count(), 0)
    await page.screenshot({ animations: "disabled", path: join(artifacts, "load-error-retry.png") })
    await page.evaluate(() =>
      (
        window as unknown as { setWorkflowHistoryResponse: (mode: string) => void }
      ).setWorkflowHistoryResponse("healthy")
    )
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.getByText("已保存的工作流结果", { exact: true }).waitFor()

    await render("missing")
    await openDetails()
    await page.getByText("未找到该运行记录。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    await page.getByRole("button", { name: "返回列表", exact: true }).click()
    await page.getByRole("button", { name: /已完成的 worktree 工作流/ }).waitFor()

    await render("malformed-worktree")
    await openDetails()
    await page.getByText("已保存的工作流结果", { exact: true }).waitFor()
    await page.getByRole("alert").filter({ hasText: "暂为只读" }).waitFor()

    await render("action-error")
    await openDetails()
    await page.getByRole("button", { name: "Diff", exact: true }).click()
    await assertReadOnly()

    await render("action-read-error")
    await openDetails()
    await page.getByRole("button", { name: "Diff", exact: true }).click()
    await assertReadOnly()

    await render("worktree-error", true)
    await assertReadOnly()
    assert.deepEqual(errors, [])
    console.log(
      "Workflow history browser regression passed: readable results, read-only worktrees, retry, missing run, malformed metadata and hydrated panel"
    )
  } finally {
    await app.close()
    rmSync(isolated, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
