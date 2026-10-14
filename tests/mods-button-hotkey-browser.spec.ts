/** Real production pane/site keyboard activation against isolated IPC fixtures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { THEME_DEFINITIONS } from "../src/renderer/src/lib/theme-registry"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-button-hotkey-browser")
  mkdirSync(output,{recursive:true})
  const browser = await chromium.launch({headless:true,
    ...(existsSync(chromium.executablePath())?{}:{channel:"msedge"})})
  const page = await browser.newPage({viewport:{width:1200,height:1000}})
  const errors:string[] = [], checks:string[] = []
  page.on("pageerror",e=>errors.push(e.message))
  const pass=(label:string)=>{checks.push(label);console.log("PASS "+label)}
  try {
    await mount(page,`
      import {FunctionPanes,Element} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      const hotkeyEnvironment={randomUUID:typeof crypto.randomUUID,secureContext:window.isSecureContext};
      let hotkeyIntent=0;
      crypto.randomUUID??=()=>"hotkey-fixture-"+(++hotkeyIntent);
      const actions=[],hotkeyListeners=new Set();let hold=false,finish;
      const styleTree={type:'Box',props:{flexDirection:'column',width:14,borderStyle:'round',borderColor:'magenta',marginTop:1,paddingX:1},children:[
        {type:'Text',props:{inverse:true,color:'cyan',backgroundColor:'navy'},children:['Inverse']},
        {type:'Text',props:{wrap:'truncate-start'},children:['/prefix/'.repeat(12)+'TAIL.ts']},
        {type:'Text',props:{wrap:'truncate-end'},children:['START'+('long text '.repeat(12))]},
        {type:'Text',props:{wrap:'wrap'},children:['first line\\nsecond line']}]};
      const button=(key,plugin,handle,hotkey)=>({type:'Button',props:{key,label:key,hotkey},press:{plugin,handle}});
      const tree=id=>({type:'Box',props:{},children:[button(id+' first','p',1,'w'),
        button(id+' last','p',2,'w'),button(id+' other plugin','q',3,'w'),button(id+' digit','p',4,'1'),
        {type:'Input',props:{key:id+' input',label:id+' input',value:'',submitLabel:'Save'},press:{plugin:'p',handle:5}}]});
      const snapshot=id=>({key:id,id,plugin:'p',title:id,generation:'gen-'+id,rows:8,closeOnEscape:false,tree:tree(id)});
      window.api.mods.panes=async()=>[snapshot('pane-one'),snapshot('pane-two')];
      window.api.mods.onCardsChanged=fn=>{hotkeyListeners.add(fn);return()=>hotkeyListeners.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      const act=async(source,action)=>{if(action.kind==='press'){actions.push({source,...action});
        if(hold){hold=false;await new Promise(r=>finish=r)}}return {focused:false}};
      window.api.mods.paneAct=async(thread,action)=>act(action.pane,action);
      window.api.mods.siteMountOutcome=async()=>({state:'mounted',owner:'band-owner'});
      window.api.mods.siteRender=async(thread,owner,input)=>({...snapshot('band'),
        nativeFallback:false,nativeContent:{component:'AbovePrompt',entries:[{ref:0,props:structuredClone(input)}]}});
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteAct=async(thread,owner,action)=>act('band',action);
      window.api.mods.feedback=async()=>[];
      window.api.mods.focusAck=async()=>{};window.api.mods.scrollAck=async()=>{};
      window.hotkeyFixture={environment:hotkeyEnvironment,actions,hold:()=>hold=true,finish:()=>finish?.()};
      const nestedText=(label,inverse=false)=>({type:'Text',props:{color:'white',inverse},children:[label]});
      const nestedTree={type:'Text',props:{backgroundColor:'black'},children:[
        nestedText('nested-direct'),
        {type:'fragment',children:[{type:'Box',props:{},children:[nestedText('nested-box-fragment')]}]},
        nestedText('nested-inverse',true),
        {type:'Client',props:{}}]};
      host.render(<ModsChatScope.Provider value={{threadId:'a',enabled:true}}>
        <div data-nested-white><Element node={{type:'Text',props:{backgroundColor:'white'},children:[
          {type:'Text',props:{color:'black'},children:['nested-white-black']},
          {type:'Text',props:{color:'black',inverse:true},children:['nested-white-inverse']}]}}
          busy={false} act={async()=>{}}/></div>
        <div data-nested-style><Element node={nestedTree} busy={false} act={async()=>{}}
          renderClient={()=> <Element node={nestedText('nested-client')} busy={false} act={async()=>{}}/>}/></div>
        <div data-original-style><Element node={styleTree} busy={false} act={async()=>{}}/></div>
        <textarea aria-label='Ordinary composer' className='composer-textarea'/>
        <button data-outside>Outside</button>
        <FunctionPanes threadId='a'/>
        <FunctionSite threadId='a' component='AbovePrompt' facts={{isWorking:false}}/>
      </ModsChatScope.Provider>);
    `,[browserWorkerPlugin()])
    await page.addStyleTag({ content: readFileSync(resolve("src/renderer/src/assets/mods-ansi-colors.css"), "utf8") })
    // tsx keepNames helpers are outside Playwright-serialized callbacks.
    // Match the existing browser fixtures; this only returns the supplied function.
    await page.addScriptTag({ content: "window.__name = (value) => value" })
    await page.getByRole("button",{name:"pane-one first",exact:true}).waitFor()
    await page.getByRole("button",{name:"band first",exact:true}).waitFor()
    const count=()=>page.evaluate("window.hotkeyFixture.actions.length")
    const last=()=>page.evaluate("window.hotkeyFixture.actions.at(-1)")
    const composer=page.getByRole("textbox",{name:"Ordinary composer",exact:true})
    await composer.fill("draft")
    await composer.press("w")
    await composer.press("1")
    assert.equal(await composer.inputValue(),"draftw1")
    await composer.fill("")
    await composer.press("1")
    assert.equal(await composer.inputValue(),"1")
    assert.equal(await count(),0)
    pass("ordinary and empty composer typing never activates buttons")
    await page.locator("[data-outside]").focus()
    await page.keyboard.press("w")
    assert.equal(await count(),0)
    pass("a globally focused non-site control never activates a hotkey")
    const first=page.getByRole("button",{name:"pane-one first",exact:true})
    await first.focus()
    await page.keyboard.press("Shift+W")
    await page.waitForFunction("window.hotkeyFixture.actions.length===1")
    assert.equal((await last()).handle,2)
    assert.equal((await last()).plugin,"p")
    assert.equal((await last()).source,"pane-one")
    pass("focused pane lowercases Shift keys and selects last matching button within its plugin")
    await first.focus()
    for(const modifier of ["ctrlKey","altKey","metaKey"])
      await first.dispatchEvent("keydown",{key:"w",[modifier]:true})
    assert.equal(await count(),1)
    await first.dispatchEvent("keydown",{key:"w",repeat:true})
    await first.dispatchEvent("keydown",{key:"w",isComposing:true})
    assert.equal(await count(),1)
    pass("modified shortcuts, key repeat and IME do not create duplicate actions")
    const input=page.getByRole("textbox",{name:"pane-one input",exact:true})
    await input.focus()
    await input.press("w")
    assert.equal(await input.inputValue(),"w")
    assert.equal(await count(),1)
    pass("typing in a plugin input does not trigger a button")
    await page.getByRole("button",{name:"pane-two first",exact:true}).focus()
    await page.keyboard.press("1")
    await page.waitForFunction("window.hotkeyFixture.actions.length===2")
    assert.equal((await last()).source,"pane-two")
    assert.equal((await last()).handle,4)
    pass("the same hotkey is confined to the currently focused pane")
    await page.getByRole("button",{name:"band first",exact:true}).focus()
    await page.keyboard.press("w")
    await page.waitForFunction("window.hotkeyFixture.actions.length===3")
    assert.equal((await last()).source,"band")
    assert.equal((await last()).handle,2)
    pass("AbovePrompt buttons use the real site action route with current scope and generation")
    await first.focus()
    await page.evaluate("window.hotkeyFixture.hold()")
    await page.keyboard.press("w")
    await page.waitForFunction("window.hotkeyFixture.actions.length===4")
    await page.waitForFunction("document.querySelector('[data-function-pane=\"pane-one\"] button[data-function-hotkey]').getAttribute('aria-disabled')==='true'")
    await page.keyboard.press("w")
    assert.equal(await count(),4)
    await page.evaluate("window.hotkeyFixture.finish()")
    await page.waitForFunction("!document.querySelector('[data-function-pane=\"pane-one\"] button[data-function-hotkey]').hasAttribute('aria-disabled')")
    pass("busy buttons cannot be activated again while the first action is unresolved")
    await first.focus()
    await page.evaluate("document.body.insertAdjacentHTML('beforeend','<div role=\"dialog\">Modal</div>')")
    await page.keyboard.press("w")
    assert.equal(await count(),4)
    await page.evaluate("document.querySelector('[role=dialog]').remove()")
    pass("an open dialog suppresses background pane hotkeys")
    for (const scheme of ["light", "dark"] as const) {
      const theme = THEME_DEFINITIONS.find(value => value.colorScheme === scheme)!
      await page.evaluate(({ scheme, palette }) => {
        document.documentElement.dataset.colorScheme = scheme
        document.documentElement.classList.toggle("dark", scheme === "dark")
        document.body.style.backgroundColor = palette.background
        document.body.style.color = palette.foreground
      }, { scheme, palette: theme.palette })
      for (const label of ["nested-direct", "nested-box-fragment", "nested-client", "nested-inverse"]) {
        const colors = await page.getByText(label, { exact: true }).evaluate(element => ({
          color: getComputedStyle(element).color,
          background: getComputedStyle(element).backgroundColor
        }))
        assert.equal(colors.color, label === "nested-inverse" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)")
        if (label === "nested-inverse") assert.equal(colors.background, "rgb(255, 255, 255)")
      }
      assert.equal(await page.locator("[data-nested-style] > span").evaluate(element =>
        getComputedStyle(element).backgroundColor), "rgb(0, 0, 0)")
      for (const label of ["nested-white-black", "nested-white-inverse"]) {
        const colors = await page.getByText(label, { exact: true }).evaluate(element => ({
          color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor
        }))
        assert.equal(colors.color, label === "nested-white-inverse" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)")
        if (label === "nested-white-inverse") assert.equal(colors.background, "rgb(0, 0, 0)")
      }
      assert.equal(await page.locator("[data-nested-white] > span").evaluate(element =>
        getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)")
      pass(`${scheme}: real Element inherits explicit backgrounds across text, fragment, box and client, including inverse`)
      const drawing = await page.locator("[data-original-style] > div").evaluate(box => {
        const expected = (variable: string) => {
          const probe = document.createElement("span")
          probe.style.color = `var(${variable})`
          box.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }
        const inverse=box.children[0], start=box.children[1], end=box.children[2], wrapped=box.children[3]
        const text=start.firstElementChild!.firstChild!
        const tail=document.createRange();tail.setStart(text,text.textContent!.length-7);tail.setEnd(text,text.textContent!.length)
        const prefix=document.createRange();prefix.setStart(text,0);prefix.setEnd(text,1)
        const bounds=start.getBoundingClientRect(), tailBounds=tail.getBoundingClientRect()
        return {expectedBorder:expected("--mods-ansi-magenta"),expectedBackground:"rgb(0, 255, 255)",border:getComputedStyle(box).borderTopColor,radius:getComputedStyle(box).borderTopLeftRadius,
          margin:getComputedStyle(box).marginTop,color:getComputedStyle(inverse).color,
          background:getComputedStyle(inverse).backgroundColor,startDirection:getComputedStyle(start).direction,
          innerDirection:getComputedStyle(start.firstElementChild!).direction,
          tailVisible:tailBounds.left>=bounds.left&&tailBounds.right<=bounds.right+1,
          prefixClipped:prefix.getBoundingClientRect().right<bounds.left,
          endOverflow:getComputedStyle(end).textOverflow,wrap:getComputedStyle(wrapped).whiteSpace,
          wrappedHeight:wrapped.getBoundingClientRect().height}
      })
      assert.deepEqual({border:drawing.border,radius:drawing.radius,margin:drawing.margin,
        color:drawing.color,background:drawing.background},
        {border:drawing.expectedBorder,radius:"6px",margin:"8px",color:"rgb(0, 0, 128)",background:drawing.expectedBackground})
      assert.equal(drawing.startDirection,"rtl")
      assert.equal(drawing.innerDirection,"ltr")
      assert(drawing.tailVisible&&drawing.prefixClipped,JSON.stringify(drawing))
      assert.equal(drawing.endOverflow,"ellipsis")
      assert.equal(drawing.wrap,"pre-wrap")
      assert(drawing.wrappedHeight>20)
      pass(`${scheme} host palette: original rounded border, margin, inverse colors, visible path tail and preserved newlines`)
    }
    assert.deepEqual(errors,[])
    await page.screenshot({path:resolve(output,"keyboard.png"),fullPage:true})
    writeFileSync(resolve(output,"report.json"),JSON.stringify({checks,errors,environment:await page.evaluate("window.hotkeyFixture.environment")},null,2))
  } catch(error) {
    await page.screenshot({path:resolve(output,"failure.png"),fullPage:true}).catch(()=>{})
    writeFileSync(resolve(output,"failure.json"),JSON.stringify({checks,errors,error:String(error),
      environment:await page.evaluate("window.hotkeyFixture.environment").catch(()=>null),
      body:await page.locator("body").innerText().catch(()=>"")},null,2))
    throw error
  } finally {await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
