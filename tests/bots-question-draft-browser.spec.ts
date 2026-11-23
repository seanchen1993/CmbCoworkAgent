/** Real question components and Virtuoso; isolated inbox transport, no app or model. */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const source = readFileSync(resolve("src/renderer/src/components/chat/ChatContainer.tsx"), "utf8")
  const inspectorDialog = source.match(
    /surface === "bot" && canAnswerUserInput && \(\s*(<UserInputRequestDialog[\s\S]*?\/>)/
  )?.[1]
  assert.ok(inspectorDialog, "actual Bot inspector dialog must be present")
  assert.match(inspectorDialog, /onDraftChange=/, "inspector must use the pending inbox draft")
  const submit = source.match(
    /const handleUserInputSubmit = useCallback\(\s*(\(response: UserInputResponse\): void => \{[\s\S]*?\n    \}),\n    \[/
  )?.[1]
  assert.ok(submit, "actual Bot submit callback must be present")
  const submitCallback = submit.replace("(response: UserInputResponse): void", "(response)")
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React,{useRef,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {Virtuoso} from 'react-virtuoso';
import {BotGroupQuestionBody} from './src/renderer/src/components/bots/BotGroupQuestion';
import {UserInputRequestDialog} from './src/renderer/src/components/chat/UserInputRequestDialog';
import {pendingUserInputPatch,userInputDraftPatch} from './src/renderer/src/lib/user-input-answer';
const request=(id,threadId='group-live')=>({requestId:id,threadId,createdAt:new Date().toISOString(),questions:[
{id:'q1',header:'First',question:'Select several',allowMultiple:true,options:[{label:'Alpha',description:'A'},{label:'Beta',description:'B'}]},
{id:'q2',header:'Second',question:'Provide detail',options:[{label:'Gamma',description:'C'}]}]});
const state=window.questionFixture={states:{'group-live':{pendingUserInput:request('one')},'private-live':{pendingUserInput:request('private-one','private-live')},'work-live':{pendingUserInput:request('work-one','work-live')}},listeners:new Set(),callbacks:{},submissions:[],scroll(){},show(){},replace(){}};
state.publish=()=>state.listeners.forEach(listener=>listener());
state.patch=(id,patch)=>{state.states[id]={...state.states[id],...patch};state.publish()};
state.context={getThreadState:id=>state.states[id],subscribeToThreadState:(id,listener)=>{state.listeners.add(listener);return()=>state.listeners.delete(listener)},getThreadActions:id=>({
setUserInputDraft:(requestId,update)=>state.patch(id,userInputDraftPatch(state.states[id],requestId,update)),
setPendingUserInput:value=>state.patch(id,pendingUserInputPatch(state.states[id],value))})};
window.api={userInput:{sendResponse:response=>state.submissions.push(response)}};
function BotDialog({threadId,inspect=false}){
const {pendingUserInput,userInputDraft}=useSyncExternalStore(listener=>state.context.subscribeToThreadState(threadId,listener),()=>state.states[threadId]);
const allowUserInputInReadOnly=inspect,botQuestionUsesComposer=false,surface='bot',threadContext=state.context;
const {setUserInputDraft,setPendingUserInput}=state.context.getThreadActions(threadId),setUserInputDialogLayout=()=>{};
const handleUserInputSubmit=${submitCallback};state.callbacks[threadId]=handleUserInputSubmit;
return <section data-bot-dialog={threadId} data-inspecting={inspect||undefined}>${inspectorDialog}</section>}
function App(){const list=useRef(null),[show,setShow]=useState(true),[mode,setMode]=useState('group'),[current,setCurrent]=useState(state.states['group-live'].pendingUserInput);
state.scroll=i=>list.current.scrollToIndex({index:i,align:'start'});state.show=setShow;
state.replace=id=>{const value=request(id);state.patch('group-live',pendingUserInputPatch(state.states['group-live'],value));setCurrent(value)};
state.mode=value=>{setMode(value);setShow(true)};
if(!show)return <p>Inspecting execution</p>;
if(mode==='inspect')return <BotDialog threadId='group-live' inspect/>;
if(mode==='private'||mode==='work')return <BotDialog key={mode} threadId={mode+'-live'}/>;
if(mode!=='group')return <UserInputRequestDialog key={mode} presentation={mode==='native'?'workbench':'bot'} request={{...current,questions:current.questions.map(q=>({...q,allowMultiple:false}))}} onSubmit={response=>state.submissions.push(response)}/>;
return <Virtuoso ref={list} style={{height:300,width:640}} data={Array.from({length:80},(_,i)=>i)} computeItemKey={(_,i)=>i} itemContent={(_,i)=>i===0?<BotGroupQuestionBody task={{threadId:'group-live'}} request={current}/>:<div style={{height:100}}>history row {i}</div>}/>}
const root=createRoot(document.getElementById('root'));state.unmount=()=>root.unmount();root.render(<App/>);`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "isolated-inbox",
        setup(b) {
          b.onResolve({ filter: /(?:thread-context|^@\/lib\/store$|\/BotAvatar)$/ }, (args) => ({
            path: args.path,
            namespace: "fixture"
          }))
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "tsx",
            resolveDir: resolve("."),
            contents: args.path.endsWith("thread-context")
              ? `import {useSyncExternalStore} from 'react';export const useThreadContext=()=>window.questionFixture.context;export const useThreadStateSelector=(id,selector)=>useSyncExternalStore(listener=>window.questionFixture.context.subscribeToThreadState(id,listener),()=>selector(window.questionFixture.context.getThreadState(id)));`
              : args.path.endsWith("BotAvatar")
                ? "export const BotAvatar=()=>null;"
                : "export const useAppStore={getState:()=>({showCustomizeView:false})};"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    ...(!existsSync(chromium.executablePath()) ? { channel: "chrome" } : {}),
    headless: true
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const custom = page.getByRole("textbox", { name: "自定义回答", exact: true })
    await page.getByRole("button", { name: /^Alpha/ }).click()
    await page.getByRole("button", { name: "下一题", exact: true }).click()
    await custom.fill("尚未提交的限制说明")
    await page.evaluate(() => (window as any).questionFixture.scroll(79))
    await custom.waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).questionFixture.scroll(0))
    assert.equal(await custom.inputValue(), "尚未提交的限制说明")
    await page.getByRole("button", { name: "上一题", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: /^Alpha/ }).getAttribute("aria-pressed"),
      "true"
    )
    await page.getByRole("button", { name: "下一题", exact: true }).click()
    await page.evaluate(() => (window as any).questionFixture.mode("inspect"))
    await page.locator('[data-inspecting="true"]').waitFor()
    assert.equal(await custom.inputValue(), "尚未提交的限制说明")
    await page.getByRole("button", { name: "上一题", exact: true }).click()
    assert.equal(
      await page.getByRole("button", { name: /^Alpha/ }).getAttribute("aria-pressed"),
      "true"
    )
    await page.getByRole("button", { name: /^Beta/ }).click()
    await page.getByRole("button", { name: "下一题", exact: true }).click()
    await custom.fill("执行记录里修订的限制说明")
    await page.evaluate(() => (window as any).questionFixture.mode("group"))
    await page.locator('[data-inspecting="true"]').waitFor({ state: "detached" })
    assert.equal(await custom.inputValue(), "执行记录里修订的限制说明")
    await page.evaluate(() => (window as any).questionFixture.show(false))
    await custom.waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).questionFixture.show(true))
    assert.equal(await custom.inputValue(), "执行记录里修订的限制说明")
    assert.deepEqual(await page.evaluate(() => (window as any).questionFixture.submissions), [])
    await page.getByRole("button", { name: "提交回答", exact: true }).click()
    const submitted = await page.evaluate(() => (window as any).questionFixture.submissions)
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].answers.q1.options[0].label, "Alpha")
    assert.equal(submitted[0].answers.q1.options[1].label, "Beta")
    assert.equal(submitted[0].answers.q2.text, "执行记录里修订的限制说明")
    assert.equal(
      await page.evaluate(
        () => (window as any).questionFixture.states["group-live"].userInputDraft
      ),
      null
    )

    // Replacement/cancellation never transfers drafts or resurrects an answer on remount.
    await page.evaluate(() => (window as any).questionFixture.replace("two"))
    assert.equal(
      await page.getByRole("button", { name: /^Alpha/ }).getAttribute("aria-pressed"),
      "false"
    )
    await page.getByRole("button", { name: "下一题", exact: true }).click()
    assert.equal(await custom.inputValue(), "")
    await custom.fill("仅属于问题二")
    await page.evaluate(() => (window as any).questionFixture.replace("three"))
    await page.getByRole("button", { name: "下一题", exact: true }).click()
    assert.equal(await custom.inputValue(), "")
    await custom.fill("取消草稿")
    await page.getByRole("button", { name: "跳过全部问题", exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => (window as any).questionFixture.states["group-live"].userInputDraft
      ),
      null
    )
    assert.equal((await page.evaluate(() => (window as any).questionFixture.submissions)).length, 2)

    // Ordinary workbench keeps its original local state and explicit submission.
    await page.evaluate(() => (window as any).questionFixture.mode("native"))
    await page.getByRole("radio", { name: /^Alpha/ }).click()
    await custom.fill("默认路径回答")
    assert.equal((await page.evaluate(() => (window as any).questionFixture.submissions)).length, 2)
    await page.getByRole("button", { name: "提交", exact: true }).click()

    // Private and work Bot surfaces retain independent drafts across normal navigation.
    for (const mode of ["private", "work"]) {
      await page.evaluate((mode) => (window as any).questionFixture.mode(mode), mode)
      await page.locator(`[data-bot-dialog="${mode}-live"]`).waitFor()
      await page.getByRole("button", { name: /^Alpha/ }).click()
      await page.getByRole("button", { name: "下一题", exact: true }).click()
      await custom.fill(`${mode} unsent constraint`)
    }
    for (const mode of ["private", "work"]) {
      await page.evaluate((mode) => (window as any).questionFixture.mode(mode), mode)
      await page.locator(`[data-bot-dialog="${mode}-live"]`).waitFor()
      assert.equal(await custom.inputValue(), `${mode} unsent constraint`)
      await page.getByRole("button", { name: "上一题", exact: true }).click()
      assert.equal(
        await page.getByRole("button", { name: /^Alpha/ }).getAttribute("aria-pressed"),
        "true"
      )
      await page.getByRole("button", { name: "下一题", exact: true }).click()
      await page.getByRole("button", { name: "提交回答", exact: true }).click()
      const rows = await page.evaluate(() => (window as any).questionFixture.submissions)
      assert.equal(rows.at(-1).answers.q2.text, `${mode} unsent constraint`)
      assert.equal(
        await page.evaluate(
          (id) => (window as any).questionFixture.states[id].userInputDraft,
          `${mode}-live`
        ),
        null
      )
    }
    assert.equal((await page.evaluate(() => (window as any).questionFixture.submissions)).length, 5)

    // The same controlled Bot path still auto-submits a one-question single choice.
    await page.evaluate(() => {
      const f = (window as any).questionFixture,
        id = "private-live"
      f.patch(id, {
        pendingUserInput: {
          requestId: "single",
          threadId: id,
          createdAt: new Date().toISOString(),
          questions: [
            { id: "one", question: "Choose", options: [{ label: "Alpha", description: "A" }] }
          ]
        },
        userInputDraft: null
      })
      f.mode("private")
    })
    await page.locator('[data-bot-dialog="private-live"]').waitFor()
    await page.getByRole("button", { name: /^Alpha/ }).click()
    assert.equal((await page.evaluate(() => (window as any).questionFixture.submissions)).length, 6)
    const late = await page.evaluate(() => {
      const f = (window as any).questionFixture,
        id = "private-live"
      const response = { requestId: "single", answers: {}, submittedAt: new Date().toISOString() }
      f.callbacks[id](response)
      f.patch(id, {
        pendingUserInput: {
          requestId: "replacement",
          threadId: id,
          createdAt: new Date().toISOString(),
          questions: []
        },
        userInputDraft: null
      })
      f.callbacks[id](response)
      const replacementPreserved = f.states[id].pendingUserInput.requestId
      f.context.getThreadActions(id).setPendingUserInput(null)
      f.callbacks[id]({ ...response, requestId: "replacement" })
      f.unmount()
      return {
        replacementPreserved,
        submissions: f.submissions.length,
        listeners: f.listeners.size
      }
    })
    assert.deepEqual(late, { replacementPreserved: "replacement", submissions: 6, listeners: 0 })
    assert.deepEqual(errors, [])
    console.log(
      "Question drafts retained across Virtuoso recycling and actual inspector dialog edits; cleared on submit/cancel/replacement; private/work navigation retains separate drafts; native explicit and Bot single-choice submission preserved."
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
