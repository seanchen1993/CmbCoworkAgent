/** Actual unified project page: bounded Host search/paging and stale-response fences. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Page } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import type {
  HarnessProjectUseReview,
  HarnessProjectUseReviewInput
} from "../src/shared/project-use-authorization"

interface SearchCall {
  account: number
  after: string
  query: string
}
interface ReviewCall {
  account: number
  input: HarnessProjectUseReviewInput
  review: HarnessProjectUseReview
  released: boolean
}
interface FixtureWindow {
  hostSearch: {
    calls: SearchCall[]
    released: string[]
    hold(query: string): void
    fail(query: string): void
    release(query: string): void
    delayTemplates(): void
    releaseTemplates(count?: number): void
    changeAccount(): void
    openDerived(): void
    pendingDerived(): unknown
    openHostStartUse(): void
    pendingHostStartUse(): unknown
    changeSourceWorkspace(workspace: string): void
    finishTemplateDelay(): void
    releaseCreate(): void
    holdRegistry(): void
    releaseRegistry(): void
    holdReviews(): void
    releaseReviews(): void
    reviewCalls: ReviewCall[]
    createInputs: Array<Record<string, unknown>>
    createCalls: number
    mutationCalls: string[]
    guideDismissals: string[]
    templates: number
  }
}

async function main() {
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined"
    },
    plugins: [
      {
        name: "host-search-owned-context",
        setup(builder) {
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /(?:^|\/)thread-context$/ }, () => ({
            path: "threads",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /\/lib\/harness-notifications$/ }, () => ({
            path: "notifications",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              args.path === "notifications"
                ? "export const useHarnessNotifications=()=>[],refreshAppNotifications=async()=>{};"
                : args.path === "threads"
                  ? `
            const empty={},context={cleanupThread(){},getAllStreamLoadingStates:()=>empty,getThreadStateSummaries:()=>empty};
            export const useThreadContext=()=>context,useThreadStateSummaries=()=>empty,
              useAllStreamLoadingStates=()=>empty,useAllThreadStates=()=>empty;
            export const useThreadStateSelector=()=>null,useThreadState=()=>null,useThreadActions=()=>null,
              useCurrentThread=()=>empty,useThreadStream=()=>empty;
            export const ThreadProvider=({children})=>children,THREAD_MESSAGE_RESIDENT_LIMIT=1500,
              THREAD_MESSAGE_PROTECTED_TAIL=320;
          `
                  : `
            import{useSyncExternalStore}from'react';const listeners=new Set(),noop=()=>{};
            let state={accountRevision:0,threads:[{thread_id:'source-chat',metadata:{workspacePath:'C:/source',agentMode:'normal'}}],models:[],installedPlugins:[],pluginVersion:0,
              currentThreadId:'source-chat',threadDirectoryHasMore:false,threadDirectoryLoadingMore:false,
              createThread:noop,forkThread:noop,selectThread:noop,updateThread:noop,deleteThread:noop,
              finalizeThreadDeletions:noop,bumpPluginVersion:noop,setShowHarnessBoardView:noop,
              setShowCustomizeView:noop};
            const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
            export const useAppStore=selector=>useSyncExternalStore(subscribe,()=>selector(state));
            useAppStore.getState=()=>state;useAppStore.subscribe=subscribe;
            export const isThreadDeletionPending=()=>false,isThreadRetired=()=>false;
            window.fixtureAccount=()=>state.accountRevision;
            window.fixtureChangeAccount=()=>{state={...state,accountRevision:state.accountRevision+1};for(const listener of listeners)listener()};
            window.fixtureChangeSourceWorkspace=workspace=>{state={...state,threads:[{thread_id:'source-chat',metadata:{workspacePath:workspace,agentMode:'normal'}}]};for(const listener of listeners)listener()};
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
      import React from'react';import{createRoot}from'react-dom/client';
      import{HarnessBoardView}from'./src/renderer/src/components/harness-board/HarnessBoardView';
      import{openDerivedProject,readDerivedProjectIntent}from'./src/renderer/src/lib/derived-project-intent';
      import{openPluginStartUse,readHostPluginStartUseIntent}from'./src/renderer/src/lib/plugin-start-use-intent';
      const calls=[],released=[],held=new Set(),failures=new Set(),pending=[];
      let templateDelay=false;const pendingTemplates=[];
      const template={installedPluginId:'delayed-host',name:'延迟模板项目插件',version:'1.0.0',
        stages:['验证阶段'],expectedTemplate:{pluginId:'delayed-host',name:'延迟模板项目插件',
          version:'1.0.0',digest:'a'.repeat(64)}};
      const hostAdapter={id:'delayed-host',name:'延迟模板项目插件',version:'1.0.0',type:'plugin',
        enabled:true,runtimeMode:'host',description:'受控Host模板',pullKnowledgeAvailable:false,
        boardCompatibility:{compatible:false,status:'host-runtime',label:'原生项目模板'}};
      const names=Array.from({length:40},(_,index)=>index===20?'目标第21个项目':index===31?'新词结果':
        index===32?'旧词结果':index===33?'旧账号迟到结果':'通用项目 '+index);
      function projects(account){return names.map((name,index)=>({projectId:'host-'+String(index).padStart(3,'0'),
        name:'账号'+account+' '+name,workspace:'C:/account-'+account+'/project-'+index,
        status:'active',stageIndex:0,updatedAt:index,packageVersion:'1.0.0'}))}
      let releaseCreate,registryDelayed=false,reviewsHeld=false,reviewSequence=0;
      const pendingRegistry=[],pendingReviews=[],reviewCalls=[];
      const guideDismissals=[],mutationCalls=[];
      window.addEventListener('ui-guide:dismiss-current-entry',event=>guideDismissals.push(event.detail.guideId));
      const search={calls,released,templates:0,createCalls:0,createInputs:[],guideDismissals,mutationCalls,reviewCalls,
        openDerived:()=>openDerivedProject('delayed-host','延迟模板项目插件'),
        openHostStartUse:()=>openPluginStartUse({threadId:'source-chat',expectedWorkspace:'C:/source',
          pluginId:hostAdapter.id,expected:{name:hostAdapter.name,version:hostAdapter.version}},
          {identity:template.expectedTemplate,kind:'host-project',canOpen:true,issues:[]}),
        pendingHostStartUse:()=>readHostPluginStartUseIntent(),
        changeSourceWorkspace:workspace=>window.fixtureChangeSourceWorkspace(workspace),
        pendingDerived:()=>readDerivedProjectIntent(),finishTemplateDelay:()=>templateDelay=false,
        holdRegistry:()=>registryDelayed=true,
        releaseRegistry:()=>{registryDelayed=false;pendingRegistry.splice(0).forEach(resolve=>resolve([structuredClone(hostAdapter)]))},
        holdReviews:()=>reviewsHeld=true,
        releaseReviews:()=>{reviewsHeld=false;pendingReviews.splice(0).forEach(release=>release())},
        releaseCreate:()=>releaseCreate?.(),hold:query=>held.add(query),fail:query=>failures.add(query),
        release:query=>{held.delete(query);for(let i=pending.length-1;i>=0;i--)if(pending[i].query===query){const item=pending.splice(i,1)[0];released.push(query);item.resolve(item.rows)}},
        delayTemplates:()=>templateDelay=true,
        releaseTemplates:(count=Infinity)=>{while(count-->0&&pendingTemplates.length)pendingTemplates.shift()([structuredClone(template)])},
        changeAccount:()=>window.fixtureChangeAccount()};window.hostSearch=search;
      const nothing=async()=>{},unsubscribe=()=>()=>{};
      const emptyCatalog={projects:[],registry:[hostAdapter],projectNextCursor:null,registryNextCursor:null,
        summary:{totalProjects:0,matchedProjects:0,activeProjects:0,archivedProjects:0,totalRegistry:1},
        stats:{durationMs:0,responseBytes:0,projectRows:0,registryRows:1,cancelled:false}};
      window.electron={ipcRenderer:{invoke:async()=>[],on:unsubscribe,removeListener(){}},
        process:{platform:'win32'}};
      window.api={featureGates:{isEnabled:async()=>({enabled:true,reason:'fixture'})},
        file:{selectDirectory:async()=>({canceled:false,filePaths:['C:/isolated/create']})},
        plugins:{list:async()=>[]},dashboard:{cancelRequests:nothing,userProfiles:async()=>[]},
        builtinRobot:{getStatus:async()=>({settings:{enabled:false},connectionState:'offline',identityState:'unknown'}),
          onStatus:unsubscribe,getRemoteAccess:async()=>({featureGrants:[],threadGrants:[]}),onRemoteAccessChanged:unsubscribe},
        appNotifications:{list:async()=>[],onChanged:unsubscribe},
        workspace:{select:async()=>'C:/isolated/create',cancelGitPanelReads:nothing,onFilesChanged:unsubscribe},
        harnessBoard:{
          searchEnterpriseProjects:async()=>({projects:[],total:0,hasMore:false}),
          verifyEnterpriseProjectCode:async()=>false,
          reviewProjectUse:async input=>{
            const account=window.fixtureAccount(),held=reviewsHeld;
            if(input.adapterId!==hostAdapter.id||input.adapterType!=='plugin'||
              JSON.stringify(input.expectedNativeTemplate)!==JSON.stringify(template.expectedTemplate))
              throw Error('PROJECT_USE_REVIEW_IDENTITY_MISMATCH');
            const captured=structuredClone(input),sequence=++reviewSequence,
              reviewId='review-'+sequence+'-'+crypto.randomUUID();
            const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([account,captured,reviewId])));
            const reviewDigest=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
            const review={reviewId,reviewDigest,projectId:'owner-'+sequence,
              workspace:input.workspacePath+'/'+input.projectDir,plugin:structuredClone(template.expectedTemplate),
              packageDigest:'b'.repeat(64),sources:[{pluginId:hostAdapter.id,name:hostAdapter.name,
                digest:'c'.repeat(64),capabilities:['process.run'],actionIds:[],configurationOnly:false}],
              scopeNotice:'一次允许本项目通过原界面登记的目录使用所列能力。',
              requiresApplicationEnable:false,expiresAt:Date.now()+60000};
            const request={account,input:captured,review,released:!held};reviewCalls.push(request);
            if(!held)return structuredClone(review);
            return new Promise(resolve=>pendingReviews.push(()=>{request.released=true;resolve(structuredClone(review))}));
          },
          createProject:async input=>{
            const receipt=input.projectUseApproval,request=reviewCalls.find(item=>
              item.review.reviewId===receipt?.reviewId&&item.review.reviewDigest===receipt?.reviewDigest);
            if(!request||!request.released||request.account!==window.fixtureAccount()||
              request.review.expiresAt<=Date.now()||request.input.adapterId!==input.adapterId||
              request.input.adapterType!==input.adapterType||request.input.workspacePath!==input.workspacePath||
              request.input.projectDir!==input.projectDir||
              JSON.stringify(request.input.expectedNativeTemplate)!==JSON.stringify(input.expectedNativeTemplate))
              throw Error('PROJECT_USE_APPROVAL_MISMATCH');
            search.createCalls++;search.createInputs.push(input);
            await new Promise(resolve=>releaseCreate=resolve);
            return {...input,projectId:'created-before-account-switch',
              'harness-adapter':{id:input.adapterId,name:hostAdapter.name,version:hostAdapter.version,type:'plugin'}}},
          catalogPage:async()=>structuredClone(emptyCatalog),registry:async()=>registryDelayed?
          new Promise(resolve=>pendingRegistry.push(resolve)):[structuredClone(hostAdapter)],
          getProjectDetails:async()=>({}),cancelCatalogRequests:nothing,cancelKnowledgePreviewRequests:nothing,
          cancelEnterpriseRequests:nothing,stopWatchRefs:nothing,onWatchRefsChanged:unsubscribe,onManagedRunChanged:unsubscribe,
          getDeployUnitMappings:async()=>[],getLeanTokenConfig:async()=>({leanToken:''}),
          localProjects:{templates:async()=>{search.templates++;return templateDelay?
              new Promise(resolve=>pendingTemplates.push(resolve)):[structuredClone(template)]},
            list:async(after='',query='')=>{const account=window.fixtureAccount();calls.push({account,after,query});
              if(failures.has(query))throw Error('PROJECT_SEARCH_QUERY_INVALID');
              const key=query.trim().toLowerCase();const rows=projects(account).filter(project=>project.projectId>after&&
                (!key||[project.name,project.workspace].some(value=>value.toLowerCase().includes(key)))).slice(0,20);
              return held.has(query)?new Promise(resolve=>pending.push({query,rows,resolve})):rows},
            create:async()=>{throw Error('OLD_HOST_CREATE_MUST_NOT_RUN')},
            get:async projectId=>({project:{...projects(window.fixtureAccount()).find(item=>item.projectId===projectId),
              version:1,goal:'保留原项目进度',manifest:{stages:[{id:'verify',title:'验证阶段',approval:'human',checkIds:[],artifactIds:[]}],
                checks:[],artifacts:[]}},operations:[],preview:{state:'expired'}}),
            command:async(_projectId,input)=>{mutationCalls.push(input.kind);throw Error('UNEXPECTED_EXECUTION')},
            mods:{approve:async()=>{mutationCalls.push('approve');throw Error('UNEXPECTED_APPROVAL')}}}}};
      createRoot(document.getElementById('root')).render(<HarnessBoardView/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  let failurePage: Page | undefined
  const errors: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
    failurePage = page
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    // A trustworthy local origin preserves the app's native Web Crypto behavior.
    await page.route("http://127.0.0.1/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1/")
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    const search = page.getByRole("textbox", { name: "搜索项目、系统编号或插件", exact: true })
    const cards = page.locator('[data-project-runtime="host"]')
    const waitQuery = (query: string, after = "", account = 0) =>
      page.waitForFunction(
        ({ query, after, account }) =>
          (window as unknown as FixtureWindow).hostSearch.calls.some(
            (call) => call.query === query && call.after === after && call.account === account
          ),
        { query, after, account }
      )
    const tick = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )

    const expandHistory = async () => {
      const summary = page.getByText("历史独立运行（兼容查看）", { exact: true })
      await summary.waitFor()
      if (await summary.locator("..").getAttribute("open") === null) await summary.click()
    }
    await search.waitFor()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-project-runtime="host"]').length === 20
    )
    assert.equal(
      await page
        .getByRole("button", { name: "打开项目 账号0 目标第21个项目", exact: true })
        .count(),
      0
    )
    await search.fill("目标第21个")
    await waitQuery("目标第21个")
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号0 目标第21个项目", exact: true }).waitFor()
    assert.equal(await cards.count(), 1)

    await search.fill("通用项目")
    await waitQuery("通用项目")
    await page.waitForFunction(
      () => document.querySelectorAll('[data-project-runtime="host"]').length === 20
    )
    await expandHistory()
    await page.getByRole("button", { name: "加载更多历史运行", exact: true }).click()
    await waitQuery("通用项目", "host-019")
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号0 通用项目 39", exact: true }).waitFor()
    await search.fill("新词")
    await waitQuery("新词")
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号0 新词结果", exact: true }).waitFor()
    assert.equal(await cards.count(), 1, "changing the query resets the previous page and cursor")

    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.hold("旧词"))
    await search.fill("旧词")
    await waitQuery("旧词")
    await page.getByRole("status").filter({ hasText: "正在查找项目" }).waitFor()
    assert.equal(
      await page.getByText("暂无项目", { exact: true }).count(),
      0,
      "a pending backend search must not tell an existing user to create their first project"
    )
    await search.fill("新词")
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号0 新词结果", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.release("旧词"))
    await tick()
    assert.equal(
      await page.getByRole("button", { name: "打开项目 账号0 旧词结果", exact: true }).count(),
      0
    )
    assert.equal(
      await page.getByRole("button", { name: "打开项目 账号0 新词结果", exact: true }).count(),
      1
    )

    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.hold("旧账号"))
    await search.fill("旧账号")
    await waitQuery("旧账号")
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.changeAccount())
    await waitQuery("", "", 1)
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号1 通用项目 0", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.release("旧账号"))
    await tick()
    assert.equal(await search.inputValue(), "")
    assert.equal(await cards.count(), 20)
    assert.equal(await page.getByRole("button", { name: /打开项目 账号0/ }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.templates),
      2,
      "typing and paging must not rescan template sources"
    )
    await search.fill("不存在的关键词")
    await waitQuery("不存在的关键词", "", 1)
    await page.getByText("未找到匹配项目", { exact: true }).waitFor()
    assert.equal(await page.getByText("暂无项目", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "清除搜索", exact: true }).click()
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号1 通用项目 0", exact: true }).waitFor()
    assert.equal(await search.inputValue(), "")
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.fail("失败请求"))
    await search.fill("失败请求")
    await waitQuery("失败请求", "", 1)
    await page.getByRole("alert").filter({ hasText: "搜索内容过长或含无效字符" }).waitFor()
    assert.equal(
      await page.getByText("未找到匹配项目", { exact: true }).count(),
      0,
      "a failed query is not an empty successful search"
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.hold("重试查询"))
    await search.fill("重试查询")
    await waitQuery("重试查询", "", 1)
    await page.getByRole("status").filter({ hasText: "正在查找项目" }).waitFor()
    assert.equal(
      await page.getByRole("alert").count(),
      0,
      "a new search must retire the previous query's error while it is pending"
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.release("重试查询"))
    await page.getByText("未找到匹配项目", { exact: true }).waitFor()

    // A fresh account remount starts with no cached template list. Keep every template
    // request held so opening the form cannot repair a discarded initial response itself.
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).hostSearch
      fixture.delayTemplates()
      fixture.changeAccount()
    })
    await waitQuery("", "", 2)
    await search.fill("目标第21个")
    await waitQuery("目标第21个", "", 2)
    await expandHistory()
    await page.getByRole("button", { name: "打开项目 账号2 目标第21个项目", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.releaseTemplates(1))
    await tick()
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.getByRole("button", { name: "选择插件", exact: true }).click()
    const hostOption = page.getByRole("option", { name: /延迟模板项目插件/ })
    assert.equal(await hostOption.isEnabled(), true)
    await hostOption.click()
    await page.getByRole("textbox", { name: /系统编号/ }).waitFor()
    await page.getByRole("textbox", { name: /项目名称/ }).fill("搜索后使用延迟模板")
    assert.equal(
      await page.getByText("项目插件尚未就绪，请启用插件并更新列表。", { exact: true }).count(),
      0,
      "a valid initial template response must survive intervening project searches"
    )
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.releaseTemplates())
    await tick()
    // The actual board must retire old account handoffs, then claim a current request only once.
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).hostSearch
      fixture.finishTemplateDelay()
      fixture.holdRegistry()
      fixture.openDerived()
    })
    await page.getByRole("status", { name: "正在准备插件项目表单", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.changeAccount())
    await page.waitForFunction(
      () => (window as unknown as FixtureWindow).hostSearch.pendingDerived() === null
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.releaseRegistry())
    await tick()
    assert.equal(
      await page.getByRole("dialog", { name: "新建项目", exact: true }).count(),
      0,
      "an old account's delayed registry response cannot open a form"
    )
    // A saved Creator handoff can arrive while this same Board still shows its old Host trial.
    const openHostDetail = async () => {
      await expandHistory()
      await page.getByRole("button", { name: "打开项目 账号3 通用项目 0", exact: true }).click()
      await page.locator('[aria-label="本地任务运行过程"]').waitFor()
      await page.getByText("保留原项目进度", { exact: true }).waitFor()
    }
    await openHostDetail()
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).hostSearch
      fixture.openHostStartUse()
      fixture.changeSourceWorkspace("C:/changed-source")
    })
    await page.waitForFunction(
      () => (window as unknown as FixtureWindow).hostSearch.pendingHostStartUse() === null
    )
    await tick()
    assert.equal(await page.locator('[aria-label="本地任务运行过程"]').count(), 1)
    assert.equal(
      await page.getByRole("dialog", { name: "新建项目", exact: true }).count(),
      0,
      "an expired source cannot discard the currently selected project"
    )
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).hostSearch
      fixture.changeSourceWorkspace("C:/source")
      fixture.openHostStartUse()
    })
    await page.getByRole("textbox", { name: /系统编号/ }).waitFor()
    assert.equal(
      await page.locator('[aria-label="本地任务运行过程"]').count(),
      0,
      "a valid explicit start-use leaves the old detail so its original form can render"
    )
    assert.equal(
      await page.getByRole("button", { name: /选择插件，当前：延迟模板项目插件/ }).count(),
      1
    )
    assert.equal(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).hostSearch.pendingHostStartUse()
      ),
      null
    )
    await page.getByRole("textbox", { name: /项目名称/ }).fill("保留已打开表单草稿")
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.openHostStartUse())
    await tick()
    assert.equal(
      await page.getByRole("textbox", { name: /项目名称/ }).inputValue(),
      "保留已打开表单草稿"
    )
    assert.equal(await page.getByRole("dialog", { name: "新建项目", exact: true }).count(), 1)
    assert.ok(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).hostSearch.pendingHostStartUse()
      ),
      "a second explicit handoff waits for the current draft"
    )
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.waitForFunction(
      () => (window as unknown as FixtureWindow).hostSearch.pendingHostStartUse() === null
    )
    await page.getByRole("textbox", { name: /系统编号/ }).waitFor()
    assert.equal(
      await page.getByRole("textbox", { name: /项目名称/ }).inputValue(),
      ""
    )
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await openHostDetail()
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.openDerived())
    await page.getByRole("textbox", { name: /系统编号/ }).waitFor()
    assert.equal(await page.getByRole("button", { name: "填写新项目", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.pendingDerived()),
      null,
      "opening the preselected form claims the request exactly once"
    )
    assert.equal(
      await page.getByRole("button", { name: /选择插件，当前：延迟模板项目插件/ }).count(),
      1
    )
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.guideDismissals),
      Array(3).fill("project-mode-getting-started"),
      "explicit plugin use dismisses only this entry's guide"
    )
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.createCalls),
      0,
      "going to use only opens the form; it never creates or starts a project"
    )
    assert.equal(
      await page.locator('[aria-label="本地任务运行过程"]').count(),
      0,
      "a derived creation handoff also leaves an already selected Host detail"
    )
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.mutationCalls),
      [],
      "leaving detail and opening either form never stops, advances or approves the old project"
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.holdReviews())
    await page.getByRole("textbox", { name: /项目名称/ }).fill("提交后切换账号")
    await page.getByRole("textbox", { name: /项目编号/ }).fill("P-ACCOUNT-CAS")
    await page.getByRole("textbox", { name: /项目描述/ }).fill("不重放已消费的创建请求")
    await page.getByRole("textbox", { name: /系统编号/ }).fill("S1")
    await page.getByRole("textbox", { name: /系统名称/ }).fill("通用系统")
    await page.getByRole("textbox", { name: "插件工作区根目录", exact: true }).click()
    await page.waitForFunction(() =>
      (window as unknown as FixtureWindow).hostSearch.reviewCalls.some(
        (request) => !request.released && request.input.workspacePath === "C:/isolated/create"
      )
    )
    assert.equal(
      await page.getByRole("button", { name: /^创建(?:并授权)?$/, exact: true }).isDisabled(),
      true,
      "the original form cannot submit while its actual scope review is pending"
    )
    assert.equal(await page.evaluate(() =>
      (window as unknown as FixtureWindow).hostSearch.createCalls), 0)
    assert.deepEqual(await page.evaluate(() =>
      (window as unknown as FixtureWindow).hostSearch.mutationCalls), [])
    await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.releaseReviews())
    const authorize = page.getByRole("button", { name: "创建并授权", exact: true })
    await authorize.waitFor()
    assert.equal(await authorize.isEnabled(), true)
    await authorize.click()
    await page.waitForFunction(
      () => (window as unknown as FixtureWindow).hostSearch.createCalls === 1
    )
    const createdInput = await page.evaluate(() =>
      (window as unknown as FixtureWindow).hostSearch.createInputs[0])
    assert.equal(createdInput.adapterId, "delayed-host")
    assert.equal(createdInput.projectCode, "P-ACCOUNT-CAS")
    assert.equal(createdInput.systemId, "S1")
    assert.equal(Object.hasOwn(createdInput, "goal"), false)
    assert.deepEqual(createdInput.expectedNativeTemplate, { pluginId: "delayed-host",
      name: "延迟模板项目插件", version: "1.0.0", digest: "a".repeat(64) })
    const approved = await page.evaluate(() =>
      (window as unknown as FixtureWindow).hostSearch.reviewCalls.at(-1)!)
    assert.equal(approved.account, 3)
    assert.equal(approved.input.workspacePath, createdInput.workspacePath)
    assert.equal(approved.input.projectDir, createdInput.projectDir)
    assert.deepEqual(approved.input.expectedNativeTemplate, createdInput.expectedNativeTemplate)
    assert.deepEqual(approved.review.sources.map(source => ({
      capabilities: source.capabilities, configurationOnly: source.configurationOnly
    })), [{ capabilities: ["process.run"], configurationOnly: false }])
    assert.deepEqual(createdInput.projectUseApproval, {
      reviewId: approved.review.reviewId, reviewDigest: approved.review.reviewDigest
    })
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).hostSearch
      fixture.changeAccount()
      fixture.releaseCreate()
    })
    await waitQuery("", "", 4)
    await tick()
    assert.equal(
      await page.getByRole("status", { name: "正在准备插件项目表单", exact: true }).count(),
      0
    )
    assert.equal(await page.getByRole("dialog", { name: "新建项目", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).hostSearch.createCalls),
      1,
      "account remount and the late reply must not replay the submitted creation"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS actual HarnessBoardView searches beyond page one, fences stale responses and retains delayed templates"
    )
  } catch (error) {
    try {
      const output = resolve("output")
      mkdirSync(output, { recursive: true })
      const failure = mkdtempSync(resolve(output, "project-host-search-failure-"))
      writeFileSync(resolve(failure, "pageerrors.json"), JSON.stringify(errors, null, 2))
      if (failurePage) {
        writeFileSync(resolve(failure, "page.html"), await failurePage.content())
        await failurePage.screenshot({ path: resolve(failure, "failure.png"), fullPage: true })
      }
      console.error(`Host search failure evidence: ${failure}`)
    } catch (captureError) {
      console.warn("Host search failure evidence could not be saved:", captureError)
    }
    throw error
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
