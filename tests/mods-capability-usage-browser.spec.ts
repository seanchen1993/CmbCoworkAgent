/** Actual React surfaces with isolated IPC fixtures; no installed plugins or user data. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/mods-capability-usage-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const fixture = `
    profileView.capabilities[0].components=[
      {id:'base',name:'通用检查',kind:'module',entry:'base.ts',dependsOn:[],actionIds:[]},
      {id:'chat',name:'对话助手',kind:'module',entry:'chat.ts',usage:'chat',dependsOn:['base'],actionIds:[]},
      {id:'project',name:'项目检查',kind:'module',entry:'project.ts',usage:'project',dependsOn:['base'],actionIds:[]}
    ];
    window.usageFixture={project:()=>{profileView.usageContext='project';for(const fn of configurationListeners)fn()}};
  `
  try {
    await mount(page, fixture + "host.render(<ClawPanel threadId='a'/>);")
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByLabel("选择能力 Demo", { exact: true }).check()
    await page.getByLabel("选择组件 Demo · 对话助手").waitFor()
    assert.equal(await page.getByLabel("选择组件 Demo · 项目检查").count(), 0)
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    const saved = await page.evaluate(
      "window.fixture.calls.find(c=>c[0]==='claw'&&c[1].kind==='save')[1].profile"
    )
    assert.deepEqual(saved.capabilities[0].components.ids, ["base", "chat"])
    assert.equal(saved.capabilities[0].components.mode, "selected")
    await page.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>c[0]==='claw'&&c[1].kind==='apply').length"
      ),
      0
    )
    await page.evaluate("window.usageFixture.project()")
    await page.getByText(/当前项目无法使用：对话助手/).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "确认应用", exact: true }).isDisabled(),
      true
    )
    assert.equal(await page.getByLabel("选择组件 Demo · 对话助手").isChecked(), true)
    await page.screenshot({ path: join(output, "changed-context.png"), fullPage: true })

    await mount(
      page,
      fixture +
        `
      profileView.usageContext='project';
      profileView.profiles=[{id:'old',name:'旧全部选择',capabilities:[{pluginId:'demo',name:'Demo',digest:'a'.repeat(64),components:{mode:'all',ids:[],config:{}}}]}];
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByRole("button", { name: "旧全部选择", exact: true }).click()
    await page.getByText(/当前项目无法使用：对话助手/).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled(),
      true
    )
    await page.getByLabel("组件范围 Demo").selectOption("all")
    assert.equal(await page.getByLabel("选择组件 Demo · 对话助手").count(), 0)
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    const repaired = await page.evaluate(
      "window.fixture.calls.find(c=>c[0]==='claw'&&c[1].kind==='save')[1].profile"
    )
    assert.deepEqual(repaired.capabilities[0].components.ids, ["base", "project"])
    assert.equal(repaired.capabilities[0].components.mode, "selected")
    await mount(
      page,
      fixture +
        `
      profileView.usageContext='project';
      profileView.profiles=[{id:'old',name:'旧未声明选择',capabilities:[{pluginId:'demo',name:'Demo',digest:'a'.repeat(64)}]}];
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByRole("button", { name: "旧未声明选择", exact: true }).click()
    await page.getByText(/当前项目无法使用：对话助手/).waitFor()
    assert(await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled())
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "chat exact selection",
            "confirmation before application",
            "context change retains choices and blocks preview",
            "legacy all explicit repair"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS capability usage browser: chat/project, exact choices, retained legacy all, stale preview"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
