import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright"
import { expect, it } from "vitest"

it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "bounds a real 2,000-task dialog and routes current run identities across pages and restored views",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmb-conversation-tasks-"))
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    try {
      await build({
        stdin: {
          resolveDir: process.cwd(),
          loader: "tsx",
          contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BotConversationTasks} from './src/renderer/src/components/bots/BotConversationTasks';
const tasks=Array.from({length:2000},(_,index)=>({
 id:'run-'+String(index).padStart(4,'0'),botId:'bot',conversationId:'conversation',
 messageId:'message-'+index,parentRunId:null,rootRunId:'root-'+index,depth:0,lane:'user',source:'user',
 status:index===17?'needs_review':index===18?'waiting_input':index===19?'running':'queued',
 revision:1,fence:0,leaseOwner:null,leaseUntil:null,checkpoint:null,result:null,error:null,
 createdAt:index,updatedAt:index,waitingForBot:null,output:index===19?'streaming content':undefined
}));
window.fixtureCalls=[];
function Fixture(){
 const [epoch,setEpoch]=useState('initial'),[conversationId,setConversationId]=useState('conversation'),[runs,setRuns]=useState(tasks);
 window.fixtureEpoch=()=>setEpoch(value=>value==='initial'?'restored':'initial');
 window.fixtureView=()=>setConversationId(value=>value==='conversation'?'other':'conversation');
 window.fixtureProgress=()=>setRuns(value=>value.map(item=>item.id==='run-0020'?{...item,status:'running',revision:2}:item));
 const all=[...runs,{...tasks[0],id:'other-run',conversationId:'other'},{...tasks[0],id:'branch-run',threadRootId:'thread'}];
 return <BotConversationTasks scope={{conversationId,dataEpoch:epoch}} runs={all}
  bots={[{id:'bot',name:'开发 Bot'}]} conversationKind="direct" canViewHistory
  onHistory={address=>window.fixtureCalls.push({kind:'history',...address})}
  onReview={run=>window.fixtureCalls.push({kind:'review',runId:run.id,conversationId:run.conversationId})}
  onCancel={runId=>{window.fixtureCalls.push({kind:'cancel',runId});return new Promise((resolve,reject)=>{window.fixtureResolve=resolve;window.fixtureReject=()=>reject(new Error('old-view failure'));});}}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`
        },
        alias: { "@": resolve("src/renderer/src") },
        plugins: [
          {
            // This fixture exercises the production task component and Radix UI.
            // Avatar image IPC and Markdown parsing have independent integration gates.
            name: "task-presentation-only",
            setup(builder) {
              builder.onResolve({ filter: /^\.\/BotAvatar$/ }, () => ({
                path: "avatar",
                namespace: "fixture"
              }))
              builder.onResolve({ filter: /components\/chat\/StreamingMarkdown$/ }, () => ({
                path: "markdown",
                namespace: "fixture"
              }))
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                loader: "tsx",
                resolveDir: process.cwd(),
                contents:
                  args.path === "avatar"
                    ? "import React from 'react';export function BotAvatar(){return <span aria-hidden>●</span>}"
                    : "import React from 'react';export function StreamingMarkdown({children}){return <p>{children}</p>}"
              }))
            }
          }
        ],
        bundle: true,
        outfile: join(directory, "fixture.js"),
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"development"' },
        logLevel: "silent"
      })
      await writeFile(
        join(directory, "index.html"),
        '<!doctype html><html><head><style>[role="dialog"]{position:fixed;inset:30px;background:white;max-height:85vh;display:flex;flex-direction:column;overflow:auto}button{min-height:28px}li{padding:4px;border:1px solid #ddd}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>'
      )
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(pathToFileURL(join(directory, "index.html")).href)
      await expect.poll(() => page.locator("[data-inline-task-id]").count()).toBe(4)
      expect(await page.locator("[data-conversation-task-id]").count()).toBe(0)
      await page.getByRole("button", { name: "查看全部 2000 个任务", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "当前会话任务", exact: true })
      await dialog.waitFor()
      expect(await dialog.locator("[data-conversation-task-id]").count()).toBe(20)
      expect(await dialog.locator("pre").count()).toBe(0)
      await dialog.getByText("查看实时输出", { exact: true }).click()
      await expect.poll(() => dialog.locator("pre").count()).toBe(1)
      expect(await dialog.locator("pre").textContent()).toBe("streaming content")
      await dialog.getByRole("button", { name: "下一页", exact: true }).click()
      expect(
        await dialog
          .locator("[data-conversation-task-id]")
          .first()
          .getAttribute("data-conversation-task-id")
      ).toBe("run-0020")
      await page.evaluate(() =>
        (window as unknown as { fixtureProgress(): void }).fixtureProgress()
      )
      expect(
        await dialog
          .locator("[data-conversation-task-id]")
          .first()
          .getAttribute("data-conversation-task-id")
      ).toBe("run-0020")
      await dialog
        .locator('[data-conversation-task-id="run-0020"]')
        .getByRole("button", { name: "任务记录", exact: true })
        .click()
      await dialog.waitFor({ state: "detached" })
      expect(
        await page.evaluate(() =>
          (window as unknown as { fixtureCalls: unknown[] }).fixtureCalls.at(-1)
        )
      ).toEqual({ kind: "history", conversationId: "conversation", runId: "run-0020" })
      await page
        .locator('[data-inline-task-id="run-0017"]')
        .getByRole("button", { name: "核对并恢复", exact: true })
        .click()
      expect(
        await page.evaluate(() =>
          (window as unknown as { fixtureCalls: unknown[] }).fixtureCalls.at(-1)
        )
      ).toEqual({ kind: "review", conversationId: "conversation", runId: "run-0017" })
      await page.getByRole("button", { name: "查看全部 2000 个任务", exact: true }).click()
      await dialog
        .locator('[data-conversation-task-id="run-0020"]')
        .getByRole("button", { name: "停止此任务", exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click()
          button.click()
        })
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { fixtureCalls: { kind: string }[] }).fixtureCalls.filter(
                (call) => call.kind === "cancel"
              ).length
          )
        )
        .toBe(1)
      expect(
        await page.evaluate(() =>
          (window as unknown as { fixtureCalls: unknown[] }).fixtureCalls.at(-1)
        )
      ).toEqual({ kind: "cancel", runId: "run-0020" })
      await page.evaluate(() => (window as unknown as { fixtureEpoch(): void }).fixtureEpoch())
      await dialog.waitFor({ state: "detached" })
      await page.evaluate(() => (window as unknown as { fixtureReject(): void }).fixtureReject())
      await page.waitForTimeout(30)
      expect(await page.getByRole("alert").count()).toBe(0)
      expect(await page.getByRole("button", { name: "正在停止…", exact: true }).count()).toBe(0)
      await page.getByRole("button", { name: "查看全部 2000 个任务", exact: true }).click()
      expect(
        await dialog
          .locator("[data-conversation-task-id]")
          .first()
          .getAttribute("data-conversation-task-id")
      ).toBe("run-0000")
      expect(await dialog.locator("[data-conversation-task-id]").count()).toBe(20)
      await page.evaluate(() => (window as unknown as { fixtureView(): void }).fixtureView())
      await dialog.waitFor({ state: "detached" })
      await expect.poll(() => page.locator("[data-inline-task-id]").count()).toBe(1)
      expect(await page.locator("[data-inline-task-id]").getAttribute("data-inline-task-id")).toBe(
        "other-run"
      )
      expect(errors).toEqual([])
    } finally {
      await browser.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000
)
