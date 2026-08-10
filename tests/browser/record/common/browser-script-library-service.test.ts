import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES } from "../../../../src/shared/browser-types"
import {
  deleteBrowserScriptLibraryEntry,
  listBrowserScriptLibraryEntries,
  readBrowserScriptLibraryScript,
  resetBrowserScriptLibraryForTests,
  saveBrowserScriptLibraryEntry,
  setBrowserScriptLibraryRootForTests,
  updateBrowserScriptLibraryEntry
} from "../../../../src/main/browser/record/common/browser-script-library-service"

let libraryRoot = ""

describe("browser script library service", () => {
  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "cmb-browser-library-"))
    setBrowserScriptLibraryRootForTests(libraryRoot)
  })

  afterEach(async () => {
    resetBrowserScriptLibraryForTests()
    if (libraryRoot) await rm(libraryRoot, { recursive: true, force: true })
  })

  it("stores scripts with generated unique file names and writes browser.json mappings", async () => {
    const first = await saveBrowserScriptLibraryEntry({
      displayName: "登录流程",
      description: "验证用户名登录",
      recordingSource: "ai",
      script: "test('login', async ({ page }) => {})",
      threadId: "thread-a",
      workspacePath: "/tmp/workspace-a"
    })
    const second = await saveBrowserScriptLibraryEntry({
      displayName: "登录流程副本",
      description: "第二条记录",
      recordingSource: "manual",
      script: "test('login again', async ({ page }) => {})",
      threadId: "thread-a",
      workspacePath: "/tmp/workspace-a"
    })

    expect(first.fileName).toMatch(/^browser-recording-.+\.spec\.ts$/)
    expect(second.fileName).toMatch(/^browser-recording-.+\.spec\.ts$/)
    expect(second.fileName).not.toBe(first.fileName)
    expect(first.workspacePath).toBe(resolve("/tmp/workspace-a"))
    expect(first.recordingSource).toBe("ai")
    expect(second.recordingSource).toBe("manual")
    await expect(readBrowserScriptLibraryScript({ fileName: first.fileName })).resolves.toBe(
      "test('login', async ({ page }) => {})"
    )

    const manifest = JSON.parse(await readFile(join(libraryRoot, "browser.json"), "utf8")) as {
      entries: unknown[]
      version: number
    }
    expect(manifest.version).toBe(1)
    expect(manifest.entries).toHaveLength(2)
  })

  it("lists all mappings regardless of workspace hint", async () => {
    await saveBrowserScriptLibraryEntry({
      displayName: "工作区 A",
      description: "A 描述",
      recordingSource: "manual",
      script: `const 变量_目标地址 = ""; // 变量-目标地址`,
      threadId: "thread-a",
      workspacePath: "/tmp/workspace-a"
    })
    await saveBrowserScriptLibraryEntry({
      displayName: "工作区 B",
      description: "B 描述",
      recordingSource: "ai",
      script: "B",
      threadId: "thread-b",
      workspacePath: "/tmp/workspace-b"
    })

    const entries = await listBrowserScriptLibraryEntries({ workspacePath: "/tmp/workspace-a" })

    expect(entries).toEqual([
      expect.objectContaining({
        displayName: "工作区 B",
        description: "B 描述",
        recordingSource: "ai",
        threadId: "thread-b",
        hasVariables: false,
        workspacePath: resolve("/tmp/workspace-b")
      }),
      expect.objectContaining({
        displayName: "工作区 A",
        description: "A 描述",
        recordingSource: "manual",
        threadId: "thread-a",
        hasVariables: true,
        workspacePath: resolve("/tmp/workspace-a")
      })
    ])
  })

  it("updates the script and display name in the existing library entry", async () => {
    const entry = await saveBrowserScriptLibraryEntry({
      displayName: "旧名称",
      recordingSource: "manual",
      script: "old script",
      threadId: "thread-a",
      workspacePath: "/tmp/workspace-a"
    })

    await updateBrowserScriptLibraryEntry({
      fileName: entry.fileName,
      displayName: "新名称",
      script: "new script"
    })

    await expect(readBrowserScriptLibraryScript({ fileName: entry.fileName })).resolves.toBe(
      "new script"
    )
    await expect(
      listBrowserScriptLibraryEntries({ workspacePath: "/tmp/workspace-a" })
    ).resolves.toEqual([
      expect.objectContaining({
        fileName: entry.fileName,
        displayName: "新名称",
        recordingSource: "manual"
      })
    ])
  })

  it("rejects unsafe script file names", async () => {
    await expect(readBrowserScriptLibraryScript({ fileName: "browser.json" })).rejects.toThrow(
      "脚本文件名无效"
    )
    await expect(readBrowserScriptLibraryScript({ fileName: "../secret.spec.ts" })).rejects.toThrow(
      "脚本文件名无效"
    )
  })

  it("rejects new recordings after reaching the library limit", async () => {
    const entries = Array.from({ length: MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES }, (_, index) => ({
      createdAt: `2026-08-10T00:00:${String(index).padStart(2, "0")}.000Z`,
      description: "",
      displayName: `录制 ${index + 1}`,
      fileName: `browser-recording-seeded-${index + 1}.spec.ts`,
      recordingSource: "manual",
      threadId: "thread-a",
      workspacePath: "/tmp/workspace-a"
    }))
    await writeFile(
      join(libraryRoot, "browser.json"),
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
      "utf8"
    )

    await expect(
      saveBrowserScriptLibraryEntry({
        displayName: "超出上限的录制",
        recordingSource: "ai",
        script: "test('too many', async ({ page }) => {})",
        threadId: "thread-a",
        workspacePath: "/tmp/workspace-a"
      })
    ).rejects.toThrow(`录制列表最多保存 ${MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES} 个录制文件`)
  })

  it("deletes the script file and removes its browser.json mapping", async () => {
    const entry = await saveBrowserScriptLibraryEntry({
      displayName: "待删除脚本",
      description: "删除验证",
      recordingSource: "ai",
      script: "test('delete me', async ({ page }) => {})",
      threadId: "thread-a",
      workspacePath: "/tmp/workspace-a"
    })

    await deleteBrowserScriptLibraryEntry({ fileName: entry.fileName })

    await expect(readBrowserScriptLibraryScript({ fileName: entry.fileName })).rejects.toThrow(
      "脚本文件不存在，可能已被删除"
    )
    await expect(
      listBrowserScriptLibraryEntries({ workspacePath: "/tmp/workspace-a" })
    ).resolves.toEqual([])

    const manifest = JSON.parse(await readFile(join(libraryRoot, "browser.json"), "utf8")) as {
      entries: unknown[]
      version: number
    }
    expect(manifest.version).toBe(1)
    expect(manifest.entries).toEqual([])
  })

  it("defaults legacy manifest entries without recordingSource to ai", async () => {
    const manifestPath = join(libraryRoot, "browser.json")
    const legacyManifest = {
      version: 1,
      entries: [
        {
          createdAt: "2026-07-31T00:00:00.000Z",
          description: "旧记录",
          displayName: "历史录制",
          fileName: "browser-recording-legacy.spec.ts",
          threadId: "thread-legacy",
          workspacePath: "/tmp/workspace-legacy"
        }
      ]
    }
    await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8")

    const entries = await listBrowserScriptLibraryEntries({
      workspacePath: "/tmp/workspace-legacy"
    })

    expect(entries).toEqual([
      expect.objectContaining({
        displayName: "历史录制",
        recordingSource: "ai"
      })
    ])
  })
})
