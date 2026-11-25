import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stageWorkspaceChatImage } from "./workspace-chat-image"

const { thread, owner, stage } = vi.hoisted(() => ({
  thread: vi.fn(), owner: vi.fn(), stage: vi.fn()
}))
vi.mock("./db", () => ({ getThreadCore: thread }))
vi.mock("./bots/conversation-link-authority", () => ({ findBotWorkThreadOwner: owner }))
vi.mock("./chat-images", () => ({ stageChatImage: stage }))

describe("ordinary workspace image attachment", () => {
  let root: string
  const request = () => ({ threadId: "thread", workspacePath: root, filePath: "/chart.png" })
  const sender = vi.fn()
  beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), "chat-workspace-"))
    await writeFile(join(root, "chart.png"), Buffer.from([2, 3, 4]))
    thread.mockReturnValue({ created_at: 1, metadata: JSON.stringify({ workspacePath: root }) })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it("reads the authorized handle once and stages it in the original thread", async () => {
    stage.mockImplementation((_thread, _name, bytes: ArrayBuffer, guard) => {
      expect([...new Uint8Array(bytes)]).toEqual([2, 3, 4])
      guard.beforePublish()
      return { image: { id: "staged" } }
    })
    await expect(stageWorkspaceChatImage(request(), sender)).resolves.toEqual({ image: { id: "staged" } })
    expect(stage).toHaveBeenCalledWith("thread", "chart.png", expect.any(ArrayBuffer), expect.any(Object))
  })

  it("requires the current root and rejects paths beyond it", async () => {
    await expect(stageWorkspaceChatImage({ ...request(), workspacePath: tmpdir() }, sender)).rejects.toThrow()
    await expect(stageWorkspaceChatImage({ ...request(), filePath: "../other.png" }, sender)).rejects.toThrow()
    expect(stage).not.toHaveBeenCalled()
  })

  it("rejects Bot metadata, linked Bot tasks and source changes during decoding", async () => {
    thread.mockReturnValueOnce({ created_at: 1, metadata: JSON.stringify({ workspacePath: root, botId: "bot" }) })
    await expect(stageWorkspaceChatImage(request(), sender)).rejects.toThrow()
    owner.mockReturnValueOnce({ id: "work" })
    await expect(stageWorkspaceChatImage(request(), sender)).rejects.toThrow()
    expect(stage).not.toHaveBeenCalled()
    stage.mockImplementation((_thread, _name, _bytes, guard) => {
      thread.mockReturnValue({ created_at: 2, metadata: JSON.stringify({ workspacePath: root }) })
      guard.beforePublish()
    })
    await expect(stageWorkspaceChatImage(request(), sender)).rejects.toThrow("会话已变更")
  })
})
