/** Native Chromium frame-boundary geometry: production ChatContainer, virtual list, controller,
 * Radix viewport and installed react-virtuoso. Only IPC and presentation leaves are fixtures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { buildFollowingFixture } from "./support/chat-following-fixture"

interface Sample {
  top: number
  gap: number
  height: number
  readable: string[]
  detached: boolean
  dialogTop?: number
  dialogHeight?: number
  tailBottom?: number
  inputReadable?: boolean
}

async function main(): Promise<void> {
  const bundle = await buildFollowingFixture()
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const results: Record<string, unknown> = {}
  const artifacts = resolve(
    process.env.CHAT_FOLLOWING_ARTIFACTS ?? "output/chat-deferred-measurement-following"
  )
  mkdirSync(artifacts, { recursive: true })
  const checkFollowing = (name: string, samples: Sample[], maxGrowth: number) => {
    assert(
      samples.every((sample) => sample.readable.length > 0),
      `${name}: blank readable frame-boundary geometry: ${JSON.stringify(samples)}`
    )
    assert(
      samples.every((sample) => !sample.detached),
      `${name}: layout detached the controller`
    )
    assert(
      Math.max(...samples.map((sample) => sample.gap)) <= maxGrowth + 2,
      `${name}: bottom drift exceeded the actual growth: ${JSON.stringify(samples)}`
    )
    // Native RO + the existing controller may take several frames. Require every settled
    // sample, not just the final screenshot, to follow; continuous streaming is checked below.
    assert(
      samples.slice(6).every((sample) => sample.gap <= 2),
      `${name}: failed to settle within six frame boundaries: ${JSON.stringify(samples)}`
    )
    results[name] = {
      frames: samples.length,
      maxGap: Math.max(...samples.map((sample) => sample.gap)),
      final: samples.at(-1),
      samples
    }
  }
  try {
    await page.setContent(`<style>${bundle.css}</style><style>
      #root{height:100vh;display:flex;overflow:hidden}
      [data-fixture-footer] p{margin:0;line-height:24px}
    </style><div id="root"></div>`)
    await page.addScriptTag({
      content: `window.__name=value=>value;
      window.heldMeasurements=[];window.holdNativeMeasurement=false;
      const nativeRAF=window.requestAnimationFrame.bind(window);let inNativeListRO=false;
      const NativeRO=window.ResizeObserver;
      window.ResizeObserver=class extends NativeRO{constructor(callback){super((entries,observer)=>{
        const previous=inNativeListRO;
        inNativeListRO=entries.some(entry=>entry.target.getAttribute('data-testid')==='virtuoso-item-list');
        try{callback(entries,observer)}finally{inNativeListRO=previous}
      })}};
      window.requestAnimationFrame=callback=>{
        if(inNativeListRO&&window.holdNativeMeasurement){window.heldMeasurements.push(callback);return -window.heldMeasurements.length}
        return nativeRAF(callback)
      };
      window.scrollWriteAttempts=[];
      const topDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
      Object.defineProperty(Element.prototype,'scrollTop',{...topDescriptor,set(value){
        if(window.monitorScrollWrites)window.scrollWriteAttempts.push({kind:'scrollTop',value,connected:this.isConnected});
        topDescriptor.set.call(this,value)
      }});
      const nativeScrollTo=Element.prototype.scrollTo;
      Element.prototype.scrollTo=function(...args){
        if(window.monitorScrollWrites)window.scrollWriteAttempts.push({kind:'scrollTo',args,connected:this.isConnected});
        return nativeScrollTo.apply(this,args)
      };
    `
    })
    await page.addScriptTag({ content: bundle.script })
    await page.waitForFunction(`window.followingFixture?.sample().readable.length > 0`)
    await page.evaluate(`window.followingFixture.frames(30)`)
    const initial = (await page.evaluate(`window.followingFixture.sample()`)) as Sample
    assert(initial.height > 300 && initial.gap <= 2 && !initial.detached, JSON.stringify(initial))
    results.initial = initial

    // Each stream update occurs in a different real animation frame. There is no fixture
    // scroll write; the real container's content events and queued positioning own following.
    const streaming = (await page.evaluate(`(async()=>{
      const f=window.followingFixture,samples=[];
      f.streamStore.setState({isLoading:true});await f.frames(10);
      for(let i=0;i<20;i++){f.grow(1);await f.frames(1);samples.push(f.sample())}
      return [...samples,...await f.record(()=>{},12)]
    })()`)) as Sample[]
    assert(
      streaming.every((sample) => sample.readable.length > 0 && !sample.detached),
      JSON.stringify(streaming)
    )
    assert(
      Math.max(...streaming.map((sample) => sample.gap)) <= 4 * 24 + 2,
      JSON.stringify(streaming)
    )
    assert(
      streaming.slice(-6).every((sample) => sample.gap <= 2),
      JSON.stringify(streaming)
    )
    results.streaming = {
      frames: streaming.length,
      maxGap: Math.max(...streaming.map((sample) => sample.gap)),
      final: streaming.at(-1),
      samples: streaming
    }

    const tool = (await page.evaluate(
      `window.followingFixture.record(()=>window.followingFixture.grow(4))`
    )) as Sample[]
    checkFollowing("tail-body-growth", tool, 96)
    const toolCard = (await page.evaluate(`window.followingFixture.record(()=>{
      const f=window.followingFixture,s=f.threadStore.getState();
      f.threadStore.setState({messages:s.messages.map((m,i)=>i===s.messages.length-1?
        {...m,tool_calls:[{id:'tool-1',name:'fixture_tool',args:{output:'Readable tail tool result\\n'.repeat(3)}}]}:m),
        messagesContentVersion:s.messagesContentVersion+1})
    })`)) as Sample[]
    checkFollowing("tail-tool-card-growth", toolCard, 72)
    assert(toolCard.at(-1)!.top > toolCard[0].top + 60, "Tool presentation must actually grow")
    const footer =
      (await page.evaluate(`window.followingFixture.record(()=>window.followingFixture.threadStore.setState({
      todos:Array.from({length:4},(_,i)=>({id:String(i),status:'pending',content:'Pending tool footer '+i}))}))`)) as Sample[]
    checkFollowing("footer-growth", footer, 108)
    assert(
      footer.at(-1)!.top > footer[0].top + 80,
      "Fixture footer must actually increase measured height"
    )

    const inputCard = (await page.evaluate(`window.followingFixture.record(()=>{
      window.followingFixture.threadStore.setState({pendingUserInput:{requestId:'input-1',threadId:'following-a',
        createdAt:new Date().toISOString(),questions:[{id:'choice',header:'Choice',question:'Choose the next step',
        options:[{label:'Continue',description:'Continue the task'},{label:'Pause',description:'Pause the task'}]}]}})
    },24)`)) as Sample[]
    results.inputCard = inputCard
    assert(
      inputCard.every(
        (sample) => (sample.readable.length > 0 || sample.inputReadable) && !sample.detached
      ),
      JSON.stringify(inputCard)
    )
    assert((inputCard.at(-1)!.dialogHeight ?? 0) >= 300, "The actual input dialog must mount")
    const growingCard = (await page.evaluate(`window.followingFixture.record(()=>{
      const s=window.followingFixture.threadStore.getState(),request=s.pendingUserInput;
      window.followingFixture.threadStore.setState({pendingUserInput:{...request,questions:[{...request.questions[0],
        options:Array.from({length:3},(_,i)=>({label:'Option '+i,description:('Additional input card details '+i+' ').repeat(5)}))}]}})
    },24)`)) as Sample[]
    results.growingInputCard = growingCard
    await page.screenshot({ path: resolve(artifacts, "grown-input-card.png") })
    assert(
      growingCard.every(
        (sample) => (sample.readable.length > 0 || sample.inputReadable) && !sample.detached
      ),
      JSON.stringify(growingCard)
    )
    await page.getByRole("button", { name: "Option 1", exact: false }).click()
    await page
      .getByRole("button", { name: "提交", exact: true })
      .isEnabled()
      .then((enabled) => assert(enabled, "The visible real question card must accept a selection"))
    assert(
      growingCard.at(-1)!.dialogHeight! > growingCard[0].dialogHeight! + 30,
      "Input card must actually grow"
    )
    assert(
      growingCard.slice(-6).every((sample) => sample.tailBottom! <= sample.dialogTop! - 10),
      `Following should keep the tail above the actual input dialog: ${JSON.stringify(growingCard)}`
    )
    await page.evaluate(
      `window.followingFixture.threadStore.setState({pendingUserInput:null});window.followingFixture.frames(24)`
    )

    const viewport = (await page.evaluate(`window.followingFixture.record(()=>{
      document.querySelector('textarea.composer-textarea').style.height='180px'
    })`)) as Sample[]
    checkFollowing(
      "composer-viewport-growth",
      viewport,
      viewport[0].height - viewport.at(-1)!.height
    )
    assert(
      viewport.at(-1)!.height < viewport[0].height - 80,
      "Composer growth must shrink the real viewport"
    )
    await page.evaluate(`window.resizeSamples=[window.followingFixture.sample()];window.recordResize=true;
      const sampleResize=async()=>{while(window.recordResize){
        await window.followingFixture.frames(1);
        if(window.recordResize)window.resizeSamples.push(window.followingFixture.sample())
      }};void sampleResize()`)
    await page.setViewportSize({ width: 1100, height: 760 })
    await page.evaluate(`window.followingFixture.frames(16)`)
    const resized = (await page.evaluate(
      `window.recordResize=false;window.resizeSamples`
    )) as Sample[]
    checkFollowing("window-viewport-shrink", resized, 140)

    await page.locator("[data-radix-scroll-area-viewport]").hover()
    await page.mouse.wheel(0, -360)
    await page.waitForFunction(`window.followingFixture.sample().detached`)
    await page.evaluate(`window.followingFixture.frames(8)`)
    const detached = (await page.evaluate(
      `window.followingFixture.record(()=>window.followingFixture.grow(5))`
    )) as Sample[]
    assert(
      detached.every((sample) => sample.detached && sample.readable.length > 0),
      JSON.stringify(detached)
    )
    assert(
      detached.every((sample) => Math.abs(sample.top - detached[0].top) <= 2),
      `Detached output stole position: ${JSON.stringify(detached)}`
    )
    results.detached = detached
    await page.getByRole("button", { name: "回到会话底部", exact: true }).click()
    await page.evaluate(`window.followingFixture.frames(20)`)
    const returned = (await page.evaluate(
      `window.followingFixture.record(()=>window.followingFixture.grow(2))`
    )) as Sample[]
    checkFollowing("return-to-bottom-resumes", returned, 48)

    // Hold only RAF scheduled by the installed Virtuoso's list ResizeObserver. Release the
    // real closures after their old elements were unmounted and a new list has settled.
    await page.evaluate(`window.holdNativeMeasurement=true;window.followingFixture.grow(3)`)
    await page.waitForFunction(`window.heldMeasurements.length>0`, null, { timeout: 5000 })
    await page.evaluate(
      `window.holdNativeMeasurement=false;window.followingFixture.unmount();window.followingFixture.mount('following-b')`
    )
    await page.evaluate(`window.followingFixture.frames(30)`)
    const stale = (await page.evaluate(`window.followingFixture.record(()=>{
      window.monitorScrollWrites=true;
      window.releasedMeasurementCount=window.heldMeasurements.length;
      for(const callback of window.heldMeasurements.splice(0))callback(performance.now())
    })`)) as Sample[]
    assert(
      stale.every(
        (sample) => sample.readable.length > 0 && Math.abs(sample.top - stale[0].top) <= 2
      ),
      JSON.stringify(stale)
    )
    assert.deepEqual(
      await page.evaluate("window.scrollWriteAttempts"),
      [],
      "Old measurement callbacks must not attempt scroll writes"
    )
    results.staleNativeCallbacks = {
      count: await page.evaluate("window.releasedMeasurementCount"),
      samples: stale
    }
    assert.deepEqual(errors, [], "Browser errors include ResizeObserver loop errors")
    console.log(
      JSON.stringify(
        results,
        (key, value) =>
          key === "samples"
            ? undefined
            : Array.isArray(value) && value.length > 8
              ? { frames: value.length, first: value[0], final: value.at(-1) }
              : value,
        2
      )
    )
    console.log(
      "PASS: real ChatContainer frame-boundary geometry preserves following and detachment"
    )
  } finally {
    writeFileSync(resolve(artifacts, "results.json"), JSON.stringify({ results, errors }, null, 2))
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
