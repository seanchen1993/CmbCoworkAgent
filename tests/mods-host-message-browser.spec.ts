/** Real message/Markdown/authorization-lifetime components; controlled native bridge data only. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-host-message-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const long =
    "# Complete report\n\n[far reference][destination]\n\n" +
    "RAW_SECRET paragraph with a complete sentence.\n\n".repeat(280) +
    "| Column | Result |\n| --- | --- |\n| final | complete |\n\n" +
    "[destination]: https://example.test/whole-markdown"
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionMessageText} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionMessageText.tsx"))};
      import {StaticMarkdownFormatting} from ${JSON.stringify(resolve("src/renderer/src/components/chat/StreamingMarkdown.tsx"))};
      import remarkGfm from 'remark-gfm';
      {const calls=[],rendered=[],cards=new Set(),owners=new Map(),releases=[];
      const long=${JSON.stringify(long)};let ownerSequence=0,held=false,fail=false,sourceVersion=1,epoch=0;
      const gate=async()=>{if(held)await new Promise(resolve=>releases.push(resolve))};
      const protect=(props,version)=>({...props,text:props.text.replaceAll('RAW_SECRET','SAFE_'+version).replaceAll('RAW_SHORT','SAFE_SHORT')});
      const read=async(thread,component,props)=>{
        const input=structuredClone(props),version=sourceVersion;
        const native=input.text.length>10000||!input.text.trim();
        calls.push([native?'host':'ordinary',thread,input.text.length]);
        if(!native){const owner='owner-'+(++ownerSequence);owners.set(owner,{thread,component});return{state:'mounted',owner}}
        await gate();if(fail){fail=false;throw Error('MODS_OUTPUT_LIMIT')}
        return{state:'projected',snapshot:{scopeId:'scope-'+thread,key:'message-key',version:'v'+version,expiresAt:Date.now()+120000,
          data:{component,hostMessage:protect(input,version)}}};
      };
      window.api.mods.siteRead=read;
      window.api.mods.siteUnmount=async(thread,owner)=>{calls.push(['unmount',thread,owner]);owners.delete(owner)};
      window.api.mods.siteMountOutcome=async()=>{throw Error('Legacy mount must not receive a host-only body')};
      window.api.mods.siteRender=async(thread,owner,props)=>{
        const input=structuredClone(props),version=sourceVersion,row=owners.get(owner);calls.push(['render',thread,owner,input.text.length]);
        await gate();return{key:'engine:'+owner,id:owner,plugin:'fixture',generation:'gen-'+owner,title:'Native',rows:12,closeOnEscape:false,
          tree:{type:'engine',ref:0},nativeContent:{component:row.component,entries:[{ref:0,props:protect(input,version)}]}};
      };
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      function Fixture(){const[text,setText]=useState('RAW_SHORT initial'),[role,setRole]=useState('assistant'),[enabled,setEnabled]=useState(true),[revision,setRevision]=useState(0);
        const captured=epoch;
        window.hostMessages={calls,rendered,long,text:setText,role:setRole,
          enable:value=>{epoch++;setEnabled(value)},
          hold:()=>held=true,waiting:()=>releases.length,
          release:()=>{held=false;releases.splice(0).forEach(resolve=>resolve())},
          fail:()=>fail=true,
          legacy:value=>{window.api.mods.siteRead=value?undefined:read;setRevision(value=>value+1)},
          source:()=>{sourceVersion++;for(const fn of cards)fn({threadId:'thread',scope:'source-retiring:'+sourceVersion});
            for(const fn of cards)fn({threadId:'thread',scope:'source-replaced:'+(sourceVersion+1)})}
        };
        return <ModsChatScope.Provider value={{threadId:'thread',enabled,ready:true,isCurrent:()=>captured===epoch}}>
          <article data-revision={revision}><FunctionMessageText threadId='thread' messageId='message' presentationId='body' role={role}
            text={text} isExpanded isFirstOfReply fallback={<p data-original>{text}</p>}
            renderText={safe=>{rendered.push(safe);return <StaticMarkdownFormatting text={safe} remarkPlugins={[remarkGfm]}/>}}/>
          </article></ModsChatScope.Provider>;
      }
      host.render(<Fixture/>)}
    `,
      [browserWorkerPlugin()],
      false
    )
    const act = (code: string) => page.evaluate(code)
    const native = () => page.locator("[data-function-site-projected]")
    await page.getByText("SAFE_SHORT initial", { exact: true }).waitFor()
    assert.equal(await page.locator("[data-original]").count(), 0)
    await act("window.hostMessages.text(window.hostMessages.long)")
    await native().waitFor()
    await page.getByRole("link", { name: "far reference", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("link", { name: "far reference", exact: true }).getAttribute("href"),
      "https://example.test/whole-markdown"
    )
    assert.equal(await page.locator("table").count(), 1)
    assert.equal(await page.locator(".streaming-markdown").count(), 1)
    assert.equal(
      await page
        .locator("body")
        .innerText()
        .then((text) => text.includes("RAW_SECRET")),
      false
    )
    assert.equal(await act("window.hostMessages.calls.filter(x=>x[0]==='unmount').length"), 1)
    assert.equal(
      await act("window.hostMessages.rendered.at(-1)"),
      long.replaceAll("RAW_SECRET", "SAFE_1")
    )
    console.log(
      "PASS complete long Markdown uses one protected body, distal reference/table and owner retirement"
    )

    await act("window.hostMessages.text('RAW_SHORT again')")
    await page.getByText("SAFE_SHORT again", { exact: true }).waitFor()
    assert.equal(await act("window.hostMessages.calls.filter(x=>x[0]==='ordinary').length"), 2)
    await act(
      "window.hostMessages.hold();window.hostMessages.text(String.fromCharCode(32,32,10,9))"
    )
    await page.waitForFunction("window.hostMessages.waiting()===1")
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    assert.equal(await page.getByText("SAFE_SHORT again", { exact: true }).count(), 0)
    assert.equal(await page.locator("[data-original]").count(), 0)
    await act("window.hostMessages.release()")
    await native().waitFor({ state: "attached" })
    assert.equal(
      await page
        .locator("article")
        .innerText()
        .then((text) => text.trim()),
      ""
    )
    console.log(
      "PASS bounded→host→bounded obtains fresh owners; blank protection has no skeleton or old message"
    )

    await act("window.hostMessages.hold();window.hostMessages.text('RAW_SHORT held stale')")
    await page.waitForFunction("window.hostMessages.waiting()===1")
    await act("window.hostMessages.text(window.hostMessages.long)")
    await page.waitForFunction("window.hostMessages.waiting()===2")
    await act("window.hostMessages.release()")
    await native().waitFor()
    assert.equal(
      await act("window.hostMessages.rendered.some(text=>text.includes('held stale'))"),
      false
    )
    assert.equal(await act("window.hostMessages.calls.filter(x=>x[0]==='unmount').length"), 3)

    await act(
      "window.hostMessages.hold();window.hostMessages.text(window.hostMessages.long+' SOURCE_CHANGE')"
    )
    await page.waitForFunction("window.hostMessages.waiting()===1")
    await act("window.hostMessages.source()")
    await page.waitForFunction("window.hostMessages.waiting()===2")
    await act("window.hostMessages.release()")
    await page.waitForFunction("window.hostMessages.rendered.at(-1).includes('SAFE_2')")
    assert.equal(
      await act(
        "window.hostMessages.rendered.some(text=>text.includes('SOURCE_CHANGE')&&text.includes('SAFE_1'))"
      ),
      false
    )
    console.log(
      "PASS boundary/source retirement rejects held old drawings and old host DTOs before publication"
    )

    await act(
      "window.hostMessages.role('user');window.hostMessages.text(window.hostMessages.long+' USER')"
    )
    await native().waitFor()
    await page.getByText("USER", { exact: false }).waitFor()
    assert.equal(await page.locator('[data-function-site="UserMessage"]').count(), 1)
    assert.equal(await page.locator("[data-original]").count(), 0)
    await act(
      "window.hostMessages.fail();window.hostMessages.text(window.hostMessages.long+' FAILED')"
    )
    await page.getByRole("alert").waitFor()
    assert.equal(
      await page
        .locator("article")
        .innerText()
        .then((text) => text.includes("RAW_SECRET")),
      false
    )
    assert.equal(await page.locator("[data-original]").count(), 0)
    console.log(
      "PASS both message roles use host data and failed protection never exposes original text"
    )

    const callsBefore = await act("window.hostMessages.calls.length")
    await act("window.hostMessages.legacy(true)")
    await page.getByRole("alert").filter({ hasText: "当前版本无法安全显示" }).waitFor()
    assert.equal(await act("window.hostMessages.calls.length"), callsBefore)
    await act("window.hostMessages.enable(false)")
    await page.locator("[data-original]").waitFor()
    assert.equal(await page.locator("[data-original]").textContent(), long + " FAILED")
    console.log(
      "PASS unsupported protected peer fails closed; explicitly inactive scope retains original rendering"
    )
    assert.deepEqual(errors, [])
    const evidence = {
      passed: true,
      chars: long.length,
      errors,
      calls: await act("window.hostMessages.calls"),
      scope:
        "Real React/Markdown/lifetime; bridge is controlled DTO data, not native permission acceptance"
    }
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2))
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    writeFileSync(
      resolve(output, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          errors,
          body: await page.locator("body").innerText(),
          calls: await actSafe(page)
        },
        null,
        2
      )
    )
    throw error
  } finally {
    await browser.close()
  }
}
async function actSafe(page: import("playwright").Page) {
  return page.evaluate("window.hostMessages?.calls").catch(() => null)
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
