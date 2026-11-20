import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

const bundle = await build({
  entryPoints: ["src/renderer/src/lib/html-srcdoc.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "PreviewBuilder",
  write: false
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
  headless: true
})
let passed = 0
try {
  const page = await browser.newPage()
  const network = []
  await page.route("https://preview-security.invalid/**", async (route) => {
    network.push(route.request().url())
    await route.abort()
  })
  await page.setContent("<!doctype html><body></body>")
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(() => {
    window.previewStatus = []
    addEventListener("message", (event) => {
      if (event.source === document.querySelector("iframe")?.contentWindow) {
        window.previewStatus.push(event.data)
      }
    })
  })

  async function mount(html, files = {}) {
    const built = await page.evaluate(
      async ({ html, files }) => {
        window.previewStatus = []
        const reads = []
        const result = await window.PreviewBuilder.buildHtmlPreviewDocument({
          html,
          htmlPath: "pages/index.html",
          runtimeId: "browser-preview",
          readTextFile: async (path) => {
            reads.push(path)
            return files[path] ?? null
          }
        })
        document.querySelector("iframe")?.remove()
        const iframe = document.createElement("iframe")
        iframe.setAttribute("sandbox", "allow-scripts")
        iframe.style.cssText = "height:600px;width:1000px"
        const loaded = new Promise((resolve) => {
          iframe.onload = resolve
        })
        iframe.srcdoc = result.srcDoc
        document.body.append(iframe)
        await loaded
        return { ...result, reads }
      },
      { html, files }
    )
    return { ...built, frame: page.frameLocator("iframe") }
  }

  async function check(name, test) {
    await test()
    passed += 1
    console.log(`PASS ${name}`)
  }

  await check(
    "inline JavaScript creates the page and inline onclick remains interactive",
    async () => {
      const { frame } = await mount(String.raw`<body><div id="root"></div><script>
      document.getElementById("root").innerHTML = '<button onclick="this.textContent=\'CLICKED\'">JS_UI</button>'
    </script></body>`)
      await frame.getByRole("button", { name: "JS_UI" }).click()
      assert.equal(await frame.getByRole("button").textContent(), "CLICKED")
    }
  )

  await check("DOMContentLoaded initializes and reveals a hidden page", async () => {
    const { frame } = await mount(`<body style="opacity:0"><div id="root"></div><script>
      addEventListener("DOMContentLoaded", () => {
        document.getElementById("root").textContent = "READY_UI"
        document.body.style.opacity = "1"
      })
    </script></body>`)
    assert.equal(await frame.locator("#root").textContent(), "READY_UI")
    assert.equal(
      await frame.locator("body").evaluate((element) => getComputedStyle(element).opacity),
      "1"
    )
  })

  await check("local scripts keep parser order, Unicode and raw closing-tag strings", async () => {
    const { frame, reads } = await mount(
      `<!doctype html><body><div id="root"></div>
      <script>window.order = ["inline"]</script><script src="assets/app.js"></script>
      <script>document.getElementById("root").textContent = window.order.join("|")</script></body>`,
      {
        "pages/assets/app.js": 'window.order.push("本地脚本</script><p>literal</p>")'
      }
    )
    assert.deepEqual(reads, ["pages/assets/app.js"])
    assert.equal(
      await frame.locator("#root").textContent(),
      "inline|本地脚本</script><p>literal</p>"
    )
    assert.equal(await frame.locator("p").count(), 0)
  })

  await check("deferred scripts still run after the body has been parsed", async () => {
    const { frame } = await mount(
      `<!doctype html><head><script defer src="app.js"></script></head>
      <body><main id="late">BEFORE</main></body>`,
      {
        "pages/app.js": 'document.getElementById("late").textContent = "DEFER_READY"'
      }
    )
    assert.equal(await frame.locator("#late").textContent(), "DEFER_READY")
  })

  await check("inline and external standalone modules render UI", async () => {
    const { frame } = await mount(
      `<body><main id="inline"></main><main id="external"></main>
      <script type="module">document.getElementById("inline").textContent = "INLINE_MODULE"</script>
      <script type="module" src="app.mjs"></script></body>`,
      {
        "pages/app.mjs": 'document.getElementById("external").textContent = "EXTERNAL_MODULE"'
      }
    )
    assert.equal(await frame.locator("#inline").textContent(), "INLINE_MODULE")
    assert.equal(await frame.locator("#external").textContent(), "EXTERNAL_MODULE")
  })

  await check(
    "local CSS retains media and does not allow closing-style markup injection",
    async () => {
      const { frame, srcDoc } = await mount(
        `<head><link rel="stylesheet" href="assets/site.css">
      <link rel="stylesheet" href="print.css" media="print"></head><body><main id="card">CSS_UI</main></body>`,
        {
          "pages/assets/site.css":
            '#card{display:flex;background:rgb(17,34,51)}\n</style><meta http-equiv="refresh" content="0;url=https://preview-security.invalid/escape"><style>',
          "pages/print.css": "#card{display:none}"
        }
      )
      assert.equal(
        await frame.locator("#card").evaluate((element) => getComputedStyle(element).display),
        "flex"
      )
      assert.equal(
        await frame
          .locator("#card")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(17, 34, 51)"
      )
      assert.equal(await frame.locator('meta[http-equiv="refresh"]').count(), 0)
      assert.ok(srcDoc.includes("\\3C /style"))
    }
  )

  await check(
    "missing and forbidden dependencies are reported without reading outside the page tree",
    async () => {
      const { issues, reads, frame } = await mount(`<body><main>VISIBLE_STATIC</main>
      <script src="../private.js"></script><script src="https://preview-security.invalid/cdn.js"></script>
      <script src="missing.js"></script></body>`)
      assert.equal(issues.length, 3)
      assert.deepEqual(reads, ["pages/missing.js"])
      assert.equal(await frame.locator("main").textContent(), "VISIBLE_STATIC")
    }
  )

  await check(
    "JavaScript cannot access the host DOM, application bridge, or persistent origin",
    async () => {
      const { frame } = await mount(`<body><main id="result"></main><script>
      const result = [typeof window.api, typeof window.require]
      try { result.push(parent.document.body ? "PARENT_LEAK" : "empty") } catch { result.push("parent-blocked") }
      try { localStorage.setItem("probe", "1"); result.push("STORAGE_LEAK") } catch { result.push("storage-blocked") }
      document.getElementById("result").textContent = result.join("|")
    </script></body>`)
      assert.equal(
        await frame.locator("#result").textContent(),
        "undefined|undefined|parent-blocked|storage-blocked"
      )
    }
  )

  await check(
    "runtime errors report a bounded status instead of silently leaving an empty page",
    async () => {
      await mount('<body><script>throw new Error("broken initializer")</script></body>')
      await page.waitForFunction(() =>
        window.previewStatus.some((status) => status.kind === "error")
      )
      assert.ok(
        await page.evaluate(() =>
          window.previewStatus.every((status) => !Object.hasOwn(status, "message"))
        )
      )
    }
  )

  await check(
    "external fetch, images, nested frames, form actions and meta refresh stay blocked",
    async () => {
      const { frame } =
        await mount(`<head><meta http-equiv="refresh" content="0;url=https://preview-security.invalid/refresh"></head>
      <body><main>ISOLATED</main><img src="https://preview-security.invalid/image">
      <iframe src="https://preview-security.invalid/frame"></iframe>
      <form action="https://preview-security.invalid/form"></form>
      <script>fetch("https://preview-security.invalid/fetch").catch(() => {})</script></body>`)
      assert.equal(await frame.locator("iframe").count(), 0)
      assert.equal(await frame.locator("form").getAttribute("action"), null)
      assert.equal(await frame.locator('meta[http-equiv="refresh"]').count(), 0)
      assert.deepEqual(network, [])
      await page.waitForFunction(() =>
        window.previewStatus.some((status) => status.kind === "blocked")
      )
      assert.equal(
        await page.evaluate(() => window.previewStatus.some((status) => status.kind === "error")),
        false,
        "a blocked image is a resource issue, not a JavaScript initialization error"
      )
    }
  )
  console.log(`ALL PASS ${passed} HTML browser regressions`)
} finally {
  await browser.close()
}
