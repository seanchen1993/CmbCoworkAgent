/** Production create dialog, Host run and project cards; controlled IPC, no model or app profile. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/project-unified-entry-browser")
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const bundled = await build({ write: false, bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", alias: { "@": renderer }, loader: { ".png": "dataurl", ".md": "text" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}", "import.meta.hot": "undefined" },
    plugins: [{ name: "isolated-store", setup(builder) {
      builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({ path: "store", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
        const state={accountRevision:0,threads:[],models:[],installedPlugins:[]};
        window.fixtureAccount=()=>state.accountRevision++;
        export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state;useAppStore.subscribe=()=>()=>{};
        export const isThreadDeletionPending=()=>false,isThreadRetired=()=>false;
      ` }))
    } }, browserWorkerPlugin()],
    stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{ProjectFormDialog}from'./src/renderer/src/components/harness-board/HarnessBoardView';
      import{HostProjectListItems,LocalProjectRun}from'./src/renderer/src/components/harness-board/LocalProjectsPanel';
      import{parseProjectRuntimeManifestV1}from'./src/shared/project-runtime/manifest';
      const root=createRoot(document.getElementById('root')),calls=[],views={},templates=[{installedPluginId:'host',name:'四阶段项目插件',version:'0.1.3',stages:['转换','需求','规格','设计'],expectedTemplate:{pluginId:'host',name:'四阶段项目插件',version:'0.1.3',digest:'a'.repeat(64)}}];
      let installedIdentity={...templates[0].expectedTemplate};
      window.replaceInstalled=kind=>{installedIdentity={...installedIdentity,...(kind==='version'?{version:'0.1.4'}:{digest:'b'.repeat(64)})}};
      window.resetInstalled=()=>{installedIdentity={pluginId:'host',name:'四阶段项目插件',version:'0.1.3',digest:'a'.repeat(64)};templates[0].expectedTemplate={...installedIdentity}};
      let holdCreate=false,finishCreate;window.holdCreate=()=>holdCreate=true;window.finishCreate=()=>finishCreate();
      const registry=[{id:'host',name:'四阶段项目插件',version:'0.1.3',type:'plugin',enabled:true,runtimeMode:'host',boardCompatibility:{compatible:false,status:'host-runtime',label:'原生项目模板'}},
        {id:'legacy',name:'既有项目插件',version:'1.0.0',type:'plugin',boardCompatibility:{compatible:true,status:'ready',label:'兼容'}},
        {id:'disabled',name:'停用项目插件',version:'1.0.0',type:'plugin',runtimeMode:'host',enabled:false,boardCompatibility:{compatible:false,status:'host-runtime'}},
        {id:'invalid',name:'不兼容插件',version:'1.0.0',type:'plugin',boardCompatibility:{compatible:false,status:'invalid',reason:'原声明不可用'}}];
      function make(input){const id='project-'+Object.keys(views).length;return {project:{projectId:id,name:input.name,goal:input.goal,workspace:input.workspace,
        pluginDigest:'a'.repeat(64),status:'active',stageIndex:0,version:1,updatedAt:1,packageVersion:'0.1.3',manifest:parseProjectRuntimeManifestV1({
          apiVersion:'devclaw.project-runtime/v1',plugin:{id:'four-stage',version:'0.1.3'},mode:'host',stateOwner:'host',
          stages:['转换','需求','规格','设计'].map((title,index)=>({id:'stage'+index,title,skill:'draft',actionIds:[],artifactIds:[],checkIds:[],approval:'none'})),actions:[],artifacts:[],checks:[],environment:[],
          capabilities:{execution:true,conditionalTransition:true,idempotency:true,reconciliation:true,cancellation:true}})},operations:[]}}
      window.api={file:{selectDirectory:async()=>({canceled:false,filePaths:['C:/fixture/project']})},
        harnessBoard:{searchEnterpriseProjects:async()=>[],createProject:async input=>{calls.push(['legacy-create',input]);return{}},
          localProjects:{get:async id=>{calls.push(['get',id]);return structuredClone(views[id])},mods:{read:async id=>({projectId:id,projectVersion:1,packageDigest:'a'.repeat(64),workspace:'C:/fixture/project'}),approve:async()=>{throw Error('NO_AUTO_APPROVAL')}},
            create:async input=>{calls.push(['host-create',input]);if(JSON.stringify(input.expectedTemplate)!==JSON.stringify(installedIdentity))throw Error('PROJECT_HOST_PACKAGE_IDENTITY_MISMATCH');const result=make(input);views[result.project.projectId]=result;if(holdCreate)await new Promise(resolve=>finishCreate=resolve);return structuredClone(result)},
            command:async()=>{throw Error('NO_AUTO_START')}}}};
      const blank=()=>({name:'既有项目',description:'独立目标',projectCode:'P001',systemId:'S1',systemName:'系统',projectDir:'legacy',workspacePath:'C:/fixture',adapterType:'plugin',adapterId:'',projectFromLean:false});
      function Fixture(){const[open,setOpen]=useState(false),[form,setForm]=useState(blank),[selected,setSelected]=useState(),[items,setItems]=useState([]);
        window.fixture={calls,refreshTemplate:()=>{templates[0].expectedTemplate={...installedIdentity};setForm(value=>({...value}))},missingTemplate:()=>delete templates[0].expectedTemplate,remount:()=>{setSelected(undefined);setItems(Object.values(views).map(v=>v.project))}};
        if(selected)return <><button onClick={()=>setSelected(undefined)}>项目列表</button><LocalProjectRun key={selected} projectId={selected} onChanged={()=>{}}/></>;
        return <><button onClick={()=>{setForm(blank());setOpen(true)}}>新建项目</button><HostProjectListItems projects={items} onSelect={setSelected}/>
          <ProjectFormDialog open={open} creating={false} form={form} registry={registry} hostTemplates={templates}
            installingPluginNames={new Set()} error={null} verification={{pending:false,error:null}} onOpenChange={setOpen} onChange={setForm}
            onInstallPlugin={()=>{throw Error('NO_AUTO_INSTALL')}} onPickWorkspace={()=>{}} onSubmit={async()=>{await window.api.harnessBoard.createProject(form);setOpen(false)}}
            onHostCreated={view=>{setItems(Object.values(views).map(v=>v.project));setOpen(false);setSelected(view.project.projectId)}}/></>}
      root.render(<Fixture/>);
    ` } })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    page.setDefaultTimeout(30000)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("status").getByText("先选择项目插件，再填写所需信息。", { exact: true }).waitFor()
    for (const name of ["项目编号 *", "项目名称 *", "系统编号 *", "系统名称 *", "插件配置"])
      assert.equal(await page.getByText(name, { exact: true }).count(), 0,
        "unselected projects must not show legacy metadata or workspace fields")
    assert.equal(await page.getByRole("button", { name: "创建", exact: true }).count(), 0)
    assert.equal(await page.getByRole("textbox", { name: "希望完成什么", exact: true }).count(), 0)
    assert(await page.getByRole("button", { name: "取消", exact: true }).isEnabled())
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.fixture.calls"), [])
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("button", { name: "选择插件", exact: true }).click()
    assert(await page.getByRole("option", { name: /停用项目插件/ }).isDisabled())
    assert(await page.getByRole("option", { name: /不兼容插件/ }).isDisabled())
    await page.getByRole("option", { name: /既有项目插件/ }).click()
    for (const name of ["项目编号 *", "项目名称 *", "系统编号 *", "系统名称 *", "插件配置"])
      await page.getByText(name, { exact: true }).waitFor()
    const systemId = page.getByRole("textbox", { name: /系统编号/ })
    await systemId.fill("")
    assert(await page.getByRole("button", { name: "创建", exact: true }).isDisabled(),
      "legacy required metadata validation stays active")
    await systemId.fill("S1")
    assert(await page.getByRole("button", { name: "创建", exact: true }).isEnabled())
    await page.getByRole("button", { name: /选择插件，当前/ }).click()
    await page.getByRole("option", { name: /四阶段项目插件/ }).click()
    for (const name of ["项目编号 *", "系统编号 *", "系统名称 *", "插件配置"])
      assert.equal(await page.getByText(name, { exact: true }).count(), 0,
        "switching to Host must show only the native goal form")
    await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("原生四阶段项目")
    await page.getByRole("textbox", { name: "希望完成什么", exact: true }).fill("按原四阶段执行")
    await page.getByRole("button", { name: "选择工作目录", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.fixture.calls"), [])
    await page.getByRole("button", { name: "创建项目", exact: true }).click()
    for (const title of ["当前：转换", "待开始：需求", "待开始：规格", "待开始：设计"])
      await page.getByText(title, { exact: true }).waitFor()
    const creates = await page.evaluate("window.fixture.calls.filter(c=>c[0].endsWith('create'))")
    assert.deepEqual(creates, [["host-create", { name: "原生四阶段项目", goal: "按原四阶段执行", workspace: "C:/fixture/project", installedPluginId: "host", expectedTemplate: { pluginId: "host", name: "四阶段项目插件", version: "0.1.3", digest: "a".repeat(64) } }]])
    await page.getByRole("button", { name: "项目列表", exact: true }).click()
    await page.getByRole("button", { name: "打开项目 原生四阶段项目", exact: true }).click()
    await page.getByText("待开始：设计", { exact: true }).waitFor()
    await page.getByRole("button", { name: "项目列表", exact: true }).click()
    await page.evaluate("window.fixture.remount()")
    await page.getByRole("button", { name: "打开项目 原生四阶段项目", exact: true }).waitFor()
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("button", { name: "选择插件", exact: true }).click()
    await page.getByRole("option", { name: /既有项目插件/ }).click()
    await page.getByRole("button", { name: "创建", exact: true }).click()
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='legacy-create').length"), 1)
    for (const kind of ["version", "content", "missing"]) {
      await page.evaluate("window.resetInstalled()")
      if (kind === "missing") await page.evaluate("window.fixture.missingTemplate()")
      await page.getByRole("button", { name: "新建项目", exact: true }).click()
      await page.getByRole("button", { name: "选择插件", exact: true }).click()
      await page.getByRole("option", { name: /四阶段项目插件/ }).click()
      await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("身份变化拒绝创建")
      await page.getByRole("textbox", { name: "希望完成什么", exact: true }).fill("冻结原选择")
      await page.getByRole("button", { name: "选择工作目录", exact: true }).click()
      const before = await page.evaluate<number>("window.fixture.calls.filter(c=>c[0]==='host-create').length")
      if (kind !== "missing") await page.evaluate(kind => (window as unknown as { replaceInstalled(value: string): void }).replaceInstalled(kind), kind)
      if (kind === "content") await page.evaluate("window.fixture.refreshTemplate()")
      await page.getByRole("button", { name: "创建项目", exact: true }).click()
      await page.getByRole("alert").getByText("项目插件身份尚未就绪或已变化。请更新列表，重新选择插件后再创建。", { exact: true }).waitFor()
      const submitted = await page.evaluate<Array<[string, { expectedTemplate?: { version: string; digest: string } }]>>("window.fixture.calls.filter(c=>c[0]==='host-create')")
      assert.equal(submitted.length, before + (kind === "missing" ? 0 : 1))
      if (kind !== "missing") {
        assert.equal(submitted.at(-1)![1].expectedTemplate!.version, "0.1.3")
        assert.equal(submitted.at(-1)![1].expectedTemplate!.digest, "a".repeat(64))
      }
      assert.equal(await page.getByText("当前：转换", { exact: true }).count(), 0)
      await page.getByRole("button", { name: "返回列表", exact: true }).click()
    }
    await page.evaluate("window.resetInstalled()")

    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("button", { name: "选择插件", exact: true }).click()
    await page.getByRole("option", { name: /四阶段项目插件/ }).click()
    await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("旧账号迟到创建")
    await page.getByRole("textbox", { name: "希望完成什么", exact: true }).fill("不跨账号导航")
    await page.getByRole("button", { name: "选择工作目录", exact: true }).click()
    await page.evaluate("window.holdCreate()")
    await page.getByRole("button", { name: "创建项目", exact: true }).click()
    assert(await page.getByRole("button", { name: /选择插件，当前/ }).isDisabled())
    assert(await page.getByRole("button", { name: "返回列表", exact: true }).isDisabled())
    await page.evaluate("window.fixtureAccount();window.finishCreate()")
    await page.getByRole("button", { name: "创建项目", exact: true }).waitFor()
    assert.equal(await page.getByText("当前：转换", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("region", { name: "本地项目任务", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ passed: true, scope: "Production dialog/list/run components, controlled IPC; no model, grants or stage success fabricated", checks: ["Host in ordinary picker", "disabled and incompatible denied", "exact Host create payload", "four retained stages", "reopen", "legacy create unchanged", "busy selector locked and late account response cannot open project", "selected version/digest frozen across replacement and prop refresh", "missing template identity does not dispatch"] }, null, 2))
    console.log("PASS unified project dialog selects Host and legacy, exact create, four stages and reopen without automatic execution")
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
