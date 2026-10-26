/** Real React interaction, isolated IPC fixtures. No application profile or model access. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Browser } from "playwright"

interface ProjectFixtureWindow {
  fixture: {
    calls: Array<[string, string | Record<string, unknown>]>
    reads: Array<() => void>
    delay(value: string): void
    finish(): void
    hold(value: boolean): void
    finishRead(): void
    valid(value: boolean): void
    finishNavigation(): void
    navigationReads: string[]
  }
}
interface OverviewFixtureWindow {
  calls: Array<["overview" | "review", string, string, string?]>
  show(workspace: string, visible?: boolean): void
  finish(index: number): void
  fail(value: boolean): void
  managedOnly(): void
}

async function verifyLocalProjects(root: string, browser: Browser, artifacts: string) {
  const bundled = await build({ write: false, bundle: true, platform: "browser", format: "iife",
    plugins: [{ name: "project-thread-navigation-store", setup(builder) {
      builder.onResolve({ filter: /^\.\.\/\.\.\/lib\/store$/ }, () => ({ path: "project-navigation-store", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
        const threads=[];
        export const isThreadDeletionPending=()=>false;
        export const useAppStore={getState:()=>({addThreadSummary:thread=>{threads.push(thread);window.fixture.calls.push(['hydrated',thread.thread_id])},selectThread:async id=>{if(!threads.find(t=>t.thread_id===id)?.metadata?.hostProjectRuntime)throw Error('MISSING_HOST_METADATA');window.fixture.calls.push(['selected',id])}})};
      ` }))
    } }],
    loader: { ".md": "text", ".png": "dataurl" },
    alias: { "@": resolve(root, "src/renderer/src") },
    jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    stdin: { loader: "tsx", resolveDir: root, contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {LocalProjectsPanel} from './src/renderer/src/components/harness-board/LocalProjectsPanel';
      import {parseProjectRuntimeManifestV1} from './src/shared/project-runtime/manifest';
      const root=createRoot(document.getElementById('root')), calls=[], pending=[];
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=> 'fixture-key-'+calls.length});
      const views={}; let delay='', valid=false, holdRead=false,finishNavigation; const reads=[],navigationReads=[];
      function make(id,human=false) { return {project:{projectId:id,name:'任务 '+id,goal:'目标 '+id,
        workspace:'C:/fixture/'+id,pluginDigest:'fixture-digest',status:'active',stageIndex:0,version:1,updatedAt:1,packageVersion:'1.0.0',
        manifest:parseProjectRuntimeManifestV1({apiVersion:'devclaw.project-runtime/v1',plugin:{id:'fixture-template',version:'1.0.0'},mode:'host',stateOwner:'host',
          stages:[{id:'draft',title:'草稿',skill:'draft',actionIds:[],artifactIds:['draft'],checkIds:['exists'],approval:human?'human':'none'}],actions:[],
          artifacts:[{id:'draft',path:'draft.md',required:true}],checks:[{id:'exists',artifactId:'draft',kind:'file-exists',sideEffect:'read'}],environment:[],
          capabilities:{execution:true,conditionalTransition:true,idempotency:true,reconciliation:true,cancellation:true}})},operations:[]}; }
      views.A=make('A'); views.B=make('B',true); views.E=make('E'); views.F=make('F',true);
      views.G=make('G'); views.G.operations=[{operationId:'G-op',stageId:'draft',expectedVersion:1,status:'succeeded',updatedAt:1,receipts:[],execution:{threadId:'G-thread'}}];
      views.D=make('D',true);
      views.D.project.manifest.stages[0].actionIds=['format-note'];
      views.D.project.manifest.actions=[{id:'format-note',ref:{pluginId:'format-plugin',plugin:'public-format-plugin',digest:'d'.repeat(64),actionId:'format-note'}}];
      views.D.project.manifest=parseProjectRuntimeManifestV1(views.D.project.manifest);
      const copy=value=>JSON.parse(JSON.stringify(value));
      window.api={threads:{get:async id=>{navigationReads.push(id);return new Promise(resolve=>finishNavigation=()=>resolve({thread_id:id,metadata:{workspacePath:'C:/fixture/G',hostProjectRuntime:{projectId:'G',operationId:'G-op',stageId:'draft',pluginDigest:'fixture-digest'}}}))}},file:{selectDirectory:async()=>({canceled:false,filePaths:['C:/fixture/new']})},
        harnessBoard:{localProjects:{
          mods:{read:async id=>{const project=views[id].project;return {projectId:project.projectId,projectVersion:project.version,packageDigest:project.pluginDigest,workspace:project.workspace}},
            approve:async()=>{throw Error('UNEXPECTED_FUNCTION_APPROVAL')}},
          templates:async()=>[{installedPluginId:'installed-uuid',name:'两阶段模板',version:'1.0.0',stages:['草稿','检查']}],
          list:async()=>Object.values(views).map(x=>copy(x.project)),
          get:async id=>{const result=copy(views[id]); if(holdRead)return new Promise(resolve=>reads.push(()=>resolve(result)));return result},
          versions:async id=>({retainedVersion:'1.0.0',installedVersion:'2.0.0',differences:['检查规则发生变化，原检查通过记录不能代替新版检查。'],guidance:'当前任务继续使用原模板副本。'}),
          create:async input=>{calls.push(['create',input]); views.C=make('C');return copy(views.C)},
          command:async(id,input)=>{calls.push([input.kind,id]); const view=views[id];
            let op=view.operations[0];
            if(input.kind==='prepare'){op={operationId:id+'-'+calls.length,expectedVersion:1,stageId:'draft',
              status:'prepared',inputFingerprint:'fp',updatedAt:1,receipts:[]};view.operations.unshift(op)}
            if(input.kind==='approve'){op.approval={decision:input.decision};if(input.decision==='rejected')op.status='cancelled'}
            if(input.kind==='start'){op.status='succeeded';if(id==='E')op.execution={threadId:'real-running-thread',terminal:null}}
            if(input.kind==='cancel')op.status='cancelled';
            if(input.kind==='validate'){op.status=valid?'succeeded':'failed';op.receipts=[{checkId:'exists',result:valid?'passed':'failed'}]}
            if(input.kind==='advance'){op.status='transitioned';view.project.stageIndex=1;view.project.status='completed';view.project.version++}
            const result=copy(view);
            if(input.kind===delay){if(id==='E'&&input.kind==='start')op.status='started';return new Promise(resolve=>pending.push(()=>resolve(result)))}
            return result;
          }
      }}};
      window.fixture={calls,reads,navigationReads,finishNavigation:()=>finishNavigation(),hold:value=>holdRead=value,finishRead:()=>reads.shift()(),delay:value=>delay=value,finish:()=>pending.shift()(),valid:value=>valid=value};
      root.render(<React.StrictMode><LocalProjectsPanel/></React.StrictMode>);
    ` } })
  const page = await browser.newPage({ viewport: { width: 380, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setContent('<html><body><div id="root"></div></body></html>')
  await page.addScriptTag({ content: bundled.outputFiles[0].text })
  const assets = resolve(root, process.env.SPARKS_BROWSER_BUILD ?? "out", "renderer/assets")
  const css = existsSync(assets) ? readdirSync(assets).find(name => /^index-.*\.css$/.test(name)) : undefined
  if (css) await page.addStyleTag({ path: resolve(assets, css) })
  const task = (id: string) => page.getByRole("button", { name: new RegExp(`^任务 ${id}`) })
  const tick = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const help = page.getByRole("link", { name: /使用说明/ })
  await help.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("heading", { name: "内置功能与本地项目任务", exact: true }).waitFor()
  await page.getByRole("article").getByRole("link", { name: "制作项目模板", exact: true }).first().click()
  await page.getByRole("heading", { name: "只写技能和节点，制作自己的项目插件", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.length), 0, "reading offline help must not mutate projects")
  await task("G").click()
  await page.getByRole("button", { name: "查看本次会话", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as ProjectFixtureWindow).fixture.navigationReads.length === 1)
  await task("A").click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finishNavigation())
  await tick()
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "selected").length), 0, "late navigation cannot switch away from the new project")
  for (let attempt = 0; attempt < 2; attempt++) {
    await task("G").click()
    await page.getByRole("button", { name: "查看本次会话", exact: true }).click()
    await page.waitForFunction(count => (window as unknown as ProjectFixtureWindow).fixture.navigationReads.length === count, attempt + 2)
    await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finishNavigation())
    await page.waitForFunction(count => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "selected").length === count, attempt + 1)
    await task("A").click()
  }
  assert.deepEqual(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => ["selected", "hydrated"].includes(x[0])).map(x => x[0])), ["hydrated", "selected", "hydrated", "selected"])
  await task("D").focus()
  await page.keyboard.press("Enter")
  await page.getByText("public-format-plugin · format-note", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "只检查已有成果", exact: true }).count(), 0)
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
  await page.getByRole("button", { name: "批准并执行" }).waitFor()
  assert.equal(await page.getByRole("button", { name: "批准，仅检查已有成果" }).count(), 0)
  await page.getByRole("button", { name: "拒绝本次执行" }).click()
  await page.getByText("任务配置与版本", { exact: true }).click()
  await page.getByRole("button", { name: "比较已安装版本" }).click()
  await page.getByText("当前任务继续使用原模板副本。", { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x=>x[0]==='start').length), 0)
  await page.screenshot({ path: resolve(artifacts, "local-project-actions-narrow.png"), fullPage: true })
  await task("A").click()
  await page.getByText("目标 A", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay("prepare"))
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).dblclick()
  await task("B").click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finish())
  await tick()
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "prepare" && x[1] === "A").length), 1)
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "start").length), 0, "late prepare must not execute after project switch")
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay(""))
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
  await page.getByRole("button", { name: "批准并执行" }).waitFor()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay("approve"))
  await page.getByRole("button", { name: "批准并执行" }).click()
  await task("A").click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finish())
  await tick()
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "start").length), 0, "late approval must not execute after project switch")
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay("start"))
  await page.getByRole("button", { name: "继续执行", exact: true }).click()
  await page.getByRole("button", { name: "停止本次步骤" }).click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finish())
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "确认完成任务" }).count(), 0, "late start response must not resurrect cancelled state")
  assert.equal(await page.getByText(/PROJECT_SCOPE_CHANGED/).count(), 0)
  const startedBeforeObserve = await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "start").length)
  await task("E").click()
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
  const observedAt = Date.now()
  await page.getByRole("button", { name: "查看本次会话", exact: true }).waitFor({ timeout: 2000 })
  assert(Date.now() - observedAt < 2000, "first bounded observation exposes running thread without refresh")
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.hold(true))
  await page.waitForFunction(() => (window as unknown as ProjectFixtureWindow).fixture.reads.length > 0)
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finish())
  await page.getByRole("button", { name: "确认完成任务", exact: true }).waitFor()
  await page.evaluate(() => { (window as unknown as ProjectFixtureWindow).fixture.hold(false); (window as unknown as ProjectFixtureWindow).fixture.finishRead() })
  await tick()
  assert.equal(await page.getByRole("button", { name: "确认完成任务", exact: true }).count(), 1, "late observed started state cannot overwrite settled command")
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "start").length), startedBeforeObserve + 1)
  await page.screenshot({ path: resolve(artifacts, "local-project-observe-settled.png"), fullPage: true })
  await task("F").click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay(""))
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay("approve"))
  await page.getByRole("button", { name: "批准并执行", exact: true }).click()
  await page.getByRole("button", { name: "停止本次步骤", exact: true }).click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.finish())
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "start" && x[1] === "F").length), 0, "cancel supersedes pending approve and forbids dependent start")
  assert.equal(await page.getByText(/PROJECT_SCOPE_CHANGED/).count(), 0)
  await task("A").click()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.delay(""))
  await page.getByRole("button", { name: "只检查已有成果", exact: true }).click()
  await page.getByText(/待修复 · draft.md/).waitFor()
  await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.valid(true))
  await page.getByRole("button", { name: "只检查已有成果", exact: true }).click()
  await page.getByRole("button", { name: "确认完成任务" }).click()
  await page.getByRole("heading", { name: "任务 A · 已完成" }).waitFor()
  await task("B").click()
  await page.getByRole("button", { name: "停止本次步骤" }).click()
  await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
  await page.getByRole("button", { name: "拒绝本次执行" }).click()
  await page.getByText("你已拒绝本次执行，可重新准备。").waitFor()
  await page.getByRole("button", { name: "新建本地任务" }).click()
  await page.getByLabel("任务名称").fill("新任务")
  await page.getByLabel("希望完成什么").fill("准备一份文档")
  await page.getByRole("button", { name: "选择工作目录" }).click()
  await page.getByRole("button", { name: "创建任务", exact: true }).click()
  await page.getByText("目标 C", { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "create").length), 1)
  assert.equal(await page.evaluate(() => (window as unknown as ProjectFixtureWindow).fixture.calls.filter(x => x[0] === "start" && x[1] === "C").length), 0)
  await page.screenshot({ path: resolve(artifacts, "local-project-fixture.png"), fullPage: true })
  if (css) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "project panel should fit the narrow viewport")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: resolve(artifacts, "local-project-desktop.png"), fullPage: true })
  assert.deepEqual(errors, [])
  await page.close()
  console.log("PASS isolated project UI: create only, double-click, stale prepare/approval, cancel response order, rejection, failed-check repair, explicit completion; model/approval backend not exercised")
}

async function main() {
  const root = resolve(__dirname, "..")
  const artifacts = resolve(root, "output/project-platform-20261012/browser")
  mkdirSync(artifacts, { recursive: true })
  const bundled = await build({ write: false, bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' },
    stdin: { loader: "tsx", resolveDir: root, contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BuiltinRunOverview} from './src/renderer/src/components/chat/BuiltinRunOverview';
      import {BuiltinOriginalProjectMetrics} from './src/renderer/src/components/chat/BuiltinPolicyMetrics';
      const root=createRoot(document.getElementById('root'));
      const pending=[], calls=[]; let failed=false;
      const overview=(id,workspace)=>({threadId:id,workspace,capturedAt:1,
        instructions:{status:'observed',message:'规范说明',snapshot:{origin:'host',entries:[{path:'规范 '+workspace,delivery:'unknown',layer:'project',scope:workspace,reason:'待核对'}],limitations:[]}},
        policy:{required:false,blockedTools:[],recordedBlocks:0,explanation:'原审批保留',decisions:{state:'observed',explanation:'真实确认记录',limited:false,records:[{id:'policy-id',at:1,source:'hook',event:'PreSkillUse',ruleId:'technical-rule-id',explanation:'原检查阻止了本次执行',nextStep:'请修复已列出的条件后再确认'}]}},
        legacyMetrics:{state:'observed',counts:{started:0,succeeded:1,failed:1,cancelled:0,unknown:1},totalSettledExecutionMs:1200,repeatedExecutions:1,explanation:'历史结束不等于成果合格',limited:false,executions:[{operationId:'technical-operation-id',threadId:'technical-thread-id',startedAt:1,status:'unknown'}]},
        metrics:{sampled:0,succeeded:0,failed:0,running:0,unknown:0,inputTokens:null,outputTokens:null,limited:false,explanation:'仅保留的记录'},suggestions:[]});
      window.api={mods:{builtinAdvisor:async()=>({enabled:false,running:false,nextAllowedAt:0,dailyLimit:10,outputTokenLimit:512}),builtinOverview:(id,workspace)=>{
        calls.push(['overview',id,workspace]); if(failed)return Promise.reject(Error('fixture read failed'));
        return new Promise(resolve=>pending.push(()=>resolve(overview(id,workspace))));
      },builtinChangeReview:async(id,workspace,baseline)=>{calls.push(['review',id,workspace,baseline]);
        return {status:'available',baseline,baselineLabel:'固定基线 '+workspace,head:'abc',files:[{path:'draft.md',status:'modified',binary:false,patch:'-old\\n+new'}],message:'1个变化',limitations:['归属未确认'],evidence:{projectName:'文档任务',stageTitle:'复核阶段',matchesProjectVersion:false,checks:[{checkId:'草稿存在',result:'passed',checkedAt:1}]}};}}};
      window.show=(workspace,visible=true)=>root.render(<BuiltinRunOverview threadId='same' workspace={workspace} visible={visible}/>);
      window.finish=index=>pending[index](); window.fail=value=>failed=value; window.calls=calls;
      window.managedOnly=()=>root.render(<BuiltinOriginalProjectMetrics value={{...overview('same','A').legacyMetrics,executions:[],counts:{started:0,succeeded:0,failed:0,cancelled:0,unknown:0},managedRun:{status:'running',providerRetries:2,durationMs:1500}}}/>);
      window.show('A',false);
    ` } })
  let browser
  try { browser = await chromium.launch({ headless: true }) }
  catch { browser = await chromium.launch({ headless: true, channel: "msedge" }) }
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole("heading", { name: "本次规范与运行概况" }).waitFor()
    const tick = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await tick()
    assert.equal(await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.length), 0)
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).show("A"))
    await page.waitForFunction(() => (window as unknown as OverviewFixtureWindow).calls.length === 1)
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).finish(0))
    await page.getByText("规范 A", { exact: true }).waitFor({ state: "attached" })
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).show("B"))
    await page.waitForFunction(() => (window as unknown as OverviewFixtureWindow).calls.length === 2)
    assert.equal(await page.getByText("规范 A", { exact: true }).count(), 0)
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).show("A"))
    await page.waitForFunction(() => (window as unknown as OverviewFixtureWindow).calls.length === 3)
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).finish(1))
    await tick()
    assert.equal(await page.getByText("规范 B", { exact: true }).count(), 0)
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).finish(2))
    await page.getByText("规范 A", { exact: true }).waitFor({ state: "attached" })
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).fail(true))
    await page.getByRole("button", { name: "更新记录" }).click()
    await page.getByRole("alert").waitFor()
    assert.match(await page.getByRole("alert").innerText(), /保留上次读取/)
    assert.equal(await page.getByText("规范 A", { exact: true }).count(), 1)
    await page.getByText("使用限制 · 查看限制与说明", { exact: true }).click()
    await page.getByText("原检查阻止了本次执行", { exact: true }).waitFor()
    await page.getByText("下一步：请修复已列出的条件后再确认", { exact: true }).waitFor()
    assert.equal(await page.getByText(/technical-rule-id/).isVisible(), false)
    await page.getByText("时间与规则来源", { exact: true }).click()
    await page.getByText(/technical-rule-id/).waitFor({ state: "visible" })
    await page.getByText("时间与规则来源", { exact: true }).click()
    await page.getByText("执行度量 · 已保留的调用记录", { exact: true }).click()
    await page.getByText("原项目执行情况", { exact: true }).waitFor()
    assert.equal(await page.getByText(/technical-operation-id/).isVisible(), false)
    await page.getByText("展开原运行记录", { exact: true }).click()
    await page.getByText(/technical-operation-id/).waitFor({ state: "visible" })
    await page.getByText("展开原运行记录", { exact: true }).click()
    await page.getByText("变更审阅 · 看看文件改了什么", { exact: true }).click()
    assert.equal(await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.filter(x => x[0] === "review").length), 0)
    await page.getByRole("button", { name: "查看改动" }).click()
    await page.getByText("1个变化", { exact: true }).waitFor()
    for (const baseline of ["stage", "project"]) {
      const before = await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.filter(call => call[0] === "review").length)
      await page.getByLabel("比较范围").selectOption(baseline)
      assert.equal(await page.getByText("1个变化", { exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.filter(call => call[0] === "review").length), before)
      await page.getByRole("button", { name: "查看改动" }).click()
      await page.getByRole("region", { name: "关联检查记录" }).getByText(/项目已经推进/).waitFor()
      assert.equal(await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.at(-1)?.[3]), baseline)
    }
    await page.getByLabel("比较范围").selectOption("task")
    assert.equal(await page.getByText("1个变化", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "查看改动" }).click()
    await page.getByText("1个变化", { exact: true }).waitFor()
    await page.getByText("修改 · draft.md", { exact: true }).click()
    assert.match(await page.locator("pre").innerText(), /-old\n\+new/)
    await page.screenshot({ path: resolve(artifacts, "overview-and-review.png"), fullPage: true })
    const count = await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.length)
    await tick(); await tick()
    assert.equal(await page.evaluate(() => (window as unknown as OverviewFixtureWindow).calls.length), count, "no polling or rerender-triggered reads")
    assert.deepEqual(errors, [])
    await page.evaluate(() => (window as unknown as OverviewFixtureWindow).managedOnly())
    await page.getByText("暂无可关联的执行账本记录；不代表项目没有执行。", { exact: true }).waitFor()
    await page.getByText("原托管任务：执行中；服务请求重试 2 次。", { exact: true }).waitFor()
    await page.getByText("托管快照已知耗时：1.5 秒。", { exact: true }).waitFor()
    assert.equal(await page.getByText(/执行中 0 次/).count(), 0)
    await page.getByText("这是关联托管任务的单独快照，不与执行账本相加。", { exact: true }).waitFor()
    console.log("PASS hidden panel is idle; workspace A→B→A rejects stale data; refresh failure labeled; diff explicit and scoped; no repeated reads or React errors")
    if (!process.argv.includes("--overview-only")) await verifyLocalProjects(root, browser, artifacts)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
