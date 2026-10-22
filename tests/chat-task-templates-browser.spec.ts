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
    let quickMount=0,quickHoldList=false,quickListFinish;
    const quickSave=window.api.mods.flowSave,quickList=window.api.mods.flowList;
    window.api.mods.flowSave=async(...args)=>{const rows=structuredClone(definitions.get(args[0])||[]);if(rows.length>=32&&!rows.some(row=>row.definition.id===args[1].id))throw Error('FLOW_DEFINITION_LIMIT');const saved=await quickSave(...args);definitions.set(args[0],[...rows.filter(row=>row.definition.id!==saved.definition.id),saved]);return saved};
    window.api.mods.flowList=async(id)=>{const rows=structuredClone(await quickList(id));if(quickHoldList){quickHoldList=false;await new Promise(resolve=>quickListFinish=resolve)}return rows};
    window.quick={account:()=>{useAppStore.getState().accountRevision++},thread:()=>useAppStore.getState().selectThread('b'),workspace:()=>{useAppStore.getState().threads=useAppStore.getState().threads.map(row=>row.thread_id==='a'?{...row,metadata:{workspacePath:'changed'}}:row)},close:()=>host.render(null),
      reopen:()=>{useAppStore.getState().setShowCustomizeView(true);host.render(<FlowsPanel key={++quickMount} threadId='a'/>)},
      definitions:()=>structuredClone(definitions.get('a')),
      editTest:()=>{const rows=structuredClone(definitions.get('a'));const row=rows.find(item=>item.definition.name==='检视并测试');row.definition.steps[0].modelId='m2';row.definition.steps.find(step=>step.kind==='check').check='e2e';row.revision++;row.digest='edited';definitions.set('a',rows);return structuredClone(row)},
      revoke:()=>{catalog.hostAvailable=false},deferList:()=>{quickHoldList=true;quickListFinish=undefined},listPending:()=>!!quickListFinish,finishList:()=>quickListFinish()};
    host.render(<FlowsPanel threadId='a'/>);`
  const count = (kind: string) =>
    page.evaluate(`window.fixture.calls.filter(row=>row[0]===${JSON.stringify(kind)}).length`)
  try {
    await mount(page, fixture, [], false)
    await page.getByRole("heading", { name: "聊天任务模板", exact: true }).waitFor()
    await page
      .getByText("内置模板无需安装新插件；手工方案也可以使用已安装插件的技能或动作。", {
        exact: false
      })
      .waitFor()
    await page
      .getByText("AutoBiz 等项目已有自己的业务流程，无需在这里重复配置。", { exact: false })
      .waitFor()
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

    const ready = () =>
      page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) => button.textContent?.trim() === "选用并返回聊天" && !button.disabled
        )
      )
    const choose = async (name: string) => {
      const previous = (await page.evaluate("window.fixture.navigation()")).filter(
        (row: unknown[]) => row[0] === false
      ).length
      await page.getByRole("article", { name, exact: true }).getByRole("button").click()
      await page.waitForFunction(
        (expected) =>
          (window as unknown as { fixture: { navigation(): unknown[][] } }).fixture
            .navigation()
            .filter((row) => row[0] === false).length === expected,
        previous + 1
      )
    }
    await mount(page, fixture, [], false)
    for (let index = 0; index < 36; index++) {
      if (index) await page.evaluate("window.quick.reopen()")
      await ready()
      await choose(["只读检视", "检视并测试", "失败修复复测"][index % 3])
    }
    assert.equal(await count("save"), 3)
    assert.equal((await page.evaluate("window.quick.definitions()")).length, 4)
    assert.equal(await count("start"), 0)
    checks.push(
      "36 reopened built-in selections reuse three exact native saved definitions without exhausting 32 slots"
    )

    const edited = await page.evaluate("window.quick.editTest()")
    await page.evaluate("window.quick.reopen()")
    await ready()
    await choose("检视并测试")
    assert.equal(await count("save"), 4)
    const definitions = await page.evaluate("window.quick.definitions()")
    assert.deepEqual(
      definitions.find(
        (row: { definition: { id: string } }) => row.definition.id === edited.definition.id
      ),
      edited
    )
    const selected = definitions.filter(
      (row: { definition: { name: string } }) => row.definition.name === "检视并测试"
    )
    assert.equal(selected.length, 2)
    assert.equal(await count("start"), 0)
    checks.push(
      "same-name model/check edits remain untouched and require an independent default definition"
    )

    for (const change of ["account", "thread", "workspace", "close", "revoke", "editTest"]) {
      await mount(page, fixture, [], false)
      await choose("检视并测试")
      await page.evaluate("window.quick.reopen()")
      await ready()
      await page.evaluate("window.quick.deferList()")
      await page
        .getByRole("article", { name: "检视并测试", exact: true })
        .getByRole("button")
        .click()
      await page.waitForFunction("window.quick.listPending()")
      await page.evaluate(`window.quick.${change}()`)
      if (change === "close") await page.locator("[data-diy-flows]").waitFor({ state: "detached" })
      await page.evaluate("window.quick.finishList()")
      if (change === "revoke")
        await page.getByRole("alert").filter({ hasText: "开启灵件功能" }).waitFor()
      else if (change === "editTest")
        await page.getByRole("alert").filter({ hasText: "版本或内容已变化" }).waitFor()
      else await page.waitForTimeout(100)
      assert.equal(await count("save"), 1, `${change}: reuse must not save another definition`)
      assert.equal(await count("start"), 0, `${change}: selection must not start execution`)
      const navigation = await page.evaluate("window.fixture.navigation()")
      assert.equal(
        navigation.filter((row: unknown[]) => row[0] === false).length,
        1,
        `${change}: stale reuse must not navigate: ${JSON.stringify(navigation)}`
      )
    }
    checks.push(
      "fresh reuse reads reject late account/thread/workspace/closed-panel changes, revoked permission and changed saved revision"
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
