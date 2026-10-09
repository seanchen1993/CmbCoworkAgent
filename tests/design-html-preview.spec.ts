/** Real Chromium regression for Design srcdoc interactions.
 * Run: node --experimental-strip-types tests/design-html-preview.spec.ts
 * Set CHROMIUM_EXECUTABLE_PATH to use an installed Chrome instead of Playwright's browser.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { chromium } from "playwright"
import ts from "typescript"
import { buildSync } from "esbuild"
import { fileURLToPath } from "node:url"

function browserModule(relativePath: string): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022"
  })
  return `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
}

const modules = {
  design: browserModule("../src/renderer/src/lib/design-html-srcdoc.ts"),
  static: browserModule("../src/renderer/src/lib/html-srcdoc.ts"),
  navigation: browserModule("../src/renderer/src/lib/design-preview-navigation.ts"),
  variation: browserModule("../src/renderer/src/lib/design-variation-document.ts")
}
const designSource = readFileSync(
  new URL("../src/renderer/src/components/design/DesignView.tsx", import.meta.url),
  "utf8"
)
const designAst = ts.createSourceFile("DesignView.tsx", designSource, ts.ScriptTarget.Latest, true)
function editorScript(name: string): string {
  for (const statement of designAst.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.name.getText() === name &&
        declaration.initializer &&
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer)
      ) {
        return declaration.initializer.text
      }
    }
  }
  throw new Error(`Missing editor script: ${name}`)
}
const editorModes = [
  [editorScript("COMMENT_INJECT"), editorScript("COMMENT_CLEANUP")],
  [editorScript("EDIT_SELECT_INJECT"), editorScript("EDIT_SELECT_CLEANUP")]
]
const fixture = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="assets/page.css">
<script defer src="assets/page.js"></script>
</head><body>
<div id="variation-a">
  <a id="tab" href="/next-tab"><span>Tab 2</span></a><p id="panel">Tab 1</p>
  <button id="modal" onclick="document.getElementById('dialog').showModal()">弹窗</button>
  <dialog id="dialog"><p>Modal content</p><button onclick="this.closest('dialog').close()">关闭</button></dialog>
  <button id="alert" onclick="alert('提示成功')">Alert</button>
  <button id="confirm" onclick="document.getElementById('panel').textContent=String(confirm('确认?'))">Confirm</button>
  <button id="prompt" onclick="document.getElementById('panel').textContent=prompt('输入')">Prompt</button>
  <form action="https://preview.invalid/submit"><button id="submit">提交</button></form>
  <a id="hash" href="#anchor">锚点</a><p id="anchor">Anchor</p>
  <img id="asset" src="assets/icon.svg">
</div>
<div id="variation-b"><p>Second variant</p></div>
<script>
document.addEventListener('click',function(e){
  if(e.target.closest('#tab'))document.getElementById('panel').textContent='Tab 2';
});
document.addEventListener('submit',function(){document.getElementById('panel').textContent='Submitted';});
window.parent.postMessage({type:'fixture-ready'},'*');
</script></body></html>`
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent("<html><body></body></html>")
  const prepared = await page.evaluate(
    async ({ modules, fixture }) => {
      const { buildDesignHtmlPreviewDocument } = await import(modules.design)
      const { buildStaticHtmlPreviewDocument } = await import(modules.static)
      const { buildDesignVariationDocument } = await import(modules.variation)
      const { DESIGN_PREVIEW_NAVIGATION_SCRIPT } = await import(modules.navigation)
      const textReads: string[] = []
      const dataReads: string[] = []
      const text: Record<string, string> = {
        "/design/assets/page.css":
          "#panel { color: rgb(12, 34, 56); background-image:url(icon.svg); }",
        "/design/assets/page.js":
          "document.getElementById('panel').dataset.deferred='加载完成'; window.closingTag='</script>';"
      }
      const data: Record<string, string> = {
        "/design/assets/icon.svg": `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')}`
      }
      const build = (html: string) =>
        buildDesignHtmlPreviewDocument({
          html,
          htmlPath: "/design/index.html",
          readTextFile: async (path: string) => {
            textReads.push(path)
            return text[path] ?? null
          },
          readDataUrlFile: async (path: string) => {
            dataReads.push(path)
            return data[path] ?? null
          }
        })
      const full = await build(fixture)
      const doc = new DOMParser().parseFromString(full, "text/html")
      const variation = buildDesignVariationDocument(doc, doc.getElementById("variation-a")!)
      const noPath = await buildDesignHtmlPreviewDocument({ html: fixture })
      const inlineOnly = await buildDesignHtmlPreviewDocument({
        html: '<button id="inline" onclick="this.textContent=\'Works\'">Inline</button>'
      })
      const safe = await buildStaticHtmlPreviewDocument({ html: fixture })
      const safeDoc = new DOMParser().parseFromString(safe, "text/html")
      const boundaryReads: string[] = []
      await buildDesignHtmlPreviewDocument({
        html: '<script src="../secret.js"></script><script src="%2e%2e/secret.js"></script><link rel="stylesheet" href="/root.css">',
        htmlPath: "/design/index.html",
        readTextFile: async (path: string) => {
          boundaryReads.push(path)
          return ""
        }
      })
      return {
        full,
        variation,
        inlineOnly,
        noPath,
        textReads,
        dataReads,
        boundaryReads,
        safe,
        staticScriptCount: safeDoc.querySelectorAll("script").length,
        staticEventCount: safeDoc.querySelectorAll("[onclick]").length,
        navigation: DESIGN_PREVIEW_NAVIGATION_SCRIPT
      }
    },
    { modules, fixture }
  )
  assert.equal(prepared.noPath, fixture)
  assert.equal(prepared.staticScriptCount, 0)
  assert.equal(prepared.staticEventCount, 0)
  assert.match(prepared.safe, /script-src 'none'/)
  assert.deepEqual(prepared.boundaryReads, [])
  assert.deepEqual(prepared.textReads.sort(), ["/design/assets/page.css", "/design/assets/page.js"])
  assert.deepEqual(prepared.dataReads, ["/design/assets/icon.svg"])

  for (const [name, html] of [
    ["imported/generated", prepared.full],
    ["variation", prepared.variation]
  ] as const) {
    await page.evaluate(
      ({ html, navigation }) => {
        document.body.innerHTML = ""
        const iframe = document.createElement("iframe")
        iframe.title = "Design Preview"
        iframe.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-modals allow-forms allow-downloads"
        )
        iframe.width = "800"
        iframe.height = "600"
        iframe.addEventListener("load", () => {
          const script = iframe.contentDocument!.createElement("script")
          script.textContent = navigation
          iframe.contentDocument!.head.append(script)
          script.remove()
        })
        iframe.srcdoc = html.replace("<head>", '<head><base href="file:///design/index.html">')
        document.body.append(iframe)
      },
      { html, navigation: prepared.navigation }
    )
    const frame = page.frameLocator("iframe")
    await frame.locator('#panel[data-deferred="加载完成"]').waitFor()
    assert.equal(
      await frame.locator("#panel").evaluate((el) => getComputedStyle(el).color),
      "rgb(12, 34, 56)"
    )
    await frame.locator("#tab span").click()
    assert.equal(await frame.locator("#panel").textContent(), "Tab 2")
    for (const [activate, cleanup] of editorModes) {
      await frame.locator("body").evaluate((el, script) => {
        const injected = el.ownerDocument.createElement("script")
        injected.textContent = script
        el.ownerDocument.head.append(injected)
        injected.remove()
      }, activate)
      await frame.locator("#panel").evaluate((el) => {
        el.textContent = "Editing"
      })
      await frame.locator("#tab").click()
      assert.equal(await frame.locator("#panel").textContent(), "Editing")
      await frame.locator("body").evaluate((el, script) => {
        const injected = el.ownerDocument.createElement("script")
        injected.textContent = script
        el.ownerDocument.head.append(injected)
        injected.remove()
      }, cleanup)
      await frame.locator("#tab").click()
      assert.equal(await frame.locator("#panel").textContent(), "Tab 2")
    }
    // Edit-mode listeners must be removed on exit; otherwise repeated mode
    // switches send duplicate HTML saves even while the user is previewing.
    await page.evaluate(() => {
      const host = window as Window & { previewEditHtmlCount?: number }
      host.previewEditHtmlCount = 0
      window.addEventListener("message", (event) => {
        if (event.data?.type === "__edit_html") host.previewEditHtmlCount! += 1
      })
      document.querySelector("iframe")!.contentWindow!.postMessage({ type: "__edit_get_html" }, "*")
    })
    await frame.locator("body").evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
    assert.equal(
      await page.evaluate(
        () => (window as Window & { previewEditHtmlCount?: number }).previewEditHtmlCount
      ),
      0
    )
    await frame.locator("#modal").click()
    assert.equal(
      await frame.locator("#dialog").evaluate((el) => (el as HTMLDialogElement).open),
      true
    )
    await frame.locator("#dialog button").click()
    assert.equal(
      await frame.locator("#dialog").evaluate((el) => (el as HTMLDialogElement).open),
      false
    )
    for (const [id, type, answer] of [
      ["alert", "alert", ""],
      ["confirm", "confirm", ""],
      ["prompt", "prompt", "输入成功"]
    ] as const) {
      const dialog = page.waitForEvent("dialog")
      const click = frame.locator(`#${id}`).click()
      const shown = await dialog
      assert.equal(shown.type(), type)
      await shown.accept(answer)
      await click
    }
    assert.equal(await frame.locator("#panel").textContent(), "输入成功")
    await frame.locator("#submit").click()
    assert.equal(await frame.locator("#panel").textContent(), "Submitted")
    await frame.locator("#hash").click()
    assert.equal(await frame.locator("#panel").textContent(), "Submitted")
    console.log(
      `PASS ${name}: deferred JS, delegated Tab, modal, alert/confirm/prompt, form and hash navigation`
    )
  }
  await page.evaluate((html) => {
    const iframe = document.querySelector("iframe")!
    iframe.srcdoc = html
  }, prepared.inlineOnly)
  const inline = page.frameLocator("iframe").locator("#inline")
  await inline.click()
  assert.equal(await inline.textContent(), "Works")
  assert.deepEqual(errors, [])
  console.log(
    "PASS asset inlining, read boundaries, script closing tags and static-preview isolation"
  )
} finally {
  await browser.close()
}
