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
  it.skipIf(process.platform === "win32")(
    "preserves a selected workspace alias while rejecting an escaped artifact directory",
    async () => {
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
      await fs.symlink(
        request.workspacePath,
        path.join(escape.request.workspacePath, ".cmb-design")
      )
      expect((await escape.service.run(2, escape.request, vi.fn())).error).toContain("符号链接")
    }
  )
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

  it("prepares an editable copy with its resources and retains it after acceptance", async () => {
    const { service, request } = await fixture()
    const captured = await service.run(1, request, vi.fn())
    const source = path.dirname(captured.artifactPath!)
    await fs.mkdir(path.join(source, "assets"))
    await fs.writeFile(path.join(source, "assets", "page.css"), "h1 { color: red }")
    const prepared = await service.prepareForEditing(1, request.requestId, "ds_1234abcd")
    expect(prepared.success, prepared.error).toBe(true)
    expect(prepared.artifactPath).toBe(
      path.join(request.workspacePath, ".cmb-design", "ds_1234abcd_design-main", "index.html")
    )
    expect(await fs.readFile(prepared.artifactPath!, "utf8")).toBe(captured.html)
    expect(
      await fs.readFile(
        path.join(path.dirname(prepared.artifactPath!), "assets", "page.css"),
        "utf8"
      )
    ).toContain("color: red")
    expect(await service.finish(1, request.requestId, true)).toBe(true)
    await expect(fs.stat(source)).rejects.toThrow()
    expect((await fs.stat(prepared.artifactPath!)).isFile()).toBe(true)
  })

  it("rejects another window, invalid session IDs and replacing an existing design", async () => {
    const { service, request } = await fixture()
    await service.run(1, request, vi.fn())
    expect((await service.prepareForEditing(2, request.requestId, "ds_1234abcd")).success).toBe(
      false
    )
    expect((await service.prepareForEditing(1, request.requestId, "../escape")).success).toBe(false)
    const existing = path.join(request.workspacePath, ".cmb-design", "ds_1234abcd_design-main")
    await fs.mkdir(existing)
    await fs.writeFile(path.join(existing, "index.html"), "existing design")
    expect((await service.prepareForEditing(1, request.requestId, "ds_1234abcd")).success).toBe(
      false
    )
    await service.finish(1, request.requestId, false)
    expect(await fs.readFile(path.join(existing, "index.html"), "utf8")).toBe("existing design")
  })

  it("removes both the capture and editable copy when preparation is cancelled", async () => {
    const { service, request } = await fixture()
    const captured = await service.run(1, request, vi.fn())
    const prepared = await service.prepareForEditing(1, request.requestId, "ds_1234abcd")
    expect(prepared.success, prepared.error).toBe(true)
    expect((await service.prepareForEditing(1, request.requestId, "ds_5678abcd")).success).toBe(
      false
    )
    await service.finish(1, request.requestId, false)
    await expect(fs.stat(captured.artifactPath!)).rejects.toThrow()
    await expect(fs.stat(prepared.artifactPath!)).rejects.toThrow()
  })

  it("cannot accept or resurrect an editing copy cancelled during resource copying", async () => {
    const { service, request } = await fixture()
    await service.run(1, request, vi.fn())
    let release!: () => void
    let started!: () => void
    const copying = new Promise<void>((resolve) => {
      started = resolve
    })
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const copy = fs.cp.bind(fs)
    const spy = vi.spyOn(fs, "cp").mockImplementationOnce(async (source, target, options) => {
      started()
      await paused
      return copy(source, target, options)
    })
    try {
      const preparing = service.prepareForEditing(1, request.requestId, "ds_1234abcd")
      await copying
      expect(await service.finish(1, request.requestId, true)).toBe(false)
      await service.finish(1, request.requestId, false)
      release()
      expect((await preparing).success).toBe(false)
      expect(await fs.readdir(path.join(request.workspacePath, ".cmb-design"))).toEqual([])
    } finally {
      release()
      spy.mockRestore()
    }
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
