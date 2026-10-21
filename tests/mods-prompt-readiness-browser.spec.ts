/** Real hook and DOM commit windows, controlled IPC; no injected editor or timer-based readiness. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const artifacts = resolve("output/mods-prompt-readiness-browser", String(Date.now()))
  mkdirSync(artifacts, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = [],
    checks: string[] = []
  const retirements: { pending: string; action: string; settledBeforeReply: boolean }[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {useLayoutEffect,startTransition} from 'react';
      import {flushSync} from 'react-dom';
      {
      const owners=new Map(),calls=[],sent=[],windows=[],rejections=[],held=new Map(),heldRules=new Map(),cancellations=[];
      let hold='a',nextHold=false,nextRuleHold=false,releaseDuringInstall,cancelDuringInstall,closedAction;
      const closedStacks=[];const OriginalError=Error;
      const observeClosed=(error,args)=>{
        if(args[0]==='MODS_PROMPT_EDITOR_CLOSED'){
          closedStacks.push(error.stack);
          if(closedAction&&error.stack.includes('at assertComposer')){
            const action=closedAction;closedAction=undefined;
            // Cross the inner flush rejection and the lifecycle race's finally so
            // cancellation lands while the outer send awaits the committed installation.
            queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(action))))
          }
        }
        return error
      };
      window.Error=new Proxy(OriginalError,{
        construct(target,args,newTarget){return observeClosed(Reflect.construct(target,args,newTarget),args)},
        apply(target,self,args){return observeClosed(Reflect.apply(target,self,args),args)}
      });
      window.api.mods.promptAttach=async(thread,owner)=>{owners.set(thread,owner);calls.push(['attach',thread,owner])};
      window.api.mods.promptDetach=async(thread,owner)=>{if(owners.get(thread)===owner)owners.delete(thread);calls.push(['detach',thread,owner])};
      window.api.mods.onPromptRequest=()=>()=>{};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.promptEditSupport=async(thread,owner)=>{
        calls.push(['support',thread,owner]);
        if(hold===thread||nextHold){hold='';nextHold=false;await new Promise(resolve=>held.set(owner,resolve))}
        return true
      };
      window.api.mods.promptEditCancel=async()=>{};
      window.api.mods.promptEdit=async request=>{
        if(owners.get(request.threadId)!==request.owner)throw Error('WRONG_EDITOR_OWNER');
        calls.push(['edit',request.threadId,request.owner]);
        if(nextRuleHold){nextRuleHold=false;await new Promise(resolve=>heldRules.set(request.owner,resolve))}
        const i=request.input;return {text:(i.text.slice(0,i.start)+i.inputText+i.text.slice(i.end)).toUpperCase(),cursor:request.nativeCursor??i.start+i.inputText.length}
      };
      function Fixture(){
        const [thread,setThread]=useState('a'),[enabled,setEnabled]=useState(true),[mods,setMods]=useState(true),
          [text,setText]=useState('retained draft'),[stops,setStops]=useState(0);
        const node=useRef(null),form=useRef(null),button=useRef(null),lastWindow=useRef('');
        const state=useRef({text:'retained draft',revision:0});
        const change=value=>{if(value!==state.current.text)state.current={text:value,revision:state.current.revision+1};setText(value)};
        const editor=usePromptComposer({threadId:thread,enabled,textarea:node,read:()=>state.current,
          apply:(revision,value)=>{if(state.current.revision!==revision)return false;change(value);return true}});
        const canSend=!mods||editor.isReady;
        const submit=async event=>{
          event.preventDefault();if(!canSend)return;
          if(!mods){sent.push({thread,text:state.current.text,native:true});return}
          await submitAfterPromptEdit(thread,{flush:editor.flushSubmission,isConfirmed:editor.isSubmissionConfirmed,
            read:()=>state.current,submit:async draft=>sent.push({thread,text:draft.text,native:false})})
        };
        useLayoutEffect(()=>{
          if(enabled&&!editor.isReady&&releaseDuringInstall){
            const owner=releaseDuringInstall;releaseDuringInstall=undefined;
            const action=cancelDuringInstall;cancelDuringInstall=undefined;
            const attachments=calls.filter(call=>call[0]==='attach').length;
            if(action)closedAction=()=>{
              cancellations.push({action,ready:window.readiness.ready,
                installedSinceLayout:calls.filter(call=>call[0]==='attach').length-attachments});
              if(action==='unmount')flushSync(()=>host.render(null));
              if(action==='off')flushSync(()=>{setMods(false);setEnabled(false)});
              if(action==='thread')flushSync(()=>setThread('c'));
              if(action==='replace'){
                flushSync(()=>setEnabled(false));flushSync(()=>setEnabled(true))
              }
            };
            const finish=held.get(owner);held.delete(owner);finish()
          }
          const key=thread+':'+enabled+':'+mods;
          if(!editor.isReady&&mods&&lastWindow.current!==key){
            lastWindow.current=key;
            const before=calls.filter(call=>call[0]==='edit').length;
            windows.push({thread,enabled,canSend,buttonDisabled:button.current.disabled,draftDisabled:node.current.disabled,text:node.current.value,before});
            form.current.requestSubmit();
            node.current.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
            editor.flushSubmission().then(()=>rejections.push('unexpected success'),error=>rejections.push(error.message));
            windows.at(-1).after=calls.filter(call=>call[0]==='edit').length
          }
        });
        window.readiness={calls,sent,windows,rejections,owners,held,heldRules,closedStacks,cancellations,
          thread:next=>flushSync(()=>setThread(next)),
          enabled:value=>flushSync(()=>setEnabled(value)),
          off:()=>flushSync(()=>{setMods(false);setEnabled(false)}),
          on:()=>flushSync(()=>{setMods(true);setThread('b');setEnabled(true)}),
          holdNext:()=>nextHold=true,
          holdNextRule:()=>nextRuleHold=true,
          unmount:()=>flushSync(()=>host.render(null)),
          startSubmit:()=>{
            window.pendingResult=undefined;
            window.pendingSubmit=submit({preventDefault(){}})
              .then(()=>({ok:true}),error=>({ok:false,error:error.message,stack:error.stack}))
              .then(result=>window.pendingResult=result)
          },
          restartReleasing:(owner,action)=>{releaseDuringInstall=owner;cancelDuringInstall=action;startTransition(()=>setEnabled(true))},
          release:owner=>{const finish=held.get(owner);held.delete(owner);finish()},
          releaseRule:owner=>{const finish=heldRules.get(owner);heldRules.delete(owner);finish()},
          stops,ready:editor.isReady};
        return <><form ref={form} onSubmit={event=>void submit(event)}>
          <textarea ref={node} aria-label='draft' value={text} onChange={event=>{change(event.target.value);editor.changed()}}
            onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.current.requestSubmit()}}}/>
          <button ref={button} type='submit' disabled={!canSend}>Send</button>
        </form><button onClick={()=>setStops(value=>value+1)}>Stop</button></>
      }
      window.remountReadiness=()=>flushSync(()=>host.render(<Fixture/>));
      host.render(<Fixture/>);
      }
    `
    )
    const draft = page.getByRole("textbox", { name: "draft", exact: true })
    const send = page.getByRole("button", { name: "Send", exact: true })
    await page.waitForFunction("window.readiness.held.size===1&&window.readiness.ready")
    const oldA = await page.evaluate("window.readiness.owners.get('a')")
    await page.evaluate("window.readiness.thread('b')")
    await page.waitForFunction(
      "window.readiness.ready&&window.readiness.calls.some(call=>call[0]==='support'&&call[1]==='b')"
    )
    await page.evaluate((owner) => {
      ;(window as unknown as { readiness: { release(owner: string): void } }).readiness.release(
        owner
      )
    }, oldA)
    await draft.fill("thread b")
    await send.click()
    await page.waitForFunction("window.readiness.sent.length===1")
    assert.deepEqual(await page.evaluate("window.readiness.sent"), [
      { thread: "b", text: "THREAD B", native: false }
    ])
    assert.equal(
      await page.evaluate("window.readiness.calls.some(call=>call[0]==='edit'&&call[1]==='a')"),
      false
    )
    checks.push(
      "thread change refuses commit-window submits and late old discovery cannot use the previous owner"
    )

    await page.evaluate("window.readiness.enabled(false)")
    assert.equal(await send.isDisabled(), true)
    assert.equal(await draft.isEnabled(), true)
    await draft.fill("still typing")
    await draft.press("Enter")
    assert.equal(await draft.inputValue(), "still typing")
    assert.equal(await page.evaluate("window.readiness.sent.length"), 1)
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    assert.equal(await page.evaluate("window.readiness.stops"), 1)
    await page.evaluate("window.readiness.holdNext();window.readiness.enabled(true)")
    await page.waitForFunction("window.readiness.ready&&window.readiness.held.size===1")
    const retiredB = await page.evaluate("window.readiness.owners.get('b')")
    await page.evaluate("window.readiness.enabled(false);window.readiness.enabled(true)")
    await page.waitForFunction(
      (owner) =>
        (window as unknown as { readiness: { ready: boolean; owners: Map<string, string> } })
          .readiness.ready &&
        (window as unknown as { readiness: { owners: Map<string, string> } }).readiness.owners.get(
          "b"
        ) !== owner,
      retiredB
    )
    await page.evaluate((owner) => {
      ;(window as unknown as { readiness: { release(owner: string): void } }).readiness.release(
        owner
      )
    }, retiredB)
    await send.click()
    await page.waitForFunction("window.readiness.sent.length===2")
    assert.equal(await page.evaluate("window.readiness.sent.at(-1).text"), "STILL TYPING")
    assert.equal(
      await page.evaluate(
        (owner) =>
          (window as unknown as { readiness: { calls: string[][] } }).readiness.calls.some(
            (call) => call[0] === "edit" && call[2] === owner
          ),
        retiredB
      ),
      false
    )
    checks.push(
      "same-thread disable/restart publishes only the installed generation; typing, Stop and a single ready submit remain usable"
    )

    await page.evaluate(
      "window.readiness.enabled(false);window.readiness.holdNext();window.readiness.enabled(true)"
    )
    await page.waitForFunction("window.readiness.ready&&window.readiness.held.size===1")
    const pendingOwner = await page.evaluate("window.readiness.owners.get('b')")
    await draft.fill("pending original intent")
    await page.evaluate("window.readiness.startSubmit();window.readiness.enabled(false)")
    await page.evaluate((owner) => {
      ;(
        window as unknown as { readiness: { restartReleasing(owner: string): void } }
      ).readiness.restartReleasing(owner)
    }, pendingOwner)
    const pendingResult = await page.evaluate("window.pendingSubmit")
    assert.deepEqual(pendingResult, { ok: true }, JSON.stringify(pendingResult))
    assert.equal(
      await page.evaluate("window.readiness.sent.at(-1).text"),
      "PENDING ORIGINAL INTENT"
    )
    assert.equal(await page.evaluate("window.readiness.sent.length"), 3)
    checks.push(
      "an admitted send waits across the same-thread layout/effect installation gap without recapturing or replaying its intent"
    )

    for (const action of ["off", "thread", "replace", "unmount"]) {
      await page.evaluate(
        "window.readiness.enabled(false);window.readiness.holdNext();window.readiness.enabled(true)"
      )
      await page.waitForFunction("window.readiness.ready&&window.readiness.held.size===1")
      await draft.fill(`cancel ${action}`)
      const sentBefore = await page.evaluate("window.readiness.sent.length")
      await page.evaluate(`
        window.cancelOwner=window.readiness.owners.get('b');
        window.readiness.startSubmit();window.readiness.enabled(false)
      `)
      await page.evaluate((mode) => {
        const state = window as unknown as {
          cancelOwner: string
          readiness: { restartReleasing(owner: string, action: string): void }
        }
        state.readiness.restartReleasing(state.cancelOwner, mode)
      }, action)
      await page.waitForFunction("window.pendingResult!==undefined")
      assert.equal(await page.evaluate("window.pendingResult.ok"), false, action)
      assert.equal(
        await page.evaluate("window.pendingResult.error"),
        "MODS_PROMPT_EDITOR_CLOSED",
        action
      )
      assert.deepEqual(await page.evaluate("window.readiness.cancellations.at(-1)"), {
        action,
        ready: false,
        installedSinceLayout: 0
      })
      assert.equal(await page.evaluate("window.readiness.sent.length"), sentBefore)
      assert.equal(
        await page.evaluate(
          "window.readiness.calls.some(call=>call[0]==='edit'&&call[2]===window.cancelOwner)"
        ),
        false
      )
      if (action === "unmount") await page.evaluate("window.remountReadiness()")
      await page.evaluate("window.readiness.on()")
      await page.waitForFunction("window.readiness.ready")
      await draft.fill(`fresh after ${action}`)
      await send.click()
      await page.waitForFunction(
        (count) =>
          (window as unknown as { readiness: { sent: unknown[] } }).readiness.sent.length === count,
        sentBefore + 1
      )
      assert.equal(
        await page.evaluate("window.readiness.sent.at(-1).text"),
        `FRESH AFTER ${action.toUpperCase()}`
      )
    }
    checks.push(
      "off, thread change, replacement before installation and unmount cancel the admitted intent and release the submit lock for one later explicit send"
    )

    for (const pending of ["support", "rule"]) {
      for (const action of ["thread", "unmount", "aba"]) {
        await page.evaluate("window.readiness.enabled(false)")
        if (pending === "support") await page.evaluate("window.readiness.holdNext()")
        await page.evaluate("window.readiness.enabled(true)")
        await page.waitForFunction("window.readiness.ready")
        if (pending === "support") {
          await page.waitForFunction("window.readiness.held.size===1")
        } else {
          await page.waitForFunction(
            "window.readiness.calls.some(call=>call[0]==='support'&&call[2]===window.readiness.owners.get('b'))"
          )
          await page.evaluate("window.readiness.holdNextRule()")
        }
        await draft.fill(`held ${pending} ${action}`)
        const oldOwner = await page.evaluate("window.readiness.owners.get('b')")
        const sentBefore = await page.evaluate("window.readiness.sent.length")
        await page.evaluate("window.readiness.startSubmit()")
        if (pending === "rule") {
          await page.waitForFunction("window.readiness.heldRules.size===1")
        }
        if (action === "unmount") {
          await page.evaluate("window.readiness.unmount()")
        } else {
          await page.evaluate("window.readiness.thread('away')")
          if (action === "aba") await page.evaluate("window.readiness.thread('b')")
        }
        // Neither the old support nor rule IPC is released before the lock must settle.
        await page.waitForFunction("window.pendingResult!==undefined")
        assert.equal(await page.evaluate("window.pendingResult.ok"), false)
        assert.equal(await page.evaluate("window.pendingResult.error"), "MODS_PROMPT_EDITOR_CLOSED")
        assert.equal(await page.evaluate("window.readiness.sent.length"), sentBefore)
        assert.equal(
          await page.evaluate(
            pending === "support" ? "window.readiness.held.size" : "window.readiness.heldRules.size"
          ),
          1
        )
        if (action === "unmount") await page.evaluate("window.remountReadiness()")
        await page.evaluate("window.readiness.on()")
        await page.waitForFunction("window.readiness.ready")
        await draft.fill(`new explicit ${pending} ${action}`)
        await send.click()
        await page.waitForFunction(
          (count) =>
            (window as unknown as { readiness: { sent: unknown[] } }).readiness.sent.length ===
            count,
          sentBefore + 1
        )
        // A late old SDK reply cannot validate a new owner or resurrect the retired send.
        await page.evaluate(
          ({ owner, kind }) => {
            const state = window as unknown as {
              readiness: { release(owner: string): void; releaseRule(owner: string): void }
            }
            if (kind === "support") state.readiness.release(owner)
            else state.readiness.releaseRule(owner)
          },
          { owner: oldOwner, kind: pending }
        )
        assert.equal(await page.evaluate("window.readiness.sent.length"), sentBefore + 1)
        assert.equal(
          await page.evaluate("window.readiness.sent.at(-1).text"),
          `NEW EXPLICIT ${pending.toUpperCase()} ${action.toUpperCase()}`
        )
        retirements.push({ pending, action, settledBeforeReply: true })
      }
    }
    checks.push(
      "thread replacement, unmount and A-B-A settle with old discovery/rule IPC still held; one new explicit send succeeds and late old replies cannot resurrect the retired intent"
    )

    const editsBeforeOff = await page.evaluate(
      "window.readiness.calls.filter(call=>call[0]==='edit').length"
    )
    await page.evaluate("window.readiness.off()")
    await draft.fill("native after off")
    assert.equal(await send.isEnabled(), true)
    await draft.press("Enter")
    assert.deepEqual(await page.evaluate("window.readiness.sent.at(-1)"), {
      thread: "b",
      text: "native after off",
      native: true
    })
    assert.equal(
      await page.evaluate("window.readiness.calls.filter(call=>call[0]==='edit').length"),
      editsBeforeOff
    )
    const windows = (await page.evaluate("window.readiness.windows")) as Array<{
      canSend: boolean
      buttonDisabled: boolean
      draftDisabled: boolean
      before: number
      after: number
    }>
    assert(windows.length >= 5)
    assert(
      windows.every(
        (window) =>
          !window.canSend &&
          window.buttonDisabled &&
          !window.draftDisabled &&
          window.before === window.after
      )
    )
    assert.equal(
      await page.evaluate(
        "window.readiness.rejections.every(error=>error==='MODS_PROMPT_EDITOR_CLOSED')"
      ),
      true
    )
    assert.deepEqual(errors, [])
    checks.push("Mods-off uses native submission without the retired editor or extra edit IPC")
    await page.screenshot({ path: join(artifacts, "ready-and-native.png") })
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          checks,
          windows,
          retirements,
          errors,
          handoff: await page.evaluate(
            "({cancellations:window.readiness.cancellations,closedStacks:window.readiness.closedStacks})"
          )
        },
        null,
        2
      )
    )
    console.log(checks.join("\n"))
  } catch (error) {
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          error: error instanceof Error ? error.stack : String(error),
          state: await page
            .evaluate(
              "({pending:window.pendingResult,cancellations:window.readiness?.cancellations,closedStacks:window.readiness?.closedStacks})"
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
