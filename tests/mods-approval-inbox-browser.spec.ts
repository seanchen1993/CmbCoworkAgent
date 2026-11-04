/** Real React inbox + native decision broker; no command, network or user profile is used. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { ModApprovalInbox } from "../src/main/ipc/mods-approval-inbox"
import { allowModRequest } from "./support/mods-approval-inbox-e2e"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {ModApprovalInbox} from "./src/renderer/src/components/chat/ModApprovalInbox";
    const api={snapshot:()=>window.nativeSnapshot(),decide:input=>window.nativeDecision(input),
      resume:id=>window.nativeResume(id),onChanged:fn=>{window.addEventListener("approval-changed",fn);return()=>window.removeEventListener("approval-changed",fn)}};
    const root=createRoot(document.getElementById("root"));
    window.api={mods:{approvalInbox:api}};
    window.replaceInboxApi=()=>root.render(<ModApprovalInbox api={{...api}}/>);
    root.render(<ModApprovalInbox api={api}/>);
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let nativeDialogs = 0
  page.on("dialog", async (dialog) => {
    nativeDialogs++
    await dialog.dismiss()
  })
  const inbox = new ModApprovalInbox(() => {
    void page.evaluate(() => window.dispatchEvent(new Event("approval-changed"))).catch(() => {})
  })
  const scope = { workspace: "C:/fixture", threadId: "chat-a", modId: "generic-board" }
  const controller = new AbortController()
  const request = () =>
    inbox.request(
      scope,
      {
        signal: controller.signal,
        message: "灵件请求运行 git",
        detail: "git status --porcelain",
        buttons: ["拒绝", "允许本次命令"]
      },
      () => {}
    )
  let deferredSnapshot: (() => Promise<ReturnType<typeof inbox.snapshot>>) | undefined
  let deferredDecision: (() => Promise<void>) | undefined
  let snapshotReads = 0
  try {
    await page.exposeFunction("nativeSnapshot", () => {
      snapshotReads++
      return deferredSnapshot?.() ?? inbox.snapshot()
    })
    await page.exposeFunction("nativeDecision", async (input) => {
      inbox.decide(input)
      await deferredDecision?.()
    })
    await page.exposeFunction("nativeResume", (input) => inbox.resume(input))
    await page.setContent(
      '<textarea aria-label="聊天输入"></textarea><button id="switch">切换会话</button><p id="destination">会话一</p><div id="root"></div><script>document.getElementById("switch").onclick=()=>document.getElementById("destination").textContent="会话二"</script>'
    )
    const assets = resolve("out/renderer/assets")
    const css =
      existsSync(assets) && readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
    if (css) await page.addStyleTag({ path: resolve(assets, css) })
    mkdirSync("output/mods-approval-inbox", { recursive: true })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const composer = page.getByRole("textbox", { name: "聊天输入" })
    await composer.fill("正在写消息")
    const first = request()
    const badge = page.getByRole("button", { name: "灵件请求待确认（1）", exact: true })
    await badge.waitFor()
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true)
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "允许本次命令" }).count(),
      0,
      "new requests never open the controls or steal focus automatically"
    )
    await page.getByRole("button", { name: "切换会话" }).click()
    assert.equal(await page.locator("#destination").innerText(), "会话二")
    await badge.click()
    await composer.fill("仍可继续输入")
    await page.screenshot({ path: "output/mods-approval-inbox/pending-nonmodal.png" })
    await allowModRequest(page, scope.threadId, scope.modId)
    assert.deepEqual(await first, { response: 1 })
    const second = request()
    await page.getByRole("button", { name: "拒绝并暂停" }).click()
    assert.deepEqual(await second, { response: 0 })
    for (let tick = 0; tick < 100; tick++) assert.throws(request, /MODS_APPROVAL_PAUSED/)
    await page.getByText("generic-board · 会话 chat-a 已暂停请求", { exact: true }).waitFor()
    await page.screenshot({ path: "output/mods-approval-inbox/paused.png" })
    await composer.fill("拒绝后正常聊天")
    assert.equal(await composer.inputValue(), "拒绝后正常聊天")
    await page.getByRole("button", { name: "恢复申请" }).click()
    await page.getByRole("region", { name: "灵件请求" }).waitFor({ state: "hidden" })
    assert.equal(inbox.snapshot().current, null, "resume never replays the denied request")
    const third = request()
    const cancelled = assert.rejects(third, /stopped/)
    await badge.waitFor()
    controller.abort(Error("stopped"))
    await cancelled
    await badge.waitFor({ state: "hidden" })
    // An older failed IPC read must not overwrite a newer successful refresh.
    const entered = Promise.withResolvers<void>()
    const delayed = Promise.withResolvers<ReturnType<typeof inbox.snapshot>>()
    deferredSnapshot = () => {
      entered.resolve()
      return delayed.promise
    }
    await page.evaluate(() => window.dispatchEvent(new Event("approval-changed")))
    await entered.promise
    deferredSnapshot = undefined
    await page.evaluate(() => window.dispatchEvent(new Event("approval-changed")))
    await page.waitForTimeout(50)
    delayed.reject(Error("old disconnected read"))
    await page.waitForTimeout(50)
    assert.equal(
      await page.getByRole("button", { name: "刷新请求" }).count(),
      0,
      "late failure cannot leave a false retry warning after successful refresh"
    )
    const acknowledgement = Promise.withResolvers<void>()
    const deciding = Promise.withResolvers<void>()
    deferredDecision = () => {
      deciding.resolve()
      return acknowledgement.promise
    }
    const old = inbox.request(
      scope,
      {
        message: "旧来源请求",
        signal: new AbortController().signal,
        buttons: ["拒绝", "允许本次命令"]
      },
      () => {}
    )
    await badge.waitFor()
    await page.getByRole("button", { name: "允许本次命令" }).click()
    await deciding.promise
    assert.deepEqual(await old, { response: 1 })
    await page.evaluate(() => (window as unknown as { replaceInboxApi(): void }).replaceInboxApi())
    await page.waitForTimeout(50)
    deferredDecision = undefined
    acknowledgement.reject(Error("old bridge disconnected"))
    await page.waitForTimeout(50)
    assert.equal(
      await page.getByRole("button", { name: "刷新请求" }).count(),
      0,
      "a replaced bridge must not receive the previous operation's late error"
    )
    const readsWhenIdle = snapshotReads
    await page.waitForTimeout(250)
    assert.equal(snapshotReads, readsWhenIdle, "the approval inbox must not poll while idle")
    assert.equal(nativeDialogs, 0)
    assert.deepEqual(errors, [])
    mkdirSync("output/mods-approval-inbox", { recursive: true })
    console.log(
      "PASS non-modal native inbox: focus, navigation/input, 100 denied retries, resume, stop, stale reads/decisions and no idle polling"
    )
  } finally {
    inbox.reset()
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
