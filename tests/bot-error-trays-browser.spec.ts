/** Actual React/Chrome and Node tray/notification services. No model or user data. */
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotErrorTrays } from "../src/main/bots/error-trays"
import { botNotificationChange } from "../src/shared/bot-notifications"
import type { BotClearErrorTrays, BotDismissErrorTray } from "../src/shared/bot-error-trays"

async function main() {
  const store = new BotStore(":memory:")
  const created = store.createBot({ nonce: "error-notice-owner", name: "质量 Bot" })
  const failedReceipt = store.send({
    nonce: "error-notice-history",
    conversationId: created.conversationId,
    text: "受控失败任务"
  })
  const failedRun = store.claim("error-notice-fixture-host")!
  store.finish(failedRun.lease, "failed", "请求频率超限，请稍后重试。", {
    code: "rate_limit",
    status: 429,
    requestId: "req-provider-1"
  })
  const historyAddress = { conversationId: created.conversationId, runId: failedReceipt.runIds[0] }
  const historyBefore = store.runHistory(historyAddress)
  const initial = store.snapshot()
  const authority = { hostId: "fixture-host", dataEpoch: initial.dataEpoch! }
  const trays = new BotErrorTrays(authority)
  const push = (episode: string, groupKey?: string) =>
    trays.push({
      episodeId: episode,
      groupKey,
      title: "模型请求失败",
      detail: "请求频率超限，请稍后重试。",
      source: "run",
      botId: created.bot.id,
      conversationId: created.conversationId,
      runId: failedRun.run.id,
      diagnostic: {
        code: "rate_limit",
        status: 429,
        requestId: "req-provider-1",
        correlationId: "rpc-local-2",
        callId: "usage-call-3"
      }
    })
  for (let index = 0; index < 21; index++) push(`initial-${index}`, `group-${index}`)
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-error-trays")
  await mkdir(output, { recursive: true })
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const workspaceCss = await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import*as Menu from'@radix-ui/react-dropdown-menu';import{BotErrorTrayStack}from'./src/renderer/src/components/bots/BotErrorTrayStack';import{BotNotificationAction}from'./src/renderer/src/components/bots/BotNotificationAction';import{projectBotErrorTraySnapshot}from'./src/renderer/src/lib/bot-error-tray-projection';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';
      applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;window.fixtureClipboardWrites=[];window.fixtureClipboardFails=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.fixtureClipboardFails)throw new Error('clipboard unavailable');window.fixtureClipboardWrites.push(text)}}});window.api={bots:{changeNotifications:input=>window.fixtureNotificationChange(input)}};window.fixtureHistory=[];window.fixtureTraySettled=0;window.fixtureHoldCommit=false;window.fixturePendingCommit=null;
      function Fixture(){const[snapshot,setSnapshot]=useState(${JSON.stringify(trays.snapshot())});const[menu,setMenu]=useState(false);window.fixturePublishTrays=setSnapshot;const invoke=async input=>{try{return await window.fixtureTrayAction(input)}finally{window.fixtureTraySettled++}};const apply=receipt=>{const commit=()=>setSnapshot(current=>projectBotErrorTraySnapshot(current,receipt,{hostId:current.hostId,dataEpoch:current.dataEpoch})??current);if(window.fixtureHoldCommit)window.fixturePendingCommit=commit;else commit()};return <div className="bot-workspace bg-background text-foreground" style={{display:"flex",height:"100vh",containerType:"inline-size",containerName:"bot-workspace"}}><aside className="bot-sidebar flex shrink-0 flex-col border-r" data-testid="bot-sidebar"><div className="flex-1"/><footer className="bot-sidebar-footer"><div className="bot-sidebar-footer-status"><BotErrorTrayStack snapshot={snapshot} bots={[{id:"${created.bot.id}",name:"质量 Bot"}]} activeConversationId="${created.conversationId}" onDismiss={async(id,revision)=>{const receipt=await invoke({...snapshot,id,revision,action:'dismiss'});apply(receipt);return receipt}} onClear={async throughRevision=>{const receipt=await invoke({...snapshot,throughRevision,action:'clear'});apply(receipt);return receipt}} onOpenRun={tray=>window.fixtureHistory.push({runId:tray.runId,conversationId:tray.conversationId,threadRootId:tray.threadRootId})} onRestoreFocus={()=>document.getElementById('composer').focus()}/></div></footer></aside><main className="bot-conversation relative min-w-0 flex-1"><Menu.Root open={menu} onOpenChange={setMenu}><Menu.Trigger className="m-4 rounded-lg border px-3 py-2">Bot 通知菜单</Menu.Trigger><Menu.Portal><Menu.Content className="bot-more-menu" sideOffset={8}><BotNotificationAction botId="${created.bot.id}" dataEpoch="${initial.dataEpoch}"/></Menu.Content></Menu.Portal></Menu.Root><div data-testid="composer-area" style={{position:"absolute",bottom:16,left:16,right:16,display:"flex",gap:8}}><input id="composer" aria-label="给 Bot 发送消息" className="min-w-0 flex-1 rounded-xl border px-3 py-2"/><button id="send" className="rounded-xl border px-3 py-2">发送</button></div></main></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    plugins: [
      {
        name: "notification-workspace-fixture",
        setup(context) {
          context.onResolve({ filter: /^@\/lib\/bot-workspace-store$/ }, () => ({
            path: "fixture-workspace",
            namespace: "fixture"
          }))
          context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: process.cwd(),
            contents: `import{create}from'zustand';import{mergeBotNotificationSettings}from'./src/renderer/src/lib/bot-notification-projection';export const useBotWorkspaceStore=create((set,get)=>({snapshot:${JSON.stringify(initial)},error:null,refresh:async()=>{try{const incoming=await window.fixtureNotificationSnapshot();set(current=>({snapshot:{...incoming,notificationSettings:mergeBotNotificationSettings(current.snapshot,incoming)},error:null}))}catch(error){set({error:error.message});throw error}}}));window.fixtureWorkspace=useBotWorkspaceStore;`
          }))
        }
      }
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let holdAction = false,
    pendingAction: (() => void) | undefined
  let loseNotificationReply = false,
    failRefresh = false
  const notificationCalls: unknown[] = []
  let notificationRefreshes = 0
  try {
    await page.exposeFunction(
      "fixtureTrayAction",
      async (input: BotDismissErrorTray & BotClearErrorTrays & { action: "dismiss" | "clear" }) => {
        if (holdAction) {
          holdAction = false
          await new Promise<void>((release) => {
            pendingAction = release
          })
        }
        return input.action === "dismiss"
          ? trays.dismiss({
              hostId: input.hostId,
              dataEpoch: input.dataEpoch,
              id: input.id,
              revision: input.revision
            })
          : trays.clear({
              hostId: input.hostId,
              dataEpoch: input.dataEpoch,
              throughRevision: input.throughRevision
            })
      }
    )
    await page.exposeFunction("fixtureNotificationChange", (raw: unknown) => {
      const input = botNotificationChange.parse(raw)
      notificationCalls.push(input)
      try {
        const value = store.notifications.change(input)
        if (loseNotificationReply) {
          loseNotificationReply = false
          return { botFailure: { code: "connection_closed", message: "返回结果暂时不可用" } }
        }
        return value
      } catch (error) {
        const cause = error as Error & { code: string }
        return {
          botFailure: {
            code: cause.code,
            message: cause.message,
            diagnostic: { code: cause.code, correlationId: "rpc-notification-local" }
          }
        }
      }
    })
    await page.exposeFunction("fixtureNotificationSnapshot", () => {
      notificationRefreshes++
      if (failRefresh) throw new Error("暂时无法读取后台状态")
      return store.snapshot()
    })
    await page.route("http://127.0.0.1:39181/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><style>${css.build(scanner.scan())}${workspaceCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39181")
    const stack = page.getByRole("region", { name: "Bot 错误通知" })
    const toggle = page.getByRole("button", { name: "查看全部错误通知", exact: true })
    await toggle.waitFor()
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    assert.equal(await stack.count(), 0, "old errors remain behind an explicit status entry")
    assert.equal(await toggle.locator("[data-error-tray-count]").innerText(), "20")
    const announcement = page.locator("[data-error-tray-announcement]")
    assert.match(await announcement.innerText(), /质量 Bot：请求速率限制/)
    assert.doesNotMatch(await announcement.innerText(), /req-provider-1|rpc-local-2|usage-call-3/)
    const assertClearComposer = async () => {
      const entry = await toggle.boundingBox()
      assert.ok(entry)
      assert.ok(
        entry.width <= 36 && entry.height <= 36,
        "collapsed status has a compact hit target"
      )
      for (const selector of ["#composer", "#send"]) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box)
        assert.ok(
          entry.x + entry.width <= box.x ||
            box.x + box.width <= entry.x ||
            entry.y + entry.height <= box.y ||
            box.y + box.height <= entry.y,
          `notification entry must not cover ${selector}`
        )
      }
    }
    for (const [theme, width] of [
      ["codex-light", 1100],
      ["codex-dark", 560]
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(
        (theme) => (window as unknown as { fixtureTheme(t: string): void }).fixtureTheme(theme),
        theme
      )
      await assertClearComposer()
      assert.equal(
        (await page.getByTestId("bot-sidebar").boundingBox())?.width,
        width < 650 ? 68 : 264,
        "fixture must exercise the production sidebar's actual compact geometry"
      )
      await page.screenshot({
        path: join(output, `trays-compact-${theme}-${width}.png`),
        animations: "disabled"
      })
    }
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.evaluate("window.fixtureTheme('codex-light')")
    const composer = page.getByRole("textbox", { name: "给 Bot 发送消息", exact: true })
    await composer.focus()
    push("same-group-collapsed-update", "group-20")
    await page.evaluate(
      (snapshot) =>
        (window as unknown as { fixturePublishTrays(value: unknown): void }).fixturePublishTrays(
          snapshot
        ),
      trays.snapshot()
    )
    await page.waitForFunction(() =>
      document.querySelector("[data-error-tray-announcement]")?.textContent?.includes("发生 2 次")
    )
    assert.match(await announcement.innerText(), /发生 2 次/)
    assert.equal(await toggle.locator("[data-error-tray-count]").innerText(), "20")
    assert.equal(
      await composer.evaluate((element) => document.activeElement === element),
      true,
      "incoming error must not move composer focus"
    )
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    await toggle.click()
    await stack.waitFor()
    assert.equal(await toggle.getAttribute("aria-expanded"), "true")
    assert.match(await stack.innerText(), /质量 Bot/)
    assert.match(await stack.innerText(), /当前对话/)
    assert.ok(await stack.locator("time[datetime]").count())
    const notices = stack.locator("[data-error-tray-id]")
    assert.equal(await notices.count(), 20, "Node and UI cap error notices at twenty")
    await page.screenshot({ path: join(output, "trays-list-light.png"), animations: "disabled" })
    assert.ok(
      await stack
        .locator("ol")
        .evaluate(
          (element) => element.parentElement!.scrollHeight > element.parentElement!.clientHeight
        )
    )
    assert.ok(
      await stack
        .locator("ol")
        .evaluate((element) => element.parentElement!.clientHeight <= 900 * 0.24 + 1),
      "only the explicitly expanded list can use up to 24vh"
    )
    await notices.first().getByRole("button", { name: "查看任务记录", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.fixtureHistory"), [
      { runId: failedRun.run.id, conversationId: created.conversationId, threadRootId: undefined }
    ])
    assert.equal(
      await notices.first().getByRole("button", { name: "复制服务请求 ID", exact: true }).count(),
      0,
      "raw provider IDs are available only through explicit details"
    )
    await notices.first().getByRole("button", { name: "查看详情", exact: true }).click()
    await page.evaluate("window.fixtureClipboardFails=true")
    await notices.first().getByRole("button", { name: "复制服务请求 ID", exact: true }).click()
    const manual = notices
      .first()
      .getByRole("textbox", { name: "手动复制服务请求 ID", exact: true })
    await manual.waitFor()
    assert.equal(await manual.inputValue(), "req-provider-1")
    await manual.focus()
    assert.equal(
      await manual.evaluate((element) => (element as HTMLInputElement).selectionEnd),
      "req-provider-1".length
    )
    assert.match(await notices.first().innerText(), /原始错误/)
    assert.match(await notices.first().innerText(), /本地关联 ID/)
    assert.match(await notices.first().innerText(), /模型调用 ID/)
    await page.evaluate("window.fixtureClipboardFails=false")
    await notices.first().getByRole("button", { name: "复制本地关联 ID", exact: true }).click()
    await notices.first().getByText("已复制", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixtureClipboardWrites"), ["rpc-local-2"])
    await page.screenshot({ path: join(output, "trays-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "trays-dark.png"), animations: "disabled" })
    const beforeUpdateOrder = await notices.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-error-tray-id"))
    )
    const detailControl = notices.first().getByRole("button", { name: "收起详情", exact: true })
    await detailControl.focus()
    push("focused-detail-update", "group-20")
    await page.evaluate(
      (snapshot) =>
        (window as unknown as { fixturePublishTrays(snapshot: unknown): void }).fixturePublishTrays(
          snapshot
        ),
      trays.snapshot()
    )
    assert.deepEqual(
      await notices.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-error-tray-id"))
      ),
      beforeUpdateOrder,
      "incoming errors retain the existing row order"
    )
    assert.equal(
      await detailControl.evaluate((element) => document.activeElement === element),
      true,
      "new error revisions must not move focus or close the user's diagnostics"
    )
    const waitForAction = async () => {
      for (let index = 0; index < 100 && !pendingAction; index++) await page.waitForTimeout(10)
      assert.ok(pendingAction, "mutation must reach the held Node action")
    }
    const publish = async () =>
      page.evaluate(
        (snapshot) =>
          (
            window as unknown as { fixturePublishTrays(snapshot: unknown): void }
          ).fixturePublishTrays(snapshot),
        trays.snapshot()
      )
    const first = trays.snapshot().items[0]
    holdAction = true
    await notices
      .first()
      .getByRole("button", { name: "关闭通知：模型请求失败", exact: true })
      .click()
    await waitForAction()
    const sameGroup = Number(first.count) === 1 ? "group-1" : "unexpected"
    push("concurrent-update", sameGroup)
    await publish()
    pendingAction!()
    pendingAction = undefined
    await stack.getByText("通知已更新，请查看后再关闭", { exact: true }).waitFor()
    assert.equal(trays.snapshot().items.find((item) => item.id === first.id)?.count, 2)
    assert.equal(await notices.count(), 20)
    const dismiss = notices
      .first()
      .getByRole("button", { name: "关闭通知：模型请求失败", exact: true })
    await dismiss.focus()
    // A projected ACK may precede the actual React props commit. Keep the old
    // row connected across two frames, then commit its removal; focus must be
    // restored after that commit rather than abandoned by an early RAF.
    await page.evaluate("window.fixtureHoldCommit=true")
    await dismiss.press("Enter")
    await page.waitForFunction(
      () =>
        !!(window as unknown as { fixturePendingCommit: (() => void) | null }).fixturePendingCommit
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await page.evaluate(
      "window.fixtureHoldCommit=false;window.fixturePendingCommit();window.fixturePendingCommit=null"
    )
    await page.waitForFunction(
      () => document.querySelectorAll("[data-error-tray-id]").length === 19
    )
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-error-dismiss"))
    holdAction = true
    await stack.getByRole("button", { name: "全部清除", exact: true }).click()
    await waitForAction()
    const newNotice = push("arrived-during-clear").items.at(-1)!
    await publish()
    pendingAction!()
    pendingAction = undefined
    await page.waitForFunction(
      (id) =>
        document.querySelectorAll("[data-error-tray-id]").length === 1 &&
        document.querySelector("[data-error-tray-id]")?.getAttribute("data-error-tray-id") === id,
      newNotice.id
    )
    assert.deepEqual(
      trays.snapshot().items.map((item) => item.id),
      [newNotice.id]
    )
    const collapse = stack.getByRole("button", { name: "收起错误通知", exact: true })
    await collapse.focus()
    await collapse.press("Escape")
    const reopen = page.getByRole("button", { name: "查看全部错误通知", exact: true })
    assert.equal(await reopen.getAttribute("aria-expanded"), "false")
    assert.equal(await reopen.evaluate((element) => document.activeElement === element), true)
    await reopen.click()
    await page.emulateMedia({ reducedMotion: "reduce" })
    push("reduced-motion")
    await publish()
    await page.waitForFunction(() => document.querySelectorAll("[data-error-tray-id]").length === 2)
    assert.equal(
      await notices.last().evaluate((element) => getComputedStyle(element).animationName),
      "none"
    )
    holdAction = true
    await notices
      .first()
      .getByRole("button", { name: "关闭通知：模型请求失败", exact: true })
      .click()
    await waitForAction()
    await page.getByRole("textbox", { name: "给 Bot 发送消息", exact: true }).click()
    pendingAction!()
    pendingAction = undefined
    await page.waitForFunction(() => document.querySelectorAll("[data-error-tray-id]").length === 1)
    assert.equal(
      await page
        .getByRole("textbox", { name: "给 Bot 发送消息", exact: true })
        .evaluate((element) => document.activeElement === element),
      true
    )
    holdAction = true
    await notices
      .first()
      .getByRole("button", { name: "关闭通知：模型请求失败", exact: true })
      .click()
    await waitForAction()
    const settledBeforeRestore = (await page.evaluate("window.fixtureTraySettled")) as number
    trays.setDataEpoch("restored-epoch")
    const restored = push("after-restore").items[0]
    await publish()
    pendingAction!()
    pendingAction = undefined
    await page.waitForFunction(
      (count) => (window as unknown as { fixtureTraySettled: number }).fixtureTraySettled > count,
      settledBeforeRestore
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await page.getByRole("button", { name: "查看全部错误通知", exact: true }).waitFor()
    assert.equal(await stack.count(), 0, "a restored Host scope starts closed")
    assert.equal(
      await page.getByText("后台已切换，请刷新通知后重试", { exact: true }).count(),
      0,
      "unmounted old scope must not publish local feedback"
    )
    const restoredTrigger = page.getByRole("button", { name: "查看全部错误通知", exact: true })
    assert.equal(await restoredTrigger.getAttribute("aria-expanded"), "false")
    await restoredTrigger.click()
    await page.waitForFunction(
      (id) =>
        document.querySelector("[data-error-tray-id]")?.getAttribute("data-error-tray-id") === id,
      restored.id
    )
    const lastDismiss = stack.getByRole("button", { name: "关闭通知：模型请求失败", exact: true })
    await lastDismiss.focus()
    await lastDismiss.press("Enter")
    await page.waitForFunction(() => document.querySelectorAll("[data-error-tray-id]").length === 0)
    await page.waitForFunction(() => document.activeElement?.id === "composer")
    push("new-failure-after-empty")
    await publish()
    const freshTrigger = page.getByRole("button", { name: "查看全部错误通知", exact: true })
    await freshTrigger.waitFor()
    assert.equal(
      await freshTrigger.getAttribute("aria-expanded"),
      "false",
      "new errors cannot reopen a previously emptied popup"
    )
    assert.equal(await composer.evaluate((element) => document.activeElement === element), true)
    assert.equal(await freshTrigger.locator("[data-error-tray-count]").innerText(), "1")
    await freshTrigger.click()
    await stack.getByRole("button", { name: "关闭通知：模型请求失败", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector("[data-error-tray-trigger]"))
    assert.deepEqual(
      store.runHistory(historyAddress),
      historyBefore,
      "closing the last notice and clearing notifications must retain the failed task history"
    )
    store.notifications.change({
      botId: created.bot.id,
      dataEpoch: initial.dataEpoch!,
      revision: 0,
      enabled: false,
      nonce: "external-mute"
    })
    await page.getByRole("button", { name: "Bot 通知菜单", exact: true }).click()
    const menu = page.getByRole("menu")
    await menu.getByRole("menuitem", { name: "关闭 Bot 通知", exact: true }).click()
    await menu
      .getByRole("alert")
      .getByText("通知设置已变化，请刷新后重试", { exact: true })
      .waitFor()
    assert.equal(
      await page.evaluate("window.fixtureWorkspace.getState().error"),
      null,
      "handled setting conflict must not become a connection error"
    )
    await menu.getByRole("menuitem", { name: "开启 Bot 通知", exact: true }).waitFor()
    const settingItem = menu.getByRole("menuitem", { name: "开启 Bot 通知", exact: true })
    await settingItem.focus()
    await settingItem.press("Tab")
    assert.equal(
      await menu
        .getByRole("button", { name: "查看详情", exact: true })
        .evaluate((element) => document.activeElement === element),
      true
    )
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")
    assert.equal(
      await menu
        .getByRole("button", { name: "复制本地关联 ID", exact: true })
        .evaluate((element) => document.activeElement === element),
      true
    )
    await page.keyboard.press("Enter")
    await menu.getByText("已复制", { exact: true }).waitFor()
    loseNotificationReply = true
    await menu.getByRole("menuitem", { name: "开启 Bot 通知", exact: true }).click()
    await menu.getByRole("menuitem", { name: "重试通知设置", exact: true }).waitFor()
    const lost = notificationCalls.at(-1)
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "Bot 通知菜单", exact: true }).click()
    await menu.getByRole("menuitem", { name: "重试通知设置", exact: true }).click()
    await menu.getByText("通知设置已保存", { exact: true }).waitFor()
    assert.deepEqual(
      notificationCalls.at(-1),
      lost,
      "closing/reopening retries the exact durable request"
    )
    const beforeAccepted = notificationCalls.length
    failRefresh = true
    await menu.getByRole("menuitem", { name: "关闭 Bot 通知", exact: true }).click()
    await menu.getByRole("menuitem", { name: "重新读取通知设置", exact: true }).waitFor()
    assert.equal(notificationCalls.length, beforeAccepted + 1)
    const beforeRefresh = notificationRefreshes
    failRefresh = false
    await menu.getByRole("menuitem", { name: "重新读取通知设置", exact: true }).click()
    await menu.getByText("通知设置已保存", { exact: true }).waitFor()
    assert.equal(notificationRefreshes, beforeRefresh + 1)
    assert.equal(
      notificationCalls.length,
      beforeAccepted + 1,
      "after acknowledgement retry only reads, never resubmits"
    )
    assert.equal(store.notifications.list()[0].enabled, false)
    assert.deepEqual(errors, [])
    console.log(
      "PASS Node/Chrome error trays: sidebar status/true composer geometry, explicit 24vh popover/list/details, owner/time, same-count announcements, empty-to-new remains closed, no incoming focus/reorder, twenty cap, CAS update, clear cutoff, copy fallback, distinct IDs, focus, reduced motion, scope isolation; notification conflict/unknown receipt/read-only sync retry"
    )
  } finally {
    pendingAction?.()
    await browser.close()
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
