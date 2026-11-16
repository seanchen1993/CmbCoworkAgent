import { describe, expect, it, vi } from "vitest"
import { DesignPreviewResources } from "./design-preview-resources"

describe("prepared design resource lifetime", () => {
  it("shares one resource, releases it, and prevents late reads from registering new URLs", async () => {
    const owner = new DesignPreviewResources()
    const revoke = vi.spyOn(URL, "revokeObjectURL")
    try {
      const read = vi.fn(async () => "data:image/svg+xml,%3Csvg/%3E")
      const urls = await Promise.all(
        Array.from({ length: 100 }, () => owner.resolve("shared", read))
      )
      expect(read).toHaveBeenCalledTimes(1)
      expect(new Set(urls).size).toBe(1)
      expect(await (await fetch(urls[0]!)).text()).toBe("<svg/>")
      let finish!: (value: string) => void
      const late = owner.resolve(
        "late",
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      owner.dispose()
      finish("data:image/svg+xml,%3Csvg/%3E")
      await expect(late).rejects.toThrow("取消")
      expect(revoke).toHaveBeenCalledExactlyOnceWith(urls[0])
      await expect(fetch(urls[0]!)).rejects.toThrow()
      await expect(owner.resolve("new", read)).rejects.toThrow("取消")
    } finally {
      owner.dispose()
      revoke.mockRestore()
    }
  })
  it("bounds the aggregate document tree before mounting it", () => {
    const owner = new DesignPreviewResources()
    owner.checkDocument("x".repeat(8 * 1024 * 1024))
    expect(() => owner.checkDocument("x".repeat(8 * 1024 * 1024))).toThrow("15MB")
    owner.dispose()
  })
})
