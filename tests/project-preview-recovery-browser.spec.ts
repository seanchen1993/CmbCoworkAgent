/** Actual React recovery controls; IPC and project execution are verified separately. */
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const artifacts = resolve(
    process.env.PROJECT_PREVIEW_RECOVERY_BROWSER_ARTIFACTS ??
      "output/project-preview-recovery-browser"
  )
  mkdirSync(artifacts, { recursive: true })
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "isolated-project-detail",
        setup(builder) {
          builder.onResolve({ filter: /harness-board\/LocalProjectsPanel$/ }, () => ({
            path: "detail",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "jsx",
            resolveDir: root,
            contents:
              "export function LocalProjectRun({projectId}) { return <p>原项目 {projectId}</p> }"
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectDevelopmentPreviewPanel} from './src/renderer/src/components/customize/ProjectDevelopmentPreviewPanel';
      const root=createRoot(document.getElementById('root')),listeners=new Set(),recoveries=[],finishes=[],active=new Set();
      let version=1,status='needs-confirmation',unknown=false,pending,epoch=0,retained=true;
      window.api={mods:{development:{onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}},harnessBoard:{localProjects:{preview:{
        list:async threadId=>({threadId,workspace:'C:/creator/'+threadId,drafts:[{id:'docs',name:'文档 '+threadId,revision:2,digest:'d'.repeat(64),
          ...(active.has(threadId)?{projectId:'original-project-'+threadId}:retained?{recovery:{projectId:'original-project-'+threadId,
            revision:2,digest:'d'.repeat(64),workspace:'C:/original/'+threadId,goal:'保留原始需求',projectVersion:status==='missing'?null:version,
            status,hasUnconfirmedEffects:unknown}}:{})}]}),
        recover:input=>{recoveries.push(input);return new Promise(resolve=>pending=()=>{active.add(input.threadId);resolve(input.projectId)})},
        finish:async input=>{finishes.push(input);retained=false},create:async()=>{throw Error('Recovery must not create a replacement project')}
      }}}};
      const show=threadId=>root.render(<React.StrictMode><ProjectDevelopmentPreviewPanel key={++epoch} threadId={threadId} workspace={'C:/creator/'+threadId}/></React.StrictMode>);
      window.fixture={recoveries,finishes,show,resolve:()=>pending(),bump:()=>{version++;for(const fn of listeners)fn({threadId:'A'})},
        scenario:(next,unconfirmed=false)=>{active.clear();retained=true;status=next;unknown=unconfirmed;show('A')}};
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
    const page = await browser.newPage({ viewport: { width: 420, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const recover = page.getByRole("button", { name: "核对并恢复原试用", exact: true })
    await recover.waitFor()
    assert(await recover.isDisabled(), "A durable receipt alone is not native confirmation")
    await page.getByRole("checkbox").check()
    assert(await recover.isEnabled())
    await page.evaluate("window.fixture.bump()")
    await page.waitForFunction("!document.querySelector('input[type=checkbox]').checked")
    assert(await recover.isDisabled(), "Changed original host state expires pending consent")
    await page.getByRole("checkbox").check()
    await recover.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(await page.evaluate("window.fixture.recoveries.length"), 1)
    assert.deepEqual(await page.evaluate("window.fixture.recoveries[0]"), {
      threadId: "A",
      draftId: "docs",
      projectId: "original-project-A",
      revision: 2,
      expectedDigest: "d".repeat(64),
      expectedProjectVersion: 2
    })
    await page.evaluate("window.fixture.show('B')")
    await page.getByText("文档 B · 版本 2", { exact: true }).waitFor()
    await page.evaluate("window.fixture.resolve()")
    await page.waitForTimeout(80)
    assert.equal(await page.getByText("原项目 original-project-A", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("checkbox").isChecked(), false)
    await page.evaluate("window.fixture.show('A')")
    await page.getByRole("button", { name: "查看本轮执行与阶段操作", exact: true }).click()
    await page.getByText("原项目 original-project-A", { exact: true }).waitFor()
    await page.evaluate("window.fixture.scenario('needs-confirmation',true)")
    await recover.waitFor()
    await page.getByText(/原任务结果尚未确认/).waitFor()
    assert(
      await page
        .getByRole("button", { name: "结束保留的试用（保留文件）", exact: true })
        .isDisabled()
    )
    await page.getByRole("checkbox").check()
    assert(await recover.isEnabled(), "Recovery permits result inspection, never replay")
    await page.evaluate("window.fixture.scenario('draft-changed')")
    await page.getByText(/草稿已改变/).waitFor()
    assert.equal(await recover.count(), 0)
    await page.getByRole("button", { name: "结束保留的试用（保留文件）", exact: true }).click()
    await page.getByRole("button", { name: "创建试用项目（稍后开始任务）", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.finishes.at(-1)"), {
      threadId: "A",
      projectId: "original-project-A",
      draftId: "docs"
    })
    assert.equal(await page.getByRole("checkbox").isChecked(), false)
    await page.evaluate("window.fixture.scenario('missing')")
    await page.getByRole("button", { name: "清除未创建记录（保留文件）", exact: true }).click()
    assert.equal(await page.evaluate("window.fixture.finishes.length"), 2)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(artifacts, "recovery-controls.png"), fullPage: true })
    console.log(
      "PASS native recovery consent, exact source/version receipt, double-click/cross-scope fencing, unknown ownership and retained-source cleanup controls"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
