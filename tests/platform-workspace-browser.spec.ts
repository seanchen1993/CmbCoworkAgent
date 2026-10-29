/** Real React controls against a bounded native IPC fixture; actual guest/protocol tests are colocated. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"

interface WorkspaceStats {
  mounts: number
  unmounts: number
  sends: number
  cards: number
  platform: number
  activeReads: number
  maxActiveReads: number
  completedReads: number
  lateFramesSeen: number
  reads: number
  opens: number
  closes: number
  acts: number
  lastOpen?: string
}

async function main() {
  const output = resolve("output/mods-iteration-20261015/platform-workspace")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  const checks: string[] = []
  try {
    await mount(
      page,
      `
      import {PlatformWorkspace} from ${JSON.stringify(resolve("src/renderer/src/components/platform/PlatformWorkspace.tsx"))};
      // about:blank is an insecure fixture origin. Electron's app origin provides this natively.
      if(!crypto.randomUUID)crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
      const pcards=new Set(),pchanges=new Set(),pconfig=new Set(),presenters=new Set(),ops=[];
      let mounts=0,unmounts=0,seq=0,drawing=0,failTree=false,failClose=false,deferOpen=false,finishOpen,deferSurfaceRead=false,rejectRead,resolveRead,deferDisable=false,finishDisable,activeReads=0,maxActiveReads=0,completedReads=0,readFailures=[],persistentReadError='',actionError='';
      const lateFramesSeen=[];
      let deferAction=false,finishAction,catalogFailure=false;
      let formKey='settings',formProvider='author';
      new MutationObserver(records=>{if(records.some(record=>[...record.addedNodes].some(node=>node.textContent?.includes('LATE frame '))))lateFramesSeen.push(true)}).observe(document.body,{subtree:true,childList:true});
      let present={version:1,presentable:true},nativePages=new Map(),activeThread='a',visible=true;
      window.api.windowPresentation={read:async()=>present,onChanged:fn=>{presenters.add(fn);return()=>presenters.delete(fn)}};
      window.api.mods.onCardsChanged=fn=>{pcards.add(fn);return()=>pcards.delete(fn)};
      window.api.mods.onPlatformChanged=fn=>{pchanges.add(fn);return()=>pchanges.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{pconfig.add(fn);return()=>pconfig.delete(fn)};
      const row=(t,side=false)=>({type:'surface',apiVersion:'devclaw.surface/v1',id:side?'sidebar':'board',title:side?'作者侧栏':'通用作者页面',placement:side?'sidebar':'page',paneId:'board',openAction:'open',key:'key-'+t+(side?'-side':''),ref:{provider:'author',id:'board',version:'1.0.0'},source:{provider:'author',digest:'a'.repeat(64),generation:t},enabled:true});
      const tree=marker=>failTree?{type:'Table',props:{columns:[],rows:[]}}:{type:'Box',props:{},children:[...(marker?[{type:'Text',props:{},children:[marker]}]:[]),{type:'Table',props:{label:'实际任务表',columns:[{key:'name',label:'任务'}],rows:[{name:'真实任务'}]}},{type:'Form',props:{key:formKey,label:'页面表单',fields:[{name:'title',label:'页面标题',type:'text',required:true}],values:{title:'原值'}},press:{plugin:formProvider,handle:1}}]};
      const frame=(t,id)=>({openId:id,entry:row(t),pane:{key:'author:board',id:'board',plugin:'author',title:'通用作者页面',generation:'12345678-1234-1234-1234-123456789012',openRequestId:id,tree:tree(),closeOnEscape:true,rows:12}});
      const api={
        platformSurfaceList:async t=>{ops.push(['list',t]);if(catalogFailure)throw Error('CATALOG_UNAVAILABLE');return{revision:1,entries:[row(t),row(t,true),{...row(t),id:'navigation',key:'key-'+t+'-navigation',title:'切换作者页面',placement:'navigation'}],errors:[]}},
        platformBehaviorList:async t=>({revision:1,bindings:[{key:'author/format',title:'作者替换',point:'ui.toast',phase:'replace',available:true}],active:[],errors:[]}),
        platformSurfaceOpen:async(t,a,intent)=>{const id='open-'+(++seq);ops.push(['open',t,id]);const result=frame(t,id);if(deferOpen){deferOpen=false;await new Promise(r=>finishOpen=r)}nativePages.set(t,result);return result},
        platformSurfaceRead:async(t,a)=>{ops.push(['read',t,a.openId]);activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);const captured=nativePages.get(t);try{let resumed;if(deferSurfaceRead){deferSurfaceRead=false;resumed=await new Promise((r,j)=>{resolveRead=r;rejectRead=j})}if(readFailures.length)throw Error(readFailures.shift());if(persistentReadError)throw Error(persistentReadError);const result=resumed==='old'?captured:nativePages.get(t);if(!result||result.openId!==a.openId)throw Error('stale');return{...result,pane:{...result.pane,generation:'12345678-1234-1234-1234-'+String(++drawing).padStart(12,'0'),tree:tree(resumed==='old'?'LATE frame '+a.openId:undefined)}}}finally{activeReads--;completedReads++}},
        platformSurfaceClose:async(t,a)=>{ops.push(['close',t,a.openId]);if(failClose)throw Error('physical cleanup unknown');if(nativePages.get(t)?.openId===a.openId)nativePages.delete(t)},
        platformSurfaceAct:async(t,a,action)=>{ops.push(['act',t,a.openId,action.value,action.intentId]);if(deferAction){deferAction=false;await new Promise(r=>finishAction=r)}if(actionError){const message=actionError;actionError='';throw Error(message)}},
        platformSurfaceDisable:async(t,a)=>{ops.push(['disable',t,a.openId]);if(deferDisable){deferDisable=false;await new Promise(r=>finishDisable=r)}if(!a.openId||nativePages.get(t)?.openId===a.openId)nativePages.delete(t)},platformSurfaceEnable:async()=>{},
        platformBehaviorPreview:async(t,s)=>({previewId:'preview',revision:1,selected:s,order:s,conflicts:[],missing:[],canApply:true}),
        platformBehaviorApply:async()=>{ops.push(['apply'])},platformBehaviorDisable:async()=>{ops.push(['restore'])}
      };
      let sends=0;
      function ChatProbe(){useEffect(()=>{mounts++;return()=>{unmounts++}},[]);return <><textarea aria-label='原聊天输入' defaultValue='未发送草稿'/><button aria-label='原生发送' style={{position:'absolute',bottom:20,right:20,width:60,height:36}} onClick={()=>sends++}>发送</button></>}
      function Harness({id,shown}){return <main style={{position:'relative',width:'100%',height:760}}><ChatProbe/>{shown&&<PlatformWorkspace threadId={id} active api={api}/>}</main>}
      const draw=()=>host.render(<Harness id={activeThread} shown={visible}/>);
      window.platformFixture={ops,counts:()=>({mounts,unmounts,sends,cards:pcards.size,platform:pchanges.size,activeReads,maxActiveReads,completedReads,lateFramesSeen:lateFramesSeen.length}),
        catalogFail:value=>{catalogFailure=value;for(const fn of pchanges)fn({threadId:activeThread})},
        formIdentity:(key,provider)=>{formKey=key;formProvider=provider;for(const fn of pchanges)fn({threadId:activeThread})},
        actionDefer:()=>deferAction=true,actionFinish:()=>finishAction(),
        render:(id,show=true)=>{activeThread=id;visible=show;draw()},bad:()=>{failTree=true;for(const fn of pchanges)fn({threadId:activeThread})},good:()=>failTree=false,
        defer:()=>deferOpen=true,finish:()=>finishOpen(),disableDefer:()=>deferDisable=true,disableFinish:()=>finishDisable(),closeFail:v=>failClose=v,readDefer:()=>deferSurfaceRead=true,readReject:(message='stale read')=>rejectRead(Error(message)),
        readResolveOld:()=>resolveRead('old'),readFail:message=>readFailures.push(message),readAlways:message=>persistentReadError=message,actFail:message=>actionError=message,
        present:value=>{present={version:present.version+1,presentable:value};for(const fn of presenters)fn(present)},
        progress:()=>{for(const fn of pchanges)fn({threadId:activeThread})}};
      draw();
    `,
      [
        {
          name: "unused-code-worker",
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, () => ({
              path: "unused-code-worker",
              namespace: "platform-fixture"
            }))
            builder.onLoad({ filter: /.*/, namespace: "platform-fixture" }, () => ({
              contents:
                "export default class Worker {postMessage(){} addEventListener(){} removeEventListener(){} terminate(){}}",
              loader: "js"
            }))
          }
        }
      ]
    )
    // Build only this fixture's current styles in memory; never depend on stale production output.
    const stylePath = resolve("src/renderer/src/index.css")
    const styles = await compile(readFileSync(stylePath, "utf8"), {
      base: dirname(stylePath),
      onDependency() {
        // This in-memory fixture compiles once and needs no dependency watcher.
      }
    })
    const candidates = new Scanner({}).scanFiles(
      [
        "src/renderer/src/components/platform/PlatformWorkspace.tsx",
        "src/renderer/src/components/platform/PlatformWidget.tsx",
        "src/renderer/src/components/chat/FunctionPanes.tsx"
      ].map((path) => ({ content: readFileSync(resolve(path), "utf8"), extension: "tsx" }))
    )
    await page.addStyleTag({ content: styles.build(candidates) })
    const open = () => page.getByRole("button", { name: "通用作者页面", exact: true }).click()
    const region = page.getByRole("region", { name: "通用作者页面", exact: true })
    await page.getByRole("button", { name: "作者侧栏", exact: true }).waitFor()
    await page.evaluate("window.platformFixture.catalogFail(true)")
    await page.getByText("扩展暂时不可用，聊天仍可继续", { exact: true }).waitFor()
    await page.evaluate("window.platformFixture.catalogFail(false)")
    await page.getByText("扩展暂时不可用，聊天仍可继续", { exact: true }).waitFor({ state: "hidden" })
    checks.push("a successful catalogue reread clears the obsolete failure notice")
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 812 })
      assert.equal(
        await page.getByRole("button", { name: "原生发送" }).evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return (
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node
          )
        }),
        true
      )
      await page.getByRole("button", { name: "原生发送" }).click()
    }
    assert.equal(await page.evaluate("window.platformFixture.counts().sends"), 2)
    await page.setViewportSize({ width: 375, height: 812 })
    checks.push("375/1280px sidebar launcher leaves native send hit target clickable")
    await open()
    await region.waitFor()
    await page.getByLabel("页面标题", { exact: true }).fill("用户设置")
    await page.getByLabel("页面标题", { exact: true }).evaluate((node) => {
      ;(window as unknown as { platformTitleInput: Element }).platformTitleInput = node
    })
    const readsBeforeDraft = await page.evaluate(
      "window.platformFixture.ops.filter(x=>x[0]==='read').length"
    )
    await page.evaluate("window.platformFixture.progress()")
    await page.waitForFunction(
      (before) =>
        (window as unknown as { platformFixture: { ops: unknown[][] } }).platformFixture.ops.filter(
          (row) => row[0] === "read"
        ).length > before,
      readsBeforeDraft
    )
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate(
          (node) =>
            node === (window as unknown as { platformTitleInput: Element }).platformTitleInput
        ),
      true,
      "A refreshed drawing generation must retain the current Form DOM"
    )
    assert.equal(
      await page.getByLabel("页面标题", { exact: true }).inputValue(),
      "用户设置",
      "Background progress must retain the user's unsubmitted Form values"
    )
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
      "A refreshed drawing must retain input focus"
    )
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate((node) => getComputedStyle(node).outlineWidth),
      "2px",
      "Platform Forms retain the shared accessible input focus style"
    )
    checks.push(
      "new drawing generations preserve the open page's Form DOM, unsubmitted values and keyboard focus"
    )
    const beforeStale = await page.evaluate<{
      read: number
      close: number
      open: number
      act: number
      completed: number
    }>(
      "({read:window.platformFixture.ops.filter(x=>x[0]==='read').length,close:window.platformFixture.ops.filter(x=>x[0]==='close').length,open:window.platformFixture.ops.filter(x=>x[0]==='open').length,act:window.platformFixture.ops.filter(x=>x[0]==='act').length,completed:window.platformFixture.counts().completedReads})"
    )
    await page.evaluate("window.platformFixture.readDefer();window.platformFixture.progress()")
    await page.waitForFunction("window.platformFixture.counts().activeReads===1")
    assert.equal(
      await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true,
      "Native redraw cannot retire a generation while its old controls are interactive"
    )
    const draft = page.getByLabel("页面标题", { exact: true })
    assert.equal(await draft.isEnabled(), true)
    await draft.evaluate((node) => (node as HTMLInputElement).setSelectionRange(2, 2))
    await draft.pressSequentially("12345", { delay: 10 })
    assert.equal(await draft.inputValue(), "用户12345设置")
    assert.deepEqual(
      await draft.evaluate((node) => {
        const input = node as HTMLInputElement
        return [input.selectionStart, input.selectionEnd, input === document.activeElement]
      }),
      [7, 7, true]
    )
    await draft.press("Enter")
    assert.equal(
      await page.evaluate("window.platformFixture.ops.filter(x=>x[0]==='act').length"),
      beforeStale.act,
      "Draft editing and Enter cannot invoke the old native callback"
    )
    await draft.fill("用户设置")
    await page.evaluate("for(let i=0;i<20;i++)window.platformFixture.progress()")
    await open()
    await page.getByLabel("页面标题", { exact: true }).focus()
    await page.evaluate(
      "window.platformFixture.readReject(\"Error invoking remote method 'mods:platform-surface-read': Error: MODS_UI_DRAWING_STALE\")"
    )
    await page.waitForFunction(
      (completed) =>
        (
          window as unknown as { platformFixture: { counts(): { completedReads: number } } }
        ).platformFixture.counts().completedReads >=
          completed + 2 &&
        (
          window as unknown as { platformFixture: { counts(): { activeReads: number } } }
        ).platformFixture.counts().activeReads === 0,
      beforeStale.completed
    )
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    assert(await region.isVisible(), "A superseded drawing read must retain the open page")
    assert.equal(await page.evaluate("window.platformFixture.counts().maxActiveReads"), 1)
    assert(
      (await page.evaluate("window.platformFixture.ops.filter(x=>x[0]==='read').length")) -
        beforeStale.read <=
        4,
      "Twenty notifications and a same-page click must coalesce into a bounded read burst"
    )
    assert.deepEqual(
      await page.evaluate(
        "({close:window.platformFixture.ops.filter(x=>x[0]==='close').length,open:window.platformFixture.ops.filter(x=>x[0]==='open').length,act:window.platformFixture.ops.filter(x=>x[0]==='act').length})"
      ),
      { close: beforeStale.close, open: beforeStale.open, act: beforeStale.act },
      "Drawing recovery must only read; it must not close, reopen or replay an action"
    )
    assert.equal(await page.getByLabel("页面标题", { exact: true }).inputValue(), "用户设置")
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate(
          (node) =>
            node === (window as unknown as { platformTitleInput: Element }).platformTitleInput &&
            node === document.activeElement
        ),
      true
    )
    checks.push(
      "superseded concurrent drawing refresh coalesces without losing the page, draft or focus"
    )
    await page.getByRole("button", { name: "保存", exact: true }).click()
    assert.equal(
      await page.evaluate("window.platformFixture.ops.filter(x=>x[0]==='act').at(-1)[3]"),
      '{"title":"用户设置"}'
    )
    assert.equal(await page.evaluate("document.documentElement.scrollWidth<=375"), true)
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    assert.equal(await page.getByLabel("原聊天输入").inputValue(), "未发送草稿")
    assert.deepEqual(
      await page.evaluate(
        "[window.platformFixture.counts().mounts,window.platformFixture.counts().unmounts]"
      ),
      [1, 0]
    )
    checks.push(
      "375px controlled table/form, real keyboard Escape, original chat DOM/draft survives"
    )
    await open()
    await region.waitFor()
    assert.equal(
      await page.getByLabel("页面标题", { exact: true }).inputValue(),
      "原值",
      "A new open custody starts with its own initial Form values"
    )
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate(
          (node) =>
            node === (window as unknown as { platformTitleInput: Element }).platformTitleInput
        ),
      false
    )
    await page.getByRole("button", { name: "行为设置", exact: true }).click()
    await page.getByText("业务行为设置", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.platformFixture.ops.filter(x=>x[0]==='close').length"),
      2
    )
    await page.getByRole("button", { name: "返回聊天", exact: true }).click()
    await open()
    await region.waitFor()
    await page.evaluate("window.platformFixture.render('b')")
    await page.waitForFunction("window.platformFixture.ops.some(x=>x[0]==='close'&&x[1]==='a')")
    await open()
    await region.waitFor()
    await page.evaluate("window.platformFixture.present(false)")
    await page.waitForFunction(
      "window.platformFixture.counts().platform===0&&window.platformFixture.counts().cards===0"
    )
    const before = await page.evaluate("window.platformFixture.ops.length")
    await page.evaluate("window.platformFixture.progress()")
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate("window.platformFixture.ops.length"), before)
    await page.evaluate("window.platformFixture.present(true)")
    await page.waitForFunction("window.platformFixture.counts().platform===1")
    checks.push(
      "behavior transition, target change and native minimize close pages; hidden listeners detach and resume"
    )
    await open()
    await region.waitFor()
    const priorReads = await page.evaluate(
      "window.platformFixture.ops.filter(x=>x[0]==='read').length"
    )
    await page.evaluate("window.platformFixture.readDefer();window.platformFixture.progress()")
    await page.waitForFunction(
      (before) =>
        (window as unknown as { platformFixture: { ops: unknown[][] } }).platformFixture.ops.filter(
          (x) => x[0] === "read"
        ).length > before,
      priorReads
    )
    await page.getByRole("button", { name: "切换作者页面", exact: true }).click()
    await region.waitFor()
    const nextOpen = await page.evaluate(
      "window.platformFixture.ops.filter(x=>x[0]==='open').at(-1)[2]"
    )
    await page.evaluate("window.platformFixture.readReject()")
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    assert(await region.isVisible(), "A late rejected read cannot erase the newly opened page")
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    assert(
      await page.evaluate(
        (openId) =>
          (window as unknown as { platformFixture: { ops: unknown[][] } }).platformFixture.ops.some(
            (x) => x[0] === "close" && x[2] === openId
          ),
        nextOpen
      ),
      "The new page keeps custody until its own explicit close"
    )
    checks.push("late read rejection cannot erase a newer page or strand its native custody")
    await open()
    await region.waitFor()
    await page.evaluate("window.platformFixture.disableDefer()")
    await page.getByRole("button", { name: "停用此页面", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: "切换作者页面", exact: true }).isDisabled(),
      true,
      "A pending disable must reserve page admission"
    )
    const opensDuringDisable = await page.evaluate(
      "window.platformFixture.ops.filter(x=>x[0]==='open').length"
    )
    await page.getByRole("button", { name: "关闭", exact: true }).last().click()
    await region.waitFor({ state: "detached" })
    assert.equal(
      await page.getByRole("button", { name: "通用作者页面", exact: true }).isDisabled(),
      true
    )
    await page.evaluate("window.platformFixture.disableFinish()")
    await page.waitForFunction(
      () =>
        !(
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent === "通用作者页面"
          ) as HTMLButtonElement | undefined
        )?.disabled
    )
    await open()
    await region.waitFor()
    assert.equal(
      await page.evaluate("window.platformFixture.ops.filter(x=>x[0]==='open').length"),
      opensDuringDisable + 1
    )
    const afterDisableOpen = await page.evaluate(
      "window.platformFixture.ops.filter(x=>x[0]==='open').at(-1)[2]"
    )
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    assert(
      await page.evaluate(
        (openId) =>
          (window as unknown as { platformFixture: { ops: unknown[][] } }).platformFixture.ops.some(
            (row) => row[0] === "close" && row[2] === openId
          ),
        afterDisableOpen
      ),
      "The page opened after disable must retain close custody"
    )
    checks.push(
      "pending disable reserves page admission; close stays available and reopening retains custody"
    )

    await page.evaluate("window.platformFixture.defer()")
    await open()
    await page.waitForFunction("window.platformFixture.ops.filter(x=>x[0]==='open').length>=5")
    await page.evaluate("window.platformFixture.render('b',false)")
    await page.evaluate("window.platformFixture.finish()")
    await page.waitForFunction(
      "window.platformFixture.ops.filter(x=>x[0]==='close'&&x[1]==='b').length>=2"
    )
    await page.evaluate("window.platformFixture.render('b',true)")
    await open()
    await region.waitFor()
    await page.evaluate("window.platformFixture.bad()")
    await page.getByText("此页面显示失败，可关闭或停用后继续聊天。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "停用此页面", exact: true }).isVisible(),
      true
    )
    await page.evaluate("window.platformFixture.closeFail(true)")
    await page.getByRole("button", { name: "关闭", exact: true }).last().click()
    await page.getByRole("button", { name: "停用页面并核对清理", exact: true }).waitFor()
    await page.getByRole("button", { name: "停用页面并核对清理", exact: true }).click()
    await page.waitForFunction("window.platformFixture.ops.some(x=>x[0]==='disable')")
    checks.push(
      "pending open after true unmount is cleaned; malformed guest region keeps native disable; unknown cleanup is visible"
    )
    await page.evaluate("window.platformFixture.closeFail(false);window.platformFixture.good()")
    await open()
    await region.waitFor()
    await page.getByLabel("页面标题", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("页面标题", { exact: true }).inputValue(), "原值")
    assert.equal(
      await page.getByText("此页面显示失败，可关闭或停用后继续聊天。", { exact: true }).count(),
      0
    )
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    checks.push("fresh native open custody resets a failed drawing boundary and Form state")

    const stats = () =>
      page.evaluate<WorkspaceStats>(
        "({...window.platformFixture.counts(),reads:window.platformFixture.ops.filter(x=>x[0]==='read').length,opens:window.platformFixture.ops.filter(x=>x[0]==='open').length,closes:window.platformFixture.ops.filter(x=>x[0]==='close').length,acts:window.platformFixture.ops.filter(x=>x[0]==='act').length,lastOpen:window.platformFixture.ops.filter(x=>x[0]==='open').at(-1)?.[2]})"
      )
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    const waitReads = async (before: number, count: number) => {
      await page.waitForFunction(
        ({ before, count }) => {
          const fixture = (
            window as unknown as {
              platformFixture: { counts(): { completedReads: number; activeReads: number } }
            }
          ).platformFixture.counts()
          return fixture.completedReads >= before + count && fixture.activeReads === 0
        },
        { before, count }
      )
      await settle()
    }

    await open()
    await region.waitFor()
    await page.getByLabel("页面标题", { exact: true }).fill("补帧保留的草稿")
    await page.getByLabel("页面标题", { exact: true }).evaluate((node) => {
      ;(window as unknown as { platformRetryInput: Element }).platformRetryInput = node
    })
    const singleStale = await stats()
    await page.evaluate(
      "window.platformFixture.readFail('MODS_UI_DRAWING_STALE');window.platformFixture.progress()"
    )
    await waitReads(singleStale.completedReads, 2)
    const afterSingleStale = await stats()
    assert.equal(afterSingleStale.reads - singleStale.reads, 2)
    assert.equal(afterSingleStale.closes, singleStale.closes)
    assert.equal(afterSingleStale.opens, singleStale.opens)
    assert.equal(afterSingleStale.acts, singleStale.acts)
    assert.equal(await page.getByLabel("页面标题", { exact: true }).inputValue(), "补帧保留的草稿")
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate(
          (node) =>
            node === (window as unknown as { platformRetryInput: Element }).platformRetryInput &&
            node === document.activeElement
        ),
      true
    )
    checks.push(
      "one stale read recovers without a new event and preserves Form identity, draft and focus"
    )

    const persistentStale = await stats()
    await page.evaluate(
      "window.platformFixture.readAlways('MODS_UI_DRAWING_STALE');window.platformFixture.progress()"
    )
    await waitReads(persistentStale.completedReads, 3)
    const exhausted = await stats()
    assert.equal(exhausted.reads - persistentStale.reads, 3)
    assert.equal(exhausted.closes, persistentStale.closes)
    assert.equal(exhausted.opens, persistentStale.opens)
    assert.equal(exhausted.acts, persistentStale.acts)
    assert.equal(
      await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true,
      "Exhausted drawing retries cannot re-enable an unconfirmed old generation"
    )
    assert(await region.isVisible())
    assert.equal(await page.getByLabel("页面标题", { exact: true }).inputValue(), "补帧保留的草稿")
    await page.evaluate("window.platformFixture.progress()")
    await waitReads(exhausted.completedReads, 1)
    const notificationAfterExhaustion = await stats()
    assert.equal(notificationAfterExhaustion.reads - exhausted.reads, 1)
    assert.equal(notificationAfterExhaustion.closes, persistentStale.closes)
    await page.evaluate("window.platformFixture.readAlways('');window.platformFixture.progress()")
    await waitReads(notificationAfterExhaustion.completedReads, 1)
    checks.push(
      "persistent stale has two autonomous retries; notifications cannot replenish retry credit"
    )

    await page.evaluate(
      "window.platformRefreshTimer=setInterval(()=>window.platformFixture.progress(),10)"
    )
    const streamingDraft = page.getByLabel("页面标题", { exact: true })
    try {
      await streamingDraft.fill("")
      await streamingDraft.pressSequentially("continuous-draft-1234567890", { delay: 20 })
      assert.equal(await streamingDraft.inputValue(), "continuous-draft-1234567890")
      assert.deepEqual(
        await streamingDraft.evaluate((node) => {
          const input = node as HTMLInputElement
          return [input.selectionStart, input.selectionEnd, input === document.activeElement]
        }),
        [27, 27, true]
      )
    } finally {
      await page.evaluate("clearInterval(window.platformRefreshTimer)")
    }
    await settle()
    const pendingAction = await stats()
    await page.evaluate("window.platformFixture.actionDefer()")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.evaluate("for(let i=0;i<20;i++)window.platformFixture.progress()")
    await settle()
    const actionHeld = await stats()
    assert.equal(actionHeld.acts, pendingAction.acts + 1)
    assert.equal(
      actionHeld.reads,
      pendingAction.reads,
      "Notifications cannot retire callback authority while its user action is in flight"
    )
    assert.equal(
      await streamingDraft.isDisabled(),
      true,
      "An in-flight action keeps the original local Form admission rule"
    )
    await page.evaluate("window.platformFixture.actionFinish()")
    await waitReads(pendingAction.completedReads, 1)
    assert.equal((await stats()).acts, pendingAction.acts + 1)
    checks.push(
      "frequent native refresh preserves continuous draft typing and serializes one action without replay"
    )
    await streamingDraft.fill("补帧保留的草稿")

    const failedAction = await stats()
    await page.evaluate("window.platformFixture.actFail('MODS_UI_DRAWING_STALE')")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page
      .getByRole("alert")
      .filter({ hasText: "操作未完成，请核对结果；没有自动重试" })
      .waitFor()
    await settle()
    const afterFailedAction = await stats()
    assert.equal(afterFailedAction.acts - failedAction.acts, 1)
    assert.equal(afterFailedAction.reads, failedAction.reads)
    assert.equal(afterFailedAction.opens, failedAction.opens)
    assert.equal(afterFailedAction.closes, failedAction.closes)
    assert.equal(await page.getByLabel("页面标题", { exact: true }).inputValue(), "补帧保留的草稿")
    assert.equal(
      await page.evaluate("window.platformFixture.ops.filter(x=>x[0]==='act').at(-1)[3]"),
      '{"title":"补帧保留的草稿"}'
    )
    checks.push(
      "a stale action is reported after one intent and is never replayed by read recovery"
    )
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })

    for (const code of ["MODS_PLATFORM_SURFACE_STALE", "MODS_PLATFORM_SCOPE_CHANGED"]) {
      await open()
      await region.waitFor()
      const terminal = await stats()
      await page.evaluate((code) => {
        const fixture = (
          window as unknown as {
            platformFixture: { readFail(code: string): void; progress(): void }
          }
        ).platformFixture
        fixture.readFail(code)
        fixture.progress()
      }, code)
      await waitReads(terminal.completedReads, 1)
      await region.waitFor({ state: "detached" })
      const afterTerminal = await stats()
      assert.equal(afterTerminal.reads - terminal.reads, 1, `${code} must not be retried`)
      assert.equal(afterTerminal.closes - terminal.closes, 1, `${code} must release custody once`)
      assert.equal(afterTerminal.opens, terminal.opens)
      assert.equal(afterTerminal.acts, terminal.acts)
    }
    checks.push(
      "surface revision and scope failures still close once without read or action retries"
    )

    await open()
    await region.waitFor()
    const oldPage = await stats()
    await page.evaluate("window.platformFixture.readDefer();window.platformFixture.progress()")
    await page.waitForFunction("window.platformFixture.counts().activeReads===1")
    await page.getByRole("button", { name: "切换作者页面", exact: true }).click()
    await region.waitFor()
    await page.getByLabel("页面标题", { exact: true }).fill("新页面的草稿")
    await page.getByLabel("页面标题", { exact: true }).evaluate((node) => {
      ;(window as unknown as { platformNextInput: Element }).platformNextInput = node
    })
    const newPage = await stats()
    assert.notEqual(newPage.lastOpen, oldPage.lastOpen)
    await page.evaluate("window.platformFixture.readResolveOld()")
    await waitReads(oldPage.completedReads, 1)
    const afterOldSuccess = await stats()
    assert.equal(afterOldSuccess.lastOpen, newPage.lastOpen)
    assert.equal(afterOldSuccess.closes, newPage.closes)
    assert.equal(afterOldSuccess.reads, newPage.reads)
    assert.equal(
      afterOldSuccess.lateFramesSeen,
      0,
      "An old drawing must never be published, even briefly"
    )
    assert.equal(await page.getByLabel("页面标题", { exact: true }).inputValue(), "新页面的草稿")
    assert.equal(
      await page
        .getByLabel("页面标题", { exact: true })
        .evaluate(
          (node) => node === (window as unknown as { platformNextInput: Element }).platformNextInput
        ),
      true
    )
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    checks.push(
      "a late successful A drawing cannot publish into B, overwrite its draft or close its custody"
    )

    for (const completion of ["success", "stale"]) {
      await open()
      await region.waitFor()
      const pending = await stats()
      await page.evaluate("window.platformFixture.readDefer();window.platformFixture.progress()")
      await page.waitForFunction("window.platformFixture.counts().activeReads===1")
      await page.keyboard.press("Escape")
      await region.waitFor({ state: "detached" })
      await page.evaluate((completion) => {
        const fixture = (
          window as unknown as {
            platformFixture: { readResolveOld(): void; readReject(code: string): void }
          }
        ).platformFixture
        if (completion === "success") fixture.readResolveOld()
        else fixture.readReject("MODS_UI_DRAWING_STALE")
      }, completion)
      await waitReads(pending.completedReads, 1)
      const retired = await stats()
      assert.equal(await region.count(), 0)
      assert.equal(retired.reads - pending.reads, 1)
      assert.equal(retired.closes - pending.closes, 1)
      assert.equal(retired.opens, pending.opens)
      assert.equal(retired.acts, pending.acts)
      assert.equal(retired.lateFramesSeen, 0)
    }
    assert.equal((await stats()).maxActiveReads, 1)
    checks.push(
      "closing a pending read invalidates late success and stale retries without resurrecting the page"
    )
    await open()
    await region.waitFor()
    const identityDraft = page.getByLabel("页面标题", { exact: true })
    await identityDraft.fill("same-key draft")
    await identityDraft.evaluate((node) => {
      ;(window as unknown as { identityInput: Element }).identityInput = node
    })
    const identityBefore = await stats()
    await page.evaluate("window.platformFixture.formIdentity('settings','author')")
    await waitReads(identityBefore.completedReads, 1)
    assert.equal(await identityDraft.inputValue(), "same-key draft")
    assert.equal(
      await identityDraft.evaluate(
        (node) => node === (window as unknown as { identityInput: Element }).identityInput
      ),
      true
    )
    await page.evaluate("window.platformFixture.formIdentity('new-key','author')")
    await waitReads(identityBefore.completedReads, 2)
    assert.equal(
      await identityDraft.inputValue(),
      "原值",
      "A new Form business key cannot inherit the prior Form's unsubmitted draft"
    )
    await identityDraft.fill("new-key draft")
    await page.evaluate("window.platformFixture.formIdentity('new-key','other-provider')")
    await waitReads(identityBefore.completedReads, 3)
    assert.equal(
      await identityDraft.inputValue(),
      "原值",
      "A new callback provider cannot inherit another provider's local Form draft"
    )
    assert.equal((await stats()).acts, identityBefore.acts)
    checks.push(
      "same provider/key generations retain draft; new Form key or provider resets without native actions"
    )
    await page.keyboard.press("Escape")
    await region.waitFor({ state: "detached" })
    await page.screenshot({ path: join(output, "workspace-375.png"), fullPage: true })
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        { passed: true, checks, calls: await page.evaluate("window.platformFixture.ops") },
        null,
        2
      )
    )
    console.log(JSON.stringify({ passed: true, checks }))
  } catch (error) {
    console.error(
      "Workspace evidence",
      await page.evaluate(
        "({ops:window.platformFixture?.ops,counts:window.platformFixture?.counts()})"
      )
    )
    writeFileSync(join(output, "failure.html"), await page.content())
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
