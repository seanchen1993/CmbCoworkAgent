import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/mods-guidance", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await mount(page, `
      import {ModsGuide} from ${JSON.stringify(resolve("src/renderer/src/components/customize/ModsGuide.tsx"))};
      import {FlowUsageGuide} from ${JSON.stringify(resolve("src/renderer/src/components/customize/FlowUsageGuide.tsx"))};
      host.render(<main><ModsGuide/><FlowUsageGuide/></main>);
    `)
    const modsGuide = page.locator("[data-mods-guide]")
    const flowGuide = page.locator("[data-flow-usage]")
    assert.match(await modsGuide.innerText(), /普通聊天中描述并发送/)
    assert.match(await modsGuide.innerText(), /创造者模式/)
    assert.equal(await modsGuide.getByRole("button", { name: "打开任务方案编辑器", exact: true }).isVisible(), false)
    await modsGuide.locator(":scope > details > summary").click()
    assert.match(await modsGuide.innerText(), /确认应用到这段聊天/)
    assert.equal(await modsGuide.getByRole("button", { name: "复制 /claw-info", exact: true }).isVisible(), false)
    await modsGuide.getByText("高级：安装现成插件并使用命令", { exact: true }).click()
    await modsGuide.getByRole("button", { name: "复制 /claw-info", exact: true }).waitFor()
    await modsGuide.getByText("高级：手动管理任务方案", { exact: true }).click()
    await modsGuide.getByRole("button", { name: "打开任务方案编辑器", exact: true }).click()
    const navigation = await page.evaluate(() =>
      (window as unknown as { fixture: { navigation(): unknown[][] } }).fixture.navigation())
    assert.deepEqual(navigation, [[true, "flows"]])
    await flowGuide.getByText("聊天任务模板怎么用？", { exact: true }).click()
    assert.match(await flowGuide.innerText(), /无需先配置任务方案/)
    assert.doesNotMatch(await flowGuide.innerText(), /先加载工具列表/)
    await flowGuide.getByText("高级：使用手动保存的任务方案", { exact: true }).click()
    assert.match(await flowGuide.innerText(), /普通发送也不会自动执行已保存方案/)
    assert.match(await flowGuide.innerText(), /任务进展 → 高级设置/)
    assert.match(await flowGuide.innerText(), /发送消息/)
    const calls = await page.evaluate(() =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls)
    assert.deepEqual(calls, [], "reading guidance and opening an editor must not execute tasks")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ passed: true, navigation, calls, errors }, null, 2))
    console.log(`PASS guidance: direct chat and creator first, manual setup collapsed, explicit saved-plan boundary; ${output}`)
  } finally { await browser.close() }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
