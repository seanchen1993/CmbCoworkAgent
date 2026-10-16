import assert from "node:assert/strict"
import { chromium } from "playwright"
import {
  buildPlaywrightScriptRecorderInjectionScript,
  PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX
} from "../../../../src/main/browser/record/script-record/script-recorder-playwright-adapter"
import { formatPlaywrightSelector } from "../../../../src/main/browser/record/common/playwright-codegen/projectLocatorAdapter"

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div class="operator-item-normal___3vtIs" onclick="window.editClicks = (window.editClicks || 0) + 1">
        <span role="img"><svg width="16" height="16"><path d="M0 0" /></svg></span>
        <span>编辑</span>
      </div>
      <span>编辑流水线配置</span>
      <button>保存</button>
      <iframe srcdoc="<span>编辑</span>"></iframe>
    `)
    await page.evaluate(buildPlaywrightScriptRecorderInjectionScript())
    const record = async (selector: string): Promise<string> => {
      const message = page.waitForEvent("console", {
        predicate: (entry) => entry.text().startsWith(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX)
      })
      await page.evaluate(async (value) => {
        await (window as any).__pw_recorderRecordAction({ name: "click", selector: value })
      }, selector)
      const payload = JSON.parse(
        (await message).text().slice(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX.length)
      )
      return payload.locator.selector
    }
    // The recorder must not tighten a selector that already has multiple matches.
    assert.equal(await record('internal:text="编辑"i'), 'internal:text="编辑"i')
    await page.getByText("编辑流水线配置", { exact: true }).evaluate((node) => node.remove())
    const recorded = await record('internal:text="编辑"i')
    assert.equal(recorded, 'internal:text="编辑"s')
    assert.equal(formatPlaywrightSelector(recorded), 'getByText("编辑", { exact: true })')
    await page.getByText("编辑", { exact: true }).evaluate((node) => {
      node.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true }))
      node.classList.add("ant-tooltip-open")
    })
    await page.evaluate(() => {
      const tooltip = document.createElement("div")
      tooltip.setAttribute("role", "tooltip")
      tooltip.textContent = "您不是系统LQ13.11的CI_OWNER，无法编辑"
      document.body.append(tooltip)
    })
    assert.equal(await page.getByText("编辑").count(), 2)
    const hoverFallback = await record(".ant-tooltip-open")
    assert.equal(hoverFallback, 'internal:text="编辑"s')
    await page.locator(recorded).click()
    assert.equal(await page.evaluate(() => (window as any).editClicks), 1)
    assert.equal(await record('internal:text="CI_OWNER"i'), 'internal:text="CI_OWNER"i')
    assert.equal(
      await record('internal:role=button[name="保存"i]'),
      'internal:role=button[name="保存"i]'
    )
    await page
      .locator(".ant-tooltip-open")
      .evaluate((node) => node.classList.remove("ant-tooltip-open"))
    await page.getByRole("tooltip").evaluate((node) => node.remove())
    await page.locator(hoverFallback).click()
    assert.equal(await page.evaluate(() => (window as any).editClicks), 2)
    const frame = page.frames()[1]
    await frame.evaluate(buildPlaywrightScriptRecorderInjectionScript("child"))
    const frameMessage = page.waitForEvent("console", {
      predicate: (entry) => entry.text().startsWith(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX)
    })
    await frame.evaluate(async () => {
      await (window as any).__pw_recorderRecordAction({
        name: "click",
        selector: 'internal:text="编辑"i'
      })
    })
    const framePayload = JSON.parse(
      (await frameMessage).text().slice(PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX.length)
    )
    assert.equal(framePayload.locator.selector, 'internal:text="编辑"s')
    console.log(
      "PASS real recorder injection: exact text, tooltip replay, partial text, roles and iframe"
    )
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
