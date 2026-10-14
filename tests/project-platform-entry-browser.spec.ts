/** Actual React entry/dialog/legacy components and deferred IPC; no app profile or business runs. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright"

const root = resolve(__dirname, "..")
const output = resolve(root, "output/project-platform-20261012/browser-entry")
mkdirSync(output, { recursive: true })
const uiErrors: string[] = []
async function fixture(browser: Browser, contents: string) {
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    loader: { ".md": "text", ".png": "dataurl" },
    jsx: "automatic",
    alias: { "@": resolve(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "isolated-navigation-only",
        setup(build) {
          build.onResolve({ filter: /(?:^|\/)lib\/store$/ }, () => ({
            path: "navigation",
            namespace: "fixture"
          }))
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export const useAppStore={getState:()=>({setShowHarnessBoardView:value=>window.calls.push(['navigate-project',value]),selectThread:id=>window.calls.push(['navigate-thread',id])})}`
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      const root=createRoot(document.getElementById('root'));window.calls=[];
      ${contents}
    `
    }
  })
  const page = await browser.newPage({ viewport: { width: 380, height: 850 } })
  page.on("pageerror", (error) => uiErrors.push(error.message))
  await page.setContent('<html><body><div id="root"></div></body></html>')
  await page.addScriptTag({ content: bundled.outputFiles[0].text })
  const assets = resolve(root, "out/renderer/assets")
  const css = existsSync(assets)
    ? readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
    : undefined
  if (css) await page.addStyleTag({ path: resolve(assets, css) })
  return page
}
const tick = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

async function gate(browser: Browser, decision: "enabled" | "disabled" | "offline") {
  const page = await fixture(
    browser,
    `
    import{ProjectPlatformEntry}from'./src/renderer/src/components/harness-board/ProjectPlatformEntry';
    const pending=[];window.api={featureGates:{isEnabled:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))},
      harnessBoard:{localProjects:{templates:async()=>{calls.push(['templates']);return[]},list:async()=>[]}}};
    function Enterprise(){React.useEffect(()=>{calls.push(['enterprise-mounted'])},[]);return <input aria-label="原企业输入" defaultValue="原始草稿"/>}
    window.finish=kind=>pending.splice(0).forEach(p=>kind==='offline'?p.reject(Error('offline')):p.resolve({enabled:kind==='enabled',reason:kind}));
    let generation=0;
    window.show=()=>root.render(<React.StrictMode><ProjectPlatformEntry key={generation}><Enterprise/></ProjectPlatformEntry></React.StrictMode>);
    window.reenter=()=>{generation++;window.show()};
    window.show();
  `
  )
  await page.getByRole("status").filter({ hasText: "正在准备项目入口" }).waitFor()
  assert.equal(await page.getByRole("button", { name: "新建本地任务" }).count(), 0)
  assert.equal(await page.getByLabel("原企业输入").count(), 0)
  await page.evaluate((decision) => (window as any).finish(decision), decision)
  if (decision === "enabled") {
    await page.getByLabel("原企业输入").fill("保留的企业草稿")
    await page.evaluate(() => (window as any).show())
    assert.equal(await page.getByLabel("原企业输入").inputValue(), "保留的企业草稿")
    assert.equal(await page.getByRole("button", { name: "新建本地任务" }).count(), 0)
  } else {
    await page.getByRole("button", { name: "新建本地任务" }).click()
    await page.getByLabel("任务名称").fill("保留的本地草稿")
    await page.evaluate(() => (window as any).show())
    assert.equal(await page.getByLabel("任务名称").inputValue(), "保留的本地草稿")
    assert.equal(
      await page.evaluate(
        () => (window as any).calls.filter((row) => row[0] === "enterprise-mounted").length
      ),
      0
    )
  }
  await page.evaluate(() => (window as any).reenter())
  await tick(page)
  if (decision === "enabled") {
    assert.equal(await page.getByRole("status").filter({ hasText: "正在准备项目入口" }).count(), 0)
    await page.getByLabel("原企业输入").fill("已开通刷新保留")
    await page.evaluate(() => (window as any).finish("enabled"))
    assert.equal(await page.getByLabel("原企业输入").inputValue(), "已开通刷新保留")
  } else {
    await page.getByRole("status").filter({ hasText: "正在准备项目入口" }).waitFor()
    assert.equal(await page.getByLabel("任务名称").count(), 0)
    await page.evaluate(() => (window as any).finish("enabled"))
    await page.getByLabel("原企业输入").waitFor()
  }
  await page.screenshot({ path: resolve(output, `gate-${decision}.png`), fullPage: true })
  await page.close()
}

async function details(browser: Browser) {
  const page = await fixture(
    browser,
    `
    import{ProjectRunDetails}from'./src/renderer/src/components/chat/ProjectRunDetails';
    const pending=[];window.api={mods:{builtinAdvisor:async(id,workspace,kind)=>{calls.push(['advisor',id,kind]);return{enabled:false,running:false,nextAllowedAt:0,dailyLimit:10,outputTokenLimit:512}},
      builtinOverview:(id,workspace)=>new Promise(resolve=>{calls.push(['overview',id]);pending.push(()=>resolve({threadId:id,workspace,capturedAt:1,
        instructions:{status:'unknown',message:'真实范围 '+id},policy:{required:false,blockedTools:[],recordedBlocks:0,explanation:'原审批'},
        metrics:{sampled:0,succeeded:0,failed:0,running:0,unknown:0,inputTokens:null,outputTokens:null,limited:false,explanation:'保留记录'},suggestions:[]}))})}};
    window.show=id=>root.render(<React.StrictMode><ProjectRunDetails key={id} threadId={id} workspace={'C:/'+id}/></React.StrictMode>);
    window.finish=()=>pending.splice(0).forEach(done=>done());window.show('A');
  `
  )
  await tick(page)
  assert.equal(await page.evaluate(() => (window as any).calls.length), 0)
  await page.getByRole("button", { name: "运行过程", exact: true }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("dialog", { name: "本阶段运行过程" }).waitFor()
  await page.evaluate(() => (window as any).show("B"))
  await page.evaluate(() => (window as any).finish())
  assert.equal(await page.getByText("真实范围 A", { exact: true }).count(), 0)
  await page.getByRole("button", { name: "运行过程", exact: true }).click()
  await page.evaluate(() => (window as any).finish())
  await page.getByText("真实范围 B", { exact: true }).waitFor({ state: "attached" })
  await page.getByText("项目规范 · 查看本次加载来源", { exact: true }).click()
  await page.screenshot({ path: resolve(output, "readonly-project-dialog.png"), fullPage: true })
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.getByRole("button", { name: "返回项目任务", exact: true }).click()
  assert.equal(
    await page.evaluate(
      () => (window as any).calls.filter((row) => row[0] === "navigate-project").length
    ),
    1
  )
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).calls.filter(
          (row) => row[0] === "advisor" && !["view", "cancel"].includes(row[2])
        ).length
    ),
    0
  )
  await page.close()
}

async function legacy(browser: Browser) {
  const page = await fixture(
    browser,
    `
    import{LegacyProjectRuntimePanel}from'./src/renderer/src/components/harness-board/LegacyProjectRuntimePanel';
    const pending=[];window.api={harnessBoard:{legacyProjects:Object.fromEntries(['view','enable','disable'].map(kind=>[kind,id=>new Promise((resolve,reject)=>{calls.push([kind,id]);pending.push({kind,id,resolve,reject})})]))}};
    window.finish=(id,enabled,unknown=false)=>{for(let i=pending.length-1;i>=0;i--)if(pending[i].id===id){pending.splice(i,1)[0].resolve({binding:enabled?{packageVersion:'1.0.0'}:null,
      operations:unknown?[{operationId:'op',threadId:'old-thread',featureId:'feature',status:'unknown',startedAt:1,terminalCode:null}]:[]})}};
    window.show=id=>root.render(<React.StrictMode><LegacyProjectRuntimePanel projectId={id}/></React.StrictMode>);window.show('A');
  `
  )
  await page.getByText("保留插件版本与运行记录 · 可选", { exact: true }).click()
  await page.getByText("正在读取项目版本与执行记录…", { exact: true }).waitFor()
  assert.equal(await page.getByText("尚未开启，当前仍使用原项目方式。", { exact: true }).count(), 0)
  await page.evaluate(() => (window as any).finish("A", false))
  await page.getByRole("button", { name: "为此项目开启" }).dblclick()
  assert.equal(
    await page.evaluate(() => (window as any).calls.filter((row) => row[0] === "enable").length),
    1
  )
  await page.evaluate(() => (window as any).show("B"))
  await page.evaluate(() => (window as any).finish("A", true))
  await page.getByText("保留插件版本与运行记录 · 可选", { exact: true }).click()
  assert.equal(await page.getByText(/已保留插件版本/).count(), 0)
  await page.evaluate(() => (window as any).finish("B", true, true))
  await page.getByRole("button", { name: "恢复使用已安装版本" }).waitFor()
  assert.equal(await page.getByRole("button", { name: "恢复使用已安装版本" }).isDisabled(), true)
  await page.getByRole("button", { name: "查看原会话" }).click()
  await tick(page)
  assert.equal(
    await page.evaluate(() => (window as any).calls.filter((row) => row[0] === "disable").length),
    0
  )
  await page.screenshot({ path: resolve(output, "legacy-unknown.png"), fullPage: true })
  await page.close()
}

async function main() {
  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" })
  }
  try {
    for (const decision of ["enabled", "disabled", "offline"] as const)
      await gate(browser, decision)
    await details(browser)
    await legacy(browser)
    for (const kind of ["local", "legacy"] as const) await failureMessages(browser, kind)
    assert.deepEqual(uiErrors, [])
    console.log(
      "PASS actual React: delayed/offline gate has no editable draft loss; no enterprise mount when unavailable; read-only scoped project dialog; legacy StrictMode/double-click/late identity/unknown guard"
    )
  } finally {
    await browser.close()
  }
}
async function failureMessages(browser: Browser, kind: "local" | "legacy") {
  const page = await fixture(
    browser,
    `
    import{LocalProjectsPanel}from'./src/renderer/src/components/harness-board/LocalProjectsPanel';
    import{LegacyProjectRuntimePanel}from'./src/renderer/src/components/harness-board/LegacyProjectRuntimePanel';
    let code='PROJECT_LEGACY_RUNTIME_UNAVAILABLE';
    const fail=async()=>{calls.push(['read']);throw Error(code)};
    window.api={harnessBoard:{localProjects:{templates:async()=>[],list:fail},legacyProjects:{view:fail,
      enable:async()=>calls.push(['enable']),disable:async()=>calls.push(['disable'])}}};
    window.conflict=()=>code='PROJECT_WORKSPACE_MODE_CONFLICT';
    root.render(<React.StrictMode>${kind === "local" ? "<LocalProjectsPanel/>" : "<LegacyProjectRuntimePanel projectId='owned'/>"}</React.StrictMode>);
  `
  )
  if (kind === "legacy")
    await page.getByText("保留插件版本与运行记录 · 可选", { exact: true }).click()
  await page
    .getByRole("alert")
    .getByText(/普通聊天仍可使用/)
    .waitFor()
  await page
    .getByRole("alert")
    .getByText(/重启应用后更新记录/)
    .waitFor()
  await page.evaluate(() => (window as any).conflict())
  await page
    .getByRole("button", { name: kind === "local" ? "更新列表" : "更新执行记录", exact: true })
    .click()
  await page
    .getByRole("alert")
    .getByText(/为新项目选择另一个目录/)
    .waitFor()
  assert.equal(
    await page.evaluate(() => (window as any).calls.filter((row) => row[0] !== "read").length),
    0
  )
  await page.screenshot({ path: resolve(output, `${kind}-conflict.png`), fullPage: true })
  await page.close()
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
