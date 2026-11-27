import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it, vi } from "vitest"
import { normalizeMarketAccountId, type DesignMarketActor } from "../../../shared/design-market"
import { MARKETPLACE_API_PATH, marketplaceEndpoints } from "../../../shared/marketplace-api"
import { DesignMarketHttpClient, createDesignMarketHttpServer } from "./market-http"
import { DesignMarketService } from "./market-service"
import { buildFallbackTemplateCoverSvg, validateAndPackTemplateSource, validateTemplateZipBuffer } from "./market-validation"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, "utf8"))
  }
  return zip.toBuffer()
}

describe("DesignMarketService & HTTP authorization", () => {
  it("publishes the staged ZIP bytes even when editing and publishing happen at different times", () => {
    const service = new DesignMarketService(makeTempDir("market-delayed-publish-"), { seedDemo: false })
    const owner = { userId: "100001", userName: "发布者" }
    const systemDraft = service.createSystemDraft({ name: "系统", category: "通用", markdown: "# 规范" }, owner)
    const systemId = systemDraft.system.systemId
    service.publishSystem({ systemId, expectedRevision: systemDraft.draft!.revision }, owner)
    const zip = makeZipBuffer({ "index.html": "<!doctype html><html><body>示例</body></html>" })

    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date("2026-11-27T08:00:00Z"))
      const staged = service.stageTemplateBlob(zip, owner)
      const draft = service.createTemplateDraft({
        systemId, name: "模板", description: "示例", scenario: "列表", minSystemVersion: "1.0.0",
        defaultEntryPath: staged.defaultEntryPath, pages: staged.pages, filesCount: staged.filesCount,
        totalBytes: staged.totalBytes, framework: staged.framework, stagedBlobSha256: staged.sha256,
        coverDataUrl: buildFallbackTemplateCoverSvg("模板", "HTML", "index.html")
      }, owner)
      vi.setSystemTime(new Date("2026-11-27T08:01:00Z"))
      const published = service.publishTemplate(
        { templateId: draft.template.templateId, expectedRevision: draft.draft!.revision },
        owner
      )
      const { blob } = service.resolveDownloadBlob("template", draft.template.templateId, published.versions[0].versionId, owner)
      expect(blob.sha256).toBe(staged.sha256)
      expect(fs.statSync(blob.filePath).size).toBe(staged.bytes)
    } finally {
      vi.useRealTimers()
    }
  })

  it("normalizes 6-digit and 80-prefixed 8-digit account aliases", () => {
    expect(normalizeMarketAccountId("123456")).toBe("123456")
    expect(normalizeMarketAccountId("80123456")).toBe("123456")
    expect(normalizeMarketAccountId("80123456 / 陈璐 / 研发部")).toBe("123456")
  })

  it("rejects a template HTML file whose declared size exceeds the import limit", () => {
    const zip = new AdmZip()
    zip.addFile("index.html", Buffer.alloc(5 * 1024 * 1024 + 1, 0x20))
    expect(() => validateTemplateZipBuffer(zip.toBuffer())).toThrow("超过 5 MB 限制")
  })

  it("enforces multi-account permissions, HTTP 401/403/409, governance, and selective restore", async () => {
    const storeDir = makeTempDir("market-service-")
    const service = new DesignMarketService(storeDir, { seedDemo: false })

    const actors = new Map<string, DesignMarketActor>([
      ["linan", { userId: "100001", userName: "林安" }],
      ["chenlu-yst", { userId: "654321", userName: "陈璐" }],
      ["chenlu-sap", { userId: "80654321", userName: "陈璐" }],
      ["admin", { userId: "999000", userName: "管理员", isAdmin: true }]
    ])

    const server = createDesignMarketHttpServer(service, (credential) => actors.get(credential) ?? null)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    try {
      const client = new DesignMarketHttpClient(baseUrl, (actor) =>
        [...actors].find(([, candidate]) => candidate === actor)?.[0] ?? null
      )
      const linan = actors.get("linan")!
      const chenluYst = actors.get("chenlu-yst")!
      const chenluSap = actors.get("chenlu-sap")!
      const admin = actors.get("admin")!

      // 1. Unauthenticated access rejected with 401
      const unauthRes = await fetch(`${baseUrl}${MARKETPLACE_API_PATH}${marketplaceEndpoints.list("design-system")}`)
      expect(unauthRes.status).toBe(401)
      const invalidCredential = await fetch(
        `${baseUrl}${MARKETPLACE_API_PATH}${marketplaceEndpoints.list("design-system")}`,
        { headers: { Authorization: "expired-test-session" } }
      )
      expect(invalidCredential.status).toBe(401)

      // 2. LinAn creates and publishes 企业工作台 v1.0.0 and v1.2.0
      const createdSys = await client.createSystemDraft(
        {
          name: "企业工作台",
          category: "企业应用",
          markdown: "# 企业工作台\n\n```css\n:root{--accent:#3B6BE0;--primary:#7E9EF0;--surface:#DAE5FA;--fg:#182B59}\n```",
          version: "1.0.0"
        },
        linan
      )
      const sysId = createdSys.system.systemId
      const pub1 = await client.publishSystem(
        { systemId: sysId, expectedRevision: createdSys.draft!.revision },
        linan
      )
      expect(pub1.system.latestVersion).toBe("1.0.0")

      const savedV12 = await client.saveSystemDraft(
        {
          systemId: sysId,
          expectedRevision: pub1.draft!.revision,
          name: "企业工作台",
          description: "企业级后台规范",
          category: "企业应用",
          markdown: `${pub1.markdown}\n补充筛选表格规范`,
          palette: pub1.system.palette,
          version: "1.2.0",
          changelog: "新增筛选表格规范"
        },
        linan
      )
      // Stale revision conflict returns 409 and preserves draft
      await expect(
        client.saveSystemDraft(
          {
            systemId: sysId,
            expectedRevision: pub1.draft!.revision,
            name: "冲突覆盖",
            description: "冲突",
            category: "企业应用",
            markdown: "# 冲突",
            palette: pub1.system.palette,
            version: "1.2.1",
            changelog: "冲突"
          },
          linan
        )
      ).rejects.toMatchObject({ statusCode: 409 })

      const pub2 = await client.publishSystem(
        { systemId: sysId, expectedRevision: savedV12.draft!.revision },
        linan
      )
      expect(pub2.system.latestVersion).toBe("1.2.0")

      // 3. ChenLu uploads & publishes 筛选表格 under LinAn's system (using sapId alias later matches ystId owner)
      const validZip = makeZipBuffer({
        "filter-table.html":
          '<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><a href="https://docs.example.com">帮助</a><div class="box">表格</div></body></html>',
        "app.css": ".box{color:#111}",
        "template/tpl_dep/lib.js": "window.__ok = true;",
        ".draft-temp.html": "<p>ignore</p>"
      })
      const staged = await client.stageTemplateBlob(validZip, chenluYst, "filter-table.html")
      expect(staged.pages).toEqual(["filter-table.html"])

      const tplDraft = await client.createTemplateDraft(
        {
          systemId: sysId,
          name: "筛选表格",
          description: "企业级筛选列表",
          scenario: "列表",
          minSystemVersion: "1.2.0",
          defaultEntryPath: "filter-table.html",
          pages: staged.pages,
          filesCount: staged.filesCount,
          totalBytes: staged.totalBytes,
          framework: staged.framework,
          stagedBlobSha256: staged.sha256,
          coverDataUrl: buildFallbackTemplateCoverSvg("筛选表格", "HTML", "filter-table.html"),
          version: "1.1.0"
        },
        chenluYst
      )
      const tplId = tplDraft.template.templateId
      const tplPub = await client.publishTemplate(
        { templateId: tplId, expectedRevision: tplDraft.draft!.revision },
        chenluSap
      )
      expect(tplPub.template.canEdit).toBe(true)

      // ChenLu also creates an unpublished template draft to test selective restore
      const draftOnlyTpl = await client.createTemplateDraft(
        {
          systemId: sysId,
          name: "草稿未发布模板",
          description: "草稿",
          scenario: "表单",
          minSystemVersion: "1.0.0",
          defaultEntryPath: "filter-table.html",
          pages: staged.pages,
          filesCount: staged.filesCount,
          totalBytes: staged.totalBytes,
          framework: staged.framework,
          stagedBlobSha256: staged.sha256,
          coverDataUrl: buildFallbackTemplateCoverSvg("草稿未发布模板", "HTML", "filter-table.html")
        },
        chenluYst
      )

      // 4. Cross-account HTTP 403 protection
      const forbiddenDraft = await fetch(`${baseUrl}${MARKETPLACE_API_PATH}/design/systems/${sysId}/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: "chenlu-yst"
        },
        body: JSON.stringify({
          expectedRevision: pub2.draft!.revision,
          name: "篡改",
          description: "x",
          category: "企业应用",
          markdown: "# x",
          palette: pub2.system.palette,
          version: "1.3.0",
          changelog: ""
        })
      })
      expect(forbiddenDraft.status).toBe(403)

      const forbiddenTplEdit = await fetch(`${baseUrl}${MARKETPLACE_API_PATH}/design/templates/${tplId}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "linan"
        },
        body: JSON.stringify({ expectedRevision: tplPub.draft!.revision })
      })
      expect(forbiddenTplEdit.status).toBe(403)

      // 5. Search matching template returns parent system with matchedTemplates
      const searchRes = await client.listCatalog({ query: "筛选表格" }, linan)
      expect(searchRes.systems).toHaveLength(1)
      expect(searchRes.systems[0].matchedTemplates?.map((t) => t.name)).toEqual(["筛选表格"])

      // 6. System owner hides ChenLu's template with reason; stops public download while ChenLu keeps draft
      await client.setTemplateVisibilityBySystemOwner(
        tplId,
        "hidden_by_system_owner",
        "页面风格不符合规范",
        linan
      )
      const afterHideCatalog = await client.listCatalog({}, linan)
      expect(afterHideCatalog.systems[0].templateCount).toBe(0)
      await expect(
        client.openDownloadStream("template", tplId, undefined, linan, new AbortController().signal)
      ).rejects.toMatchObject({ statusCode: 403 })

      const chenluDetail = await client.getTemplateDetail(tplId, chenluSap)
      expect(chenluDetail.template.visibility).toBe("hidden_by_system_owner")
      expect(chenluDetail.notices.some((n) => n.reason.includes("不符合规范"))).toBe(true)

      // Restore visibility
      await client.setTemplateVisibilityBySystemOwner(tplId, "visible", "已修改合规", linan)

      // 7. System unpublish -> parent_unpublished; republish selectively restores only published & visible
      const unpubRes = await client.setSystemStatus(sysId, "unpublished", linan)
      expect(unpubRes.affectedTemplateCount).toBe(1)
      const chenluDuringUnpub = await client.getTemplateDetail(tplId, chenluYst)
      expect(chenluDuringUnpub.template.effectiveStatus).toBe("parent_unpublished")

      await expect(
        client.publishTemplate(
          { templateId: draftOnlyTpl.template.templateId, expectedRevision: draftOnlyTpl.draft!.revision },
          chenluYst
        )
      ).rejects.toMatchObject({ statusCode: 422 })

      await client.setSystemStatus(sysId, "published", linan)
      const afterRepublish = await client.getSystemDetail(sysId, linan)
      expect(afterRepublish.templates.map((t) => t.name)).toEqual(["筛选表格"])

      // 8. Admin takedown & owner cannot self-republish
      await expect(client.adminTakedown("template", tplId, "违规", linan)).rejects.toMatchObject({
        statusCode: 403
      })
      await client.adminTakedown("template", tplId, "含敏感示例数据", admin)
      await expect(client.setTemplateStatus(tplId, "published", chenluYst)).rejects.toMatchObject({
        statusCode: 403
      })
      expect(service.getAuditRecords().some((a) => a.action === "admin_takedown")).toBe(true)
      await client.adminRestore("template", tplId, "已清理", admin)
      const restored = await client.getTemplateDetail(tplId, linan)
      expect(restored.template.effectiveStatus).toBe("published")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("rejects missing relative assets, root paths, and external runtime resources while keeping HTTP hyperlinks", () => {
    const dir = makeTempDir("market-pack-")

    // Missing relative script
    const missingDir = path.join(dir, "missing")
    fs.mkdirSync(missingDir, { recursive: true })
    fs.writeFileSync(path.join(missingDir, "index.html"), '<script src="./not-found.js"></script>')
    expect(() => validateAndPackTemplateSource(missingDir)).toThrow(/not-found\.js/)

    // Site root path
    const rootRefDir = path.join(dir, "root-ref")
    fs.mkdirSync(rootRefDir, { recursive: true })
    fs.writeFileSync(path.join(rootRefDir, "index.html"), '<img src="/assets/logo.png">')
    expect(() => validateAndPackTemplateSource(rootRefDir)).toThrow(/站点根路径/)

    // External CDN script
    const cdnDir = path.join(dir, "cdn")
    fs.mkdirSync(cdnDir, { recursive: true })
    fs.writeFileSync(
      path.join(cdnDir, "index.html"),
      '<script src="https://cdn.example.com/react.js"></script>'
    )
    expect(() => validateAndPackTemplateSource(cdnDir)).toThrow(/需要联网加载的外部资源/)

    // Valid package with HTTP hyperlink and template/<id>/ dependency + transient file stripped
    const okDir = path.join(dir, "ok")
    fs.mkdirSync(path.join(okDir, "template/tpl_abc/cdn"), { recursive: true })
    fs.writeFileSync(path.join(okDir, "template/tpl_abc/cdn/app.js"), "console.log(1)")
    fs.writeFileSync(path.join(okDir, ".draft-old.html"), "<p>temp</p>")
    fs.writeFileSync(
      path.join(okDir, "index.html"),
      '<!doctype html><html><body><a href="https://example.com/help">帮助</a><script src="./template/tpl_abc/cdn/app.js"></script></body></html>'
    )
    const packed = validateAndPackTemplateSource(okDir)
    expect(packed.fileList).toEqual(["index.html", "template/tpl_abc/cdn/app.js"])
  })
})
