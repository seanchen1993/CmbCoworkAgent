/** Real Radix thumb + Virtuoso layout; controlled bubble heights isolate window identity/geometry. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface LayoutSnapshot {
  frames: number
  emptyFrames: number
  visibleEmptyFrames: number
  maxMountedRows: number
  mounts: number
  unmounts: number
  anomalies: unknown[]
}

async function main() {
  const output = resolve(
    process.env.CHAT_VIRTUAL_LAYOUT_OUTPUT_DIR ?? "output/chat-virtual-history-layout"
  )
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{useEffect,useLayoutEffect,useRef,useState}from'react';
      import{createRoot}from'react-dom/client';
      import{ChatMessageVirtualList}from'./src/renderer/src/components/chat/ChatMessageVirtualList';
      import{isChatRowPresented}from'./src/renderer/src/components/chat/chat-row-presentation';
      import{ScrollArea}from'./src/renderer/src/components/ui/scroll-area';
      const noop=()=>{},refs={current:new Map()},virtual={current:null},range={current:null},maps=new Map();
      window.layoutDetached=false;window.layoutAnchorLease=0;
      const readLease=()=>window.layoutDetached?window.layoutAnchorLease:null;
      let phase='initial';
      const counters={mounts:0,unmounts:0,frames:0,emptyFrames:0,visibleEmptyFrames:0,maxMountedRows:0,anomalies:[],trace:[]};window.layoutCounters=counters;
      const make=(start,count,tall=false)=>Array.from({length:count},(_,i)=>({id:'row-'+(start+i),
        role:i%2?'assistant':'user',content:String(tall?820:[90,950,160,620,55][i%5])}));
      function Fixture(){
        const[messages,setMessages]=useState(()=>make(0,400)),[thread,setThread]=useState('one'),[parent,setParent]=useState(null),root=useRef(null);
        window.layoutMessageCount=messages.length;
        useLayoutEffect(()=>setParent(root.current.querySelector('[data-radix-scroll-area-viewport]')),[]);
        useEffect(()=>{let frame;const sample=time=>{counters.frames++;
          const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]'),box=viewport.getBoundingClientRect();
          const rows=[...viewport.querySelectorAll('[data-chat-message-id]')];
          const rects=rows.map(row=>{const rect=row.getBoundingClientRect();return{
            id:row.dataset.chatMessageId,top:rect.top,bottom:rect.bottom,height:rect.height,
            index:row.closest('[data-item-index]')?.getAttribute('data-item-index')}});
          counters.maxMountedRows=Math.max(counters.maxMountedRows,rows.length);
          const intersects=rects.some(rect=>rect.bottom>box.top&&rect.top<box.bottom);
          const presentation=viewport.querySelector('[data-chat-initial-presentation]');
          const list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
          counters.trace.push({phase,time,scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,listStyle:list?.getAttribute('style'),rows:rects});
          if(counters.trace.length>18)counters.trace.shift();
          if(rows.length&&!intersects)counters.emptyFrames++;
          const visible=document.visibilityState==='visible'&&box.width>0&&box.height>0&&
            presentation?.getAttribute('data-chat-initial-presentation')==='ready'&&
            getComputedStyle(viewport).visibility!=='hidden';
          if(visible&&window.layoutMessageCount>0&&!intersects)counters.visibleEmptyFrames++;
          if(window.layoutMessageCount>0&&!intersects&&counters.anomalies.length<80)counters.anomalies.push({
            phase,time,frame:counters.frames,visible,scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,
            viewport:{top:box.top,bottom:box.bottom,height:box.height},presentation:presentation?.outerHTML.slice(0,450),
            listStyle:list?.getAttribute('style'),rows:rects});
          frame=requestAnimationFrame(sample)};frame=requestAnimationFrame(sample);return()=>cancelAnimationFrame(frame)},[]);
        window.layoutFixture={
          phase:value=>{phase=value},
          rowPresented:()=>{const row=root.current.querySelector('[data-chat-message-row]');return !!row&&isChatRowPresented(row)},
          jump:index=>virtual.current.scrollToIndex({index,align:'start',behavior:'auto'}),
          position:index=>new Promise(done=>virtual.current.scrollIntoView({index,align:'start',behavior:'auto',
            calculateViewLocation:()=>({index,align:'start',behavior:'auto'}),done})),
          last:()=>virtual.current.scrollToIndex({index:'LAST',align:'end',behavior:'auto'}),
          prepend:()=>setMessages(old=>[...make(-25,25),...old]),
          release:()=>setMessages(old=>old.slice(20)),
          replace:()=>setMessages(make(1000,120)),
          historical:()=>setMessages([...make(0,872),...make(1680,320)]),
          latest:()=>setMessages(make(1500,500)),
          short:()=>setMessages(make(0,400).map(message=>({...message,content:'100'}))),
          promotionWindow:()=>{setThread('pending-promotion');setMessages(make(0,400).map(message=>({...message,content:'100'})))},
          materializationWindow:()=>{setThread('delayed-range');setMessages(make(0,400).map(message=>({...message,content:'100'})))},
          hideRows:()=>{
            const style=document.createElement('style');
            style.textContent='[data-chat-message-row]{display:none!important}';
            document.head.appendChild(style);window.delayedRangeStyle=style;
          },
          showRows:()=>{
            window.delayedRangeStyle.remove();
            root.current.querySelector('[data-chat-message-row]')?.classList.add('materialized');
          },
          pendingAll:()=>{
            const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]');
            const top=viewport.getBoundingClientRect().top;
            const rows=[...viewport.querySelectorAll('[data-chat-message-row]')];
            window.promotionPendingId=rows.find(row=>row.getBoundingClientRect().bottom>top).dataset.chatMessageId;
            rows.forEach(row=>row.firstElementChild.setAttribute('data-function-site-pending',''));
          },
          readyBeforePending:async delta=>{
            const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]');
            const top=viewport.getBoundingClientRect().top;
            const rows=[...viewport.querySelectorAll('[data-chat-message-row]')];
            const index=rows.findIndex(row=>row.dataset.chatMessageId===window.promotionPendingId);
            const row=rows[index-1],bubble=row.firstElementChild;
            const before={id:row.dataset.chatMessageId,top:row.getBoundingClientRect().top-top};
            bubble.style.height=(bubble.getBoundingClientRect().height+delta)+'px';
            bubble.removeAttribute('data-function-site-pending');
            bubble.setAttribute('aria-busy','true');
            // Deliver the content mutation before its measurement/scroll transaction.
            await Promise.resolve();
            viewport.dispatchEvent(new Event('scroll'));
            viewport.scrollTop+=delta;return before;
          },
          readyOriginalPending:delta=>{
            const row=[...root.current.querySelectorAll('[data-chat-message-row]')]
              .find(row=>row.dataset.chatMessageId===window.promotionPendingId);
            if(!row)throw Error('Pending B should still be mounted in overscan');
            const bubble=row.firstElementChild;
            bubble.style.height=(bubble.getBoundingClientRect().height+delta)+'px';
            bubble.removeAttribute('data-function-site-pending');
          },
          anchor:enabled=>{window.layoutDetached=!!enabled;window.layoutAnchorLease++},
          growAbove:delta=>{
            const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]');
            const bounds=viewport.getBoundingClientRect();
            const rows=[...viewport.querySelectorAll('[data-chat-message-row]')];
            const index=rows.findIndex(row=>row.getBoundingClientRect().bottom>bounds.top);
            if(index<1)throw Error('Fixture requires an overscan row before its visible anchor');
            const bubble=rows[index-1].firstElementChild;
            bubble.style.height=(bubble.getBoundingClientRect().height+delta)+'px';
          },
          pendingFirst:()=>{
            const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]');
            const top=viewport.getBoundingClientRect().top;
            const row=[...viewport.querySelectorAll('[data-chat-message-row]')]
              .find(row=>row.getBoundingClientRect().bottom>top);
            row.firstElementChild.setAttribute('data-function-site-pending','');
          },
          growPending:delta=>{
            const bubble=root.current.querySelector('[data-function-site-pending]');
            bubble.style.height=(bubble.getBoundingClientRect().height+delta)+'px';
          },
          equalHeightChange:delta=>{
            const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]');
            const top=viewport.getBoundingClientRect().top;
            const rows=[...viewport.querySelectorAll('[data-chat-message-row]')];
            const index=rows.findIndex(row=>row.getBoundingClientRect().bottom>top);
            const above=rows[index-1].firstElementChild,below=rows[index+2].firstElementChild;
            above.style.height=(above.getBoundingClientRect().height+delta)+'px';
            below.style.height=(below.getBoundingClientRect().height-delta)+'px';
          },
          switchThread:()=>{setThread('two');setMessages(make(1000,120,true))},
          empty:()=>setMessages([]),restore:()=>setMessages(make(2000,80)),
          snapshot:()=>({...counters,range:range.current})};
        return <ScrollArea ref={root} type='always' style={{height:600,width:650}}>
          <ChatMessageVirtualList messages={messages} visibleMessageIndexes={messages.map((_,i)=>i)} lastUserMessageIndex={messages.length-2}
            contentVersion={messages.length} historyHasMore={false} historyPageLoading={false} historyRemainingCount={0}
            onLoadEarlierHistoryPage={noop} historyGapBeforeMessageId={null} canLoadReleasedHistory={false}
            onLoadReleasedHistoryWindow={noop} onRestoreLatestHistoryWindow={noop} hookLoggingEnabled={false}
            hookLogBucketByTurnId={maps} detachedHookLogBuckets={[]} contentMessageRefs={refs} setMessageRef={()=>noop}
            isLoading={false} toolResults={maps} toolCallStates={maps} pendingApprovalToolCallKeys={new Set()}
            pendingApproval={null} autoApproveGitPush={false} onApprovalDecision={noop} onEditUserMessage={noop}
            onSetGoalFromMessage={noop} onForkFromMessage={noop} forkingMessageId={null} onOpenHookLogBucket={noop}
            threadId={thread} assistantDurationMsById={maps} userSendTimeLabelById={maps.labels??maps}
            customScrollParent={parent} virtuosoRef={virtual} navigatorVirtualRangeRef={range}
            initialTopMostItemIndex={{index:'LAST',align:'end'}} onInitialVirtualItemsRendered={noop}
            onContentHeightChanged={noop} onAtBottomStateChange={noop} readDetachedAnchorLease={readLease} footer={null}/>
        </ScrollArea>
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.hot": "undefined" },
    plugins: [
      {
        name: "geometry-only-bubbles",
        setup(builder) {
          builder.onResolve(
            { filter: /^\.\/(MessageBubble|HookLogViews|FunctionTurnNotices|ChatSearchContext)$/ },
            (args) => ({ path: args.path, namespace: "geometry" })
          )
          builder.onLoad({ filter: /.*/, namespace: "geometry" }, (args) => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: args.path.endsWith("MessageBubble")
              ? `import React,{useEffect}from'react';export function MessageBubble({message}){
              useEffect(()=>{window.layoutCounters.mounts++;return()=>{window.layoutCounters.unmounts++}},[]);
              return <div style={{height:Number(message.content),boxSizing:'border-box',background:'#ddd'}}>{message.id}</div>}`
              : "export const HookLogChip=()=>null,FunctionTurnNotices=()=>null,ChatSearchContext=()=>null"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const call = (operation: string, index?: number) =>
    page.evaluate(
      ({ operation, index }) =>
        (
          window as unknown as { layoutFixture: Record<string, (index?: number) => unknown> }
        ).layoutFixture[operation](index),
      { operation, index }
    )
  const snapshot = () => call("snapshot") as Promise<LayoutSnapshot>
  const phase = (value: string) =>
    page.evaluate(
      (value) =>
        (
          window as unknown as { layoutFixture: { phase(value: string): void } }
        ).layoutFixture.phase(value),
      value
    )
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        )
    )
  const rowOffset = (id: string) =>
    page
      .locator(`[data-chat-message-id="${id}"]`)
      .evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          document.querySelector("[data-radix-scroll-area-viewport]")!.getBoundingClientRect().top
      )
  const waitAtEnd = (id: string) =>
    page.waitForFunction((id) => {
      const viewport = document.querySelector("[data-radix-scroll-area-viewport]")!
      return (
        (window as unknown as { layoutFixture: { rowPresented(): boolean } })
          .layoutFixture.rowPresented() &&
        document.querySelector(`[data-chat-message-id="${id}"]`) &&
        Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 2
      )
    }, id)
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: "window.__name=value=>value" })
    for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css")))
      await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForSelector('[data-chat-initial-presentation="ready"]')
    await settle()
    await phase("drag")
    const beforeDrag = await snapshot()
    const bar = page.locator('[data-scroll-area-scrollbar][data-orientation="vertical"]')
    const thumb = bar.locator("[data-state]")
    const thumbBox = await thumb.boundingBox()
    const barBox = await bar.boundingBox()
    assert(thumbBox && barBox)
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2)
    await page.mouse.down()
    for (const fraction of [0.15, 0.75, 0.35, 0.9, 0.45]) {
      await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height * fraction, {
        steps: 8
      })
    }
    await page.mouse.up()
    await settle()
    const afterDrag = await snapshot()
    assert.equal(afterDrag.emptyFrames, beforeDrag.emptyFrames, "Dragging leaves no empty viewport")
    assert(
      afterDrag.maxMountedRows <= 32,
      "The 400-message transcript keeps its DOM window bounded"
    )
    const anchor = await page.evaluate(() => {
      const viewport = document.querySelector("[data-radix-scroll-area-viewport]")!
      const top = viewport.getBoundingClientRect().top
      const row = [...viewport.querySelectorAll("[data-chat-message-id]")].find(
        (element) => element.getBoundingClientRect().bottom > top
      )!
      ;(window as unknown as { anchorNode: Element }).anchorNode = row
      return {
        id: row.getAttribute("data-chat-message-id")!,
        offset: row.getBoundingClientRect().top - top
      }
    })
    const beforePrepend = await snapshot()
    await phase("prepend")
    await call("prepend")
    await settle()
    assert.equal(
      await page
        .locator(`[data-chat-message-id="${anchor.id}"]`)
        .evaluate(
          (element) => element === (window as unknown as { anchorNode: Element }).anchorNode
        ),
      true
    )
    assert(Math.abs((await rowOffset(anchor.id)) - anchor.offset) <= 2)
    const afterPrepend = await snapshot()
    writeFileSync(
      resolve(output, "prepend-diagnostic.json"),
      JSON.stringify({ beforePrepend, afterPrepend }, null, 2) + "\n"
    )
    assert.equal(
      afterPrepend.visibleEmptyFrames,
      beforePrepend.visibleEmptyFrames,
      "Prepending never paints a visible viewport without a current message row"
    )
    assert.equal(
      afterPrepend.emptyFrames,
      beforePrepend.emptyFrames,
      "Prepending does not move every mounted message outside the viewport for a frame"
    )
    assert.equal(
      await page
        .locator('[data-testid="virtuoso-item-list"]')
        .evaluate((element) => (element as HTMLElement).style.translate),
      "",
      "Native prepend compensation releases the paint correction"
    )
    await phase("release")
    await call("release")
    await settle()
    assert(Math.abs((await rowOffset(anchor.id)) - anchor.offset) <= 2)
    await call("position", 42)
    assert(
      Math.abs(await rowOffset("row-37")) <= 2,
      "Released-prefix search keeps relative indexes"
    )
    await call("last")
    await settle()
    await page.locator('[data-chat-message-id="row-399"]').waitFor()
    await call("replace")
    await waitAtEnd("row-1119")
    assert.equal(await page.locator(`[data-chat-message-id="${anchor.id}"]`).count(), 0)
    await call("position", 9)
    assert(Math.abs(await rowOffset("row-1009")) <= 2)
    await call("switchThread")
    await waitAtEnd("row-1119")
    await call("position", 9)
    assert.equal(
      await page
        .locator('[data-chat-message-id="row-1009"]')
        .evaluate((element) => element.getBoundingClientRect().height),
      820
    )
    await call("empty")
    await settle()
    assert.equal(await page.locator("[data-chat-message-id]").count(), 0)
    await call("restore")
    await settle()
    await call("last")
    await settle()
    await page.locator('[data-chat-message-id="row-2079"]').waitFor()
    await page.waitForFunction(() =>
      (window as unknown as { layoutFixture: { rowPresented(): boolean } }).layoutFixture.rowPresented()
    )
    const visibilityChecks = await page.evaluate(() => {
      const fixture = (window as unknown as { layoutFixture: { rowPresented(): boolean } }).layoutFixture
      const row = document.querySelector<HTMLElement>("[data-chat-message-row]")!
      const root = row.closest<HTMLElement>("[data-chat-initial-presentation]")!
      const values = [fixture.rowPresented()]
      row.style.visibility = "hidden"
      values.push(fixture.rowPresented())
      row.style.visibility = ""
      root.setAttribute("aria-hidden", "true")
      values.push(fixture.rowPresented())
      root.removeAttribute("aria-hidden")
      root.dataset.chatInitialPresentation = "pending"
      values.push(fixture.rowPresented())
      root.dataset.chatInitialPresentation = "ready"
      Object.defineProperty(row, "checkVisibility", { value: undefined, configurable: true })
      values.push(fixture.rowPresented())
      root.style.opacity = "0"
      values.push(fixture.rowPresented())
      root.style.opacity = ""
      delete (row as unknown as { checkVisibility?: unknown }).checkVisibility
      return values
    })
    assert.deepEqual(visibilityChecks, [true, false, false, false, true, false],
      "Presented rows require visible CSS/ancestors, including the compatibility path")
    await phase("restore-latest-with-retained-tail")
    await call("historical")
    await call("last")
    await waitAtEnd("row-1999")
    const historicalTail = await page.locator('[data-chat-message-id="row-1999"]').elementHandle()
    assert(historicalTail)
    await call("latest")
    await waitAtEnd("row-1999")
    assert.equal(
      await historicalTail.evaluate(element => element.isConnected),
      false,
      "Replacing both historical and latest prefixes must reprobe the retained tail's sizes"
    )
    assert(
      await page.locator('[data-chat-message-id="row-1999"]').evaluate(element => {
        const row = element.getBoundingClientRect()
        const viewport = element.closest("[data-radix-scroll-area-viewport]")!.getBoundingClientRect()
        return row.height > 0 && row.bottom > viewport.top && row.top < viewport.bottom
      }),
      "The restored latest tail must remain visible after the measurement window resets"
    )
    await phase("detached-async-height")
    await call("short")
    await waitAtEnd("row-399")
    await call("anchor", 1)
    const firstVisible = (readable = false) => page.evaluate((readable) => {
      const viewport = document.querySelector("[data-radix-scroll-area-viewport]")!
      const area = viewport.getBoundingClientRect()
      const row = [...viewport.querySelectorAll<HTMLElement>("[data-chat-message-row]")]
        .find(row => row.getBoundingClientRect().bottom > area.top &&
          (!readable || !row.querySelector("[data-function-site-pending]")))!
      return { id: row.dataset.chatMessageId!, top: row.getBoundingClientRect().top - area.top }
    }, readable)
    const asyncHeightHold = async (height: number) => {
      const before = await firstVisible()
      await call("growAbove", height)
      await settle()
      const after = await firstVisible()
      writeFileSync(resolve(output, "detached-height-latest.json"),
        JSON.stringify({ before, after, height, snapshot: await snapshot() }, null, 2) + "\n")
      assert.equal(after.id, before.id, "An async height change must preserve the reader's row")
      assert(Math.abs(after.top - before.top) <= 2, "The held reader's row offset must stay stable")
      return { before, after, height }
    }
    const freshThumb = await thumb.boundingBox()
    const freshBar = await bar.boundingBox()
    assert(freshThumb && freshBar)
    await page.mouse.move(freshThumb.x + freshThumb.width / 2, freshThumb.y + freshThumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(freshBar.x + freshBar.width / 2, freshBar.y + freshBar.height * 0.35, { steps: 8 })
    await settle()
    const held = await asyncHeightHold(700)
    const beforeFurtherMovement = await firstVisible()
    await page.mouse.move(freshBar.x + freshBar.width / 2, freshBar.y + freshBar.height * 0.65, { steps: 8 })
    await settle()
    assert.notEqual((await firstVisible()).id, beforeFurtherMovement.id,
      "Further actual pointer movement must replace the preceding reading anchor")
    const movedThenHeld = await asyncHeightHold(350)
    await page.mouse.up()
    await settle()
    const released = await asyncHeightHold(500)
    await call("pendingFirst")
    const viewportBox = await page.locator("[data-radix-scroll-area-viewport]").boundingBox()
    assert(viewportBox)
    await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2)
    await page.mouse.wheel(0, 1)
    await settle()
    await page.waitForTimeout(150)
    const readableBeforePendingGrowth = await firstVisible(true)
    await call("growPending", 600)
    await settle()
    const readableAfterPendingGrowth = await firstVisible(true)
    assert.deepEqual(readableAfterPendingGrowth, readableBeforePendingGrowth,
      "A pending edge row must not displace the following already readable body")
    const beforeWheel = await firstVisible()
    await page.mouse.wheel(0, 464)
    await settle()
    await page.mouse.wheel(0, 232)
    await settle()
    assert.notEqual((await firstVisible()).id, beforeWheel.id,
      "Successive wheel intent must keep ownership while moving")
    await page.waitForTimeout(150)
    const wheelStopped = await asyncHeightHold(250)
    const equalHeightBefore = await firstVisible()
    await call("equalHeightChange", 40)
    await settle()
    const equalHeightAfter = await firstVisible()
    assert.deepEqual(equalHeightAfter, equalHeightBefore,
      "Equal growth/shrink must release the measurement barrier without a list resize")
    await call("anchor", 1)
    await call("position", 42)
    await settle()
    assert(Math.abs(await rowOffset("row-42")) <= 2,
      "A new navigation lease must invalidate the prior reading anchor")
    await call("anchor", 0)
    const followingBefore = await firstVisible()
    await call("growAbove", 600)
    await settle()
    const followingAfter = await firstVisible()
    assert(followingAfter.id !== followingBefore.id ||
      Math.abs(followingAfter.top - followingBefore.top) > 100,
      "Following/restoration must yield to its existing scroll owner")
    writeFileSync(resolve(output, "detached-height-evidence.json"),
      JSON.stringify({ held, movedThenHeld, released, readableBeforePendingGrowth,
        readableAfterPendingGrowth, wheelStopped, equalHeightBefore, equalHeightAfter }, null, 2) + "\n")
    await phase("pending-anchor-promotion")
    await call("anchor", 0)
    await call("promotionWindow")
    await waitAtEnd("row-399")
    await call("position", 200)
    await settle()
    await call("anchor", 1)
    await call("pendingAll")
    await page.mouse.wheel(0, 1)
    await settle()
    await page.waitForTimeout(150)
    const firstReadableAbove = await call("readyBeforePending", 200) as { id: string; top: number }
    await settle()
    const promoted = await firstVisible(true)
    assert.equal(promoted.id, firstReadableAbove.id,
      "Readable A must be remembered during the measurement barrier before the viewport advances")
    assert(Math.abs(promoted.top - firstReadableAbove.top) <= 2,
      "Promoting A must retain its current readable offset instead of pulling B back onscreen")
    const afterIndependentGrowth = await asyncHeightHold(200)
    await call("readyOriginalPending", 500)
    await settle()
    const afterPendingBCompletes = await firstVisible(true)
    assert.deepEqual(afterPendingBCompletes, promoted,
      "Once A is readable, later B completion must not replace the reading anchor")
    writeFileSync(resolve(output, "pending-promotion-evidence.json"), JSON.stringify({
      firstReadableAbove, promoted, afterIndependentGrowth, afterPendingBCompletes
    }, null, 2) + "\n")
    await phase("delayed-range-first-anchor")
    await call("anchor", 0)
    await call("materializationWindow")
    await waitAtEnd("row-399")
    await call("position", 200)
    await settle()
    await call("hideRows")
    await call("anchor", 1)
    await page.mouse.wheel(0, 1)
    await settle()
    await page.waitForTimeout(150)
    await call("showRows")
    await settle()
    const materialized = await firstVisible(true)
    await call("growAbove", 200)
    await settle()
    const afterMaterializedGrowth = await firstVisible(true)
    assert.deepEqual(afterMaterializedGrowth, materialized,
      "A range absent at the last input capture must acquire its first readable anchor on materialization")
    writeFileSync(resolve(output, "delayed-range-anchor-evidence.json"), JSON.stringify({
      materialized, afterMaterializedGrowth
    }, null, 2) + "\n")
    assert.deepEqual(errors, [])
    const evidence = {
      beforeDrag,
      afterDrag,
      beforePrepend,
      afterPrepend,
      errors,
      scope:
        "Real Radix thumb, Virtuoso and list; fixed-height visual bubbles, no authorization claim"
    }
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
    const summary = Object.fromEntries(
      Object.entries(evidence).map(([key, value]) => [
        key,
        value && typeof value === "object" && "trace" in value
          ? Object.fromEntries(
              Object.entries(value).filter(([field]) => !["trace", "anomalies"].includes(field))
            )
          : value
      ])
    )
    console.log(
      "PASS real Radix drag across 400 mixed-height messages, prepend identity/release geometry, relative search/end, unrelated window/thread/empty reset " +
        JSON.stringify(summary)
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
