/** A committed cached view may bridge normal progress, never a real invalidation. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

export async function runFunctionSiteCachedProgressBrowser() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    const cases = [
      ...["AssistantMessage", "ToolGroup"].flatMap((component) =>
        ["aba", "projection", "source", "takeover"].map((scenario) => [component, scenario])),
      ...["UserMessage", "AssistantMessage", "CommandOutput"].flatMap((component) =>
        ["width-source", "width-projection", "width-key", "width-authorization",
          "width-aba", "width-expiry", "width-remount"].map((scenario) => [component, scenario])),
      ...["AssistantMessage", "ToolGroup"].map((component) => [component, "width-progress"])
    ]
    for (const [component, scenario] of cases) {
      await page.setViewportSize({ width: 1280, height: 800 })
      await mount(
        page,
        `
        import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
        import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
        import {FunctionSitePresentationCache,functionSitePresentationKey} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-presentation.ts"))};
        {let authorized=true;const component=${JSON.stringify(component)},cache=new FunctionSitePresentationCache(()=>authorized),cards=new Set(),pending=[],clicks=[];
        const call={tool_use_id:'a',tool:'read_file',input:{path:'PRIVATE'},isRunning:true,isErrored:false,isInterrupted:false};
        const initial=component==='ToolGroup'?{calls:[call],isActive:true,isExpanded:false}:{text:'PRIVATE a',isFirstOfReply:true};
        const progress=component==='ToolGroup'?{...initial,calls:[{...call,isRunning:false,output:'DONE'}]}:{...initial,text:'PRIVATE ab'};
        const additional=component==='ToolGroup'?{...progress,calls:[...progress.calls,{...call,tool_use_id:'b'}]}:{...initial,text:'PRIVATE abc'};
        const replacement=component==='ToolGroup'?{...initial,calls:[{...call,input:{path:'OTHER'}}]}:{...initial,text:'OTHER'};
        const safe=props=>component==='ToolGroup'?{...props,calls:props.calls.map(c=>({...c,input:{path:'SAFE'}}))}:{...props,text:props.text.replace('PRIVATE','SAFE')};
        const data=props=>component==='AssistantMessage'?{component,hostMessage:safe(props)}:{component,tree:{type:'engine',ref:0},nativeContent:{component,entries:[{ref:0,props:safe(props)}]}};
        const key=functionSitePresentationKey('a',component,'row',JSON.stringify(initial),innerWidth);
        cache.saveData(key,data(initial),30,cache.capture(component,key,JSON.stringify([component,'row'])),innerWidth,'host-key');
        window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
        window.api.mods.onConfigurationChanged=()=>()=>{};
        window.api.mods.siteUnmount=async()=>{};
        let ownerRequired=false;
        window.api.mods.siteRead=async(t,c,props,id,message,question,required)=>{ownerRequired=required===true;await new Promise(done=>pending.push(done));return{state:'projected',
          snapshot:{scopeId:'scope',key:'host-key',version:'v',expiresAt:Date.now()+120000,data:data(props)}}};
        function Fixture(){const [facts,setFacts]=useState(initial),[visible,setVisible]=useState(true),[revision,setRevision]=useState(0);
          const label=facts===initial?'initial':facts===progress?'progress':facts===additional?'additional':'replacement';
          window.cached={pending:()=>pending.length,release:()=>pending.shift()?.(),clicks,
            advance:()=>setFacts(additional),ownerRequired:()=>ownerRequired,progress:()=>setFacts(progress),replace:()=>setFacts(replacement),back:()=>setFacts(initial),
            exact:()=>Boolean(cache.read(key)),hide:()=>setVisible(false),show:()=>setVisible(true),resize:()=>setRevision(n=>n+1),
            expire:()=>{const now=Date.now();Date.now=()=>now+120001;setRevision(n=>n+1)},
            revokeKey:()=>cache.invalidateKey(key,true,JSON.stringify([component,'row'])),
            unauthorize:()=>{authorized=false;setRevision(n=>n+1)},
            projection:()=>{cache.invalidateProjection('host-key');for(const fn of cards)fn({threadId:'a',scope:'site-projection:host-key'})},
            source:()=>{cache.invalidate();for(const fn of cards)fn({threadId:'a',scope:'source-retiring:1'})}};
          return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
            <div data-input={label} data-revision={revision}>{visible&&<FunctionSite threadId='a' component={component} presentationId='row' facts={facts}
              renderNative={props=><div data-safe data-delegate={label}><p>{component==='ToolGroup'?props.calls.map(c=>c.tool_use_id+':'+c.input.path).join(','):props.text}</p>
                <button onClick={()=>clicks.push(label)}>copy</button></div>}/>}</div>
          </ModsChatScope.Provider>};host.render(<Fixture/>);}
      `,
        [browserWorkerPlugin()]
      )
      await page.waitForFunction(
        "window.cached.pending()===1 && !!document.querySelector('[data-safe]')"
      )
      if (scenario.startsWith("width-")) {
        await page.evaluate("window.savedCached=document.querySelector('[data-safe]')")
        await page.setViewportSize({ width: 980, height: 800 })
        await page.evaluate("window.cached.resize()")
        await page.waitForFunction("document.querySelector('[data-revision]')?.getAttribute('data-revision')==='1'")
        assert.equal(await page.locator("[data-safe]").count(), 1,
          `${component}: committed cache remains readable through a pure width change`)
        assert.equal(await page.evaluate("document.querySelector('[data-safe]')===window.savedCached"), true)
        assert.equal(await page.locator("[data-safe]").getAttribute("data-delegate"), "initial")
        assert.equal(await page.locator("[data-function-site-cached]").evaluate(
          (node: HTMLElement) => node.style.minHeight), "", "Old-width dimensions must not be reused")
        await page.locator("button").evaluate((button: HTMLButtonElement) => button.click())
        assert.deepEqual(await page.evaluate("window.cached.clicks"), [])
        assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
        if (scenario === "width-progress") {
          await page.setViewportSize({ width: 1080, height: 800 })
          await page.evaluate("window.cached.resize()")
          await page.waitForFunction("document.querySelector('[data-revision]')?.getAttribute('data-revision')==='2'")
          await page.evaluate("window.cached.progress()")
          await page.waitForFunction("document.querySelector('[data-input]')?.getAttribute('data-input')==='progress'")
          assert.equal(await page.evaluate("document.querySelector('[data-safe]')===window.savedCached"), true)
          assert.equal(await page.locator("[data-safe]").getAttribute("data-delegate"), "initial")
          assert.equal(await page.evaluate("window.cached.exact()"), false)
          await page.locator("button").evaluate((button: HTMLButtonElement) => button.click())
          assert.deepEqual(await page.evaluate("window.cached.clicks"), [])
          await page.evaluate("window.cached.source()")
        } else if (scenario === "width-remount") {
          await page.evaluate("window.cached.hide()")
          await page.waitForFunction("!document.querySelector('[data-function-site]')")
          await page.evaluate("window.cached.show()")
          await page.waitForFunction("!!document.querySelector('[data-function-site]')")
        } else if (scenario === "width-key") {
          await page.evaluate("window.cached.revokeKey()")
        } else if (scenario === "width-authorization") {
          await page.evaluate("window.cached.unauthorize()")
          await page.waitForFunction("document.querySelector('[data-revision]')?.getAttribute('data-revision')==='2'")
        } else if (scenario === "width-expiry") {
          await page.evaluate("window.cached.expire()")
          await page.waitForFunction("document.querySelector('[data-revision]')?.getAttribute('data-revision')==='2'")
        } else if (scenario === "width-aba") {
          await page.evaluate("window.cached.replace()")
          await page.waitForFunction("document.querySelector('[data-input]')?.getAttribute('data-input')==='replacement'")
          assert.equal(await page.locator("[data-safe]").count(), 0)
          await page.evaluate("window.cached.back()")
          await page.waitForFunction("document.querySelector('[data-input]')?.getAttribute('data-input')==='initial'")
          await page.setViewportSize({ width: 1280, height: 800 })
          await page.evaluate("window.cached.resize()")
        } else {
          await page.evaluate(scenario === "width-source" ? "window.cached.source()" : "window.cached.projection()")
        }
        assert.equal(await page.locator("[data-safe]").count(), 0,
          `${scenario}: old-width drawing must not survive revocation, expiry, replacement or a cold remount`)
        console.log(`PASS ${component}: ${scenario} keeps only the mounted inert drawing`)
        continue
      }
      await page.evaluate(
        "window.savedCached=document.querySelector('[data-safe]');window.cached.progress()"
      )
      await page.waitForFunction(
        "document.querySelector('[data-input]')?.getAttribute('data-input')==='progress'"
      )
      assert.equal(await page.locator("[data-safe]").count(), 1)
      assert.equal(await page.locator("[data-safe]").getAttribute("data-delegate"), "initial")
      assert.equal(
        await page.evaluate("document.querySelector('[data-safe]')===window.savedCached"),
        true
      )
      assert.equal(await page.evaluate("window.cached.exact()"), false)
      await page.locator("button").evaluate((button: HTMLButtonElement) => button.click())
      assert.deepEqual(await page.evaluate("window.cached.clicks"), [])
      assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
      await page.setViewportSize({ width: 980, height: 800 })
      await page.evaluate("window.cached.advance()")
      await page.waitForFunction(
        "document.querySelector('[data-input]')?.getAttribute('data-input')==='additional'"
      )
      assert.equal(await page.locator("[data-safe]").getAttribute("data-delegate"), "initial")
      assert.equal(await page.locator("[data-function-site-cached]").evaluate(
        (node: HTMLElement) => node.style.minHeight), "")
      assert.equal(
        await page.evaluate("document.querySelector('[data-safe]')===window.savedCached"),
        true
      )
      assert(!(await page.locator("[data-safe]").innerText()).includes("b:SAFE"))
      if (scenario === "source") {
        await page.evaluate("window.cached.source()")
        assert.equal(await page.locator("[data-safe]").count(), 0)
        await page.evaluate("window.cached.release()")
        await page.waitForFunction("window.cached.pending()===0")
        assert.equal(await page.locator("[data-safe]").count(), 0)
        console.log(
          `PASS ${component}: source retirement immediately revokes the live progress lease`
        )
        continue
      }
      if (scenario === "projection") {
        await page.evaluate("window.cached.projection()")
        assert.equal(await page.locator("[data-safe]").count(), 0)
        await page.evaluate("window.cached.release()")
        await page.waitForFunction("window.cached.pending()===1")
        assert.equal(await page.evaluate("window.cached.ownerRequired()"), true)
        assert.equal(await page.locator("[data-safe]").count(), 0)
        await page.evaluate("window.cached.release()")
        await page.locator("[data-safe]").waitFor()
        console.log(`PASS ${component}: original host-key revocation forces a new protected read`)
        continue
      }
      if (scenario === "takeover") {
        await page.evaluate("window.cached.release()")
        await page.waitForFunction("window.cached.pending()===1")
        assert.equal(await page.locator("[data-safe]").getAttribute("data-delegate"), "initial")
        assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
        await page.evaluate("window.cached.release()")
        await page.waitForFunction(
          "document.querySelector('[data-safe]')?.getAttribute('data-delegate')==='additional'"
        )
        await page.locator("button").click()
        assert.deepEqual(await page.evaluate("window.cached.clicks"), ["additional"])
        await page.evaluate("window.cached.hide()")
        await page.waitForFunction("!document.querySelector('[data-function-site]')")
        assert.equal(await page.evaluate("window.cached.exact()"), false)
        console.log(
          `PASS ${component}: new protected receipt takes over and restores current controls`
        )
        continue
      }
      await page.evaluate("window.cached.replace()")
      await page.waitForFunction(
        "document.querySelector('[data-input]')?.getAttribute('data-input')==='replacement'"
      )
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.cached.back()")
      await page.waitForFunction(
        "document.querySelector('[data-input]')?.getAttribute('data-input')==='initial'"
      )
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.cached.release()")
      await page.waitForFunction("window.cached.pending()===1")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.cached.release()")
      await page.locator("[data-safe]").waitFor()
      await page.evaluate("window.cached.progress()")
      await page.waitForFunction("window.cached.pending()===1")
      await page.evaluate("window.cached.projection()")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.cached.source()")
      await page.evaluate("window.cached.release()")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      console.log(
        `PASS ${component}: cache-only progress uses captured inert renderer; ABA and revocation fail closed`
      )
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}

if (resolve(process.argv[1] ?? "") === resolve(__filename))
  void runFunctionSiteCachedProgressBrowser().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
