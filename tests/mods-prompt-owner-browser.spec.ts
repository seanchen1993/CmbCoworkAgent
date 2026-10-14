import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, "../output/mods-prompt-owner-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  const scenarios: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      const owners=new Map(), changes=new Set(), supports=[], edits=[], sent=[], reported=[];
      let held, hold=false, fail=false, latestEdit;
      window.api.mods.promptAttach=async(thread,id)=>{owners.set(thread,id)};
      window.api.mods.promptDetach=async(thread,id)=>{if(owners.get(thread)===id)owners.delete(thread)};
      window.api.mods.onPromptRequest=()=>()=>{};
      window.api.mods.onConfigurationChanged=fn=>{changes.add(fn);return()=>changes.delete(fn)};
      window.api.mods.promptEditSupport=async(thread,id)=>{
        supports.push({thread,id});
        if(hold){hold=false;await new Promise(done=>held=done)};
        if(owners.get(thread)!==id)throw Error('MODS_PROMPT_EDITOR_OWNER');
        if(fail)throw Error('ACTUAL_CURRENT_RULE_FAILED');
        return true;
      };
      window.api.mods.promptEditCancel=async()=>{};
      window.api.mods.promptEdit=async request=>{
        assertOwner(request);
        edits.push(request);
        const i=request.input, text=i.text.slice(0,i.start)+i.inputText+i.text.slice(i.end);
        return {text:text.toUpperCase(),cursor:request.nativeCursor??i.start+i.inputText.length};
      };
      function assertOwner(request){if(owners.get(request.threadId)!==request.owner)throw Error('MODS_PROMPT_EDITOR_OWNER')}
      function Fixture(){
        const [enabled,setEnabled]=useState(true),[thread,setThread]=useState('a'),[text,setText]=useState('');
        const state=useRef({text:'',revision:0}),node=useRef(null);
        const change=value=>{if(value!==state.current.text)state.current={text:value,revision:state.current.revision+1};setText(value)};
        const edit=usePromptComposer({threadId:thread,enabled,textarea:node,read:()=>state.current,
          apply:(revision,value)=>{if(revision!==state.current.revision)return false;change(value);return true},
          onError:value=>reported.push(value)});
        latestEdit=edit;
        window.probe={supports,edits,sent,reported,owners,hold:()=>hold=true,release:()=>held(),
          enable:setEnabled,thread:setThread,fail:value=>fail=value,
          config:()=>{for(const fn of changes)fn()},
          submit:()=>{
            const original=edit, originalThread=thread;
            window.lastSubmission=submitAfterPromptEdit(originalThread,{flush:original.flushSubmission,
              isConfirmed:original.isSubmissionConfirmed,read:()=>state.current,
              submit:async draft=>{sent.push({thread:originalThread,text:draft.text});if(state.current.revision===draft.revision){change('');latestEdit.reset()}}})
              .then(()=>({ok:true}),cause=>({ok:false,error:cause.message}));
          }};
        return <textarea aria-label='draft' disabled={!enabled} ref={node} value={text}
          onChange={event=>{change(event.target.value);edit.changed()}}/>;
      }
      host.render(<Fixture/>);
    `)
    const draft = page.getByLabel("draft")
    await draft.waitFor()
    await page.waitForFunction("window.probe.supports.length===1")
    await page.evaluate("window.probe.hold();window.probe.config()")
    await page.waitForFunction("window.probe.supports.length===2")
    await draft.fill("fresh rules")
    await page.evaluate("window.probe.submit();window.probe.enable(false)")
    await page.waitForFunction("document.querySelector('textarea').disabled")
    await page.evaluate("window.probe.enable(true)")
    await page.waitForFunction("window.probe.supports.length===3")
    await page.evaluate("window.probe.release()")
    assert.deepEqual(await page.evaluate("window.lastSubmission"), { ok: true })
    assert.deepEqual(await page.evaluate("window.probe.sent"), [{ thread: "a", text: "FRESH RULES" }])
    assert.equal(await page.evaluate("window.probe.reported.length"), 0)
    scenarios.push("a single unsent submission survives a real editor replacement and validates the new owner's rules")

    await page.evaluate("window.probe.fail(true);window.probe.config()")
    await page.waitForFunction("window.probe.supports.length===4")
    await draft.fill("preserved")
    await page.evaluate("window.probe.submit()")
    assert.deepEqual(await page.evaluate("window.lastSubmission"), {
      ok: false, error: "ACTUAL_CURRENT_RULE_FAILED"
    })
    assert.equal(await draft.inputValue(), "preserved")
    assert.equal(await page.evaluate("window.probe.sent.length"), 1)
    scenarios.push("a current owner's actual rule failure preserves the draft and never submits through a native fallback")

    await page.evaluate("window.probe.fail(false);window.probe.hold();window.probe.config()")
    await page.waitForFunction("window.probe.supports.length===5")
    await page.evaluate("window.probe.submit();window.probe.thread('b')")
    await page.waitForFunction("window.probe.supports.at(-1).thread==='b'")
    await page.evaluate("window.probe.release()")
    assert.equal(await page.evaluate("window.lastSubmission.then(result=>result.ok)"), false)
    assert.equal(await page.evaluate("window.probe.sent.length"), 1)
    scenarios.push("a thread change cannot transfer an old user's submission to the new conversation")

    await page.evaluate("window.probe.hold();window.probe.config()")
    await page.waitForFunction("window.probe.supports.length===7")
    await page.evaluate("window.probe.config();window.probe.submit();window.probe.enable(false)")
    await page.waitForFunction("document.querySelector('textarea').disabled")
    const supportCount = await page.evaluate("window.probe.supports.length")
    await page.evaluate("window.probe.release()")
    assert.equal(await page.evaluate("window.lastSubmission.then(result=>result.ok)"), false)
    assert.equal(await page.evaluate("window.probe.supports.length"), supportCount)
    assert.equal(await page.evaluate("window.probe.sent.length"), 1)
    scenarios.push("queued configuration refreshes stop after cleanup and a disabled editor cannot continue an old submit")
    // Discovery itself is asynchronous: typing after Enter must not become the
    // first edit dispatched once a newly attached rule is discovered.
    await page.evaluate("window.probe.enable(true)")
    await page.waitForFunction("!document.querySelector('textarea').disabled")
    const discoveryCount = await page.evaluate("window.probe.supports.length")
    await page.evaluate("window.probe.hold();window.probe.config()")
    await page.waitForFunction(count => (window as unknown as { probe: { supports: unknown[] } }).probe.supports.length > count, discoveryCount)
    await draft.fill("original intent")
    await page.evaluate("window.probe.submit()")
    await draft.fill("next draft")
    await page.evaluate("window.probe.release()")
    assert.deepEqual(await page.evaluate("window.lastSubmission"), { ok: true })
    assert.deepEqual(await page.evaluate("window.probe.sent.at(-1)"), {
      thread: "b", text: "ORIGINAL INTENT"
    })
    await page.waitForFunction("document.querySelector('textarea').value==='NEXT DRAFT'")
    scenarios.push("rule discovery validates Enter-time intent while preserving and separately validating the next draft")
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ status: "passed", scenarios, errors }, null, 2))
    console.log("PASS original React prompt editor ownership, replacement, current failure, thread change and cleanup")
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
