import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DesignUrlImportService } from "./url-import-service"
import type { CaptureAssetOptions } from "./capture-assets"
import type { DesignImportProgress, DesignImportRequest } from "../../../shared/design-url-import"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true })
})
async function fixture(restrictedReason?: string) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "capture-service-"))
  directories.push(workspacePath)
  const dispose = vi.fn(),
    assertCurrent = vi.fn()
  const dependencies = {
    capture: vi.fn(async () => ({
      snapshot: {
        html: "<html><body><p>captured</p></body></html>",
        title: "Target",
        url: "https://site.test/private?token=secret",
        textLength: 8,
        warnings: [],
        restrictedReason
      },
      screenshot: Buffer.from("png"),
      warnings: [],
      readBlob: async () => null,
      assertCurrent,
      dispose
    })),
    localize: vi.fn(async (input: CaptureAssetOptions) => ({
      html: input.html,
      warnings: [],
      resources: []
    })),
    validate: vi.fn(async () => {}),
    fetch: vi.fn()
  }
  const request: DesignImportRequest = {
    requestId: "capture-test",
    source: "url",
    url: "https://site.test/private",
    workspacePath
  }
  return { service: new DesignUrlImportService(dependencies), dependencies, request, dispose }
}

describe("design URL import lifecycle", () => {
  it.skipIf(process.platform === "win32")("preserves a selected workspace alias while rejecting an escaped artifact directory", async () => {
    const { service, request } = await fixture()
    const aliases = await fs.mkdtemp(path.join(os.tmpdir(), "capture-alias-"))
    directories.push(aliases)
    const alias = path.join(aliases, "workspace")
    await fs.symlink(request.workspacePath, alias)
    const result = await service.run(1, { ...request, workspacePath: alias }, vi.fn())
    expect(result.success).toBe(true)
    expect(result.artifactPath).toMatch(new RegExp(`^${alias}`))
    await service.finish(1, request.requestId, true)
    const escape = await fixture()
    await fs.symlink(request.workspacePath, path.join(escape.request.workspacePath, ".cmb-design"))
    expect((await escape.service.run(2, escape.request, vi.fn())).error).toContain("符号链接")
  })
  it("commits a complete package and transfers ownership only after the renderer accepts it", async () => {
    const { service, request, dispose } = await fixture()
    const progress: DesignImportProgress[] = []
    const result = await service.run(1, request, (event) => progress.push(event))
    expect(result.success).toBe(true)
    expect(result.finalUrl).toBe("https://site.test/private")
    expect(await fs.readFile(result.artifactPath!, "utf8")).toContain("data-design-capture-runtime")
    expect(
      await fs.readFile(
        path.join(path.dirname(result.artifactPath!), "capture-manifest.json"),
        "utf8"
      )
    ).not.toContain("secret")
    expect(await service.finish(2, request.requestId, false)).toBe(false)
    expect(await service.finish(1, request.requestId, true)).toBe(true)
    expect(service.cancel(1, request.requestId)).toBe(false)
    expect(progress.at(-1)?.stage).toBe("completed")
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("requests user action and releases the capture browser without saving a login page", async () => {
    const { service, request, dispose, dependencies } = await fixture("需要登录")
    const result = await service.run(1, request, vi.fn())
    expect(result.status).toBe("needs_user_action")
    expect(result.screenshotDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(dependencies.localize).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(await fs.readdir(request.workspacePath)).toEqual([])
  })

  it("cleans staged files after failure and ignores cancellation by another window", async () => {
    const { service, request, dispose, dependencies } = await fixture()
    dependencies.validate.mockImplementation(async () => {
      expect(service.cancel(2, request.requestId)).toBe(false)
      expect(service.cancel(1, request.requestId)).toBe(true)
    })
    const result = await service.run(1, request, vi.fn())
    expect(result.status).toBe("cancelled")
    expect(await fs.readdir(path.join(request.workspacePath, ".cmb-design"))).toEqual([])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("removes an unaccepted result and never accepts duplicate task IDs", async () => {
    const { service, request } = await fixture()
    const first = await service.run(1, request, vi.fn())
    expect((await service.run(2, request, vi.fn())).success).toBe(false)
    expect(await service.finish(1, request.requestId, false)).toBe(true)
    await expect(fs.stat(first.artifactPath!)).rejects.toThrow()
  })
})
