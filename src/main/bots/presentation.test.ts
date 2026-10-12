import { beforeAll, afterEach, afterAll, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { build } from "esbuild"
import AdmZip from "adm-zip"
import { loadImage } from "@napi-rs/canvas"
import { BotStore } from "./store"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BotArtifacts } from "./artifacts"
import { BotDocumentReader } from "./document-reader"
import { BotPresentationInputError } from "./presentation-contract"
import { botPresentationInput, readBotPresentationChoice } from "../../shared/bot-presentation"
import { botPresentationTool } from "./presentation-tool"
import { botDeliverFileTool } from "./deliver-file-tool"
import { readPresentationManifest } from "./presentation-record"
import type { BotRuntimeRequest } from "./host"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import type { BotWorkflowChildInput } from "./workflow-children"

let directory: string, reader: BotDocumentReader
const cleanup: (() => void | Promise<unknown>)[] = []
const input = {
  name: "项目交付.pptx",
  title: "研发工作与交付",
  slides: [
    { kind: "title" as const, title: "研发工作与交付", subtitle: "持续推进 · 清晰验证" },
    {
      kind: "content" as const,
      title: "技术能力与交付价值",
      points: ["保存工作环境与项目进展", "按实际验证结果交付文件", "关键操作由人员审核"]
    },
    {
      kind: "two-column" as const,
      title: "分工与验收",
      left: { heading: "Bot", points: ["执行任务", "保留证据"] },
      right: { heading: "研发人员", points: ["确定目标", "验收结果"] }
    }
  ]
}
const signal = () => new AbortController().signal
beforeAll(async () => {
  await mkdir("output", { recursive: true })
  directory = await mkdtemp(resolve("output/presentation-"))
  const entry = join(directory, "document.cjs")
  await build({
    entryPoints: ["src/main/bots/document-worker-entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["pdfjs-dist/*", "@napi-rs/canvas"],
    logLevel: "silent"
  })
  reader = new BotDocumentReader({ entry })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function fixture(persistent = false) {
  const dir = await mkdtemp(join(directory, "artifacts-")),
    store = new BotStore(persistent ? join(dir, "bots.sqlite") : ":memory:")
  const files = new BotArtifacts(join(dir, "objects"), store, reader)
  cleanup.push(
    () => store.close(),
    () => files.close()
  )
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "文稿助手" })
  store.send({ nonce: "work", conversationId, text: "制作项目交付演示文稿" })
  const claimed = store.claim("host", 300_000)!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot,
    store,
    signal: signal(),
    messages: store.messagesForRun(claimed.run.id)
  }
  await files.recover()
  const check = () => store.assertDispatch(request.lease)
  return { dir, store, files, request, check }
}
function create(f: Awaited<ReturnType<typeof fixture>>, answer = 1) {
  const wait = vi.fn(async (id: string) => {
    const item = f.store.getInteraction(id),
      card = readBotPresentationChoice(item.prompt)!
    expect(card.images).toHaveLength(3)
    expect(() =>
      f.store.answerInteraction({
        id,
        revision: item.revision,
        expectedDataEpoch: "old",
        answer: "{}"
      })
    ).toThrow()
    const raw = JSON.stringify({
      status: "submitted",
      answers: {
        presentation_style: {
          type: "option",
          questionId: "presentation_style",
          optionIndex: answer
        }
      }
    })
    return f.store.answerInteraction({
      id,
      revision: item.revision,
      expectedDataEpoch: card.dataEpoch,
      answer: raw
    }).answer!
  })
  return { tool: botPresentationTool(f.request, f.files, reader, f.check, wait), wait }
}
function attachedPresentations(store: BotStore) {
  return (
    store.db.exec(
      "SELECT f.artifact_id,m.run_id FROM bot_message_files f JOIN bot_artifacts a ON a.id=f.artifact_id JOIN bot_messages m ON m.id=f.message_id WHERE a.mime='application/vnd.openxmlformats-officedocument.presentationml.presentation' ORDER BY m.sequence"
    )[0]?.values ?? []
  )
}
async function invoke(
  tool: ReturnType<typeof botPresentationTool>,
  args: Record<string, unknown> = input,
  id = "presentation-call"
) {
  const result = await tool.invoke({ type: "tool_call", name: "create_presentation", id, args })
  return JSON.parse(String(result.content))
}
it("real worker renders three measured PNG styles and editable multi-page OOXML with original Chinese content", async () => {
  const drafts = await reader.presentationDrafts(input, signal())
  expect(drafts.layouts.map((x) => x.style)).toEqual(["minimal", "executive", "warm"])
  for (const preview of drafts.previews) {
    const image = await loadImage(Buffer.from(preview, "base64"))
    expect([image.width, image.height]).toEqual([960, 540])
  }
  const generated = await reader.presentationWrite(drafts.layouts[1], signal()),
    zip = new AdmZip(Buffer.from(generated.bytes))
  expect(
    zip.getEntries().filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x.entryName))
  ).toHaveLength(3)
  expect(zip.readAsText("ppt/slides/slide2.xml")).toContain("按实际验证结果交付文件")
  expect(zip.readAsText("ppt/slides/slide2.xml")).toContain("<a:t>")
  expect(zip.readAsText("[Content_Types].xml")).toContain("presentationml.presentation.main+xml")
}, 30_000)
it("real typed choice publishes an immutable PPTX, previews each saved page and replays without writer or question", async () => {
  const f = await fixture(),
    a = create(f),
    output = await invoke(a.tool)
  expect(output).toMatchObject({
    name: input.name,
    pages: 3,
    style: "executive",
    editable: true,
    status: "generated",
    generated: true,
    selectionCompleted: true,
    selectionSource: "user_card",
    attachment: { status: "delivered", sourceArtifactId: output.id }
  })
  expect(attachedPresentations(f.store)).toEqual([[output.id, f.request.run.id]])
  const read = await f.files.read(output.id)
  expect(createHash("sha256").update(read.bytes).digest("hex")).toBe(output.sha256)
  expect(readPresentationManifest(f.store, output)?.layout.pages).toHaveLength(3)
  const page = await f.files.previews.read({
    id: output.id,
    conversationId: f.request.run.conversationId,
    requestId: "last-page",
    offset: 2
  })
  expect(page).toMatchObject({
    kind: "presentation",
    presentation: { page: 2, pageCount: 3, width: 960, height: 540 }
  })
  const write = vi.spyOn(reader, "presentationWrite"),
    draft = vi.spyOn(reader, "presentationDrafts")
  expect(await invoke(a.tool)).toEqual(output)
  expect(attachedPresentations(f.store)).toEqual([[output.id, f.request.run.id]])
  expect(write).not.toHaveBeenCalled()
  expect(draft).not.toHaveBeenCalled()
  expect(a.wait).toHaveBeenCalledTimes(1)
  await expect(invoke(a.tool, { ...input, title: "changed" })).rejects.toThrow()
  await expect(
    f.files.previews.read({ id: output.id, conversationId: "foreign", requestId: "bad", offset: 0 })
  ).rejects.toThrow()
}, 30_000)
it("cancelled typed choice never produces a PPTX or chooses a default", async () => {
  const f = await fixture(),
    tool = botPresentationTool(f.request, f.files, reader, f.check, async (id) => {
      const q = f.store.getInteraction(id),
        card = readBotPresentationChoice(q.prompt)!
      return f.store.answerInteraction({
        id,
        revision: q.revision,
        expectedDataEpoch: card.dataEpoch,
        answer: JSON.stringify({ status: "cancelled", answers: {} })
      }).answer!
    })
  expect(await invoke(tool)).toEqual({ status: "cancelled", generated: false })
  expect(attachedPresentations(f.store)).toEqual([])
  expect(
    f.store.artifacts(f.request.run.conversationId).filter((x) => x.name.endsWith(".pptx"))
  ).toHaveLength(0)
}, 30_000)
it("real worker rejects excess content before any artifacts; model can correct input in a new call", async () => {
  const f = await fixture(),
    a = create(f)
  const dense = {
    ...input,
    style: "minimal",
    slides: [
      {
        kind: "content",
        title: "过长",
        points: Array.from({ length: 6 }, () => "很多文字".repeat(90))
      }
    ]
  }
  const result = await invoke(a.tool, dense)
  expect(result).toMatchObject({ status: "not_generated", code: "presentation_invalid_layout" })
  expect(f.store.artifacts(f.request.run.conversationId)).toHaveLength(0)
  expect(a.wait).not.toHaveBeenCalled()
  expect(await invoke(a.tool, { ...input, style: "minimal" }, "corrected")).toMatchObject({
    editable: true,
    pages: 3
  })
}, 30_000)
it("a writer timeout or abort remains fatal and never becomes not_generated feedback", async () => {
  const f = await fixture(),
    a = create(f)
  vi.spyOn(reader, "presentationWrite").mockRejectedValue(new Error("文档解析超时"))
  await expect(invoke(a.tool, { ...input, style: "minimal" })).rejects.toThrow("超时")
  expect(f.store.artifacts(f.request.run.conversationId)).toHaveLength(0)
  const controller = new AbortController()
  controller.abort(new Error("测试取消"))
  await expect(reader.presentationDrafts(input, controller.signal)).rejects.toThrow("测试取消")
}, 30_000)
it("missing saved font is explicit; XML-invalid input and unsupported templates never reach a worker", async () => {
  const drafts = await reader.presentationDrafts(input, signal())
  await expect(
    reader.presentationPage(
      { ...drafts.layouts[0], font: "CMB-Definitely-Missing-Font" },
      0,
      signal()
    )
  ).rejects.toBeInstanceOf(BotPresentationInputError)
  for (const invalid of [0, 8, 11, 12, 14, 31, 0xd800, 0xdc00, 0xfffe, 0xffff]) {
    expect(
      botPresentationInput.safeParse({ ...input, title: `bad${String.fromCharCode(invalid)}text` })
        .success
    ).toBe(false)
  }
  expect(
    botPresentationInput.safeParse({ ...input, title: "中文\t标题\n换行\r说明 😀" }).success
  ).toBe(true)
  expect(
    botPresentationInput.safeParse({ ...input, template: "/private/template.pptx" }).success
  ).toBe(false)
  expect(
    botPresentationInput.safeParse({ ...input, slides: Array(21).fill(input.slides[0]) }).success
  ).toBe(false)
}, 30_000)
it("fake UTF-8 PPTX never publishes while existing original delivery keeps exact file identity", async () => {
  const f = await fixture(),
    fake = botDeliverFileTool(f.request, f.files, f.check)
  const result = await fake.invoke({
    type: "tool_call",
    name: "deliver_file",
    id: "fake",
    args: { name: "fake.pptx", content: "slide 1" }
  })
  expect(JSON.parse(String(result.content))).toMatchObject({ status: "not_generated" })
  expect(f.store.artifacts(f.request.run.conversationId)).toHaveLength(0)
  const a = create(f),
    file = await invoke(a.tool, { ...input, style: "warm" })
  const returned = await fake.invoke({
    type: "tool_call",
    name: "deliver_file",
    id: "original",
    args: { file_id: file.id }
  })
  expect(JSON.parse(String(returned.content))).toMatchObject({ id: file.id, sha256: file.sha256 })
}, 30_000)
it("workflow child read-only and explicit original write denials also deny presentations", () => {
  const base = { shellAccess: "full" } as BotWorkflowChildInput
  expect(botWorkflowChildAllows(base, "create_presentation")).toBe(true)
  expect(botWorkflowChildAllows({ ...base, shellAccess: "read_only" }, "create_presentation")).toBe(
    false
  )
  expect(
    botWorkflowChildAllows({ ...base, disallowedTools: ["write_file"] }, "create_presentation")
  ).toBe(false)
  expect(botWorkflowChildAllows({ ...base, browserAccess: "page" }, "create_presentation")).toBe(
    false
  )
})
it("lost manifest commit recovers the original published bytes under a fresh lease without rewriting", async () => {
  const f = await fixture(),
    a = create(f),
    originalOnce = f.store.toolOnce.bind(f.store)
  let rejectManifest = true
  vi.spyOn(f.store, "toolOnce").mockImplementation(
    (lease, id, request, operation, assertCurrent) => {
      if (id.startsWith("presentation-manifest:") && rejectManifest) {
        rejectManifest = false
        throw new Error("simulated manifest commit failure")
      }
      return originalOnce(lease, id, request, operation, assertCurrent)
    }
  )
  await expect(invoke(a.tool, { ...input, style: "minimal" })).rejects.toThrow("manifest commit")
  const original = f.store.artifacts(f.request.run.conversationId)[0]
  expect(original.name).toBe(input.name)
  const bytes = (await f.files.read(original.id)).bytes
  f.store.fenceOwner("host", "process stopped")
  const interrupted = f.store.getRun(f.request.run.id)
  f.store.recover({
    id: interrupted.id,
    revision: interrupted.revision,
    decision: "resume",
    note: "核对原件后继续",
    effects: [],
    nonce: "recover-missing-manifest",
    dataEpoch: f.store.dataEpoch()
  })
  const next = f.store.claim("restarted-host", 300_000)!
  expect(next.lease.fence).toBeGreaterThan(f.request.lease.fence)
  f.request = { ...f.request, ...next }
  f.check = () => f.store.assertDispatch(f.request.lease)
  const write = vi.spyOn(reader, "presentationWrite"),
    again = create(f)
  expect(await invoke(again.tool, { ...input, style: "minimal" })).toMatchObject({
    id: original.id,
    sha256: original.sha256
  })
  expect(write).not.toHaveBeenCalled()
  expect(again.wait).not.toHaveBeenCalled()
  expect((await f.files.read(original.id)).bytes).toEqual(bytes)
  expect(readPresentationManifest(f.store, original)?.artifactSha256).toBe(original.sha256)
}, 30_000)
it("an expired style question gets a new exact request after recovery instead of hanging on its old receipt", async () => {
  const f = await fixture()
  let oldId = ""
  const interrupted = botPresentationTool(f.request, f.files, reader, f.check, async (id) => {
    oldId = id
    throw new Error("process stopped before choice")
  })
  await expect(invoke(interrupted)).rejects.toThrow("process stopped")
  f.store.fenceOwner("host", "process stopped")
  const review = f.store.getRun(f.request.run.id)
  f.store.recover({
    id: review.id,
    revision: review.revision,
    decision: "resume",
    note: "继续选择样稿",
    effects: [],
    nonce: "recover-expired-question",
    dataEpoch: f.store.dataEpoch()
  })
  f.request = { ...f.request, ...f.store.claim("restarted-host", 300_000)! }
  f.check = () => f.store.assertDispatch(f.request.lease)
  const a = create(f)
  expect(await invoke(a.tool)).toMatchObject({ editable: true })
  expect(a.wait.mock.calls[0][0]).not.toBe(oldId)
  expect(f.store.getInteraction(oldId).status).toBe("expired")
}, 30_000)

it("an acknowledged style survives Store restart before the tool receives its answer", async () => {
  const f = await fixture(true)
  let answeredId = ""
  const interrupted = botPresentationTool(f.request, f.files, reader, f.check, async (id) => {
    answeredId = id
    const item = f.store.getInteraction(id)
    const card = readBotPresentationChoice(item.prompt)!
    f.store.answerInteraction({
      id,
      revision: item.revision,
      expectedDataEpoch: card.dataEpoch,
      answer: JSON.stringify({
        status: "submitted",
        answers: {
          presentation_style: {
            type: "option",
            questionId: "presentation_style",
            optionIndex: 2
          }
        }
      })
    })
    throw new Error("process stopped after acknowledged choice")
  })
  await expect(invoke(interrupted)).rejects.toThrow("acknowledged choice")
  f.store.fenceOwner("host", "process stopped")
  await f.files.close()
  f.store.close()
  const store = new BotStore(join(f.dir, "bots.sqlite"))
  const files = new BotArtifacts(join(f.dir, "objects"), store, reader)
  cleanup.push(
    () => store.close(),
    () => files.close()
  )
  await files.recover()
  const review = store.getRun(f.request.run.id)
  store.recover({
    id: review.id,
    revision: review.revision,
    decision: "resume",
    note: "保留已确认的版式并继续",
    effects: [],
    nonce: "resume-confirmed-style",
    dataEpoch: store.dataEpoch()
  })
  const next = store.claim("replacement-host", 300_000)!
  expect(next.lease.fence).toBeGreaterThan(f.request.lease.fence)
  const request = { ...f.request, ...next, store, signal: signal() }
  const wait = vi.fn(async () => {
    throw new Error("must not ask again")
  })
  const resumed = botPresentationTool(
    request,
    files,
    reader,
    () => store.assertDispatch(next.lease),
    wait
  )
  expect(await invoke(resumed)).toMatchObject({ editable: true, style: "warm" })
  expect(wait).not.toHaveBeenCalled()
  expect(store.getInteraction(answeredId).status).toBe("answered")
  expect(
    store.db.exec("SELECT count(*) FROM bot_interactions WHERE kind='question'")[0].values[0][0]
  ).toBe(1)
}, 30_000)

it("a supplied style remains identified as a parameter rather than an independently confirmed user answer", async () => {
  const f = await fixture(),
    a = create(f)
  const result = await invoke(a.tool, { ...input, style: "warm" })
  expect(result).toMatchObject({
    style: "warm",
    pages: 3,
    generated: true,
    editable: true,
    selectionCompleted: true,
    selectionSource: "provided_style",
    attachment: { status: "delivered", sourceArtifactId: result.id }
  })
  expect(a.wait).not.toHaveBeenCalled()
  expect(await invoke(a.tool, { ...input, style: "warm" })).toEqual(result)
  expect(attachedPresentations(f.store)).toEqual([[result.id, f.request.run.id]])
}, 30_000)

it("a lost delivery ACK replays the complete saved-manifest result after Store restart without a second attachment", async () => {
  const f = await fixture(true),
    a = create(f),
    deliver = f.store.deliverExistingArtifact.bind(f.store)
  let delivered: ReturnType<typeof deliver> | undefined
  vi.spyOn(f.store, "deliverExistingArtifact").mockImplementationOnce((...args) => {
    delivered = deliver(...args)
    throw new Error("process stopped after attachment committed")
  })
  await expect(invoke(a.tool)).rejects.toThrow("attachment committed")
  const original = delivered!
  expect(attachedPresentations(f.store)).toEqual([[original.id, f.request.run.id]])
  const bytes = (await f.files.read(original.id)).bytes
  f.store.fenceOwner("host", "process stopped after delivery")
  await f.files.close()
  f.store.close()
  const store = new BotStore(join(f.dir, "bots.sqlite")),
    files = new BotArtifacts(join(f.dir, "objects"), store, reader)
  cleanup.push(
    () => store.close(),
    () => files.close()
  )
  await files.recover()
  const review = store.getRun(f.request.run.id)
  store.recover({
    id: review.id,
    revision: review.revision,
    decision: "resume",
    note: "核对已交付原件后继续",
    effects: [],
    nonce: "resume-delivery-ack",
    dataEpoch: store.dataEpoch()
  })
  const next = store.claim("replacement-host", 300_000)!
  const request = { ...f.request, ...next, store, signal: signal() }
  const wait = vi.fn(async () => {
    throw new Error("must not ask again")
  })
  const resumed = botPresentationTool(
    request,
    files,
    reader,
    () => store.assertDispatch(next.lease),
    wait
  )
  const draft = vi.spyOn(reader, "presentationDrafts"),
    write = vi.spyOn(reader, "presentationWrite")
  const result = await invoke(resumed)
  expect(result).toMatchObject({
    id: original.id,
    sha256: original.sha256,
    name: original.name,
    pages: 3,
    style: "executive",
    editable: true,
    generated: true,
    selectionCompleted: true,
    selectionSource: "user_card",
    attachment: { status: "delivered", sourceArtifactId: original.id }
  })
  expect(await invoke(resumed)).toEqual(result)
  expect(attachedPresentations(store)).toEqual([[original.id, request.run.id]])
  expect(wait).not.toHaveBeenCalled()
  expect(draft).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect((await files.read(original.id)).bytes).toEqual(bytes)
}, 30_000)

it("additional style requirements do not publish an original or treat the option as confirmed", async () => {
  const f = await fixture(),
    write = vi.spyOn(reader, "presentationWrite")
  const tool = botPresentationTool(f.request, f.files, reader, f.check, async (id) => {
    const question = f.store.getInteraction(id),
      card = readBotPresentationChoice(question.prompt)!
    return f.store.answerInteraction({
      id,
      revision: question.revision,
      expectedDataEpoch: card.dataEpoch,
      answer: JSON.stringify({
        status: "submitted",
        answers: {
          presentation_style: {
            type: "option",
            questionId: "presentation_style",
            optionIndex: 1,
            additionalText: "请先调整为更大字号"
          }
        }
      })
    }).answer!
  })
  expect(await invoke(tool)).toMatchObject({ status: "not_generated" })
  expect(write).not.toHaveBeenCalled()
  expect(
    f.store.artifacts(f.request.run.conversationId).filter((item) => item.name.endsWith(".pptx"))
  ).toEqual([])
  expect(attachedPresentations(f.store)).toEqual([])
}, 30_000)

it.each(["artifactSha256", "inputSha256"])(
  "a mismatched saved manifest %s never attaches the original",
  async (field) => {
    const f = await fixture(),
      a = create(f),
      originalOnce = f.store.toolOnce.bind(f.store)
    vi.spyOn(f.store, "toolOnce").mockImplementation(
      (lease, id, request, operation, assertCurrent) => {
        const value = originalOnce(lease, id, request, operation, assertCurrent)
        if (id.startsWith("presentation-manifest:")) {
          const manifest = { ...(value as Record<string, unknown>), [field]: "0".repeat(64) }
          f.store.db.run("UPDATE bot_receipts SET response=? WHERE nonce=?", [
            JSON.stringify(manifest),
            `tool:${lease.runId}:${id}`
          ])
        }
        return value
      }
    )
    await expect(invoke(a.tool, { ...input, style: "minimal" })).rejects.toThrow("不一致")
    expect(attachedPresentations(f.store)).toEqual([])
  },
  30_000
)

it("restoring another data epoch never turns an old generated-but-unattached original into a new delivery", async () => {
  const f = await fixture(true),
    a = create(f)
  vi.spyOn(f.store, "deliverExistingArtifact").mockImplementationOnce(() => {
    throw new Error("process stopped before attachment")
  })
  await expect(invoke(a.tool, { ...input, style: "minimal" })).rejects.toThrow("before attachment")
  expect(attachedPresentations(f.store)).toEqual([])
  const original = f.store.artifacts(f.request.run.conversationId)[0],
    path = join(f.dir, "bots.sqlite")
  await f.files.close()
  f.store.close()
  const ledger = new BotDeletionLedger(path)
  try {
    fenceBotCheckpointDatabase(path, "restored-presentation-epoch", ledger)
  } finally {
    ledger.close()
  }
  const store = new BotStore(path),
    files = new BotArtifacts(join(f.dir, "objects"), store, reader)
  cleanup.push(
    () => store.close(),
    () => files.close()
  )
  await files.recover()
  expect(store.dataEpoch()).toBe("restored-presentation-epoch")
  expect(store.getRun(f.request.run.id).status).toBe("cancelled")
  const old = botPresentationTool(
    { ...f.request, store, signal: signal() },
    files,
    reader,
    () => store.assertDispatch(f.request.lease),
    async () => {
      throw new Error("must not ask again")
    }
  )
  await expect(invoke(old, { ...input, style: "minimal" })).rejects.toThrow()
  expect(attachedPresentations(store)).toEqual([])
  expect(store.getArtifact(original.id).sha256).toBe(original.sha256)
}, 30_000)
