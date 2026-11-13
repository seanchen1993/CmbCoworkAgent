import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

/** Actual React concurrent rendering. No read may publish private fixture text. */
export async function runFunctionSiteConcurrentCommitBrowser() {
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const imports = `
    import {StrictMode,Suspense,startTransition,useLayoutEffect} from 'react';
    import {flushSync} from 'react-dom';
    import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
    import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
    import {FunctionSitePresentationCache,functionSitePresentationKey} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-presentation.ts"))};`
  try {
    await mount(page, `${imports}
      const cards=new Set(),pending=[];let authorized=true,blocked=false,renders=0;
      const strict={renders:0,effects:0,cleanups:0};
      function StrictProbe(){strict.renders++;useEffect(()=>{strict.effects++;return()=>strict.cleanups++},[]);return null}
      window.probe={strict:()=>({...strict})};
      const original={text:'PRIVATE a',isFirstOfReply:true};
      const cache=new FunctionSitePresentationCache(()=>authorized);
      const key=functionSitePresentationKey('a','AssistantMessage','row',JSON.stringify(original),innerWidth);
      const captured=cache.capture('AssistantMessage',key,JSON.stringify(['AssistantMessage','row']));
      cache.saveData(key,{component:'AssistantMessage',hostMessage:{text:'SAFE a',isFirstOfReply:true}},30,captured,innerWidth,'host');
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRead=async(_t,_c,props)=>{await new Promise(done=>pending.push(done));return{state:'projected',
        snapshot:{scopeId:'scope',key:'host',version:'v',expiresAt:Date.now()+120000,
        data:{component:'AssistantMessage',hostMessage:{...props,text:props.text.replace('PRIVATE','SAFE')}}}}};
      const never=new Promise(()=>{});
      function Block(){if(blocked)throw never;return null}
      function Fixture(){const [facts,setFacts]=useState(original),[revision,setRevision]=useState(0);
        useLayoutEffect(()=>{window.probe.committed=facts.text});
        window.probe={...window.probe,renders:()=>renders,pending:()=>pending.length,
          exact:()=>Boolean(cache.peek(key)),captured:()=>captured(),
          speculative:()=>startTransition(()=>{blocked=true;setFacts({...original,text:'PRIVATE replacement'});setRevision(n=>n+1)}),
          abandon:()=>flushSync(()=>{blocked=false;setFacts(original);setRevision(n=>n+1)}),
          progress:()=>flushSync(()=>setFacts({...original,text:'PRIVATE ab'})),
          source:()=>{cache.invalidate();for(const fn of cards)fn({threadId:'a',scope:'source-retiring:1'})},
          release:()=>{for(const done of pending.splice(0))done()}};
        renders++;
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,isCurrent:()=>authorized,presentationCache:cache}}>
          <div data-facts={facts.text} data-revision={revision}><FunctionSite threadId='a' component='AssistantMessage'
            presentationId='row' facts={facts} fallback={<b>PRIVATE FALLBACK</b>}
            renderNative={safe=><span data-safe data-delegate={facts.text}>{safe.text}</span>}/><Block/></div>
        </ModsChatScope.Provider>}
      host.render(<StrictMode><StrictProbe/><Suspense fallback={<i>pending boundary</i>}><Fixture/></Suspense></StrictMode>);
    `, [browserWorkerPlugin()], true, "about:blank", true)
    await page.locator("[data-safe]").waitFor()
    await page.waitForFunction("window.probe.strict().renders>=2&&window.probe.strict().effects>=2&&window.probe.strict().cleanups>=1")
    await page.waitForFunction("window.probe.pending()>0")
    const before = await page.evaluate("window.probe.renders()")
    await page.evaluate("window.probe.speculative()")
    await page.waitForFunction(`window.probe.renders()>${before}`)
    assert.equal(await page.evaluate("window.probe.exact()"), true,
      "An abandoned replacement render must not retire a committed cache entry")
    assert.equal(await page.evaluate("window.probe.captured()"), true,
      "An abandoned render must not revoke its actual read admission")
    assert.equal(await page.locator("[data-safe]").innerText(), "SAFE a")
    await page.evaluate("window.probe.abandon()")
    await page.waitForFunction("window.probe.committed==='PRIVATE a'")
    assert.equal(await page.evaluate("window.probe.exact()"), true)
    await page.evaluate("window.probe.progress();window.probe.release()")
    await page.waitForFunction("!!document.querySelector('[data-function-site-projected] [data-safe]')")
    assert.equal(await page.locator("[data-safe]").innerText(), "SAFE a",
      "A real earlier protected result may first paint inert during uninterrupted streaming")
    assert.equal(await page.locator("[data-function-site-projected]").getAttribute("inert"), "")
    assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
    await page.evaluate("window.probe.source()")
    await page.waitForFunction("!document.querySelector('[data-safe]')")
    assert.deepEqual(errors, [])

    await mount(page, `${imports}
      const notices=new Set(),capabilities=[],cards=new Set();let reads=0;
      const scope={threadId:'a',workspacePath:'a',incarnation:{token:'native-incarnation',legacyCreatedAt:1}};
      window.api.threads={onThreadsChanged:fn=>{notices.add(fn);return()=>notices.delete(fn)}};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.models={onUserInfoChanged:()=>()=>{}};
      window.api.mods.chatDisplayCapability=()=>{reads++;return new Promise(done=>capabilities.push(done))};
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRead=async(_t,_c,props)=>({state:'projected',snapshot:{scopeId:'scope',key:'new-host',version:'v',expiresAt:Date.now()+120000,
        data:{component:'AssistantMessage',hostMessage:{...props,text:'SAFE active'}}}});
      function Fixture(){const state=useModsChatState('a','a',scope);
        window.probe={...window.probe,reads:()=>reads,settle:()=>capabilities.shift()?.(true),current:state.isCurrent,
          notify:value=>{for(const fn of [...notices])fn(value)},scope};
        return <ModsChatScope.Provider value={{threadId:'a',...state}}><FunctionSite threadId='a' component='AssistantMessage'
          presentationId='row' facts={{text:'PRIVATE active',isFirstOfReply:true}}
          renderNative={safe=><span data-safe>{safe.text}</span>}/></ModsChatScope.Provider>}
      host.render(<Fixture/>);
    `, [browserWorkerPlugin()])
    await page.waitForFunction("window.probe.reads()===1")
    await page.evaluate("window.probe.settle()")
    await page.locator("[data-safe]").waitFor()
    await page.evaluate("window.probe.notify({...window.probe.scope,threadId:'background',kind:'metadata'});window.probe.notify({...window.probe.scope,kind:'transcript'})")
    assert.equal(await page.evaluate("window.probe.reads()"), 1)
    assert.equal(await page.locator("[data-safe]").innerText(), "SAFE active")
    assert.equal(await page.evaluate("window.oldAuthority=window.probe.current;window.probe.notify();window.oldAuthority()"), false,
      "Unknown legacy notifications must revoke captured authority synchronously")
    await page.waitForFunction("!document.querySelector('[data-safe]')")
    await page.evaluate("window.probe.settle()")
    await page.locator("[data-safe]").waitFor()
    assert.equal(await page.evaluate("window.oldAuthority()"), false)
    assert(!(await page.locator("body").innerText()).includes("PRIVATE"))
    assert.deepEqual(errors, [])
    console.log("PASS real concurrent abort/StrictMode/first-prefix and scoped legacy notifications")
  } finally { await browser.close() }
}

if (process.argv[1]?.endsWith("function-site-concurrent-commit-browser.spec.ts"))
  void runFunctionSiteConcurrentCommitBrowser().catch(error => { console.error(error); process.exitCode = 1 })
