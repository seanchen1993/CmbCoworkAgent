/** Actual message components/navigation in Chrome; native opening and unused Thread state are fixtures. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { botMessageLink } from "../src/shared/bot-deep-link"

async function main() {
  const conversationId = "11111111-1111-4111-8111-111111111111"
  const messageId = "22222222-2222-4222-8222-222222222222"
  const internal = botMessageLink({ conversationId, messageId })
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/bot-message-links")
  await mkdir(output, { recursive: true })
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
  const plain = `🙂 资料 https://example.com/guide?x=1，核对/review 后续 (https://example.org/a_(b))。原消息 ${internal} <img src=x> [literal](https://literal.example)`
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';
        import{BotMessageMarkdown as StreamingMarkdown}from'./src/renderer/src/components/bots/BotMessageMarkdown';
        import{BotMessageText}from'./src/renderer/src/components/bots/BotMessageText';
        import{useBotNavigation}from'./src/renderer/src/lib/use-bot-navigation';
        import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
        import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
        import './src/renderer/src/components/bots/bot-workspace.css';
        window.api={botNavigation:{ready:async()=>{},onOpen:()=>()=>{}}};window.fixtureOpened=[];window.fixtureSkills=[];
        window.electron={process:{platform:'darwin'},openExternal:url=>window.fixtureOpened.push(url)};
        window.fixtureNavigation=()=>useBotWorkspaceStore.getState().navigation;
        window.fixtureReset=()=>useBotWorkspaceStore.setState({navigation:null});
        window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');
        document.addEventListener('click',event=>{if(event.defaultPrevented||!(event.target instanceof Element))return;const anchor=event.target.closest('a');if(!anchor)return;try{const url=new URL(anchor.href);if(['http:','https:'].includes(url.protocol)){event.preventDefault();window.electron.openExternal(anchor.href)}}catch{}});
        const text=${JSON.stringify(plain)},from=text.indexOf('/review');
        const message={id:'message',conversationId:'conversation',sender:'user',botId:null,text,runId:null,replyTo:null,sequence:1,createdAt:1,attachments:[],skillReferences:[{botId:'owner',id:'review',version:2,name:'review'}],inlineReferences:[{from,to:from+7,reference:{kind:'skill',id:'review',botId:'owner',version:2}}]};
        const markdown=${JSON.stringify(`[原消息](${internal})\n\n[External](https://example.net/guide)\n\n[invalid](cmbcowork://evil/v1/bots/${conversationId}/messages/${messageId}) [unsafe](javascript:alert) [image](file:///etc/passwd)\n\n![bad image](${internal})`)};
        function Fixture(){useBotNavigation();return <main className="bot-workspace" style={{display:'block',padding:32,maxWidth:840}}><section data-user-text className="bot-message-bubble"><BotMessageText message={message} conversationFor={()=>undefined} open={()=>{}} openSkill={skill=>window.fixtureSkills.push(skill)}/></section><section data-bot-markdown className="bot-message-bubble" style={{marginTop:24}}><StreamingMarkdown>{markdown}</StreamingMarkdown></section></main>}
        createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "links.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    plugins: [
      {
        name: "unused-chat-thread",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread-context",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents: "export const useThreadStateSelector=()=>null;"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } })
  const errors: string[] = []
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://127.0.0.1:39183/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1:39183")
    await page.addStyleTag({ content: css.build(scanner.scan()) })
    for (const file of bundle.outputFiles) {
      if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text })
      else await page.addScriptTag({ content: file.text })
    }
    const user = page.locator("[data-user-text]")
    const markdown = page.locator("[data-bot-markdown]")
    await user.waitFor()
    assert.equal(await user.textContent(), plain, "linkification must preserve literal input")
    assert.equal(await user.locator('a[href="https://example.com/guide?x=1"]').count(), 1)
    assert.equal(await user.locator('a[href="https://example.org/a_(b)"]').count(), 1)
    assert.equal(await user.locator("img").count(), 0, "literal HTML must never be inserted")
    await user.getByRole("button", { name: "/review" }).click()
    assert.deepEqual(await page.evaluate("window.fixtureSkills"), [
      { botId: "owner", id: "review", version: 2, name: "review" }
    ])
    const internalAnchor = markdown.getByRole("link", { name: "原消息", exact: true })
    assert.equal(await internalAnchor.getAttribute("href"), internal)
    await internalAnchor.click()
    assert.deepEqual(await page.evaluate("window.fixtureNavigation()"), {
      conversationId,
      messageId
    })
    await page.evaluate("window.fixtureReset()")
    await user.locator(`a[href="${internal}"]`).click()
    assert.deepEqual(await page.evaluate("window.fixtureNavigation()"), {
      conversationId,
      messageId
    })
    await markdown.getByRole("link", { name: "External", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.fixtureOpened"), ["https://example.net/guide"])
    assert.equal(await markdown.getByRole("link", { name: "invalid", exact: true }).count(), 0)
    assert.equal(await markdown.getByRole("link", { name: "unsafe", exact: true }).count(), 0)
    assert.equal(await markdown.getByRole("link", { name: "image", exact: true }).count(), 0)
    assert.equal(await markdown.locator(`img[src="${internal}"]`).count(), 0)
    await page.screenshot({ path: join(output, "message-links-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.screenshot({ path: join(output, "message-links-dark.png"), animations: "disabled" })
    assert.deepEqual(errors, [])
    console.log(
      "PASS: literal URL punctuation/references, internal Markdown and plain navigation, safe schemes, external opener and themes"
    )
  } catch (error) {
    console.error("Page errors:", errors)
    await writeFile(join(output, "failure.html"), await page.content())
    await page.screenshot({ path: join(output, "failure.png"), animations: "disabled" })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
