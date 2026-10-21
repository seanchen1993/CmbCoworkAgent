/** Real navigator and DOM scroll events; counts transcript work independently of elapsed time. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/chat-scroll-navigator-performance")
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React,{useRef,useState}from"react";
        import{createRoot}from"react-dom/client";
        import{ChatScrollNavigator}from"./src/renderer/src/components/chat/ChatScrollNavigator";
        const stats={children:0,scrollAdds:0,scrollRemoves:0,rectReads:0};
        const add=HTMLElement.prototype.addEventListener,remove=HTMLElement.prototype.removeEventListener;
        HTMLElement.prototype.addEventListener=function(type,...rest){
          if(type==='scroll'&&this.hasAttribute('data-radix-scroll-area-viewport'))stats.scrollAdds++;
          return add.call(this,type,...rest)
        };
        HTMLElement.prototype.removeEventListener=function(type,...rest){
          if(type==='scroll'&&this.hasAttribute('data-radix-scroll-area-viewport'))stats.scrollRemoves++;
          return remove.call(this,type,...rest)
        };
        const rect=HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect=function(){
          if(this.hasAttribute('data-question-row'))stats.rectReads++;
          return rect.call(this)
        };
        const original=Array.from({length:200},(_,index)=>({id:'question-'+index,role:'user',content:'Question '+index}));
        const noop=()=>{};
        function Fixture(){
          const root=useRef(null),[revision,setRevision]=useState(0),[prepended,setPrepended]=useState(false);
          const messages=prepended?[{id:'earlier',role:'user',content:'Earlier'},...original]:original.slice();
          window.navigatorFixture={stats,token:()=>setRevision(value=>value+1),prepend:()=>setPrepended(true),
            scroll:top=>{const viewport=root.current.querySelector('[data-radix-scroll-area-viewport]');viewport.scrollTop=top;viewport.dispatchEvent(new Event('scroll'))}};
          return <ChatScrollNavigator messages={messages} questionStructureRevision={prepended?2:1}
            historyGapBeforeMessageId={null} canLoadReleasedHistory={false} onLoadReleasedHistoryWindow={noop}
            onRevealMessage={noop} scrollContainerRef={root} rightPanelCollapsed={false}>
            {({setMessageRef})=>{stats.children++;return <div ref={root} data-revision={revision}>
              <div data-radix-scroll-area-viewport style={{height:400,width:600,overflow:'auto'}}>
                {messages.map(message=><div data-question-row key={message.id} ref={setMessageRef(message.id,'user')}
                  style={{height:100,boxSizing:'border-box',borderBottom:'1px solid gray'}}>{message.content}</div>)}
              </div></div>}}
          </ChatScrollNavigator>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: "window.__name = value => value" })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByRole("button", { name: "滚动到第 1 次提问", exact: true }).waitFor()
    const evidence = await page.evaluate(async () => {
      const fixture = () =>
        (
          window as unknown as {
            navigatorFixture: {
              stats: {
                children: number
                scrollAdds: number
                scrollRemoves: number
                rectReads: number
              }
              scroll(top: number): void
              token(): void
              prepend(): void
            }
          }
        ).navigatorFixture
      const settle = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await settle()
      const initial = { ...fixture().stats }
      for (let index = 1; index <= 30; index++) {
        fixture().scroll(index * 300)
        await settle()
      }
      const scrolled = { ...fixture().stats }
      for (let token = 0; token < 30; token++) {
        fixture().token()
        await settle()
      }
      const streamed = { ...fixture().stats }
      fixture().prepend()
      await settle()
      fixture().scroll(500)
      await settle()
      const active = document.querySelector('[data-chat-scroll-marker][aria-current="location"]')
      return { initial, scrolled, streamed, activeQuestion: active?.getAttribute("aria-label") }
    })
    const baseline = process.argv.includes("--record-baseline")
    writeFileSync(
      resolve(output, baseline ? "before.json" : "after.json"),
      JSON.stringify({ ...evidence, errors }, null, 2) + "\n"
    )
    if (!baseline) {
      assert.equal(
        evidence.scrolled.children,
        evidence.initial.children,
        "Moving the active question must not rebuild the transcript render prop"
      )
      assert.equal(
        evidence.streamed.scrollAdds,
        evidence.scrolled.scrollAdds,
        "Text-only parent renders must not reattach the navigator scroll listener"
      )
      assert.equal(evidence.streamed.scrollRemoves, evidence.scrolled.scrollRemoves)
      assert(
        evidence.scrolled.rectReads - evidence.initial.rectReads <= 30 * 10,
        "Navigator geometry reads must remain logarithmic in mounted question count"
      )
      assert.equal(
        evidence.activeQuestion,
        "滚动到第 6 次提问",
        "Prepending history must invalidate mounted question positions"
      )
      assert.deepEqual(errors, [])
    }
    console.log(JSON.stringify({ baseline, ...evidence, errors }))
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
