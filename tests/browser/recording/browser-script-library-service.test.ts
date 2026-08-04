import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  deleteBrowserScriptLibraryEntry,
  listBrowserScriptLibraryEntries,
  readBrowserScriptLibraryScript,
  resetBrowserScriptLibraryForTests,
  saveBrowserScriptLibraryEntry,
  setBrowserScriptLibraryRootForTests
} from "../../../src/main/browser/recording/browser-script-library-service"

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

  it("filters mappings by workspace while preserving the saved metadata", async () => {
    await saveBrowserScriptLibraryEntry({
      displayName: "工作区 A",
      description: "A 描述",
      recordingSource: "manual",
      script: "A",
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
        displayName: "工作区 A",
        description: "A 描述",
        recordingSource: "manual",
        threadId: "thread-a",
        workspacePath: resolve("/tmp/workspace-a")
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
