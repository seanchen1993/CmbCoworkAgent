import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import AdmZip from "adm-zip"
import type { DesignMarketActor } from "../../../shared/design-market"
import { MARKETPLACE_API_PATH } from "../../../shared/marketplace-api"
import { DesignMarketLocalStore } from "./market-local-store"
import { DesignMarketService } from "./market-service"
import { buildFallbackTemplateCoverSvg } from "./market-validation"
import { DesignMarketplaceTransport } from "./marketplace-transport"

const directories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-transport-test-"))
  directories.push(dir)
  return dir
}

it("publishes Markdown and ZIP through existing marketplace routes with local drafts and remote author checks", async () => {
  const owner: DesignMarketActor = { userId: "123456", userName: "发布者" }
  const reader: DesignMarketActor = { userId: "999999", userName: "浏览者" }
  const records = new Map<string, { form: FormData; file: Blob }>()
  const writes: Array<{ method: string; route: string; filename?: string }> = []
  const credential = (actor: DesignMarketActor) => actor.userId

  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    const route = url.pathname.slice(MARKETPLACE_API_PATH.length)
    const token = new Headers(init?.headers).get("Authorization")
    expect(url.pathname.startsWith(MARKETPLACE_API_PATH)).toBe(true)
    expect([owner.userId, reader.userId]).toContain(token)
    if (route.startsWith("/list/")) {
      const type = route.split("/")[2]
      const items = [...records.values()]
        .filter(({ form }) => form.get("resource_type") === type)
        .map(({ form }) => Object.fromEntries([...form].filter(([key]) => key !== "file")))
      return Response.json({ type, items })
    }
    if (route.startsWith("/download/")) {
      const entry = records.get(route.slice("/download/".length))
      return entry ? new Response(entry.file) : new Response(null, { status: 404 })
    }
    const method = init?.method ?? ""
    const form = init?.body as FormData | undefined
    if (method === "DELETE") {
      writes.push({ method, route })
      records.delete(route.slice(1))
      return Response.json({ message: "success" })
    }
    expect(route === "/upload" || method === "PUT").toBe(true)
    const file = form?.get("file")
    expect(file).toBeInstanceOf(Blob)
    const key = `${form?.get("resource_type")}/${form?.get("name")}`
    if (method === "PUT") expect(route).toBe(`/${key}`)
    writes.push({ method, route, filename: (file as File).name })
    records.set(key, { form: form!, file: file as Blob })
    return Response.json({ message: "success" })
  })

  const publisher = new DesignMarketplaceTransport(
    "https://market.example",
    new DesignMarketService(temp(), { seedDemo: false }),
    credential
  )
  const viewer = new DesignMarketplaceTransport(
    "https://market.example",
    new DesignMarketService(temp(), { seedDemo: false }),
    credential
  )
  const draft = await publisher.createSystemDraft(
    { category: "通用", markdown: "# 企业工作台" },
    owner
  )
  const systemId = draft.system.systemId
  expect(writes).toHaveLength(0)
  await publisher.publishSystem({ systemId, expectedRevision: draft.draft!.revision }, owner)
  expect(writes[0]).toMatchObject({ method: "POST", route: "/upload", filename: "DESIGN.md" })

  const remote = await viewer.getSystemDetail(systemId, reader)
  expect(remote.markdown).toBe("# 企业工作台")
  expect(remote.system.canEdit).toBe(false)
  await expect(
    viewer.publishSystem({ systemId, expectedRevision: 1 }, reader)
  ).rejects.toMatchObject({ statusCode: 403 })
  await expect(viewer.setSystemStatus(systemId, "unpublished", reader)).rejects.toMatchObject({
    statusCode: 403
  })
  expect(writes).toHaveLength(1)

  const zip = new AdmZip()
  zip.addFile("index.html", Buffer.from("<!doctype html><html><body>模板</body></html>"))
  const staged = await publisher.stageTemplateBlob(zip.toBuffer(), owner)
  const templateDraft = await publisher.createTemplateDraft(
    {
      systemId,
      name: "表格",
      description: "模板",
      scenario: "列表",
      minSystemVersion: "1.0.0",
      defaultEntryPath: staged.defaultEntryPath,
      pages: staged.pages,
      filesCount: staged.filesCount,
      totalBytes: staged.totalBytes,
      framework: staged.framework,
      stagedBlobSha256: staged.sha256,
      coverDataUrl: buildFallbackTemplateCoverSvg("表格", "HTML", "index.html")
    },
    owner
  )
  const templateId = templateDraft.template.templateId
  expect(writes).toHaveLength(1)
  await publisher.publishTemplate(
    { templateId, expectedRevision: templateDraft.draft!.revision },
    owner
  )
  expect(writes[1]).toMatchObject({ method: "POST", route: "/upload", filename: "template.zip" })

  const local = new DesignMarketLocalStore(temp())
  const result = await local.downloadTemplateVersion({
    transport: viewer,
    actor: reader,
    templateId
  })
  expect(result).toMatchObject({
    success: true,
    template: { templateId },
    alsoDownloadedSystem: { systemId }
  })

  const editableOnSecondDevice = await viewer.getSystemDetail(systemId, owner)
  const saved = await viewer.saveSystemDraft(
    {
      ...editableOnSecondDevice.draft!,
      systemId,
      expectedRevision: editableOnSecondDevice.draft!.revision,
      version: "1.1.0",
      markdown: "# 更新后的规范"
    },
    owner
  )
  await viewer.publishSystem({ systemId, expectedRevision: saved.draft!.revision }, owner)
  expect(writes[2]).toMatchObject({
    method: "PUT",
    route: `/design-system/${systemId}`,
    filename: "DESIGN.md"
  })

  await publisher.setTemplateStatus(templateId, "unpublished", owner)
  expect(writes[3]).toMatchObject({ method: "DELETE", route: `/design-template/${templateId}` })
  expect((await viewer.getSystemDetail(systemId, reader)).templates).toHaveLength(0)
})
