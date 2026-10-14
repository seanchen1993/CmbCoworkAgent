/** Real message wrappers and FunctionSite, with controlled lifecycle IPC failures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

type RecoveryFixtureWindow = Window & {
  recovery: {
    fail(stage: string, code: string, count: number): void
    config(): void
    emit(): void
    owners: Map<string, unknown>
    calls: Array<[string, { owner?: string }]>
  }
}

async function main() {
  const output = resolve(
    "output/site-message-recovery-20261011",
    `browser-${Date.now()}`
  )
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const checks: string[] = [],
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (label: string) => {
    checks.push(label)
    console.log("PASS " + label)
  }
  try {
    await mount(
      page,
      `
      import {useLayoutEffect} from "react";
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {useFunctionTurnNotices} from ${JSON.stringify(resolve("src/renderer/src/lib/use-function-turn-notices.ts"))};
      import {FunctionSite} from 'C:/ai/CmbCoworkAgent-mods-v2/src/renderer/src/components/chat/FunctionSite.tsx';
      import {FunctionMessageText} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionMessageText.tsx"))};
      { crypto.randomUUID ??= ()=>'recovery-'+Math.random().toString(16).slice(2); const cards=new Set(),configs=new Set(),calls=[],owners=new Map();
      let sequence=0, stage='render',failure='',remaining=0,hold='render',releases=[],redacted=false,action=false,hidden=false,quietAct=false,rejectAct=false,rollbackClick=false,inactiveMode=false;
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
      const gate=async(kind,detail)=>{calls.push([kind,detail,performance.now()]);if(hold===kind)await new Promise(r=>releases.push(r));if(stage===kind&&remaining>0){remaining--;throw Error(failure)}};
      window.api.mods.turnNotices=async()=>{calls.push(['notices',{},performance.now()]);return []};
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{configs.add(fn);return()=>configs.delete(fn)};
      window.api.mods.siteMountOutcome=async(thread,component)=>{const owner='owner-'+(++sequence);await gate('mount',{thread,component,owner});if(inactiveMode)return {state:'inactive'};owners.set(owner,{thread,component});return {state:'mounted',owner}};
      window.api.mods.siteUnmount=async(thread,owner)=>{calls.push(['unmount',{thread,owner},performance.now()]);owners.delete(owner)};
      window.api.mods.siteRender=async(thread,owner,props)=>{const info=owners.get(owner),copy=structuredClone(props);await gate('render',{thread,owner,text:copy.text});return {key:'engine:'+owner,id:owner,plugin:'engine',generation:'generation-'+sequence,title:info.component,rows:12,closeOnEscape:false,tree:action?{type:'Box',props:{},children:[{type:'engine',ref:0},{type:'Button',props:{key:'press',label:'Explicit action'},press:{plugin:'test',handle:1}}]}:{type:'engine',ref:0},nativeContent:{component:info.component,entries:[{ref:0,props:{...copy,text:redacted?'HOST REDACTED':copy.text}}],nativeUnchanged:!redacted}}};
      window.api.mods.siteAct=async()=>{if(quietAct){await gate('act',{});redacted=true;if(rejectAct)throw Error('action failed');return {}}calls.push(['act',{},performance.now()]);throw Error('MODS_ENTRY_EXPIRED')};
      function Fixture(){const [thread,setThread]=useState('a'),[text,setText]=useState('original'),[visible,setVisible]=useState(true),[raw,setRaw]=useState(false);useFunctionTurnNotices(thread,true);
        useLayoutEffect(()=>{if(rollbackClick){rollbackClick=false;document.querySelector('[data-role="assistant"] button')?.click()}},[text]);
        window.recovery={inactive:v=>inactiveMode=v,rollback:()=>{rollbackClick=true;setText("original")},raw:setRaw,quietAct:(reject=false)=>{quietAct=true;rejectAct=reject},calls,owners,held:()=>releases.length,remaining:()=>remaining,fail:(s,e,n)=>{stage=s;failure=e;remaining=n},emit:scope=>{for(const fn of cards)fn({threadId:thread,scope})},config:()=>{for(const fn of configs)fn()},text:setText,thread:setThread,visible:setVisible,hold:s=>hold=s,release:()=>{hold='';for(const done of releases.splice(0))done()},redact:v=>redacted=v,action:v=>action=v,hidden:v=>{hidden=v;document.dispatchEvent(new Event('visibilitychange'))},unmount:()=>host.render(null)};
        return <ModsChatScope.Provider value={{threadId:thread,enabled:true,ready:true}}>{visible&&['user','assistant'].map(role=><article key={role} data-role={role}>{raw?<FunctionSite threadId={thread} component={role==='assistant'?'AssistantMessage':'UserMessage'} facts={{text:role+' '+text}} fallback={<div><p>RAW {role} {text}</p><button onClick={()=>calls.push(['fallback-child',{}])}>Fallback child</button></div>}/>:<FunctionMessageText threadId={thread} messageId={role+'-id'} role={role} text={role+' '+text} isExpanded={true} isFirstOfReply={true} fallback={<p>RAW {role} {text}</p>} renderText={safe=><div><p>{safe}</p><button onClick={()=>calls.push(['native-child',{}])}>Native child</button><a href='#native-child' onClick={e=>{e.preventDefault();calls.push(['native-child',{}])}}>Native link</a></div>}/>}</article>)}</ModsChatScope.Provider>}
      host.render(<Fixture/>); }
    `,
      [browserWorkerPlugin()]
    )
    const visible = async (suffix = "original") => {
      await page.getByText(`user ${suffix}`, { exact: true }).waitFor()
      await page.getByText(`assistant ${suffix}`, { exact: true }).waitFor()
    }
    const reads = () =>
      page.evaluate(
        "window.recovery.calls.filter(c=>c[0]==='mount'||c[0]==='render').length"
      ) as Promise<number>
    await page.waitForFunction("window.recovery.held()===2")
    assert.equal(await page.getByRole("status").count(), 0,
      "ordinary initial reads must not immediately announce recovery on every message")
    assert.equal(await page.getByText(/RAW /).count(), 0)
    assert.equal(await page.locator("[data-function-site-pending]").count(), 2)
    await page.waitForTimeout(1400)
    assert.equal(await page.getByRole("status").count(), 0)
    assert.equal(await page.getByText(/正在(?:刷新|更新)显示/).count(), 0)
    assert.equal(await page.getByText(/RAW /).count(), 0)
    await page.getByText("内容加载较慢，请稍候…", { exact: true }).first().waitFor()
    assert.equal(await page.getByText("正在重新读取安全界面…", { exact: true }).count(), 0)
    await page.evaluate("window.recovery.release()")
    await visible()
    pass("initial reads use neutral placeholders without refresh text or raw fallback; genuinely slow reads remain visible")
    await page.evaluate("window.recovery.inactive(true);window.recovery.raw(true);window.recovery.config()")
    const inactiveButton = page.locator('[data-role="assistant"]').getByRole("button", { name: "Fallback child" })
    await inactiveButton.click()
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='fallback-child').length"), 1)
    await page.evaluate("window.recovery.hidden(true);document.querySelector('[data-role=assistant] button').click();window.recovery.hidden(false)")
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='fallback-child').length"), 1)
    await page.evaluate("const button=document.querySelector('[data-role=assistant] button');window.recovery.inactive(false);window.recovery.config();button.click()")
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='fallback-child').length"), 1)
    await page.evaluate("window.recovery.raw(false)")
    await visible()
    pass("current inactive fallback accepts native controls but its revoked cached DOM cannot act")
    await page.evaluate("window.recovery.action(true);window.recovery.emit()")
    await page.getByRole("button", { name: "Explicit action" }).last().waitFor()
    const beforeAppendActions = await page.evaluate("window.recovery.calls.filter(c=>c[0]==='act').length")
    await page.evaluate("window.recovery.hold('render');window.recovery.text('original appended')")
    await page.waitForFunction("window.recovery.held()===2")
    assert.equal(await page.getByText("assistant original", { exact: true }).count(), 1)
    assert.equal(await page.getByText("assistant original appended", { exact: true }).count(), 0)
    assert.equal(await page.getByText("user original", { exact: true }).count(), 0)
    const retained = page.locator('[data-role="assistant"] [inert]')
    assert.equal(await retained.count(), 1)
    for (const control of [retained.getByRole("button", { name: "Native child" }), retained.getByRole("link", { name: "Native link" })]) {
      const box = await control.boundingBox()
      assert(box)
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
    await retained.getByRole("button", { name: "Native child" }).dispatchEvent("click")
    await retained.getByRole("link", { name: "Native link" }).dispatchEvent("click")
    await retained.getByRole("button", { name: "Native child" }).evaluate(node => (node as HTMLButtonElement).focus())
    assert.equal(await retained.evaluate(node => node.contains(document.activeElement)), false)
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='native-child').length"), 0)
    await page.getByRole("button", { name: "Explicit action" }).dispatchEvent("click")
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='act').length"), beforeAppendActions)
    await page.evaluate("window.recovery.rollback()")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='native-child').length"), 0,
      "returning to an old input key must not reactivate its old protected subtree before a fresh read")
    await page.evaluate("window.recovery.text('original appended')")
    await page.evaluate("window.recovery.emit('site-invalidated:'+Array.from(window.recovery.owners.entries()).find(([,v])=>v.component==='AssistantMessage')[0])")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
    assert.equal(await page.getByText("assistant original", { exact: true }).count(), 0)
    await page.evaluate("window.recovery.release()")
    await visible("original appended")
    await page.evaluate("window.recovery.action(false);window.recovery.text('original')")
    await visible()
    pass("assistant appends retain only protected prior text with actions disabled; targeted revocation still clears immediately")
    await page.evaluate("window.recovery.raw(true)")
    await page.getByText("RAW assistant original", { exact: true }).waitFor()
    await page.evaluate("window.recovery.hold('render');window.recovery.text('original appended')")
    await page.waitForFunction("window.recovery.held()===2")
    assert.equal(await page.getByText(/RAW /).count(), 0)
    await page.evaluate("window.recovery.release()")
    await page.getByText("RAW assistant original appended", { exact: true }).waitFor()
    await page.evaluate("window.recovery.raw(false);window.recovery.text('original')")
    await visible()
    pass("nativeUnchanged without renderNative never exposes a new raw fallback during append")
    await page.evaluate("window.recovery.action(true);window.recovery.emit()")
    await page.getByRole("button", { name: "Explicit action" }).last().waitFor()
    const cachedAction = await page.getByRole("button", { name: "Explicit action" }).last().elementHandle()
    const beforeExpiredActions = await page.evaluate("window.recovery.calls.filter(c=>c[0]==='act').length")
    const beforeExpiredMounts = await page.evaluate("window.recovery.calls.filter(c=>c[0]==='mount').length")
    await page.evaluate("window.recovery.fail('render','MODS_RUNTIME_INSTANCE_EXPIRED',1);window.recovery.emit('site:'+Array.from(window.recovery.owners.entries()).find(([,v])=>v.component==='AssistantMessage')[0])")
    await page.waitForFunction("window.recovery.remaining()===0")
    await page.evaluate("window.recovery.hold('render')")
    await page.waitForFunction("window.recovery.held()>0")
    assert.equal(await page.getByText("assistant original", { exact: true }).count(), 0)
    await cachedAction!.dispatchEvent("click")
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='act').length"), beforeExpiredActions)
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='mount').length"), beforeExpiredMounts)
    await page.evaluate("window.recovery.release();window.recovery.action(false)")
    await visible()
    pass("same-input runtime expiry revokes cached controls while reusing the owner for a fresh read")
    const beforeRecords = await reads()
    const beforeNotices = await page.evaluate("window.recovery.calls.filter(c=>c[0]==='notices').length")
    await page.evaluate("window.recovery.hold('render');for(let i=0;i<40;i++)window.recovery.emit('records')")
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("user original", { exact: true }).count(), 1)
    assert.equal(await reads(), beforeRecords)
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='notices').length"), beforeNotices + 40)
    await page.evaluate("window.recovery.release()")
    pass("record notifications update the real notices reader without clearing or querying message drawings")
    const beforeScoped = await reads()
    const beforeScopedMounts = await page.evaluate("window.recovery.calls.filter(c=>c[0]==='mount').length")
    await page.evaluate("window.recovery.hold('render');window.recovery.emit('site-invalidated:unrelated')")
    await page.waitForTimeout(50)
    assert.equal(await reads(), beforeScoped)
    await visible()
    await page.evaluate("window.recovery.emit('site-invalidated:'+Array.from(window.recovery.owners.entries()).find(([,v])=>v.component==='AssistantMessage')[0])")
    await page.waitForFunction("window.recovery.held()===1")
    assert.equal(await page.getByText("assistant original", { exact: true }).count(), 0)
    assert.equal(await page.getByText("user original", { exact: true }).count(), 1)
    await page.getByRole("status").waitFor()
    assert.equal(await page.getByText(/RAW /).count(), 0)
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='mount').length"), beforeScopedMounts)
    await page.evaluate("window.recovery.release()")
    await visible()
    pass("targeted invalidation immediately revokes only its owner and retains unrelated authorized bodies")
    const mountsBeforeFacts = await page.evaluate("window.recovery.calls.filter(c=>c[0]==='mount').length")
    await page.evaluate("window.recovery.hold('render');window.recovery.text('first update')")
    await page.waitForFunction("window.recovery.held()===2")
    assert.equal(await page.getByRole("status").count(), 0)
    assert.equal(await page.getByText(/user original|assistant original|RAW /).count(), 0)
    await page.evaluate("window.recovery.text('latest update')")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    await page.evaluate("window.recovery.release()")
    await visible("latest update")
    assert.equal(await page.getByText(/user first update|assistant first update/).count(), 0)
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='mount').length"), mountsBeforeFacts,
      "pure facts changes must reuse the mounted owner")
    pass("facts updates reuse owners, coalesce deferred reads and never publish an obsolete body")
    await page.evaluate("window.recovery.text('original')")
    await visible()
    for (const stage of ["mount", "render"]) {
      for (const code of [
        "MODS_DEVELOPMENT_APPLYING",
        "MODS_ENTRY_EXPIRED",
        "MODS_RUNTIME_INSTANCE_EXPIRED",
        "MODS_UI_DRAWING_STALE",
        "MODS_UI_SITE_CLOSED",
        "MODS_SESSION_CLOSED"
      ]) {
        await page.evaluate(
          ({ stage, code }) => {
            const r = (window as RecoveryFixtureWindow).recovery
            r.fail(stage, code, 2)
            stage === "mount" ? r.config() : r.emit()
          },
          { stage, code }
        )
        await page.waitForFunction("window.recovery.remaining()===0")
        await visible()
        assert.equal(await page.getByText(/RAW /).count(), 0)
        pass(`${stage} ${code}: both bodies recover without another event or click`)
      }
    }
    const beforeBounded = await reads()
    await page.evaluate(
      "window.recovery.fail('mount','MODS_UI_SITE_CLOSED',999);window.recovery.config()"
    )
    await page.getByRole("button", { name: "重新读取界面" }).first().waitFor({ timeout: 15000 })
    const bounded = await reads()
    assert.equal(bounded - beforeBounded, 10, "two sites each get initial mount plus four retries")
    await page.waitForTimeout(2500)
    assert.equal(await reads(), bounded)
    pass("persistent CLOSED exhausts autonomous retries and stops reading")
    await page.screenshot({ path: resolve(output, "bounded-retry.png") })
    await page.evaluate("window.recovery.fail('mount','',0);window.recovery.emit()")
    await visible()
    pass("activation broadcast recovers an exhausted episode without any click")
    await page.evaluate(
      "window.recovery.fail('render','MODS_ENTRY_EXPIRED',999);window.recovery.config()"
    )
    await page.getByRole("button", { name: "重新读取界面" }).first().waitFor({ timeout: 15000 })
    await page.evaluate("window.recovery.fail('render','',0)")
    for (const role of ["user", "assistant"])
      await page
        .locator(`[data-role=${role}]`)
        .getByRole("button", { name: "重新读取界面" })
        .click()
    await visible()
    pass("explicit retry repairs each exhausted site using only fresh reads")
    await page.evaluate(
      "window.recovery.redact(true);window.recovery.fail('render','MODS_SCOPE_CHANGED',999);window.recovery.emit()"
    )
    await page.getByRole("alert").first().waitFor()
    const permanent = await reads()
    await page.waitForTimeout(600)
    assert.equal(await reads(), permanent)
    assert.equal(await page.getByText(/RAW |user original|assistant original/).count(), 0)
    await page.evaluate("window.recovery.fail('render','',0);window.recovery.emit()")
    await page.getByText("HOST REDACTED", { exact: true }).first().waitFor()
    assert.equal(await page.getByText(/RAW /).count(), 0)
    pass(
      "scope refusal never auto-retries or publishes raw fallback; fresh redacted content is honored"
    )
    await page.evaluate(
      "window.recovery.redact(false);window.recovery.fail('render','MODS_ENTRY_EXPIRED',999);window.recovery.config()"
    )
    await page.getByRole("button", { name: "重新读取界面" }).first().waitFor({ timeout: 15000 })
    const stormStart = await reads()
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        ;(window as RecoveryFixtureWindow).recovery.emit()
        await new Promise((r) => setTimeout(r, 25))
      }
    })
    await page.waitForTimeout(500)
    assert(
      (await reads()) - stormStart <= 20,
      "two sites' mount+render notifications must be throttled"
    )
    const stormEnd = await reads()
    await page.waitForTimeout(2300)
    assert.equal(await reads(), stormEnd)
    pass("notification storm coalesces limited reads without replenishing timer credit")
    await page.evaluate("window.recovery.fail('render','',0);window.recovery.config()")
    await visible()
    await page.waitForTimeout(250)
    const idleBefore = await reads()
    const idleOwners = await page.evaluate("Array.from(window.recovery.owners.keys())")
    await page.evaluate("window.recovery.hidden(true)")
    await page.waitForTimeout(400)
    await visible()
    await page.evaluate("window.recovery.hidden(false)")
    await visible()
    await page.waitForTimeout(450)
    assert.equal(await reads(), idleBefore, "idle visibility must not remount or redraw authorized messages")
    assert.deepEqual(await page.evaluate("Array.from(window.recovery.owners.keys())"), idleOwners)
    assert.equal(await page.getByRole("status").count(), 0)
    pass("idle hide and restore preserve current authorized message frames with zero rereads")
    await page.evaluate("window.recovery.hidden(true);window.recovery.text('hidden input')")
    await page.waitForFunction("!document.body.textContent.includes('user original')")
    const hiddenInputReads = await reads()
    await page.waitForTimeout(400)
    assert.equal(await reads(), hiddenInputReads)
    await page.evaluate("window.recovery.hidden(false)")
    await visible("hidden input")
    await page.evaluate("window.recovery.text('original')")
    await visible()
    pass("facts changed while hidden revoke prior frames and resume only the new input")
    await page.evaluate(
      "window.recovery.hidden(true);window.recovery.emit();window.recovery.config()"
    )
    await page.waitForFunction("!document.querySelector('[data-function-site] button') && !document.body.textContent.includes('user original')")
    const hiddenCount = await reads()
    await page.waitForTimeout(600)
    assert.equal(await reads(), hiddenCount)
    await page.evaluate("window.recovery.fail('render','',0);window.recovery.hidden(false)")
    await visible()
    pass("hidden document blocks notification/config reads and resumes fresh on visibility")
    await page.evaluate("window.recovery.action(true);window.recovery.emit()")
    await page.getByRole("button", { name: "Explicit action" }).first().waitFor()
    const hiddenAction = await page.evaluate(() => {
      const r = (window as unknown as { recovery: {
        hidden(value: boolean): void
        calls: unknown[][]
        owners: Map<string, unknown>
      } }).recovery
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .filter((button) => button.textContent === "Explicit action")
      const before = r.calls.filter((call) => call[0] === "act").length
      r.hidden(true)
      // Exercise cached DOM handlers synchronously, before React removes the old tree.
      for (const button of buttons) button.click()
      return { before, after: r.calls.filter((call) => call[0] === "act").length, owners: r.owners.size }
    })
    assert.equal(hiddenAction.after, hiddenAction.before)
    assert.equal(hiddenAction.owners, 2)
    const hiddenActionReads = await reads()
    await page.evaluate("window.recovery.hidden(false)")
    await page.waitForTimeout(450)
    assert.equal(await reads(), hiddenActionReads)
    assert.equal(await page.getByRole("status").count(), 0,
      "visibility resume must not immediately announce per-message recovery")
    assert.equal(await page.getByText(/RAW /).count(), 0)
    await page.evaluate("window.recovery.release()")
    await visible()
    await page.evaluate("window.recovery.action(false);window.recovery.emit()")
    await page.waitForFunction("!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Explicit action')")
    await visible()
    pass("hide blocks cached actions synchronously while retaining authorized owners and frames")
    await page.evaluate("window.recovery.hold('render');window.recovery.emit()")
    await page.waitForFunction("window.recovery.held()===2")
    await page.evaluate("window.recovery.hidden(true);window.recovery.release()")
    await page.waitForTimeout(200)
    assert.equal(await page.getByText(/user original|assistant original/).count(), 0)
    const hiddenLate = await reads()
    await page.waitForTimeout(500)
    assert.equal(await reads(), hiddenLate)
    await page.evaluate("window.recovery.hidden(false)")
    await visible()
    pass("hidden in-flight responses cannot publish and make no follow-up reads")
    await page.evaluate(
      "window.recovery.fail('render','MODS_ENTRY_EXPIRED',999);window.recovery.emit()"
    )
    await page.locator("[data-function-site-pending]").first().waitFor({ state: "attached" })
    await page.evaluate("window.recovery.fail('render','',0);window.recovery.text('timer input')")
    await visible("timer input")
    pass("input change cancels an old delayed read and requests current facts")
    await page.evaluate("window.recovery.hold('render');window.recovery.emit()")
    await page.waitForFunction("window.recovery.held()===2")
    await page.evaluate("window.recovery.text('new input');window.recovery.release()")
    await visible("new input")
    assert.equal(await page.getByText(/user timer input|assistant timer input/).count(), 0)
    pass("input replacement invalidates a deferred old render")
    await page.evaluate("window.recovery.hold('mount');window.recovery.config()")
    await page.waitForFunction("window.recovery.held()===2")
    const oldOwners = (await page.evaluate(
      "window.recovery.calls.filter(c=>c[0]==='mount').slice(-2).map(c=>c[1].owner)"
    )) as string[]
    await page.evaluate(
      "window.recovery.thread('b');window.recovery.text('thread B');window.recovery.release()"
    )
    await visible("thread B")
    for (const owner of oldOwners)
      assert(
        await page.evaluate((owner) => {
          const r = (window as RecoveryFixtureWindow).recovery
          return (
            !r.owners.has(owner) && r.calls.some((c) => c[0] === "unmount" && c[1].owner === owner)
          )
        }, owner)
      )
    pass("thread replacement discards late old mount tokens and publishes only B")
    await page.evaluate("window.recovery.action(true);window.recovery.emit()")
    await page.getByRole("button", { name: "Explicit action" }).first().click()
    await page.waitForTimeout(700)
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='act').length"), 1)
    pass("failed explicit action is never replayed by read recovery")
    await page.getByRole("button", { name: "Explicit action" }).first().waitFor()
    await page.evaluate("window.recovery.quietAct();window.recovery.hold('act')")
    await page.getByRole("button", { name: "Explicit action" }).first().click()
    await page.waitForFunction("window.recovery.held()===1")
    await page.evaluate("window.recovery.hidden(true);window.recovery.release()")
    const hiddenActReads = await reads()
    await page.waitForTimeout(150)
    assert.equal(await reads(), hiddenActReads)
    await page.evaluate("window.recovery.hidden(false)")
    await page.getByText("HOST REDACTED", { exact: true }).first().waitFor()
    assert.equal(await page.evaluate("window.recovery.calls.filter(c=>c[0]==='act').length"), 2)
    pass("native action completed while hidden refreshes on restore without a notification or replay")
    await page.evaluate("window.recovery.quietAct(true);window.recovery.hold('act')")
    await page.getByRole("button", { name: "Explicit action" }).first().click()
    await page.waitForFunction("window.recovery.held()===1")
    await page.evaluate("window.recovery.hidden(true);window.recovery.release()")
    const hiddenRejectReads = await reads()
    await page.waitForTimeout(150)
    assert.equal(await reads(), hiddenRejectReads)
    await page.evaluate("window.recovery.hidden(false)")
    await page.waitForFunction("window.recovery.calls.filter(c=>c[0]==='act').length===3")
    await page.waitForTimeout(250)
    assert.equal(await reads(), hiddenRejectReads + 1)
    assert.equal(await page.getByRole("alert").count(), 0)
    pass("native action rejected while hidden defers a recovery read without replay or hidden error UI")
    await page.evaluate(
      "window.recovery.fail('render','MODS_DEVELOPMENT_APPLYING',999);window.recovery.emit()"
    )
    await page.locator("[data-function-site-pending]").first().waitFor({ state: "attached" })
    await page.evaluate("window.recovery.unmount()")
    const unmounted = await reads()
    await page.waitForTimeout(2500)
    assert.equal(await reads(), unmounted)
    pass("unmount cancels delayed recovery")
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "result.json"), JSON.stringify({ checks, errors }, null, 2))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
