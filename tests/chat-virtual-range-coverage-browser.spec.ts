/** Cold row heights must converge before painting an entirely offscreen virtual range. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve(
    process.env.CHAT_VIRTUAL_RANGE_OUTPUT_DIR ?? "output/chat-virtual-range-coverage-browser"
  )
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{useState,useLayoutEffect,useRef}from'react';
      import{createRoot}from'react-dom/client';
      import{ChatMessageVirtualList}from'./src/renderer/src/components/chat/ChatMessageVirtualList';
      const noop=()=>{},map=new Map(),refs={current:new Map()},range={current:null},owner={};
      const messages=Array.from({length:130},(_,i)=>({id:'row-'+i,role:i%2?'assistant':'user',content:String(i)}));
      function Fixture(){const[parent,setParent]=useState(null),handle=useRef(null),root=useRef(null);
        useLayoutEffect(()=>{setParent(root.current)},[]);
        window.coverage={handle,viewport:()=>root.current,
          grow:()=>{root.current.style.setProperty('--even','360.5px');root.current.style.setProperty('--odd','383px')},
          own:active=>handle.current.setExternalScrollAnchor({owner,active}),
          tail:height=>root.current.style.setProperty('--tail',height+'px')};
        return <div ref={root} data-radix-scroll-area-viewport style={{height:747,width:864,overflow:'auto',overflowAnchor:'none','--even':'140.5px','--odd':'92px','--tail':'8375.5px'}}>
          <ChatMessageVirtualList projection={{ messages, contentVersion: 0, structureVersion: 0 }} visibleMessageIndexes={messages.map((_,i)=>i)} lastUserMessageIndex={128} historyHasMore={false} historyPageLoading={false} historyRemainingCount={0}
            onLoadEarlierHistoryPage={noop} historyGapBeforeMessageId={null} canLoadReleasedHistory={false}
            onLoadReleasedHistoryWindow={noop} onRestoreLatestHistoryWindow={noop} hookLoggingEnabled={false}
            hookLogBucketByTurnId={map} detachedHookLogBuckets={[]} contentMessageRefs={refs} setMessageRef={()=>noop}
            isLoading={false} toolResults={map} toolCallStates={map} pendingApprovalToolCallKeys={new Set()}
            pendingApproval={null} autoApproveGitPush={false} onApprovalDecision={noop} onEditUserMessage={noop}
            onSetGoalFromMessage={noop} onForkFromMessage={noop} forkingMessageId={null} onOpenHookLogBucket={noop}
            threadId='coverage' assistantDurationMsById={map} userSendTimeLabelById={map} customScrollParent={parent}
            virtuosoRef={handle} navigatorVirtualRangeRef={range} initialTopMostItemIndex={{index:'LAST',align:'end'}}
            onInitialVirtualItemsRendered={noop} onContentHeightChanged={noop} onAtBottomStateChange={noop} footer={null}/>
        </div>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.hot": "undefined",
      "import.meta.env.DEV": "false"
    },
    plugins: [
      browserWorkerPlugin(),
      {
        name: "coverage-bubbles",
        setup(builder) {
          builder.onResolve(
            { filter: /^\.\/(MessageBubble|HookLogViews|FunctionTurnNotices|ChatSearchContext)$/ },
            (args) => ({ path: args.path, namespace: "coverage" })
          )
          builder.onLoad({ filter: /.*/, namespace: "coverage" }, (args) => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: args.path.endsWith("MessageBubble")
              ? `import React from'react';export function MessageBubble({message}){const i=Number(message.content);return <div data-body style={{height:i===129?'var(--tail)':i%2?'var(--odd)':'var(--even)',background:'#ddd'}}>Readable {message.id}</div>}`
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  const errors: string[] = [],
    evidence: unknown[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent(
      '<style>body{margin:0}[data-item-index]{display:flow-root;padding-bottom:16px}</style><div id="root"></div>'
    )
    await page.addScriptTag({ content: "window.__name=value=>value;" + bundle.outputFiles[0].text })
    await page.waitForSelector('[data-chat-initial-presentation="ready"]')
    await page.evaluate(
      `new Promise(async done=>{for(let i=0;i<15;i++)await new Promise(r=>requestAnimationFrame(r));done()})`
    )
    await page.evaluate(
      "window.coverage.handle.current.cancelScrollToIndex();window.coverage.grow()"
    )
    await page.evaluate(
      `new Promise(async done=>{for(let i=0;i<8;i++)await new Promise(r=>requestAnimationFrame(r));done()})`
    )
    const samples = (await page.evaluate(`new Promise(async done=>{
      const viewport=window.coverage.viewport(),samples=[];
      viewport.scrollTop=viewport.scrollHeight*.55;
      for(let i=0;i<12;i++){
        await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
        const box=viewport.getBoundingClientRect(),list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
        const rows=[...viewport.querySelectorAll('[data-index]')].map(row=>{const r=row.getBoundingClientRect();return{index:Number(row.dataset.index),known:Number(row.dataset.knownSize),top:r.top,bottom:r.bottom,height:r.height}});
        samples.push({top:viewport.scrollTop,height:viewport.scrollHeight,visible:rows.filter(r=>r.bottom>box.top&&r.top<box.bottom).length,rows});
      }done(samples)})`)) as Array<{ visible: number; rows: unknown[] }>
    evidence.push({ scenario: "cold-size-model", samples })
    assert(
      samples.every((sample) => sample.visible > 0),
      "Every painted frame must contain a mounted row after the history is ready"
    )
    assert(
      samples.every((sample) => sample.rows.length < 50),
      "Cold-size convergence keeps the fixed overscan budget"
    )
    await page.evaluate("window.coverage.own(true)")
    const prior = (await page.evaluate("window.coverage.viewport().scrollTop")) as number
    await page.mouse.move(400, 350)
    await page.mouse.wheel(0, -1050)
    const owned = (await page.evaluate(`new Promise(async done=>{
      const viewport=window.coverage.viewport(),samples=[];
      for(let i=0;i<12;i++){
        await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
        const box=viewport.getBoundingClientRect(),rows=[...viewport.querySelectorAll('[data-index]')];
        samples.push({top:viewport.scrollTop,visible:rows.filter(row=>{const r=row.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom}).length,mounted:rows.length});
      }done(samples)})`)) as Array<{ top: number; visible: number; mounted: number }>
    evidence.push({ scenario: "owned-user-wheel", prior, samples: owned })
    assert(owned.every((sample) => sample.visible > 0 && sample.mounted < 50))
    assert(
      Math.abs(owned.at(-1)!.top - (prior - 1050)) < 1,
      "Native size compensation must not replace an application's owned user scroll target"
    )
    const beforeGrowth = owned.at(-1)!.top
    await page.evaluate("window.coverage.tail(9000)")
    await page.evaluate(
      `new Promise(async done=>{for(let i=0;i<8;i++)await new Promise(r=>requestAnimationFrame(r));done()})`
    )
    assert.equal(await page.evaluate("window.coverage.viewport().scrollTop"), beforeGrowth)
    await page.evaluate("window.coverage.own(false)")
    await page.evaluate(
      `new Promise(async done=>{for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));done()})`
    )
    assert.equal(
      await page.evaluate("window.coverage.viewport().scrollTop"),
      beforeGrowth,
      "Releasing the scroll owner must not replay suppressed compensation"
    )
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ evidence, errors }, null, 2))
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
