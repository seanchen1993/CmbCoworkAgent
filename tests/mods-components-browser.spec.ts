/** Real React component selection with controlled IPC; production authority has separate Electron coverage. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, "../output/mods-components-browser")
  mkdirSync(output, { recursive: true })
  const checks: string[] = []
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10000)
  try {
    await mount(
      page,
      `
      profileView.capabilities[0].components=[
        {id:'core',name:'基础',kind:'module',entry:'core.ts',dependsOn:[],actionIds:[]},
        {id:'review',name:'检视',kind:'module',entry:'review.ts',dependsOn:['core'],actionIds:['review'],configSchema:{type:'object',properties:{strict:{type:'boolean',title:'严格'},count:{type:'integer',title:'次数'},note:{type:'string',title:'备注'}},required:['strict']}},
        {id:'rewrite',name:'改写',kind:'module',entry:'rewrite.ts',dependsOn:[],actionIds:[]}
      ];
      profileView.capabilities.push({pluginId:'legacy',name:'Legacy',digest:'b'.repeat(64),state:'ready',capabilities:[]});
      window.componentsFixture={stale:()=>{profileView.capabilities[0].digest='c'.repeat(64);for(const fn of configurationListeners)fn()}};
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByLabel("选择能力 Demo", { exact: true }).check()
    await page.getByLabel("组件范围 Demo").selectOption("selected")
    await page.getByLabel("选择组件 Demo · 改写").uncheck()
    await page.getByLabel("选择组件 Demo · 基础").uncheck()
    await page.getByRole("button", { name: "加入所需依赖", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "加入所需依赖", exact: true }).click()
    assert.equal(await page.getByLabel("选择组件 Demo · 基础").isChecked(), true)
    assert.equal(await page.getByLabel("选择组件 Demo · 改写").isChecked(), false)
    checks.push(
      "explicit dependency repair includes required base without restoring excluded components"
    )
    const title = "组件配置 Demo · 检视"
    await page.getByRole("button", { name: title + "：JSON", exact: true }).click()
    await page
      .getByLabel(title, { exact: true })
      .fill('{"strict":false,"count":0,"note":"","unknown":{"keep":true}}')
    await page.getByRole("button", { name: title + "：表单", exact: true }).click()
    assert.equal(await page.getByLabel(title + " · 严格", { exact: true }).inputValue(), "false")
    assert.equal(await page.getByLabel(title + " · 次数", { exact: true }).inputValue(), "0")
    await page.getByLabel(title + " · 次数", { exact: true }).fill("-")
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: title + "：JSON", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled(),
      true
    )
    await page.getByLabel(title, { exact: true }).fill("{")
    page.once("dialog", (dialog) => dialog.dismiss())
    await page.getByLabel("选择能力 Demo", { exact: true }).click()
    assert.equal(await page.getByLabel("选择能力 Demo", { exact: true }).isChecked(), true)
    assert.equal(await page.getByLabel(title, { exact: true }).inputValue(), "{")
    await page
      .getByLabel(title, { exact: true })
      .fill('{"strict":false,"count":0,"note":"","unknown":{"keep":true}}')
    await page.getByLabel("选择能力 Legacy", { exact: true }).check()
    await page.getByText("使用全部功能 · 此灵件不支持单独选择功能。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
    const profile = await page.evaluate(
      "window.fixture.calls.find(c=>c[0]==='claw'&&c[1].kind==='save')[1].profile"
    )
    assert.deepEqual(profile.capabilities[0].components, {
      mode: "selected",
      ids: ["core", "review"],
      config: { review: { strict: false, count: 0, note: "", unknown: { keep: true } } }
    })
    assert.equal(Object.hasOwn(profile.capabilities[1], "components"), false)
    checks.push(
      "invalid numeric/JSON drafts block save; rejected removal preserves draft; false/0/empty/unknown config survives save and apply; legacy stays whole"
    )
    await page.setViewportSize({ width: 800, height: 900 })
    const assets = resolve(__dirname, "../out/renderer/assets")
    for (const file of readdirSync(assets).filter((file) => file.endsWith(".css")))
      await page.addStyleTag({ path: join(assets, file) })
    await page.screenshot({ path: join(output, "components-800.png"), fullPage: true })
    assert.equal(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      true
    )
    checks.push("800px component editor has no horizontal overflow")
    await page.evaluate("window.componentsFixture.stale()")
    await page.getByText("来源版本已改变，请重新选择并核对组件配置。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled(),
      true
    )
    assert.equal(
      await page.getByLabel(title, { exact: true }).inputValue(),
      '{"strict":false,"count":0,"note":"","unknown":{"keep":true}}'
    )
    checks.push("catalog digest change blocks stale configuration without replacing user draft")
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
