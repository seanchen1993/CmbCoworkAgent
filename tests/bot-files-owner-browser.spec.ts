import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Actual React upload/list owners, original workspace store and persistent
 * SQLite/file RPC. Controlled epoch replacement is not a real backup restore. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { BotArtifacts } from "../src/main/bots/artifacts"
import { BotDocumentReader } from "../src/main/bots/document-reader"
import { createBotAPI } from "../src/main/bots/rpc"
import type { BotWorkspaceSnapshot } from "../src/shared/bot-types"
import type { BotHostStatus } from "../src/shared/bot-api"

interface FileOwnerFixture {
  fixtureMode(mode: "upload" | "files" | "inspector"): void
  fixtureCover(value: boolean): void
  fixtureSettings(value: boolean): void
  fixtureEpoch(epoch: string): void
  fixtureBump(): void
  fixtureAttemptSend(): Promise<void>
  fixtureWorkspace: {
    setState(input: { host?: BotHostStatus; selected?: string }): void
    getState(): {
      uploading: Record<string, boolean>
      snapshot: BotWorkspaceSnapshot
      drafts: Record<
        string,
        { prompt: string; attachments: { path: string; name: string; size: number }[] }
      >
      attachments(view: string, files: { path: string; name: string; size: number }[]): void
    }
  }
}
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-file-owner-"))
  const store = new BotStore(join(directory, "bots.sqlite"))
  const files = new BotArtifacts(
    join(directory, "files"),
    store,
    new BotDocumentReader({
      entry: resolve("src/main/bots/document-worker-entry.ts"),
      execArgv: ["--import", "tsx"]
    })
  )
  const host = new BotHost(store, undefined, 4, undefined, files)
  const api = createBotAPI(host)
  const own = store.createBot({ nonce: "file-owner", name: "文件助手" })
  const source = resolve(process.env.CMB_FILES_UI_SOURCE ?? ".")
  const renderer = join(source, "src/renderer/src")
  const output = resolve(process.env.CMB_FILES_OWNER_OUTPUT ?? "output/bot-files-owner")
  await mkdir(output, { recursive: true })
  const started = new Date().toISOString()
  const calls: { method: string; input: unknown }[] = []
  const metrics: Record<string, unknown> = {}
  const cases: string[] = [],
    failures: { name: string; message: string }[] = [],
    errors: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const server = createServer()
  let viewEpoch = "initial"
  let holdMethod = "",
    holdLists = false
  let failChunk = false
  const held: { method: string; input: unknown; release(): void }[] = []
  const releaseAll = () => {
    for (const item of held.splice(0)) item.release()
  }
  try {
    const initial = await files.publish(
      {
        id: "initial-file",
        conversationId: own.conversationId,
        runId: null,
        name: "原文件.txt",
        mime: "text/plain"
      },
      Buffer.from("原文件内容")
    )
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
    const highlight = await build({
      entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent"
    })
    const bundle = await build({
      stdin: {
        loader: "tsx",
        resolveDir: source,
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotAttachmentPicker,BotFiles}from'./src/renderer/src/components/bots/BotFiles';import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{useAppStore}from'@/lib/store';window.api={bots:new Proxy({},{get:(_,method)=>async input=>window.fixtureCall(method,input)})};useBotWorkspaceStore.setState({snapshot:${JSON.stringify(store.snapshot())},host:{hostId:'fixture-host',capabilities:['file-lifecycle','mutation-data-epoch-v2']},selected:${JSON.stringify(own.conversationId)}});useBotWorkspaceStore.getState().draft(${JSON.stringify(own.conversationId)},'交办文件任务');window.fixtureWorkspace=useBotWorkspaceStore;window.fixtureEpoch=epoch=>{const state=useBotWorkspaceStore.getState();useBotWorkspaceStore.setState({snapshot:{...state.snapshot,dataEpoch:epoch},uploading:{},sending:{},pending:{}})};window.fixtureBump=()=>useBotWorkspaceStore.setState(state=>({snapshot:{...state.snapshot,cursor:state.snapshot.cursor+1}}));window.fixtureSettings=value=>useAppStore.setState({showCustomizeView:value});window.fixtureAttemptSend=()=>useBotWorkspaceStore.getState().send(${JSON.stringify(own.conversationId)});function Fixture(){const[mode,setMode]=useState('upload');const[covered,setCovered]=useState(false);const state=useBotWorkspaceStore();window.fixtureMode=setMode;window.fixtureCover=setCovered;return <main className='bot-workspace flex h-screen bg-background text-foreground'><section className='flex min-w-0 flex-1 flex-col gap-4 p-6' key={mode+':'+state.snapshot.dataEpoch}>{mode==='upload'?<><BotAttachmentPicker conversationId=${JSON.stringify(own.conversationId)} disabled={false}/><button type='button' aria-label='发送上传任务' disabled={Boolean(state.uploading[${JSON.stringify(own.conversationId)}])} onClick={()=>void window.fixtureAttemptSend()}>发送</button></>:mode==='files'?<BotFiles conversationId=${JSON.stringify(own.conversationId)} inline/>:null}</section>{mode==='inspector'&&<BotInspector key={state.snapshot.dataEpoch} bot={${JSON.stringify(own.bot)}} conversationId=${JSON.stringify(own.conversationId)} tab='library' onTabChange={()=>{}} settings={()=>setCovered(true)} covered={covered} resource={()=>{}} close={()=>setCovered(true)}/>}<Toaster/></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
      },
      bundle: true,
      outfile: join(directory, "ui.js"),
      platform: "browser",
      format: "iife",
      write: false,
      jsx: "automatic",
      alias: { "@": renderer },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        viteUrlAssetsFixture(),
        {
          name: "original-workspace-with-controlled-app",
          setup(context) {
            context.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
              path: "highlight",
              namespace: "preview-worker"
            }))
            context.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
              loader: "js",
              contents: `export default class extends Worker {constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:'text/javascript'}));super(url,options);URL.revokeObjectURL(url)}}`
            }))
            context.onResolve({ filter: /(?:\/lib\/store|^@\/lib\/store)$/ }, () => ({
              path: "app",
              namespace: "fixture"
            }))
            context.onResolve({ filter: /^\.\/store$/ }, (args) =>
              args.importer.includes("/renderer/src/lib/")
                ? { path: "app", namespace: "fixture" }
                : undefined
            )
            context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "ts",
              resolveDir: source,
              contents:
                "import{create}from'zustand';export const useAppStore=create(()=>({models:[],showCustomizeView:false}));"
            }))
          }
        }
      ]
    })
    const html = `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><style>${css.build(scanner.scan())}${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}${bundle.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join(
        "\n"
      )}</style></head><body><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script></body></html>`
    server.on("request", (_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(html)
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } })
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      try {
        const fn = (api as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]
        assert.equal(typeof fn, "function", `Original public API missing: ${method}`)
        let result = await fn(input)
        if (method === "snapshot")
          result = { ...(result as BotWorkspaceSnapshot), dataEpoch: viewEpoch }
        if (method === "uploadChunk" && failChunk) {
          failChunk = false
          throw new Error("分块回执丢失")
        }
        if (holdMethod === method || (method === "artifacts" && holdLists)) {
          if (holdMethod === method) holdMethod = ""
          await new Promise<void>((done) => held.push({ method, input, release: done }))
        }
        return result
      } catch (error) {
        return {
          botFailure: {
            code: (error as { code?: string }).code ?? "fixture_transport",
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const waitHeld = async (method: string) => {
      for (let i = 0; !held.some((item) => item.method === method) && i < 100; i++)
        await new Promise((done) => setTimeout(done, 20))
      const item = held.find((item) => item.method === method)
      assert.ok(item, `Expected actual held ${method}`)
      return item
    }
    const release = (method: string) => {
      const index = held.findIndex((item) => item.method === method)
      assert.ok(index >= 0)
      held.splice(index, 1)[0].release()
    }
    const listCount = () => calls.filter((call) => call.method === "artifacts").length
    const check = async (name: string, run: () => Promise<void>) => {
      try {
        await run()
        cases.push(name)
        console.log(`PASS ${name}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ name, message })
        console.log(`FAIL ${name}: ${message}`)
      } finally {
        holdMethod = ""
        holdLists = false
        releaseAll()
        // The baseline's unwanted synthetic send must not poison later delete checks.
        for (const run of store.snapshot().runs) {
          if (run.conversationId === own.conversationId && run.status === "queued")
            await api.cancel(run.id)
        }
        if (await page.getByRole("dialog").count()) {
          await page.keyboard.press("Escape")
          await page.getByRole("dialog").waitFor({ state: "hidden" })
        }
      }
    }
    const mode = async (value: "upload" | "files" | "inspector") => {
      await page.evaluate((mode) => {
        const f = window as unknown as FileOwnerFixture
        f.fixtureSettings(false)
        f.fixtureCover(false)
        f.fixtureMode(mode)
      }, value)
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    }
    const bump = async (count: number) => {
      for (let i = 0; i < count; i++)
        await page.evaluate(() => {
          ;(window as unknown as FileOwnerFixture).fixtureBump()
          return new Promise<void>((done) => requestAnimationFrame(() => done()))
        })
    }
    await check(
      "old epoch cancel acknowledgement cannot release a new upload owner or admit send",
      async () => {
        holdMethod = "finishUpload"
        await page.locator("input[type=file]").setInputFiles({
          name: "旧上传.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("旧上传实际内容")
        })
        await waitHeld("finishUpload")
        holdMethod = "cancelUpload"
        viewEpoch = "replacement"
        await page.evaluate(
          (epoch) => (window as unknown as FileOwnerFixture).fixtureEpoch(epoch),
          viewEpoch
        )
        release("finishUpload")
        await waitHeld("cancelUpload")
        holdMethod = "finishUpload"
        await page.locator("input[type=file]").setInputFiles({
          name: "新上传.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("新上传实际内容")
        })
        await waitHeld("finishUpload")
        const before = calls.filter((call) => call.method === "send").length
        release("cancelUpload")
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))
            )
        )
        await page.evaluate(() => (window as unknown as FileOwnerFixture).fixtureAttemptSend())
        metrics.uploadAfterOldCancel = {
          busy: await page.evaluate(
            (id) =>
              Boolean(
                (window as unknown as FileOwnerFixture).fixtureWorkspace.getState().uploading[id]
              ),
            own.conversationId
          ),
          unexpectedSends: calls.filter((call) => call.method === "send").length - before
        }
        assert.equal(
          calls.filter((call) => call.method === "send").length,
          before,
          "Old finally must not admit a task before the new attachment acknowledgement"
        )
        assert.equal(await page.getByRole("button", { name: "发送上传任务" }).isDisabled(), true)
        release("finishUpload")
        await page.getByRole("button", { name: "发送上传任务" }).waitFor()
        await page.waitForFunction(
          (id) =>
            !(window as unknown as FileOwnerFixture).fixtureWorkspace.getState().uploading[id],
          own.conversationId
        )
        assert.ok(store.artifacts(own.conversationId).some((file) => file.name === "新上传.txt"))
      }
    )
    await check(
      "same epoch lost chunk retry retains its nonce and ordinary cancel releases only its owner",
      async () => {
        await mode("upload")
        await page.waitForFunction(
          (id) =>
            !(window as unknown as FileOwnerFixture).fixtureWorkspace.getState().uploading[id],
          own.conversationId
        )
        failChunk = true
        const before = calls.filter((call) => call.method === "beginUpload").length
        await page.locator("input[type=file]").setInputFiles({
          name: "原请求重试.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("原请求不改变")
        })
        await page.getByRole("button", { name: "重试上传", exact: true }).waitFor()
        await page.getByRole("button", { name: "重试上传", exact: true }).click()
        await page.waitForFunction(
          (id) =>
            !(window as unknown as FileOwnerFixture).fixtureWorkspace.getState().uploading[id],
          own.conversationId
        )
        const starts = calls.filter((call) => call.method === "beginUpload").slice(before)
        assert.equal(starts.length, 2)
        assert.deepEqual(starts[0].input, starts[1].input)
        holdMethod = "uploadChunk"
        await page.locator("input[type=file]").setInputFiles({
          name: "取消暂存.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("取消未完成分块")
        })
        await waitHeld("uploadChunk")
        await page.getByRole("button", { name: "取消上传", exact: true }).click()
        release("uploadChunk")
        await page.waitForFunction(
          (id) =>
            !(window as unknown as FileOwnerFixture).fixtureWorkspace.getState().uploading[id],
          own.conversationId
        )
        assert.equal(
          store.artifacts(own.conversationId).some((file) => file.name === "取消暂存.txt"),
          false
        )
      }
    )
    await check(
      "file cursor bursts have one active read and hidden settings retire pending reads and stale results",
      async () => {
        holdLists = true
        await mode("files")
        await waitHeld("artifacts")
        const before = listCount()
        await bump(30)
        const afterBurst = listCount()
        await page.evaluate(() => (window as unknown as FileOwnerFixture).fixtureSettings(true))
        const hiddenStart = listCount()
        await bump(5)
        const hiddenEnd = listCount()
        metrics.listBurst = { before, afterBurst, hiddenStart, hiddenEnd }
        await files.publish(
          {
            id: "fresh-visible-file",
            conversationId: own.conversationId,
            runId: null,
            name: "恢复后最新.txt",
            mime: "text/plain"
          },
          Buffer.from("恢复后最新文件")
        )
        holdLists = false
        releaseAll()
        await page.evaluate(() => (window as unknown as FileOwnerFixture).fixtureSettings(false))
        await page.getByRole("button", { name: "预览 恢复后最新.txt", exact: true }).waitFor()
        assert.equal(afterBurst, before, "A held actual list must remain the sole active read")
        assert.equal(hiddenEnd, hiddenStart, "Hidden controls cannot query on cursor changes")
        assert.ok(listCount() <= before + 1, "Reopen consumes one fresh merged read")
      }
    )
    await check(
      "selecting an existing original preserves bytes and draft text without upload or duplicate",
      async () => {
        await mode("files")
        const beforeUploads = calls.filter((call) =>
          ["beginUpload", "uploadChunk", "finishUpload"].includes(call.method)
        ).length
        const beforeText = await page.evaluate(
          (id) =>
            (window as unknown as FileOwnerFixture).fixtureWorkspace.getState().drafts[id].prompt,
          own.conversationId
        )
        const action = page.getByRole("button", { name: "将 原文件.txt 添加到消息", exact: true })
        await action.waitFor()
        await action.click()
        assert.equal(await action.isDisabled(), true)
        const draft = await page.evaluate(
          (id) => (window as unknown as FileOwnerFixture).fixtureWorkspace.getState().drafts[id],
          own.conversationId
        )
        assert.equal(draft.prompt, beforeText)
        assert.equal(draft.attachments.filter((file) => file.path === initial.id).length, 1)
        assert.deepEqual((await files.read(initial.id)).bytes, Buffer.from("原文件内容"))
        assert.equal(
          calls.filter((call) =>
            ["beginUpload", "uploadChunk", "finishUpload"].includes(call.method)
          ).length,
          beforeUploads
        )
      }
    )
    await check(
      "a file from the open library cannot be attached to another selected conversation",
      async () => {
        await mode("files")
        const other = store.createBot({ nonce: "other-file-owner", name: "Other owner" })
        await page.evaluate(
          (id) =>
            (window as unknown as FileOwnerFixture).fixtureWorkspace.setState({ selected: id }),
          other.conversationId
        )
        assert.equal(
          await page.getByRole("button", { name: "将 原文件.txt 添加到消息", exact: true }).count(),
          0
        )
        const foreign = await page.evaluate(
          (id) => (window as unknown as FileOwnerFixture).fixtureWorkspace.getState().drafts[id],
          other.conversationId
        )
        assert.equal(foreign, undefined)
        await page.evaluate(
          (id) =>
            (window as unknown as FileOwnerFixture).fixtureWorkspace.setState({ selected: id }),
          own.conversationId
        )
        await page.getByRole("button", { name: "将 原文件.txt 添加到消息", exact: true }).waitFor()
      }
    )
    await check("file preview keeps the underlying Library read owner inactive", async () => {
      await mode("files")
      await page.getByRole("button", { name: "预览 原文件.txt", exact: true }).waitFor()
      await page.getByRole("button", { name: "预览 原文件.txt", exact: true }).click()
      await page.getByRole("dialog").waitFor()
      await page.getByText("原文件内容", { exact: false }).waitFor()
      const previewStart = listCount()
      await bump(5)
      assert.equal(listCount(), previewStart, "Preview owns visibility while it covers the list")
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden" })
    })
    await check("covered Inspector retires the original Library owner", async () => {
      await mode("inspector")
      await page.getByRole("button", { name: "预览 原文件.txt", exact: true }).waitFor()
      await page.evaluate(() => (window as unknown as FileOwnerFixture).fixtureCover(true))
      const coveredStart = listCount()
      await bump(5)
      assert.equal(listCount(), coveredStart, "Covered Inspector must disable its Library owner")
      await page.evaluate(() => (window as unknown as FileOwnerFixture).fixtureCover(false))
      await page.getByRole("button", { name: "预览 原文件.txt", exact: true }).waitFor()
    })
    await check(
      "a committed delete cannot be undone by an older actual list response",
      async () => {
        await mode("files")
        const deleteButton = page.getByRole("button", { name: "删除文件 原文件.txt", exact: true })
        await deleteButton.waitFor()
        assert.equal(
          await deleteButton.isDisabled(),
          true,
          "An old Host cannot delete without scoped epoch support"
        )
        assert.equal(await deleteButton.getAttribute("title"), "请更新 Bot 后台后删除文件")
        const oldRemoves = calls.filter((call) => call.method === "deleteFile").length
        await deleteButton.evaluate((button) => (button as HTMLButtonElement).click())
        assert.equal(calls.filter((call) => call.method === "deleteFile").length, oldRemoves)
        const actualStatus = await api.status()
        assert.ok(actualStatus.capabilities?.includes("file-delete-epoch"))
        assert.ok(actualStatus.dataEpoch)
        assert.equal(actualStatus.dataEpoch, store.dataEpoch())
        viewEpoch = actualStatus.dataEpoch
        await page.evaluate(
          ({ status, epoch }) => {
            const fixture = window as unknown as FileOwnerFixture
            fixture.fixtureEpoch(epoch)
            fixture.fixtureWorkspace.setState({ host: status })
          },
          { status: actualStatus, epoch: viewEpoch }
        )
        holdLists = true
        await bump(1)
        await waitHeld("artifacts")
        await page.getByRole("button", { name: "删除文件 原文件.txt", exact: true }).click()
        await page.getByRole("button", { name: "确认删除文件", exact: true }).click()
        await page
          .getByRole("button", { name: "预览 原文件.txt", exact: true })
          .waitFor({ state: "hidden" })
        holdLists = false
        releaseAll()
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))
            )
        )
        assert.equal(
          await page.getByRole("button", { name: "预览 原文件.txt", exact: true }).count(),
          0
        )
        assert.equal(
          store.artifacts(own.conversationId).some((file) => file.id === initial.id),
          false
        )
      }
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
  } finally {
    holdMethod = ""
    holdLists = false
    releaseAll()
    await browser?.close()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    await files.close()
    store.close()
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(
        {
          started,
          ended: new Date().toISOString(),
          source,
          database: join(directory, "bots.sqlite"),
          cases,
          failures,
          pageErrors: errors,
          metrics,
          calls,
          scope:
            "Actual React/original workspace store/Chrome/persistent SQLite/file RPC; controlled epoch replacement, not Electron or backup restore"
        },
        null,
        2
      )
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
