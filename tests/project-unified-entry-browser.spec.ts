/** Production create dialog, Host run and project cards; controlled IPC, no model or app profile. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/project-unified-entry-browser")
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined"
    },
    plugins: [
      {
        name: "isolated-store",
        setup(builder) {
          builder.onLoad({ filter: /HarnessBoardView\.tsx$/ }, (args) => ({
            loader: "tsx",
            resolveDir: dirname(args.path),
            contents: readFileSync(args.path, "utf8") + "\nexport { ProjectEditDialog }\n"
          }))
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents: `
        const state={accountRevision:0,threads:[{thread_id:'creator',metadata:{workspacePath:'C:/author',agentMode:'normal'}}],models:[],installedPlugins:[]};
        window.fixtureAccount=()=>state.accountRevision++;
        export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state;useAppStore.subscribe=()=>()=>{};
        export const isThreadDeletionPending=()=>false,isThreadRetired=()=>false;
      `
          }))
        }
      },
      browserWorkerPlugin()
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{ProjectFormDialog,ProjectEditDialog}from'./src/renderer/src/components/harness-board/HarnessBoardView';
      import{HostProjectListItems,LocalProjectRun}from'./src/renderer/src/components/harness-board/LocalProjectsPanel';
      import{parseProjectRuntimeManifestV1}from'./src/shared/project-runtime/manifest';
      const root=createRoot(document.getElementById('root')),calls=[],reviews=[],views={},templates=[{installedPluginId:'host',name:'四阶段项目插件',version:'0.1.3',stages:['转换','需求','规格','设计'],expectedTemplate:{pluginId:'host',name:'四阶段项目插件',version:'0.1.3',digest:'a'.repeat(64)}}];
      let installedIdentity={...templates[0].expectedTemplate};
      window.replaceInstalled=kind=>{installedIdentity={...installedIdentity,...(kind==='version'?{version:'0.1.4'}:{digest:'b'.repeat(64)})}};
      window.resetInstalled=()=>{installedIdentity={pluginId:'host',name:'四阶段项目插件',version:'0.1.3',digest:'a'.repeat(64)};templates[0].expectedTemplate={...installedIdentity}};
      let holdCreate=false,finishCreate;window.holdCreate=()=>holdCreate=true;window.finishCreate=()=>finishCreate();
      const registry=[{id:'host',name:'四阶段项目插件',version:'0.1.3',type:'plugin',enabled:true,runtimeMode:'host',boardCompatibility:{compatible:false,status:'host-runtime',label:'原生项目模板'}},
        {id:'legacy',name:'既有项目插件',version:'1.0.0',type:'plugin',boardCompatibility:{compatible:true,status:'ready',label:'兼容'}},
        {id:'disabled',name:'停用项目插件',version:'1.0.0',type:'plugin',runtimeMode:'host',enabled:false,boardCompatibility:{compatible:false,status:'host-runtime'}},
        {id:'invalid',name:'不兼容插件',version:'1.0.0',type:'plugin',boardCompatibility:{compatible:false,status:'invalid',reason:'原声明不可用'}},
        ...Array.from({length:40},(_,i)=>({id:'extra-'+i,name:'扩展插件'+String(i).padStart(2,'0'),version:'1.0.0',type:'plugin',boardCompatibility:{compatible:true,status:'ready',label:'兼容'}}))];
      function make(input){const id='project-'+Object.keys(views).length;return {project:{projectId:id,name:input.name,goal:input.goal,workspace:input.workspace,
        pluginDigest:'a'.repeat(64),status:'active',stageIndex:0,version:1,updatedAt:1,packageVersion:'0.1.3',manifest:parseProjectRuntimeManifestV1({
          apiVersion:'devclaw.project-runtime/v1',plugin:{id:'four-stage',version:'0.1.3'},mode:'host',stateOwner:'host',
          stages:['转换','需求','规格','设计'].map((title,index)=>({id:'stage'+index,title,skill:'draft',actionIds:[],artifactIds:[],checkIds:[],approval:'none'})),actions:[],artifacts:[],checks:[],environment:[],
          capabilities:{execution:true,conditionalTransition:true,idempotency:true,reconciliation:true,cancellation:true}})},operations:[]}}
      window.api={plugins:{prepareStartUse:async()=>({kind:'host-project',canOpen:true,identity:installedIdentity,issues:[]})},file:{selectDirectory:async()=>({canceled:false,filePaths:['C:/fixture/project']})},
        harnessBoard:{searchEnterpriseProjects:async()=>[],reviewProjectUse:async input=>(reviews.push(input),{reviewId:'review-'+input.projectDir,reviewDigest:'c'.repeat(64),projectId:input.existingProjectId??'allocated',workspace:input.workspacePath+'/'+input.projectDir,plugin:installedIdentity,packageDigest:'d'.repeat(64),sources:[{pluginId:'host',name:'四阶段项目插件',digest:'e'.repeat(64),capabilities:['process.run'],actionIds:[],configurationOnly:false}],scopeNotice:'仅用于本项目通过原界面登记的目录。',requiresApplicationEnable:false,...(input.existingProjectId?{authorizationCurrent:true}:{}),expiresAt:Date.now()+60000}),createProject:async input=>{calls.push(['legacy-create',input]);return{}},
          localProjects:{get:async id=>{calls.push(['get',id]);return structuredClone(views[id])},mods:{read:async id=>({projectId:id,projectVersion:1,packageDigest:'a'.repeat(64),workspace:'C:/fixture/project'}),approve:async()=>{throw Error('NO_AUTO_APPROVAL')}},
            create:async input=>{calls.push(['host-create',input]);if(JSON.stringify(input.expectedPlugin??input.expectedTemplate)!==JSON.stringify(installedIdentity))throw Error('PROJECT_HOST_PACKAGE_IDENTITY_MISMATCH');const result=make(input);views[result.project.projectId]=result;if(holdCreate)await new Promise(resolve=>finishCreate=resolve);return structuredClone(result)},
            command:async()=>{throw Error('NO_AUTO_START')}}}};
      const blank=()=>({name:'既有项目',description:'独立目标',projectCode:'P001',systemId:'S1',systemName:'系统',projectDir:'legacy',workspacePath:'C:/fixture',adapterType:'plugin',adapterId:'',projectFromLean:false,isTestProject:true});
      function Fixture(){const[open,setOpen]=useState(false),[editing,setEditing]=useState(false),[form,setForm]=useState(blank),[selected,setSelected]=useState(),[items,setItems]=useState([]),[startUse,setStartUse]=useState(),[workspaceError,setWorkspaceError]=useState(null),[workspaceValidating,setWorkspaceValidating]=useState(false);
        window.startSaved=()=>{setStartUse({id:'saved-intent',accountRevision:0,input:{threadId:'creator',expectedWorkspace:'C:/author',pluginId:'host',expected:installedIdentity},report:{kind:'host-project',canOpen:true,identity:installedIdentity,issues:[]}});setForm({...blank(),adapterId:'host'});setOpen(true)};
        window.editSaved=()=>{setForm({...blank(),adapterId:'host'});setEditing(true)};
        window.fixture={calls,reviews,setWorkspaceState:(error,pending)=>{setWorkspaceError(error);setWorkspaceValidating(pending)},refreshTemplate:()=>{templates[0].expectedTemplate={...installedIdentity};setForm(value=>({...value}))},missingTemplate:()=>delete templates[0].expectedTemplate,remount:()=>{setSelected(undefined);setItems(Object.values(views).map(v=>v.project))}};
        if(selected)return <><button onClick={()=>setSelected(undefined)}>项目列表</button><LocalProjectRun key={selected} projectId={selected} onChanged={()=>{}}/></>;
        return <><button onClick={()=>{setStartUse(undefined);setForm(blank());setOpen(true)}}>新建项目</button><HostProjectListItems projects={items} onSelect={setSelected}/>
          <ProjectFormDialog open={open} creating={false} form={form} registry={registry} hostTemplates={templates} hostStartUse={startUse}
            workspaceError={workspaceError} workspaceValidating={workspaceValidating} installingPluginNames={new Set()} error={null} verification={{pending:false,error:null}} onOpenChange={setOpen} onChange={setForm}
            onInstallPlugin={()=>{throw Error('NO_AUTO_INSTALL')}} onPickWorkspace={()=>{}} onSubmit={async approval=>{await window.api.harnessBoard.createProject({...form,...(approval?{projectUseApproval:approval}:{})});setOpen(false)}}
            onHostCreated={view=>{setItems(Object.values(views).map(v=>v.project));setOpen(false);setSelected(view.project.projectId)}}/>
          <ProjectEditDialog projectId="existing-owner" open={editing} saving={false} form={form} registry={registry}
            installingPluginNames={new Set()} error={null} verification={{pending:false,error:null}} onOpenChange={setEditing} onChange={setForm}
            onInstallPlugin={()=>{throw Error('NO_AUTO_INSTALL')}} onSubmit={approval=>{calls.push(['edit',{...form,...(approval?{projectUseApproval:approval}:{})}]);setEditing(false)}}/></>}
      root.render(<Fixture/>);
    `
    }
  })
  const cssPath = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "components/harness-board/HarnessBoardView.tsx",
      "components/harness-board/LocalProjectsPanel.tsx",
      ...readdirSync(resolve(renderer, "components/ui"))
        .filter((name) => name.endsWith(".tsx"))
        .map((name) => `components/ui/${name}`)
    ].map((name) => ({ content: readFileSync(resolve(renderer, name), "utf8"), extension: "tsx" }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    page.setDefaultTimeout(30000)
    const errors: string[] = []
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error(error.message)
    })
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    for (const name of ["项目编号 *", "项目名称 *", "系统编号 *", "系统名称 *", "插件配置"])
      assert.equal(
        await page.getByText(name, { exact: true }).count(),
        1,
        "ordinary project metadata remains the only creation form"
      )
    assert(await page.getByRole("button", { name: /^(创建|创建并授权)$/ }).isDisabled())
    assert.equal(await page.getByRole("textbox", { name: "希望完成什么", exact: true }).count(), 0)
    assert(await page.getByRole("button", { name: "取消", exact: true }).isEnabled())
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.fixture.calls"), [])
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("button", { name: "选择插件", exact: true }).click()
    const options = page.getByRole("dialog", { name: "选择插件", exact: true })
    assert(
      await page.getByRole("textbox", { name: "搜索插件", exact: true }).evaluate((input) => {
        const box = input.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input
      }),
      "plugin search must not be clipped by the parent dialog"
    )
    const list = options.locator('[class~="overflow-y-auto"]')
    await list.waitFor()
    const visibleOption = page.getByRole("option", { name: /扩展插件00/ })
    await visibleOption.scrollIntoViewIfNeeded()
    await visibleOption.hover()
    await page.mouse.wheel(0, 900)
    await page.waitForFunction(() => {
      const list = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="选择插件"] [class~="overflow-y-auto"]'
      )
      return !!list && list.scrollTop > 0
    })
    assert(
      await page.getByRole("textbox", { name: "搜索插件", exact: true }).evaluate((input) => {
        const box = input.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input
      }),
      "wheel must scroll options without hiding the search or moving the parent dialog"
    )
    const box = await options.boundingBox()
    assert(box && box.y >= 0 && box.y + box.height <= 900, "picker stays inside viewport")
    await page.screenshot({ path: resolve(output, "plugin-picker-scroll.png") })
    await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill("既有项目插件")
    await page.getByRole("option", { name: /既有项目插件/ }).waitFor()
    await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill("")
    assert(await page.getByRole("option", { name: /停用项目插件/ }).isDisabled())
    assert(await page.getByRole("option", { name: /不兼容插件/ }).isDisabled())
    await page.getByRole("option", { name: /既有项目插件/ }).click()
    for (const name of ["项目编号 *", "项目名称 *", "系统编号 *", "系统名称 *", "插件配置"])
      await page.getByText(name, { exact: true }).waitFor()
    const systemId = page.getByRole("textbox", { name: /系统编号/ })
    await systemId.fill("")
    assert(
      await page.getByRole("button", { name: "创建", exact: true }).isDisabled(),
      "legacy required metadata validation stays active"
    )
    await systemId.fill("S1")
    assert(await page.getByRole("button", { name: "创建", exact: true }).isEnabled())
    await page.getByRole("button", { name: /选择插件，当前/ }).click()
    await page.getByRole("option", { name: /四阶段项目插件/ }).click()
    await page.setViewportSize({ width: 760, height: 520 })
    await page.getByRole("button", { name: /选择插件，当前/ }).click()
    await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill("扩展插件")
    await page.getByRole("option", { name: /扩展插件00/ }).hover()
    await page.mouse.wheel(0, 700)
    await page.waitForFunction(() => {
      const list = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="选择插件"] [class~="overflow-y-auto"]'
      )
      return !!list && list.scrollTop > 0
    })
    assert(
      await page.getByRole("textbox", { name: "搜索插件", exact: true }).evaluate((input) => {
        const box = input.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input
      }),
      "Host dialog picker stays usable in short windows"
    )
    await page.screenshot({ path: resolve(output, "host-plugin-picker-short-window.png") })
    await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill("四阶段项目插件")
    await page.getByRole("option", { name: /四阶段项目插件/ }).click()
    await page.setViewportSize({ width: 1100, height: 900 })
    for (const name of ["项目编号 *", "项目名称 *", "系统编号 *", "系统名称 *", "插件配置"])
      await page.getByText(name, { exact: true }).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "希望完成什么", exact: true }).count(), 0)
    assert.equal(
      await page
        .getByText("创建仅保存配置；进入项目后点击“开始当前阶段”才会调用助手。", { exact: true })
        .count(),
      0
    )
    await page.getByRole("textbox", { name: /系统编号/ }).fill("")
    assert(await page.getByRole("button", { name: /^(创建|创建并授权)$/ }).isDisabled())
    await page.getByRole("textbox", { name: /系统编号/ }).fill("S1")
    await page.screenshot({ path: resolve(output, "native-original-project-form.png") })
    await page.getByRole("button", { name: "创建并授权", exact: true }).click()
    const first = (await page.evaluate("window.fixture.calls[0]")) as [
      string,
      Record<string, unknown>
    ]
    assert.equal(first[0], "legacy-create") // Same existing harness create endpoint for every engine.
    assert.equal(first[1].adapterId, "host")
    assert.equal(first[1].projectCode, "P001")
    assert.equal(first[1].systemId, "S1")
    assert.deepEqual(first[1].projectUseApproval, {
      reviewId: "review-legacy",
      reviewDigest: "c".repeat(64)
    })
    assert(!Object.hasOwn(first[1], "goal"), "project creation does not create a feature goal/run")
    assert.equal(await page.getByText("当前：转换", { exact: true }).count(), 0)
    await page.evaluate("window.startSaved()")
    for (const name of ["项目编号 *", "项目名称 *", "系统编号 *", "系统名称 *", "插件配置"])
      await page.getByText(name, { exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "saved-original-project-form.png") })
    await page.getByRole("button", { name: "创建并授权", exact: true }).click()
    assert.equal(await page.evaluate("window.fixture.calls[1][1].adapterId"), "host")
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("button", { name: "选择插件", exact: true }).click()
    await page.getByRole("option", { name: /既有项目插件/ }).click()
    await page.getByRole("button", { name: "创建", exact: true }).click()
    assert.equal(await page.evaluate("window.fixture.calls[2][1].adapterId"), "legacy")
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='host-create').length"),
      0
    )
    await page.evaluate("window.editSaved()")
    const editing = page.getByRole("dialog", { name: "编辑项目", exact: true })
    await editing.getByText("已沿用创建项目时的授权。", { exact: false }).waitFor()
    await editing.getByRole("textbox", { name: "项目名称 *", exact: true }).fill("仅修改项目名称")
    assert.equal(await editing.getByRole("button", { name: "保存并授权", exact: true }).count(), 0)
    await editing.getByRole("button", { name: "保存", exact: true }).click()
    const saved = await page.evaluate("window.fixture.calls[3][1]")
    assert.equal(saved.name, "仅修改项目名称")
    assert(
      !Object.hasOwn(saved, "projectUseApproval"),
      "metadata edit does not authorize or enable again"
    )
    const reviewsBeforeInvalid = await page.evaluate("window.fixture.reviews.length")
    await page.evaluate(() => {
      const fixture = window as unknown as {
        fixture: { setWorkspaceState(error: string | null, pending: boolean): void }
        startSaved(): void
      }
      fixture.fixture.setWorkspaceState("插件工作区必须为空，不能包含隐藏文件或文件夹", false)
      fixture.startSaved()
    })
    await page.getByRole("alert").filter({ hasText: "插件工作区必须为空" }).waitFor()
    await page.getByText("请选择新建的空文件夹。已有代码仓库请在创建特性时选择，不要清空代码仓库。", { exact: true }).waitFor()
    // Cover the debounce boundary: invalid directories must never start a second review.
    await page.waitForTimeout(450)
    assert.equal(await page.evaluate("window.fixture.reviews.length"), reviewsBeforeInvalid)
    assert.equal(await page.getByText("重新核对", { exact: true }).count(), 0)
    assert.equal(await page.getByText(/无法核对插件/).count(), 0)
    assert(await page.getByRole("button", { name: /^(创建|创建并授权)$/ }).isDisabled())
    await page.screenshot({ path: resolve(output, "invalid-workspace-guidance.png") })
    await page.evaluate("window.fixture.setWorkspaceState(null,true)")
    await page.getByRole("alert").filter({ hasText: "插件工作区必须为空" }).waitFor({ state: "detached" })
    await page.waitForTimeout(450)
    assert.equal(await page.evaluate("window.fixture.reviews.length"), reviewsBeforeInvalid)
    assert(await page.getByRole("button", { name: /^(创建|创建并授权)$/ }).isDisabled())
    await page.evaluate("window.fixture.setWorkspaceState(null,false)")
    await page.getByRole("button", { name: "创建并授权", exact: true }).click({ trial: true })
    assert.equal(await page.evaluate("window.fixture.reviews.length"), reviewsBeforeInvalid + 1)
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Actual original project form/CSS; controlled harness create callback, no runtime execution",
          checks: [
            "original metadata and validation for all plugins",
            "no goal/stage standalone create page",
            "same harness create endpoint",
            "saved/manual same original form",
            "legacy unchanged",
            "existing authorized project metadata save does not authorize again",
            "picker wheel and short viewport",
            "invalid or pending workspace blocks review; a valid replacement restores one-time consent"
          ]
        },
        null,
        2
      )
    )
    console.log(
      "PASS original project creation for native and legacy plugins, no standalone run diversion"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
