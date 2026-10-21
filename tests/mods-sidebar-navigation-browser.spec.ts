import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import {
  closeModsProgress,
  openModsFlowHistory,
  openModsFlowPreset,
  openModsProgress,
  openModsResults
} from "./support/mods-sidebar-navigation"

async function main() {
  const output = resolve(__dirname, `../output/mods-sidebar-navigation/${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(5000)
  try {
    await mount(page, "window.fixture.chat('a')")
    await openModsResults(page)
    const sidebar = page.getByRole("complementary", { name: "任务进展", exact: true })
    assert.equal(
      await sidebar.getByRole("tab", { name: "结果", exact: true }).getAttribute("aria-selected"),
      "true"
    )
    assert.equal(await sidebar.getByText("受控插件结果", { exact: true }).isVisible(), true)
    const preset = await openModsFlowPreset(page)
    assert.equal(await preset.isVisible(), true)
    await openModsFlowPreset(page)
    assert.equal(await preset.isVisible(), true)
    await closeModsProgress(page)
    await openModsProgress(page)
    assert.equal(
      await sidebar
        .getByRole("tab", { name: "当前任务", exact: true })
        .getAttribute("aria-selected"),
      "true"
    )
    await sidebar.getByRole("tab", { name: "当前任务", exact: true }).click()
    await openModsResults(page)
    assert.equal(
      await sidebar.getByRole("tab", { name: "结果", exact: true }).getAttribute("aria-selected"),
      "true"
    )
    await page.evaluate("window.fixture.hideSidebar();window.fixture.chat('b')")
    await openModsResults(page)
    assert.equal(await sidebar.getByText("受控插件结果", { exact: true }).isVisible(), true)
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(call=>['start','clawStart','cancel','save'].includes(call[0])).length"
      ),
      0
    )
    await (await openModsFlowPreset(page)).selectOption("flow_b:1")
    await closeModsProgress(page)
    await page.getByLabel("聊天消息").fill("Inspect nested history")
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
    await page.waitForFunction("Boolean(window.chat.run?.id)")
    const runId = await page.evaluate<string>("window.chat.run.id")
    const history = await openModsFlowHistory(page, runId)
    assert.equal(
      await history.getByRole("list", { name: "步骤执行记录", exact: true }).isVisible(),
      true
    )
    await openModsFlowHistory(page, runId)
    assert.equal(
      await history.getByRole("list", { name: "步骤执行记录", exact: true }).isVisible(),
      true
    )
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(call=>['save','cancel','decide'].includes(call[0])).length"
      ),
      0
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "results.png") })
    console.log(
      "PASS production task-progress navigation opens real results after close and thread switch"
    )
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
