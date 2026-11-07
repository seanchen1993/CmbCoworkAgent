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
    source.includes("ChatMessageScrollArea")
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
                  // Observe the real container's props at the production memo boundary;
                  // row rendering costs are covered by the separate history browser suites.
                  ? `export const ${name}=React.memo(p=>{window.fixture.listRenders=(window.fixture.listRenders??0)+1;
                      window.fixture.listProps=p;return <section data-fixture-list>{p.footer}</section>});`
                  : name === "ChatFlowTaskCards"
                    ? `export const ${name}=p=><button data-fixture-follow-up onClick={()=>p.onFollowUp('FOLLOW_UP')}>Fixture follow-up</button>;`
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
    const reset = async (hold?: string) => {
      await page.goto("about:blank")
      await page.setContent("<div id='root'></div>")
      await page.evaluate((value) => {
        ;(window as unknown as { initialHold?: string }).initialHold = value
      }, hold)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.waitForFunction("document.querySelector('textarea.composer-textarea')", null, {
        timeout: 15000
      })
      await page.getByRole("button", { name: "添加文件", exact: true }).click()
      await page.locator('[aria-label="移除附件 upload.txt"]').waitFor()
      await page.evaluate(
        `window.fixture.change({draftSkill:{name:'Original skill',path:'C:/skills/original/SKILL.md',description:'ORIGINAL_SKILL'}})`
      )
    }
    const checks: string[] = []
    const paint = () => page.evaluate(() => new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done))))
    await reset()
    const composer = page.locator("textarea.composer-textarea")
    await composer.focus()
    await paint()
    const idleListRenders = await page.evaluate("window.fixture.listRenders")
    await composer.pressSequentially("LOCAL_INTERACTION_DRAFT_1", { delay: 5 })
    await paint()
    assert.equal(await composer.inputValue(), "LOCAL_INTERACTION_DRAFT_1")
    assert.equal(await page.evaluate("window.fixture.state().draftInput"), "LOCAL_INTERACTION_DRAFT_1")
    assert.equal(await page.evaluate("window.fixture.listRenders"), idleListRenders,
      "Typing must not invalidate the transcript memo boundary")
    await page.locator("[data-fixture-follow-up]").click()
    assert.equal(await composer.inputValue(), "LOCAL_INTERACTION_DRAFT_1\n\nFOLLOW_UP",
      "A retained task callback must append to the current draft")
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
    assert.equal(await page.evaluate("window.fixture.listRenders"), loadingListRenders,
      "Typing during a run must retain the footer and initial-location props")
    await page.locator("[data-fixture-follow-up]").click()
    assert.equal(await composer.inputValue(), "LIVE_DRAFT\n\nFOLLOW_UP")
    await page.evaluate("window.fixture.stream({isLoading:false})")
    await page.waitForFunction("window.fixture.listProps.isLoading===false")
    checks.push("real ChatContainer idle/loading draft changes preserve the transcript memo boundary; retained follow-up reads current draft; clear and error dismissal stay live")

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
