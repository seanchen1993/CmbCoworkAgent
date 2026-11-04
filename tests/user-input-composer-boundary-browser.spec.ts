/** Real question controls inside a chat form; answer submission must not submit its draft. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from "./src/renderer/src/lib/mods-chat-scope";
      import {UserInputRequestDialog} from "./src/renderer/src/components/chat/UserInputRequestDialog";
      const answers=[],sent=[],errors=[];
      Object.assign(window.api.mods,{
        promptAttach:async()=>{},promptDetach:async()=>{},promptEditSupport:async()=>false,
        onPromptRequest:()=>()=>{},onConfigurationChanged:()=>()=>{}
      });
      function Fixture(){
        const [request,setRequest]=useState(1),[multiple,setMultiple]=useState(false);
        const node=useRef(null),draft=useRef({text:'保留这段尚未发送的创作要求',revision:1});
        const editor=usePromptComposer({threadId:'chat',enabled:true,textarea:node,
          read:()=>draft.current,apply:()=>false});
        window.questionInput={answers,sent,errors,ready:editor.isReady,
          open:many=>{setMultiple(many);setRequest(value=>value+1||1)}};
        const question={id:'mode',header:'继续创作',question:'如何继续修改？',options:[
          {label:'重新打开会话创造者模式',description:'继续原草稿'},
          {label:'保持普通模式',description:'暂不修改'}]};
        return <ModsChatScope.Provider value={{threadId:'chat',enabled:false,ready:true}}>
          <form onSubmit={async event=>{event.preventDefault();try{
            await submitAfterPromptEdit('chat',{flush:editor.flushSubmission,read:()=>draft.current,
              isConfirmed:editor.isSubmissionConfirmed,submit:async value=>{sent.push(value.text)}})
          }catch(error){errors.push(error.message)}}}>
            <textarea ref={node} aria-label='聊天草稿' defaultValue={draft.current.text}/>
            <button type='submit'>发送聊天</button>
            <UserInputRequestDialog request={request?{requestId:'question-'+request,threadId:'chat',
              createdAt:new Date().toISOString(),questions:multiple?[question,{...question,id:'next'}]:[question]}:null}
              onSubmit={answer=>{answers.push(answer);setRequest(0)}}/>
          </form>
        </ModsChatScope.Provider>
      }
      host.render(<Fixture/>);
    `,
      [browserWorkerPlugin()]
    )
    await page.waitForFunction("window.questionInput.ready")
    await page.getByLabel("自定义回答", { exact: true }).fill("重新打开会话创造者模式")
    await page.getByLabel("自定义回答", { exact: true }).press("Enter")
    await page.evaluate(async () => {
      await new Promise<void>((done) => requestAnimationFrame(() => done()))
      await new Promise<void>((done) => requestAnimationFrame(() => done()))
    })
    assert.deepEqual(
      await page.evaluate("window.questionInput.errors"),
      [],
      "Answer Enter must not enter the blocked chat composer and report EDITOR_UNAVAILABLE"
    )
    assert.equal(await page.evaluate("window.questionInput.answers.length"), 1)
    assert.equal(
      await page.evaluate("window.questionInput.answers[0].answers.mode.text"),
      "重新打开会话创造者模式"
    )
    assert.equal(await page.evaluate("window.questionInput.sent.length"), 0)
    assert.equal(await page.getByLabel("聊天草稿").inputValue(), "保留这段尚未发送的创作要求")
    await page.getByRole("button", { name: "发送聊天", exact: true }).click()
    await page.waitForFunction("window.questionInput.sent.length===1")

    await page.evaluate("window.questionInput.open(false)")
    await page.getByRole("radio", { name: /重新打开会话创造者模式/ }).click()
    await page.getByRole("button", { name: "为重新打开会话创造者模式添加补充说明" }).click()
    const extra = page.getByLabel("重新打开会话创造者模式的补充说明", { exact: true })
    await extra.fill("保留现有效果")
    await extra.evaluate((node) =>
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    assert.equal(
      await page.evaluate("window.questionInput.answers.length"),
      1,
      "IME confirmation must not submit the answer"
    )
    await extra.press("Enter")
    assert.equal(
      await page.evaluate("window.questionInput.answers[1].answers.mode.additionalText"),
      "保留现有效果"
    )
    assert.equal(await page.evaluate("window.questionInput.sent.length"), 1)

    await page.evaluate("window.questionInput.open(true)")
    await page.getByLabel("自定义回答", { exact: true }).fill("只回答第一题")
    await page.getByLabel("自定义回答", { exact: true }).press("Enter")
    assert.equal(
      await page.evaluate("window.questionInput.answers.length"),
      2,
      "Incomplete questions must remain open"
    )
    assert.equal(await page.evaluate("window.questionInput.sent.length"), 1)
    assert.deepEqual(await page.evaluate("window.questionInput.errors"), [])
    console.log(
      "PASS answer Enter, option supplement, IME, incomplete questions and retained chat draft"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
