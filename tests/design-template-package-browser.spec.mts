/** Real browser coverage: npm run test:design-templates.
 * Set DESIGN_TEMPLATE_FIXTURE to exercise a browser-ready React/Ant Design ZIP.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import { chromium } from "playwright"
import { buildSync } from "esbuild"
import { DesignTemplatePackages } from "../src/main/services/design/template-packages"
import { DesignTemplatePreview } from "../src/main/services/design/template-preview"
import { createDesignArtifactZip } from "../src/main/services/design/artifact-package"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "design-template-browser-"))
const preview = new DesignTemplatePreview()
console.log("Starting template browser verification")
const executablePath =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined)
const browser = await chromium.launch({ headless: true, executablePath })
console.log("Browser started")
try {
  let source = process.env.DESIGN_TEMPLATE_FIXTURE
  if (!source) {
    source = path.join(temporary, "fixture.zip")
    const zip = new AdmZip()
    zip.addFile(
      "pages/list.html",
      Buffer.from(
        '<!doctype html><html><head><link rel="stylesheet" href="../assets/style.css"></head><body><p id="status">loading</p><button id="increment">增加</button><script src="../assets/app.js"></script></body></html>'
      )
    )
    zip.addFile("assets/style.css", Buffer.from("#status{color:rgb(1, 2, 3)}"))
    zip.addFile(
      "assets/app.js",
      Buffer.from(
        'let count=0;document.getElementById("status").textContent="ready";document.getElementById("increment").onclick=()=>document.getElementById("status").textContent=String(++count)'
      )
    )
    zip.writeZip(source)
  }
  const packages = new DesignTemplatePackages(path.join(temporary, "library"))
  const template = packages.importSource(source)
  console.log(`Imported ${template.entryPath}: ${template.framework}`)
  assert.equal(template.warnings.length, 0)
  const url = await preview.url(template)
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent(
    `<iframe title="模板预览" sandbox="allow-scripts allow-forms allow-modals" style="width:1400px;height:950px" src="${url}"></iframe>`
  )
  const frame = page.frameLocator("iframe")
  if (process.env.DESIGN_TEMPLATE_FIXTURE) {
    await frame.locator(".ant-table-row").first().waitFor()
    assert.equal(await frame.locator(".ant-table-row").count(), 8)
    await frame.getByPlaceholder("请输入姓名").fill("张三")
    await page.waitForTimeout(100)
    assert.equal(await frame.locator(".ant-table-row").count(), 1)
    await frame.getByRole("button", { name: /重\s*置/ }).click()
    await frame.locator(".ant-table-row").nth(7).waitFor()
    await frame.locator(".ant-select-selector").first().click()
    await frame.locator('.ant-select-item-option[title="停用"]').click()
    await page.waitForTimeout(100)
    assert.equal(await frame.locator(".ant-table-row").count(), 2)
    await frame.getByRole("button", { name: /重\s*置/ }).click()
    await frame.locator(".ant-table-row").nth(7).waitFor()
    await frame.getByPlaceholder(/开始日期|Start date/).click()
    await frame.locator(".ant-picker-panel-container").waitFor()
    await page.keyboard.press("Escape")
    await frame.getByRole("button", { name: "新增用户", exact: true }).click()
    await frame.locator(".ant-message-notice").filter({ hasText: "新增用户" }).waitFor()
  } else {
    await frame.locator("#status").filter({ hasText: "ready" }).waitFor()
    await frame.locator("#increment").click()
    assert.equal(await frame.locator("#status").textContent(), "1")
  }
  const child = page.frames().find((item) => item.url() === url)!
  assert.deepEqual(
    await child.evaluate(() => [
      typeof (window as any).api,
      typeof (window as any).require,
      typeof (window as any).process
    ]),
    ["undefined", "undefined", "undefined"]
  )
  assert.deepEqual(errors, [])
  console.log(
    `PASS isolated template preview: ${template.framework}, ${template.files.length} files, ${template.entryPath}`
  )

  // Exercise the actual renderer document builder against session-owned dependencies.
  const artifactDir = path.join(temporary, "artifact")
  const prepared = packages.materialize(template, artifactDir)
  const generated = template.html
    .replace(/((?:src|href)=["'])\.\//g, `$1${prepared.resourcePrefix}`)
    .replace(/((?:src|href)=["'])\.\.\//g, `$1${prepared.resourcePrefix}../`)
  const artifactPath = path.join(artifactDir, "index.html")
  fs.writeFileSync(artifactPath, generated)
  const module = buildSync({
    entryPoints: [
      fileURLToPath(new URL("../src/renderer/src/lib/design-html-srcdoc.ts", import.meta.url))
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022"
  })
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(module.outputFiles[0].contents).toString("base64")}`
  await page.exposeFunction("readTemplateTestFile", (file: string) => {
    assert.ok(path.resolve(file).startsWith(`${artifactDir}${path.sep}`))
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
  })
  const inlined = await page.evaluate(
    async ({ generated, artifactPath, moduleUrl }) => {
      const { buildDesignHtmlPreviewDocument } = await import(moduleUrl)
      return buildDesignHtmlPreviewDocument({
        html: generated,
        htmlPath: artifactPath,
        readTextFile: (window as any).readTemplateTestFile
      })
    },
    { generated, artifactPath, moduleUrl }
  )
  await page.setContent(
    '<iframe sandbox="allow-scripts" style="width:1400px;height:950px"></iframe>'
  )
  await page.locator("iframe").evaluate((iframe: HTMLIFrameElement, html) => {
    iframe.srcdoc = html
  }, inlined)
  if (process.env.DESIGN_TEMPLATE_FIXTURE)
    await page.frameLocator("iframe").locator(".ant-table-row").nth(7).waitFor()
  else await page.frameLocator("iframe").locator("#status").filter({ hasText: "ready" }).waitFor()
  assert.deepEqual(errors, [])
  console.log("PASS generated artifact preview with local template dependencies")

  const exported = new AdmZip(createDesignArtifactZip(artifactDir, artifactPath))
  const exportedDir = path.join(temporary, "exported")
  exported.extractAllTo(exportedDir)
  for (const relative of template.files)
    assert.ok(fs.existsSync(path.join(exportedDir, "template", template.id, relative)))
  await page.goto(pathToFileURL(path.join(exportedDir, "index.html")).href)
  if (process.env.DESIGN_TEMPLATE_FIXTURE) await page.locator(".ant-table-row").nth(7).waitFor()
  else await page.locator("#status").filter({ hasText: "ready" }).waitFor()
  assert.deepEqual(errors, [])
  const screenshot = process.env.DESIGN_TEMPLATE_SCREENSHOT
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true })
  console.log("PASS exported ZIP opens independently with all template resources")
} finally {
  await browser.close()
  preview.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
