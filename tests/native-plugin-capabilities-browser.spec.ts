import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/plugin-journey-20261013/native-directory")
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {NativePluginCapabilities} from './src/renderer/src/components/customize/NativePluginCapabilities';
      window.calls=[];window.fail=false;
      const plugins=[['original','原版 AutoBiz',true,true],['derived','我的 AutoBiz v2',true,true],['off','已停用插件',false,true],['function','功能插件',true,false]].map(([id,name,enabled,hasProjectMode])=>({id,name,enabled,hasProjectMode,version:'1.0',description:'本地已安装插件',skillCount:id==='function'?0:3,...(id==='derived'?{businessModCount:5,businessExtensionCount:1}:{})}));
      const projects=['original','derived'].map(id=>({projectId:id+'-project',name:id+' 项目',harnessAdapter:{id,type:'plugin'}}));
      window.togglePlugin=(id,enabled)=>{plugins.find(p=>p.id===id).enabled=enabled;window.bumpVersion()};
      window.api={plugins:{list:async()=>{window.calls.push(['list']);if(window.fail)throw Error('目录不可读');const value=structuredClone(plugins);if(window.deferList)return new Promise(resolve=>window.finishList=()=>resolve(value));return value}},skills:{listPlugins:async()=>plugins.filter(p=>p.enabled&&p.skillCount).map(p=>({pluginId:p.id,name:'build-'+p.id,path:p.id,isProjectModePlugin:p.hasProjectMode}))},nodeComposition:{projects:async()=>projects,catalog:async(input)=>{window.calls.push(['catalog',input]);return {project:projects.find(p=>p.projectId===input.projectId),nodes:[],config:{nodes:[],templates:[{id:'custom',templateType:'custom',requiredNodes:[],name:'自选'}]}}}}};
      const root=createRoot(document.getElementById('root'));
      window.renderNative=()=>root.render(<NativePluginCapabilities threadId='thread' workspace='C:/fixture' functionPluginIds={['function']} onAssemble={id=>window.calls.push(['assemble',id])}/>);
      window.renderNative();
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "fixture",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^@\/lib\/(plugin-settings-intent|feature-gates|node-composition-intent|derived-project-intent|store)$/
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: args.path.endsWith("store")
              ? "import {useSyncExternalStore} from 'react'; let version=0;const listeners=new Set();window.bumpVersion=()=>{version++;listeners.forEach(fn=>fn())};export const useAppStore=selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector({pluginVersion:version}));"
              : args.path.endsWith("plugin-settings-intent")
                ? "export const openPluginSettings=id=>window.calls.push(['manage',id])"
                : args.path.endsWith("feature-gates")
                  ? "export const useFeatureGate=()=>({enabled:true,loading:false})"
                  : args.path.endsWith("derived-project-intent")
                    ? "export const openDerivedProject=(...args)=>window.calls.push(['new-project',...args]);export const openExistingPluginProject=(...args)=>window.calls.push(['existing-project',...args])"
                  : "export const openNativeNodePlan=async()=>{throw Error('unexpected write')}"
          }))
        }
      }
    ]
  })
  const cssPath = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      /* This fixture does not persist a CSS dependency graph. */
    }
  })
  const candidates = new Scanner({}).scanFiles(
    ["NativePluginCapabilities", "NativeNodeComposer"].map((name) => ({
      content: readFileSync(resolve(`src/renderer/src/components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://localhost/native-directory", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/native-directory")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    const original = page.getByRole("article", { name: "原版 AutoBiz", exact: true })
    const derived = page.getByRole("article", { name: "我的 AutoBiz v2", exact: true })
    const disabled = page.getByRole("article", { name: "已停用插件", exact: true })
    await original.waitFor()
    await derived.waitFor()
    assert(await original.getByText("1 项技能", { exact: true }).isVisible())
    assert.equal(await original.getByText("build-original", { exact: true }).isVisible(), false)
    await original.getByText("查看插件内容", { exact: true }).click()
    assert(await original.getByText("build-original", { exact: true }).isVisible())
    assert(await original.getByText("本地已安装插件", { exact: true }).isVisible())
    await original.getByText("查看插件内容", { exact: true }).click()
    assert.equal(await original.getByText("build-original", { exact: true }).isVisible(), false)
    assert.equal(await page.getByRole("article", { name: "功能插件", exact: true }).count(), 0)
    assert(await disabled.getByRole("button", { name: "查看项目流程", exact: true }).isDisabled())
    assert.equal(await page.getByRole("checkbox").count(), 0)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: resolve(output, "native-directory-mobile.png"), fullPage: true })
    await derived.getByRole("button", { name: "用这些 Mods 组装新插件", exact: true }).click()
    assert(await page.evaluate(() => JSON.stringify((window as unknown as { calls: unknown[] }).calls).includes('["assemble","derived"]')))
    await derived.getByRole("button", { name: "新建此插件项目", exact: true }).click()
    const creation = await page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls.find(([kind]) => kind === "new-project"))
    assert.deepEqual(creation, ["new-project", "derived", "我的 AutoBiz v2", { threadId: "thread", expectedWorkspace: "C:/fixture" }])
    await derived.getByRole("button", { name: "查看项目流程", exact: true }).click()
    const projects = page.getByLabel("选择节点所属项目")
    await projects.waitFor()
    assert.deepEqual(await projects.locator("option").allTextContents(), ["请选择", "derived 项目"])
    await projects.selectOption("derived-project")
    await page.getByRole("button", { name: "检查并预览步骤", exact: true }).waitFor()
    await page
      .getByText("此版本支持为本次需求自选步骤，前置检查和人工确认会保留。", { exact: true })
      .waitFor()
    await disabled.getByRole("button", { name: "管理并启用插件", exact: true }).click()
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify((window as unknown as { calls: unknown[] }).calls).includes(
          '["manage","off"]'
        )
      ),
      true
    )
    await page.evaluate(() => {
      ;(window as unknown as { fail: boolean }).fail = true
    })
    await page.getByRole("button", { name: "刷新插件目录", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "目录不可读" }).waitFor()
    assert.equal(await page.getByLabel("选择节点所属项目").count(), 0)
    await page.evaluate(() => {
      ;(window as unknown as { fail: boolean }).fail = false
    })
    await page.getByRole("button", { name: "刷新插件目录", exact: true }).click()
    await original.waitFor()
    await page.evaluate(() => {
      document.getElementById("root")!.hidden = true
      ;(window as unknown as { togglePlugin(id: string, enabled: boolean): void }).togglePlugin(
        "off",
        true
      )
    })
    await page.waitForFunction(() =>
      document.querySelector('article[aria-label="已停用插件"]')?.textContent?.includes("已启用")
    )
    await page.evaluate(() => {
      document.getElementById("root")!.hidden = false
    })
    assert(await disabled.getByRole("button", { name: "查看项目流程", exact: true }).isEnabled())
    await page.evaluate(() => {
      const fixture = window as unknown as {
        deferList: boolean
        togglePlugin(id: string, enabled: boolean): void
      }
      fixture.deferList = true
      fixture.togglePlugin("off", false)
    })
    await page.waitForFunction(
      () => typeof (window as unknown as { finishList?: () => void }).finishList === "function"
    )
    await page.evaluate(() => {
      const fixture = window as unknown as {
        deferList: boolean
        togglePlugin(id: string, enabled: boolean): void
      }
      fixture.deferList = false
      fixture.togglePlugin("off", true)
    })
    await page.waitForFunction(() => !document.body.textContent?.includes("正在读取插件目录…"))
    await page.evaluate(() => (window as unknown as { finishList(): void }).finishList())
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert(await disabled.getByRole("button", { name: "查看项目流程", exact: true }).isEnabled())
    const callsBeforeRender = await page.evaluate(
      () =>
        (window as unknown as { calls: unknown[][] }).calls.filter((row) => row[0] === "list")
          .length
    )
    await page.evaluate(() => (window as unknown as { renderNative(): void }).renderNative())
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { calls: unknown[][] }).calls.filter((row) => row[0] === "list")
            .length
      ),
      callsBeforeRender
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS native originals/derivatives visible, function deduplication, disabled scope, bound-project filtering, management and retry"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
