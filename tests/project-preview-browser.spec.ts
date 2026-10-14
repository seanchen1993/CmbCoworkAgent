/** Actual React preview controls with isolated IPC; the existing project execution panel is separate. */
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface FixtureWindow {
  fixture: {
    update(): void
    show(thread: string): void
    finish(): void
    creates: Array<{ threadId: string; revision: number }>
  }
}
async function main() {
  const root = resolve(__dirname, "..")
  const artifacts = resolve(root, "output/project-platform-20261012/browser")
  mkdirSync(artifacts, { recursive: true })
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "preview-project-detail",
        setup(builder) {
          builder.onResolve({ filter: /harness-board\/LocalProjectsPanel$/ }, () => ({
            path: "detail",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "jsx",
            resolveDir: root,
            contents:
              "export function LocalProjectRun({projectId}) { return <p>打开项目 {projectId}</p> }"
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ProjectDevelopmentPreviewPanel} from './src/renderer/src/components/customize/ProjectDevelopmentPreviewPanel';
      const root=createRoot(document.getElementById('root')), listeners=new Set(), creates=[];
      let revision=1, finish;
      window.api={mods:{development:{onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}},harnessBoard:{localProjects:{preview:{
        list:async threadId=>({threadId,workspace:'C:/fixture/'+threadId,drafts:[{id:'docs',name:'文档模板 '+threadId,revision,development:{devId:'dev-'+threadId,workspace:'C:/isolated/'+threadId,currentRevision:revision,currentDigest:'digest-'+revision,pendingRevision:null,activeRuns:0,updateState:'current'}}]}),
        create:async input=>{creates.push(input);return new Promise(resolve=>finish=()=>resolve('project-'+input.threadId))},
        finish:async()=>{}
      }}}};
      const show=thread=>root.render(<React.StrictMode><ProjectDevelopmentPreviewPanel threadId={thread} workspace={'C:/fixture/'+thread}/></React.StrictMode>);
      window.fixture={creates,show,finish:()=>finish(),update:()=>{revision++;for(const fn of listeners)fn({threadId:'A'})}};
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
    const page = await browser.newPage({ viewport: { width: 380, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByText("文档模板 A · 源码版本 1", { exact: true }).waitFor()
    await page.getByRole("textbox").fill("生成试用文档")
    await page.getByRole("checkbox").check()
    const create = page.getByRole("button", { name: "创建隔离试用（不开始）", exact: true })
    assert.equal(await create.isEnabled(), true)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.update())
    await page.getByText("文档模板 A · 源码版本 2", { exact: true }).waitFor()
    assert.equal(await page.getByRole("checkbox").isChecked(), false)
    assert.equal(await create.isEnabled(), false)
    await page.getByRole("checkbox").check()
    await create.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.creates.length),
      1
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.show("B"))
    await page.getByText("文档模板 B · 源码版本 2", { exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finish())
    await page.waitForTimeout(70)
    assert.equal(await page.getByText("打开项目 project-A", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("checkbox").isChecked(), false)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(artifacts, "project-preview-scope.png"), fullPage: true })
    console.log(
      "PASS preview StrictMode hydration, source-update consent expiry, double-create fencing and late cross-scope response"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
