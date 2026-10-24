/** Real message rows/actions; transport and optional tool/dialog dependencies are isolated. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

declare global {
  interface Window {
    replyFixture: {
      ids: string[]
      calls: string[]
      loading: boolean
      runningTool: boolean
      render(
        mode: "bot" | "default",
        loading?: boolean,
        layout?: "short" | "long" | "table",
        userReaction?: boolean,
        canReply?: boolean
      ): void
    }
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-message-reply-"))
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath())
      ? {}
      : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
    headless: true
  })
  try {
    const bundle = await build({
      stdin: {
        resolveDir: resolve("."),
        loader: "tsx",
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatMessageVirtualList} from './src/renderer/src/components/chat/ChatMessageVirtualList';
import {ChatPresentationContext,ChatReplyActionsContext} from './src/renderer/src/components/chat/chat-presentation-context';
import {BotMessageReactionsContext} from './src/renderer/src/components/bots/bot-message-reactions-context';
const root=createRoot(document.getElementById('root'));
const noop=()=>{};
const ids=['first','provider:response/model::cmb-same-role-duplicate:assistant:2','provider:response/model::cmb-same-role-duplicate:assistant:3'];
const messages=[{id:'user',role:'user',content:'请分段报告',created_at:new Date(1)},...ids.map((id,i)=>({id,ordinal:2+i*2,role:'assistant',content:['第一条已完成','中间这条独立结果','最后一条结果'][i],created_at:new Date(2+i)}))];
const props={lastUserMessageIndex:0,contentVersion:0,historyHasMore:false,historyPageLoading:false,historyRemainingCount:0,onLoadEarlierHistoryPage:noop,historyGapBeforeMessageId:null,canLoadReleasedHistory:false,onLoadReleasedHistoryWindow:noop,onRestoreLatestHistoryWindow:noop,hookLoggingEnabled:false,hookLogBucketByTurnId:new Map(),detachedHookLogBuckets:[],contentMessageRefs:{current:new Map()},setMessageRef:()=>noop,toolResults:new Map(),toolCallStates:new Map(),pendingApprovalToolCallKeys:new Set(),pendingApproval:null,autoApproveGitPush:false,onApprovalDecision:noop,onEditUserMessage:noop,onSetGoalFromMessage:noop,onForkFromMessage:null,forkingMessageId:null,onOpenHookLogBucket:noop,threadId:'reply-fixture',customScrollParent:document.getElementById('viewport'),virtuosoRef:{current:null},navigatorVirtualRangeRef:{current:null},initialTopMostItemIndex:{index:'LAST',align:'end',behavior:'auto'},onInitialVirtualItemsRendered:noop,onContentHeightChanged:noop,onAtBottomStateChange:noop,footer:null,assistantDurationMsById:new Map(),userSendTimeLabelById:new Map([["user","08:00"]])};
const state=window.replyFixture={ids,calls:[],mode:'bot',loading:false,runningTool:false,render(mode='bot',loading=false,layout='short',userReaction=true,canReply=true){state.mode=mode;state.loading=loading;state.runningTool=loading;document.getElementById('root').dataset.chatSurface=mode;const shown=messages.map(m=>m.role!=='assistant'||layout==='short'?m:{...m,content:layout==='long'?'长消息正文和不能断开的链接 https://example.com/'+ 'a'.repeat(120)+' 结束。'.repeat(24):'| 项目 | 内容 | 补充 |\\n| --- | --- | --- |\\n| 已完成 | https://example.com/'+ 'a'.repeat(160)+' | 表格内容 |'});if(loading)shown[shown.length-1]={...shown.at(-1),tool_calls:[{id:'held-execute',name:'execute',args:{command:'held'}}]};const tools=loading?new Map([['held-execute',{status:'running',name:'execute'}]]):props.toolCallStates;root.render(<ChatPresentationContext.Provider value={mode}><ChatReplyActionsContext.Provider value={{canReply,reply:id=>state.calls.push(id),setDraftReply:noop,quoteFor:()=>undefined,jump:noop}}><BotMessageReactionsContext.Provider value={{stateFor:id=>({messageId:id,canReact:true,reactions:id==='user'?(userReaction?[{emoji:"👍",count:1,mine:false,actors:[{botId:"actor-bot",name:"验收 Bot"}]}]:[]):[{emoji:"👍",count:1,mine:true}]}),pending:()=>false,errorFor:()=>undefined,readOnly:false,set:async()=>{},retry:noop}}><ChatMessageVirtualList {...props} isLoading={loading} toolCallStates={tools} messages={shown} visibleMessageIndexes={shown.map((_,i)=>i)}/></BotMessageReactionsContext.Provider></ChatReplyActionsContext.Provider></ChatPresentationContext.Provider>)} };
state.render();`
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      loader: { ".png": "dataurl" },
      alias: { "@": resolve("src/renderer/src") },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      plugins: [
        {
          name: "reply-fixture-isolation",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
              path: "thread-state",
              namespace: "reply-thread-fixture"
            }))
            builder.onLoad({ filter: /.*/, namespace: "reply-thread-fixture" }, () => ({
              contents:
                "const state={workspacePath:null,workspaceFiles:[]};export const useThreadStateSelector=(_id,select)=>select(state);",
              loader: "js"
            }))
            builder.onResolve(
              {
                filter: /^\.\/(ToolCallRenderer|MessageFeedbackDialog|HookLogViews|ModCards)$/
              },
              (args) => ({ path: args.path, namespace: "reply-fixture" })
            )
            builder.onLoad({ filter: /.*/, namespace: "reply-fixture" }, (args) => ({
              contents: args.path.includes("HookLog")
                ? "export const HookLogChip=()=>null"
                : args.path.includes("Feedback")
                  ? "export const MessageFeedbackDialog=()=>null"
                  : args.path.includes("ModCards")
                    ? "export const ModCards=()=>null"
                    : "export const ToolCallRenderer=()=>null",
              loader: "tsx"
            }))
          }
        }
      ]
    })
    const styleSources = [
      "src/renderer/src/components/chat/MessageBubble.tsx",
      "src/renderer/src/components/chat/ChatMessageVirtualList.tsx",
      "src/renderer/src/components/chat/StreamingMarkdown.tsx",
      "src/renderer/src/components/bots/BotMessageActions.tsx"
    ]
    const stylesheet = await compile(await readFile("src/renderer/src/index.css", "utf8"), {
      base: resolve("src/renderer/src"),
      onDependency: () => {}
    })
    const productionStyles =
      stylesheet.build(
        new Scanner({}).scanFiles(
          await Promise.all(
            styleSources.map(async (file) => ({
              content: await readFile(file, "utf8"),
              extension: "tsx"
            }))
          )
        )
      ) + (await readFile("src/renderer/src/components/bots/bots.css", "utf8"))
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="utf-8"><style>' +
        productionStyles +
        '</style><style>body{margin:0}#viewport{height:100vh;overflow:auto}#root{display:block;max-width:760px;margin:auto;padding:24px}</style><div id="viewport"><div id="root" class="bots-workspace"></div></div><script>' +
        bundle.outputFiles[0].text +
        "</script>"
    )
    const page = await browser.newPage({ viewport: { width: 960, height: 800 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/*", (route) =>
      route.request().url().startsWith("file:") || route.request().url().startsWith("data:")
        ? route.continue()
        : route.abort()
    )
    await page.goto("file://" + join(dir, "index.html"))
    const rows = page.locator('[data-chat-message-row][data-message-role="assistant"]')
    await rows
      .last()
      .waitFor({ timeout: 15_000 })
      .catch((error) => {
        throw new Error(`${error.message}\nRenderer errors: ${errors.join("\n")}`)
      })
    assert.equal(await rows.count(), 3)
    const userRow = page.locator('[data-chat-message-row][data-message-role="user"]')
    const userChip = userRow.locator("[data-message-reactions] button")
    await userChip.waitFor()
    await page.mouse.move(0, 0)
    const userVisibility = () =>
      userChip.evaluate((chip) => {
        const chain = []
        let opacity = 1
        for (let node: HTMLElement | null = chip; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          opacity *= Number(style.opacity)
          chain.push({
            tag: node.tagName,
            actions: node.hasAttribute("data-message-actions"),
            opacity: style.opacity,
            position: style.position,
            overflow: style.overflow
          })
        }
        const bubble = chip.closest('[data-message-bubble="user"]')!
        const outer = bubble.querySelector(":scope > div > [data-message-actions]")!
        const toolbar = outer.querySelector("[data-message-actions]")!
        const time = outer.querySelector("time")!
        const rect = chip.getBoundingClientRect(),
          body = bubble.querySelector("[data-message-body]")!.getBoundingClientRect()
        return {
          opacity,
          chain,
          outerPosition: getComputedStyle(outer).position,
          toolbarOpacity: getComputedStyle(toolbar).opacity,
          timeOpacity: getComputedStyle(time).opacity,
          chip: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
          bodyBottom: body.bottom,
          viewportWidth: innerWidth
        }
      })
    const offHover = await userVisibility()
    console.log("USER_REACTION_OFF_HOVER", JSON.stringify(offHover))
    assert.equal(
      offHover.opacity,
      1,
      "a persistent user-message reaction must have no transparent ancestor"
    )
    assert.equal(
      offHover.outerPosition,
      "static",
      "persistent reactions participate in user-row layout"
    )
    assert(
      offHover.chip.top >= offHover.bodyBottom && offHover.chip.right <= offHover.viewportWidth
    )
    assert.equal(offHover.toolbarOpacity, "0", "the action toolbar still waits for hover")
    assert.equal(offHover.timeOpacity, "0", "the timestamp still waits for hover")
    await userRow.hover()
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-message-bubble="user"]')!
      const outer = row.querySelector(":scope > div > [data-message-actions]")!
      return (
        getComputedStyle(outer.querySelector("[data-message-actions]")!).opacity === "1" &&
        getComputedStyle(outer.querySelector("time")!).opacity === "1"
      )
    })
    await page.evaluate(() => window.replyFixture.render("bot", false, "short", false))
    await userRow.locator("[data-message-reactions]").waitFor({ state: "detached" })
    await page.mouse.move(0, 0)
    await page.waitForFunction(
      () =>
        getComputedStyle(
          document.querySelector('[data-message-bubble="user"] > div > [data-message-actions]')!
        ).opacity === "0"
    )
    assert.equal(
      await userRow
        .locator("[data-message-actions]")
        .first()
        .evaluate((node) => getComputedStyle(node).position),
      "absolute",
      "rows without reactions keep their original action layout"
    )
    await page.evaluate(() => window.replyFixture.render("bot"))
    await userChip.waitFor()
    console.log(
      "PASS user reaction visibility: actual MessageBubble ancestors and production CSS; persistent chip visible without hover, toolbar/time hover only, no-chip layout unchanged"
    )

    for (let index = 0; index < 3; index++) {
      assert.equal(
        await rows.nth(index).getByRole("button", { name: "回复消息", exact: true }).count(),
        1,
        "each actual assistant bubble needs its own explicit reply action"
      )
    }
    await rows.nth(0).hover()
    await rows.nth(0).getByRole("button", { name: "回复消息", exact: true }).click()
    const middle = rows.nth(1).getByRole("button", { name: "回复消息", exact: true })
    await middle.focus()
    await page.keyboard.press("Enter")
    assert.equal(
      (await middle.locator("svg").boundingBox())?.width,
      16,
      "Bot reply icon matches Smile and More"
    )
    const ids = await page.evaluate(() => window.replyFixture.ids)
    assert.deepEqual(
      await page.evaluate(() => window.replyFixture.calls),
      ids.slice(0, 2),
      "click and keyboard reply must retain each selected durable identity"
    )
    assert.equal(
      await rows.nth(1).getByRole("button", { name: "复制消息", exact: true }).count(),
      0,
      "the existing terminal-only feedback/copy toolbar must not spread to intermediate messages"
    )
    for (const width of [960, 360]) {
      await page.setViewportSize({ width, height: 900 })
      for (const layout of ["short", "long", "table"] as const) {
        await page.evaluate((layout) => window.replyFixture.render("bot", false, layout), layout)
        const row = rows.last()
        await row.locator(".bot-assistant-content-row").waitFor()
        if (layout === "table") await row.locator("table").waitFor()
        await row.hover()
        const geometry = await row.evaluate((node) => {
          const body = node.querySelector("[data-message-body]")!.getBoundingClientRect()
          const actions = node
            .querySelector(".bot-assistant-content-row > [data-message-actions]")!
            .getBoundingClientRect()
          const reactions = node.querySelector("[data-message-reactions]")!.getBoundingClientRect()
          const content = node.querySelector(".bot-assistant-content-row")!
          return {
            body: { right: body.right, top: body.top, bottom: body.bottom },
            actions: {
              left: actions.left,
              top: actions.top,
              bottom: actions.bottom,
              right: actions.right
            },
            reactions: { top: reactions.top, left: reactions.left, width: reactions.width },
            row: content.getBoundingClientRect().toJSON(),
            overflow: content.scrollWidth > content.clientWidth + 1,
            order: [...content.querySelectorAll(":scope > [data-message-actions] > button")].map(
              (button) => button.getAttribute("aria-label")
            )
          }
        })
        assert(
          geometry.actions.left >= geometry.body.right + 4,
          `${layout}/${width}: actions follow the bubble without overlap`
        )
        assert(
          geometry.actions.top < geometry.body.bottom &&
            geometry.actions.bottom > geometry.body.top,
          `${layout}/${width}: actions stay beside the bubble`
        )
        assert(
          geometry.actions.right <= geometry.row.right + 1 && !geometry.overflow,
          `${layout}/${width}: no horizontal overflow`
        )
        assert(
          geometry.reactions.top >= Math.max(geometry.body.bottom, geometry.actions.bottom),
          `${layout}/${width}: reaction pills remain below`
        )
        assert(
          Math.abs(geometry.reactions.width - geometry.row.width) <= 1,
          `${layout}/${width}: reactions use the full next row`
        )
        assert.deepEqual(geometry.order, ["添加表情回应", "回复消息", "更多消息操作"])
      }
    }
    await page.setViewportSize({ width: 960, height: 800 })
    await page.evaluate(() => window.replyFixture.render("bot", true))
    await rows.last().getByRole("button", { name: "回复消息", exact: true }).waitFor()
    const streamingBody = await rows.last().locator("[data-message-body]").elementHandle()
    assert.equal(
      await rows.nth(0).getByRole("button", { name: "回复消息", exact: true }).count(),
      1
    )
    assert.equal(
      await rows.nth(1).getByRole("button", { name: "回复消息", exact: true }).count(),
      1,
      "a later streaming message must not block replies to completed intermediate messages"
    )
    assert.equal(await page.evaluate(() => window.replyFixture.loading), true)
    assert.equal(await page.evaluate(() => window.replyFixture.runningTool), true)
    assert.equal(
      await rows.last().getByRole("button", { name: "添加表情回应", exact: true }).isEnabled(),
      true,
      "Host-confirmed reactable Bot messages keep their actions while a hidden tool runs"
    )
    assert.equal(
      await rows.last().getByRole("button", { name: "更多消息操作", exact: true }).count(),
      1
    )
    await rows.last().getByRole("button", { name: "回复消息", exact: true }).click()
    assert.equal(
      await page.evaluate(() => window.replyFixture.calls.at(-1)),
      ids.at(-1),
      "reply forwards the exact selected message ID while the task remains loading, without finish metadata"
    )
    await page.evaluate(() => window.replyFixture.render("bot", false))
    await rows.last().getByRole("button", { name: "回复消息", exact: true }).waitFor()
    assert.equal(
      await streamingBody!.evaluate(
        (body) =>
          body.isConnected && body.parentElement?.classList.contains("bot-assistant-content-row")
      ),
      true,
      "completion retains the original Bot body and parent"
    )
    await page.evaluate(() => window.replyFixture.render("bot", false, "short", true, false))
    await rows.last().getByRole("button", { name: "回复消息", exact: true }).waitFor({ state: "detached" })
    assert.equal(
      await page.getByRole("button", { name: "回复消息", exact: true }).count(),
      0,
      "read-only Bot history must not offer a reply action that cannot create a draft"
    )
    assert.equal(await rows.count(), 3, "read-only keeps the original message history mounted")
    await page.evaluate(() => window.replyFixture.render("default", true))
    await rows.last().locator("[data-message-actions]").waitFor({ state: "detached" })
    assert.equal(
      await rows.last().getByRole("button", { name: "回复消息", exact: true }).count(),
      0,
      "ordinary workbench streaming keeps its existing reply/action gate"
    )
    await page.evaluate(() => window.replyFixture.render("default", false))
    await rows.nth(1).locator("[data-message-actions]").waitFor({ state: "detached" })
    assert.equal(await rows.nth(0).locator("[data-message-actions]").count(), 0)
    assert.equal(
      await rows.last().getByRole("button", { name: "复制消息", exact: true }).count(),
      1,
      "the ordinary workbench must retain its original terminal message actions"
    )
    assert.equal(
      (
        await rows
          .last()
          .getByRole("button", { name: "回复消息", exact: true })
          .locator("svg")
          .boundingBox()
      )?.width,
      12,
      "workbench reply icon keeps its original size"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS: per-bubble Bot reply keeps exact ids while loading and a hidden tool runs without finish metadata; workbench streaming/actions unchanged; production CSS geometry and streaming DOM stability"
    )
  } finally {
    await browser.close()
    await rm(dir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
