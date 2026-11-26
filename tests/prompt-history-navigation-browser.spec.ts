import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

// Exercise the actual hook, textarea and IndexedDB with controlled admission order.
const fixture = `
  import React, { useState } from "react"
  import { createRoot } from "react-dom/client"
  import { usePromptHistory } from "@/components/chat/usePromptHistory"
  import { preparePromptHistory } from "@/lib/prompt-history"

  window.submit = text => preparePromptHistory("project", text)
  function Composer() {
    const [draft, setDraft] = useState({ text: "", cursor: undefined })
    const update = (text, cursor) => setDraft({ text, cursor })
    const history = usePromptHistory("project", "chat", draft.text, draft.cursor, update)
    return <textarea value={draft.text} onChange={e => update(e.target.value)}
      onKeyDown={e => history.navigate(e.nativeEvent)} />
  }
  createRoot(document.getElementById("root")).render(<Composer />)
`

type Ticket = NonNullable<ReturnType<typeof import("../src/renderer/src/lib/prompt-history").preparePromptHistory>>
declare global {
  interface Window {
    submit: (text: string) => Ticket
    middle: Ticket
    duplicate: Ticket
  }
}

async function main() {
  const { outputFiles } = await build({
    stdin: { contents: fixture, loader: "jsx", resolveDir: process.cwd() },
    bundle: true, write: false, alias: { "@": resolve("src/renderer/src") }
  })
  const browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  try {
    for (const scenario of ["merged", "merged with later entries", "rejected independent duplicate",
      "adjacent at capacity", "separated at capacity", "collapsed separator"]) {
      const page = await browser.newPage()
      await page.route("http://history.test/", route => route.fulfill({
        contentType: "text/html", body: '<div id="root"></div>'
      }))
      await page.goto("http://history.test/")
      await page.addScriptTag({ content: outputFiles[0].text })
      const input = page.locator("textarea")
      await input.waitFor()
      // Read after the queued writes finish, so the next key sees settled history.
      const flush = () => page.evaluate(() => new Promise<void>((done, fail) => {
        const open = indexedDB.open("cmbcowork-prompt-history")
        open.onerror = () => fail(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction("workspaces")
          tx.objectStore("workspaces").get("project")
          tx.oncomplete = () => { db.close(); done() }
        }
      }))
      if (scenario === "collapsed separator") {
        await page.evaluate(() => {
          window.submit("B").accept()
          window.duplicate = window.submit("A")
          window.duplicate.preview()
        })
        await flush()
        await input.press("ArrowUp")
        assert.equal(await input.inputValue(), "A")
        await page.evaluate(() => { window.submit("B").accept(); window.submit("A").accept() })
        await flush()
        await page.evaluate(() => window.duplicate.discard())
        await flush()
        assert.equal(await input.inputValue(), "")
        await input.press("ArrowUp")
        assert.equal(await input.inputValue(), "A")
        await input.press("ArrowUp")
        assert.equal(await input.inputValue(), "B")
        await page.close()
        continue
      }
      if (scenario.endsWith("at capacity")) {
        await page.evaluate(() => { window.duplicate = window.submit("A"); window.duplicate.preview() })
        await input.press("ArrowUp")
        assert.equal(await input.inputValue(), "A")
        const separated = scenario === "separated at capacity"
        await page.evaluate(separated => {
          if (separated) window.submit("B").accept()
          window.submit("A").accept()
          for (let i = 1; i < 30; i++) window.submit("C" + i).accept()
        }, separated)
        await flush()
        await page.evaluate(() => window.duplicate.discard())
        await flush()
        assert.equal(await input.inputValue(), separated ? "" : "A")
        await input.press(separated ? "ArrowUp" : "ArrowDown")
        assert.equal(await input.inputValue(), separated ? "C29" : "C1")
        await page.close()
        continue
      }
      await page.evaluate(() => { window.submit("O").accept(); window.submit("A").accept() })
      await flush()
      await page.evaluate(() => {
        window.middle = window.submit("B")
        window.duplicate = window.submit("A")
        window.middle.preview()
        window.duplicate.preview()
      })
      await input.press("ArrowUp")
      assert.equal(await input.inputValue(), "A")
      // Reach A via B so this is the new preview, even though both A rows have identical text.
      await input.press("ArrowUp")
      assert.equal(await input.inputValue(), "B")
      await input.press("ArrowDown")
      assert.equal(await input.inputValue(), "A")
      if (scenario === "rejected independent duplicate") {
        await page.evaluate(() => { window.middle.accept(); window.duplicate.discard() })
        await flush()
        assert.equal(await input.inputValue(), "")
        await input.press("ArrowUp")
        assert.equal(await input.inputValue(), "B")
        await page.close()
        continue
      }
      await page.evaluate(() => { window.middle.discard(); window.duplicate.accept() })
      await flush()
      const laterEntries = scenario === "merged with later entries"
      if (laterEntries) {
        await page.evaluate(() => { window.submit("C").accept(); window.submit("A").accept() })
        await flush()
      }
      await input.press("ArrowDown")
      assert.equal(await input.inputValue(), laterEntries ? "C" : "")
      await input.press("ArrowUp")
      assert.equal(await input.inputValue(), "A")
      await input.press("ArrowUp")
      assert.equal(await input.inputValue(), "O")
      await page.close()
    }
    console.log("Passed navigation for merged and independently rejected duplicates.")
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
