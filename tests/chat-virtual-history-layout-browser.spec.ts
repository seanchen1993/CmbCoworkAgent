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
      import{ScrollArea}from'./src/renderer/src/components/ui/scroll-area';
      const noop=()=>{},refs={current:new Map()},virtual={current:null},range={current:null},maps=new Map();
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
          jump:index=>virtual.current.scrollToIndex({index,align:'start',behavior:'auto'}),
          position:index=>new Promise(done=>virtual.current.scrollIntoView({index,align:'start',behavior:'auto',
            calculateViewLocation:()=>({index,align:'start',behavior:'auto'}),done})),
          last:()=>virtual.current.scrollToIndex({index:'LAST',align:'end',behavior:'auto'}),
          prepend:()=>setMessages(old=>[...make(-25,25),...old]),
          release:()=>setMessages(old=>old.slice(20)),
          replace:()=>setMessages(make(1000,120)),
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
            onContentHeightChanged={noop} onAtBottomStateChange={noop} footer={null}/>
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
