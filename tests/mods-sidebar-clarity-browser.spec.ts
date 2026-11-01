/** Real sidebar/CSS; controlled IPC and runtime facts, no model or business execution. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/mods-sidebar-clarity", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const compiler = await compile(readFileSync(resolve(renderer, "index.css"), "utf8"), {
    base: renderer,
    from: resolve(renderer, "index.css"),
    onDependency() {
      return undefined
    }
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "components/chat/ClawSidebar.tsx",
      "components/customize/ModsUsageSettingsEntry.tsx",
      ...readdirSync(resolve(renderer, "components/ui"))
        .filter((name) => name.endsWith(".tsx"))
        .map((name) => `components/ui/${name}`)
    ].map((path) => ({ content: readFileSync(resolve(renderer, path), "utf8"), extension: "tsx" }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const checks: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      profileView.capabilities=[{pluginId:'delivery',name:'generic-delivery',digest:'a'.repeat(64),state:'ready',capabilities:[]}];
      profileView.active={id:'saved',name:'使用插件 · generic-delivery',capabilities:[{pluginId:'delivery',name:'generic-delivery',digest:'a'.repeat(64)}],skills:{mode:'all',items:[]},mcp:{mode:'all',items:[]},models:{roles:{}}};
      configureAppCatalogLoaders({skills:async()=>({localSkills:[],pluginSkills:[],disabledSkillIds:[]}),plugins:async()=>[{id:'project',name:'我的项目',projectDependencyIds:['delivery']},{id:'delivery',name:'generic-delivery'}]});
      host.render(<ChatFixture id='a'/>);openClawSidebar('configuration');
    `
    )
    await page.addStyleTag({ content: compiler.build(candidates) })
    const sidebar = page.getByLabel("任务进展", { exact: true })
    await sidebar.getByRole("tab", { name: "高级设置", exact: true }).click()
    await sidebar.getByRole("heading", { name: "本聊天可用功能", exact: true }).waitFor()
    assert.equal(await sidebar.getByText("这段聊天正在使用", { exact: true }).count(), 0)
    assert.equal(await sidebar.getByText("未添加灵件，可以照常聊天。", { exact: true }).count(), 0)
    assert.equal(
      await sidebar.getByText("使用插件 · generic-delivery", { exact: true }).isVisible(),
      false
    )
    const dependencies = sidebar
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "项目依赖组件（1）" }) })
      .first()
    await dependencies.locator("summary").click()
    await dependencies.getByText("由 我的项目 引用", { exact: true }).waitFor()
    await dependencies
      .getByText("这些组件由项目引用。可用不代表项目已启动。", { exact: true })
      .waitFor()
    assert.equal(
      await sidebar.getByRole("button", { name: "管理已安装插件", exact: true }).count(),
      1
    )
    checks.push(
      "eligible dependency is attributed to its parent and never presented as an executing project"
    )
    await sidebar.getByRole("button", { name: "管理已安装插件", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.fixture.navigation().at(-1)"), [
      true,
      "mods",
      "installed"
    ])
    await sidebar.getByRole("tab", { name: "输出与面板", exact: true }).click()
    assert.equal(
      await sidebar.getByRole("button", { name: "管理已安装插件", exact: true }).isVisible(),
      false
    )
    await sidebar
      .getByText(
        "查看命令记录和插件提供的交互面板。面板可能是操作入口；它本身不代表任务已完成或通过检查。",
        { exact: true }
      )
      .waitFor()
    checks.push("output explains panel provenance and exposes no unrelated plugin management link")
    await page.setViewportSize({ width: 390, height: 740 })
    await sidebar.getByRole("tab", { name: "高级设置", exact: true }).click()
    await page.screenshot({ path: resolve(output, "narrow-settings.png"), fullPage: true })
    const width = await sidebar.evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth
    }))
    assert(width.content <= width.width + 1)
    await page.getByRole("textbox", { name: "聊天消息", exact: true }).fill("保留我正在写的需求")
    await sidebar.getByRole("button", { name: "用对话创作 Mods", exact: true }).click()
    const input = await page.getByRole("textbox", { name: "聊天消息", exact: true }).inputValue()
    assert(input.includes("保留我正在写的需求") && input.includes("创建独立能力、修改界面或流程"))
    const calls = (await page.evaluate("window.fixture.calls")) as unknown[][]
    assert.equal(calls.filter((row) => row[0] === "creator").length, 1)
    assert.equal(
      calls.filter((row) =>
        ["chat", "claw", "start", "clawStart", "approve"].includes(String(row[0]))
      ).length,
      0
    )
    assert.deepEqual(errors, [])
    checks.push("creator handoff preserves draft and does not send, grant, apply or execute")
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify({ checks, errors, passed: true }, null, 2)
    )
    console.log(
      `PASS sidebar facts, dependency attribution, draft-preserving Mods creation: ${output}`
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
