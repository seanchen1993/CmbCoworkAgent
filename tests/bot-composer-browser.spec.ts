/** Actual Chromium editing/selection/history/IME against the production composer.
 * Domain acceptance is covered separately by bot-workspace-browser and Host tests. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium, type Locator } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

async function clearPrompt(input: Locator) {
  await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a")
  await input.press("Backspace")
}

async function main() {
  const root = process.cwd(),
    renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-composer")
  await mkdir(output, { recursive: true })
  const styles = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {BotComposer} from './src/renderer/src/components/bots/BotComposer';
      import {useBotWorkspaceStore as store} from './src/renderer/src/lib/bot-workspace-store';
      import {applyThemePreference} from './src/renderer/src/lib/theme-preference';
      import './src/renderer/src/components/bots/bot-workspace.css';
      import {Toaster} from 'sonner';
      const references=[{kind:'bot',id:'peer',name:'研发助手'},{kind:'routine',id:'daily',name:'项目日检'},{kind:'connector',id:'docs',name:'项目文档'}];
      const skill={botId:'owner',id:'review',version:1,name:'接口评审',botName:'项目助手',verified:true};
      const heldSkills=[];
      window.editorTest={calls:[],skillReads:0,holdSkills:false,loseNext:false,releaseSkills(){window.editorTest.holdSkills=false;for(const resolve of heldSkills.splice(0))resolve([{...skill,name:'过期会话技能',version:99}]);},epoch(){store.setState(state=>({snapshot:{...state.snapshot,dataEpoch:'replacement'}}));},switch(id){store.setState({selected:id});if(!store.getState().drafts[id])store.getState().draft(id,'');},draft(){return store.getState().drafts[store.getState().selected]},replace(text){store.getState().draft(store.getState().selected,text)},clear(){store.getState().updateDraft(store.getState().selected,{prompt:'',richText:undefined,skills:[],references:[],recipients:[]})}};
      window.api={bots:{referenceCandidates:async({kind})=>references.filter(item=>!kind||item.kind===kind),skillCandidates:async()=>{window.editorTest.skillReads++;return window.editorTest.holdSkills?new Promise(resolve=>heldSkills.push(resolve)):[skill]},send:async input=>{window.editorTest.calls.push(input);if(window.editorTest.loseNext){window.editorTest.loseNext=false;throw new Error('fixture receipt lost')}return {messageId:'accepted',runIds:[]}}}};
      store.setState({selected:'one',host:{capabilities:['entity-references','skill-references','message-recipients','inline-references']},snapshot:{dataEpoch:'initial',bots:[{id:'owner',name:'项目助手',deletedAt:null},{id:'peer',name:'研发助手',deletedAt:null}],conversations:[{id:'one',kind:'direct',members:['owner']},{id:'two',kind:'group',members:['owner','peer']}],runs:[]},refresh:async()=>{},loadMessages:async()=>{}});
      store.getState().draft('one','');
      applyThemePreference('codex-dark');
      function Fixture(){const id=store(s=>s.selected),recipients=store(s=>s.drafts[id]?.recipients);return <main style={{height:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--background)',color:'var(--foreground)'}}><section style={{width:700,padding:24}}><h1 style={{fontSize:24,marginBottom:200}}>CMBDevClaw</h1><BotComposer key={id} conversationId={id} recipients={recipients??[]} working={false}/></section><Toaster/></main>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `,
      resolveDir: root,
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: "composer.js",
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"test"'
    },
    plugins: [
      {
        name: "unrelated-file-preview",
        setup(builder) {
          builder.onResolve({ filter: /BotFilePreview$/ }, () => ({
            path: "preview",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export function BotFilePreview(){return null}",
            loader: "js"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 760 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    page.setDefaultTimeout(5000)
    await page.route("http://127.0.0.1:39174/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><head></head><body style="margin:0"><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1:39174/")
    await page.addStyleTag({ content: styles.build(scanner.scan()) })
    for (const asset of bundle.outputFiles) {
      if (asset.path.endsWith(".css")) await page.addStyleTag({ content: asset.text })
      else await page.addScriptTag({ content: asset.text })
    }
    const input = page.getByLabel("向 Bot 交办工作", { exact: true })
    await input.waitFor()
    await page.evaluate(() => window.editorTest.replace("外部操作填入的草稿"))
    await input.fill("不要覆盖我写好的草稿")
    assert.equal(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      "不要覆盖我写好的草稿"
    )
    await page.getByRole("heading").click()
    await clearPrompt(input)
    assert.equal((await page.evaluate(() => window.editorTest.draft())).prompt, "")
    await input.fill("@研发")
    await page.getByRole("option").filter({ hasText: "研发助手" }).waitFor()
    await input.press("Enter")
    await input.locator('[data-kind="bot"]').waitFor()
    assert.equal(
      await page.evaluate(() => window.editorTest.calls.length),
      0,
      "Choosing a reference cannot submit"
    )
    await input.press("Backspace")
    await input.press("Backspace")
    assert.equal(await input.locator('[data-kind="bot"]').count(), 0)
    await page.getByRole("listbox").waitFor()
    await input.press("Escape")
    await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
    await input.locator('[data-kind="bot"]').waitFor()
    assert.equal((await page.evaluate(() => window.editorTest.draft())).references?.[0].id, "peer")
    await input.press("End")
    await input.pressSequentially("检查发布条件")
    await input.press("Shift+Enter")
    await input.pressSequentially("第二行说明")
    assert.match(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      /检查发布条件\n第二行说明/
    )
    await page.screenshot({ animations: "disabled", path: join(output, "inline-reference.png") })
    // Copy/paste the actual ProseMirror clipboard payload without touching the OS clipboard.
    await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a")
    const copied = await input.evaluate((element) => {
      const data = new DataTransfer()
      element.dispatchEvent(
        new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data })
      )
      return { html: data.getData("text/html"), text: data.getData("text/plain") }
    })
    assert.ok(copied.html.includes("data-bot-reference"))
    assert.ok(copied.text.includes("研发助手"))
    await clearPrompt(input)
    await input.evaluate((element, value) => {
      const data = new DataTransfer()
      data.setData("text/html", value.html)
      data.setData("text/plain", value.text)
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    }, copied)
    await input.locator('[data-kind="bot"]').waitFor()
    assert.equal((await page.evaluate(() => window.editorTest.draft())).references?.[0].id, "peer")
    // Switching views restores the document without carrying its undo history.
    await page.evaluate(() => window.editorTest.switch("two"))
    await input.fill("@研发")
    await page.getByRole("option").filter({ hasText: "研发助手" }).click()
    await input.locator('[data-kind="recipient"]').waitFor()
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).recipients, ["peer"])
    await input.pressSequentially("@everyone")
    await page.getByRole("option").filter({ hasText: "全体 Bot" }).click()
    await input.locator('[data-kind="everyone"]').waitFor()
    assert.equal(await input.locator('[data-kind="recipient"]').count(), 0)
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).recipients, [])
    await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
    await input.locator('[data-kind="recipient"]').waitFor()
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).recipients, ["peer"])
    // Replace the restored query, choose everyone again, then narrow the routing.
    await clearPrompt(input)
    await input.pressSequentially("@everyone")
    await page.getByRole("option").filter({ hasText: "全体 Bot" }).click()
    await input.pressSequentially("@研发")
    await page.getByRole("option").filter({ hasText: "研发助手" }).click()
    await input.locator('[data-kind="recipient"]').waitFor()
    assert.equal(await input.locator('[data-kind="everyone"]').count(), 0)
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).recipients, ["peer"])
    await input.pressSequentially("检查分工")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    assert.deepEqual((await page.evaluate(() => window.editorTest.calls)).at(-1)?.recipients, [
      "peer"
    ])
    const directedInput = (await page.evaluate(() => window.editorTest.calls)).at(-1)!
    assert.equal(directedInput.inlineReferences?.length, 1)
    assert.deepEqual(directedInput.inlineReferences?.[0].reference, {
      kind: "recipient",
      id: "peer"
    })
    assert.equal(
      directedInput.text.slice(
        directedInput.inlineReferences![0].from,
        directedInput.inlineReferences![0].to
      ),
      "@研发助手"
    )
    await input.fill("另一会话")
    await page.evaluate(() => window.editorTest.switch("one"))
    await input.locator('[data-kind="bot"]').waitFor()
    assert.match((await page.evaluate(() => window.editorTest.draft())).prompt, /第二行说明/)
    const before = await page.evaluate(() => window.editorTest.calls.length)
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      keyCode: 229,
      bubbles: true
    })
    assert.equal(
      await page.evaluate(() => window.editorTest.calls.length),
      before,
      "IME confirmation cannot submit"
    )
    await page.getByRole("button", { name: "发送", exact: true }).click()
    assert.equal((await page.evaluate(() => window.editorTest.draft())).prompt, "")
    await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
    assert.equal(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      "",
      "Undo cannot resurrect a delivered message"
    )
    const skillReads = await page.evaluate(() => window.editorTest.skillReads)
    await input.fill("/workspace/project")
    assert.equal(await page.getByRole("listbox", { name: "选择技能" }).count(), 0)
    assert.equal(await page.evaluate(() => window.editorTest.skillReads), skillReads)
    await input.press("Enter")
    assert.equal(
      (await page.evaluate(() => window.editorTest.calls)).at(-1)?.text,
      "/workspace/project",
      "A plain slash path is sent unchanged, not consumed by a skill menu"
    )
    await input.fill("保留输入路径 /workspace/project")
    await page.getByRole("button", { name: "输入操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "选择技能", exact: true }).click()
    const skillSearch = page.getByRole("textbox", { name: "搜索技能", exact: true })
    await skillSearch.waitFor()
    await skillSearch.fill("评审")
    await page.getByRole("option").filter({ hasText: "接口评审" }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "explicit-skills.png") })
    await skillSearch.press("Escape")
    assert.equal(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      "保留输入路径 /workspace/project"
    )
    assert.equal(await skillSearch.count(), 0)
    await page.getByRole("button", { name: "输入操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "选择技能", exact: true }).click()
    await skillSearch.fill("评审")
    await page.getByRole("option").filter({ hasText: "接口评审" }).waitFor()
    await skillSearch.press("Enter")
    await input.locator('[data-kind="skill"]').waitFor()
    assert.match(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      /\/workspace\/project/
    )
    assert.equal((await page.evaluate(() => window.editorTest.draft())).skills?.[0].version, 1)
    await page.waitForFunction(() => document.activeElement?.id === "bot-composer-one")
    await input.pressSequentially("请评审接口")
    assert.match(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      /\/接口评审 请评审接口$/,
      "Typing after choosing a skill continues after its inline reference"
    )
    await page.evaluate(() => {
      window.editorTest.loseNext = true
    })
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByRole("button", { name: "重试发送", exact: true }).waitFor()
    await input.pressSequentially("，新增说明")
    await page.getByRole("button", { name: "重试发送", exact: true }).click()
    await page.getByRole("button", { name: "发送", exact: true }).waitFor()
    const draft = await page.evaluate(() => window.editorTest.draft())
    assert.equal(draft.skills?.[0].id, "review")
    assert.match(draft.prompt, /新增说明/)
    const calls = await page.evaluate(() => window.editorTest.calls)
    assert.deepEqual(calls.at(-1), calls.at(-2), "Retry uses exactly the original receipt input")
    await input.fill("删除所有引用后的正文")
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).skills, [])
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).references, [])
    // The old read may finish, but cannot populate a replacement data scope.
    await page.evaluate(() => {
      window.editorTest.holdSkills = true
    })
    const beforeHeldRead = await page.evaluate(() => window.editorTest.skillReads)
    await page.getByRole("button", { name: "输入操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "选择技能", exact: true }).click()
    await skillSearch.waitFor()
    await page.waitForFunction((reads) => window.editorTest.skillReads > reads, beforeHeldRead)
    assert.equal(
      await page.getByRole("option").filter({ hasText: "接口评审" }).count(),
      0,
      "Reopening waits for the new skill catalog instead of selecting a stale cached version"
    )
    await page.evaluate(() => window.editorTest.epoch())
    await skillSearch.waitFor({ state: "hidden" })
    await page.evaluate(() => window.editorTest.releaseSkills())
    assert.equal(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      "删除所有引用后的正文"
    )
    assert.deepEqual((await page.evaluate(() => window.editorTest.draft())).skills, [])
    await page.getByRole("button", { name: "输入操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "选择技能", exact: true }).click()
    await skillSearch.fill("评审")
    await page.getByRole("option").filter({ hasText: "接口评审" }).waitFor()
    assert.equal(await page.getByRole("option").filter({ hasText: "过期会话技能" }).count(), 0)
    await skillSearch.press("Enter")
    await input.locator('[data-kind="skill"]').waitFor()
    assert.equal((await page.evaluate(() => window.editorTest.draft())).skills?.[0].version, 1)
    // Exercise the production clipboard pipeline: .md is also a domain suffix,
    // but filenames must reach the model exactly as the user pasted them.
    await clearPrompt(input)
    const plainTask = "不要修改 AGENTS.md，完成 README.md。验收地址 https://example.com/spec"
    await input.evaluate((element, text) => {
      const data = new DataTransfer()
      data.setData("text/plain", text)
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    }, plainTask)
    assert.equal((await page.evaluate(() => window.editorTest.draft())).prompt, plainTask)
    assert.equal(await input.locator("a").count(), 1)
    assert.equal(await input.locator("a").getAttribute("href"), "https://example.com/spec")
    await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a")
    await input.evaluate((element) => {
      const data = new DataTransfer()
      data.setData("text/plain", "AGENTS.md")
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    })
    assert.equal((await page.evaluate(() => window.editorTest.draft())).prompt, "AGENTS.md")
    assert.equal(await input.locator("a").count(), 0)
    await page.getByRole("button", { name: "发送", exact: true }).click()
    assert.equal((await page.evaluate(() => window.editorTest.calls)).at(-1)?.text, "AGENTS.md")
    await input.evaluate((element) => {
      const data = new DataTransfer()
      data.setData("text/html", '<p><a href="https://example.com/spec">需求规范</a></p>')
      data.setData("text/plain", "需求规范")
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    })
    assert.equal(
      (await page.evaluate(() => window.editorTest.draft())).prompt,
      "需求规范 (https://example.com/spec)"
    )
    assert.equal(await input.locator("a").getAttribute("href"), "https://example.com/spec")
    assert.deepEqual(errors, [])
    console.log(
      "PASS Inline references, undo, newline, IME, conversation restore, accepted-send fence and lost-receipt draft ownership"
    )
  } catch (error) {
    await page.screenshot({ animations: "disabled", path: join(output, "failure.png") })
    await writeFile(join(output, "failure.html"), await page.content())
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

declare global {
  interface Window {
    editorTest: {
      calls: import("../src/shared/bot-types").BotSendInput[]
      skillReads: number
      holdSkills: boolean
      releaseSkills(): void
      epoch(): void
      loseNext: boolean
      switch(id: string): void
      replace(text: string): void
      draft(): import("../src/renderer/src/lib/bot-composer-draft").BotComposerDraft
      clear(): void
    }
  }
}
