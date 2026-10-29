import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const artifacts = resolve("output/mods-usage-entry", String(Date.now()))
  mkdirSync(artifacts, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {ModsUsageSetup} from ${JSON.stringify(resolve(renderer, "components/customize/ModsUsageSetup.tsx"))};
      import {ModsUsageSettingsEntry} from ${JSON.stringify(resolve(renderer, "components/customize/ModsUsageSettingsEntry.tsx"))};
      import {useAppStore} from "@/lib/store";
      const host=createRoot(document.getElementById("root"));
      const calls=[];let global=false,enabled=false,outputPolicy=true,recovery=null,wrongWorkspace=false,pauseGlobal=false,release;
      const listeners=new Set();
      window.api={mods:{globalEnabled:async()=>{calls.push(["global-read"]);return global},
        status:async thread=>{calls.push(["status",thread]);return {workspace:wrongWorkspace?"C:/other":"C:/"+thread,enabled,outputPolicy,recovery,mods:[],functionMods:[],diagnostics:[]}},
        configureGlobal:async value=>{calls.push(["global-write",value]);global=value;if(pauseGlobal)await new Promise(done=>release=done);return global},
        configure:async(...args)=>{calls.push(["workspace-write",...args]);enabled=args[1]},
        onConfigurationChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}
      }};
      const render=()=>{const s=useAppStore.getState();host.render(<main><ModsUsageSettingsEntry/><ModsUsageSetup threadId={s.currentThreadId} workspaceHint={"C:/"+s.currentThreadId}/></main>)};
      window.fixture={calls,reset:()=>{global=false;enabled=false;outputPolicy=true;recovery=null;wrongWorkspace=false;pauseGlobal=false;calls.length=0;useAppStore.patch({currentThreadId:"a",accountRevision:useAppStore.getState().accountRevision+1});render()},
        navigate:(id,account=false)=>{useAppStore.patch({currentThreadId:id,accountRevision:useAppStore.getState().accountRevision+(account?1:0)});render()},
        pause:()=>{pauseGlobal=true},release:()=>{pauseGlobal=false;release()},
        recovery:()=>{recovery="CONTROL_DATABASE_UNAVAILABLE";for(const cb of listeners)cb()},
        wrong:()=>{wrongWorkspace=true;for(const cb of listeners)cb()},
        policy:value=>{outputPolicy=value},writes:()=>calls.filter(row=>row[0].endsWith("-write")),render};
      render();`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "native-boundary",
        setup(b) {
          b.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: `import{useSyncExternalStore}from"react";
        let state={currentThreadId:"a",accountRevision:0,showCustomizeView:false,
          threads:[{thread_id:"a",metadata:{workspacePath:"C:/a"}},{thread_id:"b",metadata:{workspacePath:"C:/b"}}]};
        const listeners=new Set();export const useAppStore=selector=>useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb)},()=>selector(state));
        useAppStore.getState=()=>state;useAppStore.patch=patch=>{state={...state,...patch};for(const cb of listeners)cb()};
        state.setShowCustomizeView=(...args)=>{window.navigation=args};`
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const call = (method: string, ...args: unknown[]) =>
    page.evaluate(
      ({ method, args }) =>
        (window as unknown as { fixture: Record<string, (...args: unknown[]) => unknown> }).fixture[
          method
        ](...args),
      { method, args }
    )
  const writes = () => call("writes")
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const enable = page.getByRole("button", { name: "启用应用和当前项目灵件", exact: true })
    await enable.waitFor()
    assert.deepEqual(await writes(), [])
    await page.getByRole("button", { name: "插件", exact: true }).click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { navigation: unknown }).navigation),
      [true, "mods", "installed"]
    )
    assert.deepEqual(await writes(), [], "navigation must never enable a switch")
    assert.match(
      await page.getByRole("region", { name: "当前项目灵件使用" }).innerText(),
      /同目录聊天共用/
    )
    assert.match(
      await page.getByRole("region", { name: "当前项目灵件使用" }).innerText(),
      /恢复其他已经批准/
    )
    await call("policy", false)
    await enable.click()
    await page
      .getByText(
        "已开启应用及当前项目目录的灵件。请继续核对每项灵件的权限与使用范围；任务尚未开始。",
        { exact: true }
      )
      .waitFor()
    assert.deepEqual(await writes(), [
      ["global-write", true],
      ["workspace-write", "a", true, false, "C:/a"]
    ])
    console.log(
      "PASS explicit enable preserves current output policy and navigates without approval or execution"
    )

    await call("reset")
    await enable.waitFor()
    await call("recovery")
    await page
      .getByText("权限设置需要恢复，请到“插件”查看恢复说明。", {
        exact: true
      })
      .waitFor()
    assert.equal(await enable.count(), 0)
    assert.deepEqual(await writes(), [])
    await call("reset")
    await enable.waitFor()
    await call("wrong")
    await page
      .getByRole("alert")
      .getByText("聊天的项目目录已变化，请重新选择聊天后核对。", { exact: true })
      .waitFor()
    assert.equal(await enable.count(), 0)
    assert.deepEqual(await writes(), [])
    console.log("PASS recovery and mismatched workspace cannot be enabled")

    for (const account of [false, true]) {
      await call("reset")
      await enable.waitFor()
      await call("pause")
      await enable.click()
      await page.waitForFunction(
        () =>
          (window as unknown as { fixture: { writes(): unknown[] } }).fixture.writes().length === 1
      )
      await call("navigate", account ? "a" : "b", account)
      await call("release")
      await page.getByRole("button", { name: "启用应用和当前项目灵件", exact: true }).waitFor()
      await page.waitForFunction(() => !document.querySelector("button:disabled"))
      assert.deepEqual(
        await writes(),
        [["global-write", true]],
        "stale continuation must not configure any workspace"
      )
      assert.equal(
        await page
          .getByText(
            "已开启应用及当前项目目录的灵件。请继续核对每项灵件的权限与使用范围；任务尚未开始。",
            { exact: true }
          )
          .count(),
        0
      )
    }
    console.log(
      "PASS switching chat or account during global write fences subsequent workspace writes and stale success"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(artifacts, "mods-usage-settings.png"), fullPage: true })
    await mount(
      page,
      `
      const setupWrites=[];let appEnabled=false,projectEnabled=false;
      profileView.workspace='C:/a';profileView.enabled=false;
      useAppStore.getState().threads=[{thread_id:'a',metadata:{workspacePath:'C:/a',agentMode:'normal'}}];
      window.api.mods.globalEnabled=async()=>appEnabled;
      window.api.mods.status=async()=>({workspace:'C:/a',enabled:projectEnabled,outputPolicy:true,mods:[],functionMods:[],diagnostics:[]});
      window.api.mods.configureGlobal=async value=>{setupWrites.push(['global',value]);appEnabled=value;return value};
      window.api.mods.configure=async(...args)=>{setupWrites.push(['project',...args]);projectEnabled=args[1];profileView.enabled=appEnabled&&projectEnabled};
      window.clawSetup={writes:()=>setupWrites,chat:()=>host.render(<ChatFixture id='a'/>)};
      host.render(<ClawPanel threadId='a' workspaceHint='C:/a'/>);
    `
    )
    await page.getByRole("button", { name: "启用应用和当前项目灵件", exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() =>
        (window as unknown as { clawSetup: { writes(): unknown[] } }).clawSetup.writes()
      ),
      []
    )
    await page.getByRole("button", { name: "启用应用和当前项目灵件", exact: true }).click()
    await page
      .getByText(
        "已开启应用及当前项目目录的灵件。请继续核对每项灵件的权限与使用范围；任务尚未开始。",
        { exact: true }
      )
      .waitFor()
    assert.deepEqual(
      await page.evaluate(() =>
        (window as unknown as { clawSetup: { writes(): unknown[] } }).clawSetup.writes()
      ),
      [
        ["global", true],
        ["project", "a", true, true, "C:/a"]
      ]
    )
    await page.getByRole("button", { name: "插件", exact: true }).click()
    assert.deepEqual(
      await page.evaluate(() =>
        (window as unknown as { fixture: { navigation(): unknown[][] } }).fixture.navigation()
      ),
      [[true, "mods", "installed"]]
    )
    console.log(
      "PASS actual ClawPanel embeds the same explicit setup and direct installed-settings entry"
    )
    console.log("PASS artifacts " + artifacts)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
