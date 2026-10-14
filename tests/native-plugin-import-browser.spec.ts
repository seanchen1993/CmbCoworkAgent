import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

declare global {
  interface Window {
    calls: Array<[string, ...unknown[]]>
    gate: boolean
    next: string
    renderFixture(): void
  }
}

async function main() {
  const output = resolve("output/native-plugin-import-20261013", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ModsSettings} from './src/renderer/src/components/customize/ModsPanel';
      window.calls=[]; window.gate=true; window.next='native';
      let plugins=[{id:'mod',name:'Existing extension',enabled:true,modCount:1,skillCount:0,mcpServerCount:1,hasProjectMode:true}];
      const install=async(kind,...args)=>{window.calls.push([kind,...args]);
        if(window.next==='cancel')return {success:false,error:'已取消'};
        if(window.next==='error')return {success:false,error:'导入失败 fixture'};
        const project=window.next==='native',id=project?'native':'skill';
        if(!plugins.some(p=>p.id===id))plugins.push({id,name:project?'AutoBiz original':'Plain skill',enabled:false,skillCount:1,mcpServerCount:0,hookCount:project?2:0,hasProjectMode:project});
        return {success:true,pluginName:project?'AutoBiz original':'Plain skill',kind:'plugin',enabled:false};};
      window.api={plugins:{list:async()=>plugins.map(p=>({...p})),
        installFromDir:(...a)=>install('dir',...a),install:(_buffer,...a)=>install('zip',...a),
        setEnabled:async(id,enabled)=>{window.calls.push(['enable',id,enabled]);plugins=plugins.map(p=>p.id===id?{...p,enabled}:p)},
        delete:async(id)=>{window.calls.push(['delete',id]);plugins=plugins.filter(p=>p.id!==id);return {success:true}}},
        mods:{globalEnabled:async()=>false,onConfigurationChanged:()=>()=>{},status:async()=>{throw Error('unexpected status')},
        configureGlobal:async(value)=>{window.calls.push(['global',value]);return value}}};
      const root=createRoot(document.getElementById('root'));
      window.renderFixture=()=>root.render(<ModsSettings threadId={null} workspaceHint={null} active onDerive={p=>window.calls.push(['derive',p.id])}/>);
      window.renderFixture();
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
                /^\.\/(ModCreator|PluginDerivationPanel|OfficialSparksExamples|FunctionCompletionPolicy|FunctionCompatibilityCheck|FunctionUserConfig|SparksDocumentationLink)$/
            },
            (a) => ({ path: a.path, namespace: "component" })
          )
          b.onLoad({ filter: /.*/, namespace: "component" }, (a) => ({
            loader: "js",
            contents: `export const ${a.path.slice(2)}=()=>null`
          }))
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
            loader: "js",
            contents: a.path.endsWith("store")
              ? "const s={bumpPluginVersion(){},setCustomizeTab:(...a)=>window.calls.push(['settings',...a]),setShowCustomizeView(){}};export const useAppStore=Object.assign((f)=>f(s),{getState:()=>s})"
              : a.path.endsWith("feature-gates")
                ? "export const useFeatureGate=()=>({enabled:window.gate,loading:false})"
                : a.path.endsWith("plugin-settings-intent")
                  ? "export const openPluginSettings=(...a)=>window.calls.push(['settings',...a])"
                  : a.path.endsWith("claw-sidebar")
                    ? "export const openClawSidebar=()=>{}"
                    : "export const openDerivedProject=(...a)=>window.calls.push(['project',...a])"
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
      /* No dependency graph needed for the isolated fixture. */
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
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  try {
    await page.route("http://localhost/import", (r) =>
      r.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/import")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByText("Existing extension", { exact: true }).waitFor()
    await page.getByRole("button", { name: "从文件夹安装", exact: true }).click()
    const native = page.getByRole("article", { name: "AutoBiz original", exact: true })
    await native.getByText("尚未启用", { exact: true }).waitFor()
    assert(await native.getByRole("button", { name: "新建项目", exact: true }).isDisabled())
    assert.equal(
      await page.evaluate(() => window["calls"].filter((x) => x[0] === "enable").length),
      0
    )
    await native.getByRole("button", { name: "启用插件", exact: true }).focus()
    await page.keyboard.press("Enter")
    await native.getByText("已启用", { exact: true }).waitFor()
    await page.evaluate(() => {
      window["gate"] = false
      window["renderFixture"]()
    })
    await native.getByText("当前应用尚未开放项目模式。", { exact: true }).waitFor()
    assert(await native.getByRole("button", { name: "新建项目", exact: true }).isDisabled())
    await page.evaluate(() => {
      window["gate"] = true
      window["renderFixture"]()
    })
    await native.getByRole("button", { name: "新建项目", exact: true }).click()
    await native.getByRole("button", { name: "从此插件创建", exact: true }).click()
    await native.getByRole("button", { name: "设置使用", exact: true }).click()
    const mixed = page.getByRole("article", { name: "Existing extension", exact: true })
    assert.equal(await mixed.getByRole("button", { name: "新建项目", exact: true }).count(), 1)
    assert.equal(await mixed.getByRole("button", { name: "从此插件创建", exact: true }).count(), 1)
    assert((await mixed.innerText()).includes("1 个工具连接"))
    assert((await mixed.innerText()).includes("1 个灵件模块"))
    await page.evaluate(() => (window["next"] = "skill"))
    await page.locator("input[type=file]").setInputFiles({
      name: "plain.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("fixture")
    })
    const skill = page.getByRole("article", { name: "Plain skill", exact: true })
    await skill.waitFor()
    assert.equal(await skill.getByRole("button", { name: "新建项目", exact: true }).count(), 0)
    for (const outcome of ["error", "cancel"]) {
      await page.evaluate((v) => (window["next"] = v), outcome)
      await page.getByRole("button", { name: "从文件夹安装", exact: true }).click()
      if (outcome === "error") await page.getByText("导入失败 fixture", { exact: true }).waitFor()
      else await page.waitForFunction(() => !document.querySelector("button")?.disabled)
      assert.equal(await native.count(), 1)
      assert.equal(await skill.count(), 1)
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: resolve(output, "native-import-mobile.png"), fullPage: true })
    await native.getByRole("button", { name: "卸载", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(await native.count(), 1)
    await native.getByRole("button", { name: "卸载", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "确认卸载", exact: true }).click()
    await native.waitFor({ state: "detached" })
    await page.getByText("Existing extension", { exact: true }).waitFor()
    await page.getByRole("checkbox", { name: "允许使用灵件", exact: true }).waitFor()
    const calls = await page.evaluate(() => window["calls"])
    assert(calls.some((x) => x[0] === "dir" && x[1] === "capabilities"))
    assert(calls.some((x) => x[0] === "zip" && x[1] === "plain.zip" && x[4] === "capabilities"))
    assert.deepEqual(
      calls.filter((x) => x[0] === "enable"),
      [["enable", "native", true]]
    )
    assert.deepEqual(
      calls.filter((x) => x[0] === "derive"),
      [["derive", "native"]]
    )
    assert.deepEqual(
      calls.filter((x) => x[0] === "project"),
      [["project", "native", "AutoBiz original"]]
    )
    assert.deepEqual(
      calls.filter((x) => x[0] === "delete"),
      [["delete", "native"]]
    )
    assert.deepEqual(
      calls.filter((x) => x[0] === "settings"),
      [["settings", "native"]]
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          calls,
          errors,
          limitations: [
            "Actual ModsSettings; controlled host API and feature gate",
            "No real file parsing, hooks, project creation or legacy settings navigation",
            "Null workspace retains extension permission guidance; no authorization execution"
          ]
        },
        null,
        2
      )
    )
    console.log(
      `PASS native imports, explicit enable, feature gate, source ID, cancellation, removal, narrow keyboard UI: ${output}`
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
