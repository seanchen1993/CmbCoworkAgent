/** Browser-only API fixture; real SQLite/CAS and trusted IPC have separate tests. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output", "mods-harness-20261009", `authoring-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const source = resolve("src/renderer/src/components/customize/ModCreator.tsx")
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {ModCreator} from ${JSON.stringify(source)};
    const host=createRoot(document.getElementById('root')),calls=[],rows=new Map();let failSave=false,deferRead=false,readFinish;
    const bundle=text=>({schemaVersion:1,digest:'a'.repeat(64),files:[{path:'plugin.json',text:'{}'},{path:'mods/main.ts',text} ]});
    const doc=(thread,id,name,revision,source,versions)=>({workspace:thread,id,name,revision,currentRevision:revision,source,updatedAt:1,versions});
    window.api={mods:{authoring:{
      list:async thread=>{calls.push(['list',thread]);return {workspace:thread,drafts:[...rows.values()].filter(v=>v.workspace===thread).map(({id,name,currentRevision,updatedAt})=>({id,name,currentRevision,updatedAt}))}},
      generate:async input=>{calls.push(['generate',input]);return bundle(input.instruction)},
      prune:async input=>{calls.push(['prune',input]);const key=input.expectedWorkspace+input.id,prior=rows.get(key);const value={...prior,versions:prior.versions.slice(-2)};rows.set(key,value);return value},
      remove:async input=>{calls.push(['remove',input]);rows.delete(input.expectedWorkspace+input.id)},
      read:input=>{calls.push(['read',input]);const current=rows.get(input.expectedWorkspace+input.id),v=input.revision??current.currentRevision;const value={...current,revision:v,source:current.history[v-1]};return deferRead?new Promise(resolve=>{readFinish=()=>resolve(value)}):Promise.resolve(value)},
      save:async input=>{calls.push(['save',structuredClone(input)]);if(failSave)throw Error('AUTHORING_VERSION_CHANGED PRIVATE_SECRET');const prior=rows.get(input.expectedWorkspace+input.id),version=(prior?.currentRevision??0)+1;
        const source={schemaVersion:1,digest:'b'.repeat(64),files:input.files},history=[...(prior?.history??[]),source],versions=history.map((s,i)=>({revision:i+1,createdAt:1,digest:s.digest}));
        const value={...doc(input.expectedWorkspace,input.id,input.name,version,source,versions),history};rows.set(input.expectedWorkspace+input.id,value);return value},
      restore:async input=>{calls.push(['restore',input]);const prior=rows.get(input.expectedWorkspace+input.id),source=prior.history[input.sourceRevision-1],revision=prior.currentRevision+1;
        const value={...prior,revision,currentRevision:revision,source,history:[...prior.history,source],versions:[...prior.versions,{revision,createdAt:1,digest:source.digest,restoredFrom:input.sourceRevision}]};rows.set(input.expectedWorkspace+input.id,value);return value}
    }}};
    window.creatorFixture={calls,show:thread=>host.render(<ModCreator threadId={thread}/>),conflict:value=>failSave=value,defer:()=>deferRead=true,finish:()=>readFinish()};window.creatorFixture.show('a');
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    loader: { ".png": "dataurl", ".md": "text" },
    format: "iife",
    jsx: "automatic",
    plugins: [{
      name: "authoring-library-boundaries",
      setup(builder) {
        // This fixture exercises the actual draft editor, not the separately tested chat workspace.
        builder.onResolve({ filter: /^\.\/ModsDevelopmentPanel$/ }, (args) => args.importer.endsWith("ModCreator.tsx") ? { path: "panel", namespace: "authoring-boundary" } : undefined)
        builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({ path: "store", namespace: "authoring-boundary" }))
        builder.onLoad({ filter: /.*/, namespace: "authoring-boundary" }, (args) => ({ loader: "js", contents: args.path === "panel" ? 'export function ModsDevelopmentPanel(){return null}' : 'export const useAppStore=Object.assign((selector)=>selector?selector({threads:[]}):({threads:[]}),{getState:()=>({threads:[]})})' }))
      }
    }],
    define: { "process.env.NODE_ENV": '"development"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const checks: string[] = [],
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: result.outputFiles[0].text })
    const css = readdirSync(resolve("out/renderer/assets")).find((name) =>
      /^index-.*\.css$/.test(name)
    )
    if (css) await page.addStyleTag({ path: resolve("out/renderer/assets", css) })
    await page.getByRole("button", { name: "打开草稿库" }).waitFor()
    assert.deepEqual(await page.evaluate("window.creatorFixture.calls"), [])
    await page.getByRole("button", { name: "打开草稿库" }).click()
    await page.getByRole("button", { name: "新建草稿" }).click()
    assert.equal(await page.getByLabel("组件模板").locator("option").count(), 6)
    await page.getByLabel("组件模板").selectOption({ label: "状态决策骨架（未迁移）" })
    await page.getByLabel("草稿标识").fill("example")
    await page.getByLabel("草稿名称").fill("Example")
    await page.getByLabel("用途说明").fill("原始说明")
    await page.getByRole("button", { name: "生成模板源码" }).click()
    assert.equal(await page.evaluate("window.creatorFixture.calls.find(c=>c[0]==='generate')[1].kind"), "state-extension")
    await page.getByLabel("源码文件").selectOption("mods/main.ts")
    await page.getByLabel("文件源码").fill("const exact = '编辑源码'\n")
    await page
      .getByRole("button", { name: "保存源码版本" })
      .evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
    await page.getByText("已保存源码 v1，未安装、未应用。", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.creatorFixture.calls.filter(c=>c[0]==='save').length"),
      1
    )
    assert.equal(
      await page.evaluate(
        "window.creatorFixture.calls.filter(c=>c[0]==='save')[0][1].files[1].text"
      ),
      "const exact = '编辑源码'\n"
    )
    checks.push("Six templates include an explicitly unmigrated state scaffold; generation stays source-only")
    await page.getByLabel("源码文件").selectOption("mods/main.ts")
    await page.getByLabel("文件源码").fill("version two")
    await page.getByRole("button", { name: "保存源码版本" }).click()
    await page.getByText("已保存源码 v2，未安装、未应用。", { exact: true }).waitFor()
    await page.getByLabel("比较历史版本").selectOption("1")
    await page
      .getByText("v1 → 当前编辑：1 个文件变化。左侧为历史源码，右侧为当前编辑。", { exact: true })
      .waitFor()
    await page.getByText("mods/main.ts", { exact: true }).last().click()
    assert.equal(
      await page.getByLabel("mods/main.ts 历史源码").textContent(),
      "const exact = '编辑源码'\n"
    )
    await page.screenshot({ path: join(output, "authoring-desktop.png"), fullPage: true })
    await page.getByRole("button", { name: "将 v1 还原为新版本" }).click()
    await page.getByText("已还原为新版本 v3，未安装、未应用。", { exact: true }).waitFor()
    checks.push(
      "Historical source is fetched on demand, compared exactly and restored as a new version"
    )
    await page.getByLabel("源码文件").selectOption("mods/main.ts")
    await page.getByLabel("文件源码").fill("unsaved after conflict")
    await page.evaluate("window.creatorFixture.conflict(true)")
    await page.getByRole("button", { name: "保存源码版本" }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByLabel("文件源码").inputValue(), "unsaved after conflict")
    assert.equal((await page.locator("body").innerText()).includes("PRIVATE_SECRET"), false)
    checks.push("CAS conflicts retain local edits and show a fixed public message")
    await page.getByText("管理源码历史与草稿容量", { exact: true }).click()
    page.once("dialog", dialog => dialog.dismiss())
    await page.getByRole("button", { name: "清理旧源码历史", exact: true }).click()
    assert.equal(await page.evaluate("window.creatorFixture.calls.filter(c=>c[0]==='prune').length"), 0)
    page.once("dialog", dialog => dialog.accept())
    await page.getByRole("button", { name: "清理旧源码历史", exact: true }).click()
    await page.getByText("旧源码历史已清理，保留最近两个版本和当前未保存编辑；可以继续保存。", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("文件源码").inputValue(), "unsaved after conflict")
    assert.equal(await page.getByLabel("比较历史版本").locator("option").count(), 3)
    assert.equal(await page.evaluate("window.creatorFixture.calls.find(c=>c[0]==='prune')[1].acknowledgeHistoryLoss"), true)
    checks.push("Explicit history cleanup requires confirmation and preserves unsaved edits")
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true)
    await page.screenshot({ path: join(output, "authoring-narrow.png"), fullPage: true })
    checks.push("Source editor and history comparison fit a narrow viewport")
    const mutations = await page.evaluate(
      "window.creatorFixture.calls.filter(c=>['save','restore'].includes(c[0])).length"
    )
    await page.getByRole("button", { name: "取消编辑" }).click()
    assert.equal(
      await page.evaluate(
        "window.creatorFixture.calls.filter(c=>['save','restore'].includes(c[0])).length"
      ),
      mutations
    )
    await page.evaluate("window.creatorFixture.defer()")
    await page.getByRole("button", { name: "Example · v3" }).click()
    await page.evaluate("window.creatorFixture.show('b')")
    await page.getByRole("button", { name: "打开草稿库" }).waitFor()
    await page.evaluate("window.creatorFixture.finish()")
    await page.getByRole("button", { name: "打开草稿库" }).click()
    await page.getByText("此项目还没有源码草稿。", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("文件源码").count(), 0)
    assert.equal(await page.getByRole("button", { name: /Example/ }).count(), 0)
    checks.push("Cancel changes no composition and late source reads cannot enter another project")
    await page.evaluate("window.creatorFixture.show('a')")
    await page.getByRole("button", { name: "打开草稿库", exact: true }).click()
    await page.getByRole("button", { name: "Example · v3", exact: true }).click()
    await page.evaluate("window.creatorFixture.finish()")
    await page.getByLabel("源码文件").selectOption("mods/main.ts")
    await page.getByLabel("文件源码").fill("unsaved remains after deleting saved copies")
    await page.getByText("管理源码历史与草稿容量", { exact: true }).click()
    page.once("dialog", dialog => dialog.dismiss())
    await page.getByRole("button", { name: "删除已保存草稿", exact: true }).click()
    assert.equal(await page.evaluate("window.creatorFixture.calls.filter(c=>c[0]==='remove').length"), 0)
    page.once("dialog", dialog => dialog.accept())
    await page.getByRole("button", { name: "删除已保存草稿", exact: true }).click()
    await page.getByText("已删除已保存草稿并释放位置；编辑区内容尚未保存，正式安装版本保留。", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("文件源码").inputValue(), "unsaved remains after deleting saved copies")
    assert.equal(await page.getByRole("button", { name: "Example · v3", exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.creatorFixture.calls.filter(c=>c[0]==='remove').length"), 1)
    checks.push("Explicit draft deletion frees the library without silently saving or losing editor text")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ passed: true, checks }, null, 2))
    console.log(JSON.stringify({ passed: true, checks, artifacts: output }))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
