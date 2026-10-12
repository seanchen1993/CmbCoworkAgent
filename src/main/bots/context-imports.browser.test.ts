import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it, vi } from "vitest"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import type { ThreadMessagesPageOptions, ThreadMessageWrite } from "../types"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"

const state = vi.hoisted(() => ({ databasePath: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => state.databasePath,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))

it.skipIf(process.env.CMB_CONTEXT_IMPORT_UI_TEST !== "1")(
  "selects real Cmb transcript pages, excludes private payloads and recovers the exact import after reload",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-context-ui-"))
    state.databasePath = join(root, "threads.sqlite")
    const output = resolve("output/bot-context-import")
    await mkdir(output, { recursive: true })
    const db = await import("../db")
    await db.initializeDatabase()
    const store = new BotStore(join(root, "bots.sqlite"))
    const { bot, conversationId } = store.createBot({ nonce: "bot", name: "项目助手" })
    const api = createBotAPI(new BotHost(store))
    let releaseSlow: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let lostResponse = false
    let pagesRead = 0
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1160, height: 900 } })
    page.setDefaultTimeout(10_000)
    try {
      db.createThread("project-history", {
        title: "支付项目评审",
        apiKey: "MUST_NOT_COPY_CONFIGURATION"
      })
      db.createThread("slow-history", { title: "正在读取的旧任务" })
      const rows: ThreadMessageWrite[] = Array.from({ length: 48 }, (_, index) => ({
        id: `m-${String(index).padStart(2, "0")}`,
        role: index % 2 ? "assistant" : "user",
        content: `REFERENCE-${String(index).padStart(2, "0")} 项目评审文字`,
        created_at: new Date(1_800_000_000_000 + index * 1000)
      }))
      rows.push({
        id: "private-tool",
        role: "tool",
        content: "MUST_NOT_COPY_TOOL",
        created_at: new Date(1_800_000_100_000),
        tool_call_id: "private-call"
      })
      rows.push({
        id: "private-assistant",
        role: "assistant",
        content: [
          { type: "text", text: "公开的文字结论" },
          { type: "image", content: "MUST_NOT_COPY_IMAGE" }
        ],
        reasoning: "MUST_NOT_COPY_REASONING",
        created_at: new Date(1_800_000_101_000)
      })
      db.upsertThreadMessages("project-history", rows)
      db.upsertThreadMessages("slow-history", [
        { id: "slow-message", role: "user", content: "STALE_TASK_CONTENT", created_at: new Date() }
      ])
      const directory = ["project-history", "slow-history"].map((id) => {
        const row = db.getThreadCore(id)!
        return {
          thread_id: id,
          title: row.title,
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at),
          status: "idle"
        }
      })
      const renderer = resolve("src/renderer/src")
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
          contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BotContextImport,BotImportedContext}from'./src/renderer/src/components/bots/BotContextImport';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:{importThreadContext:input=>window.importCall(input)},threads:{getMessagesPage:(id,options)=>window.pageCall(id,options),get:id=>window.threadCall(id)}};useBotWorkspaceStore.setState({snapshot:{dataEpoch:'fixture-epoch'}});function Fixture(){const[open,setOpen]=useState(false);const[result,setResult]=useState('');const[message,setMessage]=useState(null);return <div className="p-8 text-foreground"><button onClick={()=>setOpen(true)}>选择历史记录</button><p role="status">{result}</p>{message&&<div className="mt-8 max-w-2xl rounded-xl border p-4"><BotImportedContext message={message}/></div>}{open&&<BotContextImport bot={${JSON.stringify(bot)}} close={()=>setOpen(false)} onImported={(_,id)=>{setResult('已导入 '+id);setOpen(false);window.messageCall(id).then(setMessage)}}/>}</div>}createRoot(document.getElementById('root')).render(<Fixture/>);`,
          loader: "tsx",
          resolveDir: process.cwd()
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(root, "ui.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
        plugins: [
          {
            name: "fixture-shell-directory",
            setup(builder) {
              builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
                path: "app-store",
                namespace: "fixture"
              }))
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                loader: "js",
                contents: `import{create}from'zustand';export const useAppStore=create(()=>({threads:${JSON.stringify(directory)},threadDirectoryHasMore:false,threadDirectoryLoadingMore:false,loadThreads:async()=>{},loadMoreThreads:async()=>{},addThreadSummary:()=>{},selectThread:async(id)=>{window.lastOpened=id}}));`,
                resolveDir: process.cwd()
              }))
            }
          }
        ]
      })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.exposeFunction("messageCall", (id: string) => api.message({ conversationId, id }))
      await page.exposeFunction("threadCall", (id: string) => db.getThreadCore(id))
      await page.exposeFunction(
        "pageCall",
        async (id: string, options: ThreadMessagesPageOptions) => {
          ++pagesRead
          if (id === "slow-history") await slow
          return db.getThreadMessagesPage(id, options)
        }
      )
      await page.exposeFunction("importCall", async (input) => {
        const result = await api.importThreadContext(input)
        if (!lostResponse) {
          lostResponse = true
          throw new Error("Fixture: response lost after durable import")
        }
        return result
      })
      await page.route("http://127.0.0.1:39193/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
        })
      )
      await page.goto("http://127.0.0.1:39193")
      await page.getByRole("button", { name: "选择历史记录", exact: true }).click()
      await page.getByRole("button", { name: "正在读取的旧任务", exact: false }).click()
      await page.getByText("正在读取记录…", { exact: true }).waitFor()
      await page.getByRole("button", { name: "重新选择任务", exact: true }).click()
      await page.getByRole("button", { name: "支付项目评审", exact: false }).click()
      await page.getByLabel("选择用户记录 REFERENCE-44 项目评审文字", { exact: true }).waitFor()
      releaseSlow!()
      await page.waitForTimeout(100)
      expect(await page.getByText("STALE_TASK_CONTENT", { exact: true }).count()).toBe(0)
      expect(await page.getByText("MUST_NOT_COPY_TOOL", { exact: true }).count()).toBe(0)
      await page.getByLabel("选择用户记录 REFERENCE-44 项目评审文字", { exact: true }).check()
      await page.getByLabel("选择助手记录 公开的文字结论", { exact: true }).check()
      await page.getByRole("button", { name: "查看更早记录（保留已选）", exact: true }).click()
      await page.getByLabel("选择用户记录 REFERENCE-02 项目评审文字", { exact: true }).check()
      await page.getByText("预览全部已选文字（3 条）", { exact: true }).click()
      await page.getByText("公开的文字结论", { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, "selection-light.png"), animations: "disabled" })
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({ path: join(output, "selection-dark.png"), animations: "disabled" })
      expect(store.messages(conversationId)).toHaveLength(0)
      expect(store.snapshot().runs).toHaveLength(0)
      await page.getByRole("button", { name: "确认导入选中记录", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "尚未收到导入结果" }).waitFor()
      const first = store.messages(conversationId)
      expect(first).toHaveLength(1)
      expect(first[0].importedContext?.messageIds).toEqual(["m-02", "m-44", "private-assistant"])
      expect(first[0].text).not.toContain("MUST_NOT_COPY")
      expect(first[0].text).not.toContain("REFERENCE-43")
      db.upsertThreadMessages("project-history", [
        { ...rows[44], content: "SOURCE_CHANGED_AFTER_CONFIRMATION" }
      ])
      const reads = pagesRead
      await page.reload()
      await page.getByRole("button", { name: "选择历史记录", exact: true }).click()
      await page.getByRole("button", { name: "重试核对导入", exact: true }).click()
      await page.getByRole("status").filter({ hasText: "已导入" }).waitFor()
      expect(pagesRead).toBe(reads)
      expect(store.messages(conversationId)).toEqual(first)
      expect(store.snapshot().runs).toHaveLength(0)
      await page.getByText("支付项目评审 · 3 条记录", { exact: true }).click()
      await page.getByRole("button", { name: "打开原任务", exact: true }).click()
      await page.waitForFunction("window.lastOpened === 'project-history'")
      expect(await page.evaluate("window.lastOpened")).toBe("project-history")
      db.deleteThread("project-history")
      await page.getByRole("button", { name: "打开原任务", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "原任务已删除或不可用" }).waitFor()
      expect(store.messages(conversationId)).toEqual(first)
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({
        path: join(output, "imported-record-dark.png"),
        animations: "disabled"
      })
      expect(errors).toEqual([])
    } catch (error) {
      await page.screenshot({ path: join(output, "failure.png"), animations: "disabled" })
      await writeFile(join(output, "failure.txt"), await page.locator("body").innerText())
      throw error
    } finally {
      releaseSlow?.()
      await browser.close()
      store.close()
      await db.closeDatabase()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
