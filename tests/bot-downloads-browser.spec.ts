/** Draft real React/Chrome check using the actual IPC result envelope.
 * The Node fixture verifies renderer ownership; it is not a native disk/chooser proof. */
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import {
  botArtifactDownloadMutationSchema,
  botArtifactDownloadPageInputSchema,
  botArtifactDownloadStartSchema,
  type BotArtifactDownloadJob,
  type BotArtifactDownloadSource,
  type BotArtifactDownloadsAPI
} from "../src/shared/bot-artifact-downloads"

const repo = process.cwd()
const draft = resolve(import.meta.dirname, "..")
const source: BotArtifactDownloadSource = {
  artifactId: "sample-artifact",
  conversationId: "conversation-a",
  sha256: "a".repeat(64),
  size: 100,
  dataEpoch: "epoch-a"
}
type Method = keyof BotArtifactDownloadsAPI
function makeJob(index: number, state: BotArtifactDownloadJob["state"] = "completed") {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    revision: 1,
    source: { ...source, artifactId: `artifact-${index}` },
    name: `研发成果-${String(index + 1).padStart(3, "0")}.txt`,
    mime: "text/plain",
    state,
    bytes: state === "completed" ? 100 : 40,
    total: 100,
    createdAt: Math.max(0, 1000 - index),
    updatedAt: Math.max(0, 1000 - index)
  } satisfies BotArtifactDownloadJob
}
async function main() {
  let jobs = Array.from({ length: 216 }, (_, index) => makeJob(index))
  const calls: { method: Method; input: unknown }[] = []
  let pageFailure = false,
    loseStart = false,
    conflictResume = false
  let held: { method: Method; release(): void } | undefined
  let holdNext: Method | undefined
  let pageReads = 0
  async function waitForHeld(method: Method) {
    const deadline = Date.now() + 10_000
    while (held?.method !== method && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(held?.method, method, "fixture must receive the held native request")
    return held!
  }
  const renderer = join(repo, "src/renderer/src")
  const output = join(draft, "output/bot-downloads")
  await mkdir(output, { recursive: true })
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const botCss = await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")
  const scanner = new Scanner({
    sources: [
      { base: renderer, pattern: "**/*.{ts,tsx}", negated: false },
      { base: join(draft, "src/renderer/src"), pattern: "**/*.{ts,tsx}", negated: false }
    ]
  })
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotDownloads}from'${draft}/src/renderer/src/components/bots/BotDownloads';import{createBotArtifactDownloadClient}from'${draft}/src/renderer/src/lib/bot-artifact-download-client';import{createBotDownloadStartStore}from'${draft}/src/renderer/src/lib/bot-artifact-download-starts';import{applyThemePreference}from'${renderer}/lib/theme-preference';
      applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;window.fixtureStorageFails=false;window.fixtureSettled=0;window.fixtureOpen=true;window.fixtureEpoch='epoch-a';
      window.api={botArtifactDownloads:Object.fromEntries(['start','page','pause','resume','cancel','reveal','forget'].map(method=>[method,async input=>{try{return await window.fixtureDownloadCall(method,input)}finally{window.fixtureSettled++}}]))};
      const starts=createBotDownloadStartStore(()=>({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>{if(window.fixtureStorageFails)throw new Error('storage unavailable');localStorage.removeItem(key)}}));const client=createBotArtifactDownloadClient(()=>window.api.botArtifactDownloads,starts);window.fixtureClient=client;
      function Fixture(){const[open,setOpen]=useState(true),[epoch,setEpoch]=useState('epoch-a'),[visible,setVisible]=useState(true);window.fixtureSetOpen=setOpen;window.fixtureSetEpoch=setEpoch;window.fixtureSetVisible=setVisible;window.fixtureReload=()=>client.start(${JSON.stringify(source)},{name:'示例成果.txt',mime:'text/plain'});return <main style={{minHeight:'100vh',padding:24}} className="bg-background text-foreground"><button id="outside">页面外的按钮</button><input id="composer" aria-label="给 Bot 发送消息"/><button onClick={()=>setOpen(true)}>打开下载中心</button>{open&&<BotDownloads client={client} dataEpoch={epoch} visible={visible} close={()=>setOpen(false)}/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      loader: "tsx",
      resolveDir: repo
    },
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const failure = (code: string, message: string) => ({
    botFailure: { code, message, diagnostic: { code, correlationId: "rpc-download-fixture" } }
  })
  try {
    await page.exposeFunction("fixtureDownloadCall", async (method: Method, raw: unknown) => {
      calls.push({ method, input: raw })
      const shouldHold = holdNext === method
      if (shouldHold) holdNext = undefined
      const waitForRelease = async () => {
        if (!shouldHold) return
        await new Promise<void>((release) => {
          held = { method, release }
        })
        held = undefined
      }
      if (method === "page") {
        pageReads++
        if (pageFailure) return failure("connection_closed", "暂时无法读取下载列表")
        const input = botArtifactDownloadPageInputSchema.parse(raw)
        const filtered = jobs.filter(
          (job) => !input.conversationId || job.source.conversationId === input.conversationId
        )
        const offset = Number(input.before ?? 0),
          limit = input.limit ?? 20
        const result = {
          items: structuredClone(filtered.slice(offset, offset + limit)),
          total: filtered.length,
          nextCursor: offset + limit < filtered.length ? String(offset + limit) : null
        }
        await waitForRelease()
        return result
      }
      await waitForRelease()
      if (method === "start") {
        const input = botArtifactDownloadStartSchema.parse(raw)
        let job = jobs.find((item) => item.id === input.nonce)
        if (!job) {
          job = {
            ...makeJob(9000, "choosing"),
            id: input.nonce,
            source: input.source,
            name: "示例成果.txt",
            bytes: 0,
            createdAt: 9999,
            updatedAt: 9999
          }
          jobs = [job, ...jobs].slice(0, 216)
        }
        if (loseStart) {
          loseStart = false
          return failure("connection_closed", "保存请求回执暂不可用")
        }
        return job
      }
      const input = botArtifactDownloadMutationSchema.parse(raw)
      const index = jobs.findIndex((job) => job.id === input.id),
        job = jobs[index]
      if (!job) return failure("download_archived", "记录已移除")
      if (conflictResume && method === "resume") {
        conflictResume = false
        jobs[index] = { ...job, revision: job.revision + 1, bytes: 60 }
        return failure("download_revision_conflict", "状态已变化")
      }
      if (job.revision !== input.revision)
        return failure("download_revision_conflict", "状态已变化")
      if (method === "reveal") return
      if (method === "forget") {
        jobs.splice(index, 1)
        return
      }
      const state =
        method === "resume" ? "downloading" : method === "pause" ? "paused" : "cancelled"
      jobs[index] = { ...job, state, revision: job.revision + 1, updatedAt: job.updatedAt + 1 }
      return jobs[index]
    })
    await page.route("http://127.0.0.1:39261/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><style>${css.build(scanner.scan())}${botCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39261")
    const dialog = page.getByRole("dialog", { name: "下载与保存" })
    const rows = dialog.locator("[data-download-job]")
    await page.waitForFunction("document.querySelectorAll('[data-download-job]').length===20")
    assert.equal(await rows.count(), 20)
    assert.ok((await dialog.innerText()).includes("216 项记录 · 第 1 页"))
    assert.equal(
      await dialog.getByRole("button", { name: "上一页下载", exact: true }).isDisabled(),
      true
    )
    const header = await dialog
      .getByRole("heading", { name: "下载与保存", exact: true })
      .boundingBox()
    const body = dialog.locator("ol").locator("..")
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    assert.deepEqual(
      await dialog.getByRole("heading", { name: "下载与保存", exact: true }).boundingBox(),
      header
    )
    await dialog.getByRole("button", { name: "下一页下载", exact: true }).click()
    await page.waitForFunction(
      "document.querySelector('[data-download-job]')?.textContent.includes('研发成果-021')"
    )
    assert.equal(await rows.count(), 20)
    await dialog.getByRole("button", { name: "上一页下载", exact: true }).click()
    await page.waitForFunction(
      "document.querySelector('[data-download-job]')?.textContent.includes('研发成果-001')"
    )
    await page.screenshot({ path: join(output, "downloads-light.png") })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.waitForFunction(() => {
      const content = document.querySelector("[role=dialog]")!
      return (
        getComputedStyle(content).backgroundColor ===
          getComputedStyle(document.body).backgroundColor &&
        getComputedStyle(content).color === getComputedStyle(document.body).color
      )
    })
    await page.screenshot({ path: join(output, "downloads-dark.png") })

    // Cancelling an inline confirmation restores its exact trigger, not the dialog root.
    const firstForget = rows.first().getByRole("button", { name: /^移除记录 / })
    await firstForget.click()
    await dialog.getByRole("button", { name: "返回", exact: true }).click()
    await page.waitForFunction(
      "document.activeElement?.getAttribute('data-download-action')==='forget'"
    )
    await firstForget.click()
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      "document.activeElement?.getAttribute('data-download-action')==='forget'"
    )
    assert.equal(await dialog.count(), 1)

    // Delayed authoritative page after removal retains keyboard focus intent.
    const removed = jobs[0].id
    await rows
      .first()
      .getByRole("button", { name: /^移除记录 / })
      .click()
    await dialog.getByRole("button", { name: "确认移除记录", exact: true }).focus()
    holdNext = "page"
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      "document.querySelector('[role=status]')?.textContent.includes('读取下载列表')"
    )
    assert.equal(
      jobs.some((job) => job.id === removed),
      false
    )
    ;(await waitForHeld("page")).release()
    try {
      await page.waitForFunction(
        "document.activeElement?.hasAttribute('data-download-primary-action')"
      )
    } catch (error) {
      console.log(
        "Focus diagnostic",
        await page.evaluate(() => ({
          active: document.activeElement?.outerHTML.slice(0, 1200),
          rows: document.querySelectorAll("[data-download-job]").length,
          disabled: Array.from(document.querySelectorAll("[data-download-primary-action]")).map(
            (button) => (button as HTMLButtonElement).disabled
          )
        }))
      )
      await page.screenshot({ path: join(output, "focus-failure.png") })
      throw error
    }
    assert.equal(await rows.count(), 20)

    // Actual facade turns a structured conflict into inline feedback; no replay.
    jobs[0] = { ...jobs[0], state: "paused", bytes: 40 }
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .waitFor()
    conflictResume = true
    const resumeBefore = calls.filter((call) => call.method === "resume").length
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .click()
    await dialog.getByText("任务状态已更新，列表刷新后请重新选择操作。", { exact: true }).waitFor()
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .waitFor()
    assert.equal(calls.filter((call) => call.method === "resume").length, resumeBefore + 1)
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .click()
    await rows
      .first()
      .getByRole("button", { name: /^暂停 / })
      .waitFor()
    assert.equal(calls.filter((call) => call.method === "resume").length, resumeBefore + 2)
    await rows
      .first()
      .getByRole("button", { name: /^暂停 / })
      .click()
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .waitFor()

    // Lost start response persists across component close/reopen; exact nonce is retried.
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    pageFailure = true
    loseStart = true
    await page.evaluate("window.fixtureReload().catch(()=>undefined)")
    const originalStart = calls.filter((call) => call.method === "start").at(-1)!.input as {
      nonce: string
    }
    assert.equal(await page.evaluate("window.fixtureClient.starts.inspect().kind"), "valid")
    await page.getByRole("button", { name: "打开下载中心", exact: true }).click()
    await dialog.getByRole("button", { name: "核对保存请求", exact: true }).waitFor()
    await dialog.getByRole("button", { name: "核对保存请求", exact: true }).click()
    await page.waitForFunction("window.fixtureClient.starts.inspect().kind==='empty'")
    const checked = calls.filter((call) => call.method === "start").at(-1)!.input as {
      nonce: string
    }
    assert.equal(checked.nonce, originalStart.nonce)
    pageFailure = false
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await rows.first().getByText("示例成果.txt", { exact: true }).waitFor()
    await rows
      .first()
      .getByRole("button", { name: /^取消保存 / })
      .click()
    await dialog.getByRole("button", { name: "确认取消保存", exact: true }).click()
    await rows
      .first()
      .getByText(/已取消/)
      .waitFor()

    // An accepted task with failed local cleanup can only clean the intent.
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    pageFailure = true
    await page.evaluate(
      "window.fixtureStorageFails=true;window.fixtureReload().catch(()=>undefined)"
    )
    await page.getByRole("button", { name: "打开下载中心", exact: true }).click()
    pageFailure = false
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await dialog.getByRole("button", { name: "清理请求记录", exact: true }).waitFor()
    const startsBefore = calls.filter((call) => call.method === "start").length
    await page.evaluate("window.fixtureStorageFails=false")
    await dialog.getByRole("button", { name: "清理请求记录", exact: true }).click()
    await page.waitForFunction("window.fixtureClient.starts.inspect().kind==='empty'")
    assert.equal(calls.filter((call) => call.method === "start").length, startsBefore)

    // Hidden state disables controls and stops reads; the durable task remains Node-owned.
    await page.evaluate("window.fixtureSetVisible(false)")
    await page.waitForFunction("document.querySelector('[data-download-refresh]')?.disabled===true")
    assert.equal(
      await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).isDisabled(),
      true
    )
    const hiddenReads = pageReads
    await page.waitForTimeout(1300)
    assert.equal(pageReads, hiddenReads)
    jobs[0] = { ...jobs[0], state: "completed", bytes: 100, revision: jobs[0].revision + 1 }
    await page.evaluate("window.fixtureSetVisible(true)")
    await rows
      .first()
      .getByRole("button", { name: /^打开文件夹 / })
      .waitFor()

    // A held old page cannot project or focus after an epoch-keyed remount.
    holdNext = "page"
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await page.waitForFunction(
      "document.querySelector('[role=status]')?.textContent.includes('读取下载列表')"
    )
    jobs = jobs.map((job, index) => ({
      ...job,
      name: `新数据-${index}.txt`,
      source: { ...job.source, dataEpoch: "epoch-b" }
    }))
    await page.evaluate("window.fixtureSetEpoch('epoch-b')")
    await rows.first().getByText("新数据-0.txt", { exact: true }).waitFor()
    ;(await waitForHeld("page")).release()
    await page.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    )
    assert.equal(await rows.count(), 20)
    assert.ok((await rows.first().innerText()).includes("新数据-0.txt"))

    // A pending user action's late rejection cannot write the new epoch.
    jobs[0] = { ...jobs[0], state: "paused", bytes: 40 }
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .waitFor()
    holdNext = "resume"
    await rows
      .first()
      .getByRole("button", { name: /^继续保存 / })
      .click()
    assert.equal(
      await rows
        .first()
        .getByRole("button", { name: /^继续保存 / })
        .isDisabled(),
      true
    )
    const staleAction = jobs[0].id
    jobs = jobs.map((job, index) => ({
      ...job,
      id: `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`,
      source: { ...job.source, dataEpoch: "epoch-c" }
    }))
    await page.evaluate("window.fixtureSetEpoch('epoch-c')")
    await page.locator(`[data-download-job="${jobs[0].id}"]`).waitFor()
    assert.equal(await dialog.locator(`[data-download-job="${staleAction}"]`).count(), 0)
    const pendingSettled = (await page.evaluate("window.fixtureSettled")) as number
    ;(await waitForHeld("resume")).release()
    await page.waitForFunction(
      (value) => (window as unknown as { fixtureSettled: number }).fixtureSettled > value,
      pendingSettled
    )
    assert.equal(await dialog.getByRole("alert").count(), 0)
    assert.equal(
      await rows
        .first()
        .getByRole("button", { name: /^继续保存 / })
        .isEnabled(),
      true
    )

    // Closing a pending read relinquishes focus; an old completion cannot reclaim it.
    holdNext = "page"
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await page.waitForFunction(
      "document.querySelector('[role=status]')?.textContent.includes('读取下载列表')"
    )
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.locator("#outside").focus()
    ;(await waitForHeld("page")).release()
    await page.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    )
    assert.equal(
      await page.locator("#outside").evaluate((element) => document.activeElement === element),
      true
    )
    assert.equal(await dialog.count(), 0)
    await page.getByRole("button", { name: "打开下载中心", exact: true }).click()
    await page.waitForFunction("document.querySelectorAll('[data-download-job]').length===20")
    assert.deepEqual(errors, [])

    jobs = []
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await dialog.getByText("暂无保存任务", { exact: true }).waitFor()
    assert.equal(await rows.count(), 0)
    assert.equal(
      await dialog.getByRole("button", { name: "下一页下载", exact: true }).isDisabled(),
      true
    )
    await page.emulateMedia({ reducedMotion: "reduce" })
    assert.equal(
      await page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),
      true
    )
    jobs = [makeJob(0, "paused")]
    await dialog.getByRole("button", { name: "刷新下载列表", exact: true }).click()
    await dialog.getByRole("progressbar").waitFor()
    assert.equal(
      await dialog
        .getByRole("progressbar")
        .locator("div")
        .evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s"
    )
    console.log(
      "PASS downloads real React/Chrome + IPC packet facade, 216/20 paging, safe start ACK recovery, cleanup-only, conflict/manual resume, visibility, epoch fences, delayed-removal focus and themes"
    )
  } finally {
    held?.release()
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
