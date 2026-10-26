/** Real stage-debug React controls; native IPC facts are supplied without execution authority. */
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/project-stage-debug-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ProjectStageDebugPanel} from './src/renderer/src/components/customize/ProjectStageDebugPanel';
        const root=createRoot(document.getElementById('root')), listeners=new Set(), calls=[], opened=[], repairs=[], finishes=[];
        let revision=1, scope='A', finishPrepare, finishCreate, finishRepair, failPrepare='', failCreate='', selectedProjectId, branchId='', branchDigest='', branchStatus='passed', retained=false, cold=false, foreignRetained=false, foreignCold=false;
        const digest=()=>String(revision).repeat(64);
        const snapshot={id:'snapshot',projectId:'original',stageId:'review',stageTitle:'内容审查',sourceDigest:'a'.repeat(64),createdAt:1700000000000,fileCount:2,totalBytes:120};
        const stageDebug={
          list:async threadId=>({snapshots:[snapshot],branches:[{id:'old-branch',projectId:'old-project',sourceProjectId:'original',snapshotId:'snapshot',candidateDigest:'b'.repeat(64),currentCandidateMatches:false,stageId:'review',mode:'stage',status:'passed',diagnostics:['原生文件检查通过']},...(branchId?[{id:branchId,projectId:branchId,sourceProjectId:'original',snapshotId:'snapshot',candidateDigest:branchDigest,currentCandidateMatches:branchDigest===digest(),stageId:'review',mode:'stage',status:branchStatus,diagnostics:[]}]:[])],diagnostics:[]}),
          prepare:input=>{calls.push(['prepare',input]);if(failPrepare){const code=failPrepare;failPrepare='';return Promise.reject(Error(code))}return new Promise(resolve=>finishPrepare=()=>resolve({id:'prepared-'+input.threadId,snapshotId:input.snapshotId,sourceProjectId:'original',stageId:'review',mode:input.mode,candidateDigest:input.expectedDigest,affectedStageIds:input.mode==='stage'?['review']:['review','publish'],diagnostics:[],canCreate:true}))},
          create:input=>{calls.push(['create',input]);if(failCreate){const code=failCreate;failCreate='';return Promise.reject(Error(code))}return new Promise(resolve=>finishCreate=()=>{branchId='isolated-'+input.threadId;branchDigest=input.expectedDigest;retained=true;resolve({projectId:branchId})})}
        };
        const preview={stageDebug,list:async threadId=>({threadId,workspace:'C:/fixture/'+threadId,drafts:[{id:'draft',name:'审查插件',revision,digest:digest(),...(retained?(cold?{recovery:{projectId:branchId,revision,digest:digest(),workspace:'C:/branch/'+threadId,goal:'审查',projectVersion:1,status:'needs-confirmation',debugBranch:true,hasUnconfirmedEffects:branchStatus==='unknown'||branchStatus==='running'}}:{projectId:branchId}):{})},...(foreignRetained?[{id:'foreign-draft',name:'另一份原生候选',revision:1,digest:'f'.repeat(64),...(foreignCold?{recovery:{projectId:'old-project',revision:1,digest:'f'.repeat(64),workspace:'C:/foreign-branch',goal:'原生复核',projectVersion:1,status:'needs-confirmation',debugBranch:true,hasUnconfirmedEffects:false}}:{projectId:'old-project'})}]:[])]}),finish:async input=>{finishes.push(input);if(input.projectId==='old-project')foreignRetained=false;else retained=false}};
        window.api={mods:{development:{onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}}};
        const show=threadId=>{scope=threadId;root.render(<React.StrictMode><ProjectStageDebugPanel threadId={threadId} workspace={'C:/fixture/'+threadId} draftId='draft' preview={preview} selectedProjectId={selectedProjectId} onOpenProject={id=>{opened.push(id);selectedProjectId=id;show(scope)}} onFinishProject={id=>{if(selectedProjectId===id)selectedProjectId=undefined;show(scope)}} onOpenSource={id=>calls.push(['source',id])} onRequestRepair={message=>{repairs.push(message);return new Promise(resolve=>finishRepair=resolve)}} /></React.StrictMode>)};
        window.fixture={calls,opened,repairs,finishes,show,foreignBranch:(isCold=false)=>{foreignRetained=true;foreignCold=isCold;for(const fn of listeners)fn({threadId:scope})},branchState:(status,isCold=false)=>{branchStatus=status;cold=isCold;retained=true;for(const fn of listeners)fn({threadId:scope})},failNextPrepare:(code='PROJECT_STAGE_DEBUG_SOURCE_UNSETTLED')=>failPrepare=code,failNextCreate:code=>failCreate=code,finishPrepare:()=>finishPrepare(),finishCreate:()=>finishCreate(),finishRepair:()=>finishRepair(),update:()=>{revision++;for(const fn of listeners)fn({threadId:scope})}};
        show('A');
      `
    }
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" })
  }
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    const panel = page.getByRole("region", { name: "阶段隔离调试", exact: true })
    await panel.getByText("审查插件 · 修订 1", { exact: true }).waitFor({ state: "attached" })
    await panel.getByRole("combobox", { name: "选择阶段输入快照", exact: true })
      .selectOption("snapshot")
    await panel.getByRole("combobox", { name: "选择已保存的最新候选", exact: true })
      .selectOption("draft")
    await panel.getByRole("combobox", { name: "调试范围", exact: true })
      .selectOption("stage")
    assert.equal(
      await page.evaluate("window.fixture.calls.length"),
      0,
      "Reading snapshots must not prepare, approve or execute a branch"
    )
    await panel.locator("summary").click()
    await panel.getByText("review · 单阶段 · 本次调试范围的检查已通过", { exact: true }).waitFor()
    await panel.getByText("以下仅反映各分支调试范围", { exact: false }).waitFor()
    await panel.getByText("此分支属于历史候选，当前候选已变化或不可读取；历史结果不能代表当前版本通过。", { exact: true }).waitFor()
    assert.equal(await panel.getByText("整轮试用已通过", { exact: true }).count(), 0)
    const feedback = panel.getByRole("textbox", { name: "此阶段希望如何修改", exact: true })
    await feedback.fill("  补充审查规则  ")
    await panel.getByRole("button", { name: "将阶段修改要求发送到原聊天", exact: true }).click()
    await page.waitForFunction("window.fixture.repairs.length===1")
    await feedback.fill("下一条未提交需求")
    await page.evaluate("window.fixture.finishRepair()")
    await panel.getByRole("status").waitFor()
    assert.equal(await feedback.inputValue(), "下一条未提交需求")
    assert.match(
      await page.evaluate("window.fixture.repairs[0]"),
      /阶段 review.*输入快照 snapshot.*我的要求：补充审查规则/
    )

    const prepare = panel.getByRole("button", { name: "准备阶段调试方案", exact: true })
    const create = panel.getByRole("button", {
      name: "确认创建隔离调试分支（尚不执行）",
      exact: true
    })
    await page.evaluate("window.fixture.failNextPrepare()")
    await prepare.click()
    await panel.getByRole("alert").filter({ hasText: "原试用仍占用输入或执行权限" }).waitFor()
    await panel.getByRole("button", { name: "查看快照所属原试用", exact: true }).click()
    assert.equal(await page.evaluate("window.fixture.calls.at(-1)[1]"), "original")
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(row=>['finish','cancel','create'].includes(row[0])).length"
      ),
      0,
      "A busy original trial must show native recovery guidance without cancelling or replaying it"
    )
    for (const [code, guidance] of [
      ["PROJECT_STAGE_DEBUG_HOOKS_UNSUPPORTED", "尚缺 Hooks 的隔离适配"],
      ["PROJECT_STAGE_DEBUG_SKILL_HOOKS_INVALID", "不能跳过原业务校验"],
      ["PROJECT_STAGE_DEBUG_MCP_UNSUPPORTED", "尚缺外部依赖的隔离适配"],
      ["PROJECT_STAGE_DEBUG_CONTEXT_UNSUPPORTED", "不能省略这些输入"],
      ["PROJECT_STAGE_DEBUG_CONFIGURATION_UNSUPPORTED", "尚缺配置的隔离适配"],
      ["PROJECT_STAGE_DEBUG_ACTIONS_UNSUPPORTED", "尚缺动作及其外部副作用的隔离适配"],
      ["PROJECT_STAGE_DEBUG_SHARED_MODS_UNSUPPORTED", "不能通过关闭其他 Mods 绕过原规则"],
      ["PROJECT_STAGE_DEBUG_CHECK_EFFECT", "不能删除检查来运行"],
      ["PROJECT_STAGE_DEBUG_READONLY_ADAPTER_REQUIRED", "不能删除检查后继续"],
      ["PROJECT_STAGE_DEBUG_CHECK_INPUT_UNSUPPORTED", "不能删除检查后继续"],
      ["PROJECT_READONLY_CHECK_SCOPE_CHANGED", "不能删除检查后继续"],
      ["PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED", "选择更早的阶段起点"],
      ["PROJECT_STAGE_DEBUG_CONTRACT_CHANGED", "旧快照不能证明新阶段输入兼容"],
      ["PROJECT_STAGE_DEBUG_SINGLE_STAGE_ONLY", "不能直接推进后续阶段"],
      ["PROJECT_STAGE_DEBUG_RECONFIRMATION_REQUIRED", "重新准备并确认新分支"]
    ]) {
      await page.evaluate(
        (code) =>
          (
            window as unknown as { fixture: { failNextPrepare(code: string): void } }
          ).fixture.failNextPrepare(code),
        code
      )
      await prepare.click()
      const notice = panel.getByRole("alert")
      await notice.filter({ hasText: guidance }).waitFor()
      assert.match(await notice.innerText(), /原项目/)
      assert.equal(await create.count(), 0)
    }
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(row=>['finish','cancel','create'].includes(row[0])).length"
      ),
      0,
      "Unsupported adapters must never remove checks, disable Mods, cancel original work or create a branch"
    )
    await prepare.click()
    await page.evaluate("window.fixture.finishPrepare()")
    await panel.getByRole("checkbox").check()
    await page.evaluate("window.fixture.failNextCreate('PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED')")
    await create.click()
    await panel.getByRole("alert").filter({ hasText: "刚才的调试确认已失效" }).waitFor()
    assert.equal(
      await create.count(),
      0,
      "Input changes after confirmation must require a fresh prepare and human confirmation"
    )
    await prepare.click()
    await page.evaluate("window.fixture.finishPrepare()")
    await panel.getByRole("region", { name: "阶段调试原生确认", exact: true }).waitFor()
    assert.equal(await create.isDisabled(), true)
    await panel.getByRole("checkbox").check()
    assert.equal(await create.isEnabled(), true)
    await page.evaluate("window.fixture.update()")
    await panel.getByText("审查插件 · 修订 2", { exact: true }).waitFor({ state: "attached" })
    assert.equal(
      await create.count(),
      0,
      "A new candidate must invalidate old preparation and human confirmation"
    )
    await prepare.click()
    await page.evaluate("window.fixture.finishPrepare()")
    await panel.getByRole("checkbox").check()
    await create.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='create').length"),
      2,
      "Double clicks must not create duplicate debug projects"
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.at(-1)[1].expectedDigest"),
      "2".repeat(64)
    )
    await page.evaluate("window.fixture.finishCreate()")
    await page.waitForFunction("window.fixture.opened.length===1")
    assert.equal(await page.evaluate("window.fixture.opened[0]"), "isolated-A")
    assert.equal(await create.count(), 0)
    assert.equal(
      await page.evaluate("window.fixture.calls.some(row=>row[0]==='start'||row[0]==='approve')"),
      false,
      "Creating an isolated branch must not start or approve native execution"
    )

    await prepare.click()
    await page.evaluate("window.fixture.update()")
    await panel.getByText("审查插件 · 修订 3", { exact: true }).waitFor({ state: "attached" })
    await page.evaluate("window.fixture.finishPrepare()")
    await panel.getByRole("alert").waitFor()
    assert.equal(
      await create.count(),
      0,
      "An old async prepare must not resurrect confirmation after candidate changes"
    )
    await prepare.click()
    await page.evaluate("window.fixture.show('B')")
    await panel.getByText("审查插件 · 修订 3", { exact: true }).waitFor({ state: "attached" })
    await page.evaluate("window.fixture.finishPrepare()")
    // A fresh explicit refresh settles the new scope before checking the old response.
    await panel.getByRole("button", { name: "刷新阶段调试记录", exact: true }).click()
    assert.equal(await create.count(), 0, "A response from creator A must not appear in creator B")
    assert.deepEqual(await page.evaluate("window.fixture.opened"), ["isolated-A"])
    await page.evaluate("window.fixture.show('A')")
    await panel.getByRole("button", { name: "刷新阶段调试记录", exact: true }).click()
    if (
      !(await panel.locator("details").evaluate((element) => (element as HTMLDetailsElement).open))
    )
      await panel.locator("summary").click()
    const branchEnd = panel.getByRole("button", {
      name: "结束此隔离调试分支（保留文件与结果）",
      exact: true
    })
    await branchEnd.waitFor()
    assert.equal(
      await branchEnd.isEnabled(),
      true,
      "A selected settled S6 branch exposes its own finish even when the current draft differs from the original trial request"
    )
    await page.evaluate("window.fixture.branchState('unknown')")
    await panel.getByText("分支仍在运行或结果尚未确认", { exact: false }).waitFor()
    assert.equal(await branchEnd.isDisabled(), true)
    await page.evaluate("window.fixture.branchState('running')")
    await panel.getByText("review · 单阶段 · 正在隔离执行", { exact: true }).waitFor()
    assert.equal(await branchEnd.isDisabled(), true)
    assert.equal(
      await page.evaluate("window.fixture.finishes.length"),
      0,
      "Running and unknown effects must never be ended by the debug history UI"
    )
    await page.evaluate("window.fixture.branchState('passed')")
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent === "结束此隔离调试分支（保留文件与结果）" && !button.disabled
      )
    )
    await branchEnd.click()
    await page.waitForFunction("window.fixture.finishes.length===1")
    assert.deepEqual(await page.evaluate("window.fixture.finishes[0]"), {
      threadId: "A",
      projectId: "isolated-A"
    })
    await panel
      .getByRole("region", { name: "当前调试分支结束操作", exact: true })
      .waitFor({ state: "detached" })
    assert.equal(
      await panel.getByRole("region", { name: "当前调试分支结束操作", exact: true }).count(),
      0,
      "Finishing must close only the selected execution panel while retaining historical results"
    )
    await page.evaluate("window.fixture.branchState('passed',true)")
    await panel.getByRole("button", { name: "刷新阶段调试记录", exact: true }).click()
    if (
      !(await panel.locator("details").evaluate((element) => (element as HTMLDetailsElement).open))
    )
      await panel.locator("summary").click()
    await panel
      .getByRole("button", { name: "查看此隔离分支的阶段操作", exact: true })
      .last()
      .click()
    await branchEnd.waitFor()
    assert.equal(await branchEnd.isEnabled(), true)
    await branchEnd.click()
    await page.waitForFunction("window.fixture.finishes.length===2")
    assert.deepEqual(
      await page.evaluate("window.fixture.finishes[1]"),
      { threadId: "A", projectId: "isolated-A", draftId: "draft" },
      "Cold retained branches must use the exact native retained draft finish path"
    )
    if (
      !(await panel.locator("details").evaluate((element) => (element as HTMLDetailsElement).open))
    )
      await panel.locator("summary").click()
    await panel
      .getByText("review · 单阶段 · 本次调试范围的检查已通过", { exact: true })
      .last()
      .waitFor()
    for (const cold of [false, true]) {
      await page.evaluate(cold => (window as unknown as { fixture: { foreignBranch(cold: boolean): void } }).fixture.foreignBranch(cold), cold)
      await panel.getByRole("button", { name: "刷新阶段调试记录", exact: true }).click()
      if (!(await panel.locator("details").evaluate(element => (element as HTMLDetailsElement).open)))
        await panel.locator("summary").click()
      await panel.getByRole("button", { name: "查看此隔离分支的阶段操作", exact: true }).first().click()
      await branchEnd.waitFor()
      assert.equal(await branchEnd.isEnabled(), true,
        "An owned branch of another draft still exposes its exact native finish path")
      assert.equal(await panel.getByLabel("选择已保存的最新候选", { exact: true }).locator("option").count(), 1,
        "Owner lookup must not relax the current request/intent candidate filter")
      const count = await page.evaluate("window.fixture.finishes.length")
      await branchEnd.click()
      await page.waitForFunction(count => (window as unknown as { fixture: { finishes: unknown[] } }).fixture.finishes.length === count + 1, count)
      assert.deepEqual(await page.evaluate("window.fixture.finishes.at(-1)"), {
        threadId: "A", projectId: "old-project", ...(cold ? { draftId: "foreign-draft" } : {})
      })
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "stage-debug-mobile.png"), fullPage: true })
    console.log(
      "PASS stage debug native confirmation, candidate expiry, source comparison, double-create and creator-scope isolation"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
