/** Real React/Virtuoso + production Mod renderer; controlled public IPC, no model request. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import type { FunctionPlacedAnchor } from "../src/shared/mods/v2/placed"

declare global {
  interface Window {
    placedSettling?: { key: string; since: number }
    placedFixture: {
      ops: Array<[string, ...unknown[]]>
      place(id: string, anchor: FunctionPlacedAnchor): string
      first(): void
      next(): void
      refresh(): void
      holdRead(): void
      finishRead(): void
      holdAct(): void
      finishAct(): void
      replace(): string
      history(): void
      jump(index: number): void
      reveal(): void
      permission(enabled: boolean): void
      restart(): void
    }
  }
}

async function main() {
  const output = resolve("output/mods-placed-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (check: string) => {
    checks.push(check)
    console.log("PASS " + check)
  }
  try {
    await mount(
      page,
      `
      import {useLayoutEffect} from 'react';
      import {ChatMessageVirtualList} from './src/renderer/src/components/chat/ChatMessageVirtualList';
      import {useFunctionPlacedRows} from './src/renderer/src/lib/use-function-placed-rows';
      import {useFunctionDesktop} from './src/renderer/src/lib/use-function-desktop';
      import {ModsChatScope,useModsChatState} from './src/renderer/src/lib/mods-chat-scope';
      {if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>{const b=crypto.getRandomValues(new Uint8Array(16));return [...b].map(v=>v.toString(16).padStart(2,'0')).join('-')}});
      const listeners=new Set(),configuration=new Set(),ops=[],rows=new Map(),leases=new Map();
      let sequence=0,count=0,generation=0,enabled=true,holdRead=false,resolveRead,holdAct=false,resolveAct,setMessages,jump;
      const emit=()=>{for(const fn of listeners)fn({threadId:'a',scope:'placed'})};
      const drawing=row=>({key:'engine:'+row.requestId,id:row.requestId,plugin:'engine',title:'cards',generation:'generation-'+generation,
        closeOnEscape:false,rows:12,tree:{type:'Box',props:{flexDirection:'column',gap:1,width:'100%',minWidth:0},children:[
          {type:'Text',props:{},children:['卡片 '+row.id+'：'+count]},
          {type:'Text',props:{},children:['可读长文本。'.repeat(60)]},
          {type:'Button',props:{key:'add',label:'卡片加一'},press:{plugin:'cards',handle:1}}]}});
      const place=(id,anchor)=>{const prior=[...rows.values()].find(r=>r.id===id);if(prior){generation++;emit();return prior.requestId}
        const row={requestId:'placed-'+(++sequence),id,plugin:'cards',sequence,anchor};rows.set(row.requestId,row);emit();return row.requestId};
      Object.assign(window.api.mods,{
        chatDisplayCapability:async()=>enabled,onConfigurationChanged:fn=>{configuration.add(fn);return()=>configuration.delete(fn)},
        onCardsChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        desktopAttach:async(t,o)=>{ops.push(['attach',o])},desktopDetach:async()=>{},onDesktopRequest:()=>()=>{},desktopFeedback:undefined,
        placedRows:async()=>[...rows.values()],
        placedRevealAck:async(t,o,ack)=>{const row=rows.get(ack.requestId);if(!row||row.reveal?.id!==ack.receipt)throw Error('stale reveal');
          if(ack.allowed&&(!leases.has(row.requestId)||leases.get(row.requestId)!==ack.lease))throw Error('stale lease');ops.push(['revealAck',ack]);delete row.reveal;emit()},
        placedRead:async(t,o,id,lease)=>{const row=rows.get(id);if(!row)throw Error('stale');leases.set(id,lease);const result=drawing(row);ops.push(['read',id,lease]);
          if(holdRead){holdRead=false;await new Promise(resolve=>resolveRead=resolve)}return result},
        placedAct:async(t,o,id,lease,action)=>{if(!rows.has(id)||leases.get(id)!==lease)throw Error('stale');ops.push(['act',id,action.kind]);
          if(holdAct){holdAct=false;await new Promise(resolve=>resolveAct=resolve)}if(!rows.has(id))throw Error('closed');count++;generation++;emit()},
        placedDismiss:async(t,o,id)=>{ops.push(['dismiss',id]);rows.delete(id);leases.delete(id);emit()},
        placedRelease:async(t,o,id,lease)=>{ops.push(['release',id,lease]);if(leases.get(id)===lease)leases.delete(id)},
        siteMountOutcome:async()=>({state:'inactive',reason:'no-protection-or-functions'}),
        siteRead:async()=>({state:'inactive',reason:'no-protection-or-functions'})
      });
      const maps={tools:new Map(),states:new Map(),hooks:new Map(),durations:new Map(),labels:new Map()},refs=new Map(),virtual={current:null},range={current:null},noop=()=>{};
      function Fixture(){
        const state=useModsChatState('a','C:/placed-fixture'),[messages,update]=useState([]),[parent,setParent]=useState(null),root=useRef(null),viewport=useRef(null);
        setMessages=update;const placed=useFunctionPlacedRows('a',state.enabled,state.isCurrent);
        useFunctionDesktop('a',state.enabled,root,false);
        useLayoutEffect(()=>setParent(viewport.current),[]);
        jump=index=>{ops.push(['jump',index,!!virtual.current]);virtual.current?.scrollToIndex({index,align:'start',behavior:'auto'})};
        return <ModsChatScope.Provider value={{threadId:'a',...state}}><main ref={root} data-chat-thread-id='a'>
          <textarea aria-label='未发送草稿' defaultValue='原聊天草稿仍然保留'/>
          <div ref={viewport} data-test-viewport style={{height:680,overflow:'auto',overflowAnchor:'none'}}>
            <ChatMessageVirtualList functionPlacedRows={placed} messages={messages} visibleMessageIndexes={messages.map((_,i)=>i)} lastUserMessageIndex={messages.length-1}
              contentVersion={1} historyHasMore={false} historyPageLoading={false} historyRemainingCount={0} onLoadEarlierHistoryPage={noop}
              historyGapBeforeMessageId={null} canLoadReleasedHistory={false} onLoadReleasedHistoryWindow={noop} onRestoreLatestHistoryWindow={noop}
              hookLoggingEnabled={false} hookLogBucketByTurnId={maps.hooks} detachedHookLogBuckets={[]} contentMessageRefs={{current:refs}}
              setMessageRef={()=>noop} isLoading={false} toolResults={maps.tools} toolCallStates={maps.states} pendingApprovalToolCallKeys={new Set()}
              pendingApproval={null} autoApproveGitPush={false} onApprovalDecision={noop} onEditUserMessage={noop} onSetGoalFromMessage={noop}
              onForkFromMessage={noop} forkingMessageId={null} onOpenHookLogBucket={noop} threadId='a' assistantDurationMsById={maps.durations}
              userSendTimeLabelById={maps.labels} customScrollParent={parent} virtuosoRef={virtual} navigatorVirtualRangeRef={range}
              initialTopMostItemIndex={{index:'LAST',align:'end'}} onInitialVirtualItemsRendered={noop} onContentHeightChanged={noop} onAtBottomStateChange={noop} footer={null}/>
          </div></main></ModsChatScope.Provider>}
      const native=(id,text)=>({id,role:'user',content:text,created_at:new Date()});
      window.placedFixture={ops,place,id:()=>[...rows.keys()],count:()=>count,
        first:()=>setMessages([native('native-first','第一条原生消息')]),
        next:()=>setMessages(m=>[...m,native('native-second','第二条原生消息')]),
        refresh:emit,holdRead:()=>holdRead=true,finishRead:()=>resolveRead(),holdAct:()=>holdAct=true,finishAct:()=>resolveAct(),
        replace:()=>{rows.clear();leases.clear();return place('replacement',{kind:'after-message',id:'native-first',role:'user'})},
        history:()=>setMessages([...Array.from({length:70},(_,i)=>native('before-'+i,'更早消息 '+i+' 历史内容。'.repeat(80))),native('native-first','第一条原生消息'),
          ...Array.from({length:70},(_,i)=>native('after-'+i,'稍后消息 '+i+' 历史内容。'.repeat(80)))]),
        reveal:()=>{const row=[...rows.values()][0];row.reveal={id:'reveal-'+(++sequence),block:'center'};emit()},
        jump:index=>jump(index),permission:value=>{enabled=value;for(const fn of configuration)fn()},restart:()=>{rows.clear();leases.clear();emit()}};
      host.render(<Fixture/>);}
    `,
      [
        browserWorkerPlugin(),
        {
          name: "placed-assets",
          setup(builder) {
            builder.onLoad({ filter: /\.png$/ }, (args) => ({
              contents: readFileSync(args.path),
              loader: "dataurl"
            }))
            builder.initialOptions.define = {
              ...builder.initialOptions.define,
              "import.meta.hot": "undefined"
            }
          }
        }
      ]
    )
    const renderer = resolve("src/renderer/src")
    const css = await compile(readFileSync(resolve(renderer, "index.css"), "utf8"), {
      base: renderer,
      onDependency: () => {}
    })
    const scanner = new Scanner({})
    const files: string[] = []
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) collect(file)
        else if (/\.[jt]sx?$/.test(entry.name)) files.push(file)
      }
    }
    collect(renderer)
    const candidates = scanner.scanFiles(
      files.map((file) => ({ content: readFileSync(file, "utf8"), extension: "tsx" }))
    )
    await page.addStyleTag({ content: css.build(candidates) })
    await page.waitForFunction(() => window.placedFixture.ops.some((op) => op[0] === "attach"))
    await page.evaluate(() => window.placedFixture.place("start", { kind: "start" }))
    await page.getByText("卡片 start：0", { exact: true }).waitFor()
    await page.evaluate(() => window.placedFixture.first())
    await page.getByText("第一条原生消息", { exact: true }).first().waitFor()
    assert(
      await page.evaluate(() => {
        const card = document.querySelector("[data-function-placed]")!,
          message = [...document.querySelectorAll("*")].find(
            (e) => !e.children.length && e.textContent === "第一条原生消息"
          )!
        return Boolean(card.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING)
      })
    )
    pass("empty start row remains before the first real message")
    await page.evaluate(() =>
      window.placedFixture.place("after", {
        kind: "after-message",
        id: "native-first",
        role: "user"
      })
    )
    await page.getByText("卡片 after：0", { exact: true }).waitFor()
    await page.evaluate(() => window.placedFixture.next())
    await page.getByText("第二条原生消息", { exact: true }).first().waitFor()
    assert(
      await page.evaluate(() => {
        const card = [...document.querySelectorAll("[data-function-placed]")].find((e) =>
            e.textContent?.includes("卡片 after")
          )!,
          message = [...document.querySelectorAll("*")].find(
            (e) => !e.children.length && e.textContent === "第二条原生消息"
          )!
        return Boolean(card.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING)
      })
    )
    const after = page.locator("[data-function-placed]").filter({ hasText: "卡片 after" })
    await page.evaluate(() => window.placedFixture.holdAct())
    await after.getByRole("button", { name: "卡片加一" }).evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await page.waitForFunction(
      () => window.placedFixture.ops.filter((op) => op[0] === "act").length === 1
    )
    await after.getByRole("button", { name: "关闭插件卡片" }).click()
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("[data-function-placed]")].some((e) =>
          e.textContent?.includes("卡片 after")
        )
    )
    await page.evaluate(() => window.placedFixture.finishAct())
    assert.equal(
      await page.getByRole("textbox", { name: "未发送草稿" }).inputValue(),
      "原聊天草稿仍然保留"
    )
    pass(
      "new messages follow the card; double click runs once; host close works while an action waits and keeps the draft"
    )
    await page.evaluate(() => {
      window.placedFixture.holdRead()
      window.placedFixture.refresh()
    })
    await page.waitForFunction(
      () => window.placedFixture.ops.filter((op) => op[0] === "read").length > 2
    )
    const heldReadCount = await page.evaluate(() =>
      window.placedFixture.ops.filter(op => op[0] === "read").length)
    await page.evaluate(() => { for (let i = 0; i < 40; i++) window.placedFixture.refresh() })
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.placedFixture.ops.filter(op => op[0] === "read").length),
      heldReadCount, "placed redraw bursts must wait for the one active read")
    await page.evaluate(() => window.placedFixture.replace())
    await page.getByText("卡片 replacement：0", { exact: true }).waitFor()
    await page.evaluate(() => window.placedFixture.finishRead())
    assert.equal(await page.locator("[data-function-placed]").count(), 1)
    pass("a late old drawing cannot overwrite a replacement row of the same source")
    await page.evaluate(() => window.placedFixture.history())
    await page.evaluate(() => window.placedFixture.jump(140))
    await page.waitForFunction(() => !document.querySelector("[data-function-placed]"))
    // A new data window is still completing Virtuoso's initial LAST placement and row sizing.
    await page.waitForFunction(
      () => {
        const viewport = document.querySelector("[data-test-viewport]")!
        const key = [
          viewport.scrollTop,
          viewport.scrollHeight,
          [...document.querySelectorAll("[data-index]")]
            .map((e) => e.getAttribute("data-index"))
            .join(",")
        ].join(":")
        const old = window.placedSettling
        window.placedSettling = {
          key,
          since: old?.key === key ? old.since : performance.now()
        }
        return old?.key === key && performance.now() - old.since > 250
      },
      { timeout: 10000 },
      { polling: "raf" }
    )
    await page.locator("[data-test-viewport]").hover()
    await page.mouse.wheel(0, -1)
    await page.evaluate(() => window.placedFixture.reveal())
    await page.waitForFunction(() => window.placedFixture.ops.some(op =>
      op[0] === "revealAck" && (op[1] as { allowed: boolean }).allowed))
    await page.getByText("卡片 replacement：0", { exact: true }).waitFor()
    pass("own requestId reveals an offscreen resident row and returns a real mounted lease/generation acknowledgement")
    await page.locator("[data-function-placed]").getByRole("button", { name: "卡片加一" }).click()
    await page.getByText("卡片 replacement：1", { exact: true }).waitFor()
    pass("real Virtuoso recycles and redraws the original row; its new lease remains interactive")
    await page.setViewportSize({ width: 375, height: 850 })
    const card = page.locator("[data-function-placed]")
    await card.scrollIntoViewIfNeeded()
    assert(await card.getByRole("button", { name: "关闭插件卡片" }).isVisible())
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )
    )
    await page.screenshot({ path: resolve(output, "placed-narrow.png"), fullPage: true })
    await page.evaluate(() => window.placedFixture.permission(false))
    await page.waitForFunction(() => !document.querySelector("[data-function-placed]"))
    await page.evaluate(() => {
      window.placedFixture.restart()
      window.placedFixture.permission(true)
    })
    await page.waitForTimeout(150)
    assert.equal(await page.locator("[data-function-placed]").count(), 0)
    pass("375px host controls remain reachable; revoke hides cards and restart restores none")
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          checks,
          pageErrors: errors,
          scope:
            "real React/Virtuoso + controlled public IPC; VM and native SQLite tested separately"
        },
        null,
        2
      )
    )
  } catch (error) {
    writeFileSync(
      resolve(output, "failure.txt"),
      String(error) +
        "\n" +
        JSON.stringify(errors) +
        "\n" +
        JSON.stringify(
          await page.evaluate(() => ({
            ops: window.placedFixture.ops.slice(-12),
            scroll: document.querySelector("[data-test-viewport]")?.scrollTop,
            indices: [...document.querySelectorAll("[data-index]")].map((e) =>
              e.getAttribute("data-index")
            )
          }))
        ) +
        "\n" +
        (await page.locator("body").innerText())
    )
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
