import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureMessageImageHistory, captureOrdinaryImageDraft, stageWorkspaceChatImage } from "./workspace-chat-image"

const { thread, owner, stage } = vi.hoisted(() => ({
  thread: vi.fn(), owner: vi.fn(), stage: vi.fn()
}))
vi.mock("./db", () => ({ getThreadCore: thread }))
vi.mock("./bots/conversation-link-authority", async importOriginal => ({
  ...await importOriginal<typeof import("./bots/conversation-link-authority")>(), findBotWorkThreadOwner: owner
}))
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

  it("keeps the original sent image readable across desktop linking and isolates drafts and stale work", () => {
    const metadata = { workspacePath: root, cmb_thread_incarnation: "image-thread" }
    const originalRow = { created_at: 1, metadata: JSON.stringify(metadata) }
    thread.mockReturnValue(originalRow)
    const before = captureMessageImageHistory("thread", root, sender)
    const work = { id: "work", botId: "bot", threadId: "thread", audienceKey: "desktop",
      conversation: { state: "bound", origin: "existing",
        ref: { kind: "local_thread", threadId: "thread", incarnation: { token: "image-thread", legacyCreatedAt: 1 } } } }
    const bound = { ...metadata, botId: "bot", botWorkId: work.id, botHostId: "local",
      botAudienceKey: "desktop", botLocalConversation: true, botWorkOrigin: "existing" }
    thread.mockReturnValue({ created_at: 1, metadata: JSON.stringify(bound) })
    owner.mockReturnValue(work)
    const during = captureMessageImageHistory("thread", root, sender)
    expect(during.assertCurrent().created_at).toBe(1)
    expect(() => before.assertCurrent()).toThrow()
    expect(() => captureOrdinaryImageDraft("thread", root, sender)).toThrow()
    for (const patch of [{ source: { transport: "im" } }, { audienceKey: "im:group" },
      { conversation: { ...work.conversation, state: "detaching" } }]) {
      owner.mockReturnValueOnce({ ...work, ...patch })
      expect(() => during.assertCurrent()).toThrow()
    }
    thread.mockReturnValueOnce({ created_at: 1, metadata: JSON.stringify({ ...bound, botGroupId: "group" }) })
    expect(() => during.assertCurrent()).toThrow()
    thread.mockReturnValue(originalRow)
    owner.mockReturnValue(null)
    expect(() => during.assertCurrent()).toThrow()
    expect(captureMessageImageHistory("thread", root, sender).assertCurrent()).toBe(originalRow)
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
