/** Original session-entry handlers in real React; IPC and the TabbedPanel boundary are fixtures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const renderer = resolve("src/renderer/src")
const entry = resolve(renderer, "components/harness-board/HarnessBoardView.tsx")

async function main() {
  const output = resolve("output", `native-feature-session-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
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
        name: "original-session-owned-boundaries",
        setup(builder) {
          builder.onLoad({ filter: /HarnessBoardView\.tsx$/ }, () => ({
            loader: "tsx",
            resolveDir: dirname(entry),
            contents: readFileSync(entry, "utf8") + "\nexport { FeatureDetailPage }\n"
          }))
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /(?:^|\/)thread-context$/ }, () => ({
            path: "threads",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /(?:^|\/)TabbedPanel$/ }, () => ({
            path: "chat-boundary",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /\/lib\/harness-notifications$/ }, () => ({
            path: "notifications",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents:
              args.path === "notifications"
                ? "export const useHarnessNotifications=()=>[],refreshAppNotifications=async()=>{}"
                : args.path === "threads"
                  ? `
              const empty={},context={cleanupThread(){},getAllStreamLoadingStates:()=>empty,getThreadStateSummaries:()=>empty};
              export const useThreadContext=()=>context,useThreadStateSummaries=()=>empty,useAllStreamLoadingStates=()=>empty,useAllThreadStates=()=>empty;
              export const useThreadStateSelector=()=>null,useThreadState=()=>null,useThreadActions=()=>null,useCurrentThread=()=>empty,useThreadStream=()=>empty;
              export const ThreadProvider=({children})=>children,THREAD_MESSAGE_RESIDENT_LIMIT=1500,THREAD_MESSAGE_PROTECTED_TAIL=320;
            `
                  : args.path === "chat-boundary"
                    ? `
              import React from'react';import{useAppStore}from'@/lib/store';
              import{getPendingHarnessNextAction}from'./src/renderer/src/lib/harness-next-action';
              import{NativeProjectChatGuide}from'./src/renderer/src/components/harness-board/NativeProjectChatGuide';
              export function TabbedPanel(props){const thread=useAppStore(s=>s.threads.find(t=>t.thread_id===props.threadId));
                const pending=getPendingHarnessNextAction(props.threadId);
                return <section aria-label="受控聊天边界" data-thread-id={props.threadId}>
                  <NativeProjectChatGuide threadId={props.threadId} renderMarkdown={text=><p>{text}</p>}>{null}</NativeProjectChatGuide>
                  <output data-metadata>{JSON.stringify(thread?.metadata)}</output>
                  <textarea aria-label="会话草稿边界" disabled={!!props.readOnlyReason||!!thread?.metadata?.hostProjectRuntime}
                    defaultValue={pending?.userMessage??''}/></section>}
              export default TabbedPanel;
            `
                    : `
              import{useSyncExternalStore}from'react';const listeners=new Set(),noop=()=>{};
              const initial={thread_id:'existing',created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z',title:'已有讨论',
                metadata:{workspacePath:'C:/chosen-repository',agentMode:'normal',harnessFeature:{projectId:'container',slug:'request-a',source:'autobiz'}}};
              let state={accountRevision:0,threads:[initial],models:[],installedPlugins:[],pluginVersion:0,currentThreadId:'existing',
                threadDirectoryHasMore:false,threadDirectoryLoadingMore:false,forkThread:noop,updateThread:noop,deleteThread:noop,
                finalizeThreadDeletions:noop,bumpPluginVersion:noop,setShowHarnessBoardView:noop,setShowCustomizeView:noop};
              const emit=()=>{for(const callback of listeners)callback()};
              state.createThread=async(metadata,options)=>{const thread=await window.api.threads.create(metadata);
                state={...state,threads:[thread,...state.threads],currentThreadId:thread.thread_id};emit();return thread};
              state.selectThread=async id=>{state={...state,currentThreadId:id};emit()};
              const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
              export const useAppStore=selector=>useSyncExternalStore(subscribe,()=>selector(state));
              useAppStore.getState=()=>state;useAppStore.subscribe=subscribe;
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
        import React from'react';import{createRoot}from'react-dom/client';
        import{HarnessBoardView,FeatureDetailPage}from'./src/renderer/src/components/harness-board/HarnessBoardView';
        import{useAppStore}from'@/lib/store';import{getPendingHarnessNextAction}from'./src/renderer/src/lib/harness-next-action';
        const mode=window.sessionMode,calls=[],nothing=async()=>{},unsubscribe=()=>()=>{};
        const project={projectId:'container',name:'原项目',description:'',projectCode:'project',projectDir:'project',systemId:'system',systemName:'System',
          workspacePath:'C:/project-parent',projectRootPath:'C:/project-parent/project',projectFromLean:false,
          harnessAdapter:{id:'plugin',name:'generic-project',version:'1.0.0',type:'plugin'},
          lifecycle:{status:'active',createAt:'2026-11-01T00:00:00Z'},boardCompatibility:{status:'compatible',compatible:true,label:'兼容'},
          supportsDeployUnits:false,supportsSessionContextInjection:false};
        const nodes=[{id:'collect',label:'整理资料',nodeStatus:'not_started',status:{label:'未开始',uiKind:'pending'},artifacts:[],hooks:[]}];
        const workflow={display:{mode:'ordered_nodes'},nodes:nodes.map(node=>({...node,userGuide:'请准备本次评估的范围和材料。完成后查看评估报告。',states:[{nodeStatus:'not_started',nextAction:{userMessage:'请先讨论原需求，不要直接执行'}}]}))};
        const detail={project,workflow,adapterSnapshot:{mode:'run',mock:false},sessions:[],
          ...(mode.native?{nativeBinding:{engine:'host',hostRunId:'run-a',projectId:'container',featureId:'request-a',workspace:'C:/isolated-execution',repositoryWorkspace:'C:/chosen-repository',installedPluginId:'plugin',packageDigest:'a'.repeat(64)}}:{}),
          run:{id:'request-a',slug:'request-a',title:'需求A',currentNodeId:'collect',nodes,featureStatus:'not_started',skipNodeAvailable:false,selectedDeployUnits:[],resolvedSessionWorkspacePath:'C:/chosen-repository'}};
        const projectDetail={project,workflow,adapterSnapshot:{mode:'project',mock:false},watchRefs:[],loading:false,error:null,
          runs:[{id:'request-a',slug:'request-a',title:'需求A',kind:'feature',location:'active',featureStatus:'not_started',currentNodeId:'collect',currentNodeStatus:'not_started',overallStatus:{label:'未开始',uiKind:'pending'},summary:{text:'原需求',updatedAt:'2026-11-01T00:00:00Z'}}]};
        const adapter={...project.harnessAdapter,enabled:true,runtimeMode:mode.native?'host':'legacy',description:'',pullKnowledgeAvailable:false,boardCompatibility:project.boardCompatibility};
        const catalog={projects:[project],registry:[adapter],projectNextCursor:null,registryNextCursor:null,
          summary:{totalProjects:1,matchedProjects:1,activeProjects:1,archivedProjects:0,totalRegistry:1},stats:{cancelled:false}};
        window.electron={ipcRenderer:{invoke:async()=>[],on:unsubscribe,removeListener(){}},process:{platform:'win32'}};
        window.api={featureGates:{isEnabled:async()=>({enabled:true})},plugins:{list:async()=>[]},
          dashboard:{cancelRequests:nothing,userProfiles:async()=>[]},
          builtinRobot:{getStatus:async()=>({settings:{enabled:true},connectionState:'online',identityState:'verified'}),onStatus:unsubscribe,getRemoteAccess:async()=>({featureGrants:[],threadGrants:[]}),onRemoteAccessChanged:unsubscribe,
            setFeatureRemoteAccess:async()=>{calls.push(['remote-feature-grant']);throw Error('NO_REMOTE_FEATURE_WRITE')}},
          appNotifications:{list:async()=>[],onChanged:unsubscribe},mods:{onConfigurationChanged:unsubscribe},
          workspace:{cancelGitPanelReads:nothing,onFilesChanged:unsubscribe},
          threads:{create:async metadata=>{calls.push(['create',structuredClone(metadata)]);return {thread_id:'created-'+calls.filter(c=>c[0]==='create').length,
            created_at:'2026-11-02T00:00:00Z',updated_at:'2026-11-02T00:00:00Z',status:'idle',title:'新讨论',metadata:structuredClone(metadata)}}},
          harnessBoard:{catalogPage:async()=>structuredClone(catalog),registry:async()=>[adapter],getProjectDetails:async()=>({container:structuredClone(projectDetail)}),getProjectDetail:async()=>structuredClone(projectDetail),
            getRunDetail:async()=>{calls.push(['read-run']);return structuredClone(detail)},listProjects:async()=>[project],
            cancelCatalogRequests:nothing,cancelKnowledgePreviewRequests:nothing,cancelEnterpriseRequests:nothing,stopWatchRefs:nothing,onWatchRefsChanged:unsubscribe,onManagedRunChanged:unsubscribe,onManagedRunScheduleChanged:unsubscribe,getManagedRunSchedule:async()=>null,getActiveManagedRunSchedules:async()=>[],
            getDeployUnitMappings:async()=>[],getLeanTokenConfig:async()=>({leanToken:''}),getManagedRunEvents:async()=>({events:[],hasMore:false}),getEnterpriseProjectDetails:async()=>({projects:[]}),getProjectReviews:async()=>({tokenConfigured:false,reviews:[]}),
            ensureFeatureThreadImGrant:async()=>({required:false,granted:false}),
            getDialogTips:async()=>null,getFeatureBinding:async()=>null,
            nativeFeatureMods:{read:async()=>({projectId:'run-a',projectVersion:0,packageDigest:'a'.repeat(64),workspace:'C:/isolated-execution',dependencies:[],globallyEnabled:true,workspaceEnabled:true})},
            nativeFeatureCommand:async()=>{calls.push(['forbidden-host']);throw Error('NO_HOST_EXECUTION')},
            startManagedRun:async()=>{calls.push(['forbidden-run']);throw Error('NO_MANAGED_EXECUTION')},
            localProjects:{templates:async()=>[],list:async()=>[]}}};
        window.sessionFixture={calls,threads:()=>useAppStore.getState().threads,pending:id=>getPendingHarnessNextAction(id)};
        function Detail(){const threads=useAppStore(s=>s.threads);return <FeatureDetailPage detail={{...detail,sessions:threads.map(thread=>({projectId:'container',slug:'request-a',threadId:thread.thread_id,source:'autobiz',createdAt:thread.created_at,lastActiveAt:thread.updated_at}))}}
          loading={false} isViewingSession={false} onActiveSessionChange={()=>{}} onRefresh={nothing} onBackToList={()=>{}} onBackToProject={()=>{}} onEditDeployUnits={()=>{}} onFeatureImManagementSaved={()=>{}}/>}
        createRoot(document.getElementById('root')).render(mode.entry==='detail'?<Detail/>:<HarnessBoardView/>);
      `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(!existsSync(chromium.executablePath()) && process.platform === "win32"
      ? { channel: "msedge" }
      : {})
  })
  const results: Array<Record<string, unknown>> = []
  try {
    for (const native of [true, false])
      for (const entry of ["sidebar", "detail"]) {
        const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
        page.setDefaultTimeout(10000)
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        try {
          await page.route("http://127.0.0.1/**", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<html><body><aside id="harness-sidebar-portal"></aside><main id="root"></main></body></html>'
            })
          )
          await page.goto("http://127.0.0.1/")
          await page.evaluate((mode) => Object.assign(window, { sessionMode: mode }), {
            native,
            entry
          })
          await page.addScriptTag({ content: bundled.outputFiles[0].text })
          const add =
            entry === "sidebar"
              ? page.locator('#harness-sidebar-portal button[title="新增会话"]')
              : page.getByRole("button", { name: "新增会话", exact: true })
          await add.waitFor()
          if (entry === "detail") {
            const management = page.getByRole("switch", { name: "通过招乎管理特性", exact: true })
            await management.waitFor()
            if (native) {
              assert(
                await management.isDisabled(),
                "unsupported native feature management cannot grant remotely"
              )
              await management.evaluate((button) => (button as HTMLButtonElement).click())
              assert.equal(
                await page.evaluate(
                  "window.sessionFixture.calls.filter(c=>c[0]==='remote-feature-grant').length"
                ),
                0
              )
              await page
                .getByText(
                  "此插件暂不支持通过招乎管理整条特性或新建会话；已有普通会话仍可单独接入。",
                  { exact: true }
                )
                .waitFor()
            } else
              assert(
                await management.isEnabled(),
                "legacy feature management keeps the online robot behavior"
              )
          }
          await add.hover()
          await add.click()
          if (native && entry === "detail") {
            await page.waitForFunction(
              "window.sessionFixture.calls.some(c=>c[0]==='create')||!!document.querySelector('[role=dialog]')"
            )
          }
          assert.equal(
            await page.getByRole("dialog", { name: "开启托管运行", exact: true }).count(),
            0,
            "Add session must not open managed execution"
          )
          await page.getByRole("region", { name: "受控聊天边界", exact: true }).waitFor()
          const draft = page.getByRole("textbox", { name: "会话草稿边界", exact: true })
          assert(await draft.isEnabled())
          assert.equal(await draft.inputValue(), "请先讨论原需求，不要直接执行")
          await draft.fill("用户继续调整草稿，尚未发送")
          const guide = page.getByRole("region", { name: "当前阶段指引", exact: true })
          if (native) {
            await guide.waitFor()
            assert((await guide.innerText()).includes("整理资料"))
            const chatGuide = page.getByRole("region", { name: "项目插件使用指引", exact: true })
            await chatGuide.waitFor()
            assert((await chatGuide.innerText()).includes("请准备本次评估的范围和材料"))
            assert((await chatGuide.innerText()).includes("普通聊天不会自动启动阶段"))
            assert((await chatGuide.innerText()).includes("无需手动输入斜杠命令"))
            assert.equal(await draft.inputValue(), "用户继续调整草稿，尚未发送")
            await chatGuide.getByRole("button", { name: "前往项目设置", exact: true }).click()
            await page.getByRole("region", { name: "需求权限与确认", exact: true }).waitFor()
            const start = guide.getByRole("button", { name: "填写需求并开始", exact: true })
            await start.waitFor()
            await start.click()
            const dialog = page.getByRole("dialog", { name: "开启托管运行", exact: true })
            await dialog.waitFor()
            await dialog.getByRole("button", { name: "取消", exact: true }).click()
          } else assert.equal(await guide.count(), 0, "Legacy next-action guidance is unchanged")
          const observation = await page.evaluate(() => {
            const fixture = (
              window as unknown as {
                sessionFixture: {
                  calls: unknown[][]
                  threads(): Array<{ metadata: Record<string, unknown> }>
                }
              }
            ).sessionFixture
            return { calls: fixture.calls, latest: fixture.threads()[0].metadata }
          })
          assert.equal(observation.calls.filter((call) => call[0] === "create").length, 1)
          assert.equal(
            observation.calls.filter((call) => String(call[0]).startsWith("forbidden")).length,
            0
          )
          assert.equal(observation.latest.workspacePath, "C:/chosen-repository")
          assert.equal(observation.latest.hostProjectRuntime, undefined)
          assert.deepEqual(errors, [])
          results.push({ native, entry, passed: true, calls: observation.calls, errors })
        } catch (cause) {
          results.push({
            native,
            entry,
            passed: false,
            error: String(cause),
            errors,
            dialogs: await page.locator('[role="dialog"]').allTextContents()
          })
        } finally {
          await page.screenshot({
            path: resolve(output, `${native ? "native" : "legacy"}-${entry}.png`),
            fullPage: true
          })
          await page.close()
        }
      }
  } finally {
    await browser.close()
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: results.length === 4 && results.every((result) => result.passed),
          results,
          scope:
            "Real original detail/sidebar handlers, session helper and pending-next-action store; controlled IPC/store and TabbedPanel probe, not real Composer/model acceptance"
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ output, results }))
  }
  assert(
    results.every((result) => result.passed),
    "Original session entry regression failed"
  )
}
void main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
