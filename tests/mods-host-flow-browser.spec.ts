/** Real React journey; authority and real execution are separately tested in production Electron. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

const root = resolve(__dirname, "..")
const output = join(root, "output/mods-host-flow-browser")
const checks: string[] = []
const pass = (message: string) => {
  checks.push(message)
  console.log("PASS " + message)
}

async function main() {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
    headless: true
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      catalog.plugins=[];catalog.actions=[];profileView.capabilities=[];definitions.set('a',[]);
      const save=window.api.mods.flowSave;
      window.api.mods.flowSave=async(...args)=>{const result=await save(...args);result.digest='a'.repeat(64);return result};
      const change=window.api.mods.clawChange;
      window.api.mods.clawChange=async(...args)=>{const result=await change(...args);if(args[1].kind==='apply'){profileView.bindingRevision++;result.bindingRevision=profileView.bindingRevision}return result};
      window.hostFlow={off:()=>catalog.hostAvailable=false,wrongVersion:()=>definitions.get('a')[0].revision++};
      host.render(<FlowsPanel threadId='a'/>);`
    )
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
    assert.equal(await page.getByLabel("所属插件", { exact: true }).count(), 0)
    await page.getByText("由应用运行", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "添加Autobiz 阶段推进", exact: true }).count(),
      0
    )
    await page.getByRole("button", { name: "添加真实检查", exact: true }).click()
    assert.deepEqual(
      await page.getByLabel("检查内容", { exact: true }).locator("option").allTextContents(),
      ["单元测试", "E2E"]
    )
    await page
      .locator("[data-flow-step]")
      .last()
      .getByRole("button", { name: "删除步骤", exact: true })
      .click()
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    await page.getByText("已保存版本 v1，可开始运行。", { exact: true }).waitFor()
    const definition = await page.evaluate("window.fixture.calls.find(c=>c[0]==='save')[2]")
    assert.equal(definition.schemaVersion, 2)
    assert.deepEqual(definition.execution, { kind: "host" })
    assert.equal(Object.hasOwn(definition, "plugin"), false)
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
    await page.getByRole("button", { name: "运行已保存版本", exact: true }).click()
    await page.getByRole("region", { name: "人工成果确认" }).waitFor()
    await page.getByRole("button", { name: "同意并继续", exact: true }).click()
    pass(
      "zero plugins: default v2 saves without owner; only supported nodes; save does not execute; explicit direct run starts"
    )

    await page.evaluate("window.fixture.profile()")
    await page.getByLabel("助手组合名称").fill("零插件流程 Claw")
    await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
    await page.getByLabel("组合使用的流程").selectOption(`${definition.id}:1`)
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
    await page.getByText("当前组合：零插件流程 Claw", { exact: true }).waitFor()
    const profile = await page.evaluate(
      "window.fixture.calls.find(c=>c[0]==='claw'&&c[1].kind==='save')[1].profile"
    )
    assert.deepEqual(profile.capabilities, [])
    assert.equal(profile.flow.definition.schemaVersion, 2)
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart').length"),
      0
    )
    await page.evaluate("window.fixture.chat('a',true)")
    await page.waitForFunction("window.chat.choice?.bindingRevision===1")
    await page.getByRole("button", { name: "发送聊天", exact: true }).waitFor()
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
    await page.getByLabel("聊天消息").fill("实际检视当前改动")
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(c=>c[0]==='clawStart')")
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart').length"),
      1
    )
    pass(
      "empty capability Claw binds and applies host snapshot; explicit chat flow intent calls bound start exactly once"
    )

    await mount(
      page,
      `catalog.plugins=[];catalog.hostAvailable=true;
      const hostDefinition={...definition('host'),schemaVersion:2,execution:{kind:'host'}};delete hostDefinition.plugin;
      definitions.set('a',[{definition:hostDefinition,revision:1,digest:'a'.repeat(64),updatedAt:1}]);
      window.hostFlow={off:()=>catalog.hostAvailable=false,wrongVersion:()=>definitions.get('a')[0].revision++};
      host.render(<ChatFixture id='a'/>);`
    )
    await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
    await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_host:1")
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
    await page.evaluate("window.hostFlow.off()")
    await page.getByLabel("聊天消息").fill("保留输入")
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    await page
      .getByText("应用流程暂不可运行，请确认 Mods 开关与当前项目。", { exact: true })
      .waitFor()
    assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留输入")
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
    await page.evaluate("window.hostFlow.wrongVersion()")
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    await page.getByText(/流程已更新或移除/).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
    pass(
      "host eligibility and version are rechecked at submit; failed preflight retains task and starts nothing"
    )

    await mount(page)
    await page.getByRole("button", { name: "Flow a · v1", exact: true }).click()
    assert.equal(await page.getByLabel("所属插件", { exact: true }).inputValue(), "demo")
    await page.getByLabel("流程名称", { exact: true }).fill("Legacy renamed")
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    await page.getByText("已保存版本 v2，可开始运行。", { exact: true }).waitFor()
    const old = await page.evaluate("window.fixture.calls.find(c=>c[0]==='save')[2]")
    assert.equal(old.schemaVersion, 1)
    assert.equal(old.plugin, "demo")
    assert.equal(Object.hasOwn(old, "execution"), false)
    await page.evaluate("window.fixture.revoke()")
    await page.getByRole("button", { name: "刷新项目状态", exact: true }).click()
    await page.waitForFunction("document.querySelector('[aria-label=\"所属插件\"]')!==null")
    assert(await page.getByRole("button", { name: "运行已保存版本", exact: true }).isDisabled())
    pass(
      "legacy editing keeps schema and owner; revocation never converts old flow into host execution"
    )

    await mount(
      page,
      "catalog.plugins=[];catalog.actions=[];definitions.set('a',[]);host.render(<FlowsPanel threadId='a'/>);"
    )
    const assets = join(root, "out/renderer/assets")
    const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
    assert(css)
    await page.addStyleTag({ path: join(assets, css) })
    await page.setViewportSize({ width: 800, height: 950 })
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
    await page.getByText("由应用运行", { exact: true }).waitFor()
    assert(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"))
    await page.screenshot({ path: join(output, "zero-plugins-800.png"), fullPage: true })
    pass(
      "800px first use shows application execution without owner or plugin installation prerequisite"
    )
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
