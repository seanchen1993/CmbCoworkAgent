/** Real React forms and browser events; controlled IPC latency, no user or model data. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const renderer = join(root, "src/renderer/src")
  const output = join(root, "output/mods-config-browser")
  mkdirSync(output, { recursive: true })
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
      import {useState} from "react";
      import {createRoot} from "react-dom/client";
      import {FunctionUserConfig} from ${JSON.stringify(join(renderer, "components/customize/FunctionUserConfig.tsx"))};
      import {readDesktopSelection} from ${JSON.stringify(join(renderer, "lib/function-desktop.ts"))};
      import {beginConfigurationTarget,chooseConfigurationTarget} from ${JSON.stringify(join(renderer,"lib/configuration-target.ts"))};
      import {useAppStore} from ${JSON.stringify(join(renderer,"lib/store.ts"))};
      const listeners=new Set(),calls=[],secretCalls=[],applies=[],reloads=[],picks=[],migrations=[],savedSignals=[],approvals=[];let failRead=false,deferRead=false,deferSave=false,deny=false,rewrite,migrationMode='complete',deferMigration=false;
      const pendingReads=[],pendingSaves=[],pendingPicks=[],pendingSecretAcks=[];let deferSecretAck=false;
      const migrationReplies=[];
      let view={pluginId:'p',plugin:'sample',digest:'digest',workspace:'a',savedRevision:0,
        effectiveRevision:0,state:'applied',fields:[
        {key:'tone',label:'Tone',description:'Tone description',type:'string',supported:true,required:true,value:'warm',effectiveValue:'warm'},
        {key:'flag',label:'Flag',description:'Flag description',type:'boolean',supported:true,required:false,value:false,effectiveValue:false},
        {key:'budget',label:'Budget',description:'Budget description',type:'number',supported:true,required:false,min:0,max:10,value:0,effectiveValue:0},
        {key:'choice',label:'Choice',description:'Choice description',type:'string',supported:true,required:true,options:['one','two'],value:'one'},
        {key:'file',label:'File',description:'File description',type:'file',supported:false,required:false}
      ]};
      const clone=x=>JSON.parse(JSON.stringify(x));
      window.api={mods:{userConfig:async()=>{
        if(failRead)throw Error('read failed');const captured=clone(view);
        return deferRead?new Promise(resolve=>pendingReads.push(()=>resolve(captured))):captured;
      },saveUserConfig:async(thread,current,key,value)=>{
        calls.push({thread,current,key,value});
        const run=()=>{if(deny)throw Error('policy denied');
          view={...view,savedRevision:view.savedRevision+1,state:'pending',fields:view.fields.map(f=>f.key===key?{...f,value:rewrite??value}:f)};
          for(const fn of listeners)fn();const ack=clone(view);return rewrite===undefined?ack:new Promise(resolve=>setTimeout(()=>resolve(ack),60))};
        return deferSave?new Promise((resolve,reject)=>pendingSaves.push(()=>{try{resolve(run())}catch(e){reject(e)}})):run();
      },saveSensitiveUserConfig:async(thread,current,key,action)=>{
        secretCalls.push({thread,current,key,action});
        const run=()=>{if(deny)throw Error('policy denied');
          view={...view,savedRevision:view.savedRevision+1,state:'pending',fields:view.fields.map(f=>f.key===key?{...f,secretState:action.operation==='clear'?'default':'saved'}:f)};
          for(const fn of listeners)fn();const ack=clone(view);
          return deferSecretAck?new Promise(resolve=>pendingSecretAcks.push(()=>resolve(ack))):ack};
        return deferSave?new Promise((resolve,reject)=>pendingSaves.push(()=>{try{resolve(run())}catch(e){reject(e)}})):run();
      },pickUserConfigPath:async(thread,current,key)=>{
        picks.push({thread,current,key});return new Promise(resolve=>pendingPicks.push(resolve));
      },applyUserConfig:async(thread,current)=>{
        applies.push({thread,current});view={...view,state:'applied',effectiveRevision:view.savedRevision,error:undefined};
        for(const fn of listeners)fn();return clone(view);
      },reloadUserConfig:async(thread,current)=>{
        reloads.push({thread,current});view={...view,state:'applied',effectiveRevision:view.savedRevision,error:undefined};
        for(const fn of listeners)fn();return clone(view);
      },migrateUserConfig:async(thread,current)=>{
        migrations.push({thread,current:clone(current)});
        if(migrationMode==='fail')throw Error('migration rejected');
        const next=clone(current);
        if(migrationMode==='complete'){delete next.migration;next.savedRevision++}
        if(migrationMode==='cancel')next.migration.diagnostics=['本次迁移已取消，配置保留。'];
        if(deferMigration)return new Promise(resolve=>migrationReplies.push(()=>resolve(next)));
        view=next;for(const fn of listeners)fn();return clone(next);
      },approveFunction:async()=>{approvals.push('forbidden-approve');throw Error('NO_AUTOMATIC_APPROVAL')},
      onConfigurationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}};
      function Fixture(){const [thread,setThread]=useState('a'),[epoch,setEpoch]=useState(0),[mounted,setMounted]=useState(true);
        window.probe={calls,secretCalls,applies,reloads,thread:setThread,readFailure:value=>failRead=value,
          migrations,savedSignals,approvals,migrationReplies,mounted:setMounted,
          migrationScope:()=>{view={...view,workspace:'migration-b'};setThread('migration-b')},
          startMigration:(mode,delayed=false)=>{migrationMode=mode;deferMigration=delayed;failRead=false;deferRead=false;deferSave=false;deny=false;rewrite=undefined;savedSignals.length=0;
            view={pluginId:'p',plugin:'sample',digest:'migration-source',workspace:'migration-a',savedRevision:100,state:'inactive',
              migration:{fromVersion:1,toVersion:2,digest:'migration-plan',canApply:true,changes:[{kind:'rename',from:'oldSecret',to:'secret'}],diagnostics:[]},
              fields:[{key:'secret',label:'Migration secret',description:'Already stored; never resend',type:'string',sensitive:true,supported:true,required:false,secretState:'saved'}]};
            setThread('migration-a');setMounted(true);setEpoch(value=>value+1)},
          beginTarget:()=>{useAppStore.setState({showCustomizeView:true,currentThreadId:'a',threads:['a','b'].map(id=>({thread_id:id,title:id,metadata:{workspacePath:id,agentMode:'normal'}}))});window.closeTarget=beginConfigurationTarget({threadId:'a',workspace:'a'})},chooseTarget:()=>chooseConfigurationTarget({threadId:'b',workspace:'b'}),closeTarget:()=>window.closeTarget(),
          readDelay:value=>deferRead=value,saveDelay:value=>deferSave=value,deny:value=>deny=value,
          reads:pendingReads,saves:pendingSaves,view:()=>view,
          picks,pickResults:pendingPicks,rewrite:value=>rewrite=value,listenerCount:()=>listeners.size,
          secretAckDelay:value=>deferSecretAck=value,secretAcks:pendingSecretAcks,
          selection:()=>readDesktopSelection([document.querySelector('main')])?.text,
          change:patch=>{view={...view,...patch};for(const fn of listeners)fn()}};
        return <main style={{width:360,margin:24}}><span id='selection-before'>Before parameters</span>{mounted&&<FunctionUserConfig key={epoch} threadId={thread} pluginId='p' onSaved={()=>savedSignals.push({thread})}/>}<span id='selection-after'>After parameters</span></main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 460, height: 1050 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent("<div id='root'></div>")
    const assets = join(root, "out/renderer/assets")
    const css = existsSync(assets)
      ? readdirSync(assets).find((file) => /^index-.*\.css$/.test(file))
      : undefined
    if (css) await page.addStyleTag({ content: readFileSync(join(assets, css), "utf8") })
    await page.addScriptTag({ content: result.outputFiles[0].text })
    await page.getByText("插件参数", { exact: true }).click()
    await page.getByLabel("Tone").waitFor()
    assert.equal(await page.getByLabel("Flag").getAttribute("aria-checked"), "false")
    assert.equal(await page.getByLabel("Budget").inputValue(), "0")
    assert.equal(await page.getByLabel("Choice").inputValue(), "one")
    assert.equal(await page.getByText("此参数需要专用输入，普通参数表单暂不处理。").count(), 1)
    console.log("PASS real ordinary defaults, choices and mixed file schema")
    const row = (label: string) =>
      page.getByLabel(new RegExp("^" + label + "(?: · 必填)?$")).locator("xpath=../..")
    await page.getByLabel("Tone").fill("")
    await row("Tone").getByRole("button").click()
    await page.getByRole("alert").filter({ hasText: "请填写" }).waitFor()
    assert.equal(await page.evaluate("window.probe.calls.length"), 0)
    await page.getByLabel("Budget").fill("11")
    await row("Budget").getByRole("button").click()
    await page.getByRole("alert").filter({ hasText: "超出" }).waitFor()
    assert.equal(await page.evaluate("window.probe.calls.length"), 0)
    console.log("PASS required and range validation perform zero writes")
    await page.getByLabel("Tone").fill("my draft")
    await page.evaluate("window.probe.change({savedRevision:1})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(await page.getByLabel("Tone").inputValue(), "my draft")
    await row("Tone").getByRole("button").click()
    await page.getByRole("status").filter({ hasText: "已保存，等待应用到当前聊天" }).waitFor()
    assert.equal(await page.evaluate("window.probe.calls.at(-1).current.savedRevision"), 1)
    assert.equal(await page.getByLabel("Tone").inputValue(), "my draft")
    console.log("PASS live changes retain dirty drafts and save the actual observed revision")
    await page.evaluate("window.probe.deny(true);window.probe.saveDelay(true)")
    await page.getByLabel("Tone").fill("denied draft")
    await row("Tone").getByRole("button").click()
    await page.evaluate("window.probe.change({savedRevision:3});window.probe.saves.shift()()")
    await page.getByRole("alert").filter({ hasText: "policy denied" }).waitFor()
    assert.equal(await page.getByLabel("Tone").inputValue(), "denied draft")
    console.log("PASS unrelated refresh cannot suppress an actual denied save ACK")
    await page.evaluate(
      "window.probe.deny(false);window.probe.saveDelay(false);window.probe.readDelay(true)"
    )
    await page.evaluate("window.probe.change({savedRevision:4})")
    await page.waitForFunction("window.probe.reads.length===1")
    await page.evaluate("window.probe.change({savedRevision:5})")
    await page.waitForFunction("window.probe.reads.length===2")
    await page.evaluate(
      "window.probe.reads.pop()();window.probe.reads.shift()();window.probe.readDelay(false)"
    )
    await page.waitForFunction("!document.querySelector('input').disabled")
    await row("Tone").getByRole("button").click()
    await page.waitForFunction("window.probe.calls.at(-1).current.savedRevision===5")
    console.log("PASS older read replies cannot replace a newer configuration")
    await page.evaluate("window.probe.change({state:'failed',error:'startup failed'})")
    await page.getByRole("button", { name: "重试应用", exact: true }).waitFor()
    await page.waitForFunction("!document.querySelector('input').disabled")
    await page.getByLabel("Tone").fill("keep retry draft")
    await page.getByRole("button", { name: "重试应用", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "当前对话已应用" }).waitFor()
    assert.equal(await page.getByLabel("Tone").inputValue(), "keep retry draft")
    assert.equal(await page.evaluate("window.probe.applies.at(-1).current.savedRevision"), 6)
    console.log(
      "PASS explicit application retry keeps dirty drafts and uses the exact saved revision"
    )
    await page.evaluate("window.probe.change({state:'stopped',error:'backend close rejected'})")
    await page.getByRole("status").filter({ hasText: "当前组合已停止" }).waitFor()
    await page.waitForFunction("!document.querySelector('input').disabled")
    await page.getByRole("button", { name: "重新加载当前组合", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "当前对话已应用" }).waitFor()
    assert.equal(await page.getByLabel("Tone").inputValue(), "keep retry draft")
    assert.equal(await page.evaluate("window.probe.reloads.at(-1).current.savedRevision"), 6)
    console.log(
      "PASS stopped explains the restart scope and explicit reload preserves an unsaved draft"
    )
    await page.screenshot({ path: join(output, "parameter-form.png"), fullPage: true })
    assert.equal(
      await page.evaluate("document.documentElement.scrollWidth>window.innerWidth"),
      false
    )
    await page.evaluate(`window.probe.change({state:'applied',fields:[
      ...window.probe.view().fields.filter(f=>f.key!=='file'),
      {key:'file',label:'File',description:'A path, without additional file access',type:'file',supported:true,required:false,value:''},
      {key:'directory',label:'Directory',description:'A directory path',type:'directory',supported:true,required:false,value:''},
      {key:'list',label:'List',description:'Each item stays intact',type:'string',multiple:true,supported:true,required:false,value:['a,b','c\\nd']},
      {key:'legacy',label:'Legacy',description:'Existing scalar stays unchanged until save',type:'string',multiple:true,supported:true,required:false,value:'x,y\\nz'}
    ]})`)
    await page.getByLabel("List 第 2 项", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("Legacy 第 1 项", { exact: true }).inputValue(), "x,y\nz")
    assert.equal(await page.getByText("现有值是单个文本；点击保存后才改为列表。").count(), 1)
    const listRow = page.locator('[data-config-list="list"]').locator("xpath=../..")
    await page.getByLabel("List 第 1 项", { exact: true }).fill("keep,comma\nand newline")
    await listRow.getByRole("button", { name: "添加一项", exact: true }).click()
    await listRow.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction("window.probe.calls.at(-1).key==='list'")
    assert.deepEqual(await page.evaluate("window.probe.calls.at(-1).value"), [
      "keep,comma\nand newline",
      "c\nd",
      ""
    ])
    await page.getByRole("button", { name: "删除List第 2 项", exact: true }).click()
    await page.evaluate("window.probe.change({savedRevision:8})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(await page.getByLabel("List 第 2 项", { exact: true }).inputValue(), "")
    assert.equal(await page.getByLabel("List 第 3 项", { exact: true }).count(), 0)
    console.log(
      "PASS real list add/delete, comma/newline/empty preservation and dirty refresh; legacy scalar is not split"
    )

    const fileRow = row("File")
    const pickFile = () => fileRow.getByRole("button", { name: /选择文件|正在选择/ }).click()
    await pickFile()
    await page.evaluate("window.probe.beginTarget()")
    assert.equal(await page.evaluate("window.probe.chooseTarget()"),"当前操作尚未结束，请稍后切换配置聊天。",
      "an outstanding native path chooser must block target changes")
    await page.evaluate("window.probe.closeTarget()")
    const writes = await page.evaluate("window.probe.calls.length")
    await page.evaluate("window.probe.pickResults.shift()('selected-file')")
    await page.waitForFunction(
      "document.getElementById('plugin-param-p-file').value==='selected-file'"
    )
    assert.equal(await page.evaluate("window.probe.calls.length"), writes)
    await pickFile()
    await page.getByLabel("File", { exact: true }).fill("changed")
    await page.getByLabel("File", { exact: true }).fill("selected-file")
    await page.evaluate("window.probe.pickResults.shift()('stale-aba')")
    await page.getByRole("button", { name: "选择文件", exact: true }).waitFor()
    assert.equal(await page.getByLabel("File", { exact: true }).inputValue(), "selected-file")
    await pickFile()
    await pickFile()
    await page.evaluate(
      "window.probe.pickResults.pop()('second');window.probe.pickResults.shift()('first')"
    )
    await page.waitForFunction("document.getElementById('plugin-param-p-file').value==='second'")
    console.log(
      "PASS path choice only changes a draft; manual ABA and reversed picker replies cannot overwrite it"
    )
    await pickFile()
    await page.evaluate("window.probe.change({savedRevision:9})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    await page.evaluate("window.probe.pickResults.shift()('stale-revision')")
    await page.getByRole("button", { name: "选择文件", exact: true }).waitFor()
    assert.equal(await page.getByLabel("File", { exact: true }).inputValue(), "second")
    await pickFile()
    await page.getByText("插件参数", { exact: true }).click()
    await page.getByText("插件参数", { exact: true }).click()
    await page.getByRole("button", { name: "选择文件", exact: true }).waitFor()
    await page.evaluate("window.probe.pickResults.shift()('closed-picker')")
    assert.equal(await page.getByLabel("File", { exact: true }).inputValue(), "")
    console.log("PASS configuration broadcast and close/reopen discard old chooser results")

    await page.getByLabel("List 第 1 项", { exact: true }).fill("unsaved list")
    await page.getByLabel("File", { exact: true }).fill("submitted A")
    await page.evaluate("window.probe.rewrite('committed B')")
    await fileRow.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(await page.getByLabel("File", { exact: true }).inputValue(), "committed B")
    assert.equal(
      await page.getByLabel("List 第 1 项", { exact: true }).inputValue(),
      "unsaved list"
    )
    await page.evaluate("window.probe.rewrite(undefined)")
    console.log(
      "PASS rewritten save ACK after its broadcast adopts the committed value and retains other unsaved fields"
    )
    await page.screenshot({ path: join(output, "special-parameter-form.png"), fullPage: true })
    assert.equal(
      await page.evaluate("document.documentElement.scrollWidth>window.innerWidth"),
      false
    )
    await row("Directory").getByRole("button", { name: "选择目录", exact: true }).click()
    await page.evaluate("window.probe.change({workspace:'b'})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    await page.evaluate("window.probe.pickResults.shift()('previous-workspace')")
    assert.equal(await page.getByLabel("Directory", { exact: true }).inputValue(), "")
    console.log("PASS same-plugin workspace change cannot inherit an old path choice")

    await page.evaluate(`window.probe.change({state:'applied',fields:[
      ...window.probe.view().fields,
      {key:'secret',label:'Secret',description:'Private author parameter',type:'string',sensitive:true,supported:true,required:false,secretState:'saved'},
      {key:'secretBool',label:'Secret bool',description:'Private boolean',type:'boolean',sensitive:true,supported:true,required:false,secretState:'unset'},
      {key:'secretNumber',label:'Secret number',description:'Private number',type:'number',sensitive:true,supported:true,required:false,secretState:'unset'},
      {key:'secretList',label:'Secret list',description:'Private items',type:'string',multiple:true,sensitive:true,supported:true,required:false,secretState:'saved'}
    ]})`)
    const secret = page.getByLabel("Secret", { exact: true })
    const secretRow = row("Secret")
    const saveSecret = secretRow.getByRole("button", { name: "保存", exact: true })
    await secret.waitFor()
    assert.equal(await secret.inputValue(), "")
    assert.equal(await secret.getAttribute("type"), "password")
    assert.equal(await secret.getAttribute("autocomplete"), "new-password")
    assert(await saveSecret.isDisabled())
    await secret.fill("discard this draft")
    assert(await saveSecret.isEnabled())
    await page.getByText("插件参数", { exact: true }).click()
    await page.waitForFunction("window.probe.listenerCount()===0")
    await page.getByText("插件参数", { exact: true }).click()
    await page.waitForFunction(
      "document.getElementById('plugin-param-p-secret').value===''&&!document.querySelector('input').disabled"
    )
    assert.equal(await secret.inputValue(), "")
    assert(await saveSecret.isDisabled())
    assert.equal(await page.evaluate("window.probe.secretCalls.length"), 0)
    console.log(
      "PASS protected fields are masked and close/reopen cannot save an untouched empty replacement"
    )

    await secret.fill("explicit empty")
    await secret.fill("")
    await page.evaluate("window.probe.change({savedRevision:20})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert(await saveSecret.isEnabled())
    await saveSecret.click()
    await page.waitForFunction(
      "window.probe.secretCalls.length===1&&!document.querySelector('input').disabled"
    )
    assert.deepEqual(await page.evaluate("window.probe.secretCalls.at(-1).action"), {
      operation: "set",
      value: ""
    })
    assert(await saveSecret.isDisabled())
    await secretRow.getByRole("button", { name: "清除已保存值", exact: true }).click()
    await page.waitForFunction(
      "window.probe.secretCalls.length===2&&!document.querySelector('input').disabled"
    )
    assert.deepEqual(await page.evaluate("window.probe.secretCalls.at(-1).action"), {
      operation: "clear"
    })
    console.log(
      "PASS deliberate empty replacement survives a broadcast and explicit clear carries no secret value"
    )

    await page.getByLabel("Secret bool", { exact: true }).selectOption("false")
    await row("Secret bool").getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(
      "window.probe.secretCalls.length===3&&!document.querySelector('input').disabled"
    )
    assert.deepEqual(await page.evaluate("window.probe.secretCalls.at(-1).action"), {
      operation: "set",
      value: false
    })
    await page.getByLabel("Secret number", { exact: true }).fill("0")
    await row("Secret number").getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(
      "window.probe.secretCalls.length===4&&!document.querySelector('input').disabled"
    )
    assert.deepEqual(await page.evaluate("window.probe.secretCalls.at(-1).action"), {
      operation: "set",
      value: 0
    })
    const secretList = page.locator('[data-config-list="secretList"]').locator("xpath=../..")
    await secretList.getByRole("button", { name: "添加一项", exact: true }).click()
    const privateItem = page.getByLabel("Secret list 第 1 项", { exact: true })
    await privateItem.fill("private,comma\nand newline")
    assert.equal(
      await privateItem.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-text-security")
      ),
      "disc"
    )
    const selection = await page.evaluate(() => {
      const range = document.createRange()
      range.setStart(document.getElementById("selection-before")!.firstChild!, 0)
      range.setEnd(document.getElementById("selection-after")!.firstChild!, 16)
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      return (window as unknown as { probe: { selection(): string | undefined } }).probe.selection()
    })
    assert.equal(selection, undefined)
    for (const mode of ["hidden", "inert", "closed"]) {
      const hiddenSelection = await page.evaluate(mode => {
        const form = document.querySelector<HTMLDetailsElement>("details")!
        if (mode === "hidden") form.hidden = true
        if (mode === "inert") form.inert = true
        if (mode === "closed") form.open = false
        const result = (window as unknown as { probe: { selection(): string | undefined } }).probe.selection()
        form.hidden = false
        form.inert = false
        if (mode === "closed") form.open = true
        return result
      }, mode)
      assert.equal(hiddenSelection, undefined)
    }
    console.log(
      "PASS visible/hidden/inert/closed parameter regions reject the whole real DOM selection range"
    )
    await page.evaluate(() => document.getSelection()?.removeAllRanges())
    await page.screenshot({ path: join(output, "sensitive-parameter-form.png"), fullPage: true })
    await secretList.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(
      "window.probe.secretCalls.length===5&&!document.querySelector('input').disabled"
    )
    assert.deepEqual(await page.evaluate("window.probe.secretCalls.at(-1).action"), {
      operation: "set",
      value: ["private,comma\nand newline"]
    })
    assert.equal(await privateItem.count(), 0)
    await secretList.getByRole("button", { name: "添加一项", exact: true }).click()
    await page.getByRole("button", { name: "删除Secret list第 1 项", exact: true }).click()
    await page.evaluate("window.probe.change({savedRevision:30})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert(await secretList.getByRole("button", { name: "保存", exact: true }).isEnabled())
    await secretList.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(
      "window.probe.secretCalls.length===6&&!document.querySelector('input').disabled"
    )
    assert.deepEqual(await page.evaluate("window.probe.secretCalls.at(-1).action"), {
      operation: "set",
      value: []
    })
    console.log(
      "PASS protected false/zero/list values, multiline masking and deliberate empty arrays retain their meaning"
    )

    await page.evaluate("window.probe.secretAckDelay(true)")
    await secret.fill("successfully committed private")
    await saveSecret.click()
    await page.waitForFunction("window.probe.secretAcks.length===1")
    await page.evaluate(
      "window.api.mods.saveUserConfig('a',window.probe.view(),'tone','externally committed ordinary')"
    )
    await page.waitForFunction(
      "document.getElementById('plugin-param-p-tone').value==='externally committed ordinary'"
    )
    await page.evaluate("window.probe.secretAcks.shift()();window.probe.secretAckDelay(false)")
    await page.waitForFunction(
      "document.getElementById('plugin-param-p-secret').value===''&&!document.querySelector('input').disabled"
    )
    assert(await saveSecret.isDisabled())
    const newerRevision = await page.evaluate("window.probe.view().savedRevision")
    await secret.fill("next private")
    await saveSecret.click()
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(
      await page.evaluate("window.probe.secretCalls.at(-1).current.savedRevision"),
      newerRevision
    )
    console.log(
      "PASS an older successful secret ACK clears only its confirmed draft and keeps the newer saved revision"
    )

    await page.getByLabel("Tone").fill("unrelated unsaved draft")
    await page.evaluate("window.probe.saveDelay(true)")
    await secret.fill("submitted private")
    await saveSecret.click()
    await page.getByText("插件参数", { exact: true }).click()
    await page.waitForFunction("window.probe.listenerCount()===0")
    await page.getByText("插件参数", { exact: true }).click()
    await page.waitForFunction("!document.querySelector('input').disabled")
    await secret.fill("new private draft")
    await page.getByLabel("Tone").fill("other new draft")
    await page.evaluate("window.probe.saves.shift()();window.probe.saveDelay(false)")
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(await secret.inputValue(), "new private draft")
    assert.equal(await page.getByLabel("Tone").inputValue(), "other new draft")
    assert(await saveSecret.isEnabled())
    console.log(
      "PASS a late protected save reply after close/reopen cannot erase newly typed secrets or other drafts"
    )

    await page.evaluate(
      "window.probe.change({fields:window.probe.view().fields.map(f=>f.sensitive?{...f,supported:false,secretState:'unavailable'}:f)})"
    )
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(await secret.count(), 0)
    await page.getByLabel("Tone").fill("ordinary remains editable")
    assert(await row("Tone").getByRole("button", { name: "保存", exact: true }).isEnabled())
    assert.equal(
      await page.evaluate("document.documentElement.scrollWidth>window.innerWidth"),
      false
    )
    console.log(
      "PASS unavailable secure storage explains the restriction while ordinary fields remain usable"
    )
    await page.evaluate("window.probe.readFailure(true);window.probe.thread('b')")
    await page.getByText("插件参数", { exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "read failed" }).waitFor()
    assert.equal(await page.getByLabel("Tone").count(), 0)
    assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0)
    console.log("PASS switching threads and a failed new read never expose the previous draft")
    const writesBeforeMigration = await page.evaluate("window.probe.calls.length")
    const secretsBeforeMigration = await page.evaluate("window.probe.secretCalls.length")
    const beginMigration = async (mode: string, delayed = false) => {
      await page.evaluate(
        ({ mode, delayed }) =>
          window.eval(
            "window.probe.startMigration(" +
              JSON.stringify(mode) +
              "," +
              JSON.stringify(delayed) +
              ")"
          ),
        { mode, delayed }
      )
      await page.getByText("插件参数", { exact: true }).click()
      const migrate = page.getByRole("button", { name: "核对并迁移配置", exact: true })
      await migrate.waitFor()
      assert.equal(await migrate.isEnabled(), true)
      assert.equal(await page.getByLabel("Migration secret", { exact: true }).inputValue(), "")
      return migrate
    }
    const migrate = await beginMigration("complete")
    await migrate.click()
    await page.waitForFunction("window.probe.savedSignals.length===1")
    assert.deepEqual(await page.evaluate("window.probe.savedSignals"), [{ thread: "migration-a" }])
    assert.equal(await page.getByRole("status", { name: "插件配置迁移", exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate("window.probe.migrations.at(-1)"), {
      thread: "migration-a",
      current: {
        pluginId: "p",
        plugin: "sample",
        digest: "migration-source",
        workspace: "migration-a",
        savedRevision: 100,
        state: "inactive",
        migration: {
          fromVersion: 1,
          toVersion: 2,
          digest: "migration-plan",
          canApply: true,
          changes: [{ kind: "rename", from: "oldSecret", to: "secret" }],
          diagnostics: []
        },
        fields: [
          {
            key: "secret",
            label: "Migration secret",
            description: "Already stored; never resend",
            type: "string",
            sensitive: true,
            supported: true,
            required: false,
            secretState: "saved"
          }
        ]
      }
    })
    await page.evaluate("window.probe.change({savedRevision:102})")
    await page.waitForFunction("!document.querySelector('input').disabled")
    assert.equal(
      await page.evaluate("window.probe.savedSignals.length"),
      1,
      "The migration ACK resumes its parent once; ordinary readback cannot replay that callback"
    )
    assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true)
    console.log(
      "PASS completed migration resumes its parent once without resending a stored secret"
    )

    for (const mode of ["cancel", "remain", "fail"]) {
      const action = await beginMigration(mode)
      await action.click()
      if (mode === "fail")
        await page.getByRole("alert").filter({ hasText: "migration rejected" }).waitFor()
      else if (mode === "cancel")
        await page.getByText("本次迁移已取消，配置保留。", { exact: true }).waitFor()
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "核对并迁移配置" && !button.disabled
        )
      )
      assert.equal(
        await page.evaluate("window.probe.savedSignals.length"),
        0,
        `${mode}: incomplete or denied migration must not resume plugin use`
      )
      assert.equal(await page.getByRole("status", { name: "插件配置迁移", exact: true }).count(), 1)
    }
    console.log("PASS cancelled, still-pending and rejected migration results never report saved")

    for (const invalidation of ["scope", "unmount"]) {
      const action = await beginMigration("complete", true)
      await action.click()
      await page.waitForFunction("window.probe.migrationReplies.length===1")
      if (invalidation === "scope") {
        await page.evaluate("window.probe.migrationScope()")
        await page.getByText("插件参数", { exact: true }).click()
        await page.getByLabel("Migration secret", { exact: true }).waitFor()
      } else {
        await page.evaluate("window.probe.mounted(false)")
        await page.locator("[data-function-user-config]").waitFor({ state: "detached" })
      }
      await page.evaluate("window.probe.migrationReplies.shift()()")
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      assert.equal(
        await page.evaluate("window.probe.savedSignals.length"),
        0,
        `${invalidation}: a late ACK cannot resume a different or removed configuration editor`
      )
    }
    assert.equal(await page.evaluate("window.probe.calls.length"), writesBeforeMigration)
    assert.equal(await page.evaluate("window.probe.secretCalls.length"), secretsBeforeMigration)
    assert.equal(await page.evaluate("window.probe.approvals.length"), 0)
    console.log(
      "PASS late migration ACKs after scope changes/unmount cannot resume, save secrets or approve"
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
