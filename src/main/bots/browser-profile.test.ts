import { describe, expect, it, vi } from "vitest"
import type { Cookie } from "electron"
import { syncBotBrowserProfile } from "./browser-profile"

function fixture() {
  let listener: (() => Promise<void>) | undefined
  const cookies: Cookie[] = [
    {
      name: "auth",
      value: "synthetic",
      domain: "example.test",
      path: "/app",
      secure: true,
      httpOnly: true,
      session: true,
      sameSite: "no_restriction"
    }
  ]
  const source = {
    enabled: vi.fn(() => true),
    prepare: vi.fn(async () => {}),
    read: vi.fn(async () => cookies),
    subscribe: vi.fn((next: () => Promise<void>) => {
      listener = next
      return () => {
        listener = undefined
      }
    })
  }
  const context = {
    addCookies: vi.fn<(cookies: readonly unknown[]) => Promise<void>>(async () => {})
  }
  return { source, context, cookies, emit: () => listener?.() }
}

describe("Bot browser login import", () => {
  it("does nothing without the existing import opt-in", async () => {
    const f = fixture()
    f.source.enabled.mockReturnValue(false)
    await syncBotBrowserProfile(f.context, f.source)
    expect(f.source.prepare).not.toHaveBeenCalled()
    expect(f.source.read).not.toHaveBeenCalled()
    expect(f.context.addCookies).not.toHaveBeenCalled()
  })

  it("imports before first navigation and reflects manual re-import without replacing pages", async () => {
    const f = fixture()
    const dispose = await syncBotBrowserProfile(f.context, f.source)
    expect(f.source.prepare).toHaveBeenCalledOnce()
    expect(f.context.addCookies).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "auth",
        domain: "example.test",
        path: "/app",
        httpOnly: true,
        expires: -1,
        sameSite: "None"
      })
    ])
    f.cookies[0].value = "new-synthetic"
    await f.emit()
    expect(f.context.addCookies).toHaveBeenLastCalledWith([
      expect.objectContaining({ value: "new-synthetic" })
    ])
    dispose()
    await f.emit()
    expect(f.context.addCookies).toHaveBeenCalledTimes(2)
  })

  it("bounds batches and skips expired or partitioned cookies", async () => {
    const f = fixture()
    f.cookies.push(
      ...Array.from({ length: 201 }, (_, i) => ({ ...f.cookies[0], name: `cookie-${i}` }))
    )
    f.cookies.push({ ...f.cookies[0], name: "expired", expirationDate: 1 })
    f.cookies.push({ ...f.cookies[0], name: "partitioned", partitionKey: {} } as Cookie)
    const dispose = await syncBotBrowserProfile(f.context, f.source)
    expect(f.context.addCookies.mock.calls.map(([cookies]) => cookies.length)).toEqual([
      100, 100, 2
    ])
    dispose()
  })

  it("coalesces concurrent refreshes and can recover after a failed import", async () => {
    const f = fixture()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    f.context.addCookies.mockRejectedValueOnce(new Error("synthetic secret must not be logged"))
    const dispose = await syncBotBrowserProfile(f.context, f.source)
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic secret")
    let finish!: () => void
    f.context.addCookies.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const first = f.emit()
    await vi.waitFor(() => expect(finish).toBeDefined())
    const second = f.emit()
    const third = f.emit()
    finish()
    await Promise.all([first, second, third])
    expect(f.context.addCookies).toHaveBeenCalledTimes(3)
    dispose()
    warn.mockRestore()
  })
})
