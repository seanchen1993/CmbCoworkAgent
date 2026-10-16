import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/mods-creator-sidebar", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 950 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await mount(page, `profileView.active={id:'review',name:'审查助手',capabilities:[{pluginId:'demo',name:'Demo',digest:'a'.repeat(64)}],skills:{mode:'selected',items:[]},mcp:{mode:'selected',items:[]},models:{roles:{}}};host.render(<ChatFixture id='a'/>);openClawSidebar('configuration');`)
    const call = (name: string, ...args: unknown[]) => page.evaluate(({ name, args }) =>
      (window as unknown as { fixture: Record<string, (...values: unknown[]) => unknown> }).fixture[name](...args), { name, args })
    await page.getByRole("tab", { name: "高级设置", exact: true }).click()
    await page.getByRole("button", { name: "用对话调整组合", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "管理助手组合", exact: true }).isVisible(), false)
    await page.getByLabel("聊天消息", { exact: true }).fill("保留原草稿")
    await page.getByRole("button", { name: "用对话调整组合", exact: true }).click()
    const input = await page.getByLabel("聊天消息", { exact: true }).inputValue()
    assert(input.includes("保留原草稿"))
    assert(input.includes("审查助手") && input.includes("Demo") && input.includes("我的调整需求："))
    const calls = await page.evaluate(() =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls)
    assert.equal(calls.filter(([name]) => name === "creator").length, 1)
    assert.equal(calls.filter(([name]) => ["chat", "start", "claw", "clawStart"].includes(String(name))).length, 0)
    await page.getByLabel("任务进展", { exact: true }).waitFor({ state: "hidden" })
    await page.evaluate(() => (window as unknown as { publishClawNotice?: unknown; fixture: { hideSidebar(): void } }).fixture.hideSidebar())
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    await page.getByRole("tab", { name: "高级设置", exact: true }).click()
    await page.getByText("高级：手动管理组合", { exact: true }).click()
    assert(await page.getByRole("button", { name: "管理助手组合", exact: true }).isVisible())
    await call("deferCreator")
    await page.getByRole("button", { name: "用对话调整组合", exact: true }).click()
    await call("chat", "b")
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    await page.getByRole("tab", { name: "高级设置", exact: true }).click()
    await call("finishCreator")
    assert(await page.getByLabel("任务进展", { exact: true }).isVisible(),
      "a stale creator completion must not close another chat's sidebar")
    await page.screenshot({ path: resolve(output, "creator-sidebar.png"), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(`PASS creator sidebar: contextual draft, retained advanced entry, no send, stale completion fenced; ${output}`)
  } finally { await browser.close() }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
