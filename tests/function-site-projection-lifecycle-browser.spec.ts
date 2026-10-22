/** Actual renderer lifetimes with controlled protected bridge receipts; no model/user data. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const source = (file: string) => JSON.stringify(resolve("src/renderer/src", file))
const imports = `
  import {FunctionSite} from ${source("components/chat/FunctionSite.tsx")};
  import {ModsChatScope} from ${source("lib/mods-chat-scope.tsx")};
  import {FunctionSitePresentationCache} from ${source("lib/function-site-presentation.ts")};
`

export async function runFunctionSiteProjectionLifecycleBrowser() {
  const output = resolve("output/function-site-projection-lifecycle-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (name: string) => {
    checks.push(name)
    console.log("PASS " + name)
  }
  try {
    await mount(
      page,
      imports +
        `
      {const cache=new FunctionSitePresentationCache(()=>true),cards=new Set(),clicks=[];
      let held=false,release,pending=0,reads=0;
      const safe=props=>({...props,text:props.text.replaceAll('PRIVATE','SAFE')});
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteUnmount=async()=>{throw Error('PASSIVE_MUST_NOT_OWN')};
      window.api.mods.siteRead=async(t,component,props)=>{
        reads++;if(held){pending++;await new Promise(done=>release=done);pending--}
        return{state:'projected',snapshot:{scopeId:'scope',key:'row',version:'v-'+reads,
          expiresAt:Date.now()+120000,data:{component,tree:{type:'engine',ref:0},
          nativeContent:{component,entries:[{ref:0,props:safe(props)}]}}}}
      };
      function Fixture(){const [text,setText]=useState('PRIVATE first paragraph');
        const label=text==='PRIVATE first paragraph'?'initial':'changed';
        window.projection={pending:()=>pending,reads:()=>reads,clicks,
          change:value=>{held=true;setText(value)},release:()=>{held=false;release?.()},
          notify:scope=>{cache.invalidateProjection('row');for(const fn of cards)fn({threadId:'a',scope})}};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
          <FunctionSite threadId='a' component='AssistantMessage' presentationId='row'
            facts={{text,isFirstOfReply:true}} renderNative={props=><div>
              <p data-safe-body data-delegate={label}>{props.text}</p>
              <button data-copy onClick={()=>clicks.push(label)}>Copy safe body</button>
            </div>}/>
        </ModsChatScope.Provider>;
      }host.render(<Fixture/>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.locator("[data-safe-body]").waitFor()
    await page.evaluate(`window.savedProjectionBody=document.querySelector('[data-safe-body]')`)
    await page.evaluate(`window.projection.change('PRIVATE first paragraph next token')`)
    await page.waitForFunction("window.projection.pending()===1")
    assert.equal(await page.locator("[data-safe-body]").textContent(), "SAFE first paragraph")
    assert.equal(await page.locator("[data-safe-body]").getAttribute("data-delegate"), "initial")
    assert.equal(
      await page.evaluate(
        `document.querySelector('[data-safe-body]')===window.savedProjectionBody`
      ),
      true
    )
    assert.equal(await page.locator("[data-function-site-projected]").getAttribute("inert"), "")
    await page.locator("[data-copy]").evaluate((button: HTMLButtonElement) => button.click())
    assert.deepEqual(await page.evaluate("window.projection.clicks"), [])
    assert(
      !(await page
        .locator("body")
        .innerText()
        .then((text) => text.includes("PRIVATE")))
    )
    await page.evaluate("window.projection.release()")
    await page.waitForFunction(
      `document.querySelector('[data-safe-body]')?.textContent==='SAFE first paragraph next token'`
    )
    await page.locator("[data-copy]").click()
    assert.deepEqual(await page.evaluate("window.projection.clicks"), ["changed"])
    pass(
      "append retains the committed protected DOM and delegate, with old-input interactions inert"
    )

    await page.evaluate(`window.projection.change('PRIVATE replacement')`)
    await page.waitForFunction("window.projection.pending()===1")
    assert.equal(await page.locator("[data-safe-body]").count(), 0)
    // A -> B -> A cannot revive the old protected data or its native callback.
    await page.evaluate(`window.projection.change('PRIVATE first paragraph next token')`)
    assert.equal(await page.locator("[data-safe-body]").count(), 0)
    await page.evaluate("window.projection.release()")
    await page.waitForFunction(
      `document.querySelector('[data-safe-body]')?.textContent==='SAFE first paragraph next token'`
    )
    pass("non-append replacement and ABA revoke display until a new exact-input protected read")

    await page.evaluate(`window.projection.change('PRIVATE first paragraph next token append')`)
    await page.waitForFunction("window.projection.pending()===1")
    await page.evaluate("window.projection.notify('site-projection:row')")
    assert.equal(await page.locator("[data-safe-body]").count(), 0)
    await page.evaluate("window.projection.release()")
    await page.waitForFunction(
      `document.querySelector('[data-safe-body]')?.textContent?.endsWith(' append')`
    )
    pass(
      "real dependency invalidation immediately revokes a retained prefix and rejects the in-flight ticket"
    )

    await mount(
      page,
      imports +
        `
      {const cache=new FunctionSitePresentationCache(()=>true),cards=new Set(),clicks=[],ownedRequests=[];
      let reads=0,held=false,release,pending=false;
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRead=async(t,component,props,id,_message,_question,ownerRequired)=>{
        reads++;await new Promise(done=>setTimeout(done,10));
        if(id==='job-0'&&held){pending=true;await new Promise(done=>release=done);pending=false}
        if(ownerRequired){ownedRequests.push(id);return{state:'mounted',owner:'owner-'+id,
          snapshot:{key:'engine:'+id,id,plugin:'engine',generation:'generation-'+id,
            title:component,rows:8,closeOnEscape:false,tree:{type:'engine',ref:0},
            nativeContent:{component,entries:[{ref:0,props}]}}}}
        return{state:'projected',snapshot:{scopeId:'scope',key:id,version:'v-'+reads,expiresAt:Date.now()+120000,
          data:{component,tree:{type:'engine',ref:0},nativeContent:{component,entries:[{ref:0,props}]}}}}
      };
      function Fixture(){const [tick,setTick]=useState(0);window.projection={reads:()=>reads,clicks,ownedRequests,
        pending:()=>pending,tick:()=>setTick(t=>t+1),invalidate:()=>{held=true;cache.invalidateProjection('job-0');
          for(const fn of cards)fn({threadId:'a',scope:'site-projection:job-0'})},
        release:()=>{held=false;release?.()}};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
          <div data-tick={tick}>{Array.from({length:100},(_,i)=><FunctionSite key={i} threadId='a' component='CommandOutput'
            presentationId={'job-'+i} facts={{command:'job',args:'***',text:'SAFE '+i,isErrored:false}}
            renderNative={props=><div><p data-safe-body={i}>{props.text}</p>
              <button data-copy={i} onClick={()=>clicks.push(i)}>Copy {i}</button></div>}/>)}</div>
        </ModsChatScope.Provider>;
      }host.render(<Fixture/>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.waitForFunction(`document.querySelectorAll('[data-safe-body]').length===100`)
    assert.equal(await page.evaluate("window.projection.reads()"), 100)
    await page.evaluate("window.projection.tick()")
    await page.waitForFunction(
      `document.querySelector('[data-tick]')?.getAttribute('data-tick')==='1'`
    )
    assert.equal(await page.locator("[data-safe-body]").count(), 100)
    assert.equal(await page.evaluate("window.projection.reads()"), 100)
    await page.locator('[data-copy="0"]').click()
    assert.deepEqual(await page.evaluate("window.projection.clicks"), [0])
    pass(
      "100 valid command-output slots survive the 96-admission cache bound without blank rows or retries"
    )

    await page.evaluate("window.projection.invalidate()")
    await page.waitForFunction("window.projection.pending()")
    assert.equal(await page.locator('[data-safe-body="0"]').count(), 0)
    assert.equal(await page.locator("[data-safe-body]").count(), 99)
    await page.evaluate("window.projection.release()")
    await page.waitForFunction(`document.querySelectorAll('[data-safe-body]').length===100`)
    assert.equal(await page.evaluate("window.projection.reads()"), 101)
    assert.deepEqual(await page.evaluate("window.projection.ownedRequests"), ["job-0"])
    pass(
      "real host invalidation still revokes the exact active row even after cache admission eviction"
    )

    await mount(
      page,
      imports +
        `
      {const cache=new FunctionSitePresentationCache(()=>true);let reads=0,held=false,release;
      window.api.mods.onCardsChanged=()=>()=>{};window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteRead=async(t,component,props)=>{
        reads++;if(held)await new Promise(done=>release=done);
        return{state:'projected',snapshot:{scopeId:'unretained:child-read',key:'child',version:'v',expiresAt:0,
          data:{component,hostMessage:{...props,text:'SAFE CHILD '.repeat(1200)}}}}
      };
      function Fixture(){const [visible,setVisible]=useState(true);window.projection={reads:()=>reads,
        hide:()=>setVisible(false),show:()=>{held=true;setVisible(true)},release:()=>{held=false;release?.()}};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
          {visible&&<FunctionSite threadId='a' component='AssistantMessage' presentationId='child'
            facts={{text:'PRIVATE CHILD '.repeat(1200),isFirstOfReply:true}}
            renderNative={props=><p data-safe-body>{props.text}</p>}/>}
        </ModsChatScope.Provider>;
      }host.render(<Fixture/>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.locator("[data-safe-body]").waitFor()
    await page.evaluate("window.projection.hide()")
    await page.waitForFunction(`!document.querySelector('[data-function-site]')`)
    await page.evaluate("window.projection.show()")
    await page.waitForFunction("window.projection.reads()===2")
    assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
    assert.equal(await page.locator("[data-safe-body]").count(), 0)
    await page.evaluate("window.projection.release()")
    await page.locator("[data-safe-body]").waitFor()
    assert(
      !(await page
        .locator("body")
        .innerText()
        .then((text) => text.includes("PRIVATE")))
    )
    pass(
      "native-child unretained messages are live display data and never enter the renderer history cache"
    )
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "results.json"), JSON.stringify({ checks, errors }, null, 2))
  } finally {
    await browser.close()
  }
}

if (resolve(process.argv[1] ?? "") === resolve(__filename))
  void runFunctionSiteProjectionLifecycleBrowser().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
