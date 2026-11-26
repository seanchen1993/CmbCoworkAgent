import { describe, expect, it, vi } from "vitest"
import type { QueuedMessage } from "../types"
import type { ChatImageSubmissionStatus } from "../../../shared/file-attachment"
import { claimImageComposer, imageComposerSource, imageQueuePresentation, ownsParkedImageComposer, parkImageOutbox, runFrozenImageOutbox } from "./image-outbox"

const ref = { id: "4b48c1c3-066f-43cf-af84-b4050459db25", filename: "chart.png", slot: 0 }
const composer = { draftInput: "请分析图表", draftAttachments: [{
  filename: ref.filename, filePath: "", content: "", size: 12, mimeType: "image/webp", truncated: false,
  image: { id: ref.id, filename: ref.filename, height: 3, width: 3 }
}], draftMentionedWorkspaceFiles: [], draftSkill: null, draftBuiltinBrowser: false }
const source = imageComposerSource(composer)
const frozen = { message: "请分析图表\n<attachment chart>", mode: "normal" as const, modelId: "selected-model" }
const entry: QueuedMessage = {
  id: "1880a326-a5f0-4869-a8cc-89ec9fee814b", text: composer.draftInput, chatImages: [ref],
  created_at: new Date(1), updated_at: new Date(1),
  imageDelivery: { source, workspacePath: "/work", incarnation: "uuid:original", frozen }
}

describe("ordinary image outbox", () => {
  it("writes the full recovery record before pin; Enter while the pin is delayed cannot park the same composer again", async () => {
    const release = claimImageComposer("thread", "/work", source)!
    const queue: QueuedMessage[] = []
    let finishPin!: () => void
    const consume = vi.fn()
    const parked = parkImageOutbox({ persist: () => { queue.push(structuredClone(entry)); return null },
      pin: () => new Promise<void>(resolve => { finishPin = resolve }), isCurrent: () => true,
      rollback: () => { queue.pop() }, unpin: async () => {}, consume })
    expect(queue).toEqual([entry])
    expect(consume).not.toHaveBeenCalled()
    expect(claimImageComposer("thread", "/work", source)).toBeUndefined()
    expect(ownsParkedImageComposer(composer, queue, "/work", "uuid:original")).toBe(true)
    expect(ownsParkedImageComposer({ ...composer, draftInput: "new text" }, queue, "/work", "uuid:original")).toBe(false)
    expect(ownsParkedImageComposer(composer, queue, "/work", "uuid:new")).toBe(false)
    finishPin()
    expect(await parked).toBe(true)
    expect(consume).toHaveBeenCalledTimes(1)
    release()
    const newClaim = claimImageComposer("thread", "/work", source)
    expect(newClaim).toBeTypeOf("function")
    newClaim?.()
  })

  it("leaves the composer editable when storage fails or the draft changes during pin", async () => {
    const operations = { persist: () => "storage full", pin: vi.fn(async () => {}),
      rollback: vi.fn(), unpin: vi.fn(async () => {}), isCurrent: () => false, consume: vi.fn() }
    await expect(parkImageOutbox(operations)).rejects.toThrow("storage full")
    expect(operations.pin).not.toHaveBeenCalled()
    expect(await parkImageOutbox({ ...operations, persist: () => null })).toBe(false)
    expect(operations.unpin).toHaveBeenCalledOnce()
    expect(operations.rollback).toHaveBeenCalledOnce()
    expect(operations.consume).not.toHaveBeenCalled()
  })

  it("presents an idle image as sending and reserves the queue label for a waiting draft", () => {
    const immediate = { ...entry, imageDelivery: { ...entry.imageDelivery!, immediate: true as const } }
    expect(imageQueuePresentation(immediate, undefined, true)).toBe("preparing")
    expect(imageQueuePresentation(immediate, "submitted", false)).toBe("sending")
    expect(imageQueuePresentation(immediate, "accepted", false)).toBe("hidden")
    expect(imageQueuePresentation(entry, undefined, false)).toBe("queued")
    expect(imageQueuePresentation(immediate, undefined, false)).toBe("queued")
    expect(imageQueuePresentation(entry, "preparing", true)).toBe("preparing")
  })

  it("does not hand off an image removed while submission status is being read", async () => {
    let resolveStatus!: (status: ChatImageSubmissionStatus) => void
    const send = vi.fn(), finish = vi.fn()
    let present = true
    const submission = runFrozenImageOutbox(entry, {
      status: () => new Promise(resolve => { resolveStatus = resolve }),
      canSend: () => present,
      send,
      finish
    })
    present = false
    resolveStatus("missing")
    expect(await submission).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
  })

  it("recovers a lost ACK from the persisted outcome and never sends a completed request again", async () => {
    let state: ChatImageSubmissionStatus = "missing"
    const finish = vi.fn(), send = vi.fn(async () => {
      state = "succeeded"
      throw new Error("renderer lost the acknowledgement")
    })
    const operations = { status: async () => state, send, finish }
    expect(await runFrozenImageOutbox(entry, operations)).toBe("succeeded")
    expect(send).toHaveBeenCalledWith(frozen, entry.id)
    expect(finish).toHaveBeenCalledWith(false)
    await runFrozenImageOutbox(JSON.parse(JSON.stringify(entry)), operations)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("continues to reconcile a known running receipt after the submitting stream is lost", async () => {
    const status = vi.fn<() => Promise<ChatImageSubmissionStatus>>()
      .mockResolvedValueOnce("missing")
      .mockResolvedValueOnce("running")
      .mockResolvedValueOnce("awaiting")
      .mockResolvedValueOnce("cancelled")
    const send = vi.fn().mockRejectedValue(new Error("stream disconnected"))
    const finish = vi.fn()
    const operations = { status, send, finish }
    expect(await runFrozenImageOutbox(entry, operations)).toBe("running")
    expect(await runFrozenImageOutbox(entry, operations)).toBe("awaiting")
    expect(await runFrozenImageOutbox(entry, operations)).toBe("cancelled")
    expect(send).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("reopens a cold accepted request with exactly the parked model, text, mode and id; uncertain work stays parked", async () => {
    let state: ChatImageSubmissionStatus = "accepted"
    const send = vi.fn(async () => { state = "running" })
    const finish = vi.fn()
    const operations = { status: async () => state, send, finish }
    const recovered: QueuedMessage = JSON.parse(JSON.stringify(entry))
    expect(await runFrozenImageOutbox(recovered, operations)).toBe("running")
    expect(send).toHaveBeenCalledWith(frozen, entry.id)
    for (const savedState of ["running", "pending", "unknown", "rejected"] as const) {
      state = savedState
      expect(await runFrozenImageOutbox(recovered, operations)).toBe(state)
    }
    expect(send).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalled()
  })
})
