import { MARKETPLACE_API_PATH } from "../src/shared/marketplace-api"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import { buildSync } from "esbuild"
import { chromium } from "playwright"
import type { DesignMarketActor } from "../src/shared/design-market"
import { createDesignMarketHttpServer, DesignMarketHttpClient } from "../src/main/services/design/market-http"
import { DesignMarketLocalStore } from "../src/main/services/design/market-local-store"
import { DesignMarketService } from "../src/main/services/design/market-service"
import { buildFallbackTemplateCoverSvg } from "../src/main/services/design/market-validation"
import { DesignSystemLibrary } from "../src/main/services/design/system-library"
import { DesignTemplatePackages } from "../src/main/services/design/template-packages"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "design-market-ui-"))
const serverDir = path.join(temporary, "market-server")
const localDir = path.join(temporary, "market-local")
const userSystemsDir = path.join(temporary, "user-systems")
const localPackagesDir = path.join(temporary, "local-packages")

const service = new DesignMarketService(serverDir, { seedDemo: false })
const localStore = new DesignMarketLocalStore(localDir)
const userLibrary = new DesignSystemLibrary(userSystemsDir)
const templatePackages = new DesignTemplatePackages(localPackagesDir)

const actors: Record<string, DesignMarketActor> = {
  linan: { userId: "100001", userName: "林安" },
  chenlu: { userId: "654321", userName: "陈璐" }
}
let currentActor: DesignMarketActor = actors.linan

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [k, v] of Object.entries(files)) {
    zip.addFile(k, Buffer.from(v, "utf8"))
  }
  return zip.toBuffer()
}

// Seed initial catalog: 企业工作台 (v1.2.0 & v2.0.0) by 林安; 批量导入 by 林安; 筛选表格 (min v1.2.0) by 陈璐
const sysDraft = service.createSystemDraft(
  {
    name: "企业工作台",
    description: "面向企业后台的表单与列表规范",
    category: "企业应用",
    markdown: "# 企业工作台\n\n```css\n:root{--accent:#3B6BE0;--primary:#7E9EF0;--surface:#DAE5FA;--fg:#182B59}\n```",
    version: "1.2.0",
    changelog: "基础规范 v1.2.0"
  },
  actors.linan
)
const sysPub120 = service.publishSystem(
  { systemId: sysDraft.system.systemId, expectedRevision: sysDraft.draft!.revision },
  actors.linan
)
const sysId = sysPub120.system.systemId

const sysDraft200 = service.saveSystemDraft(
  {
    systemId: sysId,
    expectedRevision: sysPub120.draft!.revision,
    name: "企业工作台",
    description: "面向企业后台的表单与列表规范",
    category: "企业应用",
    markdown: "# 企业工作台 v2\n\n升级主版本规范",
    palette: sysPub120.system.palette,
    version: "2.0.0",
    changelog: "大版本不兼容更新"
  },
  actors.linan
)
const sysPub200 = service.publishSystem(
  { systemId: sysId, expectedRevision: sysDraft200.draft!.revision },
  actors.linan
)
const sysV200Id = sysPub200.versions.find((v) => v.version === "2.0.0")!.versionId

const filterTableZip = makeZip({
  "filter-table.html":
    '<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><h1>筛选表格</h1></body></html>',
  "detail.html":
    '<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><h1>详情页</h1></body></html>',
  "app.css": "body{font-family:sans-serif}"
})
const stagedFilter = service.stageTemplateBlob(filterTableZip, actors.chenlu, "filter-table.html")
const filterDraft = service.createTemplateDraft(
  {
    systemId: sysId,
    name: "筛选表格",
    description: "适用于组合筛选、分页和批量操作的后台列表",
    scenario: "列表",
    minSystemVersion: "1.2.0",
    defaultEntryPath: "filter-table.html",
    pages: stagedFilter.pages,
    filesCount: stagedFilter.filesCount,
    totalBytes: stagedFilter.totalBytes,
    framework: stagedFilter.framework,
    stagedBlobSha256: stagedFilter.sha256,
    coverDataUrl: buildFallbackTemplateCoverSvg("筛选表格", "HTML", "filter-table.html"),
    version: "1.1.0",
    changelog: "支持多入口列表和详情"
  },
  actors.chenlu
)
const filterPub = service.publishTemplate(
  { templateId: filterDraft.template.templateId, expectedRevision: filterDraft.draft!.revision },
  actors.chenlu
)

const batchZip = makeZip({
  "batch.html": "<!doctype html><html><body><h1>批量导入</h1></body></html>"
})
const stagedBatch = service.stageTemplateBlob(batchZip, actors.linan, "batch.html")
const batchDraft = service.createTemplateDraft(
  {
    systemId: sysId,
    name: "批量导入",
    description: "文件导入向导",
    scenario: "流程",
    minSystemVersion: "1.2.0",
    defaultEntryPath: "batch.html",
    pages: stagedBatch.pages,
    filesCount: stagedBatch.filesCount,
    totalBytes: stagedBatch.totalBytes,
    framework: stagedBatch.framework,
    stagedBlobSha256: stagedBatch.sha256,
    coverDataUrl: buildFallbackTemplateCoverSvg("批量导入", "HTML", "batch.html"),
    version: "1.0.0"
  },
  actors.linan
)
service.publishTemplate(
  { templateId: batchDraft.template.templateId, expectedRevision: batchDraft.draft!.revision },
  actors.linan
)

// Start real market HTTP server
const marketCredentials = new Map([
  ["test-session-linan", actors.linan],
  ["test-session-chenlu", actors.chenlu]
])
const marketServer = createDesignMarketHttpServer(service, (credential) =>
  marketCredentials.get(credential) ?? null
)
await new Promise<void>((resolve) => marketServer.listen(0, "127.0.0.1", resolve))
const marketUrl = `http://127.0.0.1:${(marketServer.address() as AddressInfo).port}`
const transport = new DesignMarketHttpClient(marketUrl, (actor) =>
  [...marketCredentials].find(([, candidate]) => candidate.userId === actor.userId)?.[0] ?? null
)

// Bundle React UI fixture
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL("./support/design-market-fixture.tsx", import.meta.url))],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  tsconfig: "tsconfig.web.json",
  define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" }
}).outputFiles[0].contents

const cssRoot = path.resolve("out/renderer/assets")
const css = fs.existsSync(cssRoot)
  ? fs
      .readdirSync(cssRoot)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(cssRoot, name), "utf8"))
      .join("\n")
  : ""

const uiServer = http.createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("content-type", "text/javascript")
    response.end(bundle)
  } else if (request.url === "/style.css") {
    response.setHeader("content-type", "text/css")
    response.end(css)
  } else {
    response.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
    )
  }
})
await new Promise<void>((resolve) => uiServer.listen(0, "127.0.0.1", resolve))

const executablePath =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined)
const browser = await chromium.launch({ headless: true, executablePath })

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 960 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (err) => {
    errors.push(err.message)
    console.error("Renderer error:", err.message)
  })

  await page.exposeFunction("fixtureSetActor", (id: string) => {
    currentActor = actors[id] || actors.linan
  })
  await page.exposeFunction("dmGetActor", () => currentActor)
  await page.exposeFunction("dmListCatalog", (query: unknown) =>
    transport.listCatalog((query as any) || {}, currentActor)
  )
  await page.exposeFunction("dmGetSystemDetail", async (id: string) => {
    try {
      return { success: true, data: await transport.getSystemDetail(id, currentActor) }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  await page.exposeFunction("dmGetTemplateDetail", async (id: string) => {
    try {
      return { success: true, data: await transport.getTemplateDetail(id, currentActor) }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  await page.exposeFunction("dmListDownloaded", () => localStore.getLocalState())
  await page.exposeFunction("dmPlanDownload", async (kind: "system" | "template", assetId: string, versionId?: string, selectedLocalSystemId?: string | null) => {
    try {
      return {
        success: true,
        data: await localStore.planDownload(transport, currentActor, kind, assetId, versionId, selectedLocalSystemId)
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  await page.exposeFunction("dmDownloadSystem", (systemId: string, versionId?: string) =>
    localStore.downloadSystemVersion({ transport, actor: currentActor, systemId, versionId })
  )
  await page.exposeFunction("dmDownloadTemplate", (templateId: string, versionId?: string, selectedLocalSystemId?: string | null) =>
    localStore.downloadTemplateVersion({ transport, actor: currentActor, templateId, versionId, selectedLocalSystemId })
  )
  await page.exposeFunction("dmSetTemplateVisibility", async (templateId: string, visibility: "visible" | "hidden_by_system_owner", reason?: string) => {
    try {
      return {
        success: true,
        data: await transport.setTemplateVisibilityBySystemOwner(templateId, visibility, reason, currentActor)
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  await page.exposeFunction("dmCountAffected", (localSystemId: string) =>
    localStore.countAffectedTemplatesForSystemRemoval(localSystemId)
  )
  await page.exposeFunction("dmRemoveSystem", (localSystemId: string) =>
    localStore.removeSystemFromPicker(localSystemId)
  )
  await page.exposeFunction("dmRestoreSystem", (localSystemId: string) =>
    localStore.restoreSystemToPicker(localSystemId)
  )
  await page.exposeFunction("dmListSystems", () => [
    ...userLibrary.list(),
    ...localStore.listAllSystemInfos()
  ])
  await page.exposeFunction("dmReadSystem", (id: string) => {
    const sys = localStore.listAllSystemInfos().find((s) => s.id === id)
    if (sys) {
      return { success: true, system: sys, content: fs.readFileSync(sys.path, "utf8") }
    }
    const local = userLibrary.read(id)
    return { success: true, system: local.info, content: local.content }
  })
  await page.exposeFunction("dmListTemplates", () =>
    localStore.listSelectableTemplateInfos(templatePackages)
  )
  await page.exposeFunction("dmListImportedTemplates", () => templatePackages.list())

  await page.addInitScript("window.__name = (target) => target")
  await page.addInitScript(() => {
    const w = window as any
    w.api = {
      file: {
        select: async () => ({
          canceled: false,
          files: [{ filePath: "/docs/需求规格.md", grant: "g1" }]
        }),
        parseSelected: async () => ({
          success: true,
          attachment: {
            filename: "需求规格.md",
            mimeType: "text/markdown",
            size: 128,
            content: "# 需求规格"
          }
        })
      },
      design: {
        listSystems: () => w.dmListSystems(),
        readSystem: (id: string) => w.dmReadSystem(id),
        saveSystem: async () => ({ success: false, error: "unused" }),
        listTemplates: () => w.dmListTemplates(),
        listImportedTemplates: () => w.dmListImportedTemplates(),
        readTemplate: async () => ({ error: "unused" }),
        importTemplate: async () => ({ error: "unused" }),
        updateTemplateAssociation: async () => ({ error: "unused" })
      },
      designMarket: {
        getActor: () => w.dmGetActor(),
        listCatalog: (q: unknown) => w.dmListCatalog(q),
        getSystemDetail: (id: string) => w.dmGetSystemDetail(id),
        getTemplateDetail: (id: string) => w.dmGetTemplateDetail(id),
        listMyUploads: async () => ({ success: true, data: { actor: null, systems: [], templates: [], notices: [] } }),
        listDownloaded: () => w.dmListDownloaded(),
        planDownload: (k: any, a: any, v: any, s: any) => w.dmPlanDownload(k, a, v, s),
        downloadSystem: (s: string, v?: string) => w.dmDownloadSystem(s, v),
        downloadTemplate: (t: string, v?: string, s?: string | null) => w.dmDownloadTemplate(t, v, s),
        cancelDownload: async () => false,
        setTemplateVisibilityBySystemOwner: (t: string, v: any, r?: string) => w.dmSetTemplateVisibility(t, v, r),
        countAffectedTemplatesForSystemRemoval: (id: string) => w.dmCountAffected(id),
        removeSystemFromPicker: (id: string) => w.dmRemoveSystem(id),
        restoreSystemToPicker: (id: string) => w.dmRestoreSystem(id),
        onDownloadProgress: () => () => {}
      }
    }
  })

  const uiPort = (uiServer.address() as AddressInfo).port
  await page.goto(`http://127.0.0.1:${uiPort}`)

  // Scenario 1 & 2: Standalone market as ChenLu -> edit visibility, static img only, search nested hit
  await page.getByLabel("切换测试账号").selectOption("chenlu")
  await page.getByRole("button", { name: "进入独立市场", exact: true }).click()
  await page.getByRole("textbox", { name: "搜索设计系统或模板" }).fill("筛选表格")
  await page.getByText("匹配到的所属模板").waitFor()
  // No template iframe rendered on market browse!
  assert.equal(await page.locator("iframe").count(), 0)
  assert.ok((await page.locator("img").count()) >= 1)

  await page.getByTestId(`market-system-card-${sysId}`).getByRole("button", { name: "详情", exact: true }).click()
  await page.getByRole("heading", { name: "企业工作台" }).waitFor()
  assert.equal(await page.getByRole("button", { name: "编辑设计系统" }).count(), 0)
  // ChenLu sees 编辑 on her own template card, NOT on 林安's 批量导入
  const chenluCard = page.getByTestId(`market-template-card-${filterPub.template.templateId}`)
  const batchCard = page.getByTestId(`market-template-card-${batchDraft.template.templateId}`)
  assert.equal(await chenluCard.getByRole("button", { name: "编辑" }).count(), 1)
  assert.equal(await batchCard.getByRole("button", { name: "编辑" }).count(), 0)

  // Direct HTTP call by ChenLu trying to edit LinAn's system returns 403
  const directForbidden = await fetch(`${marketUrl}${MARKETPLACE_API_PATH}/design/systems/${sysId}/draft`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Authorization: "test-session-chenlu"
    },
    body: JSON.stringify({
      expectedRevision: 1,
      name: "非法修改",
      description: "x",
      category: "企业应用",
      markdown: "# x",
      palette: ["#111111", "#222222", "#333333", "#444444"],
      version: "3.0.0",
      changelog: ""
    })
  })
  assert.equal(directForbidden.status, 403)

  // Open template detail (undownloaded): static preview img only, 0 iframes
  await chenluCard.getByRole("button", { name: "详情与预览" }).click()
  await page.getByText("v1.2.0 及以上，低于 v2.0.0").waitFor()
  assert.equal(await page.locator("iframe").count(), 0)

  // Switch to LinAn: hide ChenLu's template then restore it (remount resets panel to home)
  await page.getByLabel("切换测试账号").selectOption("linan")
  await page.getByTestId(`market-system-card-${sysId}`).getByRole("button", { name: "详情", exact: true }).click()
  await page.getByTestId(`market-template-card-${filterPub.template.templateId}`).getByRole("button", { name: "隐藏" }).click()
  await page.getByPlaceholder("请输入隐藏展示原因（必填）").fill("测试隐藏展示")
  await page.getByRole("button", { name: "确认隐藏", exact: true }).click()
  await page.getByText(/已由系统作者隐藏/).waitFor()
  await page.getByTestId(`market-template-card-${filterPub.template.templateId}`).getByRole("button", { name: "恢复展示" }).click()

  // Scenario 3: Creation page with uploaded requirement attachment + Market Overlay download + form preservation
  await page.getByRole("button", { name: "进入新建设计", exact: true }).click()
  await page.getByRole("button", { name: "上传需求文件", exact: true }).click()
  await page.getByRole("button", { name: "选择文件", exact: true }).click()
  await page.getByText("需求规格.md", { exact: true }).waitFor()

  await page.getByRole("button", { name: "浏览设计市场", exact: true }).click()
  await page.getByRole("dialog", { name: "设计市场浮层" }).waitFor()
  await page.getByTestId(`market-system-card-${sysId}`).getByRole("button", { name: "详情", exact: true }).click()
  await page.getByTestId(`market-template-card-${filterPub.template.templateId}`).getByRole("button", { name: "下载模板" }).click()
  await page.getByText(/已下载模板「筛选表格」/).waitFor()
  await page.getByRole("button", { name: "返回新建设计", exact: true }).first().click()

  // Attachment and upload tab intact after closing overlay
  await page.getByText("需求规格.md", { exact: true }).waitFor()
  await page.getByRole("button", { name: "上传模板", exact: true }).click()
  await page.getByRole("button", { name: "选择 HTML / ZIP", exact: true }).waitFor()
  await page.getByRole("button", { name: "选择模板", exact: true }).click()

  // Note: because market seeded v2.0.0 as latest on server while planDownload picked v1.2.0 (latest compatible!),
  // let's select the downloaded v1.2.0 system and verify 筛选表格 appears under 专属模板 with 来自设计市场 badge
  const v120Local = localStore.listAllSystemInfos().find((s) => s.marketVersion === "1.2.0")!
  await page
    .getByLabel("测试直接切换系统版本")
    .locator(`option[value="${v120Local.id}"]`)
    .waitFor({ state: "attached" })
  await page.getByLabel("测试直接切换系统版本").selectOption(v120Local.id)
  await page.getByText("来自设计市场", { exact: true }).waitFor()
  await page.getByRole("button", { name: "选择筛选表格模板预览", exact: true }).click()
  // Multi-entry selector appears for multi-page market template
  await page.getByLabel("市场模板入口页").selectOption("detail.html")

  // Scenario 4: Download v2.0.0 and switch within the same system -> template greyed out & cleared
  await localStore.downloadSystemVersion({
    transport,
    actor: actors.linan,
    systemId: sysId,
    versionId: sysV200Id
  })
  await page.getByRole("button", { name: "刷新本地资产", exact: true }).click()
  const v200Local = localStore.listAllSystemInfos().find((s) => s.marketVersion === "2.0.0")!
  await page
    .getByLabel("测试直接切换系统版本")
    .locator(`option[value="${v200Local.id}"]`)
    .waitFor({ state: "attached" })
  await page.getByLabel("测试直接切换系统版本").selectOption(v200Local.id)
  await page.getByText(/最低适配 v1\.2\.0/).first().waitFor()
  await page
    .getByLabel("选择模板")
    .getByRole("button", { name: "更换设计系统", exact: true })
    .waitFor()

  // Switch back to v1.2.0 and pick template inside editor's DesignTemplateDialog
  await page.getByLabel("测试直接切换系统版本").selectOption(v120Local.id)
  await page.getByRole("button", { name: "进入编辑器模板弹窗", exact: true }).click()
  await page.getByRole("button", { name: "打开关联页面模板", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "选择筛选表格模板预览", exact: true }).click()
  await page.getByRole("button", { name: "关联此模板", exact: true }).click()
  const editorOut = JSON.parse((await page.getByTestId("editor-template").textContent()) || "{}")
  assert.equal(editorOut.name, "筛选表格")

  // Scenario 5: Remove last compatible system -> 需补齐设计系统 -> repair restores
  await page.getByRole("button", { name: "进入独立市场", exact: true }).click()
  await page
    .getByRole("navigation", { name: "设计市场导航" })
    .getByRole("button", { name: /^已下载/ })
    .click()
  const sysSection = page.locator("section").filter({ hasText: "已下载的设计系统" })
  const v200Row = sysSection
    .locator("div.rounded-xl")
    .filter({ has: page.getByText("v2.0.0", { exact: true }) })
  await v200Row.getByRole("button", { name: "从选择器移除", exact: true }).click()
  await v200Row.getByRole("button", { name: "恢复到选择器", exact: true }).waitFor()

  const v120Row = sysSection
    .locator("div.rounded-xl")
    .filter({ has: page.getByText("v1.2.0", { exact: true }) })
  await v120Row.getByRole("button", { name: "从选择器移除", exact: true }).click()
  await page.getByRole("button", { name: "确认移除", exact: true }).click()

  await page.getByText(/需补齐设计系统/).waitFor()
  await page.getByRole("button", { name: "补齐设计系统", exact: true }).click()
  await page.getByText(/已下载模板「筛选表格」/).waitFor()
  await page.getByText(/需补齐设计系统/).waitFor({ state: "detached" })

  assert.deepEqual(errors, [])
  console.log("PASS design market UI, auth/403, compatibility, overlay preservation & repair E2E")
} finally {
  await browser.close()
  await new Promise<void>((resolve) => uiServer.close(() => resolve()))
  await new Promise<void>((resolve) => marketServer.close(() => resolve()))
  fs.rmSync(temporary, { recursive: true, force: true })
}
