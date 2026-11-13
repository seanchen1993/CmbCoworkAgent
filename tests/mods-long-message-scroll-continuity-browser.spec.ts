/** Real Markdown geometry, including a manually expanded protected reply. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-long-message-scroll-continuity-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = [],
    evidence: unknown[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    for (const kind of ["assistant-default", "assistant-expanded", "user-wrapped"]) {
      const expanded = kind === "assistant-expanded",
        user = kind === "user-wrapped"
      for (const position of ["middle", "tail"]) {
        await mount(
          page,
          `
          import {ModsChatScope} from './src/renderer/src/lib/mods-chat-scope';
          import {FunctionMessageText} from './src/renderer/src/components/chat/FunctionMessageText';
          import {StreamingMarkdown} from './src/renderer/src/components/chat/StreamingMarkdown';
          import {FunctionSitePresentationCache} from './src/renderer/src/lib/function-site-presentation';
          {
            const caches=new Map(),releases=[],cards=new Set(),text=Array.from({length:1800},(_,i)=>'PARA_'+i+' '+ 'SAFE_WORD '.repeat(4)+'\\n\\n').join('');
            let held=false,authorized=true;
            window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
            window.api.mods.onConfigurationChanged=()=>()=>{};
            window.api.mods.siteRead=async(thread,component,props,id)=>{
              if(held)await new Promise(done=>releases.push(done));
              return{state:'projected',snapshot:{scopeId:'scope-'+thread,key:'host-'+thread,
                version:'v1',expiresAt:Date.now()+120000,data:{component,hostMessage:props}}};
            };
            const cache=thread=>{if(!caches.has(thread))caches.set(thread,new FunctionSitePresentationCache(()=>authorized));return caches.get(thread)};
            function Chat({thread,width}){return <ModsChatScope.Provider value={{threadId:thread,enabled:true,ready:true,isCurrent:()=>authorized,presentationCache:cache(thread)}}>
              <div data-radix-scroll-area-viewport style={{height:400,width,overflow:'auto'}}>
                <div data-chat-message-row>
                  <div style={${user}?{width:'80%',marginLeft:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'15px/24px sans-serif'}:{}}>
                  <FunctionMessageText threadId={thread} messageId='message' role=${JSON.stringify(user ? "user" : "assistant")}
                    text={thread==='A'?text:'Alternate message'} isExpanded isFirstOfReply fallback={null}
                    renderText={safe=>${user}?<span data-chat-search-text>{safe}</span>:<StreamingMarkdown>{safe}</StreamingMarkdown>}/>
                  </div>
                </div>
              </div>
            </ModsChatScope.Provider>}
            function Fixture(){const[thread,setThread]=useState('A'),[width,setWidth]=useState(700),[revision,setRevision]=useState(0);window.longScroll={go:setThread,hold:()=>held=true,resize:setWidth,
              source:()=>{cache(thread).invalidateProjection('host-'+thread);for(const fn of cards)fn({threadId:thread,scope:'site-presentations:*'})},
              revoke:()=>{authorized=false;setRevision(value=>value+1)},
              waiting:()=>releases.length,release:()=>{held=false;releases.splice(0).forEach(done=>done())}};
              return <Chat key={thread} thread={thread} width={width} revision={revision}/>}
            host.render(<Fixture/>);
          }
        `,
          [browserWorkerPlugin()]
        )
        await page.locator("[data-function-site-projected]").waitFor()
        if (expanded) await page.getByRole("button", { name: "展开全文", exact: true }).click()
        const viewport = page.locator("[data-radix-scroll-area-viewport]")
        const saved = await viewport.evaluate((element, position) => {
          element.scrollTop = position === "tail" ? element.scrollHeight : element.scrollHeight / 2
          const saved = element.scrollTop
          if (position === "tail")
            (window as unknown as { longScroll: { go(thread: string): void } }).longScroll.go("B")
          return saved
        }, position)
        if (position !== "tail")
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => requestAnimationFrame(() => done()))
                )
              )
          )
        if (position !== "tail") await page.evaluate("window.longScroll.go('B')")
        await page.getByText("Alternate message", { exact: true }).waitFor()
        await page.evaluate("window.longScroll.hold();window.longScroll.go('A')")
        await page.waitForFunction("window.longScroll.waiting()===1")
        await page.locator("[data-function-site-cached]").waitFor()
        await viewport.evaluate((element, saved) => {
          element.scrollTop = saved
        }, saved)
        const snapshot = await viewport.evaluate((element) => {
          const area = element.getBoundingClientRect(),
            walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          let visible = 0
          for (
            let count = 0, node = walker.nextNode();
            node && count < 10000;
            node = walker.nextNode(), count++
          ) {
            if (
              !node.textContent?.trim() ||
              !node.parentElement?.closest("[data-chat-search-text]")
            )
              continue
            const range = document.createRange()
            range.selectNodeContents(node)
            const box = range.getBoundingClientRect()
            range.detach()
            if (box.width > 0 && box.height > 0 && box.bottom > area.top && box.top < area.bottom)
              visible++
          }
          return {
            visible,
            top: element.scrollTop,
            height: element.scrollHeight,
            client: element.clientHeight
          }
        })
        evidence.push({ kind, position, saved, snapshot })
        assert(snapshot.visible > 0, `Protected cached ${kind} ${position} must remain readable`)
        assert.equal(await page.locator("[data-function-message-viewport]").count(), 1)
        assert.equal(
          await page
            .locator("[data-function-message-viewport] a, [data-function-message-viewport] button")
            .count(),
          0
        )
        await page.screenshot({ path: resolve(output, `${kind}-${position}.png`) })
        await page.evaluate("window.longScroll.resize(650)")
        await page.waitForFunction("!document.querySelector('[data-function-message-viewport]')")
        await page.evaluate("window.longScroll.resize(700)")
        await page.locator("[data-function-message-viewport]").waitFor()
        await page.evaluate("window.longScroll.source()")
        await page.waitForFunction("!document.querySelector('[data-function-message-viewport]')")
        await page.evaluate("window.longScroll.release()")
        await page.locator("[data-function-site-projected]").waitFor()
        await page.evaluate('window.longScroll.go("B")')
        await page.getByText("Alternate message", { exact: true }).waitFor()
        await page.evaluate('window.longScroll.hold();window.longScroll.go("A")')
        await page.locator("[data-function-site-cached]").waitFor()
        await page.evaluate("window.longScroll.revoke()")
        await page.waitForFunction("!document.querySelector('[data-function-site-cached]')")
        await page.evaluate("window.longScroll.release()")
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ evidence, errors }, null, 2))
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
