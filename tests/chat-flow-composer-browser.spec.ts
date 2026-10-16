/** Current real controls/controller/CSS; native IPC is an explicit bounded fixture. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { chooseSteps, mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/ui-flow-composer", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const index = resolve("src/renderer/src/index.css")
  const styles = await compile(readFileSync(index, "utf8"), {
    base: dirname(index),
    onDependency: () => undefined
  })
  const files = [
    "components/chat/ChatFlowControls.tsx",
    "components/chat/ChatFlowTaskCards.tsx",
    "components/chat/ClawSidebar.tsx",
    "components/customize/FlowRunView.tsx",
    "components/customize/FlowStepProgress.tsx",
    "components/ui/button.tsx",
    "components/ui/popover.tsx"
  ]
  const candidates = new Scanner({}).scanFiles(
    files.map((file) => ({
      content: readFileSync(resolve("src/renderer/src", file), "utf8"),
      extension: "tsx"
    }))
  )
  const css = styles.build(candidates)
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const setup = async (extra = "") => {
    await mount(page, `${extra};host.render(<ChatFixture id='a'/>);`, [
      {
        name: "no-native-approval-question",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread-context",
            namespace: "no-native-question"
          }))
          builder.onLoad({ filter: /.*/, namespace: "no-native-question" }, () => ({
            contents: "export const useThreadStateSelector=()=>false"
          }))
        }
      }
    ])
    await page.addStyleTag({ content: css })
    await page.addStyleTag({
      content:
        "#root{max-width:800px;margin:auto;padding:12px}.composer-textarea{display:block;width:100%;min-height:80px}"
    })
    await page.waitForFunction("window.chat.binding?.workspace==='a'")
  }
  const choose = async (value = "flow_a:1") => {
    await chooseSteps(page, value)
  }
  const send = async (text: string) => {
    await page.getByLabel("聊天消息", { exact: true }).fill(text)
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  }
  const calls = (type: string) =>
    page.evaluate(`window.fixture.calls.filter(c=>c[0]===${JSON.stringify(type)}).length`)
  try {
    await setup()
    await page.evaluate("window.fixture.bindFlow()")
    await page.waitForFunction("window.chat.binding?.bindingRevision===7")
    assert.equal(
      await page.evaluate("window.chat.choice"),
      null,
      "Applying a binding never changes send intent"
    )
    await page.getByLabel("聊天消息").fill("原本的普通消息")
    await page.getByRole("button", { name: "发送聊天", exact: true }).click()
    assert.equal(await calls("chat"), 1)
    assert.equal(await calls("clawStart"), 0)
    await choose("claw:7")
    await page.getByLabel("聊天消息").fill("取消前的原草稿")
    await page.getByRole("button", { name: "改为普通发送", exact: true }).click()
    assert.equal(await page.getByLabel("聊天消息").inputValue(), "取消前的原草稿")
    assert.equal(await page.locator("[data-chat-flow] textarea").count(), 0)
    checks.push(
      "ordinary-send-and-bound-profile-never-auto-start; explicit-choice-cancel-preserves-single-draft"
    )

    await setup()
    await choose()
    await send("检查订单导出")
    await page.getByRole("region", { name: "人工成果确认" }).waitFor()
    assert.equal(await calls("start"), 1)
    assert.equal(await page.evaluate("window.chat.choice"), null)
    const task = page.locator("[data-chat-task-id='run1']")
    await task.evaluate((element) => {
      ;(window as unknown as { originalTask: Element }).originalTask = element
    })
    await page.evaluate("window.chat.act('approve',{runId:'run1',nonce:'stale'})")
    assert.equal(await calls("decide"), 0)
    await page.evaluate("for(let i=0;i<100;i++)window.fixture.emit('a')")
    await page.waitForFunction("!window.chat.busy")
    assert(
      await task.evaluate(
        (element) => element === (window as unknown as { originalTask: Element }).originalTask
      )
    )
    await task.getByRole("button", { name: "同意并继续", exact: true }).click()
    await page.waitForFunction("window.chat.run.status==='complete'")
    assert(
      await task.evaluate(
        (element) => element === (window as unknown as { originalTask: Element }).originalTask
      )
    )
    await task.getByText("成果已确认", { exact: true }).waitFor()
    await page.getByLabel("聊天消息").fill("下一条恢复普通发送")
    await page.getByRole("button", { name: "发送聊天", exact: true }).click()
    assert.equal(await calls("start"), 1)
    assert.equal(await calls("chat"), 1)
    assert.equal(await task.count(), 1)
    checks.push(
      "real-run-id-card-retains-DOM-through-100-events-approval-and-completion; nonce-fence; next-send-ordinary"
    )

    await setup()
    await choose()
    await page.evaluate("window.fixture.updateVersion('a')")
    await send("版本拒绝后必须保留的输入")
    await page
      .getByText(/流程已更新或移除/)
      .first()
      .waitFor()
    assert.equal(await page.getByLabel("聊天消息").inputValue(), "版本拒绝后必须保留的输入")
    assert.equal(await calls("start"), 0)
    checks.push("stale-version-rejects-with-input-and-explicit-selection-retained")

    await setup()
    await choose()
    await send("等待实际清理后停止")
    await page.getByRole("region", { name: "人工成果确认" }).waitFor()
    await page.evaluate(`window.stopCalls=0;const original=window.api.mods.flowCancel;
      window.api.mods.flowCancel=async(...args)=>{window.stopCalls++;await new Promise(resolve=>window.finishStop=resolve);return original(...args)}`)
    await page
      .locator("[data-chat-flow-tasks]")
      .getByRole("button", { name: "停止任务", exact: true })
      .click()
    await page
      .locator("[data-chat-flow-tasks]")
      .getByRole("button", { name: "正在停止", exact: true })
      .waitFor()
    assert.equal(await page.evaluate("window.chat.run.status"), "waiting")
    assert.equal(await page.evaluate("window.stopCalls"), 1)
    await page.evaluate("window.finishStop()")
    await page.waitForFunction("window.chat.run.status==='cancelled'")
    assert.equal(await page.evaluate("window.stopCalls"), 1)
    await page
      .locator("[data-chat-flow-tasks]")
      .getByText(/已停止/)
      .first()
      .waitFor()
    checks.push("stop-is-single-native-control-and-stays-stopping-until-real-cleanup-result")

    await setup()
    await choose()
    await page.evaluate("window.fixture.deferCatalog()")
    await send("切换聊天不能启动旧目标")
    await page.waitForFunction("window.fixture.catalogPending()")
    await page.evaluate("window.fixture.chat('b')")
    await page.waitForFunction("window.chat.threadId==='b'")
    await page.evaluate("window.fixture.finishCatalog()")
    await page.waitForFunction("window.chat.threadId==='b'&&!window.chat.busy")
    assert.equal(await calls("start"), 0)
    assert.equal(await page.locator("[data-chat-task-id]").count(), 0)
    await page.evaluate("window.fixture.unmount()")
    assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
    checks.push("scope-switch-and-unmount-invalidate-old-preflight-and-release-observers")

    await setup()
    await choose()
    await send("检查订单导出的空列表处理")
    await page.evaluate(`const run=window.chat.run;
      run.pendingApproval.summary='已读取 src/orders.ts。导出空列表前需要先检查长度，建议补上边界判断后重新测试。';
      window.fixture.emit('a')`)
    await page.getByRole("region", { name: "人工成果确认" }).waitFor()
    await page.setViewportSize({ width: 860, height: 900 })
    await page.screenshot({ path: join(output, "chat-task-confirmation-doc.png"), fullPage: true })

    await setup()
    await choose()
    await send("长确认与成果")
    await page.evaluate(`const run=window.chat.run;run.pendingApproval.summary='完整确认内容 '.repeat(1500);
      window.fixture.emit('a')`)
    await page.waitForTimeout(100)
    await page.setViewportSize({ width: 375, height: 900 })
    const full = page.locator("[data-chat-flow-tasks]").getByText(/展开完整确认内容/)
    await full.waitFor()
    assert.equal(
      await page.evaluate("document.documentElement.scrollWidth>window.innerWidth+1"),
      false
    )
    await page.screenshot({ path: join(output, "single-composer-375-light.png"), fullPage: true })
    await full.click()
    const reader = page
      .locator("[data-chat-flow-tasks]")
      .getByLabel("完整确认内容", { exact: true })
    await reader.focus()
    assert((await reader.innerText()).length > 10000)
    await page.evaluate("window.applyTestTheme('codex-dark')")
    await page.screenshot({ path: join(output, "single-composer-375-dark.png"), fullPage: true })
    checks.push(
      "375-current-source-CSS-light-dark-no-horizontal-overflow; long-reader-keyboard-access; full-confirmation-retained"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          errors,
          scope:
            "Real React/controller/card/current CSS; mocked native IPC, no claim of model or native execution quality"
        },
        null,
        2
      )
    )
    console.log(`PASS single composer/task cards: ${output}`)
  } catch (error) {
    writeFileSync(join(output, "failure.txt"), await page.locator("body").innerText())
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)
    )
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
