import assert from "node:assert/strict"
import { build } from "esbuild"
import type { Browser } from "playwright"

/** Input consumed by a child or by zoom must not abandon the transcript's reading position. */
export async function verifyDetachedScrollGestures(browser: Browser): Promise<void> {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React,{useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom';
        import {Virtuoso} from 'react-virtuoso';
        import {installChatDetachedLayoutAnchor} from
          './src/renderer/src/components/chat/chat-detached-layout-anchor';
        import {acquireChatExternalScrollAnchor} from
          './src/renderer/src/components/chat/chat-external-scroll-anchor';
        import {measureChatVirtualItem,positionChatVirtualAnchor} from
          './src/renderer/src/components/chat/chat-virtual-item-measurement';
        let handle,viewport,dispose,reading,owners=0;
        window.trustedKeys=[];window.buttonClicks=0;
        const data=Array.from({length:150},(_,i)=>i);
        function App(){
          const[parent,setParent]=useState(null);
          return <div ref={node=>{viewport=node;if(node&&parent!==node)setParent(node)}}
            style={{height:600,width:700,overflow:'auto',overflowAnchor:'none'}}>
            {parent&&<Virtuoso ref={node=>handle=node} data={data} customScrollParent={parent}
              initialTopMostItemIndex={{index:80,align:'start',offset:50}}
              increaseViewportBy={1200} itemSize={measureChatVirtualItem}
              skipAnimationFrameInResizeObserver={false}
              itemContent={i=><div data-chat-message-row data-chat-message-id={'row-'+i}
                onKeyDownCapture={event=>window.trustedKeys.push(event.nativeEvent.isTrusted)}
                style={{height:300}}>Readable row {i}
                <div className="inner" tabIndex={0} style={{height:100,overflow:'auto'}}>
                  <div style={{height:600}}>Scrollable code or tool content</div>
                </div>
                <button data-control="button" onClick={()=>window.buttonClicks++}>Toggle</button>
                <select data-control="select" defaultValue="one">
                  <option value="one">One</option><option value="two">Two</option>
                </select>
                <button data-control="cancelled" onKeyDown={event=>event.preventDefault()}>
                  Consume key
                </button>
                <button data-control="stopped" onKeyDown={event=>{
                  event.preventDefault();event.stopPropagation();
                }}>Stop key</button>
                <details><summary data-control="summary">Details</summary>Extra text</details>
              </div>}/>}</div>;
        }
        const root=createRoot(document.querySelector('#root'));
        const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
        const snapshot=()=>({top:viewport.scrollTop,owners,
          offset:reading.getBoundingClientRect().top-viewport.getBoundingClientRect().top});
        const touch=(target,type,positions)=>target.dispatchEvent(new TouchEvent(type,{
          bubbles:true,cancelable:true,touches:positions.map((clientY,identifier)=>
            new Touch({identifier,target,clientX:100,clientY}))}));
        window.fixture={
          async setup(){
            flushSync(()=>root.render(<App/>));
            for(let i=0;i<25;i++)await frame();
            handle.cancelScrollToIndex();
            reading=document.querySelector('[data-chat-message-id="row-80"]');
            dispose=installChatDetachedLayoutAnchor({root:viewport.firstElementChild,viewport,
              readLease:()=>1,acquireScrollAnchor:()=>{
                owners++;const release=acquireChatExternalScrollAnchor(handle);
                return()=>{owners--;release()};
              },prepareCorrection:()=>{handle.refreshItemSizes();handle.cancelScrollToIndex()},
              commitCorrection:()=>handle.refreshItemSizes(),
              positionAnchor:(element,offset)=>positionChatVirtualAnchor(element,offset,handle)});
            return snapshot();
          },
          gesture(kind){
            const inner=reading.querySelector('.inner');
            inner.scrollTop=100;
            if(kind==='ctrl')viewport.dispatchEvent(new WheelEvent('wheel',{
              deltaY:-100,ctrlKey:true,bubbles:true}));
            if(kind==='horizontal')viewport.dispatchEvent(new WheelEvent('wheel',{
              deltaX:100,bubbles:true}));
            if(kind==='prevented'){
              const event=new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true});
              event.preventDefault();viewport.dispatchEvent(event);
            }
            if(kind==='nested'||kind==='contained-edge'||kind==='chain-edge'){
              if(kind!=='nested')inner.scrollTop=500;
              if(kind==='contained-edge')inner.style.overscrollBehaviorY='contain';
              inner.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));
            }
            if(kind==='nested-key'){
              inner.focus({preventScroll:true});
              inner.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));
            }
            if(kind==='prevented-key'){
              const event=new KeyboardEvent('keydown',{key:'PageUp',bubbles:true,cancelable:true});
              event.preventDefault();viewport.dispatchEvent(event);
            }
            if(kind==='nested-touch'){
              touch(inner,'touchstart',[200]);touch(inner,'touchmove',[180]);
            }
            if(kind==='pinch'){
              touch(viewport,'touchstart',[200]);touch(viewport,'touchmove',[180,220]);
            }
            if(kind==='outer-touch'){
              touch(viewport,'touchstart',[200]);touch(viewport,'touchmove',[240]);
            }
            if(kind==='outer')viewport.dispatchEvent(new WheelEvent('wheel',{
              deltaY:-80,bubbles:true}));
            if(['outer','outer-touch','chain-edge'].includes(kind))viewport.scrollTop-=80;
            return snapshot();
          },
          async grow(){
            document.querySelector('[data-chat-message-id="row-79"]').style.height='365px';
            document.querySelector('[data-chat-message-id="row-81"]').style.height='235px';
            const samples=[];
            for(let i=0;i<20;i++){await frame();samples.push(snapshot())}
            return samples;
          },
          async settled(){for(let i=0;i<12;i++)await frame();return snapshot()},
          keyboardSnapshot(){return {...snapshot(),trustedKeys:window.trustedKeys,
            clicks:window.buttonClicks,selected:reading.querySelector('select').value,
            disclosureOpen:reading.querySelector('details').open}},
          dispose(){dispose();return owners}
        };
      `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const variants = [
    "ctrl",
    "horizontal",
    "prevented",
    "nested",
    "contained-edge",
    "nested-key",
    "prevented-key",
    "nested-touch",
    "pinch",
    "outer",
    "outer-touch",
    "chain-edge"
  ]
  for (const kind of variants) {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const before = (await page.evaluate("window.fixture.setup()")) as {
        top: number
        offset: number
        owners: number
      }
      const after = await page.evaluate(
        (kind) =>
          (
            window as unknown as { fixture: { gesture(kind: string): typeof before } }
          ).fixture.gesture(kind),
        kind
      )
      if (["outer", "outer-touch", "chain-edge"].includes(kind)) {
        assert.equal(after.owners, 0, `${kind}: outer scroll intent releases ownership`)
        const settled = (await page.evaluate("window.fixture.settled()")) as typeof before
        assert.equal(settled.top, after.top, `${kind}: do not undo genuine transcript scrolling`)
      } else {
        assert.equal(after.owners, 1, `${kind}: preserve ownership without outer scrolling`)
        const samples = (await page.evaluate("window.fixture.grow()")) as Array<typeof before>
        assert(
          samples.every((sample) => Math.abs(sample.offset - before.offset) <= 0.5),
          `${kind}: each sampled paint keeps the reading anchor after balanced layout growth`
        )
      }
      assert.equal(await page.evaluate("window.fixture.dispose()"), 0)
      assert.deepEqual(errors, [], kind)
    } finally {
      await page.close()
    }
  }
  console.log(`PASS native detached scroll ownership: ${variants.join(", ")}`)

  const keyboardCases = [
    { control: "button", key: "Space" },
    { control: "select", key: "ArrowDown" },
    { control: "cancelled", key: "PageDown" },
    { control: "stopped", key: "PageDown" },
    { control: "summary", key: "Space" },
    { control: "button", key: "PageDown", scrollsTranscript: true }
  ]
  for (const { control, key, scrollsTranscript } of keyboardCases) {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.evaluate("window.fixture.setup()")
      const target = page.locator(`[data-chat-message-id="row-80"] [data-control="${control}"]`)
      await target.focus()
      assert(
        await target.evaluate((node) => document.activeElement === node),
        `${control}: real key target must retain focus`
      )
      const before = (await page.evaluate("window.fixture.keyboardSnapshot()")) as {
        top: number
        offset: number
        owners: number
        trustedKeys: boolean[]
        clicks: number
        selected: string
        disclosureOpen: boolean
      }
      await page.keyboard.press(key)
      const after = (await page.evaluate("window.fixture.keyboardSnapshot()")) as typeof before
      assert.deepEqual(after.trustedKeys, [true], `${control}/${key}: use a trusted browser key`)
      if (scrollsTranscript) {
        // Native keyboard scroll animation must finish without the old anchor pulling it back.
        const settled = (await page.evaluate("window.fixture.settled()")) as typeof before
        assert(settled.top > before.top + 100, "Button PageDown still scrolls the transcript")
      } else {
        assert.equal(after.owners, 1, `${control}/${key}: native control keeps transcript anchor`)
        assert.equal(after.top, before.top, `${control}/${key}: no transcript navigation`)
        if (control === "button") assert.equal(after.clicks, 1, "Space still activates the button")
        if (control === "select")
          assert.equal(after.selected, "two", "Arrow selects the next option")
        if (control === "summary") assert.equal(after.disclosureOpen, true, "Space opens details")
        const samples = (await page.evaluate("window.fixture.grow()")) as Array<typeof before>
        assert(
          samples.every((sample) => Math.abs(sample.offset - before.offset) <= 0.5),
          `${control}/${key}: subsequent streamed reflow must retain the reading position`
        )
      }
      assert.equal(await page.evaluate("window.fixture.dispose()"), 0)
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  }
  console.log("PASS native keyboard controls, bubbled cancellation and transcript PageDown")
}
