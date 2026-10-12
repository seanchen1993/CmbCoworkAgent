/** Isolated real React/Chromium presentation contract; no Host, model, user data
 * or application window. The message renderer and quotation parser are original. */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

const lines = Array.from(
  { length: 40 },
  (_, index) => `第 ${index + 1} 行：保留原始任务说明 🙂`
).join("\n")
const text = `${lines}\n@日检 https://example.com/quoted-task\n尾部目标：保持完整原文 🙂`
const referenceStart = text.indexOf("@日检")
const message = {
  id: "long-message",
  conversationId: "conversation-one",
  sender: "user",
  botId: null,
  sequence: 1,
  createdAt: 123,
  text,
  runId: null,
  replyTo: null,
  attachments: [],
  inlineReferences: [
    { from: referenceStart, to: referenceStart + 3, reference: { kind: "routine", id: "routine" } }
  ],
  entityReferences: [
    { kind: "routine", id: "routine", name: "日检", conversationId: "routine-conversation" }
  ]
}
type Fixture = {
  fixture: {
    show(id: string, conversationId: string, sender?: string, reveal?: boolean, body?: string): void
    hide(): void
    unmount(): void
  }
  observerCount: number
}
async function main(): Promise<void> {
  const root = process.cwd()
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{BotMessageText}from'./src/renderer/src/components/bots/BotMessageText';
      import{captureBotMessageQuote}from'./src/renderer/src/lib/bot-selection-quote';
      const initial=${JSON.stringify(message)};
      window.captureQuote=()=>captureBotMessageQuote(document.getElementById('transcript'),window.getSelection(),{viewId:'view',conversationId:window.currentMessage.conversationId,dataEpoch:'epoch',active:true,messages:[window.currentMessage]});
      const root=createRoot(document.getElementById('root'));
      function Fixture(){const[state,set]=useState({message:initial,reveal:false,hidden:false});window.currentMessage=state.message;window.fixture={show:(id,conversationId,sender='user',reveal=false,body)=>set({message:{...initial,id,conversationId,sender,...body===undefined?{}:{text:body,inlineReferences:[],entityReferences:[]}},reveal,hidden:false}),hide:()=>set(s=>({...s,hidden:!s.hidden})),unmount:()=>root.unmount()};
        return <main id="transcript" style={{display:state.hidden?'none':'block'}}><article className="bot-message" data-sender={state.message.sender} data-message-id={state.message.id}><div className="bot-message-bubble"><div data-bot-quote-source={state.message.id}><BotMessageText message={state.message} reveal={state.reveal} conversationFor={()=>'routine-conversation'} open={()=>{}}/></div></div></article></main>}
      root.render(<Fixture/>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": resolve(root, "src/renderer/src") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"message-fold-contract"'
    }
  })
  const css = await readFile(
    resolve(root, "src/renderer/src/components/bots/bot-workspace.css"),
    "utf8"
  )
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("**/*", (route) => route.abort())
    await page.setContent(
      `<style>${css}\n:root{font-family:sans-serif;--muted:#eee;--muted-foreground:#666;--foreground:#222;--ring:#555}body{margin:0;width:700px}.whitespace-pre-wrap{white-space:pre-wrap}</style><div id="root"></div>`
    )
    await page.evaluate(() => {
      const Native = window.ResizeObserver
      const shared = window as unknown as Fixture
      shared.observerCount = 0
      window.ResizeObserver = class extends Native {
        private active = true
        constructor(callback: ResizeObserverCallback) {
          super(callback)
          shared.observerCount++
        }
        disconnect(): void {
          if (this.active) {
            this.active = false
            shared.observerCount--
          }
          super.disconnect()
        }
      }
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const fold = page.getByRole("button", { name: "展开", exact: true })
    await fold.waitFor()
    assert.equal(await fold.getAttribute("aria-expanded"), "false")
    const controlId = await fold.getAttribute("aria-controls")
    const clip = page.locator(".bot-user-message-clip")
    const body = page.locator(".bot-user-message-content")
    assert.equal(await body.textContent(), text)
    assert.ok((await clip.boundingBox())!.height < (await body.boundingBox())!.height - 100)
    await body.evaluate(
      (node) => ((window as unknown as { originalBody: Element }).originalBody = node)
    )
    await fold.focus()
    await fold.press("Enter")
    const collapse = page.getByRole("button", { name: "收起", exact: true })
    await collapse.waitFor()
    assert.equal(await collapse.getAttribute("aria-expanded"), "true")
    assert.equal(await collapse.getAttribute("aria-controls"), controlId)
    assert.ok(Math.abs((await clip.boundingBox())!.height - (await body.boundingBox())!.height) < 2)
    assert.ok(
      await body.evaluate(
        (node) => node === (window as unknown as { originalBody: Element }).originalBody
      )
    )
    assert.equal(await page.locator('[data-kind="routine"]').innerText(), "@日检")
    assert.equal(await page.locator("a").getAttribute("href"), "https://example.com/quoted-task")
    const quoted = await page.evaluate(() => {
      const fragment = [...document.querySelectorAll<HTMLElement>("[data-bot-quote-from]")].at(-1)!
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const from = node.textContent!.indexOf("尾部目标")
        if (from < 0) continue
        const range = document.createRange()
        range.setStart(node, from)
        range.setEnd(node, node.textContent!.length)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        break
      }
      return (
        window as unknown as {
          captureQuote(): {
            expectedText: string
            quote: { sourceFragment: { from: number; to: number }; text: string }
          }
        }
      ).captureQuote()
    })
    assert.equal(quoted.expectedText, text)
    assert.equal(quoted.quote.text, "尾部目标：保持完整原文 🙂")
    assert.equal(quoted.quote.sourceFragment.from, referenceStart + 3)
    assert.equal(quoted.quote.sourceFragment.to, text.length)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await collapse.press("Space")
    await fold.waitFor()
    // Keyboard focus reaches the actual hidden link and expands before paint.
    await page.locator("a").focus()
    await collapse.waitFor()
    assert.ok(await page.locator("a").evaluate((node) => document.activeElement === node))
    // Same React callsite and same message ID in another conversation start folded.
    await page.evaluate(() =>
      (window as unknown as Fixture).fixture.show("long-message", "conversation-two")
    )
    await fold.waitFor()
    await page.evaluate(() =>
      (window as unknown as Fixture).fixture.show("new-message", "conversation-two", "user", true)
    )
    await collapse.waitFor()
    await page.evaluate(() =>
      (window as unknown as Fixture).fixture.show("bot-stream", "conversation-two", "bot")
    )
    await page.locator('[data-message-id="bot-stream"]').waitFor()
    assert.equal(await page.locator(".bot-user-message-text").count(), 0)
    assert.equal(await page.locator("[data-bot-quote-source]").textContent(), text)
    await page.waitForFunction(() => (window as unknown as Fixture).observerCount === 0)
    await page.evaluate(() =>
      (window as unknown as Fixture).fixture.show(
        "short",
        "conversation-two",
        "user",
        false,
        "简短任务"
      )
    )
    await page.locator('[data-message-id="short"]').waitFor()
    assert.equal(await page.locator(".bot-user-message-fold").count(), 0)
    assert.equal(await body.textContent(), "简短任务")
    // Ordinary Host notes use a six-line visual limit without rewriting the
    // saved task, authorization or diagnostic payload. Dedicated cards bypass
    // this renderer in the production Workspace; Bot answers remain above.
    const systemText = `${Array.from(
      { length: 12 },
      (_, index) => `Host 任务说明第 ${index + 1} 行：完整授权范围`
    ).join(
      "\n"
    )}\nhttps://example.com/task-details\n{ "observedFingerprint": "原始状态 JSON 保留" }`
    await page.evaluate(
      (body) =>
        (window as unknown as Fixture).fixture.show(
          "system-long",
          "conversation-system",
          "system",
          false,
          body
        ),
      systemText
    )
    await page.locator('[data-message-id="system-long"]').waitFor()
    await fold.waitFor()
    assert.equal(await fold.getAttribute("aria-expanded"), "false")
    const systemControlId = await fold.getAttribute("aria-controls")
    assert.equal(
      await page
        .locator(".bot-user-message-text")
        .evaluate((node) =>
          (node as HTMLElement).style.getPropertyValue("--bot-user-message-lines")
        ),
      "6"
    )
    assert.equal(await body.textContent(), systemText)
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { currentMessage: { text: string } }).currentMessage.text
      ),
      systemText
    )
    const lineHeight = await body.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).lineHeight)
    )
    assert.ok((await clip.boundingBox())!.height <= lineHeight * 6 + 2)
    assert.ok((await body.boundingBox())!.height > lineHeight * 12)
    await body.evaluate(
      (node) => ((window as unknown as { systemBody: Element }).systemBody = node)
    )
    await fold.focus()
    await fold.press("Enter")
    await collapse.waitFor()
    assert.equal(await collapse.getAttribute("aria-controls"), systemControlId)
    assert.equal(await collapse.getAttribute("aria-expanded"), "true")
    assert.equal(await body.textContent(), systemText)
    assert.ok(
      await body.evaluate(
        (node) => node === (window as unknown as { systemBody: Element }).systemBody
      )
    )
    assert.ok(Math.abs((await clip.boundingBox())!.height - (await body.boundingBox())!.height) < 2)
    assert.equal(await page.locator("a").getAttribute("href"), "https://example.com/task-details")
    await collapse.press("Space")
    await fold.waitFor()
    // A real link below the fold is still reachable with keyboard focus and
    // expands before it can remain visually clipped.
    await page.locator("a").focus()
    await collapse.waitFor()
    assert.ok(await page.locator("a").evaluate((node) => document.activeElement === node))
    await collapse.click()
    await fold.waitFor()
    // Search/navigation reveal opens the same message, keeping its source node.
    await page.evaluate(
      (body) =>
        (window as unknown as Fixture).fixture.show(
          "system-long",
          "conversation-system",
          "system",
          true,
          body
        ),
      systemText
    )
    await collapse.waitFor()
    assert.ok(
      await body.evaluate(
        (node) => node === (window as unknown as { systemBody: Element }).systemBody
      )
    )
    assert.equal(await body.textContent(), systemText)
    // The exact boundary matters: short six-line states do not acquire a
    // disclosure control; the seventh line does. Sender reuse resets expansion.
    const shortSystem = Array.from({ length: 6 }, (_, index) => `状态 ${index + 1}`).join("\n")
    await page.evaluate(
      (body) =>
        (window as unknown as Fixture).fixture.show(
          "system-short",
          "conversation-system",
          "system",
          false,
          body
        ),
      shortSystem
    )
    await page.locator('[data-message-id="system-short"]').waitFor()
    await page.waitForFunction(() => !document.querySelector(".bot-user-message-fold"))
    assert.equal(await body.textContent(), shortSystem)
    await page.evaluate(
      (body) =>
        (window as unknown as Fixture).fixture.show(
          "system-short",
          "conversation-system",
          "system",
          false,
          body + "\n状态 7"
        ),
      shortSystem
    )
    await fold.waitFor()
    assert.equal(await fold.getAttribute("aria-expanded"), "false")
    // The same seven lines remain short for a user; its original 24-line policy
    // is independent from system notes.
    await page.evaluate(
      (body) =>
        (window as unknown as Fixture).fixture.show(
          "system-short",
          "conversation-system",
          "user",
          false,
          body + "\n状态 7"
        ),
      shortSystem
    )
    await page.waitForFunction(() => !document.querySelector(".bot-user-message-fold"))
    assert.equal(
      await page
        .locator(".bot-user-message-text")
        .evaluate((node) =>
          (node as HTMLElement).style.getPropertyValue("--bot-user-message-lines")
        ),
      "24"
    )
    // A wrapped paragraph becomes long only when the measured width shrinks.
    await page.evaluate(() =>
      (window as unknown as Fixture).fixture.show(
        "wrapped",
        "conversation-two",
        "user",
        false,
        "保持完整原文 ".repeat(90)
      )
    )
    await page.locator('[data-message-id="wrapped"]').waitFor()
    await page.evaluate(() => (document.body.style.width = "700px"))
    await page.waitForFunction(() => !document.querySelector(".bot-user-message-fold"))
    assert.equal(await page.locator(".bot-user-message-fold").count(), 0)
    await page.evaluate(() => (document.body.style.width = "150px"))
    await fold.waitFor()
    await page.evaluate(() => (window as unknown as Fixture).fixture.hide())
    await page.evaluate(() => (window as unknown as Fixture).fixture.hide())
    await fold.waitFor()
    await page.evaluate(() => (document.body.style.width = "700px"))
    await page.waitForFunction(() => !document.querySelector(".bot-user-message-fold"))
    await page.evaluate(() => (window as unknown as Fixture).fixture.unmount())
    assert.equal(await page.evaluate(() => (window as unknown as Fixture).observerCount), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS user24/system6 measured fold, full original text/links/quote offsets, keyboard/reveal, sender identity and ResizeObserver cleanup"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
