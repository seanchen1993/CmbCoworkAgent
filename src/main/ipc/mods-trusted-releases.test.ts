import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import type { TrustedReleaseDelivery, TrustedReleaseReview } from "../mods/devtools/trusted-release-delivery"
import { registerTrustedReleaseHandlers } from "./mods-trusted-releases"

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }))
vi.mock("electron", () => ({ dialog: { showMessageBox } }))

const ref = { publisherId: "publisher", listingId: "listing", releaseId: "release" }
const packageSha256 = "a".repeat(64)
const review: TrustedReleaseReview = {
  release: { ...ref, package: {
    packageSha256, sourceDigest: "b".repeat(64), compiledDigest: "c".repeat(64), files: []
  } },
  name: "example", version: "1.0", description: ""
}

function fixture(available = true) {
  const endpoint = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const owner = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  const commit = vi.fn()
  const install = vi.fn(async (_input, scope, confirm) => {
    scope.assertCurrent()
    if (!await confirm(review)) return null
    scope.assertCurrent()
    return commit()
  })
  registerTrustedReleaseHandlers({
    handle: (name, handler) => { endpoint.set(name, handler) }
  } as IpcMain, { available, install } as unknown as TrustedReleaseDelivery, () => owner, e => {
    if (e.senderFrame !== e.sender.mainFrame) throw Error("UNTRUSTED")
  })
  return { sender, event, endpoint, commit, install }
}

it("requires the trusted renderer and a configured authority", async () => {
  const { event, endpoint, install } = fixture(false)
  const available = endpoint.get("mods:trusted-release:available")!
  expect(available(event, undefined)).toBe(false)
  expect(() => available({ ...event, senderFrame: {} } as typeof event, undefined)).toThrow("UNTRUSTED")
  await expect(endpoint.get("mods:trusted-release:install")!(event, ref))
    .rejects.toThrow("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
  expect(install).not.toHaveBeenCalled()
})

it("shows verified release identity and cancels a pending commit on document navigation", async () => {
  const { event, sender, endpoint, commit } = fixture()
  showMessageBox.mockImplementationOnce(async (_owner, options) => {
    expect(options.detail).toContain("发布者 publisher")
    expect(options.detail).toContain(packageSha256)
    sender.emit("did-start-navigation")
    return { response: 1 }
  })
  await expect(endpoint.get("mods:trusted-release:install")!(event, ref))
    .rejects.toThrow("TRUSTED_RELEASE_WINDOW_CHANGED")
  expect(commit).not.toHaveBeenCalled()
  expect(sender.listenerCount("did-start-navigation")).toBe(0)
})
