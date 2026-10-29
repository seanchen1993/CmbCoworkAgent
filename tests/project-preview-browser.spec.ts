/** Actual React preview controls with isolated IPC; the existing project execution panel is separate. */
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface FixtureWindow {
  fixture: {
    update(): void
    show(thread: string): void
    finish(): void
    request(): void
    feedback(): void
    finishRepair(): void
    repairs: string[]
    creates: Array<{ threadId: string; revision: number }>
  }
}
async function main() {
  const root = resolve(__dirname, "..")
  const artifacts = resolve(root, "output/project-platform-20261012/browser")
  mkdirSync(artifacts, { recursive: true })
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "preview-project-detail",
        setup(builder) {
          builder.onResolve({ filter: /harness-board\/LocalProjectsPanel$/ }, () => ({
            path: "detail",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "jsx",
            resolveDir: root,
            contents:
              "export function LocalProjectRun({projectId}) { return <p>打开项目 {projectId}</p> }"
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ProjectDevelopmentPreviewPanel} from './src/renderer/src/components/customize/ProjectDevelopmentPreviewPanel';
      const root=createRoot(document.getElementById('root')), listeners=new Set(), creates=[], repairs=[];
      let revision=1, finish, repairFinish;
      window.api={mods:{development:{onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}},harnessBoard:{localProjects:{preview:{
        list:async threadId=>({threadId,workspace:'C:/fixture/'+threadId,drafts:[{id:'docs',name:'文档模板 '+threadId,revision,digest:String(revision).repeat(64),development:{devId:'dev-'+threadId,workspace:'C:/isolated/'+threadId,currentRevision:revision,currentDigest:'digest-'+revision,pendingRevision:null,activeRuns:0,updateState:'current'}}]}),
        create:async input=>{creates.push(input);return new Promise(resolve=>finish=()=>resolve('project-'+input.threadId))},
        finish:async()=>{},stageDebug:{list:async()=>({snapshots:[],branches:[],diagnostics:[]})}
      }}}};
      const show=thread=>root.render(<React.StrictMode><ProjectDevelopmentPreviewPanel threadId={thread} workspace={'C:/fixture/'+thread}/></React.StrictMode>);
      window.fixture={creates,show,repairs,finish:()=>finish(),finishRepair:()=>repairFinish(),
        request:()=>root.render(<ProjectDevelopmentPreviewPanel key="request" threadId="A" workspace="C:/fixture/A" request={{id:"requested",draftId:"docs",name:"文档",revision,digest:String(revision).repeat(64),goal:"对话预填的文档验收目标"}}/>),
        feedback:()=>{
          const composer=document.createElement('textarea');composer.setAttribute('aria-label','原聊天保留输入');document.body.appendChild(composer);
          root.render(<ProjectDevelopmentPreviewPanel key="feedback" threadId="A" workspace="C:/fixture/A"
            request={{id:"feedback-request",draftId:"docs",name:"文档",revision,digest:String(revision).repeat(64),goal:"核对试用效果"}}
            onRequestRepair={async message=>{repairs.push(message);await new Promise(resolve=>repairFinish=resolve)}}/>);
        },update:()=>{revision++;for(const fn of listeners)fn({threadId:'A'})}};
      show('A');
    `
    }
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" })
  }
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByText("文档模板 A · 版本 1", { exact: true }).waitFor()
    await page.getByRole("textbox").fill("生成试用文档")
    const create = page.getByRole("button", { name: "开始试用", exact: true })
    assert.equal(await create.isEnabled(), true)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.update())
    await page.getByText("文档模板 A · 版本 2", { exact: true }).waitFor()
    assert.equal(await page.getByRole("checkbox").count(), 0)
    assert.equal(await create.isEnabled(), true)
    await create.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.creates.length),
      1
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.show("B"))
    await page.getByText("文档模板 B · 版本 2", { exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finish())
    await page.waitForTimeout(70)
    assert.equal(await page.getByText("打开项目 project-A", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("checkbox").count(), 0)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.request())
    await page.getByText("文档模板 A · 版本 2", { exact: true }).waitFor()
    assert.equal(await page.getByRole("textbox").inputValue(), "对话预填的文档验收目标")
    assert.equal(await create.isEnabled(), true)
    await create.click()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finish())
    await page.getByText("打开项目 project-A", { exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole("region", { name: "本轮试用项目执行", exact: true })
        .evaluate((element) =>
          Boolean(
            element.compareDocumentPosition(
              document.querySelector('[data-creator-guide="stage-debug"]')!
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          )
        ),
      true,
      "Native trial execution and its approvals must precede optional stage debugging"
    )
    assert.equal(
      await page
        .locator('[data-creator-guide="stage-debug"]')
        .evaluate((element) => (element as HTMLDetailsElement).open),
      false,
      "Optional debugging stays collapsed while the native trial is immediately accessible"
    )
    assert.equal(await page.evaluate("window.fixture.creates.at(-1).expectedDigest"), "2".repeat(64))
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.update())
    await page.getByText("文档模板 A · 版本 2", { exact: true }).waitFor({ state: "detached" })
    assert.equal(await create.count(), 0)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.feedback())
    await page.getByText("需要调整？", { exact: true }).click()
    const feedback = page.getByRole("textbox", { name: "希望如何改进", exact: true })
    const originalInput = page.getByRole("textbox", { name: "原聊天保留输入", exact: true })
    const submitFeedback = page.getByRole("button", { name: "提交到原聊天继续优化", exact: true })
    await originalInput.fill("原创作聊天尚未发送的需求")
    await feedback.fill("  第一条改进要求  ")
    await submitFeedback.click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.repairs.length === 1)
    assert.equal(await submitFeedback.isDisabled(), true)
    const newDraft = "  下一条尚未提交的反馈  "
    await feedback.fill(newDraft)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finishRepair())
    await page.getByText("输入框中保留的新内容尚未提交。", { exact: false }).waitFor()
    assert.equal(await feedback.inputValue(), newDraft,
      "A delayed first submission must not clear the user's newly typed feedback")
    assert.match(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.repairs[0]), /我的修改要求：第一条改进要求。/)
    // Editing only surrounding whitespace still creates a distinct unsent draft.
    await submitFeedback.click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.repairs.length === 2)
    await feedback.fill(newDraft.trim())
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finishRepair())
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent === "提交到原聊天继续优化")
      return !!button && !button.disabled
    })
    assert.equal(await feedback.inputValue(), newDraft.trim(),
      "Clearing must compare the exact submitted raw text, not trimmed equivalence")
    await submitFeedback.click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.repairs.length === 3)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finishRepair())
    await page.waitForFunction(() => {
      const input = [...document.querySelectorAll("textarea")].find(item => item.closest("label")?.textContent?.includes("希望如何改进"))
      return input?.value === ""
    })
    assert.equal(await originalInput.inputValue(), "原创作聊天尚未发送的需求",
      "Feedback submission must never replace or clear the original chat composer")
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(artifacts, "project-preview-scope.png"), fullPage: true })
    console.log(
      "PASS single-action preview, latest candidate identity, StrictMode hydration, double-create fencing, stale scope and delayed feedback draft isolation"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
