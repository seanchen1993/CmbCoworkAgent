import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/project-stage-prompts-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProjectStagePromptEditor} from './src/renderer/src/components/customize/ProjectStagePromptEditor';
import {ModsDevelopmentPanel} from './src/renderer/src/components/customize/ModsDevelopmentPanel';
window.calls=[];window.requests=[];window.contexts=[];window.listeners=new Set();
let revision=1,body='核对输入并生成报告。';
const identity=id=>({id,name:id==='report'?'资料核对':'研发脚手架',revision,sourceDigest:'digest-'+revision});
const response=(scope,id)=>({threadId:scope.threadId,workspace:scope.expectedWorkspace,draft:identity(id),stages:[
 {id:'define',title:'需求定义',skillPath:'skills/define/SKILL.md',inputs:['原始需求'],
 outputs:[{id:'definition',path:'definition.md'}],checks:['文件存在','业务规则检查'],body,editable:true},
 {id:'deliver',title:'交付报告',skillPath:'skills/deliver/SKILL.md',inputs:['definition'],
 outputs:[{id:'report',path:'report.md'}],checks:['引用检查'],body:'生成交付报告。',editable:true},
 {id:'shared',title:'共享阶段',skillPath:'skills/shared/SKILL.md',inputs:[],outputs:[],checks:[],
 body:'共享提示词',editable:false,diagnostic:'多个阶段共享此 Skill，请让创造者分析后修改。'}]});
window.apiFixture={
 status:async()=>({threadId:'creator-a',workspace:'C:/creator-a',enabled:true,mode:'creator',drafts:[],trials:[]}),
 listProjectPromptDrafts:async scope=>({...scope,workspace:scope.expectedWorkspace,drafts:window.hideDrafts?[]:[identity('report'),identity('engineering')]}),
 readProjectStagePrompts:async scope=>{
   const result=response(scope,scope.id);
   if(window.delayRead){window.delayRead=false;await new Promise(resolve=>window.releaseRead=resolve)}
   return result;
 },
 saveProjectStagePrompt:async input=>{
   window.calls.push(input);
   if(window.sourceLimit){window.sourceLimit=false;throw Error('AUTHORING_SOURCE_LIMIT')}
   if(window.conflict){window.conflict=false;revision++;body='另一位作者更新后的正文';throw Error('PROJECT_DRAFT_REVISION_CHANGED')}
   if(input.revision!==revision)throw Error('PROJECT_DRAFT_REVISION_CHANGED');
   revision++;body=input.body;return response(input,input.id);
 },
 onChanged:listener=>{window.listeners.add(listener);return()=>window.listeners.delete(listener)}
};
window.api={mods:{development:window.apiFixture,globalEnabled:async()=>true,
 status:async()=>({workspace:'C:/creator-a',enabled:true,outputPolicy:true,mods:[],diagnostics:[]})}};
function App(){const[scope,setScope]=useState({threadId:'creator-a',workspace:'C:/creator-a',accountRevision:0});
 const[shown,setShown]=useState(true);const[whole,setWhole]=useState(false);
 window.setWhole=setWhole;window.setScope=setScope;window.setShown=setShown;
 if(whole)return shown?<ModsDevelopmentPanel threadId='creator-a' workspaceHint='C:/creator-a'
 mode='entry' api={window.apiFixture} onReturnToChat={context=>window.contexts.push(context)} onRequestRepair={message=>window.requests.push(message)}/>:null;
 return <main className='mx-auto max-w-4xl p-3'>{shown&&<ProjectStagePromptEditor {...scope}
 api={window.apiFixture} onReturnToChat={context=>window.contexts.push(context)} onRequestRepair={message=>window.requests.push(message)}/>}</main>}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://stage-prompts.local/test-bundle.js"'
    },
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
    target: "chrome130",
    logLevel: "warning"
  })
  const componentPath = resolve(renderer, "components/customize/ProjectStagePromptEditor.tsx")
  const cssPath = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const candidates = new Scanner({}).scanFiles([
    { content: readFileSync(componentPath, "utf8"), extension: "tsx" }
  ])
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://stage-prompts.local/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<div id='root'></div>"
      })
    )
    await page.goto("http://stage-prompts.local/")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    const advanced = page.getByText("高级：查看或直接编辑阶段原文", { exact: true })
    const openAdvanced = async () => {
      await advanced.waitFor()
      if (!await advanced.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await advanced.click()
    }
    const body = page.getByRole("textbox", { name: "阶段提示词正文", exact: true })
    const draft = page.getByLabel("项目草稿", { exact: true })
    const stage = page.getByLabel("阶段", { exact: true })
    await page.getByRole("button", { name: "回对话修改这个阶段", exact: true }).waitFor()
    assert.equal(await body.isVisible(), false, "raw source is progressive disclosure, not the default task")
    await page.getByRole("button", { name: "回对话修改这个阶段", exact: true }).click()
    assert.equal(await page.evaluate("window.requests.length"), 0, "returning to conversation cannot send")
    assert.match(await page.evaluate("window.contexts[0]"), /"stageId":"define"/)
    await page.screenshot({ path: resolve(output, "00-conversation-first.png"), fullPage: true })
    await openAdvanced()
    await body.waitFor()
    assert.equal(await body.inputValue(), "核对输入并生成报告。")
    assert.match(
      await page.getByRole("region", { name: "项目阶段提示词" }).innerText(),
      /业务规则检查/
    )
    await body.fill("每条需求必须说明权限和异常场景。")
    await page.getByRole("button", { name: "刷新草稿", exact: true }).click()
    assert.equal(await body.inputValue(), "每条需求必须说明权限和异常场景。")
    page.once("dialog", (dialog) => dialog.dismiss())
    await stage.selectOption("deliver")
    assert.equal(await stage.inputValue(), "define")
    page.once("dialog", (dialog) => dialog.dismiss())
    await draft.selectOption("engineering")
    assert.equal(await draft.inputValue(), "report")
    assert.equal(
      await page.getByRole("button", { name: "让创造者修改", exact: true }).isDisabled(),
      true
    )
    await page.evaluate("window.listeners.forEach(fn=>fn({threadId:'creator-a'}))")
    assert.equal(await body.inputValue(), "每条需求必须说明权限和异常场景。")
    await page.getByRole("button", { name: "保存草稿", exact: true }).click()
    await page.getByText("草稿已保存为新修订。", { exact: false }).waitFor()
    assert.equal(await page.evaluate("window.calls.length"), 1)
    assert.deepEqual(await page.evaluate("Object.keys(window.calls[0]).sort()"), [
      "body",
      "expectedWorkspace",
      "id",
      "revision",
      "sourceDigest",
      "stageId",
      "threadId"
    ])
    assert.equal(
      await page.evaluate(
        "Object.keys(sessionStorage).filter(k=>k.startsWith('creator-stage-prompt:')).length"
      ),
      0
    )
    await page.getByLabel("阶段提示词修改要求").fill("先列出待确认问题，减少重复说明")
    await page.getByRole("button", { name: "让创造者修改", exact: true }).click()
    await page.getByRole("button", { name: "让助手准备试用", exact: true }).click()
    assert.match(await page.evaluate("window.requests[0]"), /"stageId":"define"/)
    assert.match(await page.evaluate("window.requests[0]"), /易懂的中文解释当前阶段职责/)
    assert.match(await page.evaluate("window.requests[0]"), /先列出待确认问题，减少重复说明/)
    assert.match(await page.evaluate("window.requests[1]"), /原生确认流程准备从头试用/)
    await page.screenshot({ path: resolve(output, "01-saved-stage-prompt.png"), fullPage: true })

    const oversizedBody = "完整说明".repeat(6000)
    await body.fill(oversizedBody)
    await page.evaluate("window.sourceLimit=true")
    await page.getByRole("button", { name: "保存草稿", exact: true }).click()
    const limitMessage = page.getByRole("alert").filter({ hasText: "大小限制" })
    await limitMessage.waitFor()
    assert.equal(await body.inputValue(), oversizedBody)
    assert.match(await limitMessage.innerText(), /精简正文后重试/)
    assert.doesNotMatch(await limitMessage.innerText(), /续作/)

    await body.fill("发生并发冲突时也必须保留这段文字。")
    await page.evaluate("window.conflict=true")
    await page.getByRole("button", { name: "保存草稿", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "草稿已被其他修改更新" }).waitFor()
    assert.equal(await body.inputValue(), "发生并发冲突时也必须保留这段文字。")
    // Leaving the workspace and changing accounts cannot submit or leak a buffer into another scope.
    await page.evaluate("window.setShown(false)")
    await body.waitFor({ state: "detached" })
    await page.evaluate("window.setShown(true)")
    await page.getByText("已恢复未保存正文", { exact: false }).waitFor()
    await openAdvanced()
    assert.equal(await body.inputValue(), "发生并发冲突时也必须保留这段文字。")
    await page.evaluate(
      "window.setScope({threadId:'creator-a',workspace:'C:/creator-a',accountRevision:1})"
    )
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('[aria-label="阶段提示词正文"]')?.value ===
        "另一位作者更新后的正文"
    )
    await page.evaluate(
      "window.setScope({threadId:'creator-a',workspace:'C:/creator-a',accountRevision:0})"
    )
    await page.getByText("已恢复未保存正文", { exact: false }).waitFor()
    await openAdvanced()
    assert.equal(await body.inputValue(), "发生并发冲突时也必须保留这段文字。")
    await page.screenshot({ path: resolve(output, "02-restored-stale-edit.png"), fullPage: true })
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "放弃本地修改", exact: true }).click()
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('[aria-label="阶段提示词正文"]')?.value ===
        "另一位作者更新后的正文"
    )
    await stage.selectOption("shared")
    assert.equal(await body.getAttribute("readonly"), "")
    await page.getByText("多个阶段共享此 Skill", { exact: false }).waitFor()
    await stage.selectOption("define")

    // A response from a retired scope must not overwrite the new thread's editor.
    await page.evaluate("window.delayRead=true")
    await draft.selectOption("engineering")
    await page.waitForFunction("typeof window.releaseRead==='function'")
    await page.evaluate(
      "window.setScope({threadId:'creator-b',workspace:'C:/creator-b',accountRevision:0})"
    )
    await openAdvanced()
    await body.waitFor()
    await page.evaluate("window.releaseRead()")
    await body.fill("新会话的独立修改")
    await page.getByRole("button", { name: "保存草稿", exact: true }).click()
    await page.getByText("草稿已保存为新修订。", { exact: false }).waitFor()
    assert.equal(await page.evaluate("window.calls.at(-1).threadId"), "creator-b")
    assert.equal(await page.evaluate("window.calls.at(-1).expectedWorkspace"), "C:/creator-b")
    assert.equal(await page.evaluate("window.calls.at(-1).id"), "report")

    // Quota failures preserve visible text and must not claim that it was cached.
    await page.evaluate(
      "window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('quota')}"
    )
    await body.fill("缓存不可用时仍保留内存编辑")
    await page.getByText("仅保留在当前编辑页内存", { exact: false }).waitFor()
    assert.equal(await body.inputValue(), "缓存不可用时仍保留内存编辑")
    await page.evaluate("Storage.prototype.setItem=window.originalSetItem")
    await page.setViewportSize({ width: 375, height: 850 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: resolve(output, "03-mobile-cache-failure.png"), fullPage: true })
    // Native author drafts alone reveal the workspace before any trial is requested.
    await page.evaluate("window.hideDrafts=true;window.setWhole(true)")
    await page.getByRole("region", { name: "会话创作入口", exact: true }).waitFor()
    assert.equal(await page.getByRole("region", { name: "项目阶段提示词", exact: true }).count(), 0)
    await page.evaluate(
      "window.hideDrafts=false;window.listeners.forEach(fn=>fn({threadId:'creator-a'}))"
    )
    await page.getByRole("region", { name: "项目阶段提示词", exact: true }).waitFor()
    await openAdvanced()
    await body.waitFor()
    assert.equal(
      await page.getByRole("article", { name: "项目真实试用请求", exact: true }).count(),
      0
    )
    await page.evaluate("window.setShown(false)")
    await body.waitFor({ state: "detached" })
    await page.evaluate("window.setShown(true)")
    await openAdvanced()
    await body.waitFor()
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.screenshot({
      path: resolve(output, "04-native-draft-before-trial.png"),
      fullPage: true
    })
    assert.deepEqual(errors, [])
    console.log(
      `PASS project stage prompt browser: editing, CAS conflict, recovery, account/scope isolation, shared read-only, callbacks, quota and mobile; screenshots ${output}`
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
