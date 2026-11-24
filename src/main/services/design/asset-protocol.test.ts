import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } } }
}))

import { DESIGN_ASSET_RUNTIME_PATH, DESIGN_ASSET_SCHEME } from "../../../shared/design-package"
import {
  DesignAssetRegistry,
  handleDesignAssetProtocolRequest,
  preparePreviewEntryHtml
} from "./asset-protocol"

const tempDirs: string[] = []
function makeTempDir(prefix = "cmb-asset-proto-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("design-asset protocol", () => {
  it("isolates tokens in lowercase, checks navigation authorization, and releases packages on revoke", () => {
    const registry = new DesignAssetRegistry()
    const released: string[] = []
    registry.setOnPackageReleased((root) => released.push(root))

    const root = makeTempDir()
    const ticket = registry.issue({
      ownerId: 10,
      sessionId: "ds_1",
      kind: "canvas",
      packageRoot: root,
      entryPath: "pages/home.html",
      revision: 2,
      getEntryHtml: () => "<!DOCTYPE html><html><body>Hi</body></html>"
    })

    expect(ticket.token).toBe(ticket.token.toLowerCase())
    expect(ticket.url).toBe(`${DESIGN_ASSET_SCHEME}://${ticket.token}/pages/home.html`)
    expect(registry.isPackageInUse(root)).toBe(true)

    expect(registry.isAuthorizedEntryNavigation(ticket.url, 10)).toBe(true)
    expect(registry.isAuthorizedEntryNavigation(ticket.url, 99)).toBe(false)
    expect(
      registry.isAuthorizedEntryNavigation(`${ticket.origin}/images/logo.png`, 10)
    ).toBe(false)

    expect(registry.revoke(ticket.token.toUpperCase())).toBe(true)
    expect(registry.isPackageInUse(root)).toBe(false)
    expect(released).toEqual([path.resolve(root)])
  })

  it("prepares entry HTML safely for both full documents and fragments", () => {
    const origin = `${DESIGN_ASSET_SCHEME}://tok123`
    const full = preparePreviewEntryHtml(
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><base href="file:///etc/"><base href="https://example.com/app/"></head><body><h1>Hello</h1></body></html>`,
      {
        kind: "canvas",
        previewInstanceId: "inst-1",
        revision: 3,
        origin
      }
    )
    expect(full).not.toContain("Content-Security-Policy")
    expect(full).not.toContain("file:///etc/")
    expect(full).toContain('href="https://example.com/app/"')
    expect(full).toContain(`src="${origin}/${DESIGN_ASSET_RUNTIME_PATH}"`)
    expect(full).toContain('data-design-preview-instance="inst-1"')
    expect(full).toContain("data-design-node=")

    const fragment = preparePreviewEntryHtml(
      `<div onclick="evil()"><a href="javascript:bad()">x</a><script>alert(1)</script><script type="application/design-tweaks+json">{}</script></div>`,
      {
        kind: "draft",
        previewInstanceId: "inst-frag",
        revision: 4,
        origin,
        draft: { runId: "r1", revision: 4 }
      }
    )
    expect(fragment).toContain('data-design-preview-instance="inst-frag"')
    expect(fragment).toContain('data-design-preview-draft="1"')
    expect(fragment).not.toContain("onclick")
    expect(fragment).not.toContain("javascript:")
    expect(fragment).not.toContain("alert(1)")
    expect(fragment).toContain("application/design-tweaks+json")
    expect(fragment).toContain(`src="${origin}/${DESIGN_ASSET_RUNTIME_PATH}"`)
  })

  it("serves runtime script, streams assets with Range 206/416, and blocks traversal/symlinks", async () => {
    const root = makeTempDir()
    const outside = makeTempDir("cmb-outside-")
    const outsideFile = path.join(outside, "secret.txt")
    fs.writeFileSync(outsideFile, "TOP_SECRET", "utf8")

    fs.mkdirSync(path.join(root, "pages"), { recursive: true })
    fs.mkdirSync(path.join(root, "assets"), { recursive: true })
    fs.writeFileSync(path.join(root, "assets", "data.bin"), Buffer.from("0123456789ABCDEF"))
    fs.writeFileSync(path.join(root, "assets", "样式.css"), "body { color: red; }", "utf8")
    try {
      fs.symlinkSync(outsideFile, path.join(root, "assets", "link.txt"))
    } catch {
      // Skip symlink test creation if OS disallows symlinks.
    }

    const registry = new DesignAssetRegistry()
    const ticket = registry.issue({
      ownerId: 1,
      sessionId: "ds_stream",
      kind: "canvas",
      packageRoot: root,
      entryPath: "pages/home.html",
      revision: 1,
      getEntryHtml: () => "<!DOCTYPE html><html><head></head><body>OK</body></html>"
    })

    const runtimeRes = await handleDesignAssetProtocolRequest(
      new Request(`${ticket.origin}/${DESIGN_ASSET_RUNTIME_PATH}`),
      registry
    )
    expect(runtimeRes.status).toBe(200)
    const runtimeJs = await runtimeRes.text()
    expect(runtimeJs).toContain("__cmbCanvasInstalled")
    expect(() => new Function(runtimeJs)).not.toThrow()

    const cssRes = await handleDesignAssetProtocolRequest(
      new Request(`${ticket.origin}/assets/${encodeURIComponent("样式.css")}`),
      registry
    )
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get("content-type")).toContain("text/css")
    expect(await cssRes.text()).toBe("body { color: red; }")

    const partial = await handleDesignAssetProtocolRequest(
      new Request(`${ticket.origin}/assets/data.bin`, {
        headers: { range: "bytes=4-9" }
      }),
      registry
    )
    expect(partial.status).toBe(206)
    expect(partial.headers.get("content-range")).toBe("bytes 4-9/16")
    expect(await partial.text()).toBe("456789")

    const invalidRange = await handleDesignAssetProtocolRequest(
      new Request(`${ticket.origin}/assets/data.bin`, {
        headers: { range: "bytes=999-1000" }
      }),
      registry
    )
    expect(invalidRange.status).toBe(416)

    const traversal = await handleDesignAssetProtocolRequest(
      new Request(`${ticket.origin}/%2e%2e/secret.txt`),
      registry
    )
    expect(traversal.status).toBe(404)

    if (fs.existsSync(path.join(root, "assets", "link.txt"))) {
      const symRes = await handleDesignAssetProtocolRequest(
        new Request(`${ticket.origin}/assets/link.txt`),
        registry
      )
      expect(symRes.status).toBe(404)
    }

    registry.revoke(ticket.token)
    const gone = await handleDesignAssetProtocolRequest(new Request(ticket.url), registry)
    expect(gone.status).toBe(410)
  })
})
