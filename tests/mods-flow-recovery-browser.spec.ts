/** Real React interaction; IPC is controlled here and covered separately in mods-flows.test.ts. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output", "mods-harness-20261009", `recovery-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const checks: string[] = []
  try {
    await mount(
      page,
      `
      let recoveryResolve, recoveryCount=0, eligible=false, resumeResolve, resumeReject;
      const resumeCalls=[], selected=[];
      window.api.mods.flowResume=(...args)=>{
        resumeCalls.push(args);
        return new Promise((resolve,reject)=>{resumeResolve=()=>resolve({id:'child',threadId:'a',workspace:'a',
          flow:saved('a'),status:'queued',startedAt:2,epoch:0,attempts:[],failureCounts:{}});resumeReject=()=>reject(Error('sensitive provider details'))});
      };
      window.api.mods.flowRecovery=(threadId,runId)=>{
        recoveryCount++;
        return new Promise(resolve=>{recoveryResolve=()=>resolve({schemaVersion:1,runId,
          sourceDigest:'a'.repeat(64),status:eligible?'eligible':'blocked',consumedExecutions:1,remainingExecutions:15,
          requiresFreshFinalization:true,
          reasons:eligible?[]:[{code:'legacy-binding-unverified',message:'旧记录未保存可重新核验的产物绑定。'}],
          steps:[{stepId:'build',name:'编码',disposition:eligible?'reusable':'unknown',reason:eligible?'文本结果通过当前证据核验。':'操作可能已经生效，请先核对。'}]
        })});
      };
      const showRecovery=id=>host.render(<FlowRunView run={{id,threadId:'a',workspace:'a',
        flow:saved('a'),status:'interrupted',startedAt:1,epoch:0,attempts:[],failureCounts:{}}}
        busy={false} onCancel={()=>{throw Error('unexpected cancellation')}}
        onDecide={()=>{throw Error('unexpected approval')}} onResumed={child=>{selected.push(child.id);showRecovery(child.id)}}/>);
      window.recoveryFixture={show:showRecovery,resolve:()=>recoveryResolve(),count:()=>recoveryCount,
        eligible:()=>eligible=true,resume:()=>resumeResolve(),reject:()=>resumeReject(),resumeCalls,selected};
      showRecovery('first');
    `
    )
    const assets = resolve("out/renderer/assets")
    const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
    assert(css, "Build production CSS before the browser regression")
    await page.addStyleTag({ path: join(assets, css) })
    await page.getByRole("button", { name: "检查能否继续" }).waitFor()
    assert.equal(await page.evaluate("window.recoveryFixture.count()"), 0)
    checks.push("Opening history performs no recovery query or business operation")
    await page.getByRole("button", { name: "检查能否继续" }).click()
    assert(await page.getByRole("button", { name: "正在核对…" }).isDisabled())
    await page.evaluate("window.recoveryFixture.show('second')")
    await page.getByRole("button", { name: "检查能否继续" }).waitFor()
    await page.evaluate("window.recoveryFixture.resolve()")
    assert.equal(
      await page.getByText("旧记录未保存可重新核验的产物绑定。", { exact: true }).count(),
      0
    )
    checks.push("Late response from a previous selected run is discarded")
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.evaluate("window.recoveryFixture.resolve()")
    await page.getByText("当前记录不能直接续跑。", { exact: true }).waitFor()
    assert(await page.getByText("编码 · 结果不明", { exact: true }).isVisible())
    assert(await page.getByText("旧记录未保存可重新核验的产物绑定。", { exact: true }).isVisible())
    assert.equal(await page.getByRole("button", { name: "恢复运行", exact: true }).count(), 0)
    checks.push("Blocked reasons and uncertain effects are visible without a resume action")
    await page.screenshot({ path: join(output, "recovery-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await page.getByRole("button", { name: "检查能否继续" }).isVisible())
    assert(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    await page.screenshot({ path: join(output, "recovery-narrow.png"), fullPage: true })
    checks.push("Narrow layout has no horizontal overflow")
    await page.evaluate(
      "window.recoveryFixture.eligible(); window.recoveryFixture.show('resumable')"
    )
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.evaluate("window.recoveryFixture.resolve()")
    const resumeButton = page.getByRole("button", { name: "恢复运行", exact: true })
    await resumeButton.waitFor()
    assert.equal(await page.evaluate("window.recoveryFixture.resumeCalls.length"), 0)
    await resumeButton.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    assert(await page.getByRole("button", { name: "正在准备续跑…" }).isDisabled())
    await page.screenshot({ path: join(output, "resume-preparing-narrow.png"), fullPage: true })
    assert.deepEqual(await page.evaluate("window.recoveryFixture.resumeCalls"), [
      ["a", "resumable", "a".repeat(64)]
    ])
    await page.evaluate("window.recoveryFixture.reject()")
    await page
      .getByText("未能确认恢复成功。源记录仍保留；请刷新历史并重新核对，避免重复执行。", {
        exact: true
      })
      .waitFor()
    assert.equal(await resumeButton.count(), 0)
    assert.equal(await page.getByText("sensitive provider details").count(), 0)
    assert(await page.locator('[data-flow-run="resumable"]').isVisible())
    checks.push(
      "Explicit resume forwards reviewed digest once; failure preserves source and clears stale eligibility"
    )
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.evaluate("window.recoveryFixture.resolve()")
    await resumeButton.click()
    await page.evaluate("window.recoveryFixture.show('elsewhere')")
    await page.locator('[data-flow-run="elsewhere"]').waitFor()
    await page.evaluate("window.recoveryFixture.resume()")
    assert.deepEqual(await page.evaluate("window.recoveryFixture.selected"), [])
    checks.push("A late successful resume cannot replace a different selected source")
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.evaluate("window.recoveryFixture.resolve()")
    await resumeButton.click()
    await page.evaluate("window.recoveryFixture.resume()")
    await page.locator('[data-flow-run="child"]').waitFor()
    assert.deepEqual(await page.evaluate("window.recoveryFixture.selected"), ["child"])
    checks.push("Successful explicit resume selects the new run")

    await mount(
      page,
      `
      const sourceRun={id:'source',threadId:'a',workspace:'a',flow:saved('a'),status:'interrupted',startedAt:1,epoch:0,attempts:[],failureCounts:{}};
      runs.set('source',sourceRun);
      window.api.mods.flowRecovery=async(threadId,runId)=>({schemaVersion:1,runId,sourceDigest:'a'.repeat(64),status:'eligible',consumedExecutions:1,remainingExecutions:15,requiresFreshFinalization:true,reasons:[],steps:[]});
      window.api.mods.flowResume=()=>new Promise((resolve,reject)=>{
        runs.set('source',{...sourceRun,summary:'来源已预占'});emit('a');
        window.panelReject=()=>reject(Error('unknown reply'));
        window.panelResume=()=>{const child={...sourceRun,id:'reserved',status:'running',startedAt:2};runs.set(child.id,child);resolve(child)};
      });
      host.render(<FlowsPanel threadId='a'/>);
    `
    )
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.getByRole("button", { name: "恢复运行", exact: true }).click()
    await page.getByText("来源已预占", { exact: true }).waitFor()
    assert(await page.getByRole("button", { name: "正在准备续跑…" }).isDisabled())
    await page.evaluate("window.panelReject()")
    await page
      .getByText("未能确认恢复成功。源记录仍保留；请刷新历史并重新核对，避免重复执行。", {
        exact: true
      })
      .waitFor()
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.getByRole("button", { name: "恢复运行", exact: true }).click()
    await page.evaluate("window.panelResume()")
    await page.locator('[data-flow-run="reserved"]').waitFor()
    checks.push(
      "The real parent panel selects the child even when a source update event arrives before the reply"
    )

    await mount(
      page,
      `
      runs.set('chat-source',{id:'chat-source',threadId:'a',workspace:'a',flow:saved('a'),status:'interrupted',startedAt:1,epoch:0,attempts:[],failureCounts:{}});
      window.api.mods.flowRecovery=async(threadId,runId)=>({schemaVersion:1,runId,sourceDigest:'a'.repeat(64),status:'eligible',consumedExecutions:1,remainingExecutions:15,requiresFreshFinalization:true,reasons:[],steps:[]});
      window.api.mods.flowResume=async()=>{const child={...runs.get('chat-source'),id:'chat-child',status:'running',startedAt:2};runs.set(child.id,child);return child};
      function ResumeChat(){const flow=useChatFlow('a','a',true);return <ChatFlowControls flow={flow} disabled={false}/>}
      host.render(<ResumeChat/>);
    `
    )
    await page.locator('[data-flow-run="chat-source"]').waitFor()
    await page.getByRole("button", { name: "检查能否继续" }).click()
    await page.getByRole("button", { name: "恢复运行", exact: true }).click()
    await page.locator('[data-flow-run="chat-child"]').waitFor()
    checks.push(
      "The chat flow controller selects the resumed child without starting a new ordinary task"
    )

    await mount(
      page,
      `
      const original={...definition('a'),schemaVersion:2,execution:{kind:'host'}};
      delete original.plugin;
      original.steps.push({id:'skill',name:'旧技能',kind:'skill',enabled:false,skill:{id:'skill-a',name:'Review',digest:'a'.repeat(64)},prompt:'review'});
      original.steps[0].onSuccess='review';
      let current=original, editorState;
      const render=value=>{current=value;host.render(<FlowEditor value={value} catalog={catalog} disabled={false}
        onChange={render} onEditorStateChange={state=>{editorState=state}}/>)};
      window.editorFixture={value:()=>current,state:()=>editorState};render(original);
    `
    )
    assert.equal(await page.getByLabel("执行模式", { exact: true }).inputValue(), "normal")
    const beforeSteps = await page.evaluate("JSON.stringify(window.editorFixture.value().steps)")
    await page.getByLabel("执行模式", { exact: true }).selectOption("prompt-only-v1")
    await page
      .getByText("当前配置不符合文本模式，保存前请手动修正；已有步骤不会自动删除。", {
        exact: true
      })
      .waitFor()
    assert.equal(
      await page.evaluate("JSON.stringify(window.editorFixture.value().steps)"),
      beforeSteps
    )
    assert.equal(await page.evaluate("window.editorFixture.state().valid"), false)
    assert(await page.getByText(/Agent 仅处理任务与前序文本/).isVisible())
    await page.screenshot({ path: join(output, "text-mode-invalid-steps.png"), fullPage: true })
    await page.getByLabel("执行模式", { exact: true }).selectOption("normal")
    assert.deepEqual(await page.evaluate("window.editorFixture.value().execution"), {
      kind: "host"
    })
    assert.equal(
      await page.evaluate("JSON.stringify(window.editorFixture.value().steps)"),
      beforeSteps
    )
    checks.push(
      "Text mode is opt-in and preserves unsupported steps and routes for explicit repair"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks, artifacts: output }))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)
    )
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
