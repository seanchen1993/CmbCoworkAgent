import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { RequirementCredentialStore } from "../services/requirements/credential-store"
import { LeanstarRequirementGateway } from "../services/requirements/leanstar-gateway"
import { isTrustedMainLogToggleRequest } from "../main-log-forwarding"

const { openPath } = vi.hoisted(() => ({
  openPath: vi.fn(async () => "")
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => "cmb-test",
    getVersion: () => "0.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath },
  ipcMain: { handle: () => undefined }
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const fakeIpcMain = {
  handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
}

const previousHome = process.env.HOME
const previousUserProfile = process.env.USERPROFILE
let tempHome = ""
let requirements: typeof import("./requirements")

beforeAll(async () => {
  tempHome = mkdtempSync(join(tmpdir(), "cmb-requirements-test-"))
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  requirements = await import("./requirements")
  requirements.registerRequirementHandlers(fakeIpcMain as never, {
    isTrustedEvent: () => true,
    credentials: new RequirementCredentialStore({
      directory: join(tempHome, "test-profile-credentials"),
      legacyIndexPath: () => join(tempHome, ".cmbcoworkagent", "requirements", "index.json"),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value.split("").reverse().join("")),
        decryptString: (value) => value.toString().split("").reverse().join("")
      },
      platform: "darwin"
    })
  })
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
  if (tempHome && existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true })
})

describe("requirement source preview", () => {
  it("extracts uploaded DOCX content and returns it from history", async () => {
    const sourcePath = resolve("node_modules/mammoth/test/test-data/simple-list.docx")
    const workDir = join(tempHome, "requirement-workspace")
    mkdirSync(workDir)
    const create = handlers.get("requirements:create")
    const getWorkDir = handlers.get("requirements:get-work-dir")
    const list = handlers.get("requirements:list")
    const getSourcePreview = handlers.get("requirements:get-source-preview")
    const deleteRequirement = handlers.get("requirements:delete")
    const openWorkDir = handlers.get("requirements:open-work-dir")
    const syncManifest = handlers.get("requirements:sync-manifest")
    const getCredentialStatus = handlers.get("requirements:get-credential-status")
    const saveToken = handlers.get("requirements:save-token")
    expect(create).toBeTypeOf("function")
    expect(getWorkDir).toBeTypeOf("function")
    expect(list).toBeTypeOf("function")
    expect(getSourcePreview).toBeTypeOf("function")
    expect(deleteRequirement).toBeTypeOf("function")
    expect(openWorkDir).toBeTypeOf("function")
    expect(syncManifest).toBeTypeOf("function")
    expect(getCredentialStatus).toBeTypeOf("function")
    expect(handlers.has("requirements:get-token")).toBe(false)
    expect(saveToken).toBeTypeOf("function")

    const created = (await create!(null, {
      systemId: "system-a",
      title: "DOCX 需求",
      workDir,
      source: {
        type: "file",
        fileName: "requirement.docx",
        sourcePath
      }
    })) as {
      success: boolean
      requirement?: {
        reqId: string
        requirementPath: string
      }
      error?: string
    }

    expect(created.success, created.error).toBe(true)
    expect(created.requirement?.requirementPath).toMatch(
      new RegExp(`^${join(workDir, "requirements", "req-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    )
    expect(await getWorkDir!(null)).toBe(workDir)

    const indexPath = join(tempHome, ".cmbcoworkagent", "requirements", "index.json")
    const settingsPath = join(tempHome, ".cmbcoworkagent", "requirements", "settings.json")
    const indexBeforeMigration = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      list: unknown[]
    }
    writeFileSync(indexPath, JSON.stringify({ list: indexBeforeMigration.list }), "utf-8")
    writeFileSync(settingsPath, JSON.stringify({ lastWorkDir: workDir }), "utf-8")
    expect(await getWorkDir!(null)).toBe(workDir)
    expect(existsSync(settingsPath)).toBe(false)
    expect(JSON.parse(readFileSync(indexPath, "utf-8"))).toMatchObject({ lastWorkDir: workDir })

    const archivedSourcePath = join(
      created.requirement!.requirementPath,
      "source",
      "requirement.docx"
    )
    const cachedPreviewPath = join(created.requirement!.requirementPath, "source-preview.md")
    expect(readFileSync(cachedPreviewPath, "utf-8")).toContain("- Apple")
    const prdDir = join(created.requirement!.requirementPath, "prd")
    expect(readdirSync(prdDir)).toEqual([])

    const sourcePreview = (await getSourcePreview!(null, created.requirement!.reqId)) as {
      success: boolean
      content?: string
      error?: string
    }
    expect(sourcePreview.success, sourcePreview.error).toBe(true)
    expect(sourcePreview.content).toContain("- Apple")
    expect(sourcePreview.content).toContain("- Banana")

    const syncResult = (await syncManifest!(null, {
      reqId: created.requirement!.reqId,
      manifest: {
        prd: {
          name: "DOCX 需求",
          status: "published",
          description: "提供基础待办管理与提醒能力",
          file: "pr-doc.md",
          prDetailUrl: "https://www.baidu.com",
          extraField: "ignored"
        },
        functions: [
          {
            fr: "FR1",
            name: "模块中文",
            description: "模块解释",
            file: "fr-1-doc.md",
            keywords: ["记事本", "文件"]
          },
          {
            fr: "FR2",
            name: "第二模块",
            description: "第二个模块",
            file: "fr-2-doc.md",
            keywords: ["提醒", 1]
          }
        ],
        schema_version: "1.0"
      }
    })) as { success: boolean; error?: string }
    expect(syncResult.success, syncResult.error).toBe(true)

    const history = (await list!(null)) as Array<{
      requirementPath: string
      coreFilesMissing: boolean
      prdManifest: {
        prd: {
          name: string
          status: string
          description: string
          file: string
          prDetailUrl?: string
        }
        functions: Array<{
          fr: string
          name: string
          description: string
          file: string
          keywords: string[]
        }>
      }
    }>
    expect(history).toHaveLength(1)
    expect(history[0].requirementPath).toBe(created.requirement?.requirementPath)
    expect(history[0].coreFilesMissing).toBe(false)
    expect(history[0].prdManifest).toEqual({
      prd: {
        name: "DOCX 需求",
        status: "published",
        description: "提供基础待办管理与提醒能力",
        file: "pr-doc.md",
        prDetailUrl: "https://www.baidu.com"
      },
      functions: [
        {
          fr: "FR1",
          name: "模块中文",
          description: "模块解释",
          file: "fr-1-doc.md",
          keywords: ["记事本", "文件"]
        },
        {
          fr: "FR2",
          name: "第二模块",
          description: "第二个模块",
          file: "fr-2-doc.md",
          keywords: []
        }
      ]
    })
    expect(history[0]).not.toHaveProperty("workspacePath")
    expect(history[0]).not.toHaveProperty("sourcePath")
    expect(history[0]).not.toHaveProperty("sourcePreview")
    expect(history[0]).not.toHaveProperty("prdPath")
    expect(history[0]).not.toHaveProperty("prdVersion")
    expect(history[0]).not.toHaveProperty("prdPublished")
    expect(history[0]).not.toHaveProperty("prdPreviewPath")
    expect(history[0]).not.toHaveProperty("prdPreviewFileName")
    expect(history[0]).not.toHaveProperty("prdPreview")
    expect(history[0]).not.toHaveProperty("moduleCount")
    expect(history[0]).not.toHaveProperty("modules")
    expect(history[0]).not.toHaveProperty("status")
    expect(history[0]).not.toHaveProperty("prdGenerated")

    const index = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      list: Array<{
        requirementPath?: string
        prdManifest?: unknown
        status?: unknown
        prdGenerated?: unknown
        prdVersion?: string | null
        prdPublished?: boolean
        prdManifestSynced?: boolean
      }>
    }
    expect(index.list[0].requirementPath).toBe(created.requirement?.requirementPath)
    expect(index.list[0].prdManifest).toEqual(history[0].prdManifest)
    expect(index.list[0]).not.toHaveProperty("workDir")
    expect(index.list[0]).not.toHaveProperty("prdVersion")
    expect(index.list[0]).not.toHaveProperty("prdPublished")
    expect(index.list[0]).not.toHaveProperty("prdManifestSynced")
    expect(index.list[0]).not.toHaveProperty("status")
    expect(index.list[0]).not.toHaveProperty("prdGenerated")

    const emptyToken = (await getCredentialStatus!(null)) as {
      success: boolean
      configured: boolean
      error?: string
    }
    expect(emptyToken.success, emptyToken.error).toBe(true)
    expect(emptyToken.configured).toBe(false)
    const tokenSaved = (await saveToken!(null, "  leanstar-token  ")) as {
      success: boolean
      error?: string
    }
    expect(tokenSaved.success, tokenSaved.error).toBe(true)
    const configuredToken = (await getCredentialStatus!(null)) as {
      success: boolean
      configured: boolean
      credentialRef: string
      error?: string
    }
    expect(configuredToken.success, configuredToken.error).toBe(true)
    expect(configuredToken.configured).toBe(true)
    expect(configuredToken.credentialRef).toMatch(/^cred-/)
    expect(JSON.stringify(configuredToken)).not.toContain("leanstar-token")
    expect(JSON.parse(readFileSync(indexPath, "utf-8"))).not.toHaveProperty("token")

    writeFileSync(
      indexPath,
      JSON.stringify({
        list: [
          {
            ...index.list[0],
            status: "normalized",
            prdGenerated: true,
            prdVersion: "v1.0"
          }
        ]
      }),
      "utf-8"
    )
    rmSync(join(prdDir, "prd-manifest.json"), { force: true })
    const historyWithoutDiskManifest = (await list!(null)) as Array<{
      prdManifest: {
        prd: { status: string }
        functions: Array<{ fr: string }>
      }
    }>
    expect(historyWithoutDiskManifest[0].prdManifest.prd.status).toBe("published")
    expect(historyWithoutDiskManifest[0].prdManifest.functions[0].fr).toBe("FR1")
    const migratedIndex = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      list: Array<Record<string, unknown>>
    }
    expect(migratedIndex.list[0]).not.toHaveProperty("prdVersion")
    expect(migratedIndex.list[0]).not.toHaveProperty("status")
    expect(migratedIndex.list[0]).not.toHaveProperty("prdGenerated")

    const opened = (await openWorkDir!(null, created.requirement!.reqId)) as {
      success: boolean
      error?: string
    }
    expect(opened.success, opened.error).toBe(true)
    expect(openPath).toHaveBeenCalledWith(created.requirement!.requirementPath)

    rmSync(archivedSourcePath)
    const missingCoreFileHistory = (await list!(null)) as Array<{
      coreFilesMissing: boolean
      coreFilesMissingReason: string | null
    }>
    expect(missingCoreFileHistory[0].coreFilesMissing).toBe(true)
    expect(missingCoreFileHistory[0].coreFilesMissingReason).toContain("原始需求文件")

    rmSync(created.requirement!.requirementPath, { recursive: true, force: true })
    const folderDeletedHistory = (await list!(null)) as Array<{
      workspaceMissing: boolean
    }>
    expect(folderDeletedHistory[0].workspaceMissing).toBe(true)

    const missingFolderOpen = (await openWorkDir!(null, created.requirement!.reqId)) as {
      success: boolean
      error?: string
    }
    expect(missingFolderOpen.success).toBe(false)
    expect(missingFolderOpen.error).toContain("已被删除")
    expect(openPath).toHaveBeenCalledTimes(1)

    const deleted = (await deleteRequirement!(null, created.requirement!.reqId)) as {
      success: boolean
      error?: string
    }
    expect(deleted.success, deleted.error).toBe(true)
    expect(existsSync(created.requirement!.requirementPath)).toBe(false)
    expect(await list!(null)).toEqual([])

    const deletedIndex = JSON.parse(
      readFileSync(join(tempHome, ".cmbcoworkagent", "requirements", "index.json"), "utf-8")
    ) as { list: unknown[] }
    expect(deletedIndex.list).toEqual([])
  })

  it("stores text requirements without creating a source file", async () => {
    const workDir = join(tempHome, "blank-requirement-workspace")
    mkdirSync(workDir)
    const create = handlers.get("requirements:create")
    const getSourcePreview = handlers.get("requirements:get-source-preview")
    const deleteRequirement = handlers.get("requirements:delete")
    expect(create).toBeTypeOf("function")
    expect(getSourcePreview).toBeTypeOf("function")

    const created = (await create!(null, {
      systemId: "system-blank",
      title: "空白需求",
      workDir,
      source: {
        type: "text",
        fileName: "",
        initialDescription: "为柜员增加批量导入客户资料的能力"
      }
    })) as {
      success: boolean
      requirement?: {
        reqId: string
        requirementPath: string
        source: { type: string; initialDescription?: string }
      }
      error?: string
    }

    expect(created.success, created.error).toBe(true)
    expect(created.requirement?.source).toEqual({
      type: "text",
      fileName: "",
      initialDescription: "为柜员增加批量导入客户资料的能力"
    })
    expect(existsSync(join(created.requirement!.requirementPath, "source"))).toBe(false)

    const preview = (await getSourcePreview!(null, created.requirement!.reqId)) as {
      success: boolean
      content?: string
      error?: string
    }
    expect(preview.success, preview.error).toBe(true)
    expect(preview.content).toContain("批量导入客户资料")

    const deleted = (await deleteRequirement!(null, created.requirement!.reqId)) as {
      success: boolean
      error?: string
    }
    expect(deleted.success, deleted.error).toBe(true)
  })

  it("keeps multiple conversations and persists requirement renames", async () => {
    const workDir = join(tempHome, "multi-thread-workspace")
    mkdirSync(workDir)
    const create = handlers.get("requirements:create")
    const attach = handlers.get("requirements:attach-thread")
    const detach = handlers.get("requirements:detach-thread")
    const rename = handlers.get("requirements:rename")
    const remove = handlers.get("requirements:delete")
    const created = (await create!(null, {
      systemId: "system-multi",
      title: "多会话需求",
      workDir,
      source: { type: "text", fileName: "" }
    })) as { success: boolean; requirement: { reqId: string; requirementPath: string } }
    expect(created.success).toBe(true)

    const first = (await attach!(null, {
      reqId: created.requirement.reqId,
      threadId: "thread-a"
    })) as {
      requirement: { threadIds: string[] }
    }
    expect(first.requirement.threadIds).toEqual(["thread-a"])
    const second = (await attach!(null, {
      reqId: created.requirement.reqId,
      threadId: "thread-b"
    })) as {
      requirement: { threadIds: string[] }
    }
    expect(second.requirement.threadIds).toEqual(["thread-a", "thread-b"])

    const renamed = (await rename!(null, {
      reqId: created.requirement.reqId,
      title: "重命名后的需求"
    })) as { requirement: { title: string } }
    expect(renamed.requirement.title).toBe("重命名后的需求")
    const detached = (await detach!(null, {
      reqId: created.requirement.reqId,
      threadId: "thread-a"
    })) as { requirement: { threadIds: string[] } }
    expect(detached.requirement.threadIds).toEqual(["thread-b"])
    await remove!(null, created.requirement.reqId)
  })

  it("rejects stale manifest syncs after a newer conversation request", async () => {
    const workDir = join(tempHome, "manifest-request-workspace")
    mkdirSync(workDir)
    const create = handlers.get("requirements:create")
    const attach = handlers.get("requirements:attach-thread")
    const begin = handlers.get("requirements:begin-manifest-sync")
    const sync = handlers.get("requirements:sync-manifest")
    const list = handlers.get("requirements:list")
    const remove = handlers.get("requirements:delete")
    const created = (await create!(null, {
      systemId: "system-manifest",
      title: "Manifest 竞态",
      workDir,
      source: { type: "text", fileName: "" }
    })) as { success: boolean; requirement: { reqId: string } }
    expect(created.success).toBe(true)
    await attach!(null, { reqId: created.requirement.reqId, threadId: "thread-a" })
    await attach!(null, { reqId: created.requirement.reqId, threadId: "thread-b" })

    expect(begin && sync && list && remove).toBeTruthy()
    expect(
      await begin!(null, {
        reqId: created.requirement.reqId,
        threadId: "thread-a",
        requestId: "request-a-1"
      })
    ).toMatchObject({ success: true })
    expect(
      await begin!(null, {
        reqId: created.requirement.reqId,
        threadId: "thread-b",
        requestId: "request-b-1"
      })
    ).toMatchObject({ success: true })

    expect(
      await sync!(null, {
        reqId: created.requirement.reqId,
        threadId: "thread-a",
        requestId: "request-a-1",
        manifest: { prd: { status: "published" } }
      })
    ).toMatchObject({ success: false, error: "manifest 请求已过期" })
    expect(
      await sync!(null, {
        reqId: created.requirement.reqId,
        threadId: "thread-b",
        requestId: "request-b-1",
        manifest: { prd: { status: "generated" } }
      })
    ).toMatchObject({ success: true })

    const current = (await list!(null)) as Array<{
      reqId: string
      prdManifest: { prd: { status: string } }
    }>
    expect(
      current.find((item) => item.reqId === created.requirement.reqId)?.prdManifest.prd.status
    ).toBe("generated")
    await remove!(null, created.requirement.reqId)
  })

  it("normalizes missing threadIds and migrates legacy threadId values", async () => {
    const indexPath = join(tempHome, ".cmbcoworkagent", "requirements", "index.json")
    const list = handlers.get("requirements:list")
    const remove = handlers.get("requirements:delete")
    expect(list && remove).toBeTruthy()

    const legacyReqId = "req-legacy-thread-id"
    writeFileSync(
      indexPath,
      JSON.stringify({
        list: [
          {
            reqId: legacyReqId,
            threadId: "legacy-thread",
            systemId: "system-legacy",
            title: "旧格式需求",
            source: { type: "text", fileName: "" },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            reqId: "req-missing-thread-ids",
            threadIds: undefined,
            systemId: "system-missing",
            title: "缺失会话字段需求",
            source: { type: "text", fileName: "" },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      }),
      "utf-8"
    )

    const current = (await list!(null)) as Array<{
      reqId: string
      threadIds: string[]
    }>
    expect(current.find((item) => item.reqId === legacyReqId)?.threadIds).toEqual(["legacy-thread"])
    expect(current.find((item) => item.reqId === "req-missing-thread-ids")?.threadIds).toEqual([])

    const persisted = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      list: Array<{ reqId: string; threadIds: string[]; threadId?: unknown }>
    }
    expect(persisted.list[0]).toMatchObject({ reqId: legacyReqId, threadIds: ["legacy-thread"] })
    expect(persisted.list[0]).not.toHaveProperty("threadId")
    expect(persisted.list[1].threadIds).toEqual([])

    await remove!(null, legacyReqId)
    await remove!(null, "req-missing-thread-ids")
  })
})

describe("requirement credential IPC trust and secret boundary", () => {
  it("fails closed by default and rejects foreign WebContents, subframes, origins and documents", async () => {
    const local = new Map<string, Handler>()
    const ipc = { handle: (channel: string, handler: Handler) => local.set(channel, handler) }
    const frame = { url: "http://localhost:5173/index.html" }
    const contents = { getURL: () => "http://localhost:5173/index.html" }
    const trustedEvent = { sender: contents, senderFrame: frame }
    const indexPath = join(tempHome, ".cmbcoworkagent", "requirements", "index.json")
    const fakeStorage = new RequirementCredentialStore({
      directory: join(tempHome, "ipc-private-credentials"),
      legacyIndexPath: () => indexPath,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value).reverse(),
        decryptString: (value) => Buffer.from(value).reverse().toString()
      },
      platform: "darwin"
    })
    const channels = [
      "requirements:get-credential-status",
      "requirements:save-token",
      "requirements:leanstar-query",
      "requirements:prepare-publish",
      "requirements:confirm-publish"
    ]
    requirements.registerRequirementHandlers(ipc as never, { credentials: fakeStorage })
    for (const channel of channels)
      expect(await local.get(channel)!(trustedEvent, {})).toMatchObject({
        code: "UNTRUSTED_CALLER"
      })
    const fakeFetch = vi.fn(async () => Response.json({ content: [{ code: "safe" }], total: 1 }))
    requirements.registerRequirementHandlers(ipc as never, {
      credentials: fakeStorage,
      gateway: new LeanstarRequirementGateway({
        credentials: fakeStorage,
        gatewayUrl: () => "https://fake.example.test",
        fetch: fakeFetch as typeof fetch
      }),
      isTrustedEvent: (event) =>
        isTrustedMainLogToggleRequest({
          enabled: true,
          expectedWebContents: contents,
          sender: event.sender,
          expectedMainFrame: frame,
          senderFrame: event.senderFrame,
          expectedRendererUrl: "http://localhost:5173/index.html",
          senderUrl: contents.getURL(),
          senderFrameUrl: event.senderFrame?.url
        })
    })
    const untrusted = [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { ...frame } },
      { sender: contents, senderFrame: undefined }
    ]
    for (const event of untrusted)
      for (const channel of channels) {
        expect(
          await local.get(channel)!(event, {
            expectedWebContents: contents,
            expectedMainFrame: frame
          })
        ).toMatchObject({ code: "UNTRUSTED_CALLER" })
      }
    for (const badUrl of [
      "http://evil.test/index.html",
      "http://localhost:5173/foreign.html",
      "http://localhost:9999/index.html"
    ]) {
      frame.url = badUrl
      for (const channel of channels)
        expect(await local.get(channel)!(trustedEvent, {})).toMatchObject({
          code: "UNTRUSTED_CALLER"
        })
    }
    frame.url = "http://localhost:5173/index.html"
    const sentinel = "F02_IPC_FAKE_SECRET"
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")]
    try {
      const saved = await local.get("requirements:save-token")!(trustedEvent, sentinel)
      const status = await local.get("requirements:get-credential-status")!(trustedEvent)
      const queried = await local.get("requirements:leanstar-query")!(trustedEvent, {
        operation: "getNamespaceTree"
      })
      const publication = await local.get("requirements:prepare-publish")!(trustedEvent, {
        reqId: "req-test",
        threadId: "thread-test"
      })
      expect(saved).toMatchObject({ success: true, configured: true })
      expect(status).toMatchObject({ success: true, configured: true })
      expect(queried).toMatchObject({ success: true })
      expect(publication).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" })
      expect(local.has("requirements:get-token")).toBe(false)
      const modelSessionMemory = {
        returned: [saved, status, queried, publication],
        queued: [],
        model: [],
        session: [],
        memory: []
      }
      expect(JSON.stringify(modelSessionMemory).includes(sentinel)).toBe(false)
      expect(readFileSync(indexPath, "utf8").includes(sentinel)).toBe(false)
      expect(JSON.stringify(logs.flatMap((log) => log.mock.calls)).includes(sentinel)).toBe(false)
    } finally {
      for (const log of logs) log.mockRestore()
    }
  })
})
