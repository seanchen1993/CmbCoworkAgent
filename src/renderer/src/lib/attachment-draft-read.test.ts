import { describe, expect, it, vi } from "vitest"
import { readForCurrentAttachmentDraft } from "./attachment-draft-read"

describe("ordinary attachment draft owner", () => {
  it("discards late browser bytes before parsing and refuses already stale pickers", async () => {
    let owner = true
    let finish!: (value: string) => void
    const fileRead = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const parse = vi.fn()
    const reading = readForCurrentAttachmentDraft(() => owner, fileRead)
    owner = false
    finish("previous draft")
    expect(await reading).toBeUndefined()
    expect(await readForCurrentAttachmentDraft(() => owner, parse)).toBeUndefined()
    expect(parse).not.toHaveBeenCalled()
  })
})
