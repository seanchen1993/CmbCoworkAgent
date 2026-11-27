import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { PassThrough } from "node:stream"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesignMarketActor, DesignMarketDownloadProgress } from "../../../shared/design-market"
import { checkTemplateSystemCompatibility } from "../../../shared/design-template"
import { createDesignMarketHttpServer, DesignMarketHttpClient } from "./market-http"
import { DesignMarketLocalStore } from "./market-local-store"
import { DesignMarketService } from "./market-service"
import { buildFallbackTemplateCoverSvg } from "./market-validation"
import { DesignSystemLibrary } from "./system-library"
import { DesignTemplatePackages } from "./template-packages"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
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

describe("DesignMarketLocalStore streaming, compatibility, soft removal & offline lifecycle", () => {
  it("streams downloads over HTTP, verifies SHA-256, coalesces duplicates, cleans stale temp files, and rolls back atomic dual-installs on failure", async () => {
    const serverDir = makeTempDir("mkt-srv-")
    const clientDir = makeTempDir("mkt-cli-")
    const service = new DesignMarketService(serverDir, { seedDemo: false })
    const linan: DesignMarketActor = { userId: "100001", userName: "林安" }

    // Seed system v1.2.1 & v2.0.0 and template requiring v1.2.0
    const sysDraft = service.createSystemDraft(
      { name: "企业工作台", category: "企业应用", markdown: "# 企业工作台\n\n规范正文", version: "1.2.1" },
      linan
    )
    const sysPub1 = service.publishSystem(
      { systemId: sysDraft.system.systemId, expectedRevision: sysDraft.draft!.revision },
      linan
    )
    const sysV121 = sysPub1.versions[0].versionId

    const sysDraft2 = service.saveSystemDraft(
      {
        systemId: sysDraft.system.systemId,
        expectedRevision: sysPub1.draft!.revision,
        name: "企业工作台",
        description: "v2",
        category: "企业应用",
        markdown: "# 企业工作台 v2\n\n破坏性更新",
        palette: sysPub1.system.palette,
        version: "2.0.0",
        changelog: "大版本升级"
      },
      linan
    )
    const sysPub2 = service.publishSystem(
      { systemId: sysDraft.system.systemId, expectedRevision: sysDraft2.draft!.revision },
      linan
    )
    const sysV200 = sysPub2.versions.find((v) => v.version === "2.0.0")!.versionId

    const zipBuf = makeZipBuffer({
      "index.html": '<!doctype html><html><head><link rel="stylesheet" href="./s.css"></head><body><h1>列表页</h1></body></html>',
      "s.css": "body{color:#111}"
    })
    const staged = service.stageTemplateBlob(zipBuf, linan, "index.html")
    const tplDraft = service.createTemplateDraft(
      {
        systemId: sysDraft.system.systemId,
        name: "筛选表格",
        description: "列表",
        scenario: "列表",
        minSystemVersion: "1.2.0",
        defaultEntryPath: "index.html",
        pages: staged.pages,
        filesCount: staged.filesCount,
        totalBytes: staged.totalBytes,
        framework: staged.framework,
        stagedBlobSha256: staged.sha256,
        coverDataUrl: buildFallbackTemplateCoverSvg("筛选表格", "HTML", "index.html"),
        version: "1.0.0"
      },
      linan
    )
    const tplPub = service.publishTemplate(
      { templateId: tplDraft.template.templateId, expectedRevision: tplDraft.draft!.revision },
      linan
    )

    const httpServer = createDesignMarketHttpServer(service, (credential) => credential === "test-session" ? linan : null)
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    const httpClient = new DesignMarketHttpClient(baseUrl, () => "test-session")

    // Pre-create stale temp residue before constructing localStore
    fs.mkdirSync(path.join(clientDir, "tmp"), { recursive: true })
    fs.writeFileSync(path.join(clientDir, "tmp", "stale-download.bin"), "stale")

    const localStore = new DesignMarketLocalStore(clientDir)
    expect(fs.readdirSync(path.join(clientDir, "tmp"))).toEqual([])

    // 1. Corrupted SHA-256 or mid-stream failure rolls back atomic dual-commit
    const failingTransport: DesignMarketHttpClient = Object.assign(
      Object.create(Object.getPrototypeOf(httpClient)),
      httpClient,
      {
        openDownloadStream: async (kind: "system" | "template", assetId: string, versionId: string | undefined, actor: DesignMarketActor | null, signal: AbortSignal) => {
          if (kind === "system") {
            const source = await httpClient.openDownloadStream(kind, assetId, versionId, actor, signal)
            for await (const _chunk of source.stream) {
              // Consume the test server response before simulating corruption.
            }
            return { ...source, stream: new PassThrough().end(Buffer.alloc(source.expectedBytes, 0x61)) }
          }
          return httpClient.openDownloadStream(kind, assetId, versionId, actor, signal)
        }
      }
    )
    const failedRes = await localStore.downloadTemplateVersion({
      transport: failingTransport,
      actor: linan,
      templateId: tplPub.template.templateId
    })
    expect(failedRes.success).toBe(false)
    expect(failedRes.error).toMatch(/SHA-256/)
    expect(localStore.getLocalState().systems).toHaveLength(0)
    expect(localStore.getLocalState().templates).toHaveLength(0)

    const realRename = fs.renameSync
    for (const destination of ["templates", "index"]) {
      const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        const target = String(to)
        if ((destination === "templates" && path.dirname(target) === path.join(clientDir, "templates")) ||
            (destination === "index" && target === path.join(clientDir, "index.json"))) {
          throw new Error("测试磁盘提交失败")
        }
        return realRename(from, to)
      })
      try {
        const failedCommit = await localStore.downloadTemplateVersion({
          transport: httpClient, actor: linan, templateId: tplPub.template.templateId
        })
        expect(failedCommit).toMatchObject({ success: false, error: "测试磁盘提交失败" })
        expect(localStore.getLocalState()).toMatchObject({ systems: [], templates: [] })
        expect(fs.readdirSync(path.join(clientDir, "systems"))).toEqual([])
        expect(fs.readdirSync(path.join(clientDir, "templates"))).toEqual([])
        expect(fs.readdirSync(path.join(clientDir, "tmp"))).toEqual([])
      } finally {
        rename.mockRestore()
      }
    }

    // 2. Concurrent download coalesces and auto-downloads missing compatible system v1.2.1 (NOT v2.0.0!)
    const progressEvents: DesignMarketDownloadProgress[] = []
    const openStream = vi.spyOn(httpClient, "openDownloadStream")
    const [resA, resB] = await Promise.all([
      localStore.downloadTemplateVersion({
        transport: httpClient,
        actor: linan,
        templateId: tplPub.template.templateId,
        onProgress: (evt) => progressEvents.push(evt)
      }),
      localStore.downloadTemplateVersion({
        transport: httpClient,
        actor: linan,
        templateId: tplPub.template.templateId
      })
    ])
    expect(resA.success).toBe(true)
    expect(resB.success).toBe(true)
    expect(openStream.mock.calls.map(([kind]) => kind)).toEqual(["template", "system"])
    openStream.mockRestore()
    expect(resA.alsoDownloadedSystem?.version).toBe("1.2.1")
    expect(progressEvents.some((e) => e.phase === "downloading")).toBe(true)
    expect(progressEvents.some((e) => e.phase === "done")).toBe(true)

    // 3. Re-downloading same version reuses existing files cleanly
    const reused = await localStore.downloadSystemVersion({
      transport: httpClient,
      actor: linan,
      systemId: sysDraft.system.systemId,
      versionId: sysV121
    })
    expect(reused.success).toBe(true)
    expect(reused.reusedExisting).toBe(true)

    // 4. Download v2.0.0 as well and check SemVer compatibility
    const v2Res = await localStore.downloadSystemVersion({
      transport: httpClient,
      actor: linan,
      systemId: sysDraft.system.systemId,
      versionId: sysV200
    })
    expect(v2Res.success).toBe(true)

    const packages = new DesignTemplatePackages(makeTempDir("local-pkgs-"))
    const allSysInfos = localStore.listAllSystemInfos()
    const tplInfos = localStore.listSelectableTemplateInfos(packages)
    const info121 = allSysInfos.find((s) => s.marketVersion === "1.2.1")!
    const info200 = allSysInfos.find((s) => s.marketVersion === "2.0.0")!
    expect(checkTemplateSystemCompatibility(tplInfos[0], info121)).toEqual({
      visible: true,
      compatible: true
    })
    expect(checkTemplateSystemCompatibility(tplInfos[0], info200).compatible).toBe(false)

    // 5. Soft removal preserves historical v1.2.1 file, affects template count, and toggles missingCompatibleSystem
    expect(localStore.countAffectedTemplatesForSystemRemoval(info121.id)).toBe(1)
    localStore.removeSystemFromPicker(info121.id)

    const stateAfterRemove = localStore.getLocalState()
    expect(stateAfterRemove.templates[0].missingCompatibleSystem).toBe(true)
    // Historical read still works via listAllSystemInfos()
    const historical = localStore.listAllSystemInfos().find((s) => s.id === info121.id)!
    expect(historical.removedFromPicker).toBe(true)
    expect(fs.existsSync(historical.path)).toBe(true)

    // Restoring v1.2.1 clears missingCompatibleSystem automatically
    localStore.restoreSystemToPicker(info121.id)
    expect(localStore.getLocalState().templates[0].missingCompatibleSystem).toBe(false)

    // Explicitly removed template stays removed even when compatible system is present
    localStore.removeTemplateFromPicker(stateAfterRemove.templates[0].localId)
    expect(localStore.listSelectableTemplateInfos(packages)).toHaveLength(0)
    localStore.restoreTemplateToPicker(stateAfterRemove.templates[0].localId)
    expect(localStore.listSelectableTemplateInfos(packages)).toHaveLength(1)

    // 6. Save-as-local-copy creates editable copies; market package rejects direct updateAssociation
    const userSysLib = new DesignSystemLibrary(makeTempDir("user-sys-"))
    const copiedSys = localStore.copySystemToLocalLibrary(info121.id, userSysLib)
    expect(copiedSys.ownership).toBe("user")
    expect(copiedSys.source).toBe("market-copy")

    const marketRef = tplInfos[0].package!
    expect(() => packages.updateAssociation(marketRef, "user:abc")).toThrow(/另存为本地副本/)

    const copiedTpl = localStore.copyTemplateToLocalPackages(
      localStore.getLocalState().templates[0].localId,
      packages
    )
    expect(copiedTpl.id.startsWith("tpl_")).toBe(true)
    expect(packages.updateAssociation({ id: copiedTpl.id, entryPath: copiedTpl.entryPath }, null).designSystemKey).toBeNull()

    // 7. Offline availability after server closes
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    expect(localStore.getLocalState().systems.length).toBe(2)
    expect(localStore.listSelectableTemplateInfos(packages)).toHaveLength(1)
  })

  it("cancels an in-flight download cleanly without committing partial files", async () => {
    const serverDir = makeTempDir("mkt-srv-cancel-")
    const clientDir = makeTempDir("mkt-cli-cancel-")
    const service = new DesignMarketService(serverDir, { seedDemo: false })
    const linan: DesignMarketActor = { userId: "100001", userName: "林安" }
    const draft = service.createSystemDraft(
      { name: "慢速系统", category: "通用", markdown: "# 慢速", version: "1.0.0" },
      linan
    )
    const pub = service.publishSystem(
      { systemId: draft.system.systemId, expectedRevision: draft.draft!.revision },
      linan
    )
    const versionId = pub.versions[0].versionId
    const localStore = new DesignMarketLocalStore(clientDir)

    const slowTransport: DesignMarketHttpClient = {
      getSystemDetail: async () => pub,
      openDownloadStream: async () => {
        const stream = new PassThrough()
        setTimeout(() => stream.write(Buffer.from("# half")), 20)
        return {
          stream,
          expectedBytes: pub.versions[0].bytes,
          expectedSha256: pub.versions[0].sha256,
          versionId,
          version: "1.0.0"
        }
      }
    } as unknown as DesignMarketHttpClient

    const downloadPromise = localStore.downloadSystemVersion({
      transport: slowTransport,
      actor: linan,
      systemId: draft.system.systemId,
      versionId,
      onProgress: (evt) => {
        if (evt.phase === "downloading" && evt.receivedBytes > 0) {
          setTimeout(() => localStore.cancelDownload(evt.downloadKey), 20)
        }
      }
    })
    const res = await downloadPromise
    expect(res.success).toBe(false)
    expect(res.canceled).toBe(true)
    expect(localStore.cancelDownload(`system:${draft.system.systemId}:${versionId}`)).toBe(false)
    expect(fs.readdirSync(path.join(clientDir, "tmp"))).toEqual([])
    expect(localStore.getLocalState().systems).toHaveLength(0)
  })
})
