import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Actual existing React question/gallery/preview components; finite transport fixture, no model. */
import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import {
  preparePresentationLayouts,
  renderPresentationPage
} from "../src/main/bots/presentation-layout"
import { prepareBotImage } from "../src/main/bots/image-reader"
import { writePresentation } from "../src/main/bots/presentation-writer"
import { BOT_PRESENTATION_LABELS, BOT_PRESENTATION_STYLES } from "../src/shared/bot-presentation"

async function main() {
  const root = process.cwd(),
    renderer = resolve(root, "src/renderer/src"),
    output = resolve(root, "output/powerpoint-browser")
  await mkdir(output, { recursive: true })
  const input = {
    name: "交付说明.pptx",
    title: "交付说明",
    slides: [
      { kind: "title" as const, title: "研发工作与交付", subtitle: "持续推进 · 清晰验证" },
      {
        kind: "content" as const,
        title: "技术能力与交付价值",
        points: ["保存项目上下文与工作进展", "按实际验证结果交付文件", "关键操作由人员审核"]
      }
    ]
  }
  const layouts = preparePresentationLayouts(input),
    pages = []
  for (let i = 0; i < layouts[1].pages.length; i++)
    pages.push(await renderPresentationPage(layouts[1], i))
  const artifacts = [],
    thumbnails: Record<string, unknown> = {}
  for (const [i, style] of BOT_PRESENTATION_STYLES.entries()) {
    const page = await renderPresentationPage(layouts[i], 1),
      bytes = Buffer.from(page.base64, "base64")
    const artifact = {
      id: `sample-${style}`,
      conversationId: "conversation",
      runId: "run",
      name: `${BOT_PRESENTATION_LABELS[style]}-样稿.png`,
      mime: "image/png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: 1
    }
    artifacts.push(artifact)
    thumbnails[artifact.id] = {
      artifact,
      kind: "image",
      image: await prepareBotImage({ kind: "image", bytes })
    }
    await writeFile(resolve(output, `${style}.png`), bytes)
  }
  const original = await writePresentation(layouts[1])
  const file = {
    id: "presentation-original",
    conversationId: "conversation",
    runId: "run",
    name: input.name,
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
    createdAt: 1
  }
  const longLayout = preparePresentationLayouts({
    ...input,
    name: "三页说明.pptx",
    slides: [...input.slides, { kind: "content", title: "结束页", points: ["回到工作区继续任务"] }]
  })[1]
  const longPages = []
  for (let i = 0; i < longLayout.pages.length; i++)
    longPages.push(await renderPresentationPage(longLayout, i))
  const longOriginal = await writePresentation(longLayout)
  const longFile = {
    ...file,
    id: "presentation-long",
    name: "三页说明.pptx",
    size: longOriginal.length,
    sha256: createHash("sha256").update(longOriginal).digest("hex")
  }
  const questions = {
    questions: [
      {
        id: "presentation_style",
        header: "版式",
        question: "选择演示文稿的版式",
        options: BOT_PRESENTATION_STYLES.map((style) => ({
          label: BOT_PRESENTATION_LABELS[style],
          description: "选择此版式继续制作"
        }))
      }
    ]
  }
  const item = {
    id: "style-request",
    runId: "run",
    kind: "question",
    status: "pending",
    revision: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    actionHash: null,
    answer: null,
    prompt: JSON.stringify({
      botQuestions: { version: 1, input: questions },
      botPresentation: {
        version: 1,
        dataEpoch: "epoch-original",
        conversationId: "conversation",
        runId: "run",
        inputSha256: "a".repeat(64),
        callId: "browser-call",
        layoutHashes: ["b".repeat(64), "c".repeat(64), "d".repeat(64)],
        images: artifacts
          .map((artifact) => ({
            ...artifact,
            sourceId: artifact.id,
            sourceConversationId: "conversation",
            alt: artifact.name
          }))
          .map(({ id, sourceId, sourceConversationId, name, mime, size, sha256, alt }) => ({
            id,
            sourceId,
            sourceConversationId,
            name,
            mime,
            size,
            sha256,
            alt
          }))
      }
    })
  }
  const css = await compile(
    (await readFile(resolve(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const worker = await build({
    entryPoints: [resolve(renderer, "components/tabs/code-highlight-worker.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{BotQuestions}from'./src/renderer/src/components/bots/BotQuestions';
    import{BotFilePreview}from'./src/renderer/src/components/bots/BotFilePreview';
    import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
    import './src/renderer/src/components/bots/bot-workspace.css';
    applyThemePreference(document.documentElement.dataset.fixtureTheme);
    window.fixtureAnswers=[];window.fixtureCancels=[];window.fixturePreviewCalls=[];window.fixtureOriginal=${JSON.stringify(file)};
    window.fixtureApi={
      filePreview:async({id,offset})=>{window.fixturePreviewCalls.push({id,offset});if(id.startsWith('presentation-')&&offset===window.fixtureHoldOffset){window.fixtureWaiting=true;await new Promise(resolve=>window.fixtureRelease=()=>{window.fixtureWaiting=false;window.fixtureHoldOffset=undefined;resolve();});}return id==='presentation-original'?{artifact:window.fixtureOriginal,kind:'presentation',presentation:${JSON.stringify(pages)}[offset]}:id==='presentation-long'?{artifact:${JSON.stringify(longFile)},kind:'presentation',presentation:${JSON.stringify(longPages)}[offset]}:${JSON.stringify(thumbnails)}[id];},
      cancelFilePreview:async(input)=>window.fixtureCancels.push(input),
      answer:async(input)=>{window.fixtureAnswers.push(input);if(input.expectedDataEpoch!=='epoch-original')throw Error('wrong epoch');return {};}
    };
    window.electron={process:{platform:'darwin'}};
    function Fixture(){const[view,setView]=useState('choice');const[id,setId]=useState('presentation-original');window.fixtureId=setId;return <main className="bot-workspace min-h-screen bg-background px-5 py-8 text-foreground"><div className="mx-auto max-w-3xl space-y-6"><h1 className="text-lg font-semibold">演示文稿交付</h1><div className="flex gap-3"><button onClick={()=>setView('choice')}>显示样稿</button><button onClick={()=>setView('preview')}>查看演示文稿</button><button onClick={()=>setView('empty')}>清空视图</button></div>{view==='choice'&&<BotQuestions item={${JSON.stringify(item)}} questions={${JSON.stringify(questions)}} refresh={async()=>{}}/>}{view==='preview'&&<BotFilePreview id={id} conversationId="conversation" close={()=>setView('empty')}/>}</div></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: resolve(output, "ui.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"presentation-fixture"'
    },
    plugins: [
      viteUrlAssetsFixture(),
      {
        name: "finite-existing-transports",
        setup(builder) {
          builder.onResolve({ filter: /(^|\/)bot-api$/ }, () => ({
            path: "api",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "worker",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            loader: "js",
            contents:
              path === "api"
                ? "export const botApi=new Proxy({}, {get:(_,key)=>(...args)=>window.fixtureApi[key](...args)});"
                : path === "thread"
                  ? "export const useThreadStateSelector=(_id,selector)=>selector({workspacePath:null,workspaceFiles:[]});"
                  : `export default class extends Worker{constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(worker.outputFiles[0].text)}],{type:'text/javascript'}));super(url,options);URL.revokeObjectURL(url);}}`
          }))
        }
      }
    ]
  })
  const style =
    css.build(scanner.scan()) +
    (bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "")
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const evidence = []
  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        colorScheme: theme as "light" | "dark",
        reducedMotion: "reduce"
      })
      try {
        const page = await context.newPage(),
          errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.setDefaultTimeout(5000)
        await page.route("**/*", (route) =>
          route.request().url() === "http://127.0.0.1/presentation"
            ? route.fulfill({
                contentType: "text/html",
                body: `<html lang="zh-CN" data-fixture-theme="codex-${theme}"><head><style>${style}</style></head><body><div id="root"></div></body></html>`
              })
            : route.abort()
        )
        // Keep browser instrumentation independent of tsx's function-name helpers.
        await page.addInitScript({
          content: `(() => {
          const alive = new Set(),
            create = URL.createObjectURL.bind(URL),
            revoke = URL.revokeObjectURL.bind(URL)
          URL.createObjectURL = (blob) => {
            const value = create(blob)
            alive.add(value)
            return value
          }
          URL.revokeObjectURL = (value) => {
            alive.delete(value)
            revoke(value)
          }
          Object.assign(window, { fixtureBlobCount: () => alive.size })
        })()`
        })
        await page.goto("http://127.0.0.1/presentation")
        assert.equal(
          await page.evaluate(
            () => typeof (window as unknown as { fixtureBlobCount: unknown }).fixtureBlobCount
          ),
          "function"
        )
        assert.deepEqual(errors, [])
        await page.addScriptTag({
          content: bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text
        })
        assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), theme)
        await page.waitForFunction(
          () => document.querySelectorAll('[aria-label="演示文稿版式样稿"] img').length === 3
        )
        assert.equal(await page.locator('[aria-label="演示文稿版式样稿"] button').count(), 3)
        const selectedStyle = page.getByRole("radio", { name: /深海蓝 选择此版式/ })
        await selectedStyle.click()
        assert.equal(await selectedStyle.getAttribute("aria-checked"), "true")
        await page.getByRole("button", { name: "提交", exact: true }).click()
        await page.waitForFunction(
          () => (window as unknown as { fixtureAnswers: unknown[] }).fixtureAnswers.length === 1
        )
        const answer = await page.evaluate(
          () =>
            (
              window as unknown as {
                fixtureAnswers: { expectedDataEpoch: string; answer: string }[]
              }
            ).fixtureAnswers[0]
        )
        assert.equal(answer.expectedDataEpoch, "epoch-original")
        assert.equal(JSON.parse(answer.answer).answers.presentation_style.optionIndex, 1)
        await page.screenshot({ path: resolve(output, `${theme}-choice.png`) })
        await page.getByRole("button", { name: "查看演示文稿", exact: true }).click()
        await page.getByRole("img", { name: "第 1 页幻灯片", exact: true }).waitFor()
        assert.equal(await page.getByRole("button", { name: "上一张幻灯片" }).isDisabled(), true)
        await page.evaluate(() => Object.assign(window, { fixtureHoldOffset: 1 }))
        const next = page.getByRole("button", { name: "下一张幻灯片" })
        await next.evaluate((element) => {
          Object.assign(window, { fixtureNextButton: element })
        })
        await next.click()
        await page.waitForFunction(
          () => (window as unknown as { fixtureWaiting: boolean }).fixtureWaiting
        )
        assert.equal(await next.evaluate((element) => element === document.activeElement), true)
        const heldCalls = await page.evaluate(
          () => (window as unknown as { fixturePreviewCalls: unknown[] }).fixturePreviewCalls.length
        )
        await page.keyboard.press("Enter")
        await page.keyboard.press("Space")
        await next.evaluate((element) => (element as HTMLButtonElement).click())
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { fixturePreviewCalls: unknown[] }).fixturePreviewCalls.length
          ),
          heldCalls,
          "Disabled keyboard and programmatic click paths must not queue another page"
        )
        assert.equal(await page.getByRole("heading", { name: input.name, exact: true }).count(), 1)
        assert.equal(await page.getByRole("button", { name: "上一张幻灯片" }).isDisabled(), true)
        assert.equal(await page.getByRole("button", { name: "下一张幻灯片" }).isDisabled(), true)
        assert.equal(
          await page.getByRole("button", { name: "保存原文件", exact: true }).isDisabled(),
          false
        )
        assert.equal(await page.getByRole("img", { name: "第 1 页幻灯片", exact: true }).count(), 0)
        assert.equal(
          await page.evaluate(() =>
            (window as unknown as { fixtureBlobCount(): number }).fixtureBlobCount()
          ),
          0
        )
        await page.evaluate(() =>
          (window as unknown as { fixtureRelease(): void }).fixtureRelease()
        )
        await page.getByRole("img", { name: "第 2 页幻灯片", exact: true }).waitFor()
        assert.equal(
          await next.evaluate(
            (element) =>
              element === document.activeElement &&
              element ===
                (window as unknown as { fixtureNextButton: HTMLElement }).fixtureNextButton
          ),
          true,
          "Completing a page load must keep keyboard focus on the same Next button"
        )
        assert.equal(await page.getByRole("button", { name: "下一张幻灯片" }).isDisabled(), true)
        assert.equal(await page.getByRole("button", { name: "保存原文件", exact: true }).count(), 1)
        assert.equal(await page.getByText(/保存布局预览/).count(), 1)
        await page.screenshot({ path: resolve(output, `${theme}-page2.png`) })
        await page.evaluate(() => Object.assign(window, { fixtureHoldOffset: 0 }))
        await page.getByRole("button", { name: "上一张幻灯片" }).click()
        await page.waitForFunction(
          () => (window as unknown as { fixtureWaiting: boolean }).fixtureWaiting
        )
        await page.evaluate(() =>
          (window as unknown as { fixtureId(id: string): void }).fixtureId("sample-warm")
        )
        await page.getByRole("heading", { name: "暖纸色-样稿.png", exact: true }).waitFor()
        for (const name of ["缩小", "放大", "顺时针旋转90°", "重置视图"]) {
          const control = page.getByRole("button", { name, exact: true })
          await control.waitFor()
          assert.equal(await control.getAttribute("title"), name)
        }
        assert.equal(await page.getByText("图片", { exact: true }).count(), 1)
        assert.equal(await page.getByText("Image", { exact: true }).count(), 0)
        const image = page.getByRole("img", { name: "暖纸色-样稿.png", exact: true })
        const zoomOut = page.getByRole("button", { name: "缩小", exact: true })
        const zoomIn = page.getByRole("button", { name: "放大", exact: true })
        await zoomOut.click()
        await page.waitForFunction(() => {
          const image = document.querySelector('img[alt="暖纸色-样稿.png"]')!
          return new DOMMatrixReadOnly(getComputedStyle(image).transform).a === 0.75
        })
        await page.getByText("75%", { exact: true }).waitFor()
        await zoomIn.focus()
        await page.keyboard.press("Space")
        await page.getByText("100%", { exact: true }).waitFor()
        await page.keyboard.press("Enter")
        await page.getByText("125%", { exact: true }).waitFor()
        await page.getByText("拖动平移", { exact: true }).waitFor()
        assert.equal(await page.getByText("Drag to pan", { exact: true }).count(), 0)
        await page.getByRole("button", { name: "顺时针旋转90°", exact: true }).focus()
        await page.keyboard.press("Enter")
        await page.waitForFunction(() => {
          const image = document.querySelector('img[alt="暖纸色-样稿.png"]')!
          const matrix = new DOMMatrixReadOnly(getComputedStyle(image).transform)
          return Math.abs(matrix.a) < 0.0001 && matrix.b === 1.25 && matrix.c === -1.25
        })
        const bounds = await image.boundingBox()
        assert.ok(bounds)
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        await page.mouse.down()
        await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2 + 16)
        await page.mouse.up()
        await page.waitForFunction(() => {
          const matrix = new DOMMatrixReadOnly(
            getComputedStyle(document.querySelector('img[alt="暖纸色-样稿.png"]')!).transform
          )
          return matrix.e === 24 && matrix.f === 16
        })
        await page.getByRole("button", { name: "重置视图", exact: true }).click()
        await page.waitForFunction(() => {
          const image = document.querySelector('img[alt="暖纸色-样稿.png"]')!
          return new DOMMatrixReadOnly(getComputedStyle(image).transform).isIdentity
        })
        await page.getByText("100%", { exact: true }).waitFor()
        assert.equal(await page.getByText("拖动平移", { exact: true }).count(), 0)
        await page.screenshot({ path: resolve(output, `${theme}-image-toolbar.png`) })
        const download = page.getByRole("button", { name: "保存原文件", exact: true })
        await download.focus()
        assert.equal(await page.getByRole("heading", { name: input.name, exact: true }).count(), 0)
        assert.equal(await page.getByRole("button", { name: "下一张幻灯片" }).count(), 0)
        await page.evaluate(() =>
          (window as unknown as { fixtureRelease(): void }).fixtureRelease()
        )
        await page.waitForFunction(
          () => (window as unknown as { fixtureBlobCount(): number }).fixtureBlobCount() === 1
        )
        assert.equal(
          await page.getByRole("heading", { name: "暖纸色-样稿.png", exact: true }).count(),
          1
        )
        assert.equal(await download.evaluate((element) => element === document.activeElement), true)
        assert.equal(await page.getByRole("img", { name: "第 1 页幻灯片", exact: true }).count(), 0)
        await page.keyboard.press("Escape")
        await page.waitForFunction(
          () => (window as unknown as { fixtureBlobCount(): number }).fixtureBlobCount() === 0
        )
        // Close with a held page request: its late completion must not reclaim focus or a Blob.
        await page.evaluate(() =>
          (window as unknown as { fixtureId(id: string): void }).fixtureId("presentation-original")
        )
        await page.getByRole("button", { name: "查看演示文稿", exact: true }).click()
        await page.getByRole("img", { name: "第 1 页幻灯片", exact: true }).waitFor()
        await page.evaluate(() => Object.assign(window, { fixtureHoldOffset: 1 }))
        await page.getByRole("button", { name: "下一张幻灯片" }).click()
        await page.waitForFunction(
          () => (window as unknown as { fixtureWaiting: boolean }).fixtureWaiting
        )
        await page.keyboard.press("Escape")
        await page.getByRole("dialog").waitFor({ state: "detached" })
        const outside = page.getByRole("button", { name: "显示样稿", exact: true })
        await outside.focus()
        await page.evaluate(() =>
          (window as unknown as { fixtureRelease(): void }).fixtureRelease()
        )
        assert.equal(await outside.evaluate((element) => element === document.activeElement), true)
        assert.equal(
          await page.evaluate(() =>
            (window as unknown as { fixtureBlobCount(): number }).fixtureBlobCount()
          ),
          0
        )

        // A three-page document also preserves Next at an enabled intermediate page.
        await page.evaluate(() =>
          (window as unknown as { fixtureId(id: string): void }).fixtureId("presentation-long")
        )
        await page.getByRole("button", { name: "查看演示文稿", exact: true }).click()
        await page.getByRole("img", { name: "第 1 页幻灯片", exact: true }).waitFor()
        await page.evaluate(() => Object.assign(window, { fixtureHoldOffset: 1 }))
        await next.evaluate((element) => {
          Object.assign(window, { fixtureNextButton: element })
        })
        await next.focus()
        await page.keyboard.press("Enter")
        await page.waitForFunction(
          () => (window as unknown as { fixtureWaiting: boolean }).fixtureWaiting
        )
        assert.equal(await next.evaluate((element) => element === document.activeElement), true)
        await page.evaluate(() =>
          (window as unknown as { fixtureRelease(): void }).fixtureRelease()
        )
        await page.getByRole("img", { name: "第 2 页幻灯片", exact: true }).waitFor()
        assert.equal(await next.isEnabled(), true)
        assert.equal(
          await next.evaluate(
            (element) =>
              element === document.activeElement &&
              element ===
                (window as unknown as { fixtureNextButton: HTMLElement }).fixtureNextButton
          ),
          true
        )
        await page.keyboard.press("Space")
        await page.getByRole("img", { name: "第 3 页幻灯片", exact: true }).waitFor()
        assert.equal(await next.isDisabled(), true)
        assert.equal(await next.evaluate((element) => element === document.activeElement), true)
        const lastPageCalls = await page.evaluate(
          () => (window as unknown as { fixturePreviewCalls: unknown[] }).fixturePreviewCalls.length
        )
        await page.keyboard.press("Enter")
        await page.keyboard.press("Space")
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { fixturePreviewCalls: unknown[] }).fixturePreviewCalls.length
          ),
          lastPageCalls
        )
        await page.keyboard.press("Shift+Tab")
        const previous = page.getByRole("button", { name: "上一张幻灯片" })
        assert.equal(await previous.evaluate((element) => element === document.activeElement), true)
        await page.keyboard.press("Space")
        await page.getByRole("img", { name: "第 2 页幻灯片", exact: true }).waitFor()
        assert.equal(await previous.evaluate((element) => element === document.activeElement), true)
        // Explicitly moving focus during a slow page load must be respected.
        await page.evaluate(() => Object.assign(window, { fixtureHoldOffset: 0 }))
        await page.keyboard.press("Enter")
        await page.waitForFunction(
          () => (window as unknown as { fixtureWaiting: boolean }).fixtureWaiting
        )
        await download.focus()
        await page.evaluate(() =>
          (window as unknown as { fixtureRelease(): void }).fixtureRelease()
        )
        await page.getByRole("img", { name: "第 1 页幻灯片", exact: true }).waitFor()
        assert.equal(await download.evaluate((element) => element === document.activeElement), true)
        await page.screenshot({ path: resolve(output, `${theme}-paging-focus.png`) })
        await page.keyboard.press("Escape")
        await page.waitForFunction(
          () => (window as unknown as { fixtureBlobCount(): number }).fixtureBlobCount() === 0
        )
        assert.deepEqual(errors, [])
        evidence.push({
          theme,
          threeSamples: true,
          exactTypedChoice: true,
          pageNavigation: true,
          imageControlsNamedAndLocalized: true,
          realImageZoomRotatePanReset: true,
          stablePagingMetadata: true,
          pagingFocusPreserved: true,
          disabledKeyboardAndClickGuarded: true,
          intermediateAndBoundaryPageFocus: true,
          lateCompletionDoesNotReclaimFocus: true,
          noStaleArtifactMetadataOrPixels: true,
          originalDownloadEntry: true,
          blobCountAfterClose: 0,
          errors
        })
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  await writeFile(
    resolve(output, "result.safe.json"),
    JSON.stringify(
      {
        boundary:
          "original React components with finite transport; real worker-independent layout/OOXML sources; not model/Office/native app acceptance",
        evidence
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ passed: evidence.length, output }))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
