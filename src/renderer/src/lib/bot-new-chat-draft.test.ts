import { expect, it, vi } from "vitest"
import {
  adoptNewChatDraft,
  botDraftIsBlank,
  patchNewChatText,
  newChatSessionCurrent,
  type BotNewChatWorkspaceState,
  type NewChatLocalSession
} from "./bot-new-chat-draft"
import { readStoredBotDraft } from "./bot-draft-storage"
import { composerDocumentChange } from "./bot-composer-document"
const revision = "11111111-1111-4111-8111-111111111111"
const nextRevision = "22222222-2222-4222-8222-222222222222"
function fixture() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null }
  const session: NewChatLocalSession = {
    openNonce: "ui",
    hostId: "host",
    dataEpoch: "epoch",
    originViewId: "origin",
    originViewportGeneration: 1,
    revision,
    draft: { prompt: "local input", attachments: [], revision },
    files: [],
    phase: "editing"
  }
  const drafts: BotNewChatWorkspaceState["drafts"] = {}
  const updateDraft = vi.fn((id, changes) => {
    drafts[id] = { prompt: "", attachments: [], ...changes, revision: nextRevision }
  })
  const state = {
    host: { hostId: "host" },
    snapshot: { dataEpoch: "epoch", conversations: [{ id: "origin" }] },
    selected: "origin",
    viewportLease: { viewId: "origin", generation: 1 },
    drafts,
    pending: {},
    sending: {},
    uploading: {},
    updateDraft,
    readDraft: (id) => drafts[id]
  } as unknown as BotNewChatWorkspaceState
  return { session, state, values, storage, updateDraft }
}
it("adopts only text and rich text into a blank real target and returns its actual new revision", () => {
  const f = fixture(),
    result = adoptNewChatDraft(f.session, f.state, "actual-target", f.storage)
  expect(result).toEqual({
    kind: "adopted",
    receipt: {
      openNonce: "ui",
      sourceRevision: revision,
      hostId: "host",
      dataEpoch: "epoch",
      targetViewId: "actual-target",
      targetDraftRevision: nextRevision
    }
  })
  expect(f.updateDraft).toHaveBeenCalledExactlyOnceWith("actual-target", {
    prompt: "local input",
    richText: undefined
  })
  expect(Object.keys(f.state.drafts)).toEqual(["actual-target"])
})
it.each(["prompt", "replyToId", "isFork", "skills", "references", "recipients", "attachments"])(
  "preserves a target with %s even when it exists only in storage",
  (key) => {
    const f = fixture()
    const nonblank = {
      prompt: "",
      attachments: [],
      revision,
      [key]:
        key === "isFork"
          ? true
          : ["skills", "references", "recipients", "attachments"].includes(key)
            ? key === "attachments"
              ? [{ path: "artifact", name: "a", size: 1 }]
              : key === "recipients"
                ? ["bot"]
                : key === "skills"
                  ? [{ id: "skill", botId: "bot", name: "Skill", version: 1 }]
                  : [{ kind: "bot", id: "bot", name: "Bot" }]
            : "saved"
    }
    f.values.set("bot-draft:target", JSON.stringify({ ...nonblank, dataEpoch: "epoch" }))
    expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
    expect(f.updateDraft).not.toHaveBeenCalled()
    expect(f.values.get("bot-draft:target")).toBe(
      JSON.stringify({ ...nonblank, dataEpoch: "epoch" })
    )
    expect(f.session.draft.prompt).toBe("local input")
  }
)
it("preserves valid or malformed pending and memory/storage conflicts", () => {
  const f = fixture()
  const raw = JSON.stringify({
    conversationId: "target",
    nonce: "nonce",
    text: "pending",
    dataEpoch: "epoch"
  })
  f.values.set("bot-pending:target", raw)
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  expect(f.values.get("bot-pending:target")).toBe(raw)
  f.values.set("bot-pending:target", "{invalid")
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  f.values.delete("bot-pending:target")
  f.state.drafts.target = { prompt: "", attachments: [], revision }
  f.values.set(
    "bot-draft:target",
    JSON.stringify({ prompt: "", attachments: [], revision: nextRevision, dataEpoch: "epoch" })
  )
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  expect(f.updateDraft).not.toHaveBeenCalled()
})
it.each(["sending", "uploading"])("cannot overwrite an active %s target", (key) => {
  const f = fixture()
  f.state[key].target = true
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  expect(f.updateDraft).not.toHaveBeenCalled()
})
it("fails closed on unavailable storage or a changed raw value in the final synchronous check", () => {
  const f = fixture()
  expect(
    adoptNewChatDraft(f.session, f.state, "target", {
      getItem: () => {
        throw new Error("denied")
      }
    }).kind
  ).toBe("blocked")
  let reads = 0
  const storage = {
    getItem: (key: string) =>
      key.startsWith("bot-draft:") && ++reads === 2
        ? JSON.stringify({ prompt: "changed", attachments: [], dataEpoch: "epoch" })
        : null
  }
  expect(adoptNewChatDraft(f.session, f.state, "target", storage).kind).toBe("blocked")
  expect(f.updateDraft).not.toHaveBeenCalled()
})
it("host, data restore, and navigation retire the exact local owner", () => {
  const f = fixture()
  expect(newChatSessionCurrent(f.session, f.state)).toBe(true)
  f.state.host = { ...f.state.host!, hostId: "new-host" }
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("retired")
  f.state.host.hostId = "host"
  f.state.viewportLease!.generation = 2
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("retired")
  expect(f.updateDraft).not.toHaveBeenCalled()
})
it("the shared stored parser preserves the original pending address and removes only its envelope fields", () => {
  const f = fixture()
  f.values.set(
    "bot-pending:target",
    JSON.stringify({
      conversationId: "target",
      nonce: "nonce",
      text: "pending",
      dataEpoch: "epoch",
      draftRevision: revision
    })
  )
  expect(readStoredBotDraft("target", "epoch", f.storage)).toMatchObject({
    pending: { conversationId: "target", nonce: "nonce", text: "pending" },
    pendingDraftRevision: revision,
    malformed: false
  })
  expect(
    readStoredBotDraft("foreign", "epoch", { getItem: () => f.values.get("bot-pending:target")! })
      .malformed
  ).toBe(true)
})
it("semantic rich text and non-text draft state are never silently treated as blank", () => {
  expect(botDraftIsBlank({ prompt: "", attachments: [] })).toBe(true)
  expect(
    botDraftIsBlank({
      prompt: "",
      attachments: [],
      richText: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "rich only" }] }]
      })
    })
  ).toBe(false)
})

it("copied typed reference JSON cannot be adopted as a local message identity", () => {
  const f = fixture()
  f.session.draft.richText = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "botReference",
            attrs: { reference: { kind: "bot", id: "private-bot", name: "Private" } }
          }
        ]
      }
    ]
  })
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  expect(f.updateDraft).not.toHaveBeenCalled()
})

it("clearing rich text retires the old editor document rather than restoring it on adoption", () => {
  const f = fixture()
  f.session.draft = {
    ...f.session.draft,
    richText: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "old content" }] }]
    })
  }
  const previous = f.session.draft
  expect(patchNewChatText(previous, { prompt: "new text" }).richText).toBe(previous.richText)
  f.session.draft = patchNewChatText(previous, { prompt: "", richText: undefined })
  expect(f.session.draft.richText).toBeUndefined()
  expect(botDraftIsBlank(f.session.draft)).toBe(true)
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("adopted")
  expect(f.state.drafts.target.prompt).toBe("")
  expect(f.state.drafts.target.richText).toBeUndefined()
  expect(previous.richText).toContain("old content")
})
it("malformed rich text on a real target is preserved rather than treated as empty", () => {
  const f = fixture()
  f.state.drafts.target = { prompt: "", attachments: [], richText: "{broken", revision }
  expect(botDraftIsBlank(f.state.drafts.target)).toBe(false)
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  expect(f.updateDraft).not.toHaveBeenCalled()
  expect(f.state.drafts.target.richText).toBe("{broken")
})

it("adopts the original Store-shaped empty draft after the canonical parser reorders fields", () => {
  const f = fixture()
  const blank = { prompt: "", attachments: [] }
  const changes = composerDocumentChange({ type: "doc", content: [{ type: "paragraph" }] }, blank)
  expect(changes).not.toBeNull()
  // The actual Store.updateDraft merges blank + editor changes, then appends revision.
  const live = { ...blank, ...changes, revision }
  f.state.drafts.target = live
  f.values.set("bot-draft:target", JSON.stringify({ ...live, dataEpoch: "epoch" }))
  const stored = readStoredBotDraft("target", "epoch", f.storage).draft!
  expect(JSON.stringify(live)).not.toBe(JSON.stringify(stored))
  expect(live.revision).toBe(stored.revision)
  expect(botDraftIsBlank(live)).toBe(true)
  expect(botDraftIsBlank(stored)).toBe(true)
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("adopted")
  expect(f.updateDraft).toHaveBeenCalledExactlyOnceWith("target", {
    prompt: "local input",
    richText: undefined
  })
  expect(f.state.drafts.target.revision).toBe(nextRevision)
})
it("canonical comparison still rejects a different real revision or nonempty canonical draft", () => {
  const f = fixture()
  const changes = composerDocumentChange(
    { type: "doc", content: [{ type: "paragraph" }] },
    { prompt: "", attachments: [] }
  )!
  const live = { prompt: "", attachments: [], ...changes, revision }
  f.state.drafts.target = live
  f.values.set(
    "bot-draft:target",
    JSON.stringify({ ...live, revision: nextRevision, dataEpoch: "epoch" })
  )
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  f.values.set(
    "bot-draft:target",
    JSON.stringify({ ...live, prompt: "preserve target", dataEpoch: "epoch" })
  )
  expect(adoptNewChatDraft(f.session, f.state, "target", f.storage).kind).toBe("blocked")
  expect(f.updateDraft).not.toHaveBeenCalled()
  expect(f.session.draft.prompt).toBe("local input")
  expect(f.state.drafts.target).toBe(live)
})
