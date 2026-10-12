/** Actual Cmb virtualizer integration: variable-height rows, bounded DOM,
 * inverse paging and targeted navigation. No model/network or private data. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      contents: `import React,{useCallback,useRef,useState}from'react';
      import{createRoot}from'react-dom/client';
      import{BotTranscriptList}from'./src/renderer/src/components/bots/BotTranscriptList';
      const page=(start,count)=>Array.from({length:count},(_,i)=>({id:'m-'+(start+i),sequence:start+i,text:'Message '+(start+i),attachments:[]}));
      function Fixture(){
        const[parent,setParent]=useState(null),[messages,setMessages]=useState(()=>page(100,1500)),[view,setView]=useState('main'),[location,setLocation]=useState(undefined);
        const list=useRef(null),[revision,setRevision]=useState(0);
        const mounted=useCallback(()=>setRevision(n=>n+1),[]),height=useCallback(()=>{},[]);
        window.fixture={setPage:(start,count,nextLocation)=>{setLocation(nextLocation);setMessages(page(start,count))},jump:index=>list.current.scrollToIndex({index,align:'center'}),setView};
        return <div id="viewport" ref={setParent} style={{height:500,overflowY:'auto',width:640}} data-revision={revision}>
          <BotTranscriptList viewId={view} messages={messages} scrollParent={parent} listRef={list} initialLocation={location} onRowsRendered={mounted} onHeightChanged={height}
            renderMessage={(m,i)=><article tabIndex={-1} data-message-id={m.id} data-relative-index={i} style={{marginBottom:22,padding:12,height:45+(m.sequence%5)*19}}>{m.text}</article>}/>
        </div>
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent(
      '<style>[data-item-index]{display:flow-root}body{margin:0}</style><div id="root"></div>'
    )
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.locator('[data-message-id="m-1599"]').waitFor()
    assert.ok(
      (await page.locator("article").count()) < 60,
      "1500 resident rows must not mount 1500 DOM rows"
    )
    await page.evaluate(() =>
      (window as unknown as { fixture: { jump(index: number): void } }).fixture.jump(700)
    )
    const target = page.locator('[data-message-id="m-800"]')
    await target.waitFor()
    assert.equal(await target.getAttribute("data-relative-index"), "700")
    await page.waitForTimeout(250)
    const anchor = await page.locator("#viewport").evaluate((node) => {
      const top = node.getBoundingClientRect().top
      const row = [...node.querySelectorAll<HTMLElement>("article")].find(
        (item) => item.getBoundingClientRect().bottom > top
      )!
      return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top }
    })
    await page.evaluate(() =>
      (
        window as unknown as { fixture: { setPage(start: number, count: number): void } }
      ).fixture.setPage(0, 1500)
    )
    const anchored = page.locator(`[data-message-id="${anchor.id}"]`)
    await anchored.waitFor()
    await page.waitForTimeout(250)
    assert.ok(
      Math.abs((await anchored.boundingBox())!.y - anchor.top) < 4,
      "Prepending and releasing the tail preserves the measured visible anchor"
    )
    await page.evaluate(() =>
      (
        window as unknown as { fixture: { setPage(start: number, count: number): void } }
      ).fixture.setPage(100, 1500)
    )
    await anchored.waitFor()
    await page.waitForTimeout(250)
    assert.ok(
      Math.abs((await anchored.boundingBox())!.y - anchor.top) < 4,
      "Releasing the head preserves the measured visible anchor"
    )
    await page.evaluate(() =>
      (
        window as unknown as {
          fixture: { setPage(start: number, count: number, location: object): void }
        }
      ).fixture.setPage(5000, 1500, { index: 500, align: "center" })
    )
    await page.locator('[data-message-id="m-5500"]').waitFor()
    assert.ok((await page.locator("article").count()) < 60)
    const beforeBranch = Number(await page.locator("#viewport").getAttribute("data-revision"))
    await page.evaluate(() =>
      (window as unknown as { fixture: { setView(id: string): void } }).fixture.setView("branch")
    )
    await page.locator('[data-message-id="m-5500"]').waitFor()
    await page.waitForFunction(
      (revision) => Number(document.getElementById("viewport")!.dataset.revision) > revision,
      beforeBranch
    )
    assert.deepEqual(errors, [])
    console.log("PASS bounded transcript DOM, inverse paging anchors and targeted/view navigation")
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
