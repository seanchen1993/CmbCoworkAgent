import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { openModsResults } from "./support/mods-sidebar-navigation"

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
