/** Real Markdown/link/search/code DOM; workspace state and clipboard writes are controlled. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

const text =
  "# Cached history\n\nNeedle stays searchable.\n\n" +
  "[Open report](/workspace-a/report.md:12) and `report.md`.\n\n" +
  "[unsafe](javascript:alert(1)) [safe](https://example.test)\n\n" +
  "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] Done\n\n```ts\nconst value = 1\n```"

async function main() {
  const output = resolve("output/markdown-parse-cache-browser")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{StreamingMarkdown}from'./src/renderer/src/components/chat/StreamingMarkdown';
      import{completedMarkdownParseCache as cache}from'./src/renderer/src/lib/markdown-parse-cache';
      import{onOpenResourcePreview}from'./src/renderer/src/lib/resource-preview-events';
      import{onOpenResourcePanelOverlay}from'./src/renderer/src/lib/resource-panel-overlay-events';
      const text=${JSON.stringify(text)},previews=[],overlays=[],copies=[];
      window.electron={process:{platform:'linux'}};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copies.push(value)}});
      onOpenResourcePreview(detail=>previews.push(detail));onOpenResourcePanelOverlay(mode=>overlays.push(mode));
      const location={kind:'body',blockIndex:0,sourceStart:0,sourceEnd:text.length,revision:'v1',
        start:text.indexOf('Needle'),end:text.indexOf('Needle')+6,segmentOccurrence:0,
        context:'before Needle after',contextStart:7,contextEnd:13};
      function Fixture(){const[visible,setVisible]=useState(true),[thread,setThread]=useState('a'),
        [content,setContent]=useState(text),[streaming,setStreaming]=useState(false);
        window.markdownCacheFixture={stats:()=>cache.stats(),previews,overlays,copies,
          show:setVisible,thread:setThread,text:setContent,stream:setStreaming};
        return visible?<StreamingMarkdown threadId={thread} searchLocation={{...location,revision:thread}}
          isStreaming={streaming}>{content}</StreamingMarkdown>:null
      }createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.hot": "undefined" },
    plugins: [
      {
        name: "controlled-workspace-state",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, (args) => ({
            path: args.path,
            namespace: "workspace"
          }))
          builder.onLoad({ filter: /.*/, namespace: "workspace" }, () => ({
            contents:
              "const files=[{path:'report.md',is_dir:false}];export const useThreadStateSelector=(id,select)=>select({workspacePath:id==='b'?'/workspace-b':'/workspace-a',workspaceFiles:files})"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const command = (name: string, value: unknown) =>
    page.evaluate(
      ({ name, value }) => {
        const fixture = (
          window as unknown as { markdownCacheFixture: Record<string, (value: unknown) => void> }
        ).markdownCacheFixture
        fixture[name](value)
      },
      { name, value }
    )
  const inspect = () =>
    page.evaluate(() => {
      const fixture = (
        window as unknown as {
          markdownCacheFixture: {
            stats(): { parses: number; hits: number; entries: number; bytes: number }
            previews: Array<{ threadId: string; filePath: string }>
            overlays: string[]
            copies: string[]
          }
        }
      ).markdownCacheFixture
      return {
        stats: fixture.stats(),
        previews: fixture.previews,
        overlays: fixture.overlays,
        copies: fixture.copies
      }
    })
  try {
    await page.setContent('<div id="root"></div>')
    for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css")))
      await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    await page.addScriptTag({ content: "window.__name=value=>value" })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("link", { name: "report.md", exact: true }).waitFor()
    await page.getByRole("link", { name: "Open report", exact: true }).click()
    await page.getByRole("button", { name: "复制代码", exact: true }).click()
    await page.getByRole("button", { name: "已复制代码", exact: true }).waitFor()
    assert.equal(await page.locator("table tbody tr").count(), 1)
    assert.equal(await page.locator('input[type="checkbox"][checked][disabled]').count(), 1)
    assert((await page.locator(".hljs-keyword").count()) > 0)
    assert.equal(await page.locator("[data-chat-search-context-hit]").textContent(), "Needle")
    assert.equal(
      await page
        .locator('[data-chat-search-source-start="0"]')
        .getAttribute("data-chat-search-source-end"),
      String(text.length)
    )
    assert.equal(await page.getByRole("link", { name: "unsafe", exact: true }).count(), 0)
    assert.equal(
      await page.getByRole("link", { name: "safe", exact: true }).getAttribute("href"),
      "https://example.test"
    )
    const first = await inspect()
    assert.equal(first.stats.parses, 1)
    assert.deepEqual(first.copies, ["const value = 1"])
    assert.equal(first.previews[0].threadId, "a")
    assert.equal(first.previews[0].filePath, "/workspace-a/report.md")

    await command("show", false)
    await page.locator(".streaming-markdown").waitFor({ state: "detached" })
    await command("thread", "b")
    await command("show", true)
    await page.getByRole("link", { name: "report.md", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("link", { name: "Open report", exact: true }).count(),
      0,
      "A cached AST cannot retain the first workspace's file-preview callback"
    )
    await page.getByRole("link", { name: "report.md", exact: true }).click()
    await page.getByRole("button", { name: "复制代码", exact: true }).click()
    await page.getByRole("button", { name: "已复制代码", exact: true }).waitFor()
    const second = await inspect()
    assert.equal(second.stats.parses, 1)
    assert(second.stats.hits > first.stats.hits)
    assert.equal(second.previews.at(-1)!.threadId, "b")
    assert.equal(second.previews.at(-1)!.filePath, "/workspace-b/report.md")
    assert.deepEqual(second.copies, ["const value = 1", "const value = 1"])
    assert.equal(await page.locator("[data-chat-search-context-hit]").textContent(), "Needle")

    await command("text", text + "\n\nDifferent final text")
    await page.getByText("Different final text", { exact: true }).waitFor()
    const changed = await inspect()
    assert.equal(changed.stats.parses, 2)
    assert.deepEqual(errors, [])
    const evidence = {
      first,
      second,
      changed,
      errors,
      scope:
        "Actual StreamingMarkdown/remark/rehype/link/search/copy DOM; controlled workspace state and clipboard adapter"
    }
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
    console.log(
      "PASS pure Markdown parse reuse with fresh workspace links, search, highlighting, sanitizer and code-copy callbacks " +
        JSON.stringify(evidence)
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
