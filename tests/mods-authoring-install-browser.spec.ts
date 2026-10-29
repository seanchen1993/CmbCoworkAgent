import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/mods-harness-20261009", `authoring-install-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const component = resolve(
    process.env.CREATOR_RECOVERY_STAGE ?? ".",
    "src/renderer/src/components/customize/AuthoringInstallPanel.tsx"
  )
  const customize = resolve("src/renderer/src/components/customize/CustomizeView.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react";import{createRoot}from"react-dom/client";
      import{AuthoringInstallPanel}from${JSON.stringify(component)};
      import{CustomizeView}from${JSON.stringify(customize)};
      const root=createRoot(document.getElementById("root")),calls=[];
      let deferred=false,finish,applyState="settled",key=0;
      const candidate=input=>({review:{strictCompatible:true,typesValid:true,modelProtocol:"result-v1",sdkMethods:["command.register"],configurationKeys:["theme"],components:[{id:"main",dependsOn:[]}],changedFiles:[{path:"mods/main.ts",change:"changed"}]},handle:"handle",installationId:"installation",versionId:"new-version",...(input.versionId?{restoredFromVersionId:input.versionId}:{}),name:"Example",sourceDigest:"a".repeat(64),compiledDigest:"b".repeat(64),catalogDigest:"c".repeat(64),currentVersionId:"old-version",configuration:input.restoreConfiguration?"restore":"unchanged"});
      const prepare=async input=>{calls.push(["prepare",structuredClone(input)]);const value={ok:true,value:candidate(input)};return deferred?new Promise(resolve=>{finish=()=>resolve(value)}):value};
      const api={list:async thread=>{calls.push(["list",thread]);return{ok:true,value:{workspace:thread,installations:[{installationId:"installation",name:"Example",currentVersionId:"old-version",versions:[{versionId:"old-version",sourceDigest:"a".repeat(64),compiledDigest:"b".repeat(64),createdAt:0,revision:1}]}]}}},prepare,rollbackPrepare:prepare,
        apply:async input=>{calls.push(["apply",input]);return applyState==="BUSY"?{ok:false,code:"BUSY"}:{ok:true,value:{operationId:"operation",installationId:"installation",versionId:"new-version",state:applyState}}},
        cancel:async input=>{calls.push(["cancel",input]);return{ok:true,value:undefined}}};
      const show=(thread="one",dirty=false,available=true)=>root.render(<AuthoringInstallPanel threadId={thread} workspace={thread} dirty={dirty} api={available?api:undefined} document={{id:"draft",name:"Example",currentRevision:1,revision:1,updatedAt:0,workspace:thread,source:{schemaVersion:1,digest:"a".repeat(64),files:[]},versions:[]}}/>);
      window.initialTab="general";window.panelMounted=[];window.modeCalls=[];
      window.installFixture={calls,show,defer:value=>deferred=value,finish:()=>finish(),apply:value=>applyState=value,mode:tab=>{window.initialTab=tab;root.render(<CustomizeView key={++key}/>)} };
      show("one",true);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "mode-ui-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^@\/lib\/utils$/ }, () => ({
            path: "utils",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^@\/components\/ui\/button$/ }, () => ({
            path: "button",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^\.\/(?:[A-Za-z]+Panel|AssistantWorkbench)$/ }, (args) =>
            args.importer.endsWith("CustomizeView.tsx")
              ? { path: args.path.slice(2), namespace: "panel" }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "panel" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "tsx",
            contents: `import React,{useEffect}from"react";export function ${args.path}(){useEffect(()=>{window.panelMounted.push(${JSON.stringify(args.path)})},[]);return <p>${args.path} content</p>}`
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "tsx",
            contents:
              args.path === "store"
                ? 'const read=()=>({accountRevision:0,showCustomizeView:true,customizeInitialTab:window.initialTab,currentThreadId:"one",threads:[],setShowCustomizeView:value=>window.modeCalls.push(value)});export const useAppStore=selector=>selector?selector(read()):read();useAppStore.getState=read;useAppStore.subscribe=()=>()=>{};'
                : args.path === "utils"
                  ? 'export const cn=(...values)=>values.filter(Boolean).join(" ");'
                  : 'import React from"react";export function Button({children,variant,size,...props}){return <button {...props}>{children}</button>}'
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 } })
  const checks: string[] = [],
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
    )
    await page.goto("http://fixture.test/")
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const css = readdirSync(resolve("out/renderer/assets")).find((name) =>
      /^index-.*\.css$/.test(name)
    )
    if (css) await page.addStyleTag({ path: resolve("out/renderer/assets", css) })
    assert.equal(await page.getByRole("button", { name: "准备安装当前版本" }).isDisabled(), true)
    assert.deepEqual(await page.evaluate("window.installFixture.calls"), [])
    await page.evaluate("window.installFixture.show('one',false)")
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "准备安装当前版本" && !button.disabled
      )
    )
    await page
      .getByRole("button", { name: "准备安装当前版本" })
      .evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
    await page.getByLabel("待应用版本审阅").waitFor()
    await page.getByText("代码使用的接口：command.register", { exact: false }).waitFor()
    await page.getByText("配置项：theme", { exact: false }).waitFor()
    checks.push(
      "Prepared review shows static compatibility, SDK methods, config keys and version changes without granting capabilities"
    )
    assert.equal(
      await page.evaluate("window.installFixture.calls.filter(c=>c[0]==='prepare').length"),
      1
    )
    assert.equal(
      await page.evaluate("window.installFixture.calls.filter(c=>c[0]==='apply').length"),
      0
    )
    checks.push(
      "Dirty source cannot prepare; duplicate clicks create one candidate, never auto apply"
    )
    await page.screenshot({ path: join(output, "installation-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 900 })
    await page.screenshot({ path: join(output, "installation-narrow.png"), fullPage: true })
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true)
    await page.setViewportSize({ width: 1050, height: 900 })
    await page.evaluate("window.installFixture.apply('BUSY')")
    await page.getByRole("button", { name: "确认安装此版本" }).click()
    await page.getByRole("alert").filter({ hasText: "待安装版本已保留" }).waitFor()
    assert.equal(await page.getByLabel("待应用版本审阅").count(), 1)
    await page.evaluate("window.installFixture.apply('partial')")
    await page.getByRole("button", { name: "确认安装此版本" }).click()
    await page
      .getByText("安装尚未全部完成。请刷新安装记录，查看还需要处理什么。", { exact: true })
      .waitFor()
    assert.equal(await page.getByLabel("待应用版本审阅").count(), 0)
    checks.push(
      "Busy apply preserves candidate; partial outcome never claims completed installation"
    )
    await page.getByRole("button", { name: "刷新安装记录" }).click()
    await page
      .getByLabel("选择要恢复的旧版本", { exact: true })
      .selectOption("installation/old-version")
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "预览恢复旧版本" }).click()
    await page.getByText("恢复这个版本保存的设置", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        "window.installFixture.calls.filter(c=>c[0]==='prepare').at(-1)[1].restoreConfiguration"
      ),
      true
    )
    await page.getByRole("button", { name: "取消本次安装" }).click()
    await page
      .getByText(
        "已取消本次安装，草稿仍保留。正在使用的版本和助手组合不变。",
        { exact: true }
      )
      .waitFor()
    checks.push(
      "Rollback separately selects historical source and explicit configuration restoration"
    )
    await page.evaluate("window.installFixture.defer(true)")
    await page.getByRole("button", { name: "准备安装当前版本" }).click()
    await page.getByRole("button", { name: "取消本次安装" }).click()
    await page.evaluate("window.installFixture.finish()")
    assert.equal(await page.getByLabel("待应用版本审阅").count(), 0)
    await page.getByRole("button", { name: "准备安装当前版本" }).click()
    await page.evaluate("window.installFixture.show('two',false);window.installFixture.finish()")
    await page.getByRole("button", { name: "准备安装当前版本" }).waitFor()
    assert.equal(await page.getByLabel("待应用版本审阅").count(), 0)
    checks.push("Cancellation and thread changes reject late prepared results")
    await page.evaluate("window.installFixture.show('two',false,false)")
    await page.getByText("当前暂不支持安装，可以先保存文件并试用。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "准备安装当前版本" }).count(), 0)
    checks.push("Unconnected service exposes no pretend install actions")
    await page.evaluate("localStorage.clear();window.installFixture.mode('general')")
    await page.getByText("GeneralPanel content", { exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole("button", { name: "基础功能", exact: true })
        .getAttribute("aria-expanded"),
      "true"
    )
    assert.equal(await page.getByRole("button", { name: "普通模式", exact: true }).count(), 0)
    await page.getByRole("button", { name: "插件", exact: true }).waitFor()
    await page.getByRole("navigation").filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) }).getByRole("button", { name: "插件", exact: true }).click()
    await page.getByText("ModsPanel content", { exact: true }).waitFor()
    const mounted = await page.evaluate("window.panelMounted.filter(x=>x==='ModsPanel').length")
    await page.getByRole("button", { name: "基础功能", exact: true }).click()
    assert.equal(await page.getByText("ModsPanel content", { exact: true }).isVisible(), true)
    await page.getByRole("navigation").filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) }).getByRole("button", { name: "插件", exact: true }).waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "基础功能", exact: true }).click()
    await page.getByRole("navigation").filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) }).getByRole("button", { name: "插件", exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.panelMounted.filter(x=>x==='ModsPanel').length"),
      mounted
    )
    assert.deepEqual(await page.evaluate("window.modeCalls"), [])
    await page.screenshot({ path: join(output, "creator-navigation.png"), fullPage: true })
    checks.push(
      "Grouped navigation retains UAT entries; collapsing a group preserves mounted work and changes no thread/runtime setting"
    )
    await page.evaluate("localStorage.clear();window.installFixture.mode('flows')")
    await page.getByText("FlowsPanel content", { exact: true }).waitFor()
    assert.equal(await page.evaluate("window.panelMounted.filter(x=>x==='FlowsPanel').length"), 1)
    checks.push("Creator deep link opens the requested panel without an obsolete mode gate")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
    console.log(`PASS ${checks.length} browser checks: ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
