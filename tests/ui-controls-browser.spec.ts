/** Actual controls and current application CSS, including native keyboard and theme checks. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { ThemePreference } from "../src/renderer/src/lib/theme-preference"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/ui-controls-20261015")
  mkdirSync(output, { recursive: true })
  const file = (path: string) => JSON.stringify(join(renderer, path))
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {ConfigurationTargetPicker} from ${file("components/customize/ConfigurationTargetPicker.tsx")};
      import {ClawSourceSelector} from ${file("components/customize/ClawSourceSelector.tsx")};
      import {ClawComponentSelector} from ${file("components/customize/ClawComponentSelector.tsx")};
      import {Input} from ${file("components/ui/input.tsx")};
      import {Select,SelectTrigger,SelectContent,SelectItem,SelectValue} from ${file("components/ui/select.tsx")};
      import {applyThemePreference} from ${file("lib/theme-preference.ts")};
      import {useAppStore} from '@/lib/store';
      import {beginConfigurationTarget,readConfigurationTarget,useConfigurationTarget,useConfigurationDraft,captureConfigurationScope} from ${file("lib/configuration-target.ts")};
      window.api={};window.theme=applyThemePreference;
      beginConfigurationTarget({threadId:'a',workspace:'C:/alpha/very-long-project-folder-for-a-same-title-chat'});
      window.target=readConfigurationTarget;
      const src={name:'控件示例',digest:'a',components:[]};
      function Harness(){const threads=useAppStore(s=>s.threads),target=useConfigurationTarget();
        const [value,setValue]=useState({mode:'selected',items:[]}),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[locked,setLocked]=useState(false);
        const [cap,setCap]=useState({pluginId:'example',digest:'a',components:{mode:'selected',ids:[],config:{}}});
        useConfigurationDraft(target,dirty,busy);
        window.guard=()=>captureConfigurationScope(target);window.setBusy=setBusy;window.lock=setLocked;
        return <main className='mx-auto max-w-2xl space-y-4 p-4'>
          <ConfigurationTargetPicker threads={threads}/>
          <Input aria-label='共享输入' placeholder='填写内容' onChange={()=>setDirty(true)}/>
          <Input aria-label='只读输入' readOnly value='已确定的只读值'/><Input aria-label='禁用输入' disabled value='当前不可用'/>
          <Input aria-label='错误输入' aria-invalid='true' defaultValue='需要核对'/>
          <select aria-label='规范原生选择' className='devclaw-select w-full text-sm'><option>单值下拉</option><option>另一项</option></select>
          <Select defaultValue='one'><SelectTrigger aria-label='共享下拉'><SelectValue/></SelectTrigger><SelectContent><SelectItem value='one'>第一项</SelectItem><SelectItem value='two'>第二项</SelectItem></SelectContent></Select>
          <ClawSourceSelector title='技能' description='选择真实来源范围' entries={[{id:'one',name:'示例技能',digest:'a',owner:'本地'}]} value={value} disabled={locked} unavailable={false} onChange={setValue}/>
          <ClawComponentSelector source={src} value={cap} disabled={false} onChange={setCap} onValidity={()=>{}}/>
        </main>}
      createRoot(document.getElementById('root')).render(<Harness/>);
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": renderer }, plugins: [{ name: "local-store", setup(builder) {
      builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$)/ }, () => ({ path: "store", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", resolveDir: process.cwd(), contents: `
        import {useSyncExternalStore} from 'react';const listeners=new Set();
        const row=(id,path)=>({thread_id:id,title:'同名聊天',metadata:{workspacePath:path,agentMode:'normal'}});
        let state={currentThreadId:'a',showCustomizeView:true,threads:[row('a','C:/alpha/very-long-project-folder-for-a-same-title-chat'),row('b','C:/beta')]};
        window.patch=patch=>{state={...state,...patch};for(const fn of listeners)fn()};window.store=()=>state;window.row=row;
        export function useAppStore(select){const value=useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state);return select?select(value):value}
        useAppStore.getState=()=>state;
      ` }))
    } }]
  })
  const stylePath = join(renderer, "index.css")
  const styles = await compile(readFileSync(stylePath, "utf8"), { base: dirname(stylePath), onDependency() {
    // This single-use CSS fixture does not install dependency watchers.
  } })
  const candidates = new Scanner({}).scanFiles([ ...[
    "components/customize/ConfigurationTargetPicker.tsx", "components/customize/ClawSourceSelector.tsx",
    "components/customize/ClawComponentSelector.tsx", "components/ui/input.tsx", "components/ui/select.tsx",
    "components/ui/popover.tsx", "components/ui/button.tsx"
  ].map(path => ({ content: readFileSync(join(renderer, path), "utf8"), extension: "tsx" })), { content: "mx-auto max-w-2xl space-y-4 p-4 w-full text-sm", extension: "tsx" }])
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 860, height: 1100 } })
  const errors: string[] = [], checks: string[] = [], computed: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  const trigger = () => page.getByRole("combobox", { name: "配置目标聊天", exact: true })
  const choose = async (path: string) => { await trigger().click(); await page.getByRole("option", { name: `同名聊天 · ${path}`, exact: true }).click() }
  try {
    await page.goto("about:blank"); await page.setContent('<div id="root"></div>')
    await page.evaluate("window.__name=(value)=>value")
    await page.addStyleTag({ content: styles.build(candidates) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await trigger().waitFor()
    for (const theme of ["cmbdevclaw-white", "codex-dark"] as const) for (const width of [860, 375]) {
      await page.setViewportSize({ width, height: 1100 })
      await page.evaluate(value => (window as Window & { theme(value: ThemePreference): void }).theme(value), theme)
      await trigger().focus()
      const result = await trigger().evaluate(node => {
        const s = getComputedStyle(node), body = getComputedStyle(document.body)
        const rgb = (color: string) => { const c = document.createElement('canvas').getContext('2d')!; c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3) }
        const lum = (color: string) => rgb(color).map(x => x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0)
        const contrast = (a: string,b: string) => { const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
        return { background:s.backgroundColor,border:s.borderColor,body:body.backgroundColor,outline:s.outlineStyle,outlineWidth:s.outlineWidth,
          borderContrast:contrast(s.borderColor,s.backgroundColor),textContrast:contrast(s.color,s.backgroundColor),arrow:!!node.querySelector('svg'),width:node.getBoundingClientRect().width,scrollWidth:document.documentElement.scrollWidth }
      })
      assert.equal(result.outline, "solid"); assert.equal(result.outlineWidth, "2px")
      assert.equal(result.arrow, true); assert.ok(result.borderContrast >= 3, JSON.stringify(result)); assert.ok(result.textContrast >= 4.5)
      assert.ok(result.scrollWidth <= width); computed.push({ theme, viewportWidth: width, ...result })
      await page.screenshot({ path: join(output, `${theme}-${width}.png`), fullPage: true })
    }
    checks.push("current application CSS in light/dark at 860/375: explicit arrow, 2px focus, >=3 outline and >=4.5 text contrast, no page overflow")
    await trigger().focus(); await page.keyboard.press("ArrowDown")
    await page.getByRole("combobox", { name: "搜索配置聊天" }).fill("beta")
    assert.equal(await page.getByRole("listbox", { name: "为哪段聊天配置", exact: true }).getByRole("option").count(), 1)
    await page.keyboard.press("Enter")
    assert.equal(await page.evaluate("window.target().threadId"), "b")
    assert.equal(await page.evaluate("window.store().currentThreadId"), "a")
    await trigger().click(); await page.keyboard.press("Escape"); assert.equal(await trigger().evaluate(node => node === document.activeElement), true)
    const guard = await page.evaluate("window.oldGuard=window.guard();true"); assert.equal(guard, true)
    await choose("C:/alpha/very-long-project-folder-for-a-same-title-chat"); await choose("C:/beta")
    assert.equal(await page.evaluate("window.oldGuard()"), false)
    await page.getByLabel("共享输入", { exact: true }).fill("草稿")
    page.once("dialog", dialog => dialog.dismiss()); await choose("C:/alpha/very-long-project-folder-for-a-same-title-chat")
    assert.equal(await page.evaluate("window.target().threadId"), "b")
    await page.evaluate("window.setBusy(true)"); await choose("C:/alpha/very-long-project-folder-for-a-same-title-chat")
    await page.getByRole("alert").getByText(/当前操作尚未结束/).waitFor()
    await page.evaluate("window.setBusy(false);window.patch({threads:[window.row('a','C:/alpha/very-long-project-folder-for-a-same-title-chat')]})")
    assert.equal(await trigger().isEnabled(), true); await trigger().getByText("原配置聊天已不可用，请重新选择").waitFor()
    await page.evaluate("window.patch({threads:[]})"); assert.equal(await trigger().isDisabled(), true)
    assert.equal(await page.evaluate("window.target().threadId"), "b")
    checks.push("keyboard search/select/Escape return, no navigation, ABA guard, dirty cancel, busy rejection, stale target stays selectable and empty stays disabled without fallback")
    await page.evaluate("window.patch({threads:Array.from({length:1001},(_,i)=>window.row('candidate-'+i,'C:/candidate-'+i))})")
    await trigger().click()
    assert.equal(await page.getByRole("listbox", { name: "为哪段聊天配置", exact: true }).getByRole("option").count(), 100)
    await page.getByText("显示前 100 / 1001 项，请搜索名称或目录缩小范围。", { exact: true }).waitFor()
    await page.getByRole("combobox", { name: "搜索配置聊天" }).fill("candidate-1000")
    await page.getByRole("option", { name: "同名聊天 · C:/candidate-1000", exact: true }).waitFor()
    await page.screenshot({ path: join(output, "search-bounded-375.png"), fullPage: true })
    await page.keyboard.press("Escape")
    assert.equal(await page.evaluate("window.target().threadId"), "b")
    checks.push("1001 local candidates render at most 100; search reaches omitted rows without changing the invalid retained target")
    const search = page.getByRole("textbox", { name: "搜索技能" })
    await search.focus()
    assert.equal(await search.evaluate(node => getComputedStyle(node.parentElement!).outlineWidth), "2px")
    await page.getByRole("radio", { name: "使用全部已开启项", exact: true }).check()
    assert.equal(await page.getByRole("radio", { name: "使用全部已开启项", exact: true }).isChecked(), true)
    await page.getByRole("radio", { name: "仅使用所选", exact: true }).check()
    await page.evaluate("window.lock(true)"); assert.equal(await search.isDisabled(), true)
    const native = page.getByRole("combobox", { name: "规范原生选择" })
    assert.equal(await native.evaluate(node => getComputedStyle(node).appearance), "none")
    assert.match(await native.evaluate(node => getComputedStyle(node).backgroundImage), /data:image\/svg/)
    assert.equal(await page.getByLabel("只读输入").evaluate(node => getComputedStyle(node).borderStyle), "dashed")
    await page.getByLabel("共享输入", { exact: true }).focus()
    assert.equal(await page.getByLabel("共享输入", { exact: true }).evaluate(node => getComputedStyle(node).outlineWidth), "2px")
    assert.equal(await page.getByRole("combobox", { name: "组件范围 控件示例" }).evaluate(node => getComputedStyle(node).appearance), "none")
    await page.getByRole("combobox", { name: "共享下拉", exact: true }).focus(); await page.keyboard.press("ArrowDown")
    await page.getByRole("option", { name: "第二项", exact: true }).waitFor(); await page.keyboard.press("Escape")
    checks.push("source cards expose real checked radios; search focus-within and disabled states; shared native and Radix selects have visible arrows and keyboard popups; readonly input differentiated")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ passed: true, checks, computed, errors }, null, 2))
    console.log(JSON.stringify({ passed: true, checks }))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
    writeFileSync(join(output, "failure.html"), await page.content()); throw error
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
