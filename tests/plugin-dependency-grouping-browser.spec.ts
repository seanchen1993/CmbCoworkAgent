import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Locator } from "playwright"

async function main() {
  const output = resolve("output/plugin-dependency-grouping-browser", `run-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ModsSettings} from './src/renderer/src/components/customize/ModsPanel';
      window.calls=[];
      const make=(id,name,extra={})=>({id,name,description:name,version:'1.0',enabled:true,skillCount:0,mcpServerCount:0,...extra});
      let plugins=[
        make('project-a','资料校验项目',{projectDependencyIds:['rules','workflow','knowledge']}),
        make('rules','规则组件',{modCount:1}),
        make('workflow','流程组件',{modCount:1}),
        make('knowledge','知识组件',{modCount:1}),
        make('unrelated','独立工具',{modCount:1}),
        make('project-b','报告整理项目',{projectDependencyIds:['knowledge']})
      ];
      window.api={plugins:{list:async()=>plugins.map(p=>({...p})),
        setEnabled:async(id,enabled)=>{window.calls.push(['enable',id,enabled]);plugins=plugins.map(p=>p.id===id?{...p,enabled}:p);return {success:true}},
        delete:async(id)=>{window.calls.push(['delete',id]);plugins=plugins.filter(p=>p.id!==id);return {success:true}}},
        mods:{globalEnabled:async()=>false,onConfigurationChanged:()=>()=>{},
          status:async()=>({workspace:'C:/fixture',enabled:false,outputPolicy:false,mods:[],functionMods:plugins.filter(p=>p.modCount).map(p=>({pluginId:p.id,name:p.name,digest:'a'.repeat(64),state:'needs-approval',capabilities:['command']})),diagnostics:[]}),
          clawView:async()=>null,approveFunction:async()=>{throw Error('Grouping must not grant permission')}},
        harnessBoard:{localProjects:{templates:async()=>[]}}};
      const root=createRoot(document.getElementById('root'));
      root.render(<ModsSettings threadId='grouping-chat' workspaceHint='C:/fixture' active/>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "host-boundaries",
        setup(b) {
          b.onResolve(
            {
              filter:
                /^@\/lib\/(store|feature-gates|derived-project-intent|claw-sidebar|plugin-settings-intent)$/
            },
            (a) => ({ path: a.path, namespace: "fixture" })
          )
          b.onResolve(
            {
              filter:
                /^\.\/(ModCreator|PluginDerivationPanel|OfficialSparksExamples|FunctionCompletionPolicy|FunctionCompatibilityCheck|FunctionUserConfig|SparksDocumentationLink|InstalledPluginStartUse)$/
            },
            (a) => ({ path: a.path, namespace: "component" })
          )
          b.onLoad({ filter: /.*/, namespace: "component" }, (a) => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: a.path.endsWith("InstalledPluginStartUse")
              ? `export function InstalledPluginStartUse(props){return <button disabled={props.disabled} data-native-start-use={props.pluginId} onClick={()=>{window.calls.push(['start',props.threadId,props.workspace,props.pluginId,props.expected]);props.onBusyChange?.(true);props.onBusyChange?.(false)}}>{props.actionLabel}</button>}`
              : `export const ${a.path.slice(2)}=()=>null`
          }))
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
            loader: "js",
            contents: a.path.endsWith("store")
              ? "const s={accountRevision:1,bumpPluginVersion(){},setCustomizeTab:(...a)=>window.calls.push(['settings',...a]),setShowCustomizeView(){}};export const useAppStore=Object.assign((f)=>f(s),{getState:()=>s})"
              : a.path.endsWith("feature-gates")
                ? "export const useFeatureGate=()=>({enabled:true,loading:false})"
                : a.path.endsWith("plugin-settings-intent")
                  ? "export const openPluginSettings=(...a)=>window.calls.push(['settings',...a])"
                  : a.path.endsWith("claw-sidebar")
                    ? "export const openClawSidebar=()=>{}"
                    : "export const openDerivedProject=(...a)=>window.calls.push(['project',...a]);export const openExistingPluginProject=()=>{};export const useDerivedProjectIntent=()=>null;export const dismissDerivedProject=()=>{}"
          }))
        }
      }
    ]
  })
  const css = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(css, "utf8"), {
    base: dirname(css),
    from: css,
    onDependency() {
      // The isolated browser fixture does not need a dependency graph.
    }
  })
  const candidates = new Scanner({}).scanFiles(
    ["ModsPanel", "ModsGuide", "ModsImportGuide"].map((name) => ({
      content: readFileSync(resolve(`src/renderer/src/components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 850, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const installed = page.locator("[data-installed-mods]")
  const roots = installed.locator(":scope > article")
  const card = (id: string) => installed.locator(`[data-installed-mod-id="${id}"]`)
  const rootIds = () =>
    roots.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-installed-mod-id")))
  const ownButton = (parent: Locator, name: string) =>
    parent.locator(":scope > div").getByRole("button", { name, exact: true })
  const remove = async (id: string) => {
    const parent = card(id)
    const manage = ownButton(parent, "管理")
    if (await manage.count()) await manage.click()
    await ownButton(parent, "卸载").click()
    await page.getByRole("dialog").getByRole("button", { name: "确认卸载", exact: true }).click()
    await parent.waitFor({ state: "detached" })
  }
  try {
    await page.route("http://localhost/grouping", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<div id='root'></div>"
      })
    )
    await page.goto("http://localhost/grouping")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await card("project-a").waitFor()
    assert.deepEqual(await rootIds(), ["project-a", "unrelated", "project-b"])
    assert.equal(await installed.locator("details[open]").count(), 0)
    assert.equal(await card("rules").isVisible(), false)
    assert.equal(await card("knowledge").count(), 2)
    await page.screenshot({ path: resolve(output, "dependencies-collapsed.png"), fullPage: true })

    for (const id of ["project-a", "project-b"]) {
      await card(id).locator(":scope > details > summary").click()
    }
    for (const id of ["rules", "workflow", "knowledge"]) {
      for (const dependency of await card(id).all()) {
        assert(await dependency.isVisible())
        assert((await dependency.innerText()).includes("由项目统一配置和授权"))
        assert.equal(await dependency.locator("[data-native-start-use]").count(), 0)
        assert.equal(
          await dependency.getByRole("button", { name: /开始使用|启用|授权以上能力/ }).count(),
          0
        )
        await ownButton(dependency, "管理").click()
        assert.equal(await dependency.locator("[data-function-mod-id]").count(), 0)
        assert.equal(
          await dependency.getByRole("button", { name: "授权以上能力", exact: true }).count(),
          0
        )
        await ownButton(dependency, "收起管理").click()
      }
    }
    for (const shared of await card("knowledge").all()) {
      assert((await shared.innerText()).includes("共享于：资料校验项目、报告整理项目"))
    }
    await page.screenshot({
      path: resolve(output, "dependencies-shared-expanded.png"),
      fullPage: true
    })

    // Shared components remain repairable; restoring catalogue visibility grants no permission.
    const shared = card("knowledge").first()
    await ownButton(shared, "管理").click()
    await ownButton(shared, "停用插件").click()
    await ownButton(shared, "启用组件").waitFor()
    for (const instance of await card("knowledge").all()) {
      assert.equal(await instance.locator("[data-native-start-use]").count(), 0)
      assert.equal(await instance.locator("[data-function-mod-id]").count(), 0)
    }
    await ownButton(shared, "启用组件").click()
    await ownButton(shared, "停用插件").waitFor()
    await ownButton(shared, "收起管理").click()

    // Disabling a project changes no child installation or authorization state.
    await ownButton(card("project-a"), "管理").click()
    await ownButton(card("project-a"), "停用插件").click()
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-installed-mod-id="project-a"]')
      return !Array.from(root?.querySelectorAll("button") ?? []).some(
        (b) => b.textContent === "停用插件"
      )
    })
    assert.deepEqual(await rootIds(), ["project-a", "unrelated", "project-b"])
    assert.equal(await card("rules").isVisible(), true)

    // Removing one owner restores its exclusive children, while the shared child stays under B.
    await remove("project-a")
    assert.deepEqual(await rootIds(), ["rules", "workflow", "unrelated", "project-b"])
    assert.equal(await card("knowledge").count(), 1)
    assert.equal(await card("rules").locator("[data-native-start-use]").count(), 1)
    assert.equal(await card("knowledge").locator("[data-native-start-use]").count(), 0)
    await remove("project-b")
    assert.deepEqual(await rootIds(), ["rules", "workflow", "knowledge", "unrelated"])
    assert.equal(await card("knowledge").locator("[data-native-start-use]").count(), 1)
    assert.equal(await installed.locator("details").count(), 0)
    const calls = await page.evaluate(() => window.calls)
    assert.deepEqual(calls, [
      ["enable", "knowledge", false],
      ["enable", "knowledge", true],
      ["enable", "project-a", false],
      ["delete", "project-a"],
      ["delete", "project-b"]
    ])
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "dependencies-restored.png"), fullPage: true })
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          calls,
          errors,
          boundary:
            "Actual ModsSettings, real grouping and management UI; controlled IPC metadata/state. No business execution, dependency installation or permission grant."
        },
        null,
        2
      )
    )
    console.log(
      `PASS dependency grouping, shared children, no separate authorization, disabled/removal reachability: ${output}`
    )
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    writeFileSync(
      resolve(output, "failure.json"),
      JSON.stringify({ error: String(error), errors }, null, 2)
    )
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
