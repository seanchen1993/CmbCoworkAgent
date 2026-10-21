import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, "../output/mods-integrated-ux-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const styles = async () => {
    const assets = resolve(__dirname, "../out/renderer/assets")
    for (const file of readdirSync(assets).filter((name) => name.endsWith(".css")))
      await page.addStyleTag({ path: join(assets, file) })
  }
  try {
    await mount(
      page,
      `window.bumpClaw=()=>{profileView.revision++;for(const fn of configurationListeners)fn()};host.render(<ClawPanel threadId='a'/>);`
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByLabel("选择能力 Demo").check()
    await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
    await page.getByRole("button", { name: "添加检查要求", exact: true }).click()
    await page.getByLabel("附加模式 Demo").selectOption("report")
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await page.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>c[0]==='claw'&&c[1].kind==='apply').length"
      ),
      0
    )
    await page.getByRole("region", { name: "应用变化预览" }).waitFor()
    await page.getByText("调整组合的额外完成检查", { exact: true }).waitFor()
    await page.evaluate("window.bumpClaw()")
    await page.getByText("配置已变化，请关闭后重新预览。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "确认应用", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    const mutation = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='claw'&&c[1].kind==='apply').at(-1)[1]"
    )
    assert.equal(mutation.bindingRevision, 0)
    checks.push(
      "preview is read-only; concurrent revision disables apply; refreshed confirmation carries binding CAS; additional report rule persists"
    )
    await styles()
    await page.screenshot({ path: resolve(output, "applied-rules.png"), fullPage: true })

    await mount(
      page,
      `
      profileView.capabilities[0].components=[{id:'review',name:'Review',kind:'module',entry:'review.ts',dependsOn:[],actionIds:[],configSchema:{type:'object',properties:{count:{type:'integer'}},required:['count']}}];
      profileView.active={id:'upgrade',name:'Old selection',capabilities:[{pluginId:'demo',name:'Demo',digest:'b'.repeat(64),components:{mode:'selected',ids:['review'],config:{review:{count:0}}}}]};
      window.activeClaw=()=>profileView.active;host.render(<ClawPanel threadId='a'/>);
    `
    )
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByRole("button", { name: "检查灵件版本", exact: true }).click()
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    const repaired = await page.evaluate(
      "window.fixture.calls.find(c=>c[0]==='claw'&&c[1].kind==='save')[1].profile"
    )
    assert.equal(repaired.capabilities[0].digest, "a".repeat(64))
    assert.deepEqual(repaired.capabilities[0].components, {
      mode: "selected",
      ids: ["review"],
      config: { review: { count: 0 } }
    })
    assert.equal(await page.evaluate("window.activeClaw().capabilities[0].digest"), "b".repeat(64))
    checks.push(
      "authorized upgrade keeps component/config and leaves active frozen profile unchanged"
    )

    await mount(page, `host.render(<FlowsPanel threadId='a'/>);`)
    await page.getByText("为下一条聊天选一个执行顺序，返回聊天后输入目标并发送。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "新建代码检视流程", exact: true }).isEnabled(),
      true
    )
    assert.equal(
      await page
        .getByText("项目要求的完成检查和人工确认仍会执行。关闭配置页面不会停止任务。", {
          exact: true
        })
        .isVisible(),
      false
    )
    await page.getByRole("button", { name: "聊天任务模板说明", exact: true }).click()
    assert.equal(
      await page
        .getByText("项目要求的完成检查和人工确认仍会执行。关闭配置页面不会停止任务。", {
          exact: true
        })
        .isVisible(),
      true
    )
    await page
      .getByText(
        "点击“选用并返回聊天”会保存并选择模板。随后在原聊天输入目标并发送，才会按模板执行。",
        {
          exact: true
        }
      )
      .waitFor()
    await page.keyboard.press("Escape")
    checks.push(
      "a host-available catalog enables flow creation; help explains explicit task start and preserved project checks and approval"
    )
    await page.getByRole("button", { name: "Flow a", exact: true }).click()
    const step = page.locator('[data-flow-step="review"]')
    await step.getByRole("button", { name: /^配置步骤：/ }).click()
    await step.getByLabel("模型选择方式").selectOption("fixed")
    await step.getByLabel("模型选择方式").selectOption("role")
    await step.getByLabel("助手组合中的模型分工").fill("review")
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    const saved = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='save').at(-1)[2].steps.find(s=>s.id==='review')"
    )
    assert.equal(saved.modelRole, "review")
    assert.equal(saved.modelId, undefined)
    checks.push(
      "model mode is exclusive and clearing fixed selection restores explicit role binding"
    )

    await mount(
      page,
      `host.render(<FlowRunView run={{id:'r',threadId:'a',workspace:'a',status:'complete',flow:saved('a'),startedAt:1,epoch:1,attempts:[{executionId:'e',stepId:'test',attempt:1,epoch:0,status:'passed',startedAt:1,invalidated:true,result:{source:'native-check',check:'unit-test',passed:true,summary:'old pass',evidenceIds:['old']}}],failureCounts:{},summary:'流程已完成'}} busy={false} onDecide={()=>{}} onCancel={()=>{}}/>);`
    )
    await page.getByText("测试记录", { exact: true }).click()
    await page
      .getByText("尚无可确认的项目测试结果，不能据此认为测试通过。", {
        exact: true
      })
      .waitFor()
    await page.getByText("1 条旧测试记录已失效，仅供追溯。", { exact: true }).waitFor()
    checks.push("completed flow cannot present invalidated native PASS as current evidence")
    await styles()
    await page.screenshot({ path: resolve(output, "stale-evidence.png"), fullPage: true })
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
    console.log(JSON.stringify({ checks, errors }))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
