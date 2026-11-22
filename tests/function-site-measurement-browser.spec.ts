/** Real protected drawing/placeholder geometry; held bridge reads never expose raw fallback. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/function-site-measurement-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSitePresentationCache,functionSitePresentationKey} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-presentation.ts"))};
      {const cache=new FunctionSitePresentationCache(()=>true),events=new Set();
      let hold=false,pending=[],reads=0;
      window.api.mods.onCardsChanged=fn=>{events.add(fn);return()=>events.delete(fn)};
      window.api.mods.siteUnmount=async()=>{throw Error('PASSIVE_MUST_NOT_OWN')};
      window.api.mods.siteRead=async(t,component,props)=>{
        reads++;if(hold)await new Promise(done=>pending.push(done));
        return {state:'projected',snapshot:{scopeId:'scope',key:'host-row',version:'v'+reads,
          expiresAt:Date.now()+120000,data:{component,tree:{type:'engine',ref:0},
          nativeContent:{component,entries:[{ref:0,props:{...props,text:'SAFE_VERIFIED_BODY'}}]}}}}
      };
      function Fixture(){const[visible,show]=useState(true),[width,resize]=useState(600),
        [bubbleWidth,shrink]=useState(600);
        window.measurement={show,resize,pending:()=>pending.length,release:()=>{hold=false;pending.splice(0).forEach(done=>done())},
          evictBody:()=>{shrink(160);for(let i=0;i<110;i++)cache.saveData(
            functionSitePresentationKey('a','AssistantMessage','other-'+i,'{}',window.innerWidth),
            {component:'AssistantMessage',tree:{type:'Text',props:{},children:['safe other']}},
            20,cache.capture('AssistantMessage'),600);hold=true},
          revoke:()=>{cache.invalidateProjection('host-row');for(const fn of events)fn({threadId:'a',scope:'site-projection:host-row'})}};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
          <div data-chat-message-row style={{width}}><div data-allocated style={{width:bubbleWidth}}>{visible&&<FunctionSite threadId='a' component='UserMessage'
            className='contents' presentationId='row' facts={{text:'PRIVATE_RAW_BODY',origin:{kind:'unclassified'},isExpanded:false}}
            fallback={<div>PRIVATE_UNVERIFIED_FALLBACK</div>}
            renderNative={safe=><div data-safe style={{height:320}}>{safe.text}</div>}/>}</div></div>
        </ModsChatScope.Provider>
      }host.render(<Fixture/>)}
    `, [browserWorkerPlugin()])
    await page.locator("[data-safe]").waitFor()
    await page.evaluate(() => new Promise<void>(done =>
      requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const verified = await page.locator("[data-allocated]").evaluate(node => node.getBoundingClientRect().height)
    assert.equal(verified, 320)
    await page.evaluate("window.measurement.show(false)")
    await page.locator("[data-function-site]").waitFor({ state: "detached" })
    await page.evaluate("window.measurement.evictBody();window.measurement.show(true)")
    await page.waitForFunction("window.measurement.pending()===1")
    assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
    const reserved = await page.locator("[data-function-site-pending]").evaluate(node =>
      node.getBoundingClientRect().height)
    assert.equal(reserved, verified, "Recycled pending row must keep its verified geometry after body eviction")
    assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
    assert.equal(await page.locator("[data-safe]").count(), 0)
    await page.evaluate("window.measurement.resize(480)")
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-function-site-pending]")?.style.minHeight === "")
    await page.evaluate("window.measurement.resize(600)")
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-function-site-pending]")?.style.minHeight === "320px")
    await page.evaluate("window.measurement.revoke()")
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-function-site-pending]")?.style.minHeight === "")
    await page.evaluate("window.measurement.release()")
    await page.locator("[data-safe]").waitFor()
    assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "verified-restored.png") })
    await mount(page, `
      import {observeFunctionSiteGeometry} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-geometry.ts"))};
      const OriginalObserver=window.ResizeObserver;
      const observed=[];
      let observers=0,disconnected=0;
      window.ResizeObserver=class extends OriginalObserver{
        constructor(callback){super(callback);observers++}
        observe(target){observed.push(target.id);super.observe(target)}
        disconnect(){disconnected++;super.disconnect()}
      };
      const row=document.createElement('div');
      row.id='geometry-row';row.dataset.chatMessageRow='';row.style.width='500px';
      row.innerHTML='<div id="geometry-parent"><section id="geometry-a" style="display:contents"><div style="height:20px">A</div></section><section id="geometry-b" style="display:contents"><div style="height:20px">B</div></section></div>';
      document.body.append(row);
      const samples=[null,null];
      let layoutReads=0;
      const readWidth=Object.getOwnPropertyDescriptor(Element.prototype,'clientWidth').get;
      Object.defineProperty(row,'clientWidth',{get(){layoutReads++;return readWidth.call(row)}});
      const stops=['geometry-a','geometry-b'].map((id,i)=>observeFunctionSiteGeometry(
        document.getElementById(id),value=>{
          if(samples[i]?.width!==value.layoutWidth)samples[i]={width:value.layoutWidth,layoutReads}
        }
      ));
      window.resizeFixture={facts:()=>({observers,observed,disconnected,samples}),
        removeFirst:()=>{stops[0]();document.getElementById('geometry-a').remove()},
        resize:()=>{row.style.width='420px'},close:()=>{stops[1]();window.ResizeObserver=OriginalObserver}};
    `, [browserWorkerPlugin()])
    await page.waitForFunction("window.resizeFixture.facts().samples.every(value=>value?.width===500)")
    assert.deepEqual(await page.evaluate("window.resizeFixture.facts()"), {
      observers: 1, observed: ["geometry-a", "geometry-parent", "geometry-b"],
      disconnected: 0, samples: [{ width: 500, layoutReads: 1 }, { width: 500, layoutReads: 1 }]
    })
    await page.evaluate("window.resizeFixture.removeFirst();window.resizeFixture.resize()")
    await page.waitForFunction("window.resizeFixture.facts().samples[1]?.width===420")
    await page.evaluate("window.resizeFixture.close()")
    assert.equal(await page.evaluate("window.resizeFixture.facts().disconnected"), 1)
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ verified, reserved, errors,
      checks: ["body LRU eviction retains neutral height inside a shrink-to-fit user bubble", "width mismatch rejects measurement",
        "dependency change clears measurement", "held read exposes no unverified body",
        "one shared resize observer retains a containing message until its last drawing leaves"] }, null, 2))
    console.log("PASS verified row height survives body eviction; width/source changes invalidate it without displaying raw fallback")
  } finally { await browser.close() }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
