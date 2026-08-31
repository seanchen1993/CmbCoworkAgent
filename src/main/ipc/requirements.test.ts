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
  requirements.registerRequirementHandlers(fakeIpcMain as never)
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
    const getPrdPreview = handlers.get("requirements:get-prd-preview")
    const getSourcePreview = handlers.get("requirements:get-source-preview")
    const deleteRequirement = handlers.get("requirements:delete")
    const openWorkDir = handlers.get("requirements:open-work-dir")
    const syncManifest = handlers.get("requirements:sync-manifest")
    const getToken = handlers.get("requirements:get-token")
    const saveToken = handlers.get("requirements:save-token")
    expect(create).toBeTypeOf("function")
    expect(getWorkDir).toBeTypeOf("function")
    expect(list).toBeTypeOf("function")
    expect(getPrdPreview).toBeTypeOf("function")
    expect(getSourcePreview).toBeTypeOf("function")
    expect(deleteRequirement).toBeTypeOf("function")
    expect(openWorkDir).toBeTypeOf("function")
    expect(syncManifest).toBeTypeOf("function")
    expect(getToken).toBeTypeOf("function")
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

    const emptyPrdPreview = (await getPrdPreview!(null, created.requirement!.reqId)) as {
      success: boolean
      preview?: {
        generated: boolean
        filePath: string | null
        fileName: string | null
        content: string
      }
      error?: string
    }
    expect(emptyPrdPreview.success, emptyPrdPreview.error).toBe(true)
    expect(emptyPrdPreview.preview).toEqual({
      generated: false,
      filePath: null,
      fileName: null,
      content: ""
    })

    writeFileSync(join(prdDir, "notes.md"), "# Notes\n\nGenerated content", "utf-8")
    const discoveredPrdPreview = (await getPrdPreview!(null, created.requirement!.reqId)) as {
      success: boolean
      preview?: {
        generated: boolean
        filePath: string | null
        fileName: string | null
        content: string
      }
      error?: string
    }
    expect(discoveredPrdPreview.success, discoveredPrdPreview.error).toBe(true)
    expect(discoveredPrdPreview.preview).toMatchObject({
      generated: false,
      filePath: null,
      fileName: null,
      content: ""
    })

    writeFileSync(join(prdDir, "PRD.md"), "# Canonical PRD\n\nPreferred preview", "utf-8")
    const canonicalPrdPreview = (await getPrdPreview!(null, created.requirement!.reqId)) as {
      success: boolean
      preview?: {
        generated: boolean
        filePath: string | null
        fileName: string | null
        content: string
      }
      error?: string
    }
    expect(canonicalPrdPreview.success, canonicalPrdPreview.error).toBe(true)
    expect(canonicalPrdPreview.preview).toMatchObject({
      generated: false,
      filePath: null,
      fileName: null,
      content: ""
    })

    writeFileSync(join(prdDir, "full-prd.md"), "# Full PRD\n\nCompleted", "utf-8")
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
      prdGenerated: boolean
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
    expect(history[0].prdGenerated).toBe(true)
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

    const indexPath = join(tempHome, ".cmbcoworkagent", "requirements", "index.json")
    const index = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      list: Array<{
        requirementPath?: string
        prdManifest?: unknown
        prdGenerated?: boolean
        prdVersion?: string | null
        prdPublished?: boolean
        prdManifestSynced?: boolean
      }>
    }
    expect(index.list[0].requirementPath).toBe(created.requirement?.requirementPath)
    expect(index.list[0].prdGenerated).toBe(true)
    expect(index.list[0].prdManifest).toEqual(history[0].prdManifest)
    expect(index.list[0]).not.toHaveProperty("workDir")
    expect(index.list[0]).not.toHaveProperty("prdVersion")
    expect(index.list[0]).not.toHaveProperty("prdPublished")
    expect(index.list[0]).not.toHaveProperty("prdManifestSynced")

    const emptyToken = (await getToken!(null)) as {
      success: boolean
      token: string
      error?: string
    }
    expect(emptyToken.success, emptyToken.error).toBe(true)
    expect(emptyToken.token).toBe("")
    const tokenSaved = (await saveToken!(null, "  leanstar-token  ")) as {
      success: boolean
      error?: string
    }
    expect(tokenSaved.success, tokenSaved.error).toBe(true)
    const configuredToken = (await getToken!(null)) as {
      success: boolean
      token: string
      error?: string
    }
    expect(configuredToken.success, configuredToken.error).toBe(true)
    expect(configuredToken.token).toBe("leanstar-token")
    expect(JSON.parse(readFileSync(indexPath, "utf-8"))).toMatchObject({ token: "leanstar-token" })

    writeFileSync(
      indexPath,
      JSON.stringify({
        list: [{ ...index.list[0], prdVersion: "v1.0" }]
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
})
