import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import type { BrowserConsoleEntry } from "../../shared/browser-types"

import {
  appendBrowserConsoleEntry,
  getUrlPermissionError,
  normalizeUrlInput
} from "./browser-service"

describe("browser file path guards", () => {
  it("normalizes Windows absolute paths into file URLs", () => {
    expect(normalizeUrlInput("D:\\repo\\app\\index.html", null)).toBe(
      "file:///D:/repo/app/index.html"
    )
  })

  it("normalizes relative workspace files into file URLs", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cmb-browser-url-"))
    const htmlPath = join(workspaceRoot, "pages", "index.html")
    mkdirSync(join(workspaceRoot, "pages"), { recursive: true })
    writeFileSync(htmlPath, "<h1>ok</h1>")
    expect(normalizeUrlInput("pages/index.html", workspaceRoot)).toBe(
      `file://${htmlPath.replace(/\\/g, "/")}`
    )
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it("normalizes slash-prefixed workspace files into file URLs when no absolute file exists", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cmb-browser-url-root-"))
    const htmlPath = join(workspaceRoot, "pages", "index.html")
    mkdirSync(join(workspaceRoot, "pages"), { recursive: true })
    writeFileSync(htmlPath, "<h1>ok</h1>")
    expect(normalizeUrlInput("/pages/index.html", workspaceRoot)).toBe(
      `file://${htmlPath.replace(/\\/g, "/")}`
    )
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it("allows file URLs regardless of workspace binding", () => {
    expect(getUrlPermissionError("file:///D:/repo/app/index.html", "D:\\repo\\app")).toBeNull()
    expect(getUrlPermissionError("file:///D:/repo/other/index.html", "D:\\repo\\app")).toBeNull()
    expect(getUrlPermissionError("file:///D:/repo/app/index.html", null)).toBeNull()
  })

  it("still blocks unsupported protocols", () => {
    expect(getUrlPermissionError("ftp://example.com/file.txt", null)).toBe(
      "不允许加载 ftp: 协议"
    )
  })

  it("keeps only the newest console entries within the cap", () => {
    let entries: BrowserConsoleEntry[] = []
    for (let index = 0; index < 205; index += 1) {
      entries = appendBrowserConsoleEntry(entries, {
        id: `entry-${index}`,
        timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
        level: "info",
        message: `message-${index}`
      })
    }
    expect(entries).toHaveLength(200)
    expect(entries[0]?.id).toBe("entry-5")
    expect(entries[199]?.id).toBe("entry-204")
  })
})
