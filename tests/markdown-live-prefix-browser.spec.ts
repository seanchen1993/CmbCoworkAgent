/** Actual live Markdown DOM; no model, Mods authority or simulated parser. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import type { MarkdownParseCache } from "../src/renderer/src/lib/markdown-parse-cache"

interface LiveMarkdownWindow extends Window {
  liveCodeNode: Element
  liveMarkdown: {
    append(index: number): void
    complete(): void
    stats(): {
      prefix: ReturnType<MarkdownParseCache["stats"]>
      live: ReturnType<MarkdownParseCache["stats"]>
      copies: string[]
    }
  }
}

async function main() {
  const output = resolve("output/markdown-live-prefix-browser")
  mkdirSync(output, { recursive: true })
  const prefix = "```ts\n" + "const value = 1;\n".repeat(300) + "```\n\n"
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import{useState}from'react';import{createRoot}from'react-dom/client';
    import{StreamingMarkdown}from'./src/renderer/src/components/chat/StreamingMarkdown';
    import{stableMarkdownPrefixCache,streamingMarkdownParseMetrics}from'./src/renderer/src/lib/markdown-parse-cache';
    const prefix=${JSON.stringify(prefix)},reference=${JSON.stringify("[reference][ref]\n\n")},
      completeText=${JSON.stringify("[reference][ref]\n\n[ref]: https://example.test/report")};const copies=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>copies.push(text)}});
    function Fixture(){const[text,setText]=useState(prefix+reference+'TAIL_0'),[stream,setStream]=useState(true);
      window.liveMarkdown={append:index=>setText(prefix+reference+'tail '.repeat(index*10)+'TAIL_'+index),
        complete:()=>{setText(prefix+completeText);setStream(false)},
        stats:()=>({prefix:stableMarkdownPrefixCache.stats(),live:streamingMarkdownParseMetrics.stats(),copies})};
      return <StreamingMarkdown isStreaming={stream}>{text}</StreamingMarkdown>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`
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
        name: "controlled-no-workspace-context",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "context",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const useThreadStateSelector=(_id,select)=>select({workspacePath:null,workspaceFiles:[]})"
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
  try {
    await page.setContent("<div id='root'></div>")
    await page.addScriptTag({ content: "window.__name=value=>value" })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByText("TAIL_0", { exact: false }).last().waitFor()
    await page.evaluate(() => {
      const code = document.querySelector(".streaming-markdown-code-pre code")!
      const text = code.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 12)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      Object.assign(window, { liveCodeNode: code, liveCodeText: text })
    })
    const selected = await page.evaluate(() => window.getSelection()!.toString())
    let baselineCharacters = prefix.length + "[reference][ref]\n\nTAIL_0".length
    for (let index = 1; index <= 12; index++) {
      baselineCharacters +=
        prefix.length + "[reference][ref]\n\n".length + index * 50 + `TAIL_${index}`.length
      await page.evaluate(
        (index) => (window as unknown as LiveMarkdownWindow).liveMarkdown.append(index),
        index
      )
      await page.waitForFunction(
        (index) => document.getElementById("root")?.textContent?.endsWith(`TAIL_${index}`),
        index
      )
      assert(
        await page.evaluate(
          () =>
            document.querySelector(".streaming-markdown-code-pre code") ===
            (window as unknown as LiveMarkdownWindow).liveCodeNode
        )
      )
      assert.equal(await page.evaluate(() => window.getSelection()!.toString()), selected)
    }
    const stats = await page.evaluate(() =>
      (window as unknown as LiveMarkdownWindow).liveMarkdown.stats()
    )
    assert.equal(stats.prefix.parses, 1)
    assert(stats.prefix.parsedCharacters + stats.live.parsedCharacters < baselineCharacters / 2)
    assert.equal(await page.locator(".hljs-keyword").count(), 0)
    // A pending trailing throttle must not delay the final text/reference result.
    await page.evaluate(() => (window as unknown as LiveMarkdownWindow).liveMarkdown.complete())
    await page.getByRole("link", { name: "reference", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("link", { name: "reference", exact: true }).getAttribute("href"),
      "https://example.test/report"
    )
    assert((await page.locator(".hljs-keyword").count()) > 0)
    assert(
      await page.evaluate(
        () =>
          document.querySelector(".streaming-markdown-code-pre code") ===
          (window as unknown as LiveMarkdownWindow).liveCodeNode
      )
    )
    await page.getByRole("button", { name: "复制代码", exact: true }).click()
    const completed = await page.evaluate(() =>
      (window as unknown as LiveMarkdownWindow).liveMarkdown.stats()
    )
    assert.deepEqual(completed.copies, ["const value = 1;\n".repeat(300).trimEnd()])
    assert.deepEqual(errors, [])
    const evidence = {
      passed: true,
      baselineCharacters,
      stats,
      completed,
      selected,
      errors,
      scope:
        "Only a leading closed fenced-code prefix; arbitrary Markdown still uses the full-fragment parser"
    }
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence))
  } catch (error) {
    console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }))
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
