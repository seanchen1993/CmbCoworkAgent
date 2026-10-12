/** Actual React controls and durable pending records; only the IPC reply is a controlled seam. */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

interface EpochFixtureWindow extends Window {
  fixtureWorkspace: { setState(value: unknown): void }
  fixtureVisible(value: boolean): void
  fixtureReply(value: unknown): void
  fixtureCalls: unknown[]
  fixtureRefreshes: number
  fixtureClosed: number
  fixtureChanged: number
  fixtureRemoveBlocked: boolean
  fixtureReadRaw(): string | null
  fixtureCopied: string[]
}
const inputs = {
  avatar: { botId: "owner", revision: 1, nonce: "avatar", pngBase64: null },
  webhook: {
    botId: "owner",
    routineId: "routine",
    revision: 0,
    nonce: "webhook",
    operation: "rotate"
  },
  workflow: {
    conversationId: "conversation",
    runId: "run",
    revision: 1,
    nonce: "workflow",
    operation: "message",
    text: "保留原要求"
  }
}
const keys = {
  avatar: "bot-avatar-pending:owner",
  webhook: "bot-webhook-pending:owner:routine",
  workflow: `bot-workflow-pending:${JSON.stringify(["conversation", "run", null])}`
}
const webhookState = {
  botId: "owner",
  routineId: "routine",
  revision: 0,
  enabled: false,
  routineEnabled: true,
  updatedAt: null,
  lastAcceptedAt: null,
  lastRunId: null,
  url: "http://127.0.0.1:43129/fixture",
  listenerError: null
}
const replies = {
  avatar: { botId: "owner", revision: 2, hash: null },
  webhook: {
    state: { ...webhookState, revision: 1, enabled: true },
    key: "fixture-key-never-a-production-credential"
  },
  workflow: { runId: "run", status: "running", messageId: "message" }
}

async function main() {
  const started = new Date().toISOString(),
    root = resolve(import.meta.dirname, ".."),
    renderer = join(root, "src/renderer/src")
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{BotAvatarEditor}from'./src/renderer/src/components/bots/BotAvatarEditor';
import{BotWebhook}from'./src/renderer/src/components/bots/BotWebhook';
import{BotWorkflowControls}from'./src/renderer/src/components/bots/BotWorkflowControls';
import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
const params=new URL(location.href).searchParams;const control=params.get('control'),recordKind=params.get('record')??'valid';
const key=${JSON.stringify(keys)}[control];
const nativeGet=Storage.prototype.getItem,nativeRemove=Storage.prototype.removeItem;
window.fixtureRemoveBlocked=params.has('cleanup');window.fixtureReadRaw=()=>nativeGet.call(localStorage,key);
Storage.prototype.getItem=function(target){if(recordKind==='unreadable'&&target===key)throw new Error('fixture denied');return nativeGet.call(this,target)};
Storage.prototype.removeItem=function(target){if(window.fixtureRemoveBlocked&&target===key)throw new Error('fixture denied');return nativeRemove.call(this,target)};
window.fixtureCopied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text)=>{window.fixtureCopied.push(text)}},configurable:true});
const initial={host:{capabilities:params.has('oldHost')?[]:['mutation-data-epoch-v2']},snapshot:{dataEpoch:'before',bots:[{id:'owner',name:'验证 Bot',revision:1,avatarHash:params.has('removable')?'a'.repeat(64):null}]},refresh:async()=>{window.fixtureRefreshes++}};
useBotWorkspaceStore.setState(initial);window.fixtureWorkspace=useBotWorkspaceStore;
window.fixtureCalls=[];window.fixtureRefreshes=0;window.fixtureClosed=0;window.fixtureChanged=0;
let webhookView=${JSON.stringify(webhookState)};
const hold=input=>{window.fixtureCalls.push(input);return new Promise(resolve=>{window.fixtureReply=reply=>{if(control==='webhook'&&reply?.state)webhookView=reply.state;resolve(reply)}})};
window.api={bots:{avatar:async()=>null,webhook:async()=>webhookView,changeAvatar:hold,changeWebhook:hold,workflowControl:hold}};
localStorage.clear();if(recordKind!=='empty')localStorage.setItem(key,recordKind==='corrupt'?'original damaged record':JSON.stringify({dataEpoch:recordKind==='obsolete'?'retired':'before',input:${JSON.stringify(inputs)}[control]}));
function Fixture(){const[visible,setVisible]=useState(true);window.fixtureVisible=setVisible;const close=()=>{window.fixtureClosed++;setVisible(false)};return <main className='bg-background p-8 text-foreground'>{visible&&<div data-testid='active-control'>{control==='avatar'?<BotAvatarEditor bot={initial.snapshot.bots[0]} close={close}/>:control==='webhook'?<BotWebhook routine={{id:'routine',botId:'owner',name:'验证例程'}} close={close}/>:<BotWorkflowControls address={{conversationId:'conversation',runId:'run'}} revision={1} status='running' changed={()=>{window.fixtureChanged++}}/>}</div>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    plugins: [
      {
        name: "epoch-state-fixture",
        setup(context) {
          context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
            path: "fixture-workspace",
            namespace: "fixture"
          }))
          context.onResolve({ filter: /use-bot-view-visibility$/ }, () => ({
            path: "fixture-visible",
            namespace: "fixture"
          }))
          context.onLoad({ filter: /fixture-workspace/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: root,
            contents:
              "import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({}));"
          }))
          context.onLoad({ filter: /fixture-visible/, namespace: "fixture" }, () => ({
            loader: "ts",
            contents: "export const useBotViewVisibility=()=>true;"
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css.build(scanner.scan())}\n${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = [],
    cases: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://127.0.0.1:43129/**", (route) =>
      route.fulfill({ contentType: "text/html", body: html })
    )
    for (const control of ["avatar", "webhook", "workflow"] as const) {
      for (const response of ["success", "rejected", "unmounted"] as const) {
        await page.goto(`http://127.0.0.1:43129/?control=${control}`)
        await page
          .getByRole("button", {
            name: control === "workflow" ? "重试原请求" : "核对原操作",
            exact: true
          })
          .click()
        await page.waitForFunction(
          () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 1
        )
        const raw = await page.evaluate((key) => localStorage.getItem(key), keys[control])
        await page.evaluate((unmounted) => {
          const fixture = window as unknown as EpochFixtureWindow
          if (unmounted) fixture.fixtureVisible(false)
          else fixture.fixtureWorkspace.setState({ snapshot: { dataEpoch: "restored", bots: [] } })
        }, response === "unmounted")
        if (response === "unmounted")
          await page.getByTestId("active-control").waitFor({ state: "detached" })
        await page.evaluate(
          async (reply) => {
            ;(window as unknown as EpochFixtureWindow).fixtureReply(reply)
            await new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))
            )
          },
          response === "rejected"
            ? { botFailure: { code: "revision_conflict", message: "版本已改变" } }
            : replies[control]
        )
        const result = await page.evaluate((key) => {
          const fixture = window as unknown as EpochFixtureWindow
          return {
            pending: localStorage.getItem(key),
            calls: fixture.fixtureCalls.length,
            refreshes: fixture.fixtureRefreshes,
            closed: fixture.fixtureClosed,
            changed: fixture.fixtureChanged
          }
        }, keys[control])
        assert.equal(result.calls, 1)
        assert.equal(
          result.pending,
          response === "unmounted" ? null : raw,
          `${control}/${response}: retired record must survive`
        )
        assert.equal(
          result.refreshes,
          0,
          `${control}/${response}: old view must not refresh the new workspace`
        )
        assert.equal(
          result.closed,
          0,
          `${control}/${response}: unmounted or retired view cannot close another view`
        )
        assert.equal(
          result.changed,
          0,
          `${control}/${response}: unmounted or retired view cannot notify another task`
        )
        if (response !== "unmounted") {
          await page.getByText("数据已恢复", { exact: false }).waitFor()
          assert.equal(
            await page.getByRole("textbox", { name: "Webhook 密钥", exact: true }).count(),
            0
          )
        }
        cases.push(
          `${control}: ${response} acknowledgement fenced by current workspace epoch and view lifetime`
        )
      }
    }
    for (const control of ["avatar", "webhook", "workflow"] as const) {
      const retry = () =>
        page.getByRole("button", {
          name: control === "workflow" ? "重试原请求" : "核对原操作",
          exact: true
        })
      for (const record of ["obsolete", "corrupt", "unreadable"] as const) {
        await page.goto(`http://127.0.0.1:43129/?control=${control}&record=${record}`)
        await page
          .getByRole("alert")
          .filter({ hasText: record === "obsolete" ? "恢复前" : "无法读取" })
          .waitFor()
        const raw = await page.evaluate(() =>
          (window as unknown as EpochFixtureWindow).fixtureReadRaw()
        )
        const mutation = page.getByRole("button", {
          name:
            control === "avatar"
              ? "上传图片"
              : control === "webhook"
                ? "生成密钥并启用"
                : "补充要求",
          exact: true
        })
        await mutation.waitFor()
        assert.equal(
          await mutation.isDisabled(),
          true,
          `${control}/${record}: new effects are blocked`
        )
        assert.equal(
          await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCalls.length),
          0
        )
        if (record !== "unreadable") {
          assert.equal(
            await page.getByRole("button", { name: "清除此条记录", exact: true }).isDisabled(),
            true
          )
          await page.getByRole("button", { name: "复制原记录", exact: true }).click()
          await page.getByText("原记录已复制", { exact: true }).waitFor()
          assert.deepEqual(
            await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCopied),
            [raw]
          )
          await page.getByRole("checkbox").check()
          await page.getByRole("button", { name: "清除此条记录", exact: true }).click()
          await page.waitForFunction(
            () => (window as unknown as EpochFixtureWindow).fixtureReadRaw() === null
          )
          assert.equal(await mutation.isEnabled(), true)
        } else {
          assert.equal(
            await page.getByRole("button", { name: "复制原记录", exact: true }).count(),
            0
          )
          assert.equal(
            await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureReadRaw()),
            raw
          )
        }
        assert.equal(
          await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCalls.length),
          0
        )
        cases.push(
          `${control}/${record}: exact retained record is protected and explicit archive has no effect`
        )
      }
      await page.goto(`http://127.0.0.1:43129/?control=${control}`)
      const raw = await page.evaluate(() =>
        (window as unknown as EpochFixtureWindow).fixtureReadRaw()
      )
      await retry().click()
      await page.waitForFunction(
        () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as EpochFixtureWindow).fixtureReply({
          botFailure: { code: "transport_unavailable", message: "连接已中断" }
        })
      )
      await page.getByText("连接已中断", { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureReadRaw()),
        raw
      )
      await retry().click()
      await page.waitForFunction(
        () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 2
      )
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCalls),
        [inputs[control], inputs[control]]
      )
      await page.evaluate(
        (reply) => (window as unknown as EpochFixtureWindow).fixtureReply(reply),
        replies[control]
      )
      await page.waitForFunction(
        () => (window as unknown as EpochFixtureWindow).fixtureReadRaw() === null
      )
      cases.push(`${control}: unknown response retries the original full payload and nonce`)
      for (const result of ["success", "rejected"] as const) {
        await page.goto(`http://127.0.0.1:43129/?control=${control}&cleanup=1`)
        const raw = await page.evaluate(() =>
          (window as unknown as EpochFixtureWindow).fixtureReadRaw()
        )
        await retry().click()
        await page.waitForFunction(
          () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 1
        )
        await page.evaluate(
          (reply) => (window as unknown as EpochFixtureWindow).fixtureReply(reply),
          result === "success"
            ? replies[control]
            : { botFailure: { code: "revision_conflict", message: "版本已改变" } }
        )
        await page.getByText("本机记录尚未清除", { exact: false }).waitFor()
        assert.equal(
          await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureReadRaw()),
          raw
        )
        await retry().click()
        await page.getByText("本机记录尚未清除", { exact: false }).waitFor()
        assert.equal(
          await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCalls.length),
          1
        )
        await page.evaluate(() => {
          ;(window as unknown as EpochFixtureWindow).fixtureRemoveBlocked = false
        })
        await retry().click()
        await page.waitForFunction(
          () => (window as unknown as EpochFixtureWindow).fixtureReadRaw() === null
        )
        assert.equal(
          await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCalls.length),
          1
        )
        cases.push(`${control}/${result}: known receipt cleanup retries only local storage`)
      }
    }
    await page.goto("http://127.0.0.1:43129/?control=webhook")
    await page.getByRole("button", { name: "核对原操作", exact: true }).click()
    await page.waitForFunction(
      () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 1
    )
    await page.evaluate(
      (reply) => (window as unknown as EpochFixtureWindow).fixtureReply(reply),
      replies.webhook
    )
    await page.getByRole("textbox", { name: "Webhook 密钥", exact: true }).waitFor()
    await page.evaluate(() =>
      (window as unknown as EpochFixtureWindow).fixtureWorkspace.setState({
        snapshot: { dataEpoch: "restored", bots: [] }
      })
    )
    await page.getByText("数据已恢复", { exact: false }).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "Webhook 密钥", exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "复制密钥", exact: true }).count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "复制 Webhook 地址", exact: true }).isDisabled(),
      true
    )
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCopied),
      []
    )
    cases.push("webhook: restore immediately hides the previous key and disables address copying")
    for (const control of ["avatar", "webhook", "workflow"] as const) {
      await page.goto(`http://127.0.0.1:43129/?control=${control}&oldHost=1`)
      await page.getByText("当前 Bot 后台不支持恢复保护", { exact: false }).waitFor()
      assert.equal(
        await page
          .getByRole("button", {
            name: control === "workflow" ? "重试原请求" : "核对原操作",
            exact: true
          })
          .isDisabled(),
        true
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureCalls.length),
        0
      )
      cases.push(`${control}: older Host cannot submit an operation without generation protection`)
      await page.goto(`http://127.0.0.1:43129/?control=${control}`)
      const raw = await page.evaluate(() =>
        (window as unknown as EpochFixtureWindow).fixtureReadRaw()
      )
      await page
        .getByRole("button", {
          name: control === "workflow" ? "重试原请求" : "核对原操作",
          exact: true
        })
        .click()
      await page.waitForFunction(
        () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as EpochFixtureWindow).fixtureReply({
          botFailure: { code: "data_epoch", message: "工作区数据已恢复" }
        })
      )
      await page.getByText("原记录仍保留", { exact: false }).waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureReadRaw()),
        raw
      )
      assert.equal(
        await page
          .getByRole("button", {
            name: control === "workflow" ? "重试原请求" : "核对原操作",
            exact: true
          })
          .isDisabled(),
        true
      )
      cases.push(
        `${control}: Host generation refusal retires the editor without clearing its original record`
      )
      await page.goto(`http://127.0.0.1:43129/?control=${control}&record=empty&removable=1`)
      if (control === "avatar")
        await page.getByRole("button", { name: "移除图片", exact: true }).click()
      else if (control === "webhook")
        await page.getByRole("button", { name: "生成密钥并启用", exact: true }).click()
      else {
        await page.getByRole("button", { name: "补充要求", exact: true }).click()
        await page
          .getByRole("textbox", { name: "给此子任务补充要求", exact: true })
          .fill("核对授权证据")
        await page.getByRole("button", { name: "发送补充要求", exact: true }).click()
      }
      await page.waitForFunction(
        () => (window as unknown as EpochFixtureWindow).fixtureCalls.length === 1
      )
      const input = (await page.evaluate(
        () => (window as unknown as EpochFixtureWindow).fixtureCalls[0]
      )) as { expectedDataEpoch: string; nonce: string }
      assert.equal(input.expectedDataEpoch, "before")
      assert.equal(typeof input.nonce, "string")
      assert.notEqual(input.nonce, inputs[control].nonce)
      assert.deepEqual(
        JSON.parse(
          (await page.evaluate(() => (window as unknown as EpochFixtureWindow).fixtureReadRaw()))!
        ).input,
        input
      )
      await page.evaluate(
        (reply) => (window as unknown as EpochFixtureWindow).fixtureReply(reply),
        replies[control]
      )
      await page.waitForFunction(
        () => (window as unknown as EpochFixtureWindow).fixtureReadRaw() === null
      )
      cases.push(
        `${control}: a fresh operation freezes its editor generation in the durable request`
      )
    }
    assert.deepEqual(errors, [])
    assert.equal(cases.length, 37)
    console.log(JSON.stringify({ passed: cases.length, cases, errors, started }))
  } finally {
    await browser.close()
    console.log(JSON.stringify({ physicalClose: new Date().toISOString() }))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
