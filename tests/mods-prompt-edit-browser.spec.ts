import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve(__dirname, "../output/mods-prompt-edit-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      import {captureComposerSubmissionState} from ${JSON.stringify(resolve(__dirname, "../src/renderer/src/lib/composer-submission-state.ts"))};
      const edits=[], sent=[], cancelled=[], changes=new Set();
      let owner, promptListener, slow=false, release, busy=false, rule='upper', support=true;
      const replies=[];
      window.api.mods.promptAttach=async(id,value)=>{owner=value};
      window.api.mods.promptDetach=async()=>{};
      window.api.mods.promptAuthorize=async()=>true;
      window.api.mods.promptRespond=async reply=>replies.push(reply);
      window.api.mods.onPromptRequest=fn=>{promptListener=fn;return()=>{}};
      window.api.mods.onConfigurationChanged=fn=>{changes.add(fn);return()=>changes.delete(fn)};
      window.api.mods.promptEditSupport=async()=>support;
      window.api.mods.promptEditCancel=async(id,owner,sequence)=>cancelled.push(sequence);
      window.api.mods.promptEdit=async request=>{
        edits.push(structuredClone(request));
        if(slow){slow=false;await new Promise(done=>release=done)}
        const input=request.input;
        if(rule==='reject'&&input.inputText.includes('X'))return {text:input.text,cursor:input.cursor};
        const text=input.text.slice(0,input.start)+input.inputText+input.text.slice(input.end);
        return {text:rule==='upper'?text.toUpperCase():text,cursor:request.nativeCursor??input.start+input.inputText.length,
          decorations:rule==='upper'?[{start:0,end:Math.min(3,text.length),color:'red',underline:true}]:[]};
      };
      function EditorFixture(){
        const [text,setText]=useState(''),[error,setError]=useState(''),[enabled,setEnabled]=useState(true),[working,setWorking]=useState(false);
        const state=useRef({text:'',revision:0}),node=useRef(null);
        const emptyPayload=()=>({approvalQueue:[],attachments:[],selectedSkill:null});
        const [payload,setPayload]=useState(emptyPayload),payloadRef=useRef(payload);
        const changePayload=value=>{payloadRef.current=value;setPayload(value)};
        const change=text=>{if(text!==state.current.text)state.current={text,revision:state.current.revision+1};setText(text)};
        const edit=usePromptComposer({threadId:'a',enabled,textarea:node,read:()=>state.current,
          apply:(revision,text)=>{if(revision!==state.current.revision)return false;change(text);return true},onError:setError,working});
        window.editor={...edit,change,readPayload:()=>payloadRef.current,isWorking:working,working:setWorking,read:()=>state.current,off:()=>setEnabled(false),on:()=>setEnabled(true)};
        return <><form onSubmit={async event=>{event.preventDefault();const assertCurrent=captureComposerSubmissionState(()=>payloadRef.current);try{await submitAfterPromptEdit('a',{
          flush:edit.flushSubmission,isConfirmed:edit.isSubmissionConfirmed,assertCurrent,read:()=>state.current,submit:async draft=>{sent.push({text:draft.text,busy});changePayload(emptyPayload());if(state.current.revision===draft.revision){change('');edit.reset()}}})}catch(cause){setError(cause.message)}}}>
          <div style={{position:'relative'}}><PromptDecorations text={text} decorations={edit.decorations} textarea={node} className='paint'/>
          {edit.suggestion&&<p data-ghost>{edit.suggestion}</p>}
          <textarea ref={node} aria-label='draft' value={text} onChange={event=>{change(event.target.value);edit.changed()}}
            onKeyDown={event=>{if((event.key==='Tab'||event.key==='ArrowRight')&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&edit.acceptSuggestion())event.preventDefault()}}
            onCompositionStart={()=>edit.composition(true)} onCompositionEnd={()=>edit.composition(false)}/></div>
          <input aria-label='new attachment' type='file' onChange={event=>changePayload({...payloadRef.current,
            attachments:Array.from(event.target.files??[]).map(file=>({name:file.name,size:file.size}))})}/>
          <button type='button' onClick={()=>changePayload({...payloadRef.current,selectedSkill:{id:'next-skill'}})}>Select next skill</button>
          <button type='button' onClick={()=>changePayload(emptyPayload())}>Clear payload</button>
          <p data-payload>{JSON.stringify(payload)}</p>
          <button type='submit'>Send</button></form><p role='alert'>{error}</p><p data-private>private attachment</p></>;
      }
      window.probe={edits,sent,cancelled,replies,rule:value=>rule=value,slow:()=>slow=true,
        release:()=>release(),busy:value=>busy=value,support:value=>{support=value;for(const fn of changes)fn()},
        fire:request=>promptListener({...request,threadId:'a',owner})};
      host.render(<EditorFixture/>);
    `)
    const draft = page.getByLabel("draft")
    await draft.waitFor()
    await draft.fill("abc")
    await page.waitForFunction("document.querySelector('textarea').value==='ABC'")
    assert.equal(await page.locator("[data-prompt-decorations]").textContent(), "ABC")
    assert.equal(await page.locator("[data-prompt-decorations] span").first().evaluate(node => getComputedStyle(node).color), "rgb(255, 0, 0)")
    await page.getByText("Send", { exact: true }).click()
    assert.equal(await page.evaluate("window.probe.sent.at(-1).text"), "ABC")
    await page.waitForFunction("document.querySelector('textarea').value===''")
    await page.evaluate("window.probe.rule('reject');window.probe.slow()")
    await draft.fill("X")
    await page.waitForFunction("window.probe.edits.at(-1).input.inputText==='X'")
    await draft.fill("XY")
    await page.evaluate("window.probe.release()")
    await page.waitForFunction("document.querySelector('textarea').value===''")
    assert.equal(await page.evaluate("window.probe.edits.at(-1).input.text"), "")
    assert.equal(await page.evaluate("window.probe.edits.at(-1).input.inputText"), "XY")
    assert.equal(await page.evaluate("window.probe.cancelled.length>0"), true)
    await page.evaluate("window.probe.rule('upper');window.probe.slow()")
    await draft.fill("first")
    await page.waitForFunction("window.probe.edits.at(-1).input.inputText==='first'")
    await page.evaluate("document.querySelector('form').requestSubmit();document.querySelector('form').requestSubmit()")
    await draft.fill("latest")
    await page.evaluate("window.probe.release()")
    await page.waitForFunction("window.probe.sent.length===2")
    assert.equal(await page.evaluate("window.probe.sent.at(-1).text"), "FIRST")
    await page.waitForFunction("document.querySelector('textarea').value==='LATEST'")
    await page.evaluate("window.probe.busy(true)")
    await draft.fill("queued")
    await page.getByText("Send", { exact: true }).click()
    assert.deepEqual(await page.evaluate("window.probe.sent.at(-1)"), { text: "QUEUED", busy: true })
    const count = await page.evaluate("window.probe.edits.length")
    await draft.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })))
    await draft.fill("输入法")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("window.probe.edits.length"), count)
    await draft.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })))
    await page.getByText("Send", { exact: true }).click()
    assert.equal(await page.evaluate("window.probe.sent.at(-1).text"), "输入法")
    assert.equal(await page.evaluate("window.probe.edits.at(-1).input.key"), undefined)
    await page.evaluate("window.probe.support(false)")
    await page.waitForTimeout(50)
    const before = await page.evaluate("window.probe.edits.length")
    await draft.fill("unchanged")
    await page.getByText("Send", { exact: true }).click()
    assert.equal(await page.evaluate("window.probe.sent.at(-1).text"), "unchanged")
    assert.equal(await page.evaluate("window.probe.edits.length"), before)
    await page.evaluate("window.probe.support(true);window.probe.rule('upper')")
    await page.waitForTimeout(60)
    await page.evaluate("window.probe.fire({kind:'suggest',requestId:'suggest',text:'next step'})")
    await page.locator("[data-ghost]").waitFor()
    assert.equal(await draft.inputValue(), "")
    assert.equal(await page.evaluate("window.probe.replies.at(-1).isShown"), true)
    await draft.focus()
    await draft.press("Tab")
    await page.waitForFunction("document.querySelector('textarea').value==='NEXT STEP'")
    assert.equal(await page.evaluate("window.probe.sent.length"), 5)
    assert.equal(await page.locator("[data-ghost]").count(), 0)
    await page.evaluate("window.probe.fire({kind:'suggest',requestId:'occupied',text:'overwrite'})")
    assert.equal(await page.evaluate("window.probe.replies.at(-1).isShown"), false)
    await page.getByText("Send", { exact: true }).click()
    await page.waitForFunction("document.querySelector('textarea').value===''")
    await page.evaluate("window.editor.working(true)")
    await page.waitForFunction("window.editor.isWorking===true")
    await page.evaluate("window.probe.fire({kind:'suggest',requestId:'running',text:'next'})")
    assert.equal(await page.evaluate("window.probe.replies.at(-1).isShown"), false)
    await page.evaluate("window.editor.working(false);const dialog=document.createElement('div');dialog.id='test-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');document.body.append(dialog)")
    await page.waitForFunction("window.editor.isWorking===false")
    await page.evaluate("window.probe.fire({kind:'read',requestId:'dialog-capture'})")
    const dialogRevision = await page.evaluate("window.probe.replies.at(-1).revision")
    assert.equal(await page.evaluate("window.probe.replies.at(-1).text"), "")
    await page.evaluate("document.getElementById('test-dialog').remove()")
    await draft.fill("typed and erased")
    await draft.fill("")
    await page.evaluate(revision => {
      const w = window as unknown as { probe: { fire(request: unknown): Promise<void> } }
      return w.probe.fire({ kind: "suggest", requestId: "stale-dialog", text: "old", expectedRevision: revision })
    }, dialogRevision)
    assert.equal(await page.evaluate("window.probe.replies.at(-1).isShown"), false)
    await page.evaluate("window.editor.flush()")
    await page.evaluate("const dialog=document.createElement('div');dialog.id='test-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');document.body.append(dialog)")
    await page.evaluate("window.probe.fire({kind:'suggest',requestId:'dialog',text:'after dialog'})")
    assert.equal(await page.evaluate("window.probe.replies.at(-1).isShown"), true)
    assert.equal(await page.locator("[data-ghost]").count(), 0)
    assert.equal(await page.evaluate("window.editor.acceptSuggestion()"), false)
    assert.equal(await draft.inputValue(), "")
    await page.evaluate("document.getElementById('test-dialog').remove()")
    await page.locator("[data-ghost]").waitFor()
    await draft.fill("manual")
    assert.equal(await page.locator("[data-ghost]").count(), 0)
    await page.evaluate("window.probe.rule('identity')")
    await draft.fill("aa")
    await page.evaluate("window.editor.flush()")
    await draft.evaluate(node => node.setSelectionRange(0, 0))
    await page.evaluate("window.editor.flush()")
    await draft.press("a")
    await page.evaluate("window.editor.flush()")
    assert.equal(await draft.inputValue(), "aaa")
    assert.equal(await draft.evaluate(node => node.selectionStart), 1)
    assert.deepEqual(await page.evaluate("(({text,cursor,start,end,inputText,key})=>({text,cursor,start,end,inputText,key}))(window.probe.edits.at(-1).input)"),
      { text: "aa", cursor: 0, start: 0, end: 0, inputText: "a", key: { key: "a" } })
    await draft.fill("abcde")
    await page.evaluate("window.editor.flush()")
    await draft.evaluate(node => node.setSelectionRange(1, 4, "forward"))
    await page.evaluate("window.editor.flush()")
    await draft.press("x")
    await page.evaluate("window.editor.flush()")
    assert.deepEqual(await page.evaluate("(({text,cursor,start,end,inputText})=>({text,cursor,start,end,inputText}))(window.probe.edits.at(-1).input)"),
      { text: "abcde", cursor: 4, start: 1, end: 4, inputText: "x" })
    await draft.press("Backspace")
    await page.evaluate("window.editor.flush()")
    assert.equal(await page.evaluate("window.probe.edits.at(-1).input.key.key"), "backspace")
    await draft.press("Shift+Enter")
    await page.evaluate("window.editor.flush()")
    assert.deepEqual(await page.evaluate("window.probe.edits.at(-1).input.key"), { key: "return", shift: true })
    await page.getByText("Send", { exact: true }).click()
    await page.waitForFunction("document.querySelector('textarea').value===''")
    await page.evaluate("window.probe.rule('reject');window.probe.slow()")
    await draft.fill("X")
    await page.waitForFunction("window.probe.edits.at(-1).input.inputText==='X'")
    await page.evaluate("window.probe.fire({kind:'read',requestId:'before-append'})")
    const captured = await page.evaluate("window.probe.replies.at(-1).revision")
    await page.evaluate(revision => {
      const w = window as unknown as { probe: { fire(request: unknown): void } }
      void w.probe.fire({ kind: "fill", requestId: "append-unconfirmed", mode: "append", text: "Y", expectedRevision: revision })
    }, captured)
    await page.waitForFunction("window.probe.replies.at(-1).requestId==='append-unconfirmed'")
    assert.equal(await page.evaluate("window.probe.replies.at(-1).status"), "conflict")
    // No release yet: this refusal must not depend on the edit hook completing.
    assert.equal(await draft.inputValue(), "X")
    await page.evaluate("window.probe.release()")
    await page.waitForFunction("document.querySelector('textarea').value===''")
    assert.equal(await draft.inputValue(), "")
    const beforeExternal = await page.evaluate("window.probe.edits.length")
    await page.evaluate("window.probe.slow()")
    await draft.fill("X")
    await page.waitForFunction(count => {
      const w = window as unknown as { probe: { edits: Array<{ input: { inputText: string } }> } }
      return w.probe.edits.length > count && w.probe.edits.at(-1)?.input.inputText === "X"
    }, beforeExternal)
    const beforeFollowUp = await page.evaluate("window.probe.sent.length")
    await page.evaluate("window.editor.change('X\\n\\nfollow-up');document.querySelector('form').requestSubmit()")
    await page.evaluate("window.probe.release()")
    await page.waitForFunction("document.querySelector('textarea').value==='X\\n\\nfollow-up'")
    await page.waitForFunction("document.querySelector('[role=alert]').textContent.includes('UNAVAILABLE')")
    assert.equal(await page.evaluate("window.probe.sent.length"), beforeFollowUp)
    // A same-tick programmatic draft is preserved until React commits it. An explicit
    // retry validates the whole change; it must never promote the rejected prefix.
    await page.getByText("Send", { exact: true }).click()
    await page.waitForFunction("document.querySelector('textarea').value===''")
    assert.equal(await page.evaluate("window.probe.edits.at(-1).input.inputText"), "X\n\nfollow-up")
    assert.equal(await page.evaluate("window.probe.sent.some(message=>message.text.includes('X\\n\\nfollow-up'))"), false)
    await page.evaluate("window.probe.rule('identity')")
    await draft.fill("abc")
    await page.evaluate("window.editor.flush();window.probe.fire({kind:'read',requestId:'decoration-read'})")
    const paintRevision = await page.evaluate("window.probe.replies.at(-1).revision")
    await page.evaluate(revision => {
      const w = window as unknown as { probe: { fire(request: unknown): Promise<void> } }
      return w.probe.fire({ kind: "fill", requestId: "decoration-append", mode: "append", text: "xy",
        expectedRevision: revision, decorations: [{ start: 0, end: 2, color: "red" }] })
    }, paintRevision)
    assert.equal(await page.locator("[data-prompt-decorations] span").last().textContent(), "xy")
    assert.equal(await page.locator("[data-prompt-decorations] span").first().textContent(), "abc")
    await page.getByText("Send", { exact: true }).click()
    await page.waitForFunction("document.querySelector('textarea').value===''")
    await page.evaluate("window.probe.fire({kind:'suggest',requestId:'to-revoke',text:'old proposal'})")
    await page.locator("[data-ghost]").waitFor()
    await page.evaluate("window.probe.support(false)")
    await page.waitForFunction("!document.querySelector('[data-ghost]')")
    await draft.press("Tab")
    assert.equal(await draft.inputValue(), "")
    await page.evaluate("window.probe.support(true);window.probe.rule('upper')")
    await page.waitForTimeout(60)
    for (const kind of ["attachment", "skill"]) {
      await page.getByText("Clear payload", { exact: true }).click()
      await draft.fill("")
      await page.evaluate("window.editor.flush()")
      const sentBeforePayloadEdit = await page.evaluate("window.probe.sent.length")
      const editsBeforePayloadEdit = await page.evaluate("window.probe.edits.length")
      await page.evaluate("window.probe.slow()")
      await draft.fill("old " + kind + " intent")
      await page.waitForFunction(count => (window as unknown as { probe: { edits: unknown[] } }).probe.edits.length > count,
        editsBeforePayloadEdit)
      await page.evaluate("document.querySelector('form').requestSubmit()")
      await draft.fill("next payload draft")
      if (kind === "attachment") {
        await page.getByLabel("new attachment").setInputFiles({
          name: "next-message.txt", mimeType: "text/plain", buffer: Buffer.from("next message file")
        })
      } else await page.getByText("Select next skill", { exact: true }).click()
      await page.evaluate("window.probe.release()")
      await page.waitForFunction("document.querySelector('[role=alert]').textContent.includes('当前输入已保留')")
      await page.waitForFunction("document.querySelector('textarea').value==='NEXT PAYLOAD DRAFT'")
      assert.equal(await page.evaluate("window.probe.sent.length"), sentBeforePayloadEdit)
      const retained = await page.evaluate("window.editor.readPayload()")
      if (kind === "attachment") assert.equal(retained.attachments[0].name, "next-message.txt")
      else assert.equal(retained.selectedSkill.id, "next-skill")
    }
    assert.equal(JSON.stringify(await page.evaluate("window.probe.edits")).includes("private attachment"), false)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "input-rules.png"), fullPage: true })
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ status: "passed", errors,
      scenarios: ["cumulative rejected input", "IME", "Enter-time normalized submit preserves next draft", "busy queue", "ghost acknowledgement and acceptance",
        "dialog staging", "no-hook fast path", "repeated-character native splice", "selected range active caret", "Backspace and Shift+Enter",
        "pending append cannot promote", "follow-up cannot promote", "fill decoration offsets", "revoke old proposal", "pending hook preserves new attachment and skill"] }, null, 2))
    console.log("PASS prompt edit actual React/DOM, cumulative rejection, IME, fresh send, busy queue, decorations and no-hook fast path")
  } catch (cause) {
    console.error(await page.evaluate("JSON.stringify({draft:document.querySelector('textarea')?.value,state:window.editor?.read(),alert:document.querySelector('[role=alert]')?.textContent,edits:window.probe?.edits,sent:window.probe?.sent,cancelled:window.probe?.cancelled})"))
    console.error(errors)
    throw cause
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
