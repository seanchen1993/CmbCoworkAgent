/** Real message components: protected streaming prefixes, never raw or retired replies. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const output = resolve("output/function-stream-projection-browser")
  mkdirSync(output, { recursive: true })
  const evidence: unknown[] = []
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import {ModsChatScope,useModsChatState} from './src/renderer/src/lib/mods-chat-scope';
      import {FunctionMessageText} from './src/renderer/src/components/chat/FunctionMessageText';
      import {FunctionSite} from './src/renderer/src/components/chat/FunctionSite';
      {const events=new Set(),waiting=[],calls=[],raw=[];
      let holding=false,source=1,serial=0,stream;
      window.api.mods.siteRead=async(thread,component,props)=>{
        const capturedSource=source,id=++serial;
        calls.push({thread,length:props.text.length,source:capturedSource});
        if(holding)await new Promise(done=>waiting.push(done));
        else await new Promise(done=>setTimeout(done,160));
        return {state:'projected',snapshot:{scopeId:'scope-'+thread,key:'row-'+thread,
          version:String(id),expiresAt:Date.now()+120000,
          data:{component,hostMessage:{...props,text:'SAFE_SOURCE_'+capturedSource+':'+props.text}}}}};
      window.api.mods.onCardsChanged=listener=>{events.add(listener);return()=>events.delete(listener)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.chatDisplayCapability=async()=>true;
      window.api.models={...window.api.models,onUserInfoChanged:()=>()=>{}};
      window.api.threads={...window.api.threads,onThreadsChanged:()=>()=>{}};
      window.clicks=0;
      new MutationObserver(records=>{for(const record of records)if([record.target,...record.addedNodes]
        .some(node=>node.textContent?.includes('RAW_MUST_NOT_SHOW')))raw.push(true)})
        .observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true});
      function Fixture(){const [text,setText]=useState('x'.repeat(11000)),[thread,setThread]=useState('a'),
        [unsafe,setUnsafe]=useState(false);
        const scope=useModsChatState(thread,'workspace');
        window.fixture={calls,raw,text:setText,thread:setThread,
          unsafe:setUnsafe,
          hold:()=>holding=true,pending:()=>waiting.length,
          release:()=>waiting.splice(0).forEach(done=>done()),
          unhold:()=>{holding=false;waiting.splice(0).forEach(done=>done())},
          source:value=>source=value,
          emit:scope=>{for(const fn of events)fn({threadId:thread,scope})},
          stream:()=>{clearInterval(stream);stream=setInterval(()=>setText(value=>value+' token'),20)},
          stop:()=>clearInterval(stream),close:()=>{clearInterval(stream);host.unmount()}};
        return <ModsChatScope.Provider value={{threadId:thread,...scope}}>
          {unsafe ? <FunctionSite threadId={thread} component='AssistantMessage' presentationId='unsafe'
            facts={{text,isFirstOfReply:true}} fallback={<p>RAW_MUST_NOT_SHOW</p>}/> :
          <FunctionMessageText threadId={thread} messageId='stream' role='assistant' text={text}
            isExpanded isFirstOfReply fallback={<p>RAW_MUST_NOT_SHOW</p>}
            renderText={safe=><div data-safe data-thread={thread}><span data-body>{safe}</span>
              <button onClick={()=>window.clicks++}>Copy protected text</button></div>}/>}
        </ModsChatScope.Provider>}
      host.render(<Fixture/>)}
    `,
      [browserWorkerPlugin()]
    )
    const call = (script: string) => page.evaluate(script)
    const safe = page.locator("[data-safe]")
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    await call("window.fixture.stream()")
    // Every reply is older than the current text; waiting for a quiet stream is not acceptable.
    await safe.waitFor({ timeout: 1200 })
    const body = page.locator("[data-body]")
    const first = (await body.innerText()).length
    await page.waitForTimeout(5500)
    assert((await body.innerText()).length > first, "Protected prefixes must keep advancing")
    await page.waitForFunction(
      () =>
        document.querySelector("[data-function-site-projected]")?.getAttribute("aria-disabled") ===
        "true"
    )
    await page.locator("[data-safe] button").evaluate((button: HTMLButtonElement) => button.click())
    assert.equal(
      await call("window.clicks"),
      0,
      "An older protected prefix grants no fresh callback"
    )
    assert.equal(await page.getByText("内容加载较慢，请稍候…", { exact: true }).count(), 0)
    evidence.push({
      scenario: "cold-long-stream",
      readableDuringStream: true,
      reads: await call("window.fixture.calls.length"),
      slowWarning: false
    })
    // Resizing/zoom-equivalent CSS viewport changes must not starve streaming text.
    for (let step = 0; step < 16; step++) {
      await page.setViewportSize({ width: 640 + (step % 4) * 160, height: 600 + (step % 3) * 100 })
      await page.waitForTimeout(40)
      assert.equal(await safe.count(), 1)
    }
    assert((await body.innerText()).length > first)
    assert.equal(await page.getByText("内容加载较慢，请稍候…", { exact: true }).count(), 0)
    evidence.push({ scenario: "stream-during-viewport-resize", readable: true })
    await call("window.fixture.stop()")
    await page.waitForTimeout(220)

    // Cross the real 10k routing boundary while tokens continue after the keyed remount.
    await call("window.fixture.text('p'.repeat(9900))")
    await page.waitForFunction(() =>
      document.querySelector("[data-body]")?.textContent?.endsWith("p")
    )
    await call("window.fixture.text('p'.repeat(10001));window.fixture.stream()")
    await safe.waitFor({ timeout: 1200 })
    await page.waitForTimeout(400)
    assert((await body.innerText()).length > 10001)
    evidence.push({ scenario: "cross-10k-stream", readableDuringStream: true })
    await call("window.fixture.stop()")
    await page.waitForTimeout(220)

    // An A -> B -> A edit must not resurrect an earlier A-prefix reply.
    await call("window.fixture.hold();window.fixture.text('A'.repeat(11000))")
    await page.waitForFunction("window.fixture.pending()===1")
    await call("window.fixture.text('B'.repeat(11000))")
    await settle()
    await call("window.fixture.text('A'.repeat(11000)+' tail')")
    await settle()
    await call("window.fixture.release()")
    await page.waitForFunction("window.fixture.pending()===1")
    assert.equal(await safe.count(), 0, "Replaced lineage must not publish its old A reply")
    await call("window.fixture.unhold()")
    await safe.waitFor()
    assert((await body.innerText()).endsWith(" tail"))
    evidence.push({ scenario: "A-B-A", oldReplyRejected: true })

    // Truncation withdraws a committed longer drawing, even while the shorter read waits.
    await call("window.fixture.hold();window.fixture.text('A'.repeat(10500))")
    await page.waitForFunction("window.fixture.pending()===1")
    assert.equal(await safe.count(), 0)
    await call("window.fixture.unhold()")
    await safe.waitFor()
    assert.equal((await body.innerText()).length, "SAFE_SOURCE_1:".length + 10500)
    evidence.push({ scenario: "truncation", longerReplyHidden: true })

    // A late response from the old conversation cannot enter the new conversation.
    await call("window.fixture.hold();window.fixture.text('C'.repeat(11000))")
    await page.waitForFunction("window.fixture.pending()===1")
    await call("window.fixture.thread('b')")
    await page.waitForFunction("window.fixture.pending()===2")
    assert.equal(await safe.count(), 0)
    await call("window.fixture.unhold()")
    await safe.waitFor()
    assert.equal(await safe.getAttribute("data-thread"), "b")
    evidence.push({ scenario: "thread-switch", oldThreadRejected: true })

    // Retiring a source revokes both a committed frame and its pending prefix.
    await call("window.fixture.hold();window.fixture.text('C'.repeat(11000)+' more')")
    await page.waitForFunction("window.fixture.pending()===1")
    await call("window.fixture.emit('source-retiring:1');window.fixture.release()")
    await settle()
    assert.equal(await safe.count(), 0)
    await call("window.fixture.source(2);window.fixture.emit('source-replaced:2')")
    await page.waitForFunction("window.fixture.pending()===1")
    assert.equal(await safe.count(), 0)
    await call("window.fixture.unhold()")
    await safe.waitFor()
    assert((await body.innerText()).startsWith("SAFE_SOURCE_2:"))
    // Without a captured native renderer, an old prefix cannot use the raw fallback.
    await call(
      "window.fixture.hold();window.fixture.unsafe(true);window.fixture.text('U'.repeat(11000))"
    )
    await page.waitForFunction("window.fixture.pending()===1")
    await call("window.fixture.text('U'.repeat(11000)+' new');window.fixture.release()")
    await page.waitForFunction("window.fixture.pending()===1")
    assert.equal(await page.locator("[data-function-site-projected]").count(), 0)
    assert.equal(await page.getByText("RAW_MUST_NOT_SHOW", { exact: true }).count(), 0)
    await call("window.fixture.unhold()")
    await page.locator("[data-function-site-projected]").waitFor()
    assert.deepEqual(await call("window.fixture.raw"), [])
    assert.deepEqual(errors, [])
    evidence.push({ scenario: "source-retirement", retiredReplyRejected: true })
    await call("window.fixture.close()")
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ passed: true, evidence }, null, 2)
    )
    console.log(
      "PASS real streaming projection: protected prefixes advance; replacement, truncation, thread and source revoke them"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
