import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { avatarImage } from "./image-fixtures"
import { botBrowserFileReceiver } from "./browser-files"
import { botDeliverFileInput, botDeliverFileTool } from "./deliver-file-tool"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifact } from "../../shared/bot-types"

// Same real Store/object/receiver fixture as browser-files.test.ts and
// artifact-publication-lifecycle.test.ts. No model, browser process or Host fake.
const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-deliver-original-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const files = new BotArtifacts(directory, store)
  cleanup.push(() => files.close())
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "File owner" })
  await files.recover()
  return { directory, store, files, bot, conversationId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function start(f: Fixture, attachments: string[] = [], nonce = "task") {
  const sent = f.store.send({
    nonce,
    conversationId: f.conversationId,
    text: "Deliver the original file",
    attachments
  })
  const claimed = f.store.claim("host", 300_000)!
  expect(claimed.run.id).toBe(sent.runIds[0])
  const request: BotRuntimeRequest = {
    ...claimed,
    bot: f.bot,
    store: f.store,
    signal: new AbortController().signal,
    messages: f.store.messagesForRun(claimed.run.id)
  }
  const tool = botDeliverFileTool(request, f.files, () => f.store.assertDispatch(request.lease))
  return { ...claimed, request, tool, sent }
}
type Active = ReturnType<typeof start>
async function invoke(a: Active, args: Record<string, unknown>, id: string) {
  // Original LangChain tool-call shape, as used by profile-tools.test.ts.
  const value = await a.tool.invoke({ type: "tool_call", name: "deliver_file", id, args })
  return JSON.parse(String(value.content)) as BotArtifact
}
const ORIGINAL = Buffer.from("\ufeffrecord_id,amount_yuan\r\nREC-A,12.30\r\nREC-B,7.40\r\n", "utf8")
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
async function download(f: Fixture, active?: Active, threadRootId?: string) {
  const guid = randomUUID()
  const receiver = botBrowserFileReceiver({
    store: f.store,
    files: f.files,
    botId: f.bot.id,
    conversationId: f.conversationId,
    ...(active ? { lease: active.lease, check: () => f.store.assertDispatch(active.lease) } : {}),
    ...(threadRootId ? { threadRootId } : {})
  })
  receiver.started?.(guid)
  await receiver.complete({ guid, bytes: ORIGINAL, suggestedName: "original.csv" }, () => {})
  return f.store.getArtifact(`browser-download:${guid}`)
}
const links = (f: Fixture, runId: string, id: string) =>
  f.store.messages(f.conversationId).filter((m) => m.runId === runId && m.attachments.includes(id))

it("returns the exact browser original with BOM/CRLF/SHA preserved and creates no second attachment/object", async () => {
  const f = await fixture(),
    a = start(f),
    original = await download(f, a)
  expect(original.origin).toBe("browser")
  expect(original.sha256).toBe(sha(ORIGINAL))
  const objects = await readdir(f.directory),
    messages = f.store.messages(f.conversationId)
  const publish = vi.spyOn(f.files, "publish"),
    read = vi.spyOn(f.files, "read")
  expect(await invoke(a, { file_id: original.id }, "return-original")).toEqual(original)
  expect(publish).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(f.store.artifacts(f.conversationId)).toEqual([original])
  expect(f.store.messages(f.conversationId)).toEqual(messages)
  expect(links(f, a.run.id, original.id)).toHaveLength(1)
  expect(await readdir(f.directory)).toEqual(objects)
  const bytes = await readFile(join(f.directory, original.sha256))
  expect(bytes).toEqual(ORIGINAL)
  expect(sha(bytes)).toBe(original.sha256)
})

it("attaches an explicitly uploaded original atomically once and replays the same receipt without copying", async () => {
  const f = await fixture()
  const original = await f.files.publish(
    {
      id: "uploaded",
      conversationId: f.conversationId,
      runId: null,
      name: "original.csv",
      mime: "text/csv",
      origin: "upload"
    },
    ORIGINAL
  )
  const a = start(f, [original.id])
  const first = await invoke(a, { file_id: original.id }, "deliver-upload")
  expect(first).toEqual(original)
  expect(await invoke(a, { file_id: original.id }, "deliver-upload")).toEqual(first)
  expect(await invoke(a, { file_id: original.id }, "explicit-repeat")).toEqual(first)
  expect(links(f, a.run.id, original.id)).toHaveLength(1)
  expect(f.store.hasToolResult(a.lease, "deliver-upload")).toBe(true)
  expect(f.store.artifacts(f.conversationId)).toEqual([original])
  expect(await readFile(join(f.directory, original.sha256))).toEqual(ORIGINAL)
})

it("rolls back attachment message/events and receipt together if the attachment-link commit fails", async () => {
  const f = await fixture()
  const original = await f.files.publish(
    {
      id: "uploaded",
      conversationId: f.conversationId,
      runId: null,
      name: "original.csv",
      mime: "text/csv"
    },
    ORIGINAL
  )
  const a = start(f, [original.id]),
    messages = f.store.messages(f.conversationId),
    events = f.store.events().length
  const run = f.store.db.run.bind(f.store.db)
  const fault = vi.spyOn(f.store.db, "run").mockImplementation((sql, parameters) => {
    if (sql === "INSERT INTO bot_message_files VALUES(?,?)")
      throw new Error("controlled attachment commit failure")
    return run(sql, parameters)
  })
  await expect(invoke(a, { file_id: original.id }, "atomic-delivery")).rejects.toThrow(
    "controlled attachment commit failure"
  )
  fault.mockRestore()
  expect(f.store.messages(f.conversationId)).toEqual(messages)
  expect(f.store.events().length).toBe(events)
  expect(f.store.hasToolResult(a.lease, "atomic-delivery")).toBe(false)
  expect(await invoke(a, { file_id: original.id }, "atomic-delivery")).toEqual(original)
  expect(links(f, a.run.id, original.id)).toHaveLength(1)
})

it.each(["foreign", "unselected", "branch"] as const)(
  "refuses the %s original before recording a delivery receipt",
  async (mode) => {
    const f = await fixture()
    let original: BotArtifact
    if (mode === "branch") {
      const root = start(f)
      f.store.finish(root.lease, "succeeded", "Root discussion")
      original = await download(f, undefined, root.sent.messageId)
    } else {
      const other =
        mode === "foreign" ? f.store.createBot({ nonce: "other", name: "Other owner" }) : null
      original = await f.files.publish(
        {
          id: mode,
          conversationId: other?.conversationId ?? f.conversationId,
          runId: null,
          name: "original.csv",
          mime: "text/csv"
        },
        ORIGINAL
      )
    }
    const a = start(f, [], "inspect-scope"),
      messages = f.store.messages(f.conversationId)
    await expect(invoke(a, { file_id: original.id }, "refused")).rejects.toMatchObject({
      code: "artifact_scope"
    })
    expect(f.store.hasToolResult(a.lease, "refused")).toBe(false)
    expect(f.store.messages(f.conversationId)).toEqual(messages)
    expect(links(f, a.run.id, original.id)).toHaveLength(0)
  }
)

it.each(["unknown", "deleted"] as const)(
  "refuses an %s ID instead of reporting an unavailable original delivered",
  async (mode) => {
    const f = await fixture()
    let id = "unknown-file"
    if (mode === "deleted") {
      const original = await f.files.publish(
        {
          id: "deleted-original",
          conversationId: f.conversationId,
          runId: null,
          name: "original.csv",
          mime: "text/csv"
        },
        ORIGINAL
      )
      id = original.id
      f.store.deleteArtifact({
        nonce: "delete",
        conversationId: f.conversationId,
        id,
        sha256: original.sha256
      })
    }
    const a = start(f),
      messages = f.store.messages(f.conversationId)
    await expect(invoke(a, { file_id: id }, "unavailable")).rejects.toMatchObject({
      code: mode === "deleted" ? "artifact_deleted" : "not_found"
    })
    expect(f.store.hasToolResult(a.lease, "unavailable")).toBe(false)
    expect(f.store.messages(f.conversationId)).toEqual(messages)
  }
)

it.each(["cancel", "fence"] as const)(
  "refuses original delivery and new generation after %s, including a previously recorded receipt",
  async (mode) => {
    const f = await fixture(),
      a = start(f),
      original = await download(f, a)
    await invoke(a, { file_id: original.id }, "accepted-before-revocation")
    const messages = f.store.messages(f.conversationId),
      objects = await readdir(f.directory)
    const publish = vi.spyOn(f.files, "publish")
    if (mode === "cancel") f.store.cancel(a.run.id)
    else f.store.fenceOwner(a.lease.owner, "Controlled owner revocation")
    for (const callId of ["accepted-before-revocation", "new-after-revocation"])
      await expect(invoke(a, { file_id: original.id }, callId)).rejects.toMatchObject({
        code: "stale_lease"
      })
    await expect(
      invoke(a, { name: "new.txt", content: "Must not publish" }, "new-file")
    ).rejects.toMatchObject({ code: "stale_lease" })
    expect(publish).not.toHaveBeenCalled()
    expect(f.store.messages(f.conversationId)).toEqual(messages)
    expect(await readdir(f.directory)).toEqual(objects)
  }
)

it("rejects changed original ID or switching an existing-file receipt to generation on the same call", async () => {
  const f = await fixture(),
    a = start(f),
    original = await download(f, a)
  const second = await f.files.publish(
    {
      id: "another-result",
      conversationId: f.conversationId,
      runId: a.run.id,
      name: "other.csv",
      mime: "text/csv"
    },
    Buffer.from("other"),
    a.lease
  )
  await invoke(a, { file_id: original.id }, "fixed-call")
  await expect(invoke(a, { file_id: second.id }, "fixed-call")).rejects.toMatchObject({
    code: "nonce_conflict"
  })
  await expect(
    invoke(a, { name: "original.csv", content: "reconstructed" }, "fixed-call")
  ).rejects.toMatchObject({ code: "nonce_conflict" })
  expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
  expect((await f.files.read(original.id)).bytes).toEqual(ORIGINAL)
})

it("retains new-file generation/replay and intentional same-name derivatives while rejecting altered replay inputs", async () => {
  const f = await fixture(),
    a = start(f)
  const first = await invoke(
    a,
    { name: "report.csv", content: "id,value\r\nA,1\r\n" },
    "new-result"
  )
  expect(first.id).toBe(`result:${a.run.id}:new-result`)
  expect((await f.files.read(first.id)).bytes).toEqual(Buffer.from("id,value\r\nA,1\r\n"))
  expect(
    await invoke(a, { name: "report.csv", content: "id,value\r\nA,1\r\n" }, "new-result")
  ).toEqual(first)
  await expect(
    invoke(a, { name: "report.csv", content: "changed" }, "new-result")
  ).rejects.toMatchObject({ code: "nonce_conflict" })
  await expect(
    invoke(a, { name: "renamed.csv", content: "id,value\r\nA,1\r\n" }, "new-result")
  ).rejects.toMatchObject({ code: "nonce_conflict" })
  await expect(invoke(a, { file_id: first.id }, "new-result")).rejects.toMatchObject({
    code: "nonce_conflict"
  })
  const derivative = await invoke(
    a,
    { name: "report.csv", content: "id,value\nA,2\n" },
    "new-derivative"
  )
  expect(derivative.id).not.toBe(first.id)
  expect(derivative.name).toBe(first.name)
  expect(derivative.sha256).not.toBe(first.sha256)
  expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
  for (const artifact of [first, derivative]) {
    const delivered = links(f, a.run.id, artifact.id)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      sender: "system",
      text: `已交付：${artifact.name}`,
      attachmentFiles: [expect.objectContaining({ id: artifact.id, sha256: artifact.sha256 })]
    })
  }
})

it("commits generated bytes, attachment and delivery receipt together, then retries without a duplicate", async () => {
  const f = await fixture(),
    a = start(f),
    args = { name: "report.txt", content: "new authored content" },
    before = f.store.messages(f.conversationId),
    run = f.store.db.run.bind(f.store.db)
  const fault = vi.spyOn(f.store.db, "run").mockImplementation((sql, parameters) => {
    if (sql === "INSERT INTO bot_message_files VALUES(?,?)")
      throw new Error("controlled generated attachment failure")
    return run(sql, parameters)
  })
  await expect(invoke(a, args, "atomic-generation")).rejects.toThrow(
    "controlled generated attachment failure"
  )
  fault.mockRestore()
  expect(f.store.messages(f.conversationId)).toEqual(before)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  expect(
    f.store.db.exec("SELECT count(*) FROM bot_receipts WHERE nonce LIKE 'file-delivery:%'")[0]
      .values[0][0]
  ).toBe(0)
  const artifact = await invoke(a, args, "atomic-generation")
  expect(await invoke(a, args, "atomic-generation")).toEqual(artifact)
  expect(links(f, a.run.id, artifact.id)).toHaveLength(1)
  expect((await f.files.read(artifact.id)).bytes).toEqual(Buffer.from(args.content))
})

it("attaches a generated result to its owning discussion branch without leaking to the main conversation", async () => {
  const f = await fixture(),
    root = start(f)
  f.store.finish(root.lease, "succeeded", "Root discussion")
  const sent = f.store.send({
      nonce: "branch-task",
      conversationId: f.conversationId,
      threadRootId: root.sent.messageId,
      text: "Deliver a new branch report"
    }),
    claimed = f.store.claim("host", 300_000)!
  expect(claimed.run.id).toBe(sent.runIds[0])
  const request: BotRuntimeRequest = {
      ...claimed,
      bot: f.bot,
      store: f.store,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(claimed.run.id)
    },
    active = {
      ...claimed,
      request,
      sent,
      tool: botDeliverFileTool(request, f.files, () => f.store.assertDispatch(claimed.lease))
    }
  const artifact = await invoke(
    active,
    { name: "branch.txt", content: "Branch original" },
    "branch-delivery"
  )
  expect(
    f.store.messages(f.conversationId).some((message) => message.attachments.includes(artifact.id))
  ).toBe(false)
  const messages = f.store.messages(
    f.conversationId,
    undefined,
    100,
    undefined,
    root.sent.messageId
  )
  expect(messages.filter((message) => message.attachments.includes(artifact.id))).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({
    threadRootId: root.sent.messageId,
    runId: claimed.run.id
  })
})

it("does not treat a saved generation intent as a successful publication; exact retry publishes the missing original result", async () => {
  const f = await fixture(),
    a = start(f)
  const publish = vi
    .spyOn(f.files, "publish")
    .mockRejectedValueOnce(new Error("controlled publication failure"))
  const args = { name: "report.txt", content: "new authored content" }
  await expect(invoke(a, args, "retry-publish")).rejects.toThrow("controlled publication failure")
  expect(f.store.hasToolResult(a.lease, "retry-publish")).toBe(true)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  publish.mockRestore()
  const result = await invoke(a, args, "retry-publish")
  expect((await f.files.read(result.id)).bytes).toEqual(Buffer.from(args.content))
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
})

it.each([
  {},
  { name: "only.txt" },
  { content: "only" },
  { file_id: "original", name: "copy.csv" },
  { file_id: "original", content: "copy" },
  { file_id: "original", name: "copy.csv", content: "copy" },
  { file_id: "" },
  { file_id: "original", unknown: true }
])("rejects ambiguous/partial delivery parameters: %j", (input) => {
  expect(botDeliverFileInput.safeParse(input).success).toBe(false)
})
it("keeps empty UTF-8 result files supported", async () => {
  expect(botDeliverFileInput.safeParse({ name: "empty.txt", content: "" }).success).toBe(true)
  const f = await fixture(),
    a = start(f)
  const result = await invoke(a, { name: "empty.txt", content: "" }, "empty-result")
  expect(result.size).toBe(0)
  expect((await f.files.read(result.id)).bytes).toEqual(Buffer.alloc(0))
})

it("keeps ordinary old attachments deliverable and shareable after the model history has paged them out", async () => {
  const f = await fixture()
  const original = await f.files.publish(
    {
      id: "older-original",
      conversationId: f.conversationId,
      runId: null,
      name: "evidence.png",
      mime: "image/png"
    },
    ORIGINAL
  )
  const old = f.store.send({
    nonce: "older-upload",
    conversationId: f.conversationId,
    text: "Earlier explicit attachment",
    attachments: [original.id]
  })
  f.store.cancel(old.runIds[0])
  for (let index = 0; index < 205; index++) {
    const padding = f.store.send({
      nonce: `older-padding-${index}`,
      conversationId: f.conversationId,
      text: `Ordinary message ${index}`
    })
    f.store.cancel(padding.runIds[0])
  }
  const a = start(f, [], "older-followup")
  expect(
    f.store.messagesForRun(a.run.id).some((message) => message.attachments.includes(original.id))
  ).toBe(false)
  expect(f.store.artifactsForRun(a.run.id)).toEqual([original])
  expect(f.store.artifactForRun(a.run.id, original.id)).toEqual(original)
  // This method supplies metadata to the existing raster/approval layer;
  // its responsibility is durable artifact scope, not raster decoding.
  expect(f.store.peerImageSources(a.lease, [{ artifact_id: original.id }])[0]).toMatchObject({
    sourceId: original.id,
    sha256: original.sha256
  })
  expect(await invoke(a, { file_id: original.id }, "older-delivery")).toEqual(original)
  expect(links(f, a.run.id, original.id)).toHaveLength(1)
})

it("applies the file-list limit after visibility and does not admit unfinished uploads through an ID", async () => {
  const f = await fixture()
  const original = await f.files.publish(
    {
      id: "accepted-file",
      conversationId: f.conversationId,
      runId: null,
      name: "accepted.txt",
      mime: "text/plain"
    },
    ORIGINAL
  )
  const a = start(f, [original.id])
  // These valid uploaded originals reuse immutable bytes, but have never been
  // submitted to a message. Their metadata must not displace an allowed result.
  for (let index = 0; index < 501; index++)
    f.store.publishArtifact({
      id: `unsubmitted-${String(index).padStart(4, "0")}`,
      conversationId: f.conversationId,
      runId: null,
      name: `pending-${index}.txt`,
      mime: "text/plain",
      size: original.size,
      sha256: original.sha256,
      origin: "upload"
    })
  expect(f.store.artifacts(f.conversationId).map((file) => file.id)).not.toContain(original.id)
  expect(f.store.artifactsForRun(a.run.id)).toEqual([original])
  expect(() => f.store.artifactForRun(a.run.id, "unsubmitted-0500")).toThrow(
    "文件不属于当前任务可见"
  )
  expect(f.store.artifactForRun(a.run.id, original.id)).toEqual(original)
})

it("does not treat a waiting task's unaccepted peer-image alias as its own generated result", async () => {
  const f = await fixture(),
    a = start(f)
  const peerBot = f.store.createBot({ nonce: "pending-peer-owner", name: "Peer evidence reviewer" })
  const assignment = f.store.sendPeer(a.lease, {
    nonce: "pending-peer-assignment",
    recipient: peerBot.bot.id,
    text: "Review the evidence"
  })
  f.store.waitForPeer(a.lease, assignment.runIds[0])
  const child = f.store.claim("pending-peer-child", 300_000)!
  expect(child.run.id).toBe(assignment.runIds[0])
  const original = await f.files.publish(
    {
      id: "pending-peer-original",
      conversationId: peerBot.conversationId,
      runId: child.run.id,
      name: "pending-peer.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64"),
    child.lease
  )
  const inbound = f.store.sendPeer(child.lease, {
    nonce: "pending-peer-evidence",
    recipient: f.bot.id,
    intent: "status",
    text: "Supplemental evidence",
    images: f.store.peerImageSources(child.lease, [{ artifact_id: original.id }])
  })
  const message = f.store.message({ conversationId: f.conversationId, id: inbound.messageId }),
    alias = message.attachments[0]
  expect(f.store.getArtifact(alias)).toMatchObject({ runId: a.run.id, origin: "peer" })
  expect(f.store.steering.state(message.id)?.state).toBe("pending")
  expect(f.store.artifactsForRun(a.run.id)).toEqual([])
  expect(() => f.store.artifactForRun(a.run.id, alias)).toThrow("文件不属于当前任务可见")
  expect(() => f.store.steering.interruptIfPending(a.lease)).toThrow(/补充/)
  await f.store.steering
    .queue(a.lease, async (input) => {
      const { artifact, bytes } = await f.files.read(input.attachments[0])
      return [
        {
          type: "image_url",
          image_url: { url: `data:${artifact.mime};base64,${bytes.toString("base64")}` }
        }
      ]
    })
    .take({
      threadId: a.run.id,
      ownerRunToken: `${a.lease.owner}:${a.lease.fence}`,
      appliedIds: [],
      phase: "beforeModel"
    })
  expect(f.store.steering.state(message.id)?.state).toBe("accepted")
  expect(f.store.artifactForRun(a.run.id, alias)).toMatchObject({
    id: alias,
    sha256: original.sha256
  })
  expect(f.store.artifactsForRun(a.run.id)).toEqual([f.store.getArtifact(alias)])
})

it.each([
  ["result.csv", "text/csv"],
  ["结果.CSV", "text/csv"],
  ["result.tsv", "text/tab-separated-values"],
  ["result.json", "application/json"],
  ["review.MD", "text/markdown"],
  ["review.markdown", "text/markdown"],
  ["review.mdx", "text/markdown"],
  ["result.ts", "text/plain"],
  ["misnamed.png", "text/plain"]
])(
  "persists the generated UTF-8 MIME for %s without changing bytes or replay identity",
  async (name, mime) => {
    const f = await fixture(),
      a = start(f)
    const content = "\ufeff列,amount\r\nA,18.45\r\n"
    const bytes = Buffer.from(content, "utf8")
    const result = await invoke(a, { name, content }, "typed-result")
    expect(result).toMatchObject({
      name,
      mime,
      size: bytes.length,
      sha256: sha(bytes),
      origin: "generated"
    })
    expect(f.store.getArtifact(result.id)).toEqual(result)
    expect((await f.files.read(result.id)).bytes).toEqual(bytes)
    expect(await invoke(a, { name, content }, "typed-result")).toEqual(result)
    expect(f.store.artifacts(f.conversationId)).toEqual([result])
    expect(f.store.artifactsForRun(a.run.id)).toEqual([result])
    const chunk = await f.files.chunk({ id: result.id, offset: 0 })
    expect(chunk.artifact).toEqual(result)
    expect(Buffer.from(chunk.base64, "base64")).toEqual(bytes)
  }
)

it.each(["intent-only", "published"] as const)(
  "replays a legacy %s CSV generation under its original MIME instead of conflicting or rewriting it",
  async (mode) => {
    const f = await fixture(),
      a = start(f)
    const callId = "legacy-generation",
      name = "result.csv",
      content = "id,amount\r\nA,18.45\r\n"
    const bytes = Buffer.from(content),
      publicationId = `result:${a.run.id}:${callId}`
    f.store.toolOnce(
      a.lease,
      callId,
      {
        tool: "deliver_file",
        mode: "generate",
        name,
        contentSha256: createHash("sha256").update(content, "utf8").digest("hex")
      },
      () => ({ publicationId })
    )
    const original =
      mode === "published"
        ? await f.files.publish(
            {
              id: publicationId,
              conversationId: f.conversationId,
              runId: a.run.id,
              name,
              mime: "text/plain"
            },
            bytes,
            a.lease
          )
        : null
    const result = await invoke(a, { name, content }, callId)
    expect(result).toMatchObject({
      id: publicationId,
      name,
      mime: "text/plain",
      size: bytes.length,
      sha256: sha(bytes)
    })
    if (original) expect(result).toEqual(original)
    expect((await f.files.read(result.id)).bytes).toEqual(bytes)
    expect(f.store.artifacts(f.conversationId)).toEqual([result])
    expect(f.store.artifactsForRun(a.run.id)).toEqual([result])
    const chunk = await f.files.chunk({ id: result.id, offset: 0 })
    expect(chunk.artifact).toEqual(result)
    expect(Buffer.from(chunk.base64, "base64")).toEqual(bytes)
    await expect(invoke(a, { name, content: "changed" }, callId)).rejects.toMatchObject({
      code: "nonce_conflict"
    })
  }
)
