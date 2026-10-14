/** Real model control and popover; fake catalog, thread store and dialog callback boundary. */
import assert from "node:assert/strict"
import { mkdirSync, existsSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright"

const root = resolve(__dirname, "..")
const renderer = join(root, "src/renderer/src")
const artifacts = resolve(
  root,
  process.env.CMB_MODEL_DISPLAY_ARTIFACTS ??
    "output/mods-v2-validation/stage41-model-display-browser-20261008"
)
assert(!existsSync(artifacts), "Preserve previous failures; use a fresh artifact directory")
mkdirSync(artifacts, { recursive: true })
const checks: string[] = []
const pageErrors: string[] = []
let browser: Browser | undefined
let page: Page | undefined

const storeModule = `
import {useSyncExternalStore} from 'react';
const listeners=new Set();
const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
let state={models:[],threads:[{thread_id:'a',metadata:{}},{thread_id:'b',metadata:{}}],
  rightModule:'work',rightPanelCollapsed:true};
const notify=()=>{state={...state};for(const fn of listeners)fn()};
state.loadModels=async force=>{
  const {revalidateModelCatalog}=await import('@/lib/model-catalog-cache');
  const result=await revalidateModelCatalog(force);
  state.models=result.models;notify();
};
state.setRightModule=value=>{state.rightModule=value;notify()};
state.setRightPanelCollapsed=value=>{state.rightPanelCollapsed=value;notify()};
export const useAppStore=selector=>selector(useSyncExternalStore(subscribe,()=>state));
useAppStore.getState=()=>state;
window.testStore=()=>state;
window.testMetadata=(id,model)=>{
  state.threads=state.threads.map(thread=>thread.thread_id===id
    ? {...thread,metadata:{...thread.metadata,model}}:thread);
  notify();
};
`

const threadModule = `
import {useSyncExternalStore} from 'react';
const listeners=new Set();
const states=new Map([['a',{currentModel:'custom:a',routingResult:null}],
  ['b',{currentModel:'custom:a',routingResult:null}]]);
const actions=new Map();
const notify=()=>{for(const fn of listeners)fn()};
export const useThreadStateSelector=(id,selector)=>useSyncExternalStore(
  fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(states.get(id)));
export function useThreadActions(id){
  if(!actions.has(id))actions.set(id,{
    setCurrentModel:model=>{window.fixture.writes.push([id,model]);
      states.set(id,{...states.get(id),currentModel:model});notify()},
    restoreCurrentModel:model=>{window.fixture.restores.push([id,model]);
      states.set(id,{...states.get(id),currentModel:model});notify()}
  });
  return actions.get(id);
}
window.testThread=id=>states.get(id);
window.testRoutingResult=(id,value)=>{states.set(id,{...states.get(id),routingResult:value});notify()};
window.testActualModel=(id,model)=>{
  states.set(id,{...states.get(id),currentModel:model,
    routingResult:{resolvedModelId:model,resolvedTier:'premium',routeReason:'controlled actual'}});
  notify();
};
`

// The global write starts before a delayed completion, matching the real dialog contract.
// This deliberately does not claim to exercise its form fields or real model-config IPC.
const dialogModule = `
import {useState} from 'react';
export function CustomModelDialog(props){
  const [pending,setPending]=useState(false);
  if(!props.open)return null;
  const start=kind=>{
    setPending(true);
    window.fixture.globalWrites.push([kind,props.selectedModelId]);
    const captured={...props};
    window.fixture.pending.push(async()=>{
      captured.onModelSaved?.('custom:new');
      captured.onOpenChange(false);
      setPending(false);
    });
  };
  return <div role='dialog' aria-label='测试模型配置回调边界'>
    <span data-model-target>{props.selectedModelId||'new'}</span>
    <button disabled={pending} onClick={()=>start('save')}>保存并延迟完成</button>
    <button disabled={pending} onClick={()=>start('delete')}>删除并延迟完成</button>
    <button onClick={()=>props.onOpenChange(false)}>关闭配置窗口</button>
  </div>;
}
`

async function mount(
  target: Page,
  rejectFirstRead = false,
  initialDefault?: string,
  holdFirstRead = false
): Promise<void> {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModelSwitcher} from ${JSON.stringify(join(renderer, "components/chat/ModelSwitcher.tsx"))};
import {useAppStore} from '@/lib/store';
import {readModelCatalogCache,resetModelCatalogCacheForTests} from '@/lib/model-catalog-cache';
const models=[
  {id:'custom:a',model:'a',name:'模型 A',source:'custom',provider:'custom',available:true,tier:'premium'},
  {id:'custom:b',model:'b',name:'模型 B',source:'custom',provider:'custom',available:true,tier:'economy'},
  {id:'custom:new',model:'new',name:'新模型',source:'custom',provider:'custom',available:true,tier:'premium'}
];
const fixture=window.fixture={writes:[],restores:[],globalWrites:[],pending:[],routingWrites:[],
  catalogReads:0,catalog:{models,providers:[],defaultModelId:'custom:a',routingMode:'pinned'},
  rejectRead:${rejectFirstRead},rejectRouting:false,holdRead:${holdFirstRead},readRelease:null,
  readWaiters:[],
  sidebarTabs:[],patch:null,remount:null};
window.addEventListener('claw:sidebar-tab',event=>fixture.sidebarTabs.push(event.detail));
window.api={models:{getCatalog:async()=>{fixture.catalogReads++;
  if(fixture.holdRead)await new Promise(done=>{
    fixture.readWaiters.push(done);
    fixture.readRelease=()=>{
      fixture.holdRead=false;
      for(const release of fixture.readWaiters.splice(0))release();
    };
  });
  if(fixture.rejectRead)throw Error('controlled catalog refusal');
  return structuredClone(fixture.catalog)}},routing:{setMode:async mode=>{
    fixture.routingWrites.push(mode);
    if(fixture.rejectRouting)throw Error('controlled routing refusal');
    fixture.catalog.routingMode=mode}}};
function Host(){
  const [props,setProps]=useState({threadId:'a',composerMode:'chat',modsEnabled:true,
    readOnly:false,bindingRevision:1,clawDefaultModel:${JSON.stringify(initialDefault)}});
  const [key,setKey]=useState(0);
  fixture.patch=value=>setProps(old=>({...old,...value}));
  fixture.remount=()=>setKey(old=>old+1);
  return <ModelSwitcher key={key} {...props}/>;
}
fixture.finish=async index=>{const continuation=fixture.pending[index];
  if(!continuation)throw Error('Missing captured dialog continuation');await continuation()};
fixture.refresh=async()=>{await useAppStore.getState().loadModels(true)};
fixture.snapshot=()=>readModelCatalogCache();
fixture.resetCatalog=()=>resetModelCatalogCacheForTests();
createRoot(document.getElementById('root')).render(<Host/>);
`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "controlled-model-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/(store|thread-context)$/ }, (args) => ({
            path: args.path,
            namespace: "boundary"
          }))
          builder.onResolve({ filter: /^\.\/CustomModelDialog$/ }, () => ({
            path: "dialog",
            namespace: "boundary"
          }))
          builder.onLoad({ filter: /.*/, namespace: "boundary" }, (args) => ({
            resolveDir: root,
            loader: "tsx",
            contents:
              args.path === "dialog"
                ? dialogModule
                : args.path.endsWith("thread-context")
                  ? threadModule
                  : storeModule
          }))
        }
      }
    ]
  })
  await target.setContent('<div id="root"></div>')
  // No Tailwind pipeline in this behavior fixture. Size icons so their intrinsic
  // SVG dimensions do not move otherwise visible controls outside the viewport.
  // Visual acceptance still belongs to the real packaged renderer.
  await target.addStyleTag({
    content: "svg { width: 14px; height: 14px; } #root { padding: 16px; }"
  })
  await target.addScriptTag({ content: result.outputFiles[0].text })
}

async function patch(value: Record<string, unknown>): Promise<void> {
  assert(page)
  await page.evaluate((next) => {
    const fixture = (window as unknown as { fixture: { patch(value: unknown): void } }).fixture
    fixture.patch(next)
  }, value)
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
}

async function evaluate<T>(expression: string): Promise<T> {
  assert(page)
  return page.evaluate(expression) as Promise<T>
}

function pass(label: string): void {
  checks.push(label)
  console.log("PASS " + label)
}

async function settings(): Promise<void> {
  assert(page)
  await page.getByRole("button", { name: "原聊天模型与智能路由", exact: true }).click()
}

function modelDialog() {
  assert(page)
  return page.getByRole("dialog", { name: "测试模型配置回调边界", exact: true })
}

async function editBase(): Promise<void> {
  assert(page)
  await page.getByRole("button", { name: /^编辑(?:原聊天)?模型配置$/ }).click()
  await modelDialog().waitFor()
}

async function run(): Promise<void> {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {})
  })
  page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await mount(page)
  await page.getByRole("button", { name: "模型 A", exact: true }).waitFor()
  assert.equal(await evaluate("window.fixture.catalogReads"), 1)
  assert.deepEqual(await evaluate("window.fixture.writes"), [])
  pass("Original pinned model renders without rewriting selection or reading extra catalogs")

  await patch({ clawDefaultModel: "custom:b" })
  const combo = page.getByRole("button", { name: /当前组合模型.*模型 B/ })
  await combo.waitFor()
  await combo.click()
  assert.equal(await evaluate("window.fixture.sidebarTabs.at(-1)"), "configuration")
  assert.equal(await evaluate("window.testThread('a').currentModel"), "custom:a")
  await settings()
  await page.getByRole("button", { name: /^模型 B/ }).waitFor()
  assert.equal(await evaluate("window.fixture.catalogReads"), 1)
  pass("Applied default B has a real configuration entry while original A and settings remain")

  await page.keyboard.press("Escape")
  await patch({ composerMode: "flow" })
  await page.getByRole("button", { name: "模型按步骤设置", exact: true }).click()
  assert.equal(await evaluate("window.fixture.sidebarTabs.at(-1)"), "run")
  await settings()
  await page.getByRole("button", { name: "编辑原聊天模型配置", exact: true }).waitFor()
  await patch({ composerMode: "chat" })
  assert.equal(
    await page.getByRole("button", { name: "编辑原聊天模型配置", exact: true }).count(),
    0
  )
  pass("Flow names step-based models and a send-mode change closes the previous popover")

  await settings()
  await editBase()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await patch({ threadId: "b" })
  assert.equal(await modelDialog().count(), 0)
  await settings()
  await editBase()
  await evaluate("window.fixture.finish(0)")
  assert.equal(await modelDialog().count(), 1)
  assert.deepEqual(await evaluate("window.fixture.writes"), [])
  assert.equal(await evaluate("window.fixture.globalWrites.length"), 1)
  pass("Old save may finish its global operation but cannot choose a model or close a new dialog")

  await page.getByRole("button", { name: "删除并延迟完成", exact: true }).click()
  await page.getByRole("button", { name: "关闭配置窗口", exact: true }).click()
  await settings()
  await editBase()
  await evaluate("window.fixture.finish(1)")
  assert.equal(await modelDialog().count(), 1)
  assert.deepEqual(await evaluate("window.fixture.writes"), [])
  pass(
    "Closing and reopening in the same scope also invalidates the old delete and close callbacks"
  )

  await page.getByRole("button", { name: "关闭配置窗口", exact: true }).click()
  await patch({ clawDefaultModel: undefined })
  await page.getByRole("button", { name: "模型 A", exact: true }).click()
  await editBase()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await evaluate("window.fixture.catalog.defaultModelId='custom:new';window.fixture.refresh()")
  await evaluate("window.fixture.finish(2)")
  await page.getByRole("button", { name: "新模型", exact: true }).waitFor()
  assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  pass(
    "An authorized save survives its own global default notification and retains original selection behavior"
  )

  await patch({ clawDefaultModel: "custom:b", bindingRevision: 2 })
  await settings()
  await page.getByRole("button", { name: "编辑组合模型配置", exact: true }).click()
  assert.equal(await page.locator("[data-model-target]").innerText(), "custom:b")
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await evaluate("window.fixture.finish(3)")
  assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  pass(
    "Repairing the combination model does not select a base model or implicitly apply a combination"
  )

  await settings()
  await editBase()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await patch({ bindingRevision: 3 })
  assert.equal(await modelDialog().count(), 0)
  await evaluate("window.fixture.finish(4)")
  assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  pass("Changing the applied combination version invalidates the previously opened callback scope")

  await settings()
  await editBase()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await patch({ readOnly: true })
  assert.equal(await modelDialog().count(), 0)
  await evaluate("window.fixture.finish(5)")
  assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  pass("Read-only transition closes the old editing window and denies its delayed selection")

  await patch({ readOnly: false })
  await settings()
  await editBase()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await patch({ threadId: "a" })
  await patch({ threadId: "b" })
  await settings()
  await editBase()
  await evaluate("window.fixture.finish(6)")
  assert.equal(await modelDialog().count(), 1)
  assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  pass("Returning to the original thread does not revive a callback from an earlier scope epoch")
  await page.getByRole("button", { name: "关闭配置窗口", exact: true }).click()

  for (const change of [
    { clawDefaultModel: "custom:a" },
    { clawDefaultModel: undefined },
    { modsEnabled: false, clawDefaultModel: undefined },
    { composerMode: "flow" }
  ]) {
    await patch({ modsEnabled: true, clawDefaultModel: "custom:b", composerMode: "chat" })
    await settings()
    await editBase()
    await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
    const pendingIndex = (await evaluate<number>("window.fixture.pending.length")) - 1
    await patch(change)
    assert.equal(await modelDialog().count(), 0)
    await evaluate(`window.fixture.finish(${pendingIndex})`)
    assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  }
  pass(
    "Changing the default, disabling Mods or switching send mode invalidates old dialog callbacks"
  )

  await patch({ modsEnabled: true, clawDefaultModel: "custom:b", composerMode: "chat" })
  await settings()
  await page.getByRole("switch", { name: "智能路由", exact: true }).click()
  assert.equal(await evaluate("window.fixture.snapshot().routingMode"), "auto")
  assert.deepEqual(await evaluate("window.fixture.routingWrites"), ["auto"])
  await page.keyboard.press("Escape")
  await evaluate(
    "window.testRoutingResult('b',{resolvedModelId:'custom:a',resolvedTier:'premium'})"
  )
  await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
  await patch({ clawDefaultModel: undefined })
  await page.getByRole("button", { name: /智能路由.*模型 A/ }).waitFor()
  assert.equal(await evaluate("window.testThread('b').currentModel"), "custom:new")
  assert.deepEqual(await evaluate("window.fixture.routingWrites"), ["auto"])
  pass(
    "Routing remains operable under B and stays auto after removal without rewriting the base model"
  )

  await patch({ clawDefaultModel: "custom:b" })
  await settings()
  await evaluate("window.fixture.rejectRouting=true")
  await page.getByRole("switch", { name: "智能路由", exact: true }).click()
  await page.getByText("智能路由设置失败，请重试", { exact: true }).waitFor()
  assert.equal(await evaluate("window.fixture.catalog.routingMode"), "auto")
  assert.deepEqual(await evaluate("window.fixture.routingWrites"), ["auto", "pinned"])
  await evaluate("window.fixture.rejectRouting=false")
  await page.getByRole("button", { name: "重试设置智能路由", exact: true }).click()
  await page.getByText("智能路由设置失败，请重试", { exact: true }).waitFor({ state: "hidden" })
  assert.equal(await evaluate("window.fixture.catalog.routingMode"), "pinned")
  assert.deepEqual(await evaluate("window.fixture.routingWrites"), ["auto", "pinned", "pinned"])
  await page.getByRole("switch", { name: "智能路由", exact: true }).click()
  assert.equal(await evaluate("window.fixture.catalog.routingMode"), "auto")
  await page.keyboard.press("Escape")
  pass("A refused routing setting is visible and retry submits the original requested mode")

  await patch({ clawDefaultModel: "custom:b" })
  await settings()
  await editBase()
  await evaluate("window.fixture.rejectRead=true")
  await page.getByRole("button", { name: "关闭配置窗口", exact: true }).click()
  await settings()
  await page.getByRole("button", { name: "重试读取名称", exact: true }).waitFor()
  await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
  await evaluate("window.fixture.rejectRead=false;window.fixture.holdRead=true")
  await page.getByRole("button", { name: "重试读取名称", exact: true }).click()
  assert(await page.getByRole("button", { name: "重试读取名称", exact: true }).isDisabled())
  await page.getByText("上次名称读取失败，可重试", { exact: true }).waitFor()
  await evaluate("window.fixture.readRelease()")
  await page.getByRole("button", { name: "重试读取名称", exact: true }).waitFor({ state: "hidden" })
  pass(
    "A local catalog refusal is caught, preserves its old name and offers a real successful retry"
  )
  await page.keyboard.press("Escape")

  await evaluate(
    "window.fixture.catalog.models=window.fixture.catalog.models.filter(m=>m.id!=='custom:b');window.fixture.refresh()"
  )
  await settings()
  await page.getByRole("button", { name: "编辑组合模型配置", exact: true }).click()
  await modelDialog().waitFor()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  const missingIndex = (await evaluate<number>("window.fixture.pending.length")) - 1
  await evaluate(`window.fixture.finish(${missingIndex})`)
  assert.deepEqual(await evaluate("window.fixture.writes"), [["b", "custom:new"]])
  pass(
    "A combination absent from the acquired catalog keeps a reachable repair entry without base selection"
  )

  await patch({ composerMode: "flow", clawDefaultModel: undefined })
  await page.getByRole("button", { name: "模型按步骤设置", exact: true }).waitFor()
  await patch({ modsEnabled: false })
  assert.equal(await page.getByRole("button", { name: "模型按步骤设置", exact: true }).count(), 0)
  await page.getByRole("button", { name: /智能路由.*模型 A/ }).waitFor()
  pass("Disabling Mods closes the flow-model entry and restores the original model control")

  await evaluate(`window.fixture.catalog.models.push(
    {id:'custom:x',model:'legacy',name:'同名甲',source:'custom',provider:'custom',available:true},
    {id:'custom:y',model:'legacy',name:'同名乙',source:'custom',provider:'custom',available:true});
    window.fixture.refresh()`)
  await patch({ modsEnabled: true, composerMode: "chat", clawDefaultModel: "custom:legacy" })
  await page.getByRole("button", { name: /当前组合模型.*名称尚未确认/ }).waitFor()
  await settings()
  const beforeAmbiguousRepair = await evaluate<number>("window.fixture.globalWrites.length")
  await page.getByRole("button", { name: "编辑组合模型配置", exact: true }).click()
  assert.equal(await modelDialog().count(), 0)
  assert.equal(await evaluate("window.fixture.sidebarTabs.at(-1)"), "configuration")
  assert.equal(await evaluate("window.fixture.globalWrites.length"), beforeAmbiguousRepair)
  pass("Ambiguous legacy names use the public configuration path without guessing a dialog target")

  assert.deepEqual([...pageErrors], [])
  await page.screenshot({ path: join(artifacts, "model-controls.png") })

  await page.close()
  page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await mount(page, true, "custom:b")
  await page.getByRole("button", { name: /当前组合模型.*名称尚未取得/ }).waitFor()
  await settings()
  await page.getByText("上次名称读取失败，可重试", { exact: true }).waitFor()
  assert.equal(await evaluate("window.fixture.catalogReads"), 1)
  assert.deepEqual(await evaluate("window.fixture.writes"), [])
  await page.getByRole("button", { name: "编辑组合模型配置", exact: true }).click()
  assert.equal(await modelDialog().count(), 0)
  assert.equal(await evaluate("window.fixture.sidebarTabs.at(-1)"), "configuration")
  await evaluate("window.fixture.rejectRead=false")
  await page.getByRole("button", { name: "重试读取名称", exact: true }).click()
  await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
  assert.equal(await evaluate("window.fixture.catalogReads"), 2)
  assert.deepEqual([...pageErrors], [])
  pass("First-read refusal keeps the name unconfirmed and explicit retry acquires the catalog")

  for (const [label, change] of [
    ["project OFF", { modsEnabled: false }],
    ["application OFF", { modsEnabled: false, clawDefaultModel: undefined }],
    ["remove combination", { clawDefaultModel: undefined }]
  ] as const) {
    await mount(page, false, "custom:b")
    await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
    await evaluate("window.testMetadata('a','custom:a');window.testActualModel('a','custom:b')")
    await settings()
    await page.getByText("原聊天模型：模型 A", { exact: true }).waitFor()
    await editBase()
    assert.equal(await page.locator("[data-model-target]").innerText(), "custom:a")
    await page.getByRole("button", { name: "关闭配置窗口", exact: true }).click()
    await patch(change)
    await page.getByRole("button", { name: "模型 A", exact: true }).waitFor()
    assert.equal(await evaluate("window.testThread('a').currentModel"), "custom:a")
    assert.deepEqual(await evaluate("window.fixture.writes"), [])
    assert.equal(await evaluate("window.testStore().threads[0].metadata.model"), "custom:a")
    pass(`Pinned ${label} restores persisted manual A after actual B, without a metadata write`)
  }

  for (const target of ["custom:new", "custom:b"]) {
    await mount(page, false, "custom:b")
    await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
    await evaluate("window.testMetadata('a','custom:a');window.testActualModel('a','custom:b')")
    await settings()
    const name = target === "custom:new" ? "新模型" : "模型 B"
    await page
      .getByRole("dialog")
      .getByRole("button")
      .filter({
        has: page.getByText(name, { exact: true })
      })
      .click()
    await evaluate("window.testActualModel('a','custom:b')")
    await patch({ clawDefaultModel: undefined })
    await page.getByRole("button", { name, exact: true }).waitFor()
    assert.equal(await evaluate("window.testThread('a').currentModel"), target)
    assert.deepEqual(await evaluate("window.fixture.writes"), [["a", target]])
    assert.equal(await evaluate("window.testStore().threads[0].metadata.model"), "custom:a")
    await evaluate(`window.testMetadata('a',${JSON.stringify(target)})`)
    await patch({ clawDefaultModel: "custom:b" })
    await evaluate("window.testActualModel('a','custom:b')")
    await patch({ clawDefaultModel: undefined })
    assert.equal(await evaluate("window.testThread('a').currentModel"), target)
    pass(`Pending manual ${target} survives removal before metadata acknowledgement and after it`)
  }

  await mount(page, false, "custom:b")
  await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
  await evaluate("window.testMetadata('a','custom:a');window.testActualModel('a','custom:b')")
  await settings()
  await page.getByRole("switch", { name: "智能路由", exact: true }).click()
  await patch({})
  await evaluate("window.testActualModel('a','custom:b')")
  await patch({ modsEnabled: false, clawDefaultModel: undefined })
  await page.getByRole("button", { name: /智能路由.*模型 B/ }).waitFor()
  assert.equal(await evaluate("window.testThread('a').currentModel"), "custom:b")
  assert.equal(await evaluate("window.testStore().threads[0].metadata.model"), "custom:a")
  assert.equal(await evaluate("window.fixture.snapshot().routingMode"), "auto")
  assert.deepEqual(await evaluate("window.fixture.writes"), [])
  pass("Auto ON keeps its temporary actual model and persisted manual A when Mods is disabled")

  await mount(page, false, "custom:b")
  await page.getByRole("button", { name: /当前组合模型.*模型 B/ }).waitFor()
  await evaluate("window.testMetadata('a','custom:a');window.testActualModel('a','custom:b')")
  await patch({ clawDefaultModel: undefined })
  await page.getByRole("button", { name: "模型 A", exact: true }).waitFor()
  await page.getByRole("button", { name: "模型 A", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({
      has: page.getByText("新模型", { exact: true })
    })
    .click()
  await evaluate("window.fixture.refresh()")
  await patch({ bindingRevision: 20, composerMode: "flow" })
  await patch({ composerMode: "chat" })
  assert.equal(await evaluate("window.testThread('a').currentModel"), "custom:new")
  assert.deepEqual(await evaluate("window.fixture.writes"), [["a", "custom:new"]])
  pass("Ordinary refresh and unrelated scope changes do not replay outdated manual metadata")

  await mount(page, false, "custom:b", true)
  await page.getByRole("button", { name: /当前组合模型/ }).waitFor()
  await evaluate("window.testMetadata('a','custom:a');window.testActualModel('a','custom:b')")
  await settings()
  await page.getByRole("button", { name: "去配置模型", exact: true }).click()
  await modelDialog().waitFor()
  await page.getByRole("button", { name: "保存并延迟完成", exact: true }).click()
  await evaluate("window.fixture.finish(0);window.testActualModel('a','custom:b')")
  assert.equal(await evaluate("window.fixture.snapshot()"), null)
  await patch({ clawDefaultModel: undefined })
  assert.equal(await evaluate("window.fixture.snapshot()"), null)
  await evaluate("window.fixture.readRelease()")
  await page.getByRole("button", { name: "新模型", exact: true }).waitFor()
  assert.equal(await evaluate("window.testThread('a').currentModel"), "custom:new")
  assert.equal(await evaluate("window.testStore().threads[0].metadata.model"), "custom:a")
  assert.deepEqual(await evaluate("window.fixture.writes"), [["a", "custom:new"]])
  pass(
    "First catalog completion cannot overwrite pending manual intent restored after Claw removal"
  )

  await mount(page, false, "custom:b", true)
  await page.getByRole("button", { name: /当前组合模型/ }).waitFor()
  await evaluate("window.testMetadata('a','custom:a');window.testActualModel('a','custom:b')")
  await patch({ clawDefaultModel: undefined })
  await evaluate("window.testMetadata('b','custom:new');window.testActualModel('b','custom:new')")
  await patch({ threadId: "b" })
  await evaluate("window.fixture.readRelease()")
  await page.getByRole("button", { name: "新模型", exact: true }).waitFor()
  assert.equal(await evaluate("window.testThread('a').currentModel"), "custom:b")
  assert.equal(await evaluate("window.testThread('b').currentModel"), "custom:new")
  assert.deepEqual(await evaluate("window.fixture.writes"), [])
  assert.deepEqual(await evaluate("window.fixture.restores"), [])
  pass("A pending removal before catalog completion cannot restore a previous thread")
  assert.deepEqual([...pageErrors], [])
}

async function main(): Promise<void> {
  const failures: string[] = []
  try {
    await run()
  } catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
  } finally {
    try {
      await browser?.close()
    } catch (error) {
      failures.push(String(error))
    }
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          checks,
          pageErrors,
          failures,
          passed: failures.length === 0 && pageErrors.length === 0,
          scope:
            "Real ModelSwitcher and Popover; controlled store/catalog/dialog callback boundary",
          productionPackage: false,
          realModelConfigSave: false,
          realProviderRequest: false
        },
        null,
        2
      ) + "\n",
      { flag: "wx" }
    )
  }
  assert.deepEqual(failures, [])
  assert.deepEqual([...pageErrors], [])
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
