import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { localizeCaptureAssets, capturePublicUrl } from "./capture-assets"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true })
})
async function directory() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "capture-assets-"))
  directories.push(value)
  return value
}

describe("captured design resources", () => {
  it("saves recursive CSS, inline styles, fonts and images with local references and deduplication", async () => {
    const output = await directory()
    const responses: Record<string, [string, string]> = {
      "https://site.test/css/main.css": [
        '@import "sub/other.css";body{background:url(../image.svg)}',
        "text/css"
      ],
      "https://site.test/css/sub/other.css": [
        "@font-face{font-family:test;src:url(../../font.woff2)}.title{color:red}",
        "text/css"
      ],
      "https://site.test/font.woff2": ["font-content", "font/woff2"],
      "https://site.test/image.svg": [
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        "image/svg+xml"
      ]
    }
    const fetch = vi.fn(
      async (url: string) =>
        new Response(responses[url]?.[0], {
          status: responses[url] ? 200 : 404,
          headers: { "content-type": responses[url]?.[1] || "text/plain" }
        })
    )
    const result = await localizeCaptureAssets({
      directory: output,
      pageUrl: "https://site.test/page",
      signal: new AbortController().signal,
      fetch,
      html: '<html><head><link rel="stylesheet" href="/css/main.css"></head><body style="background:url(/image.svg)"><img src="/image.svg"></body></html>'
    })
    expect(result.warnings).toEqual([])
    expect(result.resources).toHaveLength(4)
    expect(result.html).not.toContain("https://")
    expect(result.html).toContain("assets/")
    const css = (
      await Promise.all(
        (await fs.readdir(path.join(output, "assets")))
          .filter((file) => file.endsWith(".css"))
          .map((file) => fs.readFile(path.join(output, "assets", file), "utf8"))
      )
    ).join("\n")
    expect(css).not.toMatch(/\.\.\/|https?:/)
    expect(css).toContain(".woff2")
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[0]?.[0]).toBe("https://site.test/css/main.css")
  })

  it("fails for missing critical styles but allows a missing image with an explicit warning", async () => {
    const common = {
      directory: await directory(),
      pageUrl: "https://site.test/",
      signal: new AbortController().signal,
      fetch: async () => new Response("missing", { status: 404 })
    }
    await expect(
      localizeCaptureAssets({
        ...common,
        html: '<link rel="stylesheet" href="/private.css?token=secret">'
      })
    ).rejects.toThrow("关键样式")
    const result = await localizeCaptureAssets({
      ...common,
      html: '<img src="/missing?token=secret">'
    })
    expect(result.warnings[0].code).toBe("resource_missing")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(result.html).toContain("data:image/svg+xml")
  })

  it("bounds streamed resources, handles CSS cycles and observes cancellation", async () => {
    const common = {
      directory: await directory(),
      pageUrl: "https://site.test/",
      signal: new AbortController().signal
    }
    const bounded = await localizeCaptureAssets({
      ...common,
      html: '<img src="large">',
      limits: { perFile: 4 },
      fetch: async () =>
        new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } })
    })
    expect(bounded.warnings[0].code).toBe("resource_missing")
    const cycle = await localizeCaptureAssets({
      ...common,
      html: '<link rel="stylesheet" href="/a.css">',
      fetch: async () =>
        new Response('@import url("/a.css");p{color:red}', {
          headers: { "content-type": "text/css" }
        })
    })
    expect(cycle.warnings[0].code).toBe("css_cycle")
    const controller = new AbortController()
    controller.abort(new Error("cancel"))
    await expect(
      localizeCaptureAssets({
        ...common,
        signal: controller.signal,
        html: '<img src="image">',
        fetch: vi.fn()
      })
    ).rejects.toThrow("cancel")
  })

  it("removes credentials, query strings and fragments from persisted source URLs", () => {
    expect(capturePublicUrl("https://name:password@site.test/page?token=secret#key")).toBe(
      "https://site.test/page"
    )
  })
})
