import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const models = readFileSync(new URL("./models.ts", import.meta.url), "utf8")
const preload = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8")
const chat = readFileSync(
  new URL("../../renderer/src/components/chat/ChatContainer.tsx", import.meta.url),
  "utf8"
)

describe("workspace file read boundary", () => {
  it("removes unbounded raw text and base64 workspace IPC channels", () => {
    for (const channel of ["workspace:readFile", "workspace:readBinaryFile"]) {
      expect(models).not.toContain(channel)
      expect(preload).not.toContain(channel)
    }
  })

  it("routes @file through the cancellable bounded preview worker only once at send", () => {
    expect(chat).not.toContain("window.api.workspace.readFile(")
    expect(chat).not.toContain("window.api.workspace.readBinaryFile(")
    expect(chat).toContain("readBoundedWorkspaceMentionFile({")
    expect(chat).toContain("window.api.workspace.readFilePreview({")
    expect(chat).toContain("cancelAtFileReads")
  })
})
