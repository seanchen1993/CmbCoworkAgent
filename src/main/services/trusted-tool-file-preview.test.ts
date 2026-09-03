import path from "node:path"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  externalFileReadGrantCountForTests,
  resolveExternalFileReadGrant
} from "./external-file-read-tokens"
import { LocalSandbox } from "../agent/local-sandbox"
import {
  authorizeTrustedToolFilePreview,
  clearTrustedToolFilePreviewSourcesForTests,
  clearTrustedToolFilePreviewSourcesForThread,
  issueTrustedToolFilePreviewGrant,
  recordTrustedToolFilePreviewSource,
  resolveTrustedToolFilePreviewSource,
  runWithTrustedToolFilePreviewContext
} from "./trusted-tool-file-preview"

afterEach(() => {
  clearTrustedToolFilePreviewSourcesForTests()
})

describe("trusted tool file preview sources", () => {
  it("records the resolved path under the executing tool call", () => {
    const filePath = path.resolve("outside", "report.md")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-1", toolName: "write_file" },
      () => recordTrustedToolFilePreviewSource(filePath, "write")
    )

    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-1")).toMatchObject({
      threadId: "thread-1",
      toolCallId: "call-1",
      toolName: "write_file",
      operation: "write",
      filePath
    })
  })

  it("does not accept a path outside a matching file-tool execution context", () => {
    const filePath = path.resolve("outside", "report.md")
    recordTrustedToolFilePreviewSource(filePath, "write")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-1", toolName: "read_file" },
      () => recordTrustedToolFilePreviewSource(filePath, "write")
    )

    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-1")).toBeNull()
  })

  it("rejects ambiguous reused tool-call ids instead of guessing a path", () => {
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-1", toolName: "read_file" },
      () => {
        recordTrustedToolFilePreviewSource(path.resolve("outside", "one.md"), "read")
        recordTrustedToolFilePreviewSource(path.resolve("outside", "two.md"), "read")
      }
    )

    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-1")).toBeNull()
  })

  it("rejects a late source from a tool context invalidated by thread deletion", () => {
    const stalePath = path.resolve("outside", "stale.md")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-stale", toolName: "write_file" },
      () => {
        clearTrustedToolFilePreviewSourcesForThread("thread-1")
        recordTrustedToolFilePreviewSource(stalePath, "write")
      }
    )

    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-stale")).toBeNull()

    const freshPath = path.resolve("outside", "fresh.md")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-fresh", toolName: "write_file" },
      () => recordTrustedToolFilePreviewSource(freshPath, "write")
    )
    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-fresh")).toMatchObject({
      filePath: freshPath
    })
  })

  it("issues a sender-bound grant for only the recorded file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cmb-tool-preview-"))
    try {
      const filePath = path.join(root, "report.md")
      const otherPath = path.join(root, "other.md")
      await Promise.all([
        writeFile(filePath, "report", "utf8"),
        writeFile(otherPath, "other", "utf8")
      ])
      runWithTrustedToolFilePreviewContext(
        { threadId: "thread-1", toolCallId: "call-1", toolName: "read_file" },
        () => recordTrustedToolFilePreviewSource(filePath, "read")
      )

      const issued = issueTrustedToolFilePreviewGrant("thread-1", "call-1", 7)
      expect(issued.success).toBe(true)
      if (!issued.success) return
      await expect(resolveExternalFileReadGrant(issued.grant, 7, filePath)).resolves.toMatchObject({
        filePath
      })
      await expect(resolveExternalFileReadGrant(issued.grant, 7, otherPath)).resolves.toEqual({
        error: "Access denied: file was not issued by the trusted preview source"
      })
      await expect(resolveExternalFileReadGrant(issued.grant, 8, filePath)).resolves.toEqual({
        error: "Sender mismatch"
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns the authoritative path without issuing a grant for a workspace file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cmb-tool-preview-internal-"))
    try {
      const filePath = path.join(root, "report.md")
      await writeFile(filePath, "report", "utf8")
      runWithTrustedToolFilePreviewContext(
        { threadId: "thread-1", toolCallId: "call-1", toolName: "read_file" },
        () => recordTrustedToolFilePreviewSource(filePath, "read")
      )

      const grantCountBefore = externalFileReadGrantCountForTests()
      expect(authorizeTrustedToolFilePreview("thread-1", "call-1", 7, root)).toEqual({
        success: true,
        external: false,
        filePath
      })
      expect(externalFileReadGrantCountForTests()).toBe(grantCountBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("revokes an issued grant when its thread is cleared", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cmb-tool-preview-revoke-"))
    try {
      const filePath = path.join(root, "report.md")
      await writeFile(filePath, "report", "utf8")
      runWithTrustedToolFilePreviewContext(
        { threadId: "thread-1", toolCallId: "call-1", toolName: "read_file" },
        () => recordTrustedToolFilePreviewSource(filePath, "read")
      )
      const issued = issueTrustedToolFilePreviewGrant("thread-1", "call-1", 7)
      expect(issued.success).toBe(true)
      if (!issued.success) return

      clearTrustedToolFilePreviewSourcesForThread("thread-1")

      await expect(resolveExternalFileReadGrant(issued.grant, 7, filePath)).resolves.toEqual({
        error: "Invalid or expired grant"
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("captures the actual path reached by LocalSandbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cmb-tool-preview-sandbox-"))
    try {
      const workspace = path.join(root, "workspace")
      await mkdir(workspace, { recursive: true })
      const sandbox = new LocalSandbox({ rootDir: workspace, runId: "thread-1" })

      await runWithTrustedToolFilePreviewContext(
        { threadId: "thread-1", toolCallId: "call-1", toolName: "write_file" },
        () => sandbox.write("report.md", "report")
      )

      expect(resolveTrustedToolFilePreviewSource("thread-1", "call-1")).toMatchObject({
        filePath: path.join(workspace, "report.md"),
        operation: "write"
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not trust a LocalSandbox read that finishes with an invalid offset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cmb-tool-preview-read-error-"))
    try {
      const filePath = path.join(root, "report.md")
      await writeFile(filePath, "one line", "utf8")
      const sandbox = new LocalSandbox({ rootDir: root, runId: "thread-1" })

      const result = await runWithTrustedToolFilePreviewContext(
        { threadId: "thread-1", toolCallId: "call-read-error", toolName: "read_file" },
        () => sandbox.read("report.md", 10, 1)
      )

      expect(result).toContain("exceeds file length")
      expect(resolveTrustedToolFilePreviewSource("thread-1", "call-read-error")).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
