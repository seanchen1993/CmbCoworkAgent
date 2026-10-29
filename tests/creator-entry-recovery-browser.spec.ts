/** Real creator entry controls; failed reads and enablement never replay native writes. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"

async function main() {
  const output = resolve("output/creator-entry-recovery-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react";import {createRoot} from "react-dom/client";
      import {ModsDevelopmentPanel} from "./src/renderer/src/components/customize/ModsDevelopmentPanel";
      const root=createRoot(document.getElementById("root")),calls=[];
      let epoch=0,mode="chat",failReads=1,failEnable=true,globalEnabled=false;
      let state={threadId:"creator",workspace:"C:/fixture",mode:"normal",enabled:false,drafts:[],trials:[]};
      const api={status:async()=>{calls.push("read");if(failReads-- > 0)throw Error("read unavailable");return structuredClone(state)},
        onChanged:()=>()=>{},setMode:async input=>{calls.push("mode:"+input.mode);state={...state,mode:input.mode,enabled:true};return structuredClone(state)}};
      const settings={globalEnabled:async()=>globalEnabled,
        status:async()=>({workspace:"C:/fixture",enabled:true,outputPolicy:true,mods:[],diagnostics:[]}),
        configureGlobal:async()=>{calls.push("enable");if(failEnable)throw Error("enable unavailable");globalEnabled=true;return true},
        configure:async()=>{calls.push("configure");throw Error("unexpected workspace write")}};
      window.api={mods:{...settings,development:api}};
      const render=()=>root.render(<ModsDevelopmentPanel key={epoch} threadId="creator" workspaceHint="C:/fixture"
        mode={mode} api={api} settingsApi={settings} onReturnToChat={()=>document.getElementById("composer").focus()}/>);
      window.fixture={calls,reset:next=>{epoch++;mode=next;failReads=1;failEnable=true;globalEnabled=false;
          state={...state,mode:"normal",enabled:false};render()},recoverEnable:()=>{failEnable=false}};
      render();
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
    define: {
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://creator-entry.fixture/bundle.js"'
    },
    logLevel: "error"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const errors: string[] = [],
      checks: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent(
      '<textarea id="composer" aria-label="原聊天输入框"></textarea><div id="root"></div>'
    )
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const count = (kind: string) =>
      page.evaluate(
        (kind) =>
          window.eval(
            "window.fixture.calls.filter(call=>call===" + JSON.stringify(kind) + ").length"
          ),
        kind
      )
    for (const mode of ["chat", "entry"]) {
      if (mode === "entry") await page.evaluate("window.fixture.reset('entry')")
      const entry = page.getByRole("button", {
        name: mode === "chat" ? "创造者模式" : "进入创造者模式",
        exact: true
      })
      const retry = page.getByRole("button", { name: "重新读取状态", exact: true })
      await page.getByRole("status").filter({ hasText: "暂时无法读取创作状态" }).waitFor()
      assert.equal(await entry.isDisabled(), true)
      const reads = await count("read")
      const enables = await count("enable")
      await retry.click()
      await entry.waitFor({ state: "visible" })
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].some(
            (button) => button.textContent === "重新读取状态"
          )
      )
      assert.equal(await entry.isEnabled(), true)
      assert.equal(await count("read"), reads + 1)
      assert.equal(await count("enable"), enables)
      checks.push(`${mode}: failed initial read is visible and explicit retry only reads status`)

      await entry.click()
      await page.getByRole("status").filter({ hasText: "部分开关可能已开启" }).waitFor()
      assert.equal(await count("enable"), enables + 1)
      assert.equal(await count("configure"), 0)
      assert.equal(await count("mode:creator"), mode === "chat" ? 0 : 1)
      assert.equal(await page.getByRole("dialog").count(), 0)
      await retry.click()
      await retry.waitFor({ state: "hidden" })
      assert.equal(await count("enable"), enables + 1)
      assert.equal(await entry.isEnabled(), true)
      checks.push(
        `${mode}: enable failure remains visible; reading status never retries enablement`
      )

      const composer = page.getByRole("textbox", { name: "原聊天输入框", exact: true })
      await composer.fill("继续处理普通聊天")
      if (mode === "entry")
        await page.getByRole("button", { name: "返回原聊天", exact: true }).click()
      assert.equal(await composer.inputValue(), "继续处理普通聊天")
      await page.evaluate("window.fixture.recoverEnable()")
      await entry.click()
      if (mode === "chat") {
        const normal = page.getByRole("button", { name: "普通模式", exact: true })
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="聊天模式"] button')
              ?.getAttribute("aria-pressed") === "false"
        )
        await normal.click()
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="聊天模式"] button')
              ?.getAttribute("aria-pressed") === "true"
        )
      } else {
        await page
          .getByText("已进入创造者模式，请回到原聊天描述要制作、修改或组合的插件。", {
            exact: true
          })
          .waitFor()
      }
      checks.push(
        `${mode}: a fresh user action can enter creator mode after recovery without blocking chat`
      )
    }
    const navigation = await browser.newPage()
    await navigation.setContent(
      '<div data-chat-thread-id="creator"><button aria-pressed="false" disabled>创造者模式</button></div>'
    )
    await navigation.evaluate("window.__name = value => value")
    await navigation.evaluate(() => {
      const chat = document.querySelector("[data-chat-thread-id]")!
      const button = chat.querySelector("button")!
      let clicks = 0
      Object.assign(window, {
        api: {
          mods: {
            development: {
              status: async () => ({
                threadId: "creator",
                workspace: "C:/fixture",
                mode: "creator"
              })
            }
          }
        },
        navigationClicks: () => clicks
      })
      button.addEventListener("click", () => {
        clicks++
        button.setAttribute("aria-pressed", "true")
        chat.setAttribute("aria-hidden", "true")
        const dialog = document.createElement("div")
        dialog.setAttribute("role", "dialog")
        dialog.setAttribute("aria-modal", "true")
        dialog.textContent = "插件创作工作区"
        document.body.append(dialog)
      })
      setTimeout(() => (button.disabled = false), 50)
    })
    await enterModsCreatorChat(navigation, "creator", "C:/fixture")
    assert.equal(await navigation.getByRole("dialog").isVisible(), true)
    assert.equal(await navigation.evaluate("window.navigationClicks()"), 1)
    checks.push("native navigation waits for history readiness and accepts a modal after entry")
    await enterModsCreatorChat(navigation, "creator", "C:/fixture")
    assert.equal(await navigation.evaluate("window.navigationClicks()"), 1)
    checks.push("already active creator behind a modal is observed without replaying the click")
    await navigation.close()
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
