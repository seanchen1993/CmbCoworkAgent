/** Actual React/Virtuoso, public-only TLS and thumbnail worker integration. External OS opening is a controlled bridge fixture. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright"
import { createCanvas } from "@napi-rs/canvas"
import { BotLinkPreviewService } from "../src/main/bots/link-preview-service"
import { PublicLinkFetcher } from "../src/main/bots/public-link-fetch"
import { BotLinkPreviewImageReader } from "../src/main/bots/link-preview-image"
import { previewTLSFixture, publicDNS } from "../src/main/bots/link-preview-tls-fixture"
import type { BotLinkPreviewCache } from "../src/renderer/src/lib/bot-link-preview-cache"
import type { BotLinkPreviewRequest } from "../src/shared/bot-link-preview"
declare global {
  interface Window {
    fixtureCalls: BotLinkPreviewRequest[]
    fixtureCancelled: string[]
    fixtureOpens: string[]
    fixtureDetached: number
    previewInjected: number
    fixtureTheme(theme: "codex-dark" | "codex-light"): void
    fixtureOpenRace(): void
    fixtureOpenFail(): void
    fixtureRejectOpen(): void
    fixtureSwitch(): void
    fixtureVisible(active: boolean): void
    fixtureNew(): void
    fixtureUnmount(): void
    fixtureCache: BotLinkPreviewCache
  }
}
const root = fileURLToPath(new URL("../", import.meta.url))
const output = resolve(root, "output/bot-link-preview")
const original = "https://preview.candidate.net/page#original-section"
const deep =
  "cmbcowork://app/v1/bots/11111111-1111-4111-8111-111111111111/messages/22222222-2222-4222-8222-222222222222"

async function main() {
  await mkdir(output, { recursive: true })
  const canvas = createCanvas(600, 400),
    ctx = canvas.getContext("2d")
  ctx.fillStyle = "#214d79"
  ctx.fillRect(0, 0, 600, 400)
  const png = await canvas.encode("png")
  let release: (() => void) | undefined, releaseObsolete: (() => void) | undefined
  const fixture = await previewTLSFixture((request, response) => {
    if (request.url === "/image") response.writeHead(200, { "content-type": "image/png" }).end(png)
    else if (request.url === "/obsolete")
      releaseObsolete = () =>
        response.writeHead(200, { "content-type": "text/html" }).end("<title>OBSOLETE</title>")
    else if (request.url === "/page")
      release = () =>
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<head><meta property="og:title" content="研发平台实践：服务可靠性与长期任务协作"><script>window.previewInjected=1</script><meta name="description" content="本文介绍项目上下文、任务交接与稳定的协作机制。"><meta property="og:image" content="https://image.candidate.net/image"></head>'
          )
    else
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>New conversation</title>")
  })
  const images = new BotLinkPreviewImageReader({
    entry: resolve(root, "src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href]
  })
  const service = new BotLinkPreviewService({
    fetcher: new PublicLinkFetcher(publicDNS, fixture.dial),
    proxyFor: async () => "DIRECT",
    image: (bytes, mime, signal) => images.render(bytes, mime, signal)
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const bundle = await build({
      stdin: {
        loader: "tsx",
        resolveDir: root,
        contents: `
    import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
    import{BotLinkPreviewCard}from'./src/renderer/src/components/bots/BotLinkPreviewCard';import{botMessagePreviewUrl}from'./src/renderer/src/lib/bot-link-preview-policy';import{BotLinkPreviewCache}from'./src/renderer/src/lib/bot-link-preview-cache';
    import{BotTranscriptList}from'./src/renderer/src/components/bots/BotTranscriptList';import{BotMessageText}from'./src/renderer/src/components/bots/BotMessageText';
    import{observeBotTranscriptScroll}from'./src/renderer/src/lib/use-bot-transcript-scroll';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
    applyThemePreference('codex-light');window.previewInjected=0;window.fixtureTheme=applyThemePreference;window.fixtureOpens=[];window.fixtureCalls=[];window.fixtureCancelled=[];window.fixtureDetached=0;
    const cache=new BotLinkPreviewCache({getLinkPreview:input=>{window.fixtureCalls.push(input);return window.fixturePreview(input)},cancelLinkPreview:async input=>{window.fixtureCancelled.push(input.requestId);await window.fixtureCancel(input)}});window.fixtureCache=cache;
    let openMode='normal', rejectOpen;window.fixtureOpenRace=()=>{openMode='race'};window.fixtureOpenFail=()=>{openMode='fail'};window.fixtureRejectOpen=()=>rejectOpen(new Error('old opening failed'));
    const openExternal=async value=>{window.fixtureOpens.push(value);const mode=openMode;openMode='normal';if(mode==='fail')throw new Error('opening failed');if(mode==='race')await new Promise((resolve,reject)=>{rejectOpen=reject})};
    function Fixture(){const[version,setVersion]=useState('page'),[parent,setParent]=useState(null),[show,setShow]=useState(true),[active,setActive]=useState(true);window.fixtureVisible=setActive;const list=useRef(null),following=useRef(true);window.fixtureSwitch=()=>setVersion('obsolete');window.fixtureNew=()=>setVersion('new');window.fixtureUnmount=()=>setShow(false);
    const href=version==='page'?${JSON.stringify(original)}:version==='obsolete'?'https://preview.candidate.net/obsolete':'https://preview.candidate.net/new';
    const messages=Array.from({length:40},(_,index)=>({id:'message-'+index,sequence:index+1,conversationId:'conversation',botId:null,sender:'user',text:index===39?href:index===38?${JSON.stringify(deep)}:'任务进展 '+index+'：项目资料与工作记录。',runId:null,replyTo:null,createdAt:index,attachments:[]}));
    useEffect(()=>{if(!parent)return;return observeBotTranscriptScroll({scrollParent:parent,following,onReadPosition:()=>{},onUserDetach:()=>window.fixtureDetached++,onContentHeightChanged:()=>{}})},[parent]);
    return <main><header><strong>CMBDevClaw</strong><button id="toggle" onClick={()=>setShow(value=>!value)}>切换视图</button></header><div id="transcript" ref={setParent}>{show?<BotTranscriptList viewId="fixture-view" messages={messages} scrollParent={parent} listRef={list} onRowsRendered={()=>{}} onHeightChanged={()=>{}} renderMessage={message=>{const url=botMessagePreviewUrl(message.text);return <article data-message-id={message.id} className="fixture-message"><div className="message-text"><BotMessageText message={message} conversationFor={()=>undefined} open={()=>{}}/></div>{url?<BotLinkPreviewCard url={url} href={message.text} cache={cache} active={active} openExternal={openExternal}/>:null}</article>}}/>:null}</div><textarea id="composer" placeholder="给 Bot 发送消息…"/></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      alias: { "@": resolve(root, "src/renderer/src") },
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env.DEV": "false"
      }
    })
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({
      viewport: { width: 900, height: 850 }
    })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.setDefaultTimeout(5000)
    const results: string[] = []
    try {
      console.log("Bot link preview browser start", new Date().toISOString())
      await page.exposeFunction("fixturePreview", (input: BotLinkPreviewRequest) =>
        service.get("chrome", input)
      )
      await page.exposeFunction("fixtureCancel", (input: { requestId: string }) =>
        service.cancel("chrome", input.requestId)
      )
      await page.route("**/*", (route) =>
        route.request().url() === "http://127.0.0.1/link-preview-fixture"
          ? route.fulfill({
              contentType: "text/html",
              body: "<html><body></body></html>"
            })
          : route.abort()
      )
      await page.goto("http://127.0.0.1/link-preview-fixture")
      const css = await readFile(
        resolve(root, "src/renderer/src/components/bots/bot-link-preview.css"),
        "utf8"
      )
      await page.setContent(
        `<html><head><style>${css}*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font-family:Inter,system-ui,sans-serif}main{margin:24px auto;width:600px}header{height:44px;display:flex;align-items:center;justify-content:space-between}button{background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:10px;padding:7px 12px}#transcript{height:600px;overflow:auto;border:1px solid var(--border);border-radius:16px;padding:16px}.fixture-message{padding:12px 0;min-height:56px;font-size:14px;line-height:22px}.message-text{overflow-wrap:anywhere;white-space:pre-wrap}a{color:inherit}#composer{margin-top:16px;resize:none;width:100%;height:72px;border-radius:16px;border:1px solid var(--border);padding:14px;background:var(--background);color:var(--foreground)}</style></head><body><div id="root"></div></body></html>`
      )
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const card = page.locator(".bot-link-preview-card")
      await card.waitFor()
      await page.locator("#composer").focus()
      await page.waitForFunction(() => window.fixtureCalls.length === 1)
      const before = await page.evaluate(() => ({
        height: document.querySelector(".bot-link-preview-card")!.getBoundingClientRect().height,
        top: document.getElementById("transcript")!.scrollTop,
        detached: window.fixtureDetached
      }))
      assert.equal(before.height, 126)
      const waitDeadline = Date.now() + 3000
      while (!release && Date.now() < waitDeadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(release)
      release()
      await page.waitForFunction(
        () => document.querySelector(".bot-link-preview-card img") !== null
      )
      const after = await page.evaluate(() => ({
        height: document.querySelector(".bot-link-preview-card")!.getBoundingClientRect().height,
        top: document.getElementById("transcript")!.scrollTop,
        detached: window.fixtureDetached,
        focus: document.activeElement?.id,
        body: document.querySelector('[data-message-id="message-39"] .message-text')!.textContent,
        href: document
          .querySelector('[data-message-id="message-39"] .message-text a')!
          .getAttribute("href"),
        injected: window.previewInjected,
        deep: document.querySelector('[data-message-id="message-38"] a')!.getAttribute("href")
      }))
      assert.equal(after.height, before.height)
      assert.ok(Math.abs(after.top - before.top) < 1)
      assert.equal(after.detached, before.detached)
      assert.equal(after.focus, "composer")
      assert.equal(after.body, original)
      assert.equal(after.href, original)
      assert.equal(after.deep, deep)
      assert.equal(after.injected, 0)
      results.push(
        "Actual React/Virtuoso: loading→metadata+safe JPEG has unchanged card height/scroll/follow intent/composer focus; literal original text and internal jump anchor preserved"
      )
      await card.focus()
      await page.keyboard.press("Enter")
      assert.deepEqual(await page.evaluate(() => window.fixtureOpens), [original])
      results.push("Keyboard Enter opens exact original external href including fragment")
      await page.waitForTimeout(100)
      assert.equal(await page.evaluate(() => window.fixtureCalls.length), 1)
      results.push("No background preview polling")
      await page.screenshot({ path: resolve(output, "light-preview.png") })
      await page.evaluate(() => window.fixtureTheme("codex-dark"))
      await page.waitForTimeout(160)
      const palette = await page.locator(".bot-link-preview-card").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        body: getComputedStyle(document.body).backgroundColor
      }))
      assert.notEqual(palette.background, "rgb(255, 255, 255)")
      const contrasts = await page.evaluate<number[]>(`(() => {
      const element = document.querySelector(".bot-link-preview-card");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      const luminance = color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      };
      const background = luminance(getComputedStyle(element).backgroundColor);
      return [".bot-link-preview-title", ".bot-link-preview-description"].map(selector => {
        const foreground = luminance(getComputedStyle(element.querySelector(selector)).color);
        return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
      });
    })()`)
      assert.ok(
        contrasts.every((value) => value >= 4.5),
        `Dark preview text contrast: ${contrasts}`
      )
      results.push(
        "Dark theme title and description contrast >=4.5; theme switching has no background interpolation flash"
      )
      await page.screenshot({ path: resolve(output, "dark-preview.png") })
      await page.evaluate(() => window.fixtureOpenFail())
      await card.click()
      await page.locator(".bot-link-preview-open-error").waitFor()
      await card.click()
      await page.waitForFunction(() => !document.querySelector(".bot-link-preview-open-error"))
      results.push("Successful retry clears a previous external-opening failure")
      await page.evaluate(() => window.fixtureOpenRace())
      await card.click()
      await card.click()
      await page.evaluate(() => window.fixtureRejectOpen())
      await page.waitForTimeout(50)
      assert.equal(await page.locator(".bot-link-preview-open-error").count(), 0)
      results.push(
        "An older opening promise failing after a newer success cannot overwrite current feedback"
      )
      await page.evaluate(() => window.fixtureVisible(false))
      await page.waitForTimeout(50)
      await page.evaluate(() => window.fixtureVisible(true))
      await page.waitForTimeout(50)
      assert.equal(await page.evaluate(() => window.fixtureCalls.length), 1)
      assert.equal(await card.evaluate((element) => element.getBoundingClientRect().height), 126)
      results.push(
        "Completed preview survives hidden→visible without a new request or row-height change"
      )
      await page.evaluate(() => window.fixtureSwitch())
      await page.waitForFunction(() => window.fixtureCalls.length === 2)
      const obsoleteDeadline = Date.now() + 3000
      while (!releaseObsolete && Date.now() < obsoleteDeadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(releaseObsolete)
      const obsoleteId = await page.evaluate(() => window.fixtureCalls[1].requestId)
      await page.locator("#composer").focus()
      await page.evaluate(() => window.fixtureVisible(false))
      await page.waitForFunction((id) => window.fixtureCancelled.includes(id), obsoleteId)
      assert.equal(await card.evaluate((element) => element.getBoundingClientRect().height), 126)
      assert.equal(await page.evaluate(() => document.activeElement?.id), "composer")
      await page.evaluate(() => window.fixtureNew())
      await page.waitForTimeout(100)
      assert.equal(await page.evaluate(() => window.fixtureCalls.length), 2)
      releaseObsolete!()
      await page.waitForTimeout(50)
      assert.equal((await card.textContent())!.includes("OBSOLETE"), false)
      results.push(
        "Hidden view cancels pending lease; URL changes and late body while hidden cause no fetch, focus shift or height change"
      )
      await page.evaluate(() => window.fixtureVisible(true))
      await page.waitForFunction(
        () => document.querySelector(".bot-link-preview-title")?.textContent === "New conversation"
      )
      assert.equal(
        (await page.locator(".bot-link-preview-card").textContent())!.includes("OBSOLETE"),
        false
      )
      results.push(
        "View switch cancels old lease and ignores its delayed body; current card receives only its own URL result"
      )
      await page.evaluate(() => window.fixtureUnmount())
      await page.evaluate(() => window.fixtureCache.dispose())
      await service.close()
      await page.waitForTimeout(30)
      assert.equal(fixture.sockets.size, 0)
      assert.equal(service.metrics().active, 0)
      assert.deepEqual(errors, [])
      results.push("Unmount/close joins actual TLS and utility resources; zero page errors")
      await writeFile(
        resolve(output, "browser-results.json"),
        JSON.stringify({ passed: results.length, results, before, after, palette }, null, 2) + "\n"
      )
      console.log(JSON.stringify({ passed: results.length, results }, null, 2))
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            errors,
            html: (await page.content()).slice(0, 12000),
            state: await page.evaluate(() => ({
              cards: document.querySelectorAll(".bot-link-preview-card").length,
              calls: window.fixtureCalls,
              secure: window.isSecureContext,
              crypto: typeof crypto.randomUUID
            }))
          },
          null,
          2
        )
      )
      await page.screenshot({ path: resolve(output, "browser-failure.png") })
      throw error
    } finally {
      console.log("Bot link preview browser end", new Date().toISOString())
    }
  } finally {
    await browser?.close()
    await service.close()
    await fixture.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
