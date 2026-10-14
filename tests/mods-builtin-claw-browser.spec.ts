import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, `../output/plain-language-20261013/builtin-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const checks: string[] = [],
    errors: string[] = []
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } })
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10000)
  try {
    await mount(
      page,
      `
      profileView.capabilities=[];
      window.builtinView=()=>structuredClone(profileView);
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    assert.equal(await page.getByLabel("启用聊天容量提示").isChecked(), false)
    await page.getByLabel("启用聊天容量提示").check()
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    assert.equal(await page.evaluate("window.builtinView().active"), null)
    await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
    await page.getByText("启用聊天容量提示", { exact: true }).waitFor()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    assert.equal(await page.evaluate("window.builtinView().active.builtins.contextMeter"), true)
    await page.getByLabel("启用聊天容量提示").uncheck()
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    assert.equal(await page.evaluate("window.builtinView().active.builtins.contextMeter"), true)
    await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
    await page.getByText("关闭聊天容量提示", { exact: true }).waitFor()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    assert.equal(await page.evaluate("window.builtinView().active.builtins.contextMeter"), false)
    checks.push(
      "zero-plugin builtin defaults off; enable/disable preview and save/apply snapshots are explicit"
    )

    await mount(
      page,
      `
      profileView.capabilities.push({pluginId:'z',name:'Second',digest:'b'.repeat(64),state:'ready',capabilities:[]});
      window.builtinView=()=>structuredClone(profileView);
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByLabel("选择能力 Demo", { exact: true }).check()
    await page.getByLabel("选择能力 Second", { exact: true }).check()
    assert.equal(await page.getByLabel("上移能力 Demo").isDisabled(), true)
    assert.equal(await page.getByLabel("下移能力 Second").isDisabled(), true)
    await page.getByLabel("上移能力 Second").click()
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    assert.deepEqual(
      await page.evaluate("window.builtinView().active.capabilities.map(c=>c.name)"),
      ["Second", "Demo"]
    )
    await page.getByLabel("下移能力 Second").click()
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
    await page.getByText("调整插件顺序：Demo → Second", { exact: true }).waitFor()
    checks.push("visible move controls preserve and preview the saved capability array order")
    const assets = resolve(__dirname, "../out/renderer/assets")
    for (const file of readdirSync(assets).filter((file) => file.endsWith(".css")))
      await page.addStyleTag({ path: join(assets, file) })
    await page.screenshot({ path: join(output, "builtin-and-order-800.png"), fullPage: true })
    assert.equal(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      true
    )
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
    for (const check of checks) console.log("PASS " + check)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
