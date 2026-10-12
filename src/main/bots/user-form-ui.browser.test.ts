/** Actual Workspace React + SQLite + authenticated RPC. Only a committed
 * answer ACK is held at the renderer bridge to prove late-ACK ownership. */
import { expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { highlightWorkerFixture } from "../../../tests/fixtures/highlight-worker"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { serializeBotFailure } from "./error-diagnostic"
import { type BotUserForm } from "../../shared/bot-user-form"
const enabled = process.env.CMB_TYPED_FORM_UI_TEST === "1"
it.skipIf(!enabled)(
  "renders typed ordinary fields in the real Workspace and retains a newer form when an older committed answer ACK arrives",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmb-typed-form-ui-")),
      cleanup: (() => void | Promise<void>)[] = [
        () => rm(directory, { recursive: true, force: true })
      ]
    try {
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
          resolveDir: process.cwd(),
          loader: "tsx",
          contents: `import React from'react';import{createRoot}from'react-dom/client';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';applyThemePreference('codex-dark');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)}),botArtifactDownloads:{page:async()=>({items:[],nextCursor:null,total:0})}};window.fixtureShow=input=>{store.setState({host:input.host,snapshot:input.snapshot});store.getState().select(input.conversationId)};createRoot(document.getElementById('root')).render(<main className="flex h-screen bg-background text-foreground"><BotWorkspace/></main>);`
        },
        outfile: "typed-form-ui.js",
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        jsx: "automatic",
        preserveSymlinks: true,
        alias: { "@": renderer },
        define: {
          "process.env.NODE_ENV": '"production"',
          "import.meta.env.DEV": "false",
          __APP_VERSION__: '"ui-fixture"'
        },
        plugins: [
          await highlightWorkerFixture(renderer),
          {
            name: "unrelated-outer-shell",
            setup(builder) {
              builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) =>
                args.path === "./store" && !args.importer.startsWith(join(renderer, "lib"))
                  ? undefined
                  : { path: "app-store", namespace: "outer" }
              )
              builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
                path: "thread",
                namespace: "outer"
              }))
              builder.onLoad({ filter: /.*/, namespace: "outer" }, (args) => ({
                loader: "js",
                resolveDir: process.cwd(),
                contents:
                  args.path === "app-store"
                    ? 'import{create}from"zustand";export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));'
                    : "export const useThreadStateSelector=(_id,select)=>select({workspacePath:null,workspaceFiles:[]});"
              }))
            }
          }
        ]
      })
      const script = bundle.outputFiles!.find((file) => file.path.endsWith(".js"))!.text,
        styles =
          css.build(scanner.scan()) +
          "\n" +
          bundle
            .outputFiles!.filter((file) => file.path.endsWith(".css"))
            .map((file) => file.text)
            .join("\n")
      const lock = BotHostLock.acquire(directory)!
      cleanup.push(() => lock.release())
      const store = new BotStore(join(directory, "bots.sqlite"))
      cleanup.push(() => store.close())
      const host = new BotHost(store)
      host.bindOwnership(lock)
      cleanup.push(() => host.stop())
      const socketPath =
          process.platform === "win32"
            ? `\\\\.\\pipe\\cmb-form-ui-${randomBytes(12).toString("hex")}`
            : join(directory, "rpc.sock"),
        token = randomBytes(32).toString("hex"),
        rpc = new BotRpcServer(host, token)
      await rpc.listen(socketPath)
      cleanup.push(() => rpc.close())
      const client = new BotTransportClient({
        version: 1,
        pid: process.pid,
        hostId: host.id,
        socketPath,
        token
      })
      cleanup.push(() => client.closeAndWait())
      const { conversationId } = await client.call("create", { nonce: "bot", name: "发布助手" })
      store.send({ nonce: "first", conversationId, text: "请收集发布信息" })
      const first = store.claim(host.id, 300_000)!
      const form: BotUserForm = {
        title: "发布信息",
        description: "请核对以下信息；说明可以留空。",
        fields: [
          { id: "branch", label: "分支", type: "text", required: true },
          { id: "date", label: "计划日期", type: "date", required: true },
          { id: "count", label: "实例数量", type: "number", required: true },
          { id: "email", label: "通知邮箱", type: "email", required: true },
          { id: "tel", label: "联系电话", type: "tel", required: true },
          {
            id: "target",
            label: "目标环境",
            type: "select",
            required: true,
            options: [
              { value: "test", label: "测试环境" },
              { value: "prod", label: "生产环境" }
            ]
          },
          { id: "notes", label: "补充说明", type: "textarea" }
        ]
      }
      const item = store.requestUserFormInteraction(first.lease, form)
      const browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
        args: ["--disable-updater-scheduler"]
      })
      cleanup.push(() => browser.close())
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
      page.setDefaultTimeout(10_000)
      cleanup.push(() => page.close())
      const errors: string[] = [],
        calls: { method: string; input: unknown }[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      let hold = true,
        held: { release(): void } | undefined
      cleanup.push(() => held?.release())
      await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
        calls.push({ method, input })
        try {
          const result = await Reflect.apply(client.call, client, [
            method,
            ...(input === undefined ? [] : [input])
          ])
          if (method === "answer" && hold) {
            hold = false
            return new Promise((done) => {
              held = { release: () => done(result) }
            })
          }
          return result
        } catch (failure) {
          return { botFailure: serializeBotFailure(failure) }
        }
      })
      await page.route("http://127.0.0.1:39215/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script>`
        })
      )
      await page.goto("http://127.0.0.1:39215")
      const show = async () =>
        page.evaluate((input) => Reflect.get(window, "fixtureShow")(input), {
          host: await client.call("status"),
          snapshot: store.snapshot(),
          conversationId
        })
      await show()
      // Label DOM text joins the two spans; accessible names normalize their boundary.
      const fieldLabels = await page
        .locator("form label")
        .evaluateAll((labels) => labels.map((label) => label.textContent))
      await page.getByRole("heading", { name: "发布信息", exact: true }).waitFor()
      await page.getByRole("button", { name: "提交", exact: true }).click()
      expect(calls.filter((call) => call.method === "answer")).toHaveLength(0)
      await page.getByText("请填写“分支”", { exact: true }).waitFor()
      await page.getByLabel(/^分支\s*必填$/).fill("main")
      await page.getByLabel(/^计划日期\s*必填$/).fill("2028-02-29")
      await page.getByLabel(/^实例数量\s*必填$/).fill("Infinity")
      await page.getByRole("button", { name: "提交", exact: true }).click()
      await page.getByText("“实例数量”需要有限的十进制数值", { exact: true }).waitFor()
      await page.getByLabel(/^实例数量\s*必填$/).fill("0")
      await page.getByLabel(/^通知邮箱\s*必填$/).fill("dev@example.test")
      await page.getByLabel(/^联系电话\s*必填$/).fill("+86 138 0000 0000")
      await page.getByRole("combobox", { name: /目标环境/ }).click()
      await page.getByRole("option", { name: "测试环境", exact: true }).click()
      await page.getByLabel(/^补充说明\s*选填$/).fill("中文说明第一行\n第二行")
      await show()
      expect(await page.getByLabel(/^分支\s*必填$/).inputValue()).toBe("main")
      expect(await page.getByLabel(/^补充说明\s*选填$/).inputValue()).toContain("第二行")
      await writeFile(
        join(directory, "typed-form-dark.png"),
        await page.screenshot({ fullPage: true })
      )
      await page.getByRole("button", { name: "提交", exact: true }).click()
      await page.waitForFunction(() =>
        document.querySelector("form button[type=submit]")?.textContent?.includes("正在确认")
      )
      for (let index = 0; index < 100 && !held; index++)
        await new Promise((done) => setTimeout(done, 20))
      expect(held).toBeDefined()
      expect(store.getInteraction(item.id).status).toBe("answered")
      expect(calls.filter((call) => call.method === "answer")).toHaveLength(1)
      // This is a new original task, not a retry with changed parameters.
      store.finish(first.lease, "cancelled", "结束已回答的夹具任务")
      store.send({ nonce: "next", conversationId, text: "补充后续参数" })
      const second = store.claim(host.id, 300_000)!
      const secondItem = store.requestUserFormInteraction(second.lease, {
        title: "后续参数",
        fields: [{ id: "value", type: "text", label: "独立值", required: true }]
      })
      await show()
      await page.getByLabel(/^独立值\s*必填$/).fill("NEW_DRAFT_KEPT")
      held!.release()
      await page.waitForTimeout(100)
      expect(await page.getByLabel(/^独立值\s*必填$/).inputValue()).toBe("NEW_DRAFT_KEPT")
      expect(calls.filter((call) => call.method === "answer")).toHaveLength(1)
      // Another window retained this same card's original payload. A first click
      // reveals that payload; only explicit confirmation may submit it.
      await page.evaluate(
        (input) =>
          localStorage.setItem(
            `bot-user-form-pending:${input.id}`,
            JSON.stringify({ dataEpoch: input.dataEpoch, input })
          ),
        {
          id: secondItem.id,
          runId: second.run.id,
          conversationId,
          revision: secondItem.revision,
          dataEpoch: "initial",
          answer: '{"status":"submitted","values":{"value":"ORIGINAL_SUBMITTED"}}',
          storedAt: Date.now()
        }
      )
      await page.getByRole("button", { name: "提交", exact: true }).click()
      expect(await page.getByLabel(/^独立值\s*必填$/).inputValue()).toBe("ORIGINAL_SUBMITTED")
      expect(calls.filter((call) => call.method === "answer")).toHaveLength(1)
      await page
        .getByText("另一次提交尚未确认，已显示原回答。请核对后确认原提交。", { exact: true })
        .waitFor()
      await page.getByRole("button", { name: "确认原提交", exact: true }).click()
      for (
        let index = 0;
        index < 100 && store.getInteraction(secondItem.id).status !== "answered";
        index++
      )
        await new Promise((done) => setTimeout(done, 20))
      expect(store.getInteraction(secondItem.id).answer).toBe(
        '{"status":"submitted","values":{"value":"ORIGINAL_SUBMITTED"}}'
      )
      expect(calls.filter((call) => call.method === "answer")).toHaveLength(2)
      expect(errors).toEqual([])
      const evidence = process.env.CMB_TYPED_FORM_UI_EVIDENCE
      if (evidence) {
        await writeFile(
          join(evidence, "typed-form-dark.png"),
          await readFile(join(directory, "typed-form-dark.png"))
        )
        await writeFile(
          join(evidence, "ui-events.json"),
          JSON.stringify(
            {
              calls: calls.map((call) => call.method),
              pageErrors: errors,
              fieldLabels,
              firstAnswer: store.getInteraction(item.id).answer,
              secondDraft: "NEW_DRAFT_KEPT"
            },
            null,
            2
          )
        )
      }
    } finally {
      for (const close of cleanup.reverse()) await close()
    }
  },
  30_000
)
