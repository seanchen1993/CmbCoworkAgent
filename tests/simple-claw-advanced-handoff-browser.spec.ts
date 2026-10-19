import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { chromium, type Page } from "playwright"
import { mount as mountFixture } from "./mods-flow-browser.spec"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { resolveClawActionInput } from "../src/shared/mods/claw-actions"

const mount = (page: Page, body: string) =>
  mountFixture(
    page,
    `
  window.api.plugins={list:async()=>[]};
  window.api.skills={listPlugins:async()=>[]};
  ${body}
`
  )

async function main() {
  const output = resolve("output/ui-ux-20261015/canonical-combination")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 } })
  const renderer = resolve("src/renderer/src")
  const cssPath = join(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "customize/ClawPanel",
      "customize/SimpleClawBuilder",
      "customize/SimpleActionParameters",
      "customize/ClawComponentSelector",
      "customize/ClawSourceSelector",
      "customize/FlowParameterEditor",
      "ui/button"
    ].map((name) => ({
      content: readFileSync(join(renderer, `components/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const styles = () => page.addStyleTag({ content: compiler.build(candidates) })
  const errors: string[] = []
  const checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const calls = () =>
    page.evaluate(
      "window.fixture.calls.filter(c=>['claw','save','start','clawStart'].includes(c[0]))"
    )
  try {
    await mount(
      page,
      `
      profileView.capabilities = ['a','b','c','d'].map(id=>({pluginId:'plugin-'+id,name:'Plugin '+id.toUpperCase(),digest:'a'.repeat(64),state:'ready',capabilities:[]}));
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await styles()
    const simple = page.getByRole("region", { name: "简单组合", exact: true })
    await simple.getByLabel("组合名称", { exact: true }).fill("单功能搭配")
    await simple.getByLabel("Plugin A", { exact: true }).check()
    assert.equal(
      await simple.getByRole("button", { name: "保存并核对应用", exact: true }).isEnabled(),
      true
    )
    await simple.getByLabel("Plugin B", { exact: true }).check()
    await simple.getByLabel("Plugin C", { exact: true }).check()
    await simple.getByLabel("Plugin D", { exact: true }).check()
    await simple.getByRole("button", { name: "在高级编辑中继续此草稿", exact: true }).click()
    assert.equal(await page.getByLabel("助手组合名称", { exact: true }).inputValue(), "单功能搭配")
    for (const id of ["A", "B", "C", "D"])
      assert.equal(
        await page.getByLabel(`选择能力 Plugin ${id}`, { exact: true }).isChecked(),
        true
      )
    await page.getByLabel("助手组合名称", { exact: true }).fill("高级修改后名称")
    await page.getByRole("button", { name: "返回简单配置", exact: true }).click()
    assert.equal(
      await simple.getByLabel("组合名称", { exact: true }).inputValue(),
      "高级修改后名称"
    )
    assert.equal(await simple.getByLabel("Plugin D", { exact: true }).isChecked(), true)
    assert.deepEqual(await calls(), [])
    checks.push(
      "1, 2 and 4 selected functions work; simple and advanced share edits with no save, overwrite dialog or second draft"
    )

    await mount(
      page,
      `window.focusIntents=[];window.addEventListener('devclaw:chat-composer-focus',e=>window.focusIntents.push(e.detail));host.render(<><ClawPanel threadId='a'/><textarea aria-label='唯一聊天输入' className='composer-textarea' defaultValue='原聊天草稿'/></>);`
    )
    await styles()
    const single = page.getByRole("region", { name: "简单组合", exact: true })
    await single.getByLabel("Demo", { exact: true }).check()
    await single.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await single.getByRole("button", { name: "确认应用", exact: true }).click()
    await single.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.focusIntents"), [
      { threadId: "a", workspace: "a" }
    ])
    assert.equal(await page.getByLabel("唯一聊天输入").inputValue(), "原聊天草稿")
    assert.equal(await page.getByRole("region", { name: "准备首次任务", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>['save','start','clawStart'].includes(c[0])).length"
      ),
      0
    )
    checks.push(
      "a single function saves and applies; use requests focus in the selected composer with its original text and no extra preparation or execution"
    )

    await mount(
      page,
      `
      profileView.capabilities[0].components=[{id:'review',name:'Review',kind:'module',entry:'review.ts',dependsOn:[],actionIds:[],configSchema:{type:'object',properties:{count:{type:'integer'}},required:['count']}}];
      profileView.active={id:'raw-draft',name:'Raw draft',capabilities:[{pluginId:'demo',name:'Demo',digest:'a'.repeat(64),components:{mode:'selected',ids:['review'],config:{review:{count:1}}}}]};
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await styles()
    const componentSimple = page.getByRole("region", { name: "简单组合", exact: true })
    await componentSimple
      .getByRole("button", { name: "在高级编辑中继续此草稿", exact: true })
      .click()
    await page
      .getByRole("button", { name: "组件配置 Demo · Review：JSON", exact: true })
      .last()
      .click()
    await page
      .getByRole("textbox", { name: "组件配置 Demo · Review", exact: true })
      .fill('{"count":')
    await page.getByRole("button", { name: "返回简单配置", exact: true }).click()
    assert.equal(
      await componentSimple
        .getByRole("textbox", { name: "组件配置 Demo · Review", exact: true })
        .inputValue(),
      '{"count":'
    )
    assert.equal(
      await componentSimple
        .getByRole("button", { name: "保存并核对应用", exact: true })
        .isDisabled(),
      true
    )
    await componentSimple
      .getByRole("textbox", { name: "组件配置 Demo · Review", exact: true })
      .fill('{"count":3}')
    await componentSimple
      .getByRole("button", { name: "在高级编辑中继续此草稿", exact: true })
      .click()
    assert.equal(
      await page.getByRole("textbox", { name: "组件配置 Demo · Review", exact: true }).inputValue(),
      '{"count":3}'
    )
    assert.deepEqual(await calls(), [])
    checks.push("component raw JSON, invalid state and field modes are canonical across both views")

    await mount(
      page,
      `
      catalog.actions=[{pluginId:'demo',plugin:'Demo',digest:'a'.repeat(64),actionId:'count',name:'数字参数',command:'count',inputSchema:{type:'object',properties:{count:{type:'integer',title:'数量'}},required:['count']}}];
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await styles()
    const numeric = page.getByRole("region", { name: "简单组合", exact: true })
    await numeric.getByLabel("Demo", { exact: true }).check()
    await numeric.getByRole("button", { name: /先后执行/ }).click()
    await numeric.getByLabel("步骤1动作").selectOption("demo:count")
    await numeric.getByLabel("步骤1输入 · 数量", { exact: true }).fill("1e")
    await numeric.getByRole("button", { name: "在高级编辑中继续此草稿", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "返回简单配置", exact: true }).click()
    assert.equal(await numeric.getByLabel("步骤1输入 · 数量", { exact: true }).inputValue(), "1e")
    await numeric.getByLabel("步骤1输入 · 数量", { exact: true }).fill("2")
    await numeric.getByRole("button", { name: "在高级编辑中继续此草稿", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: "保存组合", exact: true }).isEnabled(),
      true
    )
    assert.deepEqual(await calls(), [])
    checks.push(
      "an incomplete numeric step draft survives switching views and blocks either save until corrected"
    )

    await mount(
      page,
      `window.readProfile=()=>structuredClone(profileView);host.render(<ClawPanel threadId='a'/>);`
    )
    await styles()
    const checkpointSimple = page.getByRole("region", { name: "简单组合", exact: true })
    await checkpointSimple.getByLabel("Demo", { exact: true }).check()
    await checkpointSimple
      .getByRole("button", { name: "在高级编辑中继续此草稿", exact: true })
      .click()
    await page.getByLabel("助手组合名称", { exact: true }).fill("Checkpoint 保存核对")
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "搭配已保存，尚未应用" }).waitFor()
    const firstProfileSaveCount = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='claw').length"
    )
    await page.evaluate("window.fixture.sessionView({profiles:[],revision:2})")
    await page
      .getByRole("button", { name: "应用到所选聊天", exact: true })
      .waitFor({ state: "detached" })
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.waitForFunction("window.readProfile().profiles.length === 1")
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').length"),
      firstProfileSaveCount + 1
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].revision"),
      2
    )
    await page.evaluate(
      "window.fixture.sessionView({profiles:[{...window.readProfile().profiles[0],name:'外部修改的搭配'}],revision:4})"
    )
    await page.getByRole("button", { name: "外部修改的搭配", exact: true }).waitFor()
    assert.equal(
      await page.getByLabel("助手组合名称", { exact: true }).inputValue(),
      "Checkpoint 保存核对"
    )
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.waitForFunction("window.readProfile().profiles[0]?.name === 'Checkpoint 保存核对'")
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').length"),
      firstProfileSaveCount + 2
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].revision"),
      4
    )
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').length"),
      firstProfileSaveCount + 2
    )
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>c[0]==='save'||c[0]==='start'||c[0]==='clawStart'||c[0]==='claw'&&c[1].kind==='apply').length"
      ),
      0
    )
    checks.push(
      "advanced save rechecks its acknowledged profile against current saved state: deleted or changed profiles save again with current CAS; unchanged profiles avoid duplicate save"
    )

    await mount(
      page,
      `
      const schema={type:'object',properties:{path:{type:'string',title:'文件路径',minLength:1,maxLength:240}},required:['path'],additionalProperties:false};
      catalog.actions=[{pluginId:'demo',plugin:'Demo',digest:'a'.repeat(64),actionId:'path',name:'文件动作',command:'path',inputSchema:schema,outputSchema:schema}];
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await styles()
    const binding = page.getByRole("region", { name: "简单组合", exact: true })
    await binding.getByLabel("Demo", { exact: true }).check()
    await binding.getByRole("button", { name: /先后执行/ }).click()
    await binding.getByLabel("步骤1动作").selectOption("demo:path")
    await binding.getByLabel("步骤1输入 · 文件路径", { exact: true }).fill("src/producer.ts")
    await binding.getByRole("button", { name: "添加步骤", exact: true }).click()
    await binding.getByLabel("步骤2动作").selectOption("demo:path")
    await binding.getByLabel("步骤2输入 · 文件路径", { exact: true }).fill("src/manual.ts")
    await binding.getByLabel("步骤2输入来源").selectOption(JSON.stringify(["step-1", ""]))
    const fixedPath = binding.getByLabel("步骤2输入 · 文件路径", { exact: true })
    assert.equal(await fixedPath.isVisible(), true)
    assert.equal(await fixedPath.inputValue(), "src/manual.ts")
    await binding
      .getByText("先使用前置步骤的实际结果；下方固定值会覆盖同名字段。", { exact: true })
      .waitFor()
    await fixedPath.fill("src/explicit-override.ts")
    await binding.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await binding.getByRole("region", { name: "简单组合应用预览", exact: true }).waitFor()
    const withOverride = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='save').at(-1)[2].steps[1]"
    )
    assert.equal(
      resolveClawActionInput(
        withOverride.input,
        { path: "src/actual-result.ts" },
        withOverride.inputFrom.path
      ).path,
      "src/explicit-override.ts"
    )
    page.once("dialog", (dialog) => dialog.dismiss())
    await binding.getByRole("button", { name: "清除固定覆盖值", exact: true }).click()
    assert.equal(await fixedPath.inputValue(), "src/explicit-override.ts")
    page.once("dialog", (dialog) => dialog.accept())
    await binding.getByRole("button", { name: "清除固定覆盖值", exact: true }).click()
    assert.equal(await fixedPath.isDisabled(), true)
    assert.equal(
      await binding.getByLabel("步骤2输入来源").inputValue(),
      JSON.stringify(["step-1", ""])
    )
    await binding.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await binding.getByRole("region", { name: "简单组合应用预览", exact: true }).waitFor()
    const inherited = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='save').at(-1)[2].steps[1]"
    )
    assert.deepEqual(inherited.input, {})
    assert.equal(
      resolveClawActionInput(
        inherited.input,
        { path: "src/actual-result.ts" },
        inherited.inputFrom.path
      ).path,
      "src/actual-result.ts"
    )
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').at(-1)[3]"), 1)
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>c[0]==='start'||c[0]==='clawStart'||c[0]==='claw'&&c[1].kind==='apply').length"
      ),
      0
    )
    checks.push(
      "bound steps disclose and edit fixed overrides; cancelling clear preserves them, confirmed clear inherits actual upstream output as verified by the real resolver"
    )

    const actions = [
      JSON.parse(readFileSync("examples/autobiz-fullstack-mods/mods/manifest.json", "utf8")).claw
        .actions[0],
      JSON.parse(readFileSync("examples/mods-review-agent/plugin.json", "utf8")).claw.actions[0]
    ].map((action, index) => ({
      ...action,
      actionId: action.id,
      pluginId: index ? "review" : "autobiz",
      plugin: index ? "Review" : "AutoBiz",
      digest: "a".repeat(64)
    }))
    await mount(
      page,
      `
      catalog.actions=${JSON.stringify(actions)};
      profileView.capabilities=catalog.actions.map(action=>({pluginId:action.pluginId,name:action.plugin,digest:action.digest,state:'ready',capabilities:[],actions:[action]}));
      profileView.active={id:'sequence-draft',name:'顺序草稿',capabilities:[],models:{default:'m2',roles:{review:'m2'}}};
      host.render(<ClawPanel threadId='a'/>);
    `
    )
    await styles()
    const sequence = page.getByRole("region", { name: "简单组合", exact: true })
    await sequence.getByLabel("AutoBiz", { exact: true }).check()
    await sequence.getByLabel("Review", { exact: true }).check()
    await sequence.getByRole("button", { name: /先后执行/ }).click()
    await sequence.getByLabel("步骤1动作").selectOption("autobiz:prepare-review")
    await sequence.getByLabel(/真实 Feature ID/).fill("REAL-REQ-1")
    await sequence.getByLabel(/项目相对文件路径/).fill("src/cart.ts")
    for (const index of [2, 3, 4]) {
      await sequence.getByRole("button", { name: "添加步骤", exact: true }).click()
      await sequence.getByLabel(`步骤${index}动作`).selectOption("review:review-input")
      await sequence.getByLabel(`步骤${index}输入来源`).selectOption(JSON.stringify(["step-1", ""]))
    }
    await sequence.getByRole("button", { name: "在高级编辑中继续此草稿", exact: true }).click()
    assert.deepEqual(await calls(), [])
    await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
    await page.getByText("高级：编辑本份执行步骤定义", { exact: true }).click()
    const rawFlow = page.getByRole("textbox", { name: "执行步骤定义草稿", exact: true })
    const unsaved = JSON.parse(await rawFlow.inputValue())
    assert.equal(unsaved.steps.length, 4)
    assert.equal(unsaved.steps[0].input.feature, "REAL-REQ-1")
    assert.equal(unsaved.steps[3].inputFrom.stepId, "step-1")
    unsaved.steps[0].input.path = "src/advanced-edit.ts"
    await rawFlow.fill(JSON.stringify(unsaved, null, 2))
    await page.getByRole("button", { name: "返回简单配置", exact: true }).click()
    assert.equal(await sequence.getByLabel(/项目相对文件路径/).inputValue(), "src/advanced-edit.ts")
    page.once("dialog", (dialog) => dialog.accept())
    await sequence.getByRole("button", { name: "移除步骤 3", exact: true }).click()
    await page.setViewportSize({ width: 375, height: 760 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await sequence.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await page.getByRole("region", { name: "简单组合应用预览" }).waitFor()
    const saved = await page.evaluate("window.fixture.calls.find(c=>c[0]==='save')[2]")
    assert.equal(saved.steps.length, 3)
    assert.equal(saved.steps[0].input.path, "src/advanced-edit.ts")
    assert.equal(saved.steps[2].inputFrom.stepId, "step-1")
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').length"), 1)
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>c[0]==='claw'&&c[1].kind==='save').length"
      ),
      1
    )
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>['start','clawStart'].includes(c[0])||c[0]==='claw'&&c[1].kind==='apply').length"
      ),
      0
    )
    await page.screenshot({ path: join(output, "canonical-sequence-375.png"), fullPage: true })
    checks.push(
      "four steps with arbitrary prior bindings; advanced raw edit returns intact; remove and save three steps with genuine receipt and no implicit apply/start; 375 px"
    )
    await sequence.getByLabel("组合名称", { exact: true }).fill("跨视图失败恢复")
    await page.evaluate(`(() => {
      const original = window.api.mods.clawChange
      let fail = true
      window.api.mods.clawChange = async (...args) => {
        if (fail && args[1].kind === 'save') { fail = false; throw Error('profile phase unavailable') }
        return original(...args)
      }
    })()`)
    const beforeFlows = await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').length")
    await sequence.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await sequence.getByRole("alert").filter({ hasText: "profile phase unavailable" }).waitFor()
    await sequence.getByRole("button", { name: "在高级编辑中继续此草稿", exact: true }).click()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').length"),
      beforeFlows + 1
    )
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "搭配已保存，尚未应用" }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').length"),
      beforeFlows + 1
    )
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>['start','clawStart'].includes(c[0])).length"
      ),
      0
    )
    checks.push(
      "flow-save success and profile-save failure resume in the other view using the same acknowledged receipt without replaying flowSave"
    )
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "evidence.json"), JSON.stringify({ checks, errors }, null, 2))
    checks.forEach((check) => console.log(`PASS ${check}`))
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
