import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"
import { buildSync } from "esbuild"
import { chromium } from "playwright"
import { DesignSystemLibrary } from "../src/main/services/design/system-library"
import { DesignTemplatePackages } from "../src/main/services/design/template-packages"
import { designSystemKey } from "../src/shared/design-template"
import { resolveTemplateAssociation } from "../src/main/services/design/template-association"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "template-association-ui-"))
const systemsLibrary = new DesignSystemLibrary(path.join(temporary, "systems"))
const a = systemsLibrary.save({ name: "设计系统 A", content: "# A" })
const a2 = systemsLibrary.save({ name: "设计系统 A 新版", content: "# A2", baseId: a.id })
const b = systemsLibrary.save({ name: "设计系统 B", content: "# B" })
const emptySystem = systemsLibrary.save({ name: "暂无模板的系统", content: "# Empty" })
const systems = systemsLibrary.list()
const aKey = designSystemKey(a)!,
  bKey = designSystemKey(b)!
const source = path.join(temporary, "index.html")
fs.writeFileSync(source, "<!doctype html><html><body>Template</body></html>")
const packages = new DesignTemplatePackages(path.join(temporary, "packages"))
const publicTemplate = packages.importSource(source)
const aTemplate = packages.importSource(source, aKey)
const bTemplate = packages.importSource(source, bKey)
const catalog = [
  ...Array.from({ length: 5 }, (_, i) => ({
    name: `公共卡片 ${i + 1}`,
    path: `/templates/public-${i}/SKILL.md`,
    designSystemKey: null
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    name: i === 0 ? "A 专属卡片" : `A 专属卡片 ${i + 1}`,
    path: `/templates/a-${i}/SKILL.md`,
    designSystemKey: aKey
  })),
  { name: "B 专属卡片", path: "/templates/b/SKILL.md", designSystemKey: bKey }
].map((t) => ({
  ...t,
  description: "页面结构",
  mode: "prototype",
  platform: null,
  scenario: "design",
  previewHtml: "<p>Preview</p>",
  previewPath: ""
}))
const bundle = buildSync({
  entryPoints: [
    fileURLToPath(new URL("./support/design-template-association-fixture.tsx", import.meta.url))
  ],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  tsconfig: "tsconfig.web.json",
  define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" }
}).outputFiles[0].contents
const server = http.createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("content-type", "text/javascript")
    response.end(bundle)
  } else
    response.end(
      '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    )
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const executablePath =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined)
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  let pendingImport: (() => void) | null = null
  let delayImport = false,
    failUpdate = false
  await page.exposeFunction("fixtureList", () => packages.list())
  await page.exposeFunction("fixtureRead", (reference) => ({ template: packages.read(reference) }))
  await page.exposeFunction("fixtureImport", async (_source: string, key: string | null) => {
    if (delayImport)
      await new Promise<void>((resolve) => {
        pendingImport = resolve
      })
    return { template: packages.importSource(source, resolveTemplateAssociation(key, systems)) }
  })
  await page.exposeFunction("fixtureUpdate", (reference, key: string | null) =>
    failUpdate
      ? { error: "模拟关联更新失败" }
      : {
          template: packages.updateAssociation(reference, resolveTemplateAssociation(key, systems))
        }
  )
  await page.addInitScript("window.__name = (target) => target")
  await page.addInitScript(
    ({ systems, catalog }) => {
      const w = window as any
      w.fixtureSystems = systems
      w.api = {
        design: {
          listTemplates: async () => catalog,
          listImportedTemplates: () => w.fixtureList(),
          readTemplate: (r) => w.fixtureRead(r),
          importTemplate: (s, k) => w.fixtureImport(s, k),
          updateTemplateAssociation: (r, k) => w.fixtureUpdate(r, k)
        }
      }
    },
    { systems, catalog }
  )
  const address = server.address() as { port: number }
  await page.goto(`http://127.0.0.1:${address.port}`)
  const current = page.getByLabel("测试当前设计系统")
  const association = page.getByLabel("关联设计系统")
  const selection = () =>
    page
      .getByTestId("selection")
      .textContent()
      .then((s) => JSON.parse(s!))
  await page.getByRole("button", { name: /^公共卡片 1/ }).waitFor()
  const scopeSwitch = page.getByRole("group", { name: "模板归属" })
  const exclusiveScope = scopeSwitch.getByRole("button", { name: "专属模板", exact: true })
  const publicScope = scopeSwitch.getByRole("button", { name: "公共模板", exact: true })
  assert.deepEqual(await scopeSwitch.getByRole("button").allTextContents(), [
    "专属模板",
    "公共模板"
  ])
  assert.equal(await publicScope.getAttribute("aria-pressed"), "true")
  assert.equal(await page.getByRole("combobox", { name: "需求列表系统筛选" }).count(), 0)
  assert.equal(await page.getByRole("button", { name: /专属卡片/ }).count(), 0)
  await exclusiveScope.click()
  await page.getByText("请先选择设计系统，查看其专属模板。", { exact: true }).waitFor()
  assert(await page.getByRole("button", { name: "开始设计", exact: true }).isDisabled())
  await current.selectOption(emptySystem.id)
  await page.getByText("当前设计系统暂无专属模板，可切换到公共模板。", { exact: true }).waitFor()
  assert.equal(await publicScope.isEnabled(), true)
  await current.selectOption(a.id)
  assert.equal(await exclusiveScope.getAttribute("aria-pressed"), "true")
  assert.equal(await page.getByRole("button", { name: /^公共卡片/ }).count(), 0)
  await page.getByRole("button", { name: "下一页模板" }).click()
  await page.getByRole("button", { name: /^A 专属卡片 5/ }).click()
  await publicScope.click()
  await page.getByText("第 1 / 2 页", { exact: true }).waitFor()
  assert.equal((await selection()).name, null)
  assert.equal(await page.getByRole("button", { name: /专属卡片/ }).count(), 0)
  await page.getByRole("button", { name: "下一页模板" }).click()
  await page.getByRole("button", { name: /^公共卡片 5/ }).waitFor()
  await exclusiveScope.click()
  await page.getByText("第 1 / 2 页", { exact: true }).waitFor()
  assert.equal((await selection()).name, null)
  await page.getByRole("button", { name: "选择A 专属卡片模板预览", exact: true }).click()
  await current.selectOption(a2.id)
  assert.equal((await selection()).name, "A 专属卡片")
  await current.selectOption(b.id)
  await page.getByRole("status").filter({ hasText: "已取消" }).waitFor()
  assert.equal((await selection()).name, null)
  assert(await page.getByRole("button", { name: "开始设计", exact: true }).isDisabled())
  assert.equal(await page.getByRole("button", { name: /A 专属卡片/ }).count(), 0)
  await publicScope.click()
  await page.getByRole("button", { name: /^公共卡片 1/ }).click()
  await current.selectOption(a2.id)
  assert.equal((await selection()).name, "公共卡片 1")
  await page.getByRole("button", { name: "上传模板", exact: true }).click()
  assert.equal(await association.inputValue(), aKey)
  // The list-level requirement filter must not become a second source for template context.
  await page.getByRole("button", { name: "需求特性", exact: true }).click()
  const requirementFilter = page.getByRole("combobox", { name: "需求列表系统筛选" })
  await requirementFilter.click()
  await page.getByRole("option", { name: "设计系统 B", exact: true }).click()
  await page.getByRole("button", { name: "原型设计", exact: true }).click()
  assert.equal(await requirementFilter.count(), 0)
  assert.equal(await current.inputValue(), a2.id)
  assert.equal(await association.inputValue(), aKey)
  const imported = page.getByLabel("已导入模板")
  assert.deepEqual(
    (
      await imported
        .locator("option")
        .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
    ).sort(),
    [publicTemplate.id, aTemplate.id].sort()
  )
  await imported.selectOption(publicTemplate.id)
  await page.waitForFunction(
    (id) =>
      JSON.parse(document.querySelector('[data-testid="selection"]')!.textContent!).package?.id ===
      id,
    publicTemplate.id
  )
  assert.equal(await association.inputValue(), "")
  await current.selectOption(b.id)
  assert.equal((await selection()).package.id, publicTemplate.id)
  await imported.selectOption(bTemplate.id)
  failUpdate = true
  await association.selectOption(aKey)
  await page.getByText("模拟关联更新失败", { exact: true }).waitFor()
  assert.equal(await association.inputValue(), bKey)
  assert.equal(packages.read(bTemplate).designSystemKey, bKey)
  failUpdate = false
  await association.selectOption(aKey)
  await page.getByRole("status").filter({ hasText: "切换设计系统后可选用" }).waitFor()
  assert.equal((await selection()).package, undefined)
  assert.equal(await imported.locator(`option[value="${bTemplate.id}"]`).count(), 0)
  await current.selectOption(a2.id)
  await imported.locator(`option[value="${bTemplate.id}"]`).waitFor({ state: "attached" })
  delayImport = true
  await page.getByRole("button", { name: "选择 HTML / ZIP", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector<HTMLSelectElement>('[aria-label="关联设计系统"]')?.disabled
  )
  await current.selectOption(b.id)
  assert(pendingImport)
  pendingImport!()
  await page.getByRole("status").filter({ hasText: "切换设计系统后可选用" }).waitFor()
  assert.equal((await selection()).package, undefined)
  assert.equal(await association.inputValue(), bKey)
  delayImport = false
  await association.selectOption("")
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click()
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('[data-testid="selection"]')!.textContent!).package
  )
  const newPublic = (await selection()).package.id
  assert.equal(packages.read({ id: newPublic, entryPath: "index.html" }).designSystemKey, null)
  await page.reload()
  await page.getByRole("button", { name: "上传模板", exact: true }).click()
  await page
    .getByLabel("已导入模板")
    .locator(`option[value="${newPublic}"]`)
    .waitFor({ state: "attached" })
  await page.getByRole("button", { name: "不选模板", exact: true }).click()
  assert(await page.getByRole("button", { name: "开始设计", exact: true }).isEnabled())
  assert.deepEqual(errors, [])
  console.log(
    "PASS real selector: exclusive/public scope switching and independent pagination; requirement navigation filter stays out of design and cannot change template context; revision identity, selection cleanup, association persistence/rollback, delayed import, folder upload, and reload."
  )
} finally {
  await browser.close()
  server.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
