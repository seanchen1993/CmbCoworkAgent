import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EXTERNAL_FILE_READ_GRANT_TTL_MS,
  externalFileReadGrantCountForTests,
  issueExternalFileReadGrant,
  resolveExternalFileReadGrant,
  revokeExternalFileReadGrantsForOwner
} from "./external-file-read-tokens"
import { WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES } from "../../shared/workspace-file-preview"
import { readPreviewTextPage } from "../workspace-file-preview/reader"

const tempDirectories: string[] = []

async function createTrustedRoot(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "cmb-external-preview-grant-"))
  tempDirectories.push(root)
  const file = path.join(root, "report.txt")
  await writeFile(file, "trusted preview")
  return { root, file }
}

afterEach(async () => {
  revokeExternalFileReadGrantsForOwner(1)
  revokeExternalFileReadGrantsForOwner(2)
  vi.useRealTimers()
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("external file read grants", () => {
  it("resolves descendants of a main-issued root and remains reusable for paging", async () => {
    const { root, file } = await createTrustedRoot()
    const issued = issueExternalFileReadGrant(root, 1, ["report.txt"], "test-preview")
    expect("grant" in issued).toBe(true)
    const grant = "grant" in issued ? issued.grant : ""

    await expect(resolveExternalFileReadGrant(grant, 1, "report.txt")).resolves.toEqual({
      filePath: await realpath(file),
      rootPath: await realpath(root)
    })
    await expect(resolveExternalFileReadGrant(grant, 1, file)).resolves.toHaveProperty(
      "filePath"
    )
  })

  it("is sender-bound without letting another sender invalidate the grant", async () => {
    const { root } = await createTrustedRoot()
    const issued = issueExternalFileReadGrant(root, 1, ["report.txt"], "test-preview")
    const grant = "grant" in issued ? issued.grant : ""

    await expect(resolveExternalFileReadGrant(grant, 2, "report.txt")).resolves.toEqual({
      error: "Sender mismatch"
    })
    await expect(resolveExternalFileReadGrant(grant, 1, "report.txt")).resolves.toHaveProperty(
      "filePath"
    )
  })

  it("rejects traversal and arbitrary absolute paths outside the trusted root", async () => {
    const first = await createTrustedRoot()
    const second = await createTrustedRoot()
    await writeFile(path.join(first.root, "not-issued.txt"), "not in the trusted result")
    const issued = issueExternalFileReadGrant(first.root, 1, ["report.txt"], "test-preview")
    const grant = "grant" in issued ? issued.grant : ""

    await expect(resolveExternalFileReadGrant(grant, 1, "../secret.txt")).resolves.toEqual({
      error: "Access denied: path outside trusted preview root"
    })
    await expect(resolveExternalFileReadGrant(grant, 1, second.file)).resolves.toEqual({
      error: "Access denied: path outside trusted preview root"
    })
    await expect(resolveExternalFileReadGrant(grant, 1, "not-issued.txt")).resolves.toEqual({
      error: "Access denied: file was not issued by the trusted preview source"
    })
  })

  it("refuses a protected root before issuing any capability", async () => {
    const { root } = await createTrustedRoot()
    expect(
      issueExternalFileReadGrant(path.join(root, ".ssh"), 1, ["id_rsa"], "test-preview")
    ).toEqual({
      error: "Access denied: path is protected"
    })
    expect(externalFileReadGrantCountForTests()).toBe(0)
  })

  it("expires grants and rejects replay after the TTL", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"))
    const { root } = await createTrustedRoot()
    const issued = issueExternalFileReadGrant(root, 1, ["report.txt"], "test-preview")
    const grant = "grant" in issued ? issued.grant : ""
    vi.advanceTimersByTime(EXTERNAL_FILE_READ_GRANT_TTL_MS + 1)

    await expect(resolveExternalFileReadGrant(grant, 1, "report.txt")).resolves.toEqual({
      error: "Grant expired"
    })
  })

  it("deduplicates repeated grants for the same trusted root and owner", async () => {
    const { root } = await createTrustedRoot()
    const first = issueExternalFileReadGrant(root, 1, ["report.txt"], "test-preview")
    const second = issueExternalFileReadGrant(root, 1, ["report.txt"], "test-preview")
    expect(first).toEqual(second)
    expect(externalFileReadGrantCountForTests()).toBe(1)
  })

  it("keeps picker and knowledge scopes isolated even when they share a directory", async () => {
    const { root } = await createTrustedRoot()
    await writeFile(path.join(root, "picked.txt"), "picked")
    const knowledge = issueExternalFileReadGrant(
      root,
      1,
      ["report.txt"],
      "harness-knowledge:test"
    )
    const picker = issueExternalFileReadGrant(
      root,
      1,
      ["picked.txt"],
      "attachment-picker:test"
    )
    const knowledgeGrant = "grant" in knowledge ? knowledge.grant : ""
    const pickerGrant = "grant" in picker ? picker.grant : ""
    expect(knowledgeGrant).not.toBe(pickerGrant)
    await expect(
      resolveExternalFileReadGrant(knowledgeGrant, 1, "report.txt")
    ).resolves.toHaveProperty("filePath")
    await expect(
      resolveExternalFileReadGrant(pickerGrant, 1, "picked.txt")
    ).resolves.toHaveProperty("filePath")
  })

  it("keeps an authorized normal preview within the worker page-size budget", async () => {
    const { root, file } = await createTrustedRoot()
    await writeFile(file, "bounded line\n".repeat(10_000))
    const issued = issueExternalFileReadGrant(root, 1, ["report.txt"], "test-preview")
    const grant = "grant" in issued ? issued.grant : ""
    const resolved = await resolveExternalFileReadGrant(grant, 1, "report.txt")
    expect("filePath" in resolved).toBe(true)
    if (!("filePath" in resolved)) return

    const cancellation = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    )
    const page = await readPreviewTextPage(
      { externalFullPath: resolved.filePath, trustedRootPath: resolved.rootPath },
      undefined,
      0,
      cancellation
    )
    expect(page.result.contentBytes).toBeLessThanOrEqual(
      WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES
    )
    expect(page.result.hasMore).toBe(true)
  })
})
