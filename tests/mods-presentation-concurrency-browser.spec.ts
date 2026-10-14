/** Interrupt a pending protected frame commit with a synchronous append-only parent update. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  try {
    await mount(page, `
      import {flushSync} from "react-dom";
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {let reads=[],index=0,setText;const observations=[],events=new Set();
      window.api.mods.onCardsChanged=fn=>{events.add(fn);return()=>events.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async()=>({state:'mounted',owner:'one'});
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRender=async(thread,owner,input)=>{
        const request=++index;await new Promise(done=>reads.push(done));
        const tree={type:'engine',ref:0};let scheduled=false;
        return {key:'engine:one',id:'one',plugin:'engine',generation:'g'+request,title:'Protected',rows:12,closeOnEscape:false,
          get tree(){if(request===2&&!scheduled){scheduled=true;queueMicrotask(()=>{
            flushSync(()=>setText(value=>value+' + synchronous input'));
            observations.push(document.querySelector('[data-function-site="AssistantMessage"]').innerText)
          })}return tree},
          nativeContent:{component:'AssistantMessage',entries:[{ref:0,props:{...input,text:input.text.replace('RAW','SAFE')}}],nativeUnchanged:false}}
      };
      function Fixture(){const [text,update]=useState('RAW_FIRST');setText=update;
        window.concurrentFrame={append:()=>update(value=>value+' + stream'),pending:()=>reads.length,
          release:()=>reads.shift()(),observations:()=>observations};
        return <ModsChatScope.Provider value={{threadId:'c',enabled:true,ready:true}}><FunctionSite threadId='c'
          component='AssistantMessage' facts={{text,isFirstOfReply:true}} renderNative={safe=><p>{safe.text}</p>}/></ModsChatScope.Provider>
      }host.render(<Fixture/>)}
    `, [browserWorkerPlugin()])
    await page.waitForFunction("window.concurrentFrame?.pending()===1")
    await page.evaluate("window.concurrentFrame.release()")
    await page.getByText("SAFE_FIRST", { exact: true }).waitFor()
    await page.evaluate("window.concurrentFrame.append()")
    await page.waitForFunction("window.concurrentFrame.pending()===1")
    await page.evaluate("window.concurrentFrame.release()")
    await page.waitForFunction("window.concurrentFrame.observations().length===1")
    const observations = await page.evaluate<string[]>("window.concurrentFrame.observations()")
    assert(observations.every(text => text.includes("SAFE_FIRST")),
      `A future pending frame must not erase the committed protected presentation: ${JSON.stringify(observations)}`)
    console.log("PASS synchronous append cannot erase an already committed protected frame while another read commits")
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
