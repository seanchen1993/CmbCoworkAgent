import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileUploadTool } from "./browser-file-upload-tool"
import type { BotRuntimeRequest } from "./host"
import type { LocalBotComputerProvider } from "./computer-provider"
import { readBotBrowserUploadCard } from "../../shared/bot-browser-upload"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import type { BotWorkflowChildInput } from "./workflow-children"
import { BotDomainError } from "../../shared/bot-types"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const bytes = Buffer.from("\ufeffid,amount\r\nA,12.30\r\n", "utf8")
async function fixture(
  mode: "visible" | "own" | "foreign" | "group" | "unselected" | "branch" = "visible"
) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-upload-original-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const files = new BotArtifacts(directory, store)
  cleanup.push(() => files.close())
  await files.recover()
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  const other = ["foreign", "group"].includes(mode)
    ? store.createBot({ nonce: "other", name: "Other" })
    : undefined
  const group =
    mode === "group"
      ? store.createGroup({
          nonce: "group",
          name: "Separate discussion",
          members: [bot.id, other!.bot.id]
        })
      : undefined
  const original = await files.publish(
    {
      id: "original",
      conversationId: group?.id ?? other?.conversationId ?? conversationId,
      runId: null,
      name: "original.csv",
      mime: "text/csv",
      origin: "upload"
    },
    bytes
  )
  let rootId: string | undefined
  if (mode === "branch") {
    const root = store.send({ nonce: "root", conversationId, text: "A private branch" })
    const claimed = store.claim("host", 300000)!
    store.finish(claimed.lease, "succeeded", "done")
    rootId = root.messageId
    store.send({
      nonce: "branch",
      conversationId,
      threadRootId: rootId,
      text: "Private original",
      attachments: [original.id]
    })
    const child = store.claim("host", 300000)!
    store.finish(child.lease, "succeeded", "done")
  }
  store.send({
    nonce: "start",
    conversationId,
    text: "Upload original",
    attachments: mode === "visible" ? [original.id] : []
  })
  const active = store.claim("host", 300000)!
  const request: BotRuntimeRequest = {
    ...active,
    bot,
    store,
    messages: store.messagesForRun(active.run.id),
    signal: new AbortController().signal
  }
  let selected = original
  if (mode === "own")
    selected = await files.publish(
      { id: "own-result", conversationId, runId: active.run.id, name: "own.csv", mime: "text/csv" },
      bytes,
      active.lease
    )
  const check = () => {
    request.signal.throwIfAborted()
    store.assertDispatch(active.lease)
  }
  const target = {
    botId: bot.id,
    generation: "one",
    controlEpoch: 0,
    control: "bot" as const,
    viewId: "view"
  }
  const review = {
    destination: {
      origin: "https://upload.test",
      url: "https://upload.test/form",
      title: "Upload",
      field: "Actual input",
      accept: ".csv",
      multiple: true,
      formAction: "https://upload.test/submit",
      formMethod: "get"
    },
    context: {
      targetPageUrl: "https://upload.test/form",
      displayStateIdentity: "document",
      elements: [{ tag: "input", id: "file", type: "file" }],
      manualReason: null,
      navigationEpoch: 1,
      fileInput: { accept: ".csv", multiple: true, directory: false }
    },
    dispose: vi.fn(async () => {})
  }
  const dispatchedBytes: Buffer[] = []
  const broker = {
    ensure: vi.fn(async () => target),
    prepareUpload: vi.fn(async () => review),
    assertUpload: vi.fn(async (_target: unknown, _review: unknown, authorize: () => void) => {
      authorize()
    }),
    performUpload: vi.fn(
      async (
        _target: unknown,
        _review: unknown,
        loadFiles: () => Promise<{ metadata: unknown; bytes: Buffer }[]>,
        authorize: () => void
      ) => {
        authorize()
        const payloads = await loadFiles()
        for (const item of payloads) dispatchedBytes.push(Buffer.from(item.bytes))
        payloads.length = 0
        return { status: "files_selected", serverAcceptance: "unverified" }
      }
    )
  }
  const state: {
    beforeApproval?: () => Promise<void>
    deny?: boolean
    throwAfterDispatch?: boolean
  } = {}
  const approve = vi.fn(
    async (
      id: string,
      action: unknown,
      operation: () => Promise<string>,
      beforeStart?: () => Promise<void | string>
    ) => {
      const approval = store.requestInteraction(active.lease, {
        kind: "approval",
        action,
        prompt: JSON.stringify(action)
      })
      await state.beforeApproval?.()
      store.answerInteraction({
        id: approval.id,
        revision: approval.revision,
        answer: state.deny ? "reject" : "approve"
      })
      if (state.deny) return "denied"
      const skipped = await beforeStart?.()
      if (skipped) return skipped
      store.beginEffect(active.lease, { id, action, approvalId: approval.id })
      try {
        const result = await operation()
        if (state.throwAfterDispatch) throw new Error("lost acknowledgement")
        store.settleEffect(active.lease, id, "succeeded", result)
        return result
      } catch (error) {
        store.settleEffect(active.lease, id, "unknown", "unconfirmed")
        throw error
      }
    }
  )
  const tool = botBrowserFileUploadTool({
    request,
    files,
    computer: { get: async () => broker } as unknown as LocalBotComputerProvider,
    check,
    approve
  })
  const invoke = (
    args = { ref: "e1", file_ids: [selected.id], purpose: "Upload the selected original" },
    id = "upload"
  ) => tool.invoke({ type: "tool_call", name: "upload_file", id, args })
  return {
    directory,
    dispatchedBytes,
    store,
    files,
    request,
    original: selected,
    broker,
    review,
    approve,
    state,
    invoke
  }
}
it.each(["visible", "own"] as const)(
  "uploads %s immutable original only after approval and reuses successful receipt",
  async (mode) => {
    const f = await fixture(mode),
      read = vi.spyOn(f.files, "read")
    f.state.beforeApproval = async () => {
      expect(read).not.toHaveBeenCalled()
    }
    await f.invoke()
    const action = f.approve.mock.calls[0][1]
    expect(action).toMatchObject({ browserReview: f.review.context })
    expect(readBotBrowserUploadCard(JSON.stringify(action))).toMatchObject({
      files: [{ id: f.original.id, sha256: f.original.sha256, size: bytes.length }],
      destination: f.review.destination
    })
    expect(f.dispatchedBytes).toEqual([bytes])
    await f.invoke()
    expect(f.broker.performUpload).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(f.review.dispose).toHaveBeenCalledTimes(1)
  }
)
it.each(["foreign", "group", "unselected", "branch"] as const)(
  "refuses %s IDs before object read, target lookup or approval",
  async (mode) => {
    const f = await fixture(mode),
      read = vi.spyOn(f.files, "read")
    await expect(f.invoke()).rejects.toMatchObject({ code: "artifact_scope" })
    expect(read).not.toHaveBeenCalled()
    expect(f.approve).not.toHaveBeenCalled()
    expect(f.broker.ensure).not.toHaveBeenCalled()
  }
)
it("keeps refusal side-effect free and releases the held DOM review", async () => {
  const f = await fixture(),
    read = vi.spyOn(f.files, "read")
  f.state.deny = true
  expect(String((await f.invoke()).content)).toBe("denied")
  expect(read).not.toHaveBeenCalled()
  expect(f.broker.performUpload).not.toHaveBeenCalled()
  expect(f.review.dispose).toHaveBeenCalledTimes(1)
})
it("retains Store protection against deleting an original used by a live task", async () => {
  const f = await fixture(),
    read = vi.spyOn(f.files, "read")
  f.state.beforeApproval = async () => {
    f.store.deleteArtifact({
      nonce: "delete",
      conversationId: f.request.run.conversationId,
      id: f.original.id,
      sha256: f.original.sha256
    })
  }
  await expect(f.invoke()).rejects.toMatchObject({ code: "artifact_in_use" })
  expect(read).not.toHaveBeenCalled()
  expect(f.broker.performUpload).not.toHaveBeenCalled()
})
it("rechecks task-visible authority after approval before reading bytes", async () => {
  const f = await fixture(),
    read = vi.spyOn(f.files, "read")
  f.state.beforeApproval = async () => {
    vi.spyOn(f.store, "artifactForRun").mockImplementation(() => {
      throw new BotDomainError("artifact_scope", "controlled authority change")
    })
  }
  await expect(f.invoke()).rejects.toMatchObject({ code: "artifact_scope" })
  expect(read).not.toHaveBeenCalled()
  expect(f.broker.performUpload).not.toHaveBeenCalled()
})
it("rejects corrupt object bytes after approval before website dispatch", async () => {
  const f = await fixture()
  await writeFile(join(f.directory, f.original.sha256), Buffer.from("wrong"))
  await expect(f.invoke()).rejects.toMatchObject({ code: "artifact_corrupt" })
  expect(f.dispatchedBytes).toEqual([])
})
it("preserves unknown effect and never repeats even after an acknowledged file selection", async () => {
  const f = await fixture()
  f.state.throwAfterDispatch = true
  await expect(f.invoke()).rejects.toThrow("lost acknowledgement")
  await expect(f.invoke()).rejects.toMatchObject({ code: "effect_requires_review" })
  expect(f.store.effects(f.request.run.id)).toMatchObject([{ status: "unknown" }])
  expect(f.broker.performUpload).toHaveBeenCalledTimes(1)
})
it("stops a changed review before reading bytes or beginning the effect", async () => {
  const f = await fixture(),
    read = vi.spyOn(f.files, "read")
  f.broker.assertUpload.mockRejectedValueOnce(
    new BotDomainError("browser_upload_changed", "changed")
  )
  expect(String((await f.invoke()).content)).toContain("文件尚未选择")
  expect(read).not.toHaveBeenCalled()
  expect(f.store.effects(f.request.run.id)).toEqual([])
})
it("allows only scoped browser children and honors browser/read_file denials", () => {
  const input = {
    browserAccess: "page",
    shellAccess: "none",
    disallowedTools: []
  } as unknown as BotWorkflowChildInput
  expect(botWorkflowChildAllows(input, "upload_file")).toBe(true)
  for (const denied of ["browser", "read_file", "upload_file"])
    expect(botWorkflowChildAllows({ ...input, disallowedTools: [denied] }, "upload_file")).toBe(
      false
    )
  expect(botWorkflowChildAllows({ ...input, browserAccess: undefined }, "upload_file")).toBe(false)
  expect(botWorkflowChildAllows({ ...input, desktopAccess: "shared-native" }, "upload_file")).toBe(
    false
  )
})
