/** Actual user bubble, expansion store and protected message wrapper; controlled native IPC. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/message-user-overflow-browser")
  mkdirSync(output, { recursive: true })
  const cssPath = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      // This browser fixture does not persist the CSS dependency graph.
    }
  })
  const candidates = new Scanner({}).scanFiles(
    ["MessageBubble", "FunctionSite", "FunctionMessageText"].map((name) => ({
      content: readFileSync(resolve(`src/renderer/src/components/chat/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const css = compiler.build(candidates)
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {MessageBubble} from ${JSON.stringify(resolve("src/renderer/src/components/chat/MessageBubble.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {UserMessageExpansionContext,UserMessageExpansionStore} from ${JSON.stringify(resolve("src/renderer/src/components/chat/user-message-expansion-context.ts"))};
      import {observeUserContentOverflow} from ${JSON.stringify(resolve("src/renderer/src/components/chat/user-content-overflow.ts"))};
      {const choices=new UserMessageExpansionStore(),owners=new Map(),pending=[],calls=[];
       let seq=0,hold=false,reads=0;
       window.api.mods.onCardsChanged=()=>()=>{};
       const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollHeight');
       Object.defineProperty(Element.prototype,'scrollHeight',{...descriptor,get(){
         if(this.hasAttribute('data-chat-search-user-content-collapse-threshold'))reads++;
         return descriptor.get.call(this)
       }});
       window.api.mods.siteMountOutcome=async(thread,component)=>{calls.push('mount');const owner='user-'+(++seq);owners.set(owner,component);return{state:'mounted',owner}};
       window.api.mods.siteRender=async(thread,owner,input)=>{calls.push('render');const props={...input,text:input.text?.replace('RAW','SAFE')};
         if(hold)await new Promise(done=>pending.push(done));
         return{key:'engine:'+owner,id:owner,plugin:'test',generation:owner,title:'user',rows:8,closeOnEscape:false,
           tree:{type:'engine',ref:0},nativeContent:{component:owners.get(owner),entries:[{ref:0,props}]}}};
       window.api.mods.siteUnmount=async(thread,owner)=>owners.delete(owner);
       window.electron={process:{platform:'win32'}};
       window.createOverflowProbe=fallback=>{
         const outer=document.createElement('div'),inner=document.createElement('div'),marker=document.createElement('span');
         outer.style.cssText='overflow:hidden;max-height:260px';inner.style.height='269px';marker.dataset.functionSitePending='';
         inner.append(marker);outer.append(inner);document.body.append(outer);let count=0,result=null;
         Object.defineProperty(outer,'scrollHeight',{get(){count++;if(!fallback)throw Error('Unexpected forced layout');return 269}});
         const original=window.ResizeObserver;if(fallback)window.ResizeObserver=undefined;
         const stop=observeUserContentOverflow(outer,inner,260,value=>result=value);window.ResizeObserver=original;
         window.overflowProbe={result:()=>result,reads:()=>count,authorize:()=>marker.remove(),height:value=>inner.style.height=value+'px',dispose:()=>{stop();outer.remove()}}
       };
       function Fixture(){const[text,setText]=useState('short'),[width,setWidth]=useState(700),[visible,show]=useState(true),[protectedMode,protect]=useState(false);
         window.userOverflow={text:setText,width:setWidth,show,protect,calls,reads:()=>reads,held:()=>pending.length,
           hold:()=>hold=true,release:()=>{hold=false;pending.splice(0).forEach(done=>done())}};
         return <ModsChatScope.Provider value={{threadId:'thread',enabled:protectedMode,ready:true}}>
           <UserMessageExpansionContext.Provider value={choices}><section data-user-fixture style={{width}}>
             {visible&&<MessageBubble message={{id:'user-row',role:'user',content:text,created_at:new Date(1)}}
               threadId='thread' isStreaming={false} isLoading={false}/>}</section></UserMessageExpansionContext.Provider>
         </ModsChatScope.Provider>}
       host.render(<Fixture/>)}
    `,
      [
        browserWorkerPlugin(),
        {
          name: "user-overflow-assets",
          setup(builder) {
            builder.initialOptions.loader = { ...builder.initialOptions.loader, ".png": "dataurl" }
          }
        }
      ]
    )
    await page.addStyleTag({ content: css })
    const call = (source: string) => page.evaluate(source)
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0)))
          )
      )
    const more = page.locator("[data-chat-search-expand-user-content]")
    const shell = page.locator("[data-chat-search-user-content-collapse-threshold]")
    await page.getByText("short", { exact: true }).waitFor()
    await settle()
    assert.equal(await more.count(), 0)
    await call("window.userOverflow.text(Array(9).fill('line').join('\\n'))")
    await settle()
    assert.equal(await more.count(), 0)
    await call("window.userOverflow.text(Array(10).fill('line').join('\\n'))")
    await more.waitFor()
    assert.equal(await shell.evaluate((node) => node.getBoundingClientRect().height), 260)
    checks.push("actual rendered nine/ten line boundary")
    await more.click()
    assert.equal(await more.getAttribute("aria-expanded"), "true")
    assert((await shell.evaluate((node) => node.getBoundingClientRect().height)) > 260)
    await call("window.userOverflow.show(false)")
    await shell.waitFor({ state: "detached" })
    await call("window.userOverflow.show(true)")
    await more.waitFor()
    await settle()
    assert.equal(await more.getAttribute("aria-expanded"), "true")
    await more.click()
    assert.equal(await more.getAttribute("aria-expanded"), "false")
    checks.push("expand/collapse choice survives virtual remount")
    await call(
      "window.userOverflow.text(Array(60).fill('wrapping').join(' '));window.userOverflow.width(700)"
    )
    await settle()
    assert.equal(await more.count(), 0)
    await call("window.userOverflow.width(240)")
    await more.waitFor()
    await call("window.userOverflow.width(700)")
    await settle()
    assert.equal(await more.count(), 0)
    checks.push("width-only wrapping updates uncapped layout")
    await call(
      "window.userOverflow.hold();window.userOverflow.protect(true);window.userOverflow.text('RAW '+Array(20).fill('authorized line').join('\\n'))"
    )
    await page.locator("[data-function-site-pending]").waitFor()
    await settle()
    assert.equal(await more.count(), 0)
    assert.equal(await page.getByText(/RAW /).count(), 0)
    await page.waitForFunction("window.userOverflow.held()>0")
    await call("window.userOverflow.release()")
    await page.getByText(/SAFE /).waitFor()
    await more.waitFor()
    await more.click()
    assert.equal(await more.getAttribute("aria-expanded"), "true")
    await call("window.userOverflow.show(false)")
    await shell.waitFor({ state: "detached" })
    await call("window.userOverflow.show(true)")
    await more.waitFor()
    await settle()
    assert.equal(await more.getAttribute("aria-expanded"), "true")
    checks.push(
      "pending raw content never measured/displayed; authorized expansion and remount retained"
    )
    await call("window.createOverflowProbe(false)")
    await settle()
    assert.equal(await call("window.overflowProbe.result()"), false)
    await call("window.overflowProbe.authorize()")
    await settle()
    assert.equal(
      await call("window.overflowProbe.result()"),
      true,
      "equal-size authorization uses delivered geometry"
    )
    await call("window.overflowProbe.height(268)")
    await settle()
    assert.equal(await call("window.overflowProbe.result()"), false)
    assert.equal(await call("window.overflowProbe.reads()"), 0)
    await call("window.overflowProbe.dispose();window.createOverflowProbe(true)")
    assert.equal(
      await call("window.overflowProbe.reads()"),
      0,
      "fallback must not measure pending content"
    )
    await call("window.overflowProbe.authorize()")
    await settle()
    assert.equal(await call("window.overflowProbe.result()"), true)
    assert((await call("window.overflowProbe.reads()")) > 0)
    await call("window.overflowProbe.dispose()")
    checks.push("same-size authorization, exact delivered-size threshold and no-RO fallback")
    const reads = await call("window.userOverflow.reads()")
    assert.equal(reads, 0, "modern RO never reads user shell scrollHeight")
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ passed: true, scrollHeightReads: reads, checks, errors }, null, 2)
    )
    await page.screenshot({ path: resolve(output, "authorized-expanded.png"), fullPage: true })
    console.log(
      "PASS actual MessageBubble overflow: 0 scrollHeight reads, boundary/width/authorization/virtual expansion preserved"
    )
  } catch (error) {
    console.error({
      errors,
      body: await page.locator("body").innerText(),
      calls: await page.evaluate("window.userOverflow?.calls")
    })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
