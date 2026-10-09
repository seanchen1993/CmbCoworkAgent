/** Extended real-browser coverage for HTML preview resources and interactions. */
import assert from "node:assert/strict"
import { buildSync } from "esbuild"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

function browserModule(name: string): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL(`../src/renderer/src/lib/${name}.ts`, import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022"
  })
  return `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
}
const modules = {
  document: browserModule("design-html-srcdoc"),
  variation: browserModule("design-variation-document"),
  navigation: browserModule("design-preview-navigation"),
  viewport: browserModule("design-preview-viewport")
}
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
try {
  const page = await browser.newPage({ acceptDownloads: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent("<html><body></body></html>")
  const documents = await page.evaluate(async (modules) => {
    const { buildDesignHtmlPreviewDocument } = await import(modules.document)
    const { buildDesignVariationDocument } = await import(modules.variation)
    const { DESIGN_PREVIEW_NAVIGATION_SCRIPT } = await import(modules.navigation)
    const { getDesignPreviewViewport } = await import(modules.viewport)
    const text: Record<string, string> = {
      "/design/css/main.css":
        '@import "nested/colors.css" screen; #background{background-image:url(../images/icon.svg)}',
      "/design/css/nested/colors.css": '@import "../main.css"; #theme{color:rgb(21,43,65)}',
      "/design/css/print.css": "#theme{color:rgb(200,0,0)}",
      "/design/css/disabled.css": "#theme{background-color:rgb(22,44,66)}",
      "/design/js/main.js":
        'import { value } from "./value.js"; import { cycle } from "./cycle.js"; document.getElementById("modules").textContent=value+cycle(); import("./dynamic.js").then(m=>document.getElementById("dynamic").textContent=m.value); fetch("data/info.json").then(r=>r.json()).then(d=>document.getElementById("externalFetch").textContent=d.label);',
      "/design/js/value.js":
        'import { cycle } from "./cycle.js"; export const value="Module "; export function seed(){return "cycle";} export function linked(){return cycle;}',
      "/design/js/cycle.js":
        'import { seed } from "./value.js"; export function cycle(){return seed();}',
      "/design/js/dynamic.js": 'export const value="Dynamic module";'
    }
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')}`
    const data: Record<string, string> = {
      "/design/images/icon.svg": svg,
      "/design/data/info.json": `data:application/json;base64,${btoa(JSON.stringify({ label: "Local JSON" }))}`
    }
    const reads: string[] = []
    const html = `<!DOCTYPE html><html lang="zh-CN"><head>
      <link id="mainStyle" rel="stylesheet" href="css/main.css">
      <link rel="stylesheet" media="print" href="css/print.css">
      <link id="disabledStyle" rel="stylesheet" disabled href="css/disabled.css">
      <script type="module" src="js/main.js"></script>
      </head><body data-theme="dark">
      <div id="variation-a">
        <button id="sharedOpen" onclick="document.getElementById('sharedDialog').showModal()">Shared dialog</button>
        <p id="theme">Theme</p><div id="background">Background</div>
        <p id="modules"></p><p id="dynamic"></p><p id="externalFetch"></p><p id="inlineFetch"></p>
        <img id="responsive" srcset="${svg} 1x, images/icon.svg 2x">
        <details id="details"><summary>Details</summary><p>Expanded</p></details>
        <button id="popoverButton" popovertarget="popover">Popover</button><div id="popover" popover>Menu</div>
        <select id="select"><option value="a">A</option><option value="b">B</option></select>
        <input id="check" type="checkbox"><input id="radio1" type="radio" name="r"><input id="radio2" type="radio" name="r">
        <input id="date" type="date"><input id="range" type="range" min="0" max="10" value="5">
        <input id="file" type="file"><p id="fileName"></p>
        <form id="validated"><input id="email" type="email" required><button id="validSubmit">Submit</button></form><p id="formResult"></p>
        <canvas id="canvas" width="2" height="2"></canvas><svg><rect id="rect" width="20" height="20" fill="red"/></svg>
        <button id="svgUpdate" onclick="document.getElementById('rect').setAttribute('fill','blue')">SVG</button>
        <a id="download" download="preview.csv" href="data:text/csv,a%2Cb%0A1%2C2">Download</a>
        <div id="viewport" style="height:100vh"></div><div style="height:2000px"></div>
        <button id="fixed" style="position:fixed;bottom:10px;right:10px">Fixed</button>
        <a id="encodedAnchor" href="#%E4%B8%AD%E6%96%87">Anchor</a><div id="中文">Target</div>
      </div>
      <div id="variation-b"><button id="otherButton">Other variant</button></div>
      <dialog id="sharedDialog"><p>Shared content</p><button onclick="this.closest('dialog').close()">Close</button></dialog>
      <template id="sharedTemplate"><p>Template</p></template>
      <script>
        document.getElementById('otherButton').addEventListener('click',()=>{});
        document.body.dataset.ready=document.getElementById('sharedTemplate').content.textContent.trim();
        const example="fetch('unchanged.json')";
        window.literalExample=example;
        fetch('data/info.json').then(r=>r.json()).then(d=>document.getElementById('inlineFetch').textContent=d.label);
        document.getElementById('file').addEventListener('change',e=>document.getElementById('fileName').textContent=e.target.files[0].name);
        document.getElementById('validated').addEventListener('submit',()=>document.getElementById('formResult').textContent='Valid');
        const context=document.getElementById('canvas').getContext('2d');context.fillStyle='rgb(123,45,67)';context.fillRect(0,0,2,2);
      </script></body></html>`
    const full = await buildDesignHtmlPreviewDocument({
      html,
      htmlPath: "/design/index.html",
      readTextFile: async (path: string) => {
        reads.push(path)
        return text[path] ?? null
      },
      readDataUrlFile: async (path: string) => {
        reads.push(path)
        return data[path] ?? null
      }
    })
    const doc = new DOMParser().parseFromString(full, "text/html")
    const variation = buildDesignVariationDocument(doc, doc.getElementById("variation-a")!)
    return {
      full,
      variation,
      navigation: DESIGN_PREVIEW_NAVIGATION_SCRIPT,
      reads,
      viewports: [100, 50, 200].map((zoom) => ({
        zoom,
        ...getDesignPreviewViewport(800, 600, zoom)
      }))
    }
  }, modules)
  assert(
    !documents.reads.some((path) => path.endsWith("unchanged.json")),
    "fetch-like strings are untouched"
  )
  assert(documents.reads.includes("/design/css/nested/colors.css"))
  assert(documents.reads.includes("/design/images/icon.svg"))
  for (const html of [documents.full, documents.variation]) {
    await page.evaluate(
      ({ html, navigation }) => {
        document.body.innerHTML = ""
        const iframe = document.createElement("iframe")
        iframe.style.cssText = "width:800px;height:600px;border:0"
        iframe.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-modals allow-forms allow-downloads"
        )
        iframe.addEventListener("load", () => {
          const script = iframe.contentDocument!.createElement("script")
          script.textContent = navigation
          iframe.contentDocument!.head.append(script)
          script.remove()
        })
        iframe.srcdoc = html
        document.body.append(iframe)
      },
      { html, navigation: documents.navigation }
    )
    const frame = page.frameLocator("iframe")
    for (const [id, text] of [
      ["modules", "Module cycle"],
      ["dynamic", "Dynamic module"],
      ["externalFetch", "Local JSON"],
      ["inlineFetch", "Local JSON"]
    ]) {
      await page.waitForFunction(
        ({ id, text }) =>
          document.querySelector("iframe")?.contentDocument?.getElementById(id)?.textContent ===
          text,
        { id, text }
      )
    }
    assert.equal(await frame.locator("body").getAttribute("data-theme"), "dark")
    assert.equal(await frame.locator("body").getAttribute("data-ready"), "Template")
    assert.equal(
      await frame.locator("#theme").evaluate((el) => getComputedStyle(el).color),
      "rgb(21, 43, 65)"
    )
    assert.equal(
      await frame.locator("#theme").evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)"
    )
    await frame
      .locator("#disabledStyle")
      .evaluate((el) => ((el as HTMLLinkElement).disabled = false))
    await page.waitForFunction(
      () =>
        getComputedStyle(
          document.querySelector("iframe")!.contentDocument!.getElementById("theme")!
        ).backgroundColor === "rgb(22, 44, 66)"
    )
    assert.match(
      (await frame.locator("#responsive").getAttribute("srcset"))!,
      /data:image\/svg\+xml[^ ]+ 2x/
    )
    await frame.locator("#sharedOpen").click()
    assert.equal(
      await frame.locator("#sharedDialog").evaluate((el) => (el as HTMLDialogElement).open),
      true
    )
    await frame.locator("#sharedDialog button").click()
    await frame.locator("summary").click()
    assert.equal(
      await frame.locator("#details").evaluate((el) => (el as HTMLDetailsElement).open),
      true
    )
    await frame.locator("#popoverButton").click()
    assert.equal(
      await frame.locator("#popover").evaluate((el) => el.matches(":popover-open")),
      true
    )
    await frame.locator("#popoverButton").click()
    await frame.locator("#select").selectOption("b")
    assert.equal(await frame.locator("#select").inputValue(), "b")
    await frame.locator("#check").check()
    await frame.locator("#radio1").check()
    await frame.locator("#radio2").check()
    assert.equal(await frame.locator("#radio1").isChecked(), false)
    await frame.locator("#date").fill("2026-10-09")
    assert.equal(await frame.locator("#date").inputValue(), "2026-10-09")
    await frame.locator("#range").focus()
    await frame.locator("#range").press("ArrowRight")
    assert.equal(await frame.locator("#range").inputValue(), "6")
    await frame
      .locator("#file")
      .setInputFiles({ name: "preview.txt", mimeType: "text/plain", buffer: Buffer.from("test") })
    assert.equal(await frame.locator("#fileName").textContent(), "preview.txt")
    await frame.locator("#validSubmit").click()
    assert.equal(
      await frame
        .locator("#email")
        .evaluate((el) => (el as HTMLInputElement).validity.valueMissing),
      true
    )
    await frame.locator("#email").fill("preview@example.invalid")
    await frame.locator("#validSubmit").click()
    assert.equal(await frame.locator("#formResult").textContent(), "Valid")
    assert.deepEqual(
      await frame
        .locator("#canvas")
        .evaluate((el) =>
          Array.from((el as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data)
        ),
      [123, 45, 67, 255]
    )
    await frame.locator("#svgUpdate").click()
    assert.equal(await frame.locator("#rect").getAttribute("fill"), "blue")
    const download = page.waitForEvent("download")
    await frame.locator("#download").click()
    assert.equal((await download).suggestedFilename(), "preview.csv")
    for (const viewport of documents.viewports) {
      await page.locator("iframe").evaluate((el, v) => {
        ;(el as HTMLIFrameElement).style.width = `${v.width}px`
        ;(el as HTMLIFrameElement).style.height = `${v.height}px`
      }, viewport)
      assert.equal(
        await frame.locator("#viewport").evaluate((el) => el.getBoundingClientRect().height),
        viewport.height
      )
      const position = await frame.locator("#fixed").evaluate((el) => ({
        bottom: el.getBoundingClientRect().bottom,
        height: window.innerHeight
      }))
      assert.equal(position.height - position.bottom, 10)
    }
    await frame.locator("#encodedAnchor").click()
    assert.equal(
      await frame.locator("body").evaluate(() => decodeURIComponent(location.hash)),
      "#中文"
    )
    console.log(
      `PASS ${html === documents.full ? "full" : "variation"}: shared DOM, nested CSS/media/themes, local JSON, ESM/dynamic imports, responsive images, native controls, file input, canvas/SVG, download, viewport/zoom and anchors`
    )
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
