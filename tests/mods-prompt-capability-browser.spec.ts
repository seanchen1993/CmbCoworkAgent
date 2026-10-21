/** Real capability and editor hooks share the application's submission readiness decision. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const artifacts = resolve("output/mods-prompt-capability-browser", String(Date.now()))
  mkdirSync(artifacts, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  const checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {flushSync} from 'react-dom';
      import {useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {isPromptSubmissionReady} from ${JSON.stringify(resolve("src/renderer/src/lib/prompt-submission-readiness.ts"))};
      {
      const configs=new Set(),queries=[],owners=new Map(),calls=[],sent=[],attempts=[];
      window.api.mods.chatDisplayCapability=(thread,workspace)=>{
        calls.push(['capability',thread,workspace]);
        return new Promise((resolve,reject)=>queries.push({resolve,reject}))
      };
      window.api.mods.onConfigurationChanged=fn=>{configs.add(fn);return()=>configs.delete(fn)};
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.promptAttach=async(thread,owner)=>{owners.set(thread,owner);calls.push(['attach',owner])};
      window.api.mods.promptDetach=async(thread,owner)=>{if(owners.get(thread)===owner)owners.delete(thread)};
      window.api.mods.onPromptRequest=()=>()=>{};
      window.api.mods.promptEditSupport=async()=>true;
      window.api.mods.promptEditCancel=async()=>{};
      window.api.mods.promptEdit=async request=>{
        if(owners.get(request.threadId)!==request.owner)throw Error('STALE_EDITOR');
        calls.push(['edit',request.owner]);
        const i=request.input;return {text:(i.text.slice(0,i.start)+i.inputText+i.text.slice(i.end)).toUpperCase(),cursor:request.nativeCursor??i.start+i.inputText.length}
      };
      function Fixture(){
        const [workspace,setWorkspace]=useState('C:/scope'),[text,setText]=useState('retained capability draft'),
          [stops,setStops]=useState(0);
        const form=useRef(null),button=useRef(null),node=useRef(null);
        const draft=useRef({text:'retained capability draft',revision:0});
        const change=value=>{if(value!==draft.current.text)draft.current={text:value,revision:draft.current.revision+1};setText(value)};
        const scope=useModsChatState('capability-thread',workspace);
        const editor=usePromptComposer({threadId:'capability-thread',enabled:scope.enabled,textarea:node,
          read:()=>draft.current,apply:(revision,value)=>{if(draft.current.revision!==revision)return false;change(value);return true}});
        const readiness={workspace,modsEnabled:scope.enabled,modsReady:scope.ready,
          editorReady:editor.isReady,isCurrent:scope.isCurrent};
        const ready=isPromptSubmissionReady(readiness);
        const submit=async event=>{
          event.preventDefault();attempts.push({ready:scope.ready,live:scope.isCurrent()});
          if(!isPromptSubmissionReady(readiness))return;
          if(!scope.enabled){sent.push({text:draft.current.text,native:true});return}
          await submitAfterPromptEdit('capability-thread',{flush:editor.flushSubmission,
            read:()=>draft.current,isConfirmed:editor.isSubmissionConfirmed,
            submit:async value=>sent.push({text:value.text,native:false})})
        };
        window.capability={queries,calls,sent,attempts,ready:scope.ready,enabled:scope.enabled,
          editorReady:editor.isReady,error:scope.error,stops,
          resolve:value=>queries.at(-1).resolve(value),reject:()=>queries.at(-1).reject(Error('CAPABILITY_UNAVAILABLE')),
          retry:scope.retry,workspace:value=>flushSync(()=>setWorkspace(value)),
          request:()=>form.current.requestSubmit(),
          invalidateAndSubmit:()=>{
            const before=sent.length,beforeAttempts=attempts.length;
            for(const fn of configs)fn({scope:'authorization'});
            window.capabilityLiveWindow={renderReady:scope.ready,live:scope.isCurrent(),
              buttonDisabled:button.current.disabled,before};
            form.current.requestSubmit();
            window.capabilityLiveWindow.after=sent.length;
            window.capabilityLiveWindow.submitEvents=attempts.length-beforeAttempts
          }};
        return <form ref={form} onSubmit={event=>void submit(event)}>
          <textarea aria-label='capability draft' ref={node} value={text}
            onChange={event=>{change(event.target.value);editor.changed()}}
            onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.current.requestSubmit()}}}/>
          <button ref={button} type='submit' disabled={!ready}>Send</button>
          <button type='submit' disabled={!ready}>Execute command</button>
          <button type='button' onClick={()=>setStops(value=>value+1)}>Stop</button>
        </form>
      }
      host.render(<Fixture/>);
      }
    `
    )
    const draft = page.getByRole("textbox", { name: "capability draft", exact: true })
    const send = page.getByRole("button", { name: "Send", exact: true })
    const command = page.getByRole("button", { name: "Execute command", exact: true })
    await page.waitForFunction("window.capability.queries.length===1")
    await draft.press("Enter")
    await page.evaluate("window.capability.request()")
    assert.equal(await send.isDisabled(), true)
    assert.equal(await command.isDisabled(), true)
    assert.equal(await draft.isEnabled(), true)
    assert.equal(await page.evaluate("window.capability.sent.length"), 0)
    assert.equal(
      await page.evaluate("window.capability.calls.some(call=>call[0]==='attach')"),
      false
    )
    checks.push(
      "workspace capability pending blocks both send controls and Enter/requestSubmit without native fallback"
    )

    await page.evaluate("window.capability.reject()")
    await page.waitForFunction("Boolean(window.capability.error)")
    await draft.press("Enter")
    assert.equal(await send.isDisabled(), true)
    assert.equal(await command.isDisabled(), true)
    assert.equal(await draft.inputValue(), "retained capability draft")
    assert.equal(await page.evaluate("window.capability.sent.length"), 0)
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    assert.equal(await page.evaluate("window.capability.stops"), 1)
    checks.push("capability failure preserves the draft and keeps typing and Stop available")

    await page.evaluate("window.capability.retry()")
    await page.waitForFunction("window.capability.queries.length===2")
    await page.evaluate("window.capability.resolve(false)")
    await page.waitForFunction("window.capability.ready&&!window.capability.enabled")
    await send.click()
    assert.deepEqual(await page.evaluate("window.capability.sent"), [
      {
        text: "retained capability draft",
        native: true
      }
    ])
    assert.equal(await page.evaluate("window.capability.calls.some(call=>call[0]==='edit')"), false)
    checks.push("confirmed Mods-off uses native submission without an editor or edit IPC")

    await page.evaluate("window.capability.invalidateAndSubmit()")
    assert.deepEqual(await page.evaluate("window.capabilityLiveWindow"), {
      renderReady: true,
      live: false,
      buttonDisabled: false,
      before: 1,
      after: 1,
      submitEvents: 1
    })
    await page.waitForFunction("window.capability.queries.length===3&&!window.capability.ready")
    assert.equal(await send.isDisabled(), true)
    await page.evaluate("window.capability.resolve(true)")
    await page.waitForFunction(
      "window.capability.ready&&window.capability.enabled&&window.capability.editorReady"
    )
    await draft.fill("one protected send")
    await send.click()
    await page.waitForFunction("window.capability.sent.length===2")
    assert.deepEqual(await page.evaluate("window.capability.sent.at(-1)"), {
      text: "ONE PROTECTED SEND",
      native: false
    })
    checks.push(
      "live invalidation blocks stale ready closures before React commits; confirmed on sends once through the actual editor"
    )

    await page.evaluate("window.capability.invalidateAndSubmit()")
    assert.deepEqual(await page.evaluate("window.capabilityLiveWindow"), {
      renderReady: true,
      live: false,
      buttonDisabled: false,
      before: 2,
      after: 2,
      submitEvents: 1
    })
    await page.waitForFunction("!window.capability.ready")
    await page.evaluate("window.capability.workspace('')")
    await draft.fill("no workspace native")
    assert.equal(await send.isEnabled(), true)
    assert.equal(await command.isEnabled(), true)
    await draft.press("Enter")
    assert.deepEqual(await page.evaluate("window.capability.sent.at(-1)"), {
      text: "no workspace native",
      native: true
    })
    checks.push(
      "no-workspace native path remains usable while capability readiness is intentionally false"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          checks,
          errors,
          state: await page.evaluate(
            "({sent:window.capability.sent,attempts:window.capability.attempts,calls:window.capability.calls})"
          )
        },
        null,
        2
      )
    )
    await page.screenshot({ path: join(artifacts, "capability-ready.png") })
    console.log(checks.join("\n"))
  } catch (error) {
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          error: error instanceof Error ? error.stack : String(error),
          state: await page
            .evaluate(
              "({ready:window.capability?.ready,enabled:window.capability?.enabled,sent:window.capability?.sent,attempts:window.capability?.attempts})"
            )
            .catch(() => undefined)
        },
        null,
        2
      )
    )
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
