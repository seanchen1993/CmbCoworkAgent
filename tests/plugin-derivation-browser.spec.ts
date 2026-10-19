import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

interface FixtureWindow extends Window {
  calls: Array<[string, ...unknown[]]>
  failSave: boolean
  sourceChanged: boolean
  upstreamChanged: boolean
  deferUpstream: boolean
  finishUpstream(): void
  failGenerate: boolean
  deferGenerate: boolean
  finishGenerate(): void
  projectEntryMode: string
  refreshPluginEntry(): void
  renderScope(threadId?: string, workspace?: string, active?: boolean): void
}

async function main() {
  const skipArtifacts = process.env.DERIVATION_SKIP_ARTIFACTS === "1"
  const output = resolve(
    "output/plain-language-20261013",
    `plugin-derivation-browser-${Date.now()}`
  )
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PluginDerivationPanel} from './src/renderer/src/components/customize/PluginDerivationPanel';
    window.calls=[];window.scopeVersion=0;window.projectEntryMode='legacy';let installedEnabled=false; let copy=null, text='# Original skill\\nKeep original stage checks.';
    const update=(values)=>{copy={...copy,...values}; return {...copy}};
    window.api={pluginDerivation:{sources:async()=>[{pluginId:'original',name:'AutoBiz',description:''}],list:async()=>copy?[copy]:[],
      revise:async(input)=>{window.calls.push(['revise',input]);return update({copyId:'revision-'+window.calls.length,parentCopyId:input.copyId,name:copy.name+'-v2',status:'created',pluginId:undefined})},
      inspectUpstream:async(input)=>{window.calls.push(['upstream',input]);const value={state:window.upstreamChanged?'changed':'unchanged',inspection:{inspectionId:'upstream',sourceName:'AutoBiz',suggestedName:'upstream-latest',digest:'upstream-two',fileCount:5,totalBytes:100,excluded:[],warnings:[]}};
        if(input.prepare&&window.deferUpstream)return new Promise(resolve=>window.finishUpstream=()=>resolve(value));return value},
      inspect:async()=>({inspectionId:'inspection',sourceName:'AutoBiz',suggestedName:'my-autobiz',digest:'source',fileCount:5,totalBytes:100,excluded:[],warnings:[]}),
      create:async(input)=>{window.calls.push(['create',input]);return update({copyId:'copy',name:input.name,sourceName:'AutoBiz',digest:'one',sourceDigest:'original',
        status:'created',createdAt:'',fileCount:5,excluded:[],warnings:[],businessNotes:''})},
      propose:async(input)=>{window.calls.push(['propose',input]);
        if(window.failGenerate)throw Error('model unavailable');
        const value={proposalId:input.requestId,copyId:copy.copyId,baseDigest:copy.digest,
          summary:'增加 SQL 与数据质量报告要求',files:[{path:'skills/build/SKILL.md',before:text,after:text+'\\n'+input.instruction}]};
        if(window.deferGenerate)return new Promise(resolve=>window.finishGenerate=()=>resolve(value));return value},
      prepareNodeComposition:async(input)=>{window.calls.push(['prepareNodes',input]);return {proposalId:'nodes-'+input.requestId,copyId:copy.copyId,baseDigest:copy.digest,summary:'新增可选择步骤的入口，原检查和人工确认保留',files:[{path:'board_core/board_config.json',before:JSON.stringify({workflow:{templates:{standard:{kind:'profile'}}}}),after:JSON.stringify({workflow:{templates:{standard:{kind:'profile'},'devclaw-composed':{kind:'custom',requiredNodes:['dev.code','ops.archive']}}}})}]}},
      prepareFlowComposition:async(input)=>{window.calls.push(['prepareFlow',input]);return {proposalId:'flow-'+input.requestId,copyId:copy.copyId,baseDigest:copy.digest,summary:'新增完整流程入口，原检查和人工确认保留',files:[{path:'devclaw.capabilities.json',before:'',after:JSON.stringify({apiVersion:'devclaw.capabilities/v1',capabilities:[{id:'full-flow',kind:'flow',usage:'project'}]})}]}},
      cancelProposal:async(input)=>window.calls.push(['cancel',input]),
      applyProposal:async(input)=>{window.calls.push(['apply',input]);if(window.sourceChanged)throw Error('源码已变化，请重新生成修改建议');if(window.failSave)throw Error('save failed');
        if(input.proposalId.startsWith('nodes-'))return update({digest:'nodes-saved',status:'changed'});
        if(input.proposalId.startsWith('flow-'))return update({digest:'flow-saved',status:'changed'});
        const proposal=window.calls.filter(x=>x[0]==='propose').at(-1)[1];text+='\\n'+proposal.instruction;
        return update({digest:'proposal-saved',status:'changed'})},
      get:async()=>({...copy}), listEditableFiles:async()=>['skills/build/SKILL.md','hooks/verify.py'],
      readFile:async(input)=>({path:input.path,text,digest:copy.digest}),
      saveFile:async(input)=>{window.calls.push(['saveFile',input]);if(input.expectedDigest!==copy.digest)throw Error('changed');text=input.text;return update({digest:'two',status:'changed'})},
      saveNotes:async(input)=>update({businessNotes:input.businessNotes,digest:'notes',status:'changed'}),
      check:async()=>update({status:'checked'}),install:async(input)=>{window.calls.push(['install',input]);return update({status:'installed',pluginId:'derived-id'})},
      openSource:async()=>window.calls.push(['source'])},plugins:{list:async()=>copy?.pluginId?[{id:copy.pluginId,name:copy.name,version:'1.0.0',enabled:installedEnabled,hasProjectMode:window.projectEntryMode==='legacy'}]:[],setEnabled:async(...args)=>{installedEnabled=true;window.calls.push(['enable',...args])}},
      harnessBoard:{localProjects:{templates:async()=>window.projectEntryMode==='host'&&copy?.pluginId?[{installedPluginId:copy.pluginId,name:'actual-derived-host-package',version:'1.0.0',stages:['draft']}]:[]}}};
    const root=createRoot(document.getElementById('root'));
    window.renderScope=(threadId='thread',workspace='C:/fixture',active=true)=>{window.scopeVersion++;root.render(<PluginDerivationPanel threadId={threadId} workspace={workspace} active={active}/>)};
    window.renderScope();
  `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "host-boundary",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:@\/lib\/(store|configuration-target|feature-gates|derived-project-intent)|sonner)$/ },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: args.path === "sonner"
              ? "export const toast={info:(text)=>window.calls.push(['notice',text])}"
              : args.path.endsWith("store")
              ? "import{useSyncExternalStore}from'react';const listeners=new Set();const state={pluginVersion:0,bumpPluginVersion(){state.pluginVersion++;for(const cb of listeners)cb()},setShowCustomizeView(value){window.calls.push(['customize',value])},setShowHarnessBoardView(value){window.calls.push(['host-projects',value])}};window.refreshPluginEntry=()=>state.bumpPluginVersion();export function useAppStore(selector){return useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb)},()=>selector(state))};useAppStore.getState=()=>state;"
              : args.path.endsWith("configuration-target")
                ? "export const useConfigurationDraft=()=>{};export const captureConfigurationScope=()=>{const version=window.scopeVersion;return()=>version===window.scopeVersion}"
              : args.path.endsWith("feature-gates")
                ? "export const useFeatureGate=()=>({enabled:true,loading:false})"
                : "export const openDerivedProject=(...args)=>window.calls.push(['project',...args]);export const useDerivedProjectIntent=()=>null;export const dismissDerivedProject=(id)=>window.calls.push(['dismiss-project',id])"
          }))
        }
      }
    ]
  })
  const cssPath = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      /* CSS dependency collection is unnecessary for this isolated fixture. */
    }
  })
  const candidates = new Scanner({}).scanFiles(
    ["PluginDerivationPanel", "DerivedPluginEditor", "DerivedPluginProposal", "InstalledPluginProjectEntry"].map((name) => ({
      content: readFileSync(resolve(`src/renderer/src/components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/derivation", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/derivation")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByLabel("选择原插件").selectOption("original")
    await page.getByLabel("2. 给新插件起个名字").fill("my-data-autobiz")
    await page.getByRole("button", { name: "创建我的插件", exact: true }).click()
    await page.getByText("手动修改文件（适合熟悉代码的用户）", { exact: true }).click()
    await page.getByLabel("要修改的文件").selectOption("skills/build/SKILL.md")
    await page.getByLabel("副本文件内容").waitFor()
    await page.getByText("手动修改文件（适合熟悉代码的用户）", { exact: true }).click()
    await page.getByLabel("告诉我你想怎么改").fill("生成 SQL 并提供数据质量报告")
    await page.getByRole("button", { name: "生成修改建议", exact: true }).focus()
    await page.keyboard.press("Enter")
    await page.getByLabel("修改建议预览").waitFor()
    assert.equal(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).calls.filter((x) => x[0] === "apply").length
      ),
      0
    )
    assert(await page.getByRole("button", { name: "检查能否安装", exact: true }).isDisabled())
    await page
      .getByLabel("修改建议预览")
      .getByText("skills/build/SKILL.md", { exact: true })
      .click()
    await page.getByLabel("本次新增的业务要求").waitFor()
    await page.getByText("查看完整修改前后", { exact: true }).click()
    await page.getByText("修改前", { exact: true }).waitFor()
    await page.getByText("修改后", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    if (!skipArtifacts)
      await page.screenshot({
        path: resolve(output, "proposal-before-after-mobile.png"),
        fullPage: true
      })
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).failSave = true
    })
    await page.getByRole("button", { name: "确认保存修改", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "save failed" }).waitFor()
    assert.equal(
      await page.getByLabel("告诉我你想怎么改").inputValue(),
      "生成 SQL 并提供数据质量报告"
    )
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).sourceChanged = true
    })
    await page.getByRole("button", { name: "确认保存修改", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "检查能否安装" }).waitFor()
    await page.getByRole("button", { name: "取消本次建议", exact: true }).click()
    await page.getByRole("button", { name: "检查能否安装", exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).failSave = false
      ;(window as unknown as FixtureWindow).sourceChanged = false
    })
    await page.getByRole("button", { name: "生成修改建议", exact: true }).click()
    await page.getByRole("button", { name: "确认保存修改", exact: true }).click()
    await page
      .getByText("业务要求已保存到技能文件。接下来检查能否安装。", { exact: true })
      .waitFor()
    assert.equal(await page.getByLabel("副本文件内容").count(), 0)
    await page.getByLabel("告诉我你想怎么改").fill("增加空值检查")
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).deferGenerate = true
    })
    await page.getByRole("button", { name: "生成修改建议", exact: true }).click()
    await page.getByRole("button", { name: "取消本次建议", exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).finishGenerate()
      ;(window as unknown as FixtureWindow).deferGenerate = false
    })
    assert.equal(await page.getByLabel("修改建议预览").count(), 0)
    await page.evaluate(() => (window as unknown as FixtureWindow).renderScope("other", "C:/other"))
    await page.getByText("继续修改已创建的插件（1）", { exact: true }).click()
    await page.getByRole("button", { name: "my-data-autobiz", exact: true }).click()
    assert.equal(await page.getByLabel("告诉我你想怎么改").inputValue(), "")
    await page.evaluate(() => (window as unknown as FixtureWindow).renderScope())
    await page.getByText("继续修改已创建的插件（1）", { exact: true }).click()
    await page.getByRole("button", { name: "my-data-autobiz", exact: true }).click()
    assert.equal(await page.getByLabel("告诉我你想怎么改").inputValue(), "增加空值检查")
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).failGenerate = true
    })
    await page.getByRole("button", { name: "生成修改建议", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "model unavailable" }).waitFor()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).failGenerate = false
    })
    await page.getByRole("button", { name: "生成修改建议", exact: true }).click()
    await page.getByLabel("修改建议预览").waitFor()
    await page.getByLabel("告诉我你想怎么改").fill("补充范围变化要求")
    assert.equal(await page.getByLabel("修改建议预览").count(), 0)
    await page.getByText("手动修改文件（适合熟悉代码的用户）", { exact: true }).click()
    await page.getByLabel("要修改的文件").selectOption("skills/build/SKILL.md")
    await page
      .getByLabel("副本文件内容")
      .fill("# Data skill\nKeep original stage checks.\nValidate SQL.")
    assert(await page.getByRole("button", { name: "检查能否安装", exact: true }).isDisabled())
    assert(await page.getByRole("button", { name: "再创建一个插件", exact: true }).isDisabled())
    await page.getByRole("button", { name: "保存文件", exact: true }).click()
    await page.getByRole("button", { name: "添加自选步骤选项", exact: true }).click()
    await page
      .getByLabel("修改建议预览")
      .getByText("board_core/board_config.json", { exact: true })
      .click()
    await page.getByLabel("新增节点组合配置").waitFor()
    await page.getByRole("button", { name: "取消本次建议", exact: true }).click()
    await page.getByRole("button", { name: "添加自选步骤选项", exact: true }).click()
    await page.getByRole("button", { name: "确认添加自选步骤选项", exact: true }).click()
    await page.getByText("“自选项目步骤”已保存。接下来检查能否安装。", { exact: true }).waitFor()
    const beforeFlow = await page.evaluate(
      () => (window as unknown as FixtureWindow).calls.filter(([name]) => name === "apply").length
    )
    await page.getByRole("button", { name: "用于完整流程组合", exact: true }).click()
    await page
      .getByLabel("修改建议预览")
      .getByText("devclaw.capabilities.json", { exact: true })
      .click()
    await page.getByLabel("新增文件内容", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).calls.filter(([name]) => name === "apply").length
      ),
      beforeFlow,
      "Preparing a flow must not save before confirmation"
    )
    await page.getByRole("button", { name: "取消本次建议", exact: true }).click()
    assert.equal(await page.getByLabel("修改建议预览").count(), 0)
    await page.getByRole("button", { name: "用于完整流程组合", exact: true }).click()
    await page.getByRole("button", { name: "确认保存完整流程配置", exact: true }).click()
    await page
      .getByText(
        "完整流程组合配置已保存。请检查并安装此副本，再到项目会话的“项目能力”选择完整流程。",
        { exact: true }
      )
      .waitFor()
    await page.getByRole("button", { name: "检查能否安装", exact: true }).click()
    await page.getByRole("button", { name: "安装新插件", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: "添加自选步骤选项", exact: true }).count(),
      0
    )
    await page.getByText("先启用这个插件，再打开项目入口。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "新建项目", exact: true }).count(), 0)
    await page.getByRole("button", { name: "启用新插件", exact: true }).click()
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).calls.some(([name]) => name === "project"))
    const calls = await page.evaluate(() => (window as unknown as FixtureWindow).calls)
    assert.equal(calls.filter((call) => call[0] === "create").length, 1)
    assert.deepEqual(
      calls.find((call) => call[0] === "enable"),
      ["enable", "derived-id", true]
    )
    assert.deepEqual(
      calls.find((call) => call[0] === "project"),
      [
        "project",
        "derived-id",
        "my-data-autobiz",
        { threadId: "thread", expectedWorkspace: "C:/fixture" }
      ]
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    assert.deepEqual(errors, [])
    if (!skipArtifacts)
      await page.screenshot({
        path: resolve(output, "created-installed-next-project.png"),
        fullPage: true
      })
    // The installed runtime, rather than the copy's original mode or display name, owns navigation.
    await page.evaluate(() => {
      const fixture = window as unknown as FixtureWindow
      fixture.projectEntryMode = "host"
      fixture.refreshPluginEntry()
    })
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).waitFor()
    await page.getByText("进入后点击“新建本地任务”，选择“actual-derived-host-package”。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "新建项目", exact: true }).count(), 0)
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).calls.some(([name]) => name === "host-projects"))
    const routed = await page.evaluate(() => (window as unknown as FixtureWindow).calls)
    assert.equal(routed.filter(([name]) => name === "project").length, 1)
    assert.deepEqual(routed.filter(([name]) => name === "customize"), [["customize", false]])
    assert.deepEqual(routed.filter(([name]) => name === "host-projects"), [["host-projects", true]])
    assert(routed.some(([name, text]) => name === "notice" && String(text).includes("actual-derived-host-package")))
    if (!skipArtifacts)
      await page.screenshot({ path: resolve(output, "installed-host-project-entry.png"), fullPage: true })
    await page.evaluate(() => {
      const fixture = window as unknown as FixtureWindow
      fixture.projectEntryMode = "legacy"
      fixture.refreshPluginEntry()
    })
    await page.getByRole("button", { name: "修改这个插件（创建新版本草稿）", exact: true }).click()
    await page.getByLabel("告诉我你想怎么改").waitFor()
    await page.getByText("my-data-autobiz-v2 已创建", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("告诉我你想怎么改").inputValue(), "")
    await page.getByRole("button", { name: "检查能否安装", exact: true }).click()
    await page.getByRole("button", { name: "发布并安装新版本", exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).upstreamChanged = true
    })
    await page.getByRole("button", { name: "修改这个插件（创建新版本草稿）", exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).calls.filter((x) => x[0] === "upstream").length
      ),
      0
    )
    await page.getByRole("button", { name: "检查来源更新", exact: true }).click()
    await page.getByRole("button", { name: "从最新来源制作", exact: true }).waitFor()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).deferUpstream = true
    })
    await page.getByRole("button", { name: "从最新来源制作", exact: true }).click()
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).renderScope("thread", "C:/fixture", false)
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).renderScope())
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).finishUpstream()
    })
    await page.waitForFunction(() => !document.body.textContent?.includes("正在处理，请稍候"))
    assert.equal(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).calls.filter((x) => x[0] === "create").length
      ),
      1
    )
    await page.getByRole("button", { name: "检查来源更新", exact: true }).click()
    await page.getByRole("button", { name: "从最新来源制作", exact: true }).click()
    await page.evaluate(() => (window as unknown as FixtureWindow).renderScope("other", "C:/other"))
    await page.getByText("继续修改已创建的插件（1）", { exact: true }).waitFor()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).finishUpstream()
      ;(window as unknown as FixtureWindow).deferUpstream = false
    })
    await page.getByText("继续修改已创建的插件（1）", { exact: true }).click()
    await page.getByRole("button", { name: "my-data-autobiz-v2-v2", exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).calls.filter((x) => x[0] === "create").length
      ),
      1
    )
    await page.getByRole("button", { name: "检查来源更新", exact: true }).click()
    if (!skipArtifacts)
      await page.screenshot({
        path: resolve(output, "revision-upstream-mobile.png"),
        fullPage: true
      })
    await page.getByRole("button", { name: "从最新来源制作", exact: true }).click()
    await page.getByText("upstream-latest 已创建", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    if (!skipArtifacts)
      writeFileSync(
        resolve(output, "evidence.json"),
        JSON.stringify(
          {
            passed: true,
            host: "controlled fixture",
            calls: await page.evaluate(() => (window as unknown as FixtureWindow).calls)
          },
          null,
          2
        )
      )
    console.log(
      "PASS proposal preview, explicit apply/retry, scoped drafts, install/project handoff, new versions, upstream updates and stale-scope cancellation"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
