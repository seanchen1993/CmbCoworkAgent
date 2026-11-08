import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import type { Browser } from "playwright"
import { measureChatVirtualItem } from "../../src/renderer/src/components/chat/chat-virtual-item-measurement"

/** Execute the actual session restore callback against installed Virtuoso and real layout. */
export async function verifyNativeItemMeasurements(browser: Browser): Promise<unknown[]> {
  for (const [height, expected] of [[400, 400], [387.5, 387.5], [391.75, 391.75], [101.123, 101.125]]) {
    assert.equal(measureChatVirtualItem({ getBoundingClientRect: () => ({ height }) } as unknown as HTMLElement), expected)
  }
  const source = readFileSync("src/renderer/src/components/chat/ChatContainer.tsx", "utf8")
  const start = source.indexOf("    const restore = (layoutOnly = false): void => {")
  const end = source.indexOf(
    "\n    let correctingLayout = false",
    start
  )
  assert(start >= 0 && end > start, "Actual session restore callback must remain available")
  const restoreCode = source.slice(start, end)
  const historyStart = source.indexOf("    const restoreAnchor = (layoutOnly = false): void => {")
  const historyEnd = source.indexOf("    let correctingLayout = false", historyStart)
  assert(historyStart >= 0 && historyEnd > historyStart)
  const historyRestoreCode = source.slice(historyStart, historyEnd)
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{useState,useRef,useLayoutEffect}from'react';import{createRoot}from'react-dom/client';
      import{Virtuoso}from'react-virtuoso';
      import{createChatSessionRestorePosition}from'./src/renderer/src/components/chat/chat-session-restore-position';
      import{hasUncommittedChatItemSizes,needsChatItemSizeRefresh,positionChatVirtualAnchor,measureChatVirtualItem}from'./src/renderer/src/components/chat/chat-virtual-item-measurement';
      import{acquireChatExternalScrollAnchor}from'./src/renderer/src/components/chat/chat-external-scroll-anchor';
      const config=window.config,heights=new Map(config.initial?[]:[[83,2400]]);
      const data=Array.from({length:200},(_,i)=>({id:'row-'+i}));
      let viewport,handle,anchor,frame,position,release,refreshes=[],cancels=[];
      const pendingChatSessionAnchorRef={current:null},contentMessageRefs={current:new Map()},virtuosoRef={current:null};
      const getViewport=()=>viewport,visibleIndex=80;
      const CHAT_SESSION_ANCHOR_STABLE_FRAMES=2,CHAT_HISTORY_ANCHOR_STABLE_FRAMES=12,CHAT_HISTORY_ANCHOR_MAX_FRAMES=120;
      const finish=()=>{pendingChatSessionAnchorRef.current=null;release?.()};
      const settle=()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))));
      function Row({index,id}){const ref=useRef(null);
        useLayoutEffect(()=>{if(config.initial&&index!==79){const publish=()=>{heights.set(index,391);if(ref.current)ref.current.style.height='391px'};if(config.delayed)requestAnimationFrame(()=>requestAnimationFrame(publish));else publish()}},[]);
        const readable=config.initial?(index===80||index===81):index===81;
        return <div ref={ref} data-chat-message-row data-chat-message-id={id} style={{height:heights.get(index)??(config.initial?141:400)}}>
          <div data-function-site="AssistantMessage" style={{height:'100%',display:config.initial?'contents':'block'}} {...(readable?{}:{'data-function-site-pending':''})}>
            {readable?<div style={{display:config.initial?'contents':'block'}}><p data-readable-body style={{margin:0}}>Readable answer</p></div>:''}</div></div>;
      }
      function App(){const[parent,setParent]=useState(null),outer=useRef(null);
        useLayoutEffect(()=>{viewport=outer.current;setParent(viewport)},[]);
        useLayoutEffect(()=>{if(config.initial&&parent&&handle)run('initial').then(result=>window.result=result)},[parent]);
        return <div ref={outer} style={{height:747,width:864,overflow:'auto',overflowAnchor:'none'}}>
          {parent&&<Virtuoso ref={h=>{handle=h;virtuosoRef.current=h&&{...h,cancelScrollToIndex(){cancels.push({at:performance.now(),attempt:anchor?.attempt});h.cancelScrollToIndex()},refreshItemSizes(){
            const list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
            const mismatch=[...list.children].some(item=>item.hasAttribute('data-index')&&
              Number(item.dataset.knownSize)!==Math.round(item.getBoundingClientRect().height));
            refreshes.push({hidden:list.style.visibility==='hidden',mismatch});h.refreshItemSizes();
          }}}} data={data} customScrollParent={parent} skipAnimationFrameInResizeObserver itemSize={measureChatVirtualItem} followOutput={false}
            increaseViewportBy={{top:1200,bottom:1200}} initialTopMostItemIndex={{index:config.initial?79:80,align:'start'}}
            computeItemKey={(_,row)=>row.id} itemContent={(index,row)=><Row index={index} id={row.id}/>}/>}</div>;
      }
      async function run(variant){
        if(!config.initial){await settle();handle.scrollToIndex({index:80,align:'start',behavior:'auto'});
          await new Promise(done=>setTimeout(done,180));handle.cancelScrollToIndex();await settle();}
        anchor={messageId:'row-80',offsetFromViewportTop:config.initial?config.offset:0,attempt:0,stableFrames:0};
        pendingChatSessionAnchorRef.current=anchor;release=acquireChatExternalScrollAnchor(handle);
        position=createChatSessionRestorePosition();refreshes=[];
        ${restoreCode}
        let expected=config.offset;
        if(config.initial)frame=requestAnimationFrame(()=>restore());
        else{
          restore();expected=viewport.querySelector('[data-chat-message-id="row-81"]').getBoundingClientRect().top-viewport.getBoundingClientRect().top;
          const above=variant==='saved'?80:79;
          heights.set(above,2600);heights.set(83,200);
          viewport.querySelector('[data-chat-message-id="row-'+above+'"]').style.height='2600px';
          viewport.querySelector('[data-chat-message-id="row-83"]').style.height='200px';
        }
        const samples=[],started=performance.now();
        // Cover the existing native 150ms completion watch in wall time, even on fast RAFs.
        for(let i=0;i<(config.initial?160:8)&&(!config.initial||performance.now()-started<450);i++){
          await new Promise(done=>requestAnimationFrame(()=>setTimeout(done,0)));
          const bounds=viewport.getBoundingClientRect(),list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
          const row=viewport.querySelector('[data-chat-message-id="row-'+(config.initial?80:81)+'"]');
          const bodies=[...viewport.querySelectorAll('[data-readable-body]')]
            .filter(body=>{const box=body.getBoundingClientRect();return list.style.visibility!=='hidden'&&box.bottom>bounds.top&&box.top<bounds.bottom}).length;
          samples.push({at:performance.now()-started,attempt:anchor.attempt,offset:row?row.getBoundingClientRect().top-bounds.top:null,bodies,top:viewport.scrollTop});
        }
        pendingChatSessionAnchorRef.current=null;cancelAnimationFrame(frame);release();
        return {expected,samples,refreshes,cancels:cancels.map(c=>({...c,at:c.at-started}))};
      }
      window.verifyMovingFrame=()=>{
        const viewport=document.createElement('div');viewport.style.cssText='height:100px;overflow:auto';
        const target=document.createElement('div');target.dataset.chatMessageId='stable-target';
        target.style.cssText='height:100px;margin-top:100px';
        target.innerHTML='<div data-function-site="AssistantMessage">Readable answer</div>';
        const tail=document.createElement('div');tail.style.height='1000px';
        viewport.append(target,tail);document.body.append(viewport);
        let frame,finished=false,refreshes=0;
        const anchor={messageId:'stable-target',offsetFromViewportTop:0,attempt:0,stableFrames:1};
        const pendingChatSessionAnchorRef={current:anchor},contentMessageRefs={current:new Map()};
        const getViewport=()=>viewport,position=createChatSessionRestorePosition();
        const virtuosoRef={current:{refreshItemSizes(){refreshes++;viewport.scrollTop=100},cancelScrollToIndex(){}}};
        const finish=()=>{finished=true};
        ${restoreCode}
        restore();cancelAnimationFrame(frame);
        const result={finished,stableFrames:anchor.stableFrames,refreshes,top:viewport.scrollTop};
        viewport.remove();return result;
      };
      window.verifyRecycledDuringRefresh=(history,layoutOnly=false)=>{
        const viewport=document.createElement('div');viewport.style.cssText='height:100px;overflow:auto';
        const target=document.createElement('div');target.dataset.chatMessageId='recycled';
        target.style.cssText='height:40px;margin-top:100px';target.textContent='System row';
        viewport.append(target);document.body.append(viewport);
        let frame,cancels=0,reveals=[];
        const anchor={messageId:'recycled',offsetFromViewportTop:0,viewportTop:viewport.getBoundingClientRect().top,attempt:6,stableFrames:0,lastRevealAttempt:0};
        const pendingChatSessionAnchorRef={current:anchor},contentMessageRefs={current:new Map()};
        const getViewport=()=>viewport,position=createChatSessionRestorePosition(),finish=()=>{};
        const virtuosoRef={current:{refreshItemSizes(){target.remove()},cancelScrollToIndex(){cancels++},scrollToIndex(){reveals.push(anchor.attempt)}}};
        const pendingDurableHistoryAnchorRef=pendingChatSessionAnchorRef,visibleMessageIndexById=new Map([['recycled',80]]),finishRestore=()=>{};
        ${restoreCode}
        ${historyRestoreCode}
        const tick=history?restoreAnchor:restore;
        if(layoutOnly){anchor.targetMounted=true;for(let i=0;i<6;i++)tick(true);
          const result={attempt:anchor.attempt,targetMounted:anchor.targetMounted,lastRevealAttempt:anchor.lastRevealAttempt,reveals};
          viewport.remove();return result}
        for(let i=0;i<13;i++){tick();cancelAnimationFrame(frame)}
        viewport.append(target);tick();cancelAnimationFrame(frame);
        viewport.remove();return{cancels,reveals};
      };
      window.verifyHiddenDeadline=()=>{
        const viewport=document.createElement('div');viewport.style.cssText='height:100px;overflow:auto';
        const list=document.createElement('div');list.dataset.testid='virtuoso-item-list';list.style.visibility='hidden';
        const item=document.createElement('div');item.dataset.index='80';item.dataset.knownSize='40';item.style.height='80px';
        const target=document.createElement('div');target.dataset.chatMessageId='deadline';target.textContent='System row';
        item.append(target);list.append(item);viewport.append(list);document.body.append(viewport);
        let frame,finished=false,cancels=0,refreshes=0;
        const anchor={messageId:'deadline',offsetFromViewportTop:0,attempt:119,stableFrames:0};
        const pendingChatSessionAnchorRef={current:anchor},contentMessageRefs={current:new Map()};
        const getViewport=()=>viewport,position=createChatSessionRestorePosition();
        const virtuosoRef={current:{refreshItemSizes(){refreshes++},cancelScrollToIndex(){cancels++}}};
        const finish=()=>{finished=true;pendingChatSessionAnchorRef.current=null};
        ${restoreCode}
        restore();cancelAnimationFrame(frame);const beforeDeadline={finished,cancels};
        restore();cancelAnimationFrame(frame);viewport.remove();
        return {beforeDeadline,finished,cancels,refreshes,attempt:anchor.attempt};
      };
      window.run=run;createRoot(document.getElementById('root')).render(<App/>);
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const evidence: unknown[] = []
  for (const variant of ["saved", "above", "initial", "negative", "delayed"]) {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.setContent('<style>body{margin:0}</style><div id="root"></div>')
      await page.evaluate((initial) => {
        ;(window as unknown as { config: unknown }).config = { initial, offset: 98 }
      }, (variant === "initial" || variant === "negative" || variant === "delayed"))
      if (variant === "negative") await page.evaluate("window.config.offset=-162")
      if (variant === "delayed") await page.evaluate("window.config.delayed=true")
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      if ((variant === "initial" || variant === "negative" || variant === "delayed")) await page.waitForFunction("window.result")
      else await page.waitForSelector('[data-chat-message-id="row-81"]')
      const result = (await page.evaluate(
        (variant === "initial" || variant === "negative" || variant === "delayed") ? "window.result" : `window.run('${variant}')`
      )) as {
        expected: number
        samples: { at: number; attempt: number; offset: number | null; bodies: number }[]
        refreshes: { hidden: boolean; mismatch: boolean }[]
        cancels: { at: number; attempt: number }[]
      }
      assert.deepEqual(errors, [])
      if (variant === "initial") {
        for (const history of [false, true]) assert.deepEqual(
          await page.evaluate(value => window.verifyRecycledDuringRefresh(value, true), history),
          { attempt: 6, targetMounted: true, lastRevealAttempt: 0, reveals: [] },
          "Layout-only delivery cannot consume the RAF deadline, recycle edge, or missing-index spacing"
        )
        assert.deepEqual(await page.evaluate("window.verifyRecycledDuringRefresh(false)"), {
          cancels: 0, reveals: [6, 18, 19]
        }, "Session recycling interrupts an active throttle once, keeps continuous-missing cadence, and rearms after remount")
        assert.deepEqual(await page.evaluate("window.verifyRecycledDuringRefresh(true)"), {
          cancels: 2, reveals: [6, 18, 19]
        }, "History restoration preserves the same recycle-edge cadence")
      }
      if (variant === "initial") assert.deepEqual(await page.evaluate("window.verifyHiddenDeadline()"), {
        beforeDeadline: { finished: false, cancels: 0 }, finished: true, cancels: 1, refreshes: 2, attempt: 121
      }, "Uncommitted hidden measurements retain the original deadline and release initialization at expiry")
      if ((variant === "initial" || variant === "negative" || variant === "delayed")) {
        assert.deepEqual(
          await page.evaluate("window.verifyMovingFrame()"),
          {
            finished: false,
            stableFrames: 0,
            refreshes: 2,
            top: 100
          },
          "A native movement ending at zero delta must sync scroll state and await a stable frame"
        )
      }
      if (variant !== "delayed") assert(
        result.refreshes.some((item) => item.mismatch),
        "The regression must exercise stale native item sizes"
      )
      if ((variant === "initial" || variant === "negative" || variant === "delayed")) {
        if (variant !== "delayed") assert(result.refreshes.some((item) => item.hidden && item.mismatch))
        const firstBody = result.samples.findIndex((sample) => sample.bodies > 0)
        assert(firstBody >= 0, JSON.stringify({ variant, result }))
        assert(result.samples[firstBody].attempt < 121, "Native initialization must finish before the forced restore deadline")
        assert(result.samples.at(-1)!.at >= 150, "Observe the existing native completion watch in real time")
        assert(result.cancels[0].at >= 140, "Without a readable destination, keep native initialization alive through its own completion watch")
        assert(
          result.samples.slice(firstBody).every((sample) => sample.bodies > 0),
          "Native initial size publication must not evict approved text after its first visible frame"
        )
        assert(Math.abs(result.samples.at(-1)!.offset! - result.expected) <= 2)
      } else
        assert(
          result.samples.every(
            (sample) =>
              sample.offset !== null &&
              Math.abs(sample.offset - result.expected) <= 2 &&
              sample.bodies > 0
          ),
          "Balanced 2200px changes beyond overscan retain the actual session reading anchor on every paint"
        )
      evidence.push({ variant, ...result })
    } finally {
      await page.close()
    }
  }
  evidence.push(await verifyDelayedSpacerCommit(browser))
  evidence.push(await verifyNativeAnchorBoundary(browser))
  evidence.push(await verifyFractionalMutationCost(browser))
  evidence.push(await verifyRecycledTargetNavigation(browser))
  return evidence
}


/** A controlled delayed DOM commit, not a claim to reproduce all Electron scheduling. */
export async function verifyDelayedSpacerCommit(browser: Browser): Promise<unknown> {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React,{useLayoutEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
      import{Virtuoso}from'react-virtuoso';
      import{positionChatVirtualAnchor,measureChatVirtualItem}from'./src/renderer/src/components/chat/chat-virtual-item-measurement';
      import{acquireChatExternalScrollAnchor}from'./src/renderer/src/components/chat/chat-external-scroll-anchor';
      const data=Array.from({length:200},(_,i)=>i);let viewport,handle;
      const paint=()=>new Promise(done=>requestAnimationFrame(()=>setTimeout(done,0)));
      function App(){const ref=useRef(null),[parent,setParent]=useState(null);
        useLayoutEffect(()=>{viewport=ref.current;setParent(viewport)},[]);
        return <div ref={ref} style={{height:747,width:864,overflow:'auto',overflowAnchor:'none'}}>
          {parent&&<Virtuoso ref={h=>handle=h} customScrollParent={parent} data={data}
            firstItemIndex={10000} initialTopMostItemIndex={{index:80,align:'start'}}
            increaseViewportBy={{top:1200,bottom:1200}} itemSize={measureChatVirtualItem}
            skipAnimationFrameInResizeObserver followOutput={false}
            itemContent={(_,i)=><div data-row={i} style={{height:window.fractional?(i%2?391.75:387.5):400}}>
              <section style={{display:'contents'}}><p style={{margin:0}}>Readable row {i}</p></section>
            </div>}/>}</div>;
      }
      window.run=async native=>{
        for(let i=0;i<4;i++)await paint();handle.cancelScrollToIndex();
        const release=acquireChatExternalScrollAnchor(handle);
        const row=viewport.querySelector('[data-row="81"]'),list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
        const offset=()=>row.getBoundingClientRect().top-viewport.getBoundingClientRect().top;
        const expected=offset(),padding=list.style.paddingTop,top=viewport.scrollTop;
        // Deliberately retain a stale spacer while the native model stays correct.
        list.style.paddingTop=(parseFloat(padding)+517)+'px';
        handle.refreshItemSizes();handle.cancelScrollToIndex();
        const staleDelta=offset()-expected;
        if(native)positionChatVirtualAnchor(row,expected,handle);
        else viewport.scrollTop+=staleDelta;
        if(viewport.scrollTop!==top)handle.refreshItemSizes();
        // Model publication does not commit this DOM synchronously: emulate its queued commit.
        queueMicrotask(()=>{list.style.paddingTop=padding});
        const samples=[];for(let i=0;i<8;i++){await paint();const current=viewport.querySelector('[data-row="81"]');
          samples.push({same:current===row,offset:current?current.getBoundingClientRect().top-viewport.getBoundingClientRect().top:null})}
        release();return{native,expected,staleDelta,samples};
      };createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const results: unknown[] = []
  for (const fractional of [false, true]) for (const native of [false, true]) {
    const page = await browser.newPage()
    try {
      await page.setContent('<style>body{margin:0}</style><div id="root"></div>')
      await page.evaluate(value => { (window as unknown as { fractional: boolean }).fractional = value }, fractional)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.waitForSelector('[data-row="81"]')
      const result = await page.evaluate(`window.run(${native})`) as {
        expected: number, staleDelta: number, samples: { same: boolean, offset: number | null }[]
      }
      assert.equal(result.staleDelta, 517)
      if (native) assert(result.samples.every(sample => sample.same && sample.offset !== null &&
        Math.abs(sample.offset - result.expected) <= 1), "Native one-shot retains the row through a delayed spacer commit")
      else assert(result.samples.some(sample => sample.offset === null ||
        Math.abs(sample.offset - result.expected) > 500), "Legacy DOM delta must reproduce the stale spacer overcorrection")
      results.push({ fractional, native, ...result })
    } finally { await page.close() }
  }
  return { delayedSpacerCommit: results }
}


export async function verifyNativeAnchorBoundary(browser: Browser): Promise<unknown> {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{Virtuoso}from'react-virtuoso';import{installChatDetachedLayoutAnchor}from'./src/renderer/src/components/chat/chat-detached-layout-anchor';import{positionChatVirtualAnchor,measureChatVirtualItem}from'./src/renderer/src/components/chat/chat-virtual-item-measurement';import{acquireChatExternalScrollAnchor}from'./src/renderer/src/components/chat/chat-external-scroll-anchor';
let handle,parent,configure;function App(){const[p,setP]=useState(null),[height,setHeight]=useState(500);configure=setHeight;return <div ref={node=>{parent=node;if(node&&p!==node)setP(node)}} style={{height:400,width:600,overflow:'auto',overflowAnchor:'none'}}>{p&&<Virtuoso ref={node=>handle=node} data={[0,1,2,3]} customScrollParent={p} initialTopMostItemIndex={{index:2,align:'start',offset:100}} increaseViewportBy={1200} itemSize={measureChatVirtualItem} skipAnimationFrameInResizeObserver itemContent={index=><div data-chat-message-row data-chat-message-id={'row-'+index} style={{height:[300,300,400,height][index]}}>Readable row {index}</div>}/>}</div>};const root=createRoot(document.querySelector('#root'));const frames=async n=>{for(let i=0;i<n;i++)await new Promise(r=>requestAnimationFrame(r))};window.run=async native=>{flushSync(()=>root.render(<App/>));await frames(30);parent.scrollTop=700;handle.refreshItemSizes();handle.cancelScrollToIndex();await frames(3);const dispose=installChatDetachedLayoutAnchor({root:parent.firstElementChild,viewport:parent,readLease:()=>1,acquireScrollAnchor:()=>acquireChatExternalScrollAnchor(handle),prepareCorrection:()=>{handle.refreshItemSizes();handle.cancelScrollToIndex()},commitCorrection:()=>handle.refreshItemSizes(),positionAnchor:native?((el,offset)=>positionChatVirtualAnchor(el,offset,handle)):undefined});const record=()=>({top:parent.scrollTop,max:parent.scrollHeight-parent.clientHeight,offset:document.querySelector('[data-chat-message-id="row-2"]').getBoundingClientRect().top-parent.getBoundingClientRect().top});const before=record();flushSync(()=>configure(20));await frames(8);const shrunk=record();flushSync(()=>configure(500));await frames(8);const regrown=record();dispose();return{native,before,shrunk,regrown}};
` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const results: unknown[] = []
  for (const native of [false, true]) {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const result = await page.evaluate(`window.run(${native})`) as {
        before: { top: number }, shrunk: { top: number, offset: number },
        regrown: { top: number, offset: number }
      }
      assert(result.before.top - result.shrunk.top > 70, "The shrink must clamp the viewport")
      assert(Math.abs(result.regrown.top - result.shrunk.top) <= 1)
      assert(Math.abs(result.regrown.offset - result.shrunk.offset) <= 1,
        "Growing after a native boundary clamp must not replay the unreachable old anchor")
      results.push({ native, ...result })
    } finally { await page.close() }
  }
  return { nativeBoundary: results }
}


/** The +0.5 control restores Virtuoso's old ceil bias; production uses nearest-pixel positioning. */
export async function verifyFractionalMutationCost(browser: Browser): Promise<unknown> {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{Virtuoso}from'react-virtuoso';import{installChatDetachedLayoutAnchor}from'./src/renderer/src/components/chat/chat-detached-layout-anchor';import{positionChatVirtualAnchor,measureChatVirtualItem}from'./src/renderer/src/components/chat/chat-virtual-item-measurement';import{acquireChatExternalScrollAnchor}from'./src/renderer/src/components/chat/chat-external-scroll-anchor';
let handle,parent;const data=Array.from({length:100},(_,i)=>i);function App(){const[p,setP]=useState(null);return <div ref={node=>{parent=node;if(node&&p!==node)setP(node)}} style={{height:747,width:864,overflow:'auto',overflowAnchor:'none'}}>{p&&<Virtuoso ref={node=>handle=node} data={data} customScrollParent={p} initialTopMostItemIndex={{index:40,align:'start',offset:100}} increaseViewportBy={1200} itemSize={measureChatVirtualItem} skipAnimationFrameInResizeObserver itemContent={i=><div data-chat-message-row data-chat-message-id={'row-'+i} style={{height:i%2?391.75:387.5}}>Readable row {i}</div>}/>}</div>};const root=createRoot(document.querySelector('#root'));const frames=async n=>{for(let i=0;i<n;i++)await new Promise(r=>requestAnimationFrame(r))};window.run=async bias=>{flushSync(()=>root.render(<App/>));await frames(30);handle.cancelScrollToIndex();let prepares=0,positions=0;const adapter={...handle,scrollToIndex:opts=>handle.scrollToIndex({...opts,offset:opts.offset+bias})};const row=document.querySelector('[data-chat-message-id="row-40"]');const read=()=>({top:parent.scrollTop,offset:row.getBoundingClientRect().top-parent.getBoundingClientRect().top,prepares,positions});const dispose=installChatDetachedLayoutAnchor({root:parent.firstElementChild,viewport:parent,readLease:()=>1,acquireScrollAnchor:()=>acquireChatExternalScrollAnchor(handle),prepareCorrection:()=>{prepares++;handle.refreshItemSizes();handle.cancelScrollToIndex()},commitCorrection:()=>handle.refreshItemSizes(),positionAnchor:(el,offset)=>{positions++;return positionChatVirtualAnchor(el,offset,adapter)}});const before=read();document.querySelector('[data-chat-message-id="row-39"]').style.height='392.875px';await frames(8);const grown=read(),mutations=[];for(let i=0;i<6;i++){const a=read();row.firstChild.nodeValue='Readable fixed-size mutation '+i;await frames(4);const b=read();mutations.push({prepares:b.prepares-a.prepares,positions:b.positions-a.positions,offset:b.offset,top:b.top})}const after=read();await frames(12);const idle=read();dispose();return{bias,before,grown,mutations,after,idle}};
` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const results: unknown[] = []
  for (const bias of [0.5, 0]) {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const result = await page.evaluate(`window.run(${bias})`) as {
        before: { offset: number }, grown: { offset: number },
        mutations: { prepares: number, positions: number }[],
        after: { prepares: number, positions: number }, idle: { prepares: number, positions: number }
      }
      if (bias === 0.5) assert(result.mutations.every(sample => sample.prepares > 0 && sample.positions > 0),
        "The original ceil bias must reproduce unnecessary scans for unchanged-height text")
      else {
        assert(Math.abs(result.grown.offset - result.before.offset) <= 0.5)
        assert(result.mutations.every(sample => sample.prepares === 0 && sample.positions === 0),
          "Same-height text mutations must not repeatedly measure or reposition a fractional anchor")
      }
      assert.equal(result.idle.prepares, result.after.prepares)
      assert.equal(result.idle.positions, result.after.positions)
      results.push({ bias, ...result })
    } finally { await page.close() }
  }
  return { fractionalMutationCost: results }
}


/** Real native row recycling: delaying an already-seen target can navigate away from newly readable text. */
async function verifyRecycledTargetNavigation(browser: Browser): Promise<unknown> {
  const source = readFileSync("src/renderer/src/components/chat/ChatContainer.tsx", "utf8")
  const start = source.indexOf("    const restore = (layoutOnly = false): void => {")
  const end = source.indexOf("    let correctingLayout = false", start)
  assert(start >= 0 && end > start)
  const actual = source.slice(start, end)
  assert.equal(actual.split("targetWasRecycled ||").length - 1, 1)
  const callback = actual.replace("targetWasRecycled ||", "(window.edge && targetWasRecycled) ||")
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React,{useState,useLayoutEffect,useRef}from'react';import{createRoot}from'react-dom/client';import{Virtuoso}from'react-virtuoso';
import{createChatSessionRestorePosition}from'./src/renderer/src/components/chat/chat-session-restore-position';
import{hasUncommittedChatItemSizes,needsChatItemSizeRefresh,positionChatVirtualAnchor,measureChatVirtualItem}from'./src/renderer/src/components/chat/chat-virtual-item-measurement';
import{acquireChatExternalScrollAnchor}from'./src/renderer/src/components/chat/chat-external-scroll-anchor';
const data=Array.from({length:200},(_,i)=>i),heights=new Map([[83,2400]]);let viewport,handle,frame,anchor,release;
const pendingChatSessionAnchorRef={current:null},contentMessageRefs={current:new Map()},virtuosoRef={current:null};
const getViewport=()=>viewport,visibleIndex=80,CHAT_SESSION_ANCHOR_STABLE_FRAMES=2,CHAT_HISTORY_ANCHOR_STABLE_FRAMES=12,CHAT_HISTORY_ANCHOR_MAX_FRAMES=120;
const finish=()=>{pendingChatSessionAnchorRef.current=null;release?.()},paint=()=>new Promise(done=>requestAnimationFrame(()=>setTimeout(done,0)));
function App(){const ref=useRef(null),[parent,setParent]=useState(null);useLayoutEffect(()=>{viewport=ref.current;setParent(viewport)},[]);
return <div ref={ref} style={{height:747,width:864,overflow:'auto',overflowAnchor:'none'}}>{parent&&<Virtuoso ref={h=>{handle=h;virtuosoRef.current=h}} data={data} customScrollParent={parent} initialTopMostItemIndex={{index:80,align:'start'}} increaseViewportBy={{top:1200,bottom:1200}} itemSize={measureChatVirtualItem} skipAnimationFrameInResizeObserver followOutput={false} itemContent={(_,i)=><div data-chat-message-row data-chat-message-id={'row-'+i} style={{position:'relative',height:heights.get(i)??400}}><section data-function-site="AssistantMessage" data-function-site-pending style={{display:'contents'}}/></div>}/>}</div>}
window.run=async()=>{for(let i=0;i<16;i++)await paint();handle.cancelScrollToIndex();
anchor={messageId:'row-80',offsetFromViewportTop:0,attempt:1,stableFrames:0,lastRevealAttempt:0};pendingChatSessionAnchorRef.current=anchor;release=acquireChatExternalScrollAnchor(handle);
const position=createChatSessionRestorePosition();let reveals=[];virtuosoRef.current={...handle,scrollToIndex(loc){reveals.push({attempt:anchor.attempt,top:viewport.scrollTop});handle.scrollToIndex(loc)}};
${callback}
restore();heights.set(79,2600);heights.set(83,300);viewport.querySelector('[data-chat-message-id="row-79"]').style.height='2600px';viewport.querySelector('[data-chat-message-id="row-83"]').style.height='300px';
const samples=[];for(let i=0;i<24;i++){await paint();for(const [index,readyAt] of [[79,4],[80,16]]){const row=viewport.querySelector('[data-chat-message-id="row-'+index+'"]');const site=row?.querySelector('[data-function-site]');if(site&&i>=readyAt&&!site.querySelector('p')){site.removeAttribute('data-function-site-pending');site.innerHTML='<p data-readable-body style="position:absolute;top:'+(index===79?600:20)+'px;margin:0;height:80px">Visible authorized answer</p>'}}
const box=viewport.getBoundingClientRect();const bodies=[...viewport.querySelectorAll('[data-readable-body]')].filter(node=>{const r=node.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom}).length;samples.push({i,attempt:anchor.attempt,target:!!viewport.querySelector('[data-chat-message-id="row-80"]'),top:viewport.scrollTop,bodies})}
pendingChatSessionAnchorRef.current=null;cancelAnimationFrame(frame);release();return{edge:window.edge,reveals,samples}};createRoot(document.getElementById('root')).render(<App/>);
` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const results: unknown[] = []
  for (const edge of [false, true]) {
    const page = await browser.newPage()
    try {
      await page.setContent('<style>body{margin:0}</style><div id="root"></div>')
      await page.evaluate(value => { (window as unknown as { edge: boolean }).edge = value }, edge)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.waitForSelector('[data-chat-message-id="row-80"]')
      const result = await page.evaluate("window.run()") as {
        reveals: { attempt: number }[], samples: { target: boolean, bodies: number, top: number }[]
      }
      assert(result.samples.some(sample => !sample.target), "Virtuoso must actually recycle the saved target")
      assert(result.samples.at(-1)!.target && result.samples.at(-1)!.bodies > 0)
      const firstBody = result.samples.findIndex(sample => sample.bodies > 0)
      assert(firstBody >= 0)
      const laterBlank = result.samples.slice(firstBody).some(sample => sample.bodies === 0)
      if (edge) {
        assert(result.reveals[0].attempt < 12)
        assert.equal(laterBlank, false, "An evicted target is recovered before the old missing-probe throttle can displace new text")
      } else {
        assert.equal(result.reveals[0].attempt, 12)
        assert.equal(laterBlank, true, "Control reproduces the delayed reveal removing newly readable text")
      }
      results.push({ edge, ...result })
    } finally { await page.close() }
  }
  return { recycledTargetNavigation: results }
}
