/** Real ChatContainer/menus/target controller; thread transport is an explicit deterministic backend. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import ts from "typescript"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const renderer = resolve("src/renderer/src")
const chatFile = resolve(renderer, "components/chat/ChatContainer.tsx")
const original = readFileSync(chatFile, "utf8")
const parsed = ts.createSourceFile(
  chatFile,
  original,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const leaves = new Map<string, { names: string[]; helpers: string[] }>()
for (const node of parsed.statements) {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.importClause?.isTypeOnly ||
    !node.importClause?.namedBindings ||
    !ts.isNamedImports(node.importClause.namedBindings)
  )
    continue
  const source = node.moduleSpecifier.text
  if (
    !(
      source.startsWith("./") ||
      source.startsWith("../customize/") ||
      source.startsWith("@/components/")
    )
  )
    continue
  const absolute = source.startsWith("@/")
    ? resolve(renderer, source.slice(2))
    : resolve(dirname(chatFile), source)
  if (!existsSync(absolute + ".tsx")) continue
  if (
    source.includes("/ui/") ||
    source.includes("ModsAgentTranscriptPanel") ||
    source.includes("ContextReminderController") ||
    source.includes("ChatScrollNavigator") ||
    source.includes("ChatMessageScrollArea") ||
    source.includes("AgentGitCommitDialog")
  )
    continue
  const values = node.importClause.namedBindings.elements.filter((item) => !item.isTypeOnly)
  const names = values
    .filter((item) => /^[A-Z][a-z]/.test(item.name.text))
    .map((item) => item.name.text)
  if (names.length)
    leaves.set(source, {
      names,
      helpers: values
        .filter((item) => !names.includes(item.name.text))
        .map((item) => item.name.text)
    })
}
const thread = readFileSync(resolve(renderer, "lib/thread-context.tsx"), "utf8")
const defaultStart = thread.indexOf("const createDefaultThreadState =")
const defaultBody = thread
  .slice(thread.indexOf("=> ({", defaultStart) + 3, thread.indexOf("\n})", defaultStart) + 3)
  .replace("createDefaultContextReminderState()", "{status:'idle',enabled:false}")

async function main() {
  const output = resolve("output/mods-chatcontainer-input-target-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ChatContainer} from ${JSON.stringify(chatFile)};
      import {useAppStore} from '@/lib/store';import {fixture,threadStore} from 'fixture:thread';
      import {reserveModsAgentInput,releaseModsAgentInput} from '@/lib/mods-agent-input-target';
      import {chatScrollSessionStore} from '@/components/chat/chat-scroll-session-store';
      import {createChatScrollState} from './src/shared/chat-scroll-controller';
      const root=createRoot(document.getElementById('root'));
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>
        '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^(crypto.getRandomValues(new Uint8Array(1))[0]&15)>>Number(c)/4).toString(16))});
      const noop=()=>{},asyncNoop=async()=>null;
      const defaults={getAll:()=>({}),getAllMetadata:()=>({}),getEnabledSources:()=>[],list:()=>[],
        listModels:()=>[],getStatus:()=>({}),getConfig:()=>({}),getYoloMode:()=>false,isCoordinatorModeForced:()=>fixture.delay('mode',false)};
      const native=(path='')=>new Proxy(function(){},{get:(_,name)=>name==='then'?undefined:native(path+'.'+String(name)),
        apply:(_t,_o,args)=>{const name=path.split('.').at(-1);if(name.startsWith('on'))return noop;
          if(path.endsWith('.workspace.readFilePreview'))return fixture.delay('file',{success:true,text:'PRIVATE_FILE_CONTENT',content:'PRIVATE_FILE_CONTENT',hasMore:false,totalChars:20});
          if(path.endsWith('.file.select'))return Promise.resolve({canceled:false,files:[{filePath:'C:/upload.txt',grant:'fixture-grant'}]});
          if(path.endsWith('.file.parseSelected'))return Promise.resolve({success:true,attachment:{filename:'upload.txt',filePath:'C:/upload.txt',content:'UPLOAD_PAYLOAD',size:14,mimeType:'text/plain'}});
          if(path.endsWith('.skills.list'))return Promise.resolve([{name:'Fixture skill',path:'C:/skills/fixture/SKILL.md',description:'test'}]);
          if(path.endsWith('.skills.getDisabled'))return Promise.resolve([]);
          if(path.endsWith('.mods.chatDisplayCapability'))return Promise.resolve(false);
          if(path.endsWith('.mods.commands'))return Promise.resolve([]);
          if(path.endsWith('.autoCommit.getWorkspaceCard')){fixture.cardReads=(fixture.cardReads??0)+1;return Promise.resolve({cardNumber:'CARD-1'})}
          if(path.endsWith('.workspace.getGitPanelDiffs')){fixture.diffReads=(fixture.diffReads??0)+1;return Promise.resolve({success:true,files:[],changedFiles:[],totals:{fileCount:0,additions:0,deletions:0},omittedFileCount:0})}
          if(path.endsWith('.hooks.logging.get'))return Promise.resolve({enabled:false,diagnostic:false});
          if(path.endsWith('.appNotifications.list'))return Promise.resolve([]);
          if(path.endsWith('.agent.isCoordinatorModeForced'))return fixture.delay('mode',false);
          return Promise.resolve(defaults[name]?.()??null)}});
      window.api=native();window.electron={process:{platform:'win32'},openExternal:asyncNoop};
      useAppStore.setState({accountRevision:1,currentThreadId:'a',mainView:'thread',threads:[{thread_id:'a',title:'Existing',created_at:1,metadata:{workspacePath:'C:/fixture'}}],
        models:[{id:'test',name:'Fixture model',model:'fixture',available:true}],pluginVersion:0,rightPanelCollapsed:true,loadThreads:asyncNoop,
        loadModels:asyncNoop,patchThreadMetadata:asyncNoop,generateTitleForFirstMessage:noop});
      const intent={id:'child-input',threadId:'a',workspace:'C:/fixture',agentId:'child',parentIncarnation:'birth',sourceDigest:'source',mode:'interactive'};
      if(window.initialHold)fixture.hold(window.initialHold);
      fixture.switchInput=()=>{const reservation=reserveModsAgentInput(intent,1);fixture.reservation=reservation;
        fixture.activation=reservation.ready(new AbortController().signal).then(()=>{fixture.activated=reservation.activate()},()=>{fixture.cancelled=true})};
      fixture.returnParent=()=>releaseModsAgentInput(intent.id);
      window.fixture=fixture;fixture.mount=()=>root.render(<ChatContainer threadId='a'/>);
      fixture.customize=value=>useAppStore.setState({showCustomizeView:value});
      if(window.restoreSessionFixture){
        const lease=chatScrollSessionStore.open('a').lease;
        chatScrollSessionStore.save(lease,{state:{...createChatScrollState('a'),mode:'detached'},
          anchor:{messageId:'saved-5',offsetFromViewportTop:28},contentSnapshot:null});
        if(window.restoreSessionFixture==='durable')chatScrollSessionStore.setPendingRevealMessageId(lease,'saved-12');
        fixture.change({messages:Array.from({length:20},(_,i)=>({id:'saved-'+i,role:'assistant',content:'Message '+i})),
          historyConversationPresence:'nonempty',historyLoadedMessageCount:20,historyMessageTotal:20});
      }
      fixture.mount();
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://fixture.invalid/fixture.js"',
      __APP_VERSION__: '"2.0.0"'
    },
    plugins: [
      browserWorkerPlugin(),
      {
        name: "real-chat-transport-backend",
        setup(builder) {
          // Keep the actual approval dialog and task-card hook; omit only the unrelated picker.
          builder.onResolve({ filter: /^@\/components\/git\/TaskCardPicker$/ }, () => ({
            path: "task-card-picker",
            namespace: "commit-picker"
          }))
          builder.onLoad({ filter: /.*/, namespace: "commit-picker" }, () => ({
            contents: "export const TaskCardPicker=()=>null"
          }))
          builder.onResolve({ filter: /^fixture:thread$|(?:^|\/)thread-context$/ }, () => ({
            path: "thread",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: `
          import {create} from 'zustand';
          export const fixture={sent:[],events:[],gates:new Map(),activated:false,delay:(kind,value)=>{
            fixture.events.push(kind);const gate=fixture.gates.get(kind);return gate?new Promise(resolve=>gate.push(()=>resolve(value))):Promise.resolve(value)},
            hold:kind=>fixture.gates.set(kind,[]),release:kind=>{const gates=fixture.gates.get(kind)||[];fixture.gates.delete(kind);for(const release of gates)release()}};
          const initial=${defaultBody};
          const noop=()=>{},asyncNoop=async()=>null;
          let actions;export const threadStore=create(()=>({...initial,workspacePath:'C:/fixture',historyLoading:false,currentModel:'test',
            historyConversationPresence:'empty',workspaceFiles:[{name:'proof.txt',path:'proof.txt',type:'file'}]}));
          const change=patch=>threadStore.setState(patch);
          actions=new Proxy({setDraftInput:text=>change({draftInput:text,draftRevision:threadStore.getState().draftRevision+1}),
            readPromptDraft:()=>({text:threadStore.getState().draftInput,revision:threadStore.getState().draftRevision}),
            applyPromptDraft:(revision,text)=>{if(revision!==threadStore.getState().draftRevision)return false;actions.setDraftInput(text);return true},
            setDraftSkill:value=>change({draftSkill:value}),setDraftBuiltinBrowser:value=>change({draftBuiltinBrowser:value}),
            setError:value=>change({error:value}),clearError:()=>change({error:null}),
            appendMessage:message=>change({messages:[...threadStore.getState().messages,message]}),
            captureModelSelectionIntent:()=>({id:'model'}),isModelSelectionIntentCurrent:()=>true,
            setQueueAutoDrainSuppressed:value=>change({queueAutoDrainSuppressed:value}),
            addQueuedMessage:value=>change({queuedMessages:[...threadStore.getState().queuedMessages,value]}),
            refreshGoalUi:asyncNoop}, {get:(target,name)=>target[name]??noop});
          export function useCurrentThread(){return new Proxy({...threadStore(),...actions},{get:(target,name)=>Object.hasOwn(target,name)?target[name]:actions[name]})}
          const stream={submit:(input,config)=>{fixture.sent.push({input,config});return Promise.resolve()},stop:noop};
          const streamStore=create(()=>({stream,isLoading:false,messages:[],liveMessages:[]}));
          export const useThreadStream=()=>streamStore(),useThreadActions=()=>actions;
          export const useThreadStateSelector=(_id,select)=>select(threadStore());
          const logs=[],context={getThreadState:()=>threadStore.getState(),getThreadActions:()=>actions,subscribeToHookLogs:()=>noop,getHookLogBuckets:()=>logs};
          export const useThreadContext=()=>context;
          fixture.state=()=>threadStore.getState();fixture.change=change;fixture.actions=actions;
          fixture.stream=patch=>streamStore.setState(patch);
        `
          }))
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.importer !== chatFile || !leaves.has(args.path)) return
            return { path: args.path, namespace: "leaf" }
          })
          builder.onLoad({ filter: /.*/, namespace: "leaf" }, (args) => {
            const leaf = leaves.get(args.path)!
            const absolute = args.path.startsWith("@/")
              ? resolve(renderer, args.path.slice(2))
              : resolve(dirname(chatFile), args.path)
            return {
              loader: "tsx",
              resolveDir: dirname(chatFile),
              contents: `import React from 'react';
            ${leaf.helpers.length ? `export {${leaf.helpers.join(",")}} from ${JSON.stringify(absolute)};` : ""}
            ${leaf.names
              .map((name) =>
                name === "ChatMessageVirtualList"
                  ? // Observe the real container's props at the production memo boundary;
                    // row rendering costs are covered by the separate history browser suites.
                    `export const ${name}=React.memo(p=>{window.fixture.listRenders=(window.fixture.listRenders??0)+1;
                      React.useLayoutEffect(()=>{const handle={scrollToIndex:value=>{window.fixture.indexCalls??=[];window.fixture.indexCalls.push(value)},scrollIntoView:()=>{},
                        refreshItemSizes:()=>{window.fixture.refreshCalls=(window.fixture.refreshCalls??0)+1;
                          window.fixture.measurementOrder??=[];window.fixture.measurementOrder.push('refresh');
                          window.fixture.onRefresh?.()},
                        cancelScrollToIndex:()=>{window.fixture.cancelScrollCalls=(window.fixture.cancelScrollCalls??0)+1;
                          window.fixture.measurementOrder??=[];window.fixture.measurementOrder.push('cancel')},
                        setExternalScrollAnchor:({owner,active})=>{window.fixture.anchorOwners??=new Set();
                          active?window.fixture.anchorOwners.add(owner):window.fixture.anchorOwners.delete(owner)}};
                        p.virtuosoRef.current=handle;return()=>{if(p.virtuosoRef.current===handle)p.virtuosoRef.current=null}},[p.virtuosoRef]);
                      window.fixture.listProps=p;return <section data-fixture-list>{p.footer}</section>});`
                  : name === "ChatFlowTaskCards"
                    ? `export const ${name}=p=><button data-fixture-follow-up onClick={()=>p.onFollowUp('FOLLOW_UP')}>Fixture follow-up</button>;`
                    : name === "ChatSearchOverlay"
                      ? `export const ${name}=p=>{window.fixture.searchProps=p;return null};`
                      : name === "ChatMessageScrollArea"
                        ? `export const ${name}=React.forwardRef((p,ref)=><div ref={ref}>{p.children}</div>);`
                        : `export const ${name}=p=>p.fallback??p.children??null;`
              )
              .join("\n")}`
            }
          })
          builder.onLoad({ filter: /ChatContainer\.tsx$/ }, (args) => ({
            loader: "tsx",
            resolveDir: dirname(args.path),
            contents: readFileSync(args.path, "utf8").replace(
              "visibleUserMessage = await visibleUserMessagePromise",
              "visibleUserMessage = await window.fixture.delay('append', await visibleUserMessagePromise)"
            )
          }))
          for (const name of ["SlashCommandPopover", "AtFileMentionPopover"])
            builder.onLoad({ filter: new RegExp(name + "\\.tsx$") }, (args) => ({
              loader: "tsx",
              resolveDir: dirname(args.path),
              contents:
                readFileSync(args.path, "utf8").replace(
                  `export function ${name}(`,
                  `function Native${name}(`
                ) +
                `\nexport function ${name}(props){window.fixture.${name}=props;return <Native${name} {...props}/>}`
            }))
        }
      }
    ]
  })
  writeFileSync(resolve(output, "fixture.js"), bundle.outputFiles[0].text)
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (cause) => {
    errors.push(cause.message)
    console.error(cause.stack)
  })
  try {
    const reset = async (hold?: string, restored: boolean | "durable" = false) => {
      await page.goto("about:blank")
      await page.setContent("<div id='root'></div>")
      await page.addScriptTag({ content: "window.__name=value=>value" })
      await page.evaluate((value) => {
        ;(
          window as unknown as { restoreSessionFixture: boolean | "durable" }
        ).restoreSessionFixture = value
      }, restored)
      await page.evaluate((value) => {
        ;(window as unknown as { initialHold?: string }).initialHold = value
      }, hold)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.waitForFunction("document.querySelector('textarea.composer-textarea')", null, {
        timeout: 15000
      })
      if (restored) return
      await page.getByRole("button", { name: "添加文件", exact: true }).click()
      await page.locator('[aria-label="移除附件 upload.txt"]').waitFor()
      await page.evaluate(
        `window.fixture.change({draftSkill:{name:'Original skill',path:'C:/skills/original/SKILL.md',description:'ORIGINAL_SKILL'}})`
      )
    }
    const checks: string[] = []
    const paint = () =>
      page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      )
    await reset(undefined, true)
    assert.deepEqual(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      { index: 5, align: "start", behavior: "auto", offset: -28 },
      "A restored detached ChatContainer starts at the saved relative index and offset"
    )
    await page.evaluate(`{
      const viewport=document.querySelector('[data-radix-scroll-area-viewport]');
      viewport.style.height='300px';viewport.style.width='500px';
      const top=viewport.getBoundingClientRect().top;
      const target=document.createElement('div');target.dataset.chatMessageId='saved-5';
      target.style.cssText='position:fixed;top:'+(top+200)+'px;height:40px;width:100px;visibility:hidden';
      target.innerHTML='<div data-function-site="AssistantMessage"><i data-function-site-pending></i></div>';
      const body=document.createElement('div');body.dataset.chatMessageId='saved-6';
      body.style.cssText='position:fixed;top:'+(top+60)+'px;height:100px;width:100px;visibility:hidden';
      body.innerHTML='<div data-function-site="AssistantMessage">Readable neighbor</div>';
      viewport.append(target,body);
      const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
      window.fixture.restoreWrites=0;
      Object.defineProperty(viewport,'scrollTop',{configurable:true,
        get(){return descriptor.get.call(viewport)},
        set(value){window.fixture.restoreWrites++;descriptor.set.call(viewport,value)}});
    }`)
    await page.evaluate(`{
      const target=document.querySelector('[data-chat-message-id="saved-5"]');
      const list=document.createElement('div');list.dataset.testid='virtuoso-item-list';
      list.style.visibility='hidden';target.parentElement.append(list);
      const item=document.createElement('div');item.dataset.index='5';item.dataset.knownSize='40';item.style.height='80px';list.append(item);item.append(target);
      window.fixture.measurementOrder=[];
      window.fixture.onRefresh=()=>{window.fixture.onRefresh=undefined};
    }`)
    let cancelBeforeCold = (await page.evaluate("window.fixture.cancelScrollCalls??0")) as number
    await paint()
    assert.deepEqual(
      await page.evaluate("window.fixture.measurementOrder.slice(0,1)"),
      ["refresh"],
      "Hidden probe sizes are published while native initialization retains ownership"
    )
    assert(
      ((await page.evaluate("window.fixture.cancelScrollCalls??0")) as number) === cancelBeforeCold,
      "Without a visible reading destination the native initial request must remain active"
    )
    assert.equal(
      await page.evaluate("window.fixture.restoreWrites"),
      0,
      "A hidden probe must not precisely align its unready body"
    )
    await page.evaluate("document.querySelector('[data-index=\"5\"]').dataset.knownSize='80'")
    cancelBeforeCold = (await page.evaluate("window.fixture.cancelScrollCalls??0")) as number
    await paint()
    assert(
      ((await page.evaluate("window.fixture.cancelScrollCalls??0")) as number) === cancelBeforeCold,
      "Committed hidden sizes retain native initialization until a visible reading anchor can take over"
    )
    assert.equal(await page.evaluate("window.fixture.restoreWrites"), 0)
    await page.evaluate("document.querySelector('[data-testid=\"virtuoso-item-list\"]').style.visibility='';document.querySelector('[data-chat-message-id=\"saved-5\"]').style.visibility=''")
    const settledRefreshes = await page.evaluate("window.fixture.refreshCalls")
    await page.evaluate(
      "document.querySelector('[data-chat-message-id=\"saved-6\"]').style.visibility=''"
    )
    await paint()
    await paint()
    assert(((await page.evaluate("window.fixture.cancelScrollCalls??0")) as number) > cancelBeforeCold,
      "A readable neighbor immediately takes ownership from native initialization")
    assert.equal(
      await page.evaluate("window.fixture.restoreWrites"),
      0,
      "Actual Container must not align a cold saved row at the expense of its readable neighbor"
    )
    assert.equal(
      await page.evaluate("window.fixture.refreshCalls"),
      settledRefreshes,
      "Stable restore frames do not repeatedly scan native item sizes"
    )
    const stableLayoutCallbacks = await page.evaluate(`{
      const fixture=window.fixture, before=[fixture.refreshCalls,fixture.cancelScrollCalls,fixture.restoreWrites];
      const pending=fixture.listProps.hasPendingAnchorLayout();
      for(let i=0;i<20;i++)fixture.listProps.correctPendingAnchorLayout();
      ({pending,before,after:[fixture.refreshCalls,fixture.cancelScrollCalls,fixture.restoreWrites]});
    }`) as { pending: boolean; before: number[]; after: number[] }
    assert.equal(stableLayoutCallbacks.pending, true)
    assert.deepEqual(stableLayoutCallbacks.after, stableLayoutCallbacks.before,
      "Stable pending layout delivery performs no native measurement, cancellation, or write")
    await page.evaluate(`{
      const row=document.querySelector('[data-chat-message-id="saved-6"]');
      const top=document.querySelector('[data-radix-scroll-area-viewport]').getBoundingClientRect().top;
      row.style.top=(top+90)+'px';window.fixture.measurementOrder=[];
      window.fixture.onRefresh=()=>{row.style.top=(top+60)+'px';window.fixture.onRefresh=undefined};
    }`)
    await paint()
    assert.deepEqual(await page.evaluate("window.fixture.measurementOrder.slice(0,2)"), [
      "refresh",
      "cancel"
    ])
    assert.equal(
      await page.evaluate("window.fixture.restoreWrites"),
      0,
      "A refresh that changes geometry cannot reuse the preliminary 30px delta"
    )
    const beforeRecycleCalls = (await page.evaluate(
      "window.fixture.indexCalls?.length??0"
    )) as number
    const cancelBeforeMissing = (await page.evaluate(`{
      document.querySelector('[data-chat-message-id="saved-5"]').remove();
      window.fixture.cancelScrollCalls??0;
    }`)) as number
    await page.waitForFunction(`(window.fixture.indexCalls?.length??0)>${beforeRecycleCalls}`)
    assert.equal(
      await page.evaluate("window.fixture.indexCalls.at(-1).index"),
      5,
      "Recycling the cold target retains the existing bounded index reacquisition"
    )
    await paint()
    assert.equal(
      await page.evaluate("window.fixture.cancelScrollCalls??0"),
      cancelBeforeMissing,
      "A missing target must not cancel the fresh index reveal needed to remount it"
    )
    const cancelBeforeSearch = (await page.evaluate(
      "window.fixture.cancelScrollCalls??0"
    )) as number
    assert.equal(
      await page.evaluate("window.fixture.anchorOwners.size"),
      1,
      "Pending session restore owns native resize compensation"
    )
    await page.evaluate("window.fixture.searchProps.onRevealMessage('saved-12')")
    await paint()
    assert(
      ((await page.evaluate("window.fixture.cancelScrollCalls??0")) as number) > cancelBeforeSearch,
      "Explicit search cancels the native initial RAF as well as the platform restore"
    )
    assert.equal(await page.evaluate("window.fixture.listProps.hasPendingAnchorLayout()"), false,
      "Search immediately clears the pending layout callback without waiting for observer cleanup")
    assert.equal(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      undefined,
      "Explicit search takes over the pending session restore"
    )
    assert.equal(
      await page.evaluate("window.fixture.anchorOwners.size"),
      0,
      "Explicit navigation releases the captured restore owner"
    )
    const searchCalls = await page.evaluate("window.fixture.indexCalls.length")
    assert.equal(await page.evaluate("window.fixture.indexCalls.at(-1).index"), 12)
    await paint()
    await paint()
    assert.equal(
      await page.evaluate("window.fixture.indexCalls.length"),
      searchCalls,
      "The old session restore frame must not pull a new search back"
    )
    await page.evaluate(
      `window.fixture.change({messages:[{id:'replacement',role:'assistant',content:'Other window'}]})`
    )
    await paint()
    await page.evaluate(
      `window.fixture.change({messages:Array.from({length:20},(_,i)=>({id:'saved-'+i,role:'assistant',content:'Message '+i}))})`
    )
    await paint()
    assert.equal(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      undefined,
      "A later history window reset cannot replay the consumed session seed"
    )
    checks.push(
      "real ChatContainer seeds a detached restore; search cancels its frame and later windows do not replay it"
    )
    await reset(undefined, "durable")
    await page.waitForFunction("window.fixture.indexCalls?.some(call=>call.index===12)")
    await paint()
    assert.equal(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      undefined,
      "A resumed durable search consumes the session seed only when its virtual handle is ready"
    )
    const durableCalls = await page.evaluate("window.fixture.indexCalls.length")
    await paint()
    await paint()
    assert.equal(await page.evaluate("window.fixture.indexCalls.length"), durableCalls)
    assert.equal(await page.evaluate("window.fixture.indexCalls.at(-1).index"), 12)
    await reset(undefined, true)
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!
      const row = document.createElement("div")
      row.dataset.chatMessageId = "saved-5"
      row.style.cssText = `position:fixed;top:${viewport.getBoundingClientRect().top + 28}px;height:32px;width:100px`
      row.innerHTML =
        '<div data-function-site="AssistantMessage"><i data-function-site-pending></i></div>'
      viewport.append(row)
      ;(
        window as unknown as {
          fixture: {
            listProps: {
              contentMessageRefs: { current: Map<string, HTMLElement> }
            }
          }
        }
      ).fixture.listProps.contentMessageRefs.current.set("saved-5", row)
    })
    await paint()
    assert.notEqual(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      undefined,
      "A mounted pending target cannot finish the saved session restoration"
    )
    await page.evaluate(`document.querySelector('[data-chat-message-id="saved-5"]').innerHTML=
      '<div data-function-site="AssistantMessage">Target answer</div>'`)
    await page.waitForFunction(
      "window.fixture.listProps.initialTopMostItemIndex===undefined",
      undefined,
      { timeout: 1000 }
    )
    assert.equal(
      await page.evaluate("window.fixture.anchorOwners.size"),
      0,
      "Completed session restoration releases its native lease"
    )
    await page.evaluate(
      `window.fixture.change({messages:[{id:'replacement',role:'assistant',content:'Other window'}]})`
    )
    await paint()
    await page.evaluate(
      `window.fixture.change({messages:Array.from({length:20},(_,i)=>({id:'saved-'+i,role:'assistant',content:'Message '+i}))})`
    )
    await paint()
    assert.equal(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      undefined,
      "A completed restore cannot seed a subsequent rebuilt virtual window"
    )
    checks.push(
      "resumed durable navigation waits for its handle; completed restores clear their initial seed"
    )
    await reset(undefined, true)
    const hiddenGestureCancelCount = await page.evaluate(`{
      const viewport=document.querySelector('[data-radix-scroll-area-viewport]');
      const list=document.createElement('div');list.dataset.testid='virtuoso-item-list';list.style.visibility='hidden';
      list.innerHTML='<div data-index="5" data-known-size="40" style="height:80px"><div data-chat-message-id="saved-5">System probe</div></div>';
      viewport.append(list);window.fixture.cancelScrollCalls??0;
    }`)
    await paint()
    assert.equal(await page.evaluate("window.fixture.cancelScrollCalls??0"), hiddenGestureCancelCount,
      "Automatic restoration waits for a hidden measurement commit")
    await page.locator("[data-radix-scroll-area-viewport]").dispatchEvent("wheel", { deltaY: -100 })
    assert(((await page.evaluate("window.fixture.cancelScrollCalls??0")) as number) > hiddenGestureCancelCount,
      "A real Container user gesture cancels immediately even while hidden measurements are uncommitted")
    await paint()
    assert.equal(await page.evaluate("window.fixture.listProps.hasPendingAnchorLayout()"), false,
      "A user gesture synchronously disables pending layout corrections")
    assert.equal(
      await page.evaluate("window.fixture.listProps.initialTopMostItemIndex"),
      undefined,
      "A user wheel consumes a pending restore seed"
    )
    assert.equal(
      await page.evaluate("window.fixture.anchorOwners.size"),
      0,
      "A user wheel releases native compensation ownership synchronously"
    )
    await reset()
    const cancellationWiring = await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: { cancelScrollCalls?: number } }).fixture
      const viewport = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!
      const count = () => fixture.cancelScrollCalls ?? 0
      const deltas: Record<string, number> = {}
      const check = (name: string, act: () => void) => {
        const before = count()
        act()
        deltas[name] = count() - before
      }
      const wheel = (target: HTMLElement, options: WheelEventInit = {}) =>
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100, ...options }))
      check("wheel", () => wheel(viewport))
      check("ctrlWheel", () => wheel(viewport, { ctrlKey: true }))
      check("horizontalWheel", () => wheel(viewport, { deltaY: 0, deltaX: 100 }))
      const nested = document.createElement("div")
      nested.style.cssText = "height:40px;overflow-y:auto;overscroll-behavior-y:contain"
      nested.innerHTML = '<div style="height:200px"></div>'
      viewport.append(nested)
      nested.scrollTop = 50
      check("nestedWheel", () => wheel(nested))
      nested.remove()
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")!
      textarea.focus()
      check("composerKey", () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowUp",
            bubbles: true
          })
        )
      )
      textarea.blur()
      check("scrollKey", () =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "PageUp",
            bubbles: true
          })
        )
      )
      const touch = (type: string, y: number) => {
        const event = new Event(type, { bubbles: true })
        Object.defineProperty(event, "touches", { value: [{ clientY: y }] })
        viewport.dispatchEvent(event)
      }
      check("touchStart", () => touch("touchstart", 100))
      check("touchMove", () => touch("touchmove", 120))
      // The real container owns the capture listener; the marker models its Radix sibling.
      const scrollbar = document.createElement("div")
      scrollbar.setAttribute("data-scroll-area-scrollbar", "")
      viewport.parentElement!.append(scrollbar)
      check("scrollbarPointer", () =>
        scrollbar.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId: 1
          })
        )
      )
      scrollbar.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }))
      scrollbar.remove()
      check("preciseSearch", () =>
        (
          window as unknown as {
            fixture: { searchProps: { onBeforePreciseScroll(): void } }
          }
        ).fixture.searchProps.onBeforePreciseScroll()
      )
      return deltas
    })
    assert.deepEqual(
      cancellationWiring,
      {
        wheel: 1,
        ctrlWheel: 0,
        horizontalWheel: 0,
        nestedWheel: 0,
        composerKey: 0,
        scrollKey: 1,
        touchStart: 0,
        touchMove: 1,
        scrollbarPointer: 1,
        preciseSearch: 1
      },
      "Real ChatContainer cancels pending index navigation only for accepted scroll gestures"
    )
    checks.push(
      "real ChatContainer gesture handlers call the cancellation handle; nested scrolling, zoom and composer input retain their filters"
    )
    await reset()
    const composer = page.locator("textarea.composer-textarea")
    await composer.focus()
    await paint()
    const idleListRenders = await page.evaluate("window.fixture.listRenders")
    await composer.pressSequentially("LOCAL_INTERACTION_DRAFT_1", { delay: 5 })
    await paint()
    assert.equal(await composer.inputValue(), "LOCAL_INTERACTION_DRAFT_1")
    assert.equal(
      await page.evaluate("window.fixture.state().draftInput"),
      "LOCAL_INTERACTION_DRAFT_1"
    )
    assert.equal(
      await page.evaluate("window.fixture.listRenders"),
      idleListRenders,
      "Typing must not invalidate the transcript memo boundary"
    )
    await page.locator("[data-fixture-follow-up]").click()
    assert.equal(
      await composer.inputValue(),
      "LOCAL_INTERACTION_DRAFT_1\n\nFOLLOW_UP",
      "A retained task callback must append to the current draft"
    )
    await composer.press("ControlOrMeta+A")
    await composer.press("Backspace")
    assert.equal(await page.evaluate("window.fixture.state().draftInput"), "")

    await page.evaluate("window.fixture.change({error:'FRESH_ERROR'})")
    const errorText = page.getByText("FRESH_ERROR", { exact: true })
    await errorText.waitFor()
    assert.equal(await errorText.innerText(), "FRESH_ERROR")
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click()
    await errorText.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate("window.fixture.state().error"), null)
    await page.evaluate("window.fixture.stream({isLoading:true})")
    await page.waitForFunction("window.fixture.listProps.isLoading===true")
    await composer.focus()
    await paint()
    const loadingListRenders = await page.evaluate("window.fixture.listRenders")
    await composer.pressSequentially("LIVE_DRAFT", { delay: 5 })
    await paint()
    assert.equal(await composer.inputValue(), "LIVE_DRAFT")
    assert.equal(
      await page.evaluate("window.fixture.listRenders"),
      loadingListRenders,
      "Typing during a run must retain the footer and initial-location props"
    )
    await page.locator("[data-fixture-follow-up]").click()
    assert.equal(await composer.inputValue(), "LIVE_DRAFT\n\nFOLLOW_UP")
    await page.evaluate("window.fixture.stream({isLoading:false})")
    await page.waitForFunction("window.fixture.listProps.isLoading===false")
    checks.push(
      "real ChatContainer idle/loading draft changes preserve the transcript memo boundary; retained follow-up reads current draft; clear and error dismissal stay live"
    )

    assert.equal(
      await page.evaluate("window.fixture.cardReads??0"),
      0,
      "No commit approval must avoid mounting the dialog and reading its task card"
    )
    assert.equal(await page.evaluate("window.fixture.diffReads??0"), 0)
    await page.evaluate(`window.fixture.change({pendingApproval:{id:'commit-one',
      operation:'git_commit',suggestedCommitMessage:'CARD-1 #comment fix:first suggested message #CMBDevClaw'}})`)
    const commitMessage = page.locator("#agent-commit-message")
    await commitMessage.waitFor()
    assert.equal(await commitMessage.inputValue(), "first suggested message")
    await commitMessage.fill("edited approval draft")
    await page.waitForFunction("window.fixture.cardReads===1")
    await page.evaluate("window.fixture.customize(true)")
    await commitMessage.waitFor({ state: "hidden" })
    await paint()
    assert.equal(await page.evaluate("window.fixture.cardReads"), 1)
    await page.evaluate("window.fixture.customize(false)")
    await commitMessage.waitFor()
    assert.equal(
      await commitMessage.inputValue(),
      "edited approval draft",
      "Settings must hide the pending approval without unmounting its draft"
    )
    assert.equal(await page.evaluate("window.fixture.cardReads"), 1)
    await page.evaluate(`window.fixture.change({pendingApproval:{id:'commit-two',
      operation:'git_commit',suggestedCommitMessage:'CARD-1 #comment feat:second suggested message #CMBDevClaw'}})`)
    await page.waitForFunction(
      "document.querySelector('#agent-commit-message')?.value==='second suggested message'"
    )
    assert.equal(
      await page.evaluate("window.fixture.cardReads"),
      2,
      "A different approval ID must mount a fresh dialog and task-card state"
    )
    await page.evaluate("window.fixture.change({pendingApproval:null})")
    await commitMessage.waitFor({ state: "detached" })
    await paint()
    assert.equal(
      await page.evaluate("window.fixture.cardReads"),
      2,
      "Finishing approval must not create a replacement idle dialog"
    )
    checks.push(
      "real approval dialog mounts only for a request, keeps drafts through settings, and resets on a new approval ID"
    )

    for (const phase of ["file", "mode", "append"]) {
      await reset(phase)
      const draft = page.locator("textarea.composer-textarea")
      await draft.fill(
        phase === "file" ? "@proof.txt original file request" : `original ${phase} request`
      )
      await draft.press("Enter")
      await page.waitForFunction(
        (phase) => {
          const f = (
            window as unknown as { fixture: { events: string[]; state(): { draftInput: string } } }
          ).fixture
          return f.events.includes(phase) && !f.state().draftInput
        },
        phase,
        { timeout: 5000 }
      )
      await draft.fill(`fresh parent ${phase} draft`)
      await page.evaluate("window.fixture.switchInput()")
      await page.waitForFunction("document.querySelector('textarea.composer-textarea').disabled")
      assert.equal(await page.evaluate("window.fixture.activated"), false)
      assert.equal(await page.evaluate("window.fixture.sent.length"), 0)
      await page.evaluate(
        (phase) =>
          (window as unknown as { fixture: { release(phase: string): void } }).fixture.release(
            phase
          ),
        phase
      )
      await page.waitForFunction("window.fixture.sent.length===1&&window.fixture.activated===true")
      const payload = await page.evaluate("JSON.stringify(window.fixture.sent[0])")
      assert.match(payload, new RegExp(`original ${phase} request`))
      assert.match(payload, /UPLOAD_PAYLOAD/)
      assert.match(payload, /ORIGINAL_SKILL/)
      if (phase === "file") assert.match(payload, /PRIVATE_FILE_CONTENT/)
      assert.doesNotMatch(payload, /fresh parent/)
      assert.equal(await draft.inputValue(), `fresh parent ${phase} draft`)
      await page.evaluate("window.fixture.returnParent()")
      assert.equal(await draft.isEnabled(), true)
      checks.push(
        `real ChatContainer ${phase} await: claimed payload hands off once before child activates; fresh draft retained`
      )
    }
    await reset("file")
    const draft = page.locator("textarea.composer-textarea")
    await draft.fill("@proof.txt original cancelled-switch request")
    await draft.press("Enter")
    await page.waitForFunction(
      "window.fixture.events.includes('file')&&!window.fixture.state().draftInput"
    )
    await page.evaluate("window.fixture.switchInput();window.fixture.returnParent()")
    await page.waitForFunction("window.fixture.cancelled===true")
    await page.evaluate("window.fixture.release('file')")
    await page.waitForFunction("window.fixture.sent.length===1")
    assert.equal(await page.evaluate("window.fixture.activated"), false)
    checks.push("cancelling a waiting input switch leaves the parent's claimed payload intact")

    await reset()
    await page.evaluate("window.fixture.change({draftSkill:null})")
    await draft.fill("/g")
    await page.waitForFunction("window.fixture.SlashCommandPopover.mode.kind==='slash'")
    await page.evaluate(
      "window.fixture.staleSlash=window.fixture.SlashCommandPopover;window.fixture.switchInput()"
    )
    await page.waitForFunction("window.fixture.activated===true")
    await page.waitForFunction("window.fixture.SlashCommandPopover.mode.kind==='closed'")
    await page.evaluate(`window.fixture.staleSlash.onSelectSkill({name:'Wrong skill',path:'C:/wrong'});
      window.fixture.staleSlash.onSelectCommand({id:'goal',command:'/goal',insertText:'/goal ',title:'Goal',keywords:[],description:''})`)
    assert.equal(await draft.inputValue(), "/g")
    assert.equal(await page.evaluate("window.fixture.state().draftSkill"), null)
    assert.equal(await page.locator('[aria-label="移除附件 upload.txt"]').count(), 1)
    await page.evaluate("window.fixture.returnParent()")
    await draft.fill("@p")
    await page.waitForFunction("window.fixture.AtFileMentionPopover.mode.kind==='at-file'")
    await page.evaluate(
      "window.fixture.staleAt=window.fixture.AtFileMentionPopover;window.fixture.switchInput()"
    )
    await page.waitForFunction("window.fixture.AtFileMentionPopover.mode.kind==='closed'")
    await page.evaluate(
      `window.fixture.staleAt.onSelectFile({name:'proof.txt',path:'proof.txt',relativePath:'proof.txt',type:'file'})`
    )
    assert.equal(await draft.inputValue(), "@p")
    assert.equal(await page.locator('[aria-label="移除附件 upload.txt"]').count(), 1)
    checks.push(
      "real slash/@file menus close on input switch; captured old callbacks cannot alter parent text/skill/files"
    )
    await page.screenshot({ path: resolve(output, "actual-chat-paused.png") })
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          checks,
          errors,
          boundary:
            "Production ChatContainer and real menus/controller; explicit thread/transport backend, decorative leaf components omitted; append await is test-bundle instrumented"
        },
        null,
        2
      )
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS actual ChatContainer input target: " + checks.length + " scenarios; " + output
    )
  } catch (cause) {
    writeFileSync(
      resolve(output, "failure.txt"),
      String(cause) +
        "\n" +
        JSON.stringify(errors) +
        "\n" +
        (await page.locator("body").innerText())
    )
    throw cause
  } finally {
    await browser.close()
  }
}
void main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
