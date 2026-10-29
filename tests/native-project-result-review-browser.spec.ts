/** Real React controls with bounded IPC fixtures; backend protocol has separate SQLite tests. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/native-project-result-review", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const stubs: Record<string, string> = {
    ProjectActionResults: "export function ProjectActionResults(){return null}",
    ProjectLibraryPanel: "export function ProjectLibraryPanel(){return null}",
    ProjectFunctionConsent: "import {useEffect} from 'react'; export function ProjectFunctionConsent({onReady}){useEffect(()=>onReady(true),[]);return null}",
    SparksDocumentationLink: "export function SparksDocumentationLink(){return null}"
  }
  const result = await build({
    write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "fixture", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store|\.\.\/\.\.\/lib\/store)$/ }, () => ({ path: "store", namespace: "fixture" }))
      builder.onResolve({ filter: /(?:ProjectActionResults|ProjectLibraryPanel|ProjectFunctionConsent|SparksDocumentationLink)$/ }, args => {
        const name = args.path.split("/").at(-1)!
        return stubs[name] ? { path: name, namespace: "fixture" } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        loader: "tsx", resolveDir: root, contents: args.path === "store"
          ? "const state={accountRevision:0,threads:[],threadDirectoryHasMore:false,threadDirectoryLoadingMore:false}; export const useAppStore=selector=>selector(state); useAppStore.getState=()=>state; useAppStore.subscribe=()=>()=>{}; export const isThreadDeletionPending=()=>false"
          : stubs[args.path]
      }))
    } }],
    stdin: { loader: "tsx", resolveDir: root, contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {LocalProjectRun} from './src/renderer/src/components/harness-board/LocalProjectsPanel';
      import {LocalProjectImport} from './src/renderer/src/components/harness-board/LocalProjectImport';
      const review={operationId:'op',expectedVersion:1,inputFingerprint:'input',pluginDigest:'plugin',
        artifactFingerprint:'artifact',receiptFingerprint:'receipt',policyDigest:'policy'};
      let project={projectId:'p',name:'设计任务',goal:'完成设计并确认',version:1,stageIndex:0,status:'active',
        packageVersion:'1.0.0',pluginDigest:'plugin',manifest:{stages:[{id:'design',title:'设计',actionIds:[],
          checkIds:['schema'],artifactIds:['design'],approval:'none',resultApproval:'human'}],actions:[],
          artifacts:[{id:'design',path:'design.json'}],checks:[{id:'schema',artifactId:'design',kind:'json-schema'}]}};
      let operation={operationId:'op',projectId:'p',expectedVersion:1,stageId:'design',status:'succeeded',
        createdAt:1,updatedAt:2,startedAt:1,execution:null,approval:null,resultApproval:null,
        receipts:[{checkId:'schema',result:'passed',checkedAt:2}]};
      const calls=[]; let stale=false; let mode='review'; let migrationReview; let adapterMode=false; let frozenSource=false; let savedImport; let releaseCancel;
      let releasePrepare; let prepareFailures=0; let operationHistory=[];
      const migration={projectId:'p',expectedVersion:3,sourceDigest:'old',targetDigest:'new',
        targetVersion:'1.1.0',inputFingerprint:'old-input',candidateInputFingerprint:'new-input',
        preservedStageIds:['design'],remainingStageIds:['review','deliver'],contractDigest:'contract'};
      const view=()=>({project:structuredClone(project),operations:mode==='migration'?[]:[structuredClone(operation),...structuredClone(operationHistory)],
        ...(['input','waiting','blocked'].includes(mode)?{inputWait:{operationId:'op',requestId:'request',threadId:'thread',resumable:mode!=='blocked',status:mode==='waiting'?'waiting':'answered'}}:{}),
        ...(migrationReview?{migrationReview}:{}),
        ...(mode==='imported'?{resultApprovalRequired:true,importedSource:{sourceProjectId:'old',prefixStageIds:['design'],reexecuteStageIds:adapterMode?['design']:[]}}:{}),
        ...(stale?{resultReviewError:'成果或检查已变化，请重新核对后再审批。'}:{resultReview:review})});
      window.api={file:{selectDirectory:async()=>({canceled:false,filePaths:['C:/new-task']})},harnessBoard:{localProjects:{
        legacyImport:{sources:async()=>[{projectId:'old',packageId:'original',workspace:'C:/old-task',frozen:frozenSource}],
          target:async()=>({adapters:adapterMode?[{id:'legacy-documents',title:'从原记录导入',parameters:[{id:'feature',label:'特性编号'}]}]:[],stages:[{id:'design',title:'设计',eligible:!adapterMode,artifacts:[{id:'design',path:'design.json'}]}]}),
          review:async(input)=>{calls.push({kind:'import-review',input});return {...input,files:[{artifactId:'design',sourcePath:input.artifacts[0].sourcePath,targetPath:'design.json',digest:'sha',bytes:4}],reviewDigest:'review'}},
          reviewAdapter:async(input)=>{calls.push({kind:'import-adapter-review',input});savedImport={...input,prefixStageIds:['design'],files:[{artifactId:'design',sourcePath:'old/design.md',targetPath:'design.json',digest:'sha',bytes:4}],reviewDigest:'adapted-review',adaptation:{checkpoint:{value:'design'},sourceFiles:[{sourcePath:'old/design.md'}],materialPath:'.devclaw/import-source.json',reexecuteStageIds:['design']}};return structuredClone(savedImport)},
          resumeReview:async(id)=>{if(id!=='old')throw Error('wrong source');calls.push({kind:'import-resume-review',sourceProjectId:id});return structuredClone(savedImport)},
          confirm:async(review)=>{calls.push({kind:'import-confirm',review});return view()}
        },get:async()=>view(),command:async(id,command)=>{
        calls.push(structuredClone(command));
        if(id!==project.projectId)throw Error('wrong project');
        if(command.kind==='validate-imported'||command.kind==='start'){
          if(mode.startsWith('retry')||mode.startsWith('instructions')){
            if(command.kind!=='start'||command.operationId!=='retry-op'||operation.status!=='prepared')throw Error('wrong retry operation');
            operation.status='started';
          }else{
            if(mode!=='imported'||(command.kind==='start')!==adapterMode)throw Error('wrong import execution');operation.status='succeeded';
          }
        }else if(command.kind==='approve-result'){
          if(stale||JSON.stringify(command.review)!==JSON.stringify(review))throw Error('INPUT_CHANGED');
          if(operation.resultApproval)throw Error('RESULT_APPROVAL_ALREADY_DECIDED');
          if(command.decision==='approved'&&'feedback' in command)throw Error('approval must not carry feedback');
          operation.resultApproval={...review,decision:command.decision,...(command.feedback?{feedback:command.feedback}:{}),actorId:'desktop-user',decidedAt:3};
        }else if(command.kind==='cancel'){
          if(operation.status!=='succeeded'||operation.resultApproval?.decision!=='rejected')throw Error('retry requires rejected settled result');
          if(mode==='retry-deferred')await new Promise(resolve=>{releaseCancel=resolve});
          operation={...operation,status:mode==='retry-unknown'?'unknown':'cancelled'};
        }else if(command.kind==='prepare'){
          if(mode.startsWith('instructions')){
            if(operation.status!=='failed'||command.expectedVersion!==project.version||!command.idempotencyKey)throw Error('wrong failed-stage prepare');
            if(prepareFailures-->0)throw Error('fixture prepare rejected');
            const savedMode=mode;
            const nextOperation={...operation,operationId:'retry-op',status:'prepared',resultApproval:null,
              ...(command.stageInstructions?{stageInstructions:command.stageInstructions}:{})};
            const nextView={...view(),operations:[nextOperation,structuredClone(operation)]};
            if(mode==='instructions-deferred')await new Promise(resolve=>{releasePrepare=resolve});
            if(savedMode!==mode)return nextView;
            operationHistory=[structuredClone(operation)];operation=nextOperation;
          }else{
            if(operation.status!=='cancelled'||command.expectedVersion!==project.version||!command.idempotencyKey)throw Error('prepare before settled cancellation');
            operation={...operation,operationId:'retry-op',status:'prepared',resultApproval:null};
          }
        }else if(command.kind==='continue'){
          if(operation.resultApproval?.decision!=='approved')return{...view(),continuation:{reason:'result_approval_required'}};
          project={...project,stageIndex:1,status:'completed',version:2};operation={...operation,status:'transitioned'};
        }else if(command.kind==='resume-input'){
          if(command.operationId!=='op'||command.requestId!=='request')throw Error('wrong input binding');
          mode='review';operation={...operation,status:'succeeded'};
        }else if(command.kind==='review-plan'){
          if(command.expectedVersion!==3)throw Error('wrong version');
          migrationReview=migration;
        }else if(command.kind==='migrate-plan'){
          if(JSON.stringify(command.review)!==JSON.stringify(migration))throw Error('wrong migration review');
          project={...project,version:4,packageVersion:'1.1.0'};migrationReview=undefined;
        }else throw Error('unexpected command');
        return view();
      }}}};
      const root=createRoot(document.getElementById('root'));let renderKey=0;
      const render=()=>root.render(mode==='import-wizard'
        ? <LocalProjectImport key={++renderKey} templates={[{installedPluginId:'new',name:'新文档插件',version:'1.0.0',stages:['设计']}]} onCancel={()=>{}} onCreated={()=>{mode='imported';operation.status='prepared';if(adapterMode)project.manifest.stages[0].resultApproval='none';render()}}/>
        : <LocalProjectRun key={++renderKey} projectId={project.projectId} onChanged={()=>{}}/>);
      window.fixture={calls,answer:()=>{mode='input'},releaseCancel:()=>releaseCancel?.(),
        releasePrepare:()=>releasePrepare?.(),
        changeOperation:()=>{operation={...operation,operationId:'other-op'}},
        changeStage:()=>{project={...project,version:project.version+1,stageIndex:1,
          manifest:{...project.manifest,stages:[project.manifest.stages[0],{...project.manifest.stages[0],id:'plan',title:'计划'}]}};
          operation={...operation,stageId:'plan',expectedVersion:project.version}},
        reset:(next)=>{
        frozenSource=next==='import-resume';adapterMode=next==='import-adapter'||frozenSource;mode=adapterMode?'import-wizard':next;stale=next==='stale';
        operationHistory=[];prepareFailures=next==='instructions-fail'?1:0;
        project={...project,projectId:next==='instructions-other-project'?'q':'p',status:'active',stageIndex:0,version:next==='migration'?3:1};
        project.manifest.stages=[{...project.manifest.stages[0],id:'design',title:'设计',approval:['retry-human','instructions-human'].includes(next)?'human':'none'}];
        operation={...operation,projectId:project.projectId,operationId:'op',stageId:'design',expectedVersion:project.version,
          status:['input','waiting','blocked','preparation-unknown'].includes(next)?'unknown':next.startsWith('instructions')?'failed':'succeeded',resultApproval:null,
          execution:null,receipts:[{checkId:'schema',result:'passed',checkedAt:2}]};
        if(next==='instructions-limit'||next==='preparation-unknown'){
          operation.receipts=[];operation.execution={threadId:'thread',terminal:{settledAt:3,
            outcome:next==='instructions-limit'?'error':'unknown',
            code:next==='instructions-limit'?'project_check_input_limit':'project_phase_preparation_unconfirmed'}};
        }
        delete operation.stageInstructions;
        render();
      }};
      render();
    ` }
  })
  const browser = await chromium.launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, channel: "msedge" }))
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("http://127.0.0.1:47777/**", route => route.fulfill({
      contentType: "text/html", body: '<html><body><div id="root"></div></body></html>'
    }))
    await page.goto("http://127.0.0.1:47777/")
    await page.addScriptTag({ content: result.outputFiles[0].text })
    const reset = async (mode: string) => {
      await page.evaluate(value =>
        (window as unknown as {fixture:{reset(mode:string):void}}).fixture.reset(value), mode)
      if (mode.startsWith("instructions")) {
        await page.getByText("补充要求（可选）", { exact: true }).click()
      }
    }
    await page.getByRole("button", { name: "接受当前成果", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "确认完成任务", exact: true }).count(), 0)
    await page.getByRole("button", { name: "开始执行", exact: true }).click()
    await page.getByText("任务已停在需要你确认的位置，请处理下方待办。").waitFor()
    await page.getByRole("button", { name: "拒绝当前成果", exact: true }).click()
    await page.getByText("你已拒绝这版成果，流程尚未推进。").waitFor()
    assert.equal(await page.getByRole("button", { name: "确认完成任务", exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "接受当前成果", exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "拒绝当前成果", exact: true }).isDisabled(), true)
    await reset("review") // A separate undecided result accepts without feedback; never overwrite rejection.
    await page.getByRole("button", { name: "接受当前成果", exact: true }).click()
    await page.getByRole("button", { name: "确认完成任务", exact: true }).waitFor()
    await page.getByRole("button", { name: "开始执行", exact: true }).click()
    await page.getByRole("heading", { name: "设计任务 · 已完成" }).waitFor()
    const calls = await page.evaluate(() => (window as unknown as { fixture: { calls: Array<{kind:string;decision?:string;review?:unknown}> } }).fixture.calls)
    assert.deepEqual(calls.map(call => [call.kind, call.decision]), [
      ["continue", undefined], ["approve-result", "rejected"],
      ["approve-result", "approved"], ["continue", undefined]
    ])
    assert.ok(calls[2].review)
    const commandCount = () => page.evaluate(() =>
      (window as unknown as {fixture:{calls:unknown[]}}).fixture.calls.length)
    const latestCommands = (offset: number) => page.evaluate(value =>
      (window as unknown as {fixture:{calls:Array<{kind:string;operationId?:string;feedback?:string;stageInstructions?:string;idempotencyKey?:string}>}}).fixture.calls.slice(value), offset)
    const instructions = page.getByRole("textbox", { name: "本次阶段补充说明（可选）", exact: true })
    const startStage = page.getByRole("button", { name: "开始当前阶段", exact: true })
    const continuous = page.getByRole("button", { name: "开始执行", exact: true })
    const preparationOffset = await commandCount()
    await reset("instructions-limit")
    const preparationMessage = page.getByLabel("本次步骤问题说明", { exact: true })
    await preparationMessage.waitFor()
    assert.match((await preparationMessage.textContent())!, /超过插件声明的读取上限，检查尚未启动/)
    await instructions.waitFor()
    assert.equal(await page.getByLabel("本次检查失败详情", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "接受当前成果", exact: true }).count(), 0)
    await reset("preparation-unknown")
    await page.getByRole("button", { name: "核对上次执行结果", exact: true }).waitFor()
    assert.match((await preparationMessage.textContent())!, /核对前不会自动重跑或推进/)
    assert.equal(await startStage.count(), 0)
    assert.equal(await instructions.count(), 0)
    assert.equal(await page.getByRole("button", { name: "接受当前成果", exact: true }).count(), 0)
    assert.equal(await commandCount(), preparationOffset)
    await reset("instructions-fail")
    await instructions.fill("  修正中文边界\n保留原检查  ")
    assert.equal(await instructions.getAttribute("maxlength"), "4000")
    assert.equal(await continuous.isDisabled(), true)
    assert.equal(await page.getByLabel("本次操作已保存的阶段补充说明", { exact: true }).count(), 0)
    const instructionsOffset = await commandCount()
    await startStage.click()
    await page.waitForFunction(() => !(document.querySelector('[aria-label="本次阶段补充说明（可选）"]') as HTMLTextAreaElement)?.disabled)
    assert.equal(await instructions.inputValue(), "  修正中文边界\n保留原检查  ")
    assert.deepEqual((await latestCommands(instructionsOffset)).map(call => call.kind), ["prepare"])
    await startStage.click()
    await page.getByText("正在执行", { exact: true }).waitFor()
    const instructionCalls = await latestCommands(instructionsOffset)
    assert.deepEqual(instructionCalls.map(call => call.kind), ["prepare", "prepare", "start"])
    assert.equal(instructionCalls[1].stageInstructions, "修正中文边界\n保留原检查")
    assert.notEqual(instructionCalls[0].idempotencyKey, instructionCalls[1].idempotencyKey)
    assert.equal(instructionCalls[2].operationId, "retry-op")
    assert.equal(await instructions.count(), 0)
    assert.equal(await page.getByLabel("本次操作已保存的阶段补充说明", { exact: true }).count(), 1)
    assert.match((await page.getByLabel("本次操作已保存的阶段补充说明", { exact: true }).textContent())!, /修正中文边界\n保留原检查/)

    await reset("instructions-human")
    await instructions.fill("下一次仍需执行审批")
    const instructionsHumanOffset = await commandCount()
    await startStage.click()
    await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor()
    assert.deepEqual((await latestCommands(instructionsHumanOffset)).map(call => call.kind), ["prepare"])
    assert.equal(await instructions.count(), 0)

    await reset("instructions-deferred")
    await instructions.fill("旧项目未提交的新要求")
    const instructionsDeferredOffset = await commandCount()
    await startStage.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    assert.equal(await startStage.isDisabled(), true)
    assert.deepEqual((await latestCommands(instructionsDeferredOffset)).map(call => call.kind), ["prepare"])
    await reset("instructions-other-project")
    await instructions.waitFor()
    await page.evaluate(() => (window as unknown as {fixture:{releasePrepare():void}}).fixture.releasePrepare())
    assert.equal(await instructions.inputValue(), "")
    assert.deepEqual((await latestCommands(instructionsDeferredOffset)).map(call => call.kind), ["prepare"])
    assert.equal(await continuous.isDisabled(), false)
    await instructions.fill("仅属于此失败操作")
    await page.evaluate(() => (window as unknown as {fixture:{changeOperation():void}}).fixture.changeOperation())
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('[aria-label="本次阶段补充说明（可选）"]') as HTMLTextAreaElement)?.value === "")
    await instructions.fill("仅属于此版本阶段")
    await page.evaluate(() => (window as unknown as {fixture:{changeStage():void}}).fixture.changeStage())
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('[aria-label="本次阶段补充说明（可选）"]') as HTMLTextAreaElement)?.value === "")
    await reset("instructions-empty")
    const emptyInstructionsOffset = await commandCount()
    await startStage.click()
    await page.getByText("正在执行", { exact: true }).waitFor()
    assert.equal("stageInstructions" in (await latestCommands(emptyInstructionsOffset))[0], false)
    await reset("retry")
    const feedback = page.getByRole("textbox", { name: "成果修改意见", exact: true })
    await feedback.fill("  保留中文与换行\n修正验证依据  ")
    assert.equal(await feedback.getAttribute("maxlength"), "4000")
    const retryOffset = await commandCount()
    await page.getByRole("button", { name: "拒绝当前成果", exact: true }).click()
    await page.getByLabel("已保存的修改意见", { exact: true }).waitFor()
    assert.equal(await feedback.getAttribute("readonly"), "")
    assert.match((await page.getByLabel("已保存的修改意见", { exact: true }).textContent())!, /保留中文与换行\n修正验证依据/)
    assert.deepEqual((await latestCommands(retryOffset)).map(call => call.kind), ["approve-result"])
    assert.equal((await latestCommands(retryOffset))[0].feedback, "保留中文与换行\n修正验证依据")
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.getByLabel("已保存的修改意见", { exact: true }).waitFor()
    await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).click()
    await page.getByText("正在执行", { exact: true }).waitFor()
    const retryCalls = await latestCommands(retryOffset)
    assert.deepEqual(retryCalls.map(call => call.kind), ["approve-result", "cancel", "prepare", "start"])
    assert.equal(retryCalls[1].operationId, "op")
    assert.ok(retryCalls[2].idempotencyKey)
    assert.equal(retryCalls[3].operationId, "retry-op")
    assert.equal(await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).count(), 0)

    await reset("retry-human")
    await feedback.fill("重新执行仍需确认")
    const humanOffset = await commandCount()
    await page.getByRole("button", { name: "拒绝当前成果", exact: true }).click()
    await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).click()
    await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor()
    assert.deepEqual((await latestCommands(humanOffset)).map(call => call.kind), ["approve-result", "cancel", "prepare"])

    await reset("retry-unknown")
    await feedback.fill("不得绕过未知结果")
    await page.getByRole("button", { name: "拒绝当前成果", exact: true }).click()
    const unknownOffset = await commandCount()
    await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).click()
    await page.getByRole("button", { name: "核对上次执行结果", exact: true }).waitFor()
    assert.deepEqual((await latestCommands(unknownOffset)).map(call => call.kind), ["cancel"])
    assert.equal(await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).count(), 0)

    await reset("retry-deferred")
    await feedback.fill("等待取消确认")
    await page.getByRole("button", { name: "拒绝当前成果", exact: true }).click()
    const deferredOffset = await commandCount()
    await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).isDisabled(), true)
    assert.deepEqual((await latestCommands(deferredOffset)).map(call => call.kind), ["cancel"])
    await reset("review") // Keyed project view remount must fence the old dependent prepare/start.
    await page.evaluate(() => (window as unknown as {fixture:{releaseCancel():void}}).fixture.releaseCancel())
    assert.equal(await feedback.inputValue(), "")
    assert.deepEqual((await latestCommands(deferredOffset)).map(call => call.kind), ["cancel"])
    await reset("review")
    await feedback.fill("只属于原操作")
    await page.evaluate(() => (window as unknown as {fixture:{changeOperation():void}}).fixture.changeOperation())
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('[aria-label="成果修改意见"]') as HTMLTextAreaElement)?.value === "")
    await feedback.fill("只属于原版本")
    await page.evaluate(() => (window as unknown as {fixture:{changeStage():void}}).fixture.changeStage())
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('[aria-label="成果修改意见"]') as HTMLTextAreaElement)?.value === "")
    await reset("stale")
    await page.getByText("成果或检查已变化，请重新核对后再审批。").waitFor()
    assert.equal(await page.getByRole("button", { name: "接受当前成果", exact: true }).isDisabled(), true)
    await reset("waiting")
    await page.getByText("此步骤正在等待你的回答，请打开阶段会话填写输入卡片。", { exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as {fixture:{answer():void}}).fixture.answer())
    await page.getByRole("button", { name: "继续已保存输入", exact: true }).click()
    await page.getByRole("button", { name: "接受当前成果", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "继续已保存输入", exact: true }).count(), 0)
    await reset("blocked")
    assert.equal(await instructions.count(), 0)
    await page.getByText("问题与已提交的回答均已保留，但此步骤存在尚未证明已结束的外部操作。请在原会话核对执行结果，当前不能自动续接或重跑。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "继续已保存输入", exact: true }).count(), 0)
    await reset("migration")
    await page.getByText("任务配置与版本", { exact: true }).click()
    await page.getByRole("button", { name: "检查是否可采用已安装插件的新步骤", exact: true }).click()
    await page.getByText("后续阶段：review → deliver", { exact: true }).waitFor()
    await page.getByRole("button", { name: "确认更新后续步骤", exact: true }).click()
    await page.getByText("固定模板版本：1.1.0。插件更新不会替换本任务的模板副本。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "确认更新后续步骤", exact: true }).count(), 0)
    await reset("import-wizard")
    await page.getByLabel("旧项目", { exact: true }).selectOption("old")
    await page.getByLabel("新插件", { exact: true }).selectOption("new")
    await page.getByLabel("新任务名称", { exact: true }).fill("导入文档")
    await page.getByLabel("任务目标", { exact: true }).fill("保留旧产物并重新核对")
    await page.getByRole("button", { name: "选择独立的新任务目录", exact: true }).click()
    await page.getByLabel("原产物 design", { exact: true }).fill("archive/design.json")
    await page.getByRole("button", { name: "核对导入方案", exact: true }).click()
    await page.getByRole("button", { name: "确认冻结并导入", exact: true }).waitFor()
    assert.equal(await page.getByLabel("新任务名称", { exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "确认冻结并导入", exact: true }).click()
    assert.equal(await instructions.count(), 0)
    assert.equal(await page.getByRole("button", { name: "开始执行", exact: true }).count(), 0)
    await page.getByRole("button", { name: "重新验证导入成果", exact: true }).click()
    await page.getByRole("button", { name: "接受当前成果", exact: true }).waitFor()
    const imports = await page.evaluate(() => (window as unknown as {fixture:{calls:Array<{kind:string;input?:{artifacts:unknown};review?:{artifacts:unknown}}>}}).fixture.calls.filter(call => call.kind.startsWith("import-") || call.kind === "validate-imported"))
    assert.deepEqual(imports.map(call => call.kind), ["import-review", "import-confirm", "validate-imported"])
    assert.deepEqual(imports[0].input?.artifacts, [{ artifactId: "design", sourcePath: "archive/design.json" }])
    assert.deepEqual(imports[1].review?.artifacts, imports[0].input?.artifacts)
    await page.getByRole("button", { name: "拒绝当前成果", exact: true }).click()
    await page.getByText("你已拒绝这版成果，流程尚未推进。").waitFor()
    assert.equal(await page.getByRole("button", { name: "按修改意见重新执行", exact: true }).count(), 0)
    await reset("import-adapter")
    await page.getByLabel("旧项目", { exact: true }).selectOption("old")
    await page.getByLabel("新插件", { exact: true }).selectOption("new")
    await page.getByLabel("特性编号", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("导入方式", { exact: true }).inputValue(), "legacy-documents")
    assert.equal(await page.getByLabel("原产物 design", { exact: true }).count(), 0)
    await page.getByLabel("新任务名称", { exact: true }).fill("重新执行旧材料")
    await page.getByLabel("任务目标", { exact: true }).fill("保留材料并生成新版产物")
    await page.getByRole("button", { name: "选择独立的新任务目录", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "核对导入方案", exact: true }).isDisabled(), true)
    await page.getByLabel("特性编号", { exact: true }).fill("feature-one")
    await page.getByRole("button", { name: "核对导入方案", exact: true }).click()
    await page.getByText("设计：重新执行技能并检查，通过后需人工确认", { exact: true }).waitFor()
    await page.getByRole("button", { name: "确认冻结并导入", exact: true }).click()
    await page.getByText("旧材料已保留。当前阶段需要重新执行技能并通过检查，再由你确认新成果；旧项目的完成状态不会自动沿用。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "重新验证导入成果", exact: true }).count(), 0)
    await page.getByRole("button", { name: "继续执行", exact: true }).click()
    await page.getByRole("button", { name: "接受当前成果", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "确认完成任务", exact: true }).count(), 0)
    const adapterCalls = await page.evaluate(() => (window as unknown as {fixture:{calls:Array<{kind:string;input?:Record<string,unknown>}>}}).fixture.calls)
    const adapterInput = adapterCalls.find(call => call.kind === "import-adapter-review")!.input!
    assert.deepEqual(adapterInput.parameters, { feature: "feature-one" })
    assert.equal(adapterInput.adapterId, "legacy-documents")
    assert.equal("prefixStageIds" in adapterInput, false)
    assert.equal("artifacts" in adapterInput, false)
    assert.equal("checkpoint" in adapterInput, false)
    assert.equal(adapterCalls.at(-1)?.kind, "start")
    await reset("import-resume")
    await page.getByLabel("旧项目", { exact: true }).selectOption("old")
    assert.equal(await page.getByRole("button", { name: "核对导入方案", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "核对并恢复上次导入", exact: true }).click()
    await page.getByRole("button", { name: "确认冻结并导入", exact: true }).waitFor()
    assert.equal(await page.getByLabel("新任务名称", { exact: true }).inputValue(), "重新执行旧材料")
    await page.getByRole("button", { name: "确认冻结并导入", exact: true }).click()
    const resumed = await page.evaluate(() => (window as unknown as {fixture:{calls:Array<{kind:string;review?:unknown}>}}).fixture.calls.filter(call => call.kind === "import-confirm"))
    assert.deepEqual(resumed.at(-1)?.review, resumed.at(-2)?.review)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "result-review-complete.png"), fullPage: true })
    writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: true, calls, errors }, null, 2))
    process.stdout.write("PASS native result review, failed-stage instructions, stale evidence, input resume, plan migration and legacy import UI\n")
  } finally {
    await browser.close()
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
