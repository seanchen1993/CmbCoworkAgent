import { expect, it, vi } from "vitest"

const probe = vi.hoisted(() => ({
  send: vi.fn(),
  read: vi.fn(),
  destroyed: false
}))
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => probe.destroyed,
        webContents: { isDestroyed: () => false, send: probe.send }
      }
    ]
  }
}))
vi.mock("../db", () => ({ getThreadRuntimeScope: probe.read }))

import { notifyRemoteThreadChanged } from "./renderer-stream-mirror"

const row = {
  created_at: 1,
  metadata: JSON.stringify({ workspacePath: "/workspace", cmb_thread_incarnation: "original" })
}

it("sends only an actual native row scope for a remote transcript change", () => {
  probe.send.mockClear()
  probe.read.mockReturnValue(row)
  notifyRemoteThreadChanged("thread", "transcript")
  expect(probe.send).toHaveBeenCalledExactlyOnceWith("threads:changed", {
    threadId: "thread",
    kind: "transcript",
    workspacePath: "/workspace",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  })
})

it("retains the committed original row across later native same-ID replacement", () => {
  probe.send.mockClear()
  probe.read.mockReturnValue({
    created_at: 1,
    metadata: JSON.stringify({ workspacePath: "/other", cmb_thread_incarnation: "replacement" })
  })
  notifyRemoteThreadChanged("thread", "metadata", row)
  expect(probe.send).toHaveBeenCalledExactlyOnceWith("threads:changed", {
    threadId: "thread",
    kind: "metadata",
    workspacePath: "/workspace",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  })
})

it("keeps unknown scope conservative and does not send to destroyed windows", () => {
  probe.send.mockClear()
  probe.read.mockReturnValue(undefined)
  notifyRemoteThreadChanged("missing", "transcript")
  expect(probe.send).toHaveBeenCalledExactlyOnceWith("threads:changed", undefined)
  probe.send.mockClear()
  probe.destroyed = true
  try {
    notifyRemoteThreadChanged("thread", "metadata", row)
    expect(probe.send).not.toHaveBeenCalled()
  } finally {
    probe.destroyed = false
  }
})
