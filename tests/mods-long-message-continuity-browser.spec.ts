/** Real protected surfaces: mode transitions and bounded large-message remounts. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-long-message-continuity-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = [],
    evidence: unknown[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const act = (script: string) => page.evaluate(script)
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
  try {
    for (const scenario of [
      "owned-boundary",
      "projected-boundary",
      "large-assistant",
      "large-user"
    ]) {
      await mount(
        page,
        `
        import {ModsChatScope} from './src/renderer/src/lib/mods-chat-scope';
        import {FunctionMessageText} from './src/renderer/src/components/chat/FunctionMessageText';
        import {FunctionSitePresentationCache} from './src/renderer/src/lib/function-site-presentation';
        {
          const scenario=${JSON.stringify(scenario)}, reads=[], releases=[], cards=new Set(), caches=new Map(), owners=new Map();
          let held=false,authorized=true,sequence=0,epoch=0;
          const large=scenario.startsWith('large-');
          const makeText=count=>'RAW_HEAD'+'x'.repeat(count-16)+'RAW_TAIL';
          const protect=props=>({...props,text:props.text.replaceAll('RAW','PUB')});
          const gate=async()=>{if(held)await new Promise(done=>releases.push(done))};
          window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
          window.api.mods.onConfigurationChanged=()=>()=>{};
          window.api.mods.siteRead=async(thread,component,props,id)=>{
            reads.push({kind:'read',thread,length:props.text.length});
            if(scenario==='owned-boundary'&&props.text.length<=10000){const owner='owner-'+(++sequence);owners.set(owner,{component});return{state:'mounted',owner}}
            await gate();
            return{state:'projected',snapshot:{scopeId:'scope-'+thread,key:'host-'+thread+'-'+id,
              version:'v1',expiresAt:Date.now()+120000,data:{component,hostMessage:protect(props)}}};
          };
          window.api.mods.siteRender=async(thread,owner,props)=>{
            reads.push({kind:'render',thread,length:props.text.length});
            if(props.text.length>10000)throw Error('Host message entered the owned guest API');
            await gate();
            return{key:'engine:'+owner,id:owner,plugin:'fixture',generation:'g-'+owner,title:'Native',rows:12,closeOnEscape:false,
              tree:{type:'engine',ref:0},nativeContent:{component:owners.get(owner).component,entries:[{ref:0,props:protect(props)}]}};
          };
          window.api.mods.siteUnmount=async(thread,owner)=>{reads.push({kind:'unmount',thread,owner});owners.delete(owner)};
          const cache=id=>{if(!caches.has(id))caches.set(id,new FunctionSitePresentationCache(()=>authorized));return caches.get(id)};
          function Chat({thread,text,version}){
            const captured=epoch;
            return <ModsChatScope.Provider value={{threadId:thread,enabled:true,ready:true,isCurrent:()=>authorized&&captured===epoch,presentationCache:cache(thread)}}>
              <div data-radix-scroll-area-viewport data-version={version} style={{height:650,width:600,overflow:'auto'}}>
                <div data-chat-message-row style={{minHeight:70}}>
                  <FunctionMessageText threadId={thread} messageId='message' role={scenario==='large-user'?'user':'assistant'}
                    text={text} isExpanded isFirstOfReply fallback={<p data-unprotected>{text}</p>}
                    renderText={safe=><div data-audit-body style={{height:70,overflow:'hidden'}}>{safe}</div>}/>
                </div>
              </div>
            </ModsChatScope.Provider>;
          }
          function Fixture(){const[thread,setThread]=useState('A'),[text,setText]=useState(makeText(large?100000:9999)),[version,setVersion]=useState(0);
            window.continuity={reads,waiting:()=>releases.length,hold:()=>held=true,
              text:length=>setText(previous=>!large&&length>=previous.length?previous+'x'.repeat(length-previous.length):makeText(length)),go:setThread,
              render:()=>setVersion(v=>v+1),revoke:()=>{authorized=false;epoch++;setVersion(v=>v+1)},
              source:()=>{cache(thread).invalidate();for(const fn of cards)fn({threadId:thread,scope:'site-presentations:*'})},
              release:()=>{held=false;releases.splice(0).forEach(done=>done())}};
            return <Chat key={thread} thread={thread} text={text} version={version}/>;
          }
          host.render(<Fixture/>);
        }
      `,
        [browserWorkerPlugin()]
      )
      await page.locator("[data-audit-body]").first().waitFor()
      await settle()
      if (scenario.endsWith("boundary")) {
        await act("window.continuity.text(10000)")
        await page.waitForFunction(
          "document.querySelector('[data-audit-body]')?.textContent?.length===10000"
        )
        await act("window.continuity.hold();window.continuity.text(10001)")
        await page.waitForFunction("window.continuity.waiting()===1")
        await settle()
        assert.equal(await page.locator("[data-audit-body]").count(), 1)
        assert.equal((await page.locator("[data-audit-body]").textContent())?.length, 10000)
        assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
        assert.equal(await act("window.continuity.reads.filter(x=>x.kind==='unmount').length"), 0)
        await act("window.continuity.release()")
        await page.waitForFunction(
          "document.querySelector('[data-audit-body]')?.textContent?.length===10001"
        )
        if (scenario === "owned-boundary")
          assert.equal(await act("window.continuity.reads.filter(x=>x.kind==='unmount').length"), 1)
      } else {
        await act("window.continuity.go('B')")
        await page.locator("[data-function-site-projected]").waitFor()
        await settle()
        await act("window.continuity.hold();window.continuity.go('A')")
        await page.waitForFunction("window.continuity.waiting()===1")
        await settle()
        assert.equal(await page.locator("[data-function-site-cached]").count(), 1)
        assert.equal(await page.locator("[data-audit-body]").count(), 2)
        assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
        assert.equal(await page.locator("[data-function-message-preview]").count(), 1)
        const retained = await page.locator("[data-audit-body]").allTextContents()
        assert(retained[0].startsWith("PUB_HEAD"))
        assert(retained[1].endsWith("PUB_TAIL"))
        assert(retained.join("").length < 60000)
        // A resize may reflow this already committed protected preview, never raw text.
        await page.setViewportSize({ width: 1100, height: 800 })
        await act("window.continuity.render()")
        await settle()
        assert.equal(await page.locator("[data-function-site-cached]").count(), 1)
        assert.equal(await page.locator("[data-audit-body]").count(), 2)
        await act("window.continuity.release()")
        await page.waitForFunction(
          "document.querySelector('[data-function-site-projected] [data-audit-body]')?.textContent?.length===100000"
        )
        // A second keyed remount exercises virtual-row recycling as well as navigation.
        await act("window.continuity.go('B')")
        await page.locator("[data-function-site-projected]").waitFor()
        await settle()
        await act("window.continuity.hold();window.continuity.go('A')")
        await page.waitForFunction("window.continuity.waiting()===1")
        await settle()
        assert.equal(await page.locator("[data-function-site-cached]").count(), 1)
        await act("window.continuity.source()")
        await settle()
        assert.equal(await page.locator("[data-audit-body]").count(), 0)
        await act("window.continuity.release()")
        await page.locator("[data-audit-body]").first().waitFor()
      }
      assert.equal(await page.locator("[data-unprotected]").count(), 0)
      assert.equal((await page.locator("body").innerText()).includes("RAW_HEAD"), false)
      await act("window.continuity.revoke()")
      await settle()
      assert.equal(await page.locator("[data-audit-body]").count(), 0)
      assert.equal(await page.locator("[data-unprotected]").count(), 0)
      evidence.push({
        scenario,
        protectedContinuity: true,
        calls: await act("window.continuity.reads")
      })
    }
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ evidence, errors }, null, 2))
    console.log("PASS protected message mode boundaries, large remounts, resize and revocation")
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {})
    console.error(
      await page
        .locator("body")
        .innerText()
        .then((text) => text.slice(-1500))
    )
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
