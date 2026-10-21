import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/chat-task-templates-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
    headless: true
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const fixture = `catalog.unitTest={ready:true,command:'npm run test'};
    window.quick={account:()=>{useAppStore.getState().accountRevision++},thread:()=>useAppStore.getState().selectThread('b'),close:()=>host.render(null)};
    host.render(<FlowsPanel threadId='a'/>);`
  const count = (kind: string) =>
    page.evaluate(`window.fixture.calls.filter(row=>row[0]===${JSON.stringify(kind)}).length`)
  try {
    await mount(page, fixture, [], false)
    await page.getByRole("heading", { name: "聊天任务模板", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "选用并返回聊天", exact: true }).count(), 3)
    assert.equal(
      await page.getByRole("button", { name: "新建代码检视流程", exact: true }).isVisible(),
      false
    )
    await page.getByRole("article", { name: "只读检视", exact: true }).getByRole("button").click()
    await page.waitForFunction("window.fixture.navigation().some(row=>row[0]===false)")
    assert.equal(await count("save"), 1)
    assert.equal(await count("start"), 0)
    const definition = await page.evaluate("window.fixture.calls.find(row=>row[0]==='save')[2]")
    assert.equal(definition.schemaVersion, 2)
    assert.equal(definition.name, "只读检视")
    assert(!("plugin" in definition))
    await page.evaluate("window.fixture.chat('a')")
    await page.waitForFunction("window.chat.choice?.name==='只读检视'")
    await page.waitForFunction("document.activeElement?.classList.contains('composer-textarea')")
    assert.equal(await count("start"), 0)
    checks.push(
      "default three templates save/select/focus the original chat without starting or plugin ownership"
    )

    await mount(
      page,
      `catalog.unitTest={ready:false,reason:'缺少 package.json 的 test:unit / test，请配置后刷新。'};host.render(<FlowsPanel threadId='a'/>);`,
      [],
      false
    )
    await page.getByRole("article", { name: "检视并测试", exact: true }).getByRole("button").click()
    await page
      .getByRole("alert")
      .getByText("缺少 package.json 的 test:unit / test，请配置后刷新。", { exact: true })
      .waitFor()
    assert.equal(await count("save"), 0)
    assert.equal(await count("start"), 0)
    assert.equal((await page.evaluate("window.fixture.navigation()")).length, 0)
    checks.push("missing real test configuration is actionable and never saves/selects/starts")

    await mount(
      page,
      "catalog.hostAvailable=false;host.render(<FlowsPanel threadId='a'/>);",
      [],
      false
    )
    await page.getByRole("article", { name: "只读检视", exact: true }).getByRole("button").click()
    await page.getByRole("alert").filter({ hasText: "开启灵件功能" }).waitFor()
    await page.getByRole("button", { name: "前往开启灵件功能", exact: true }).waitFor()
    assert.equal(await count("save"), 0)
    assert.equal(await count("start"), 0)
    checks.push(
      "disabled application capability requires explicit opt-in and is never granted by template selection"
    )

    for (const change of ["account", "thread", "close"]) {
      await mount(page, fixture, [], false)
      await page.evaluate("window.fixture.deferSave()")
      await page.getByRole("article", { name: "只读检视", exact: true }).getByRole("button").click()
      await page.waitForFunction("window.fixture.calls.some(row=>row[0]==='save')")
      await page.evaluate(`window.quick.${change}()`)
      await page.evaluate("window.fixture.finishSave()")
      await page.waitForTimeout(100)
      assert.equal(
        (await page.evaluate("window.fixture.navigation()")).filter(
          (row: unknown[]) => row[0] === false
        ).length,
        0
      )
      assert.equal(await count("start"), 0)
      await page.evaluate("window.fixture.chat('b')")
      await page.waitForFunction("window.chat.loading===false")
      assert.equal(await page.evaluate("window.chat.choice"), null)
    }
    checks.push(
      "late save after account/chat switch or closed panel cannot select or navigate another chat"
    )

    await mount(page, fixture, [], false)
    await page.getByText("高级：编辑模板与执行记录", { exact: true }).click()
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
    await page.getByLabel("流程名称", { exact: true }).fill("")
    assert.equal(
      await page.getByRole("button", { name: "保存流程", exact: true }).isEnabled(),
      false
    )
    assert.equal(await count("save"), 0)
    checks.push("advanced editor and its actual invalid-definition save guard remain")
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: join(output, "advanced-template-validation.png"),
      fullPage: true
    })
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Real React and chat selection; controlled native IPC fixture; not model or production execution",
          checks,
          errors
        },
        null,
        2
      )
    )
    checks.forEach((check) => console.log("PASS " + check))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
