/** Controlled protected tool receipts exercise real React lifetimes without model/user data. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

export async function runFunctionToolProgressBrowser() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    for (const mode of ["projected", "mounted"]) {
      await mount(
        page,
        `
        import {FunctionToolGroup} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionToolGroup.tsx"))};
        import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
        import {FunctionSitePresentationCache} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-presentation.ts"))};
        {const cache=new FunctionSitePresentationCache(()=>true),cards=new Set(),pending=[],clicks=[];
        let reads=0,unmounts=0;
        const call=id=>({tool_use_id:id,tool:'read_file',input:{path:'PRIVATE'},
          isRunning:true,isErrored:false,isInterrupted:false});
        const receipt=async(component,props)=>{reads++;await new Promise(done=>pending.push(done));
          const safe={...props,calls:props.calls.map(c=>({...c,input:{path:'SAFE'}}))};
          return {key:'engine:owner',id:'owner',plugin:'engine',generation:'g'+reads,
            title:component,rows:8,closeOnEscape:false,tree:{type:'engine',ref:0},
            nativeContent:{component,entries:[{ref:0,props:safe}]}}};
        window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
        window.api.mods.onConfigurationChanged=()=>()=>{};
        window.api.mods.siteUnmount=async()=>{unmounts++};
        window.api.mods.siteRender=async(t,o,props)=>receipt('ToolGroup',props);
        window.api.mods.siteRead=async(t,component,props)=>{const snapshot=await receipt(component,props);
          return ${JSON.stringify(mode)}==='mounted'?{state:'mounted',owner:'owner',snapshot}:
            {state:'projected',snapshot:{scopeId:'scope',key:'group',version:'v'+reads,
              expiresAt:Date.now()+120000,data:{component,tree:snapshot.tree,nativeContent:snapshot.nativeContent}}}};
        function Fixture(){const [calls,setCalls]=useState([call('a')]);const label=calls.length+':'+calls[0].isRunning;
          window.tools={reads:()=>reads,pending:()=>pending.length,unmounts:()=>unmounts,clicks,
            release:()=>pending.shift()?.(),done:()=>setCalls([{...call('a'),isRunning:false,output:'DONE'}]),
            append:()=>setCalls([{...call('a'),isRunning:false,output:'DONE'},call('b')]),
            redraw:()=>{for(const fn of cards)fn({threadId:'a',scope:'site-redraw:owner'})},
            replace:()=>setCalls([{...call('a'),input:{path:'REPLACEMENT'}}]),
            revoke:()=>{for(const fn of cards)fn({threadId:'a',scope:${JSON.stringify(mode)}==='mounted'?'site-invalidated:owner':'site-projection:group'})}};
          return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
            <div data-current={label}><FunctionToolGroup threadId='a' calls={calls} blocked={false} isActive={true}>
              {(expanded,safe)=>safe?<div data-safe data-delegate={label}>{safe.map(c=><p key={c.tool_use_id}>{c.tool_use_id}:{c.input.path}</p>)}
                <button onClick={()=>clicks.push(label)}>copy</button></div>:<p>RAW FALLBACK</p>}
            </FunctionToolGroup></div>
          </ModsChatScope.Provider>;
        }host.render(<Fixture/>);}
      `,
        [browserWorkerPlugin()]
      )
      await page.waitForFunction("window.tools.pending()===1")
      await page.evaluate("window.tools.done()")
      await page.waitForFunction(
        "document.querySelector('[data-current]')?.getAttribute('data-current')==='1:false'"
      )
      await page.evaluate("window.tools.release()")
      await page.waitForFunction(
        "window.tools.pending()===1 && !!document.querySelector('[data-safe]')"
      )
      assert.equal(await page.locator("[data-safe]").getAttribute("data-delegate"), "1:true")
      assert.equal(
        await page.locator("[data-safe]").evaluate((node) => Boolean(node.closest("[inert]"))),
        true
      )
      await page.locator("button").evaluate((node: HTMLButtonElement) => node.click())
      assert.deepEqual(await page.evaluate("window.tools.clicks"), [])
      await page.evaluate("window.tools.release()")
      await page.waitForFunction(
        "document.querySelector('[data-safe]')?.getAttribute('data-delegate')==='1:false'"
      )
      if (mode === "mounted") {
        await page.evaluate("window.tools.redraw()")
        await page.waitForFunction("window.tools.pending()===1")
      }
      await page.evaluate(
        "window.savedSite=document.querySelector('[data-function-site]');window.tools.append()"
      )
      await page.waitForFunction("window.tools.pending()===1")
      assert.equal(
        await page.evaluate("window.savedSite===document.querySelector('[data-function-site]')"),
        true
      )
      await page.waitForFunction(
        "document.querySelector('[data-current]')?.getAttribute('data-current')==='2:false'"
      )
      assert.equal(await page.locator("[data-safe] p").count(), 1)
      assert.equal(
        await page.locator("[data-safe]").evaluate((node) => Boolean(node.closest("[inert]"))),
        true
      )
      await page.evaluate("window.tools.release()")
      if (mode === "mounted") {
        await page.waitForFunction("window.tools.pending()===1")
        assert.equal(await page.locator("[data-safe] p").count(), 1)
        await page.evaluate("window.tools.release()")
      }
      await page.waitForFunction("document.querySelectorAll('[data-safe] p').length===2")
      await page.evaluate("window.tools.replace()")
      await page.waitForFunction("window.tools.pending()===1")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.tools.append()")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.tools.release()")
      await page.waitForFunction("window.tools.pending()===1")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      await page.evaluate("window.tools.release()")
      await page.waitForFunction("document.querySelectorAll('[data-safe] p').length===2")
      await page.evaluate("window.tools.revoke()")
      await page.waitForFunction("window.tools.pending()===1")
      assert.equal(await page.locator("[data-safe]").count(), 0)
      assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
      await page.evaluate("window.tools.release()")
      await page.waitForFunction("document.querySelectorAll('[data-safe] p').length===2")
      console.log(
        `PASS ${mode}: cold tool progress, stable append, inert delegate, ABA and revocation`
      )
    }
    await mount(
      page,
      `
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {const pending=[],cards=new Set();let reads=0;
      const receipt=async props=>{reads++;await new Promise(done=>pending.push(done));return{
        key:'engine:owner',id:'owner',plugin:'engine',generation:'g'+reads,title:'AssistantMessage',
        rows:8,closeOnEscape:false,tree:{type:'engine',ref:0},nativeContent:{component:'AssistantMessage',
          entries:[{ref:0,props:{...props,text:props.text.replace('PRIVATE','SAFE')}}]}}};
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRead=async(t,c,props)=>({state:'mounted',owner:'owner',snapshot:await receipt(props)});
      window.api.mods.siteRender=async(t,o,props)=>receipt(props);
      function Fixture(){const [text,setText]=useState('PRIVATE a');window.assistant={
        pending:()=>pending.length,release:()=>pending.shift()?.(),set:setText,
        notify:scope=>{for(const fn of cards)fn({threadId:'a',scope})}};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true}}>
          <div data-input={text}><FunctionSite threadId='a' component='AssistantMessage' presentationId='row'
            facts={{text,isFirstOfReply:true}} renderNative={safe=><p data-safe>{safe.text}</p>}/></div>
        </ModsChatScope.Provider>};host.render(<Fixture/>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.waitForFunction("window.assistant.pending()===1")
    await page.evaluate("window.assistant.release()")
    await page.waitForFunction("document.querySelector('[data-safe]')?.textContent==='SAFE a'")
    await page.evaluate("window.assistant.notify('site-redraw:owner')")
    await page.waitForFunction("window.assistant.pending()===1")
    await page.evaluate("window.assistant.set('PRIVATE ab')")
    await page.waitForFunction(
      "document.querySelector('[data-input]')?.getAttribute('data-input')==='PRIVATE ab'"
    )
    assert.equal(await page.locator("[data-safe]").textContent(), "SAFE a")
    assert.equal(
      await page.locator("[data-safe]").evaluate((node) => Boolean(node.closest("[inert]"))),
      true
    )
    await page.evaluate("window.assistant.release()")
    await page.waitForFunction("window.assistant.pending()===1")
    assert.equal(await page.locator("[data-safe]").textContent(), "SAFE a")
    await page.evaluate("window.assistant.release()")
    await page.waitForFunction("document.querySelector('[data-safe]')?.textContent==='SAFE ab'")
    // A response started before redraw cannot borrow the retained committed frame's epoch.
    await page.evaluate("window.assistant.set('PRIVATE abc')")
    await page.waitForFunction("window.assistant.pending()===1")
    await page.evaluate("window.assistant.notify('site-redraw:owner')")
    await page.evaluate("window.assistant.set('PRIVATE abcd')")
    await page.waitForFunction(
      "document.querySelector('[data-input]')?.getAttribute('data-input')==='PRIVATE abcd'"
    )
    assert.equal(await page.locator("[data-safe]").textContent(), "SAFE ab")
    await page.evaluate("window.assistant.release()")
    await page.waitForFunction("window.assistant.pending()===1")
    assert.equal(await page.locator("[data-safe]").textContent(), "SAFE ab")
    await page.evaluate("window.assistant.notify('site-invalidated:owner')")
    assert.equal(await page.locator("[data-safe]").count(), 0)
    await page.evaluate("window.assistant.release()")
    await page.waitForFunction("window.assistant.pending()===1")
    assert.equal(await page.locator("[data-safe]").count(), 0)
    await page.evaluate("window.assistant.release()")
    await page.waitForFunction("document.querySelector('[data-safe]')?.textContent==='SAFE abcd'")
    console.log(
      "PASS assistant: redraw then append retains committed frame but rejects pre-redraw reads"
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}

if (resolve(process.argv[1] ?? "") === resolve(__filename))
  void runFunctionToolProgressBrowser().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
