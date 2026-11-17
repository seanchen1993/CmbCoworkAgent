import { afterEach, describe, expect, it, vi } from "vitest"
import type { BotDefinition, BotTask } from "../../shared/bots/contracts"
import type { BotWorkItem } from "../../shared/bots/work"
import { botWorkAttachmentHref, botWorkHistoryHref, parseBotWorkAttachmentHref } from "../../shared/bots/work-history"
import type { Message } from "../types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import type { LocalBotHost } from "./host"
import { publishWorkResult, createWorkResultEvidenceAccess } from "./work-result-runtime"
import { verifiedWorkResultThread } from "./work-result-thread"
import {
  RetryableBotWorkPublicationError,
  normalWorkResultSummary,
  type BotWorkResultAttachmentReference
} from "./work-result-settlement"
import { includeWorkResultAnswers, projectForegroundCommand, projectWorkResultProcess, type BotWorkResultProcess } from "./work-result-process"

const f = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  configRef: "custom:original",
  model: "original",
  constructModel: vi.fn(),
  invoke: vi.fn(),
  route: vi.fn(async () => ({ resolvedModelId: "custom:original" })),
  write: vi.fn(),
  read: vi.fn((_thread?: string, _ids?: string[]) => [] as Array<{ id: string; role: string; content: string }>),
  readPage: vi.fn(),
  mirror: vi.fn(),
  attention: vi.fn(),
  notify: vi.fn(),
  pet: vi.fn()
}))
vi.mock("../agent/runtime", () => ({
  getModelInstance: (...args: unknown[]) => {
    f.constructModel(...args)
    return { invoke: f.invoke }
  }
}))
vi.mock("../routing", () => ({ resolveModel: f.route }))
vi.mock("../storage", () => ({ getGlobalRoutingMode: () => "auto" }))
vi.mock("../models/registry", () => ({
  getModelConfigByRef: () => ({
    model: f.model,
    apiKey: "unused",
    baseUrl: "http://unused.invalid"
  }),
  getAvailableModelConfigOrDefault: () => null,
  toModelRef: () => f.configRef
}))
vi.mock("../db", () => ({
  getThreadCore: (threadId: string) =>
    threadId === "work-thread"
      ? {
          thread_id: threadId,
          created_at: 10,
          metadata: JSON.stringify({
            botId: "bot",
            botHostId: "local",
            botWorkId: "work",
            botAudienceKey: "desktop",
            workspacePath: "/workspace",
            cmb_thread_incarnation: "real-thread",
            ...f.metadata
          })
        }
      : null,
  getThreadMessagesByIds: f.read,
  upsertThreadMessages: f.write
}))
vi.mock("../thread-message-hydration/client", () => ({ readThreadMessagesPageInWorker: f.readPage }))
vi.mock("../services/im/remote-grant-store", () => ({ imRemoteGrantStore: { getThreadGrant: vi.fn() } }))
vi.mock("../agent/renderer-stream-mirror", () => ({ mirrorStandardTurnStreamToRenderer: f.mirror }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: f.attention }))
vi.mock("../services/notify", () => ({ notifyIfBackground: f.notify }))
vi.mock("../pet", () => ({ showPetCompletedTaskNotice: f.pet }))

const bot = {
  id: "bot",
  name: "Bot",
  modelRef: "custom:original",
  threadId: "main"
} as BotDefinition
const work = {
  id: "work",
  botId: bot.id,
  title: "Work",
  threadId: "work-thread",
  audienceKey: "desktop"
} as BotWorkItem
const task = { id: "lease", threadId: bot.threadId, botId: bot.id, createdAt: 100 } as BotTask
const incarnation = (target = work) => verifiedWorkResultThread(target).incarnation
const contextFor = (target: BotWorkItem) => ({
  work: target,
  incarnation: incarnation(target),
  requestTaskId: "root",
  executionTaskId: "exec",
  executionSupplementRequestIds: [] as string[],
  requests: [{ text: "Review this report" }],
  outcome: { state: "completed", text: "Report is ready", truncated: false },
  remainingRepairs: 2,
  defaultAttachments: [] as BotWorkResultAttachmentReference[],
  evidence: [],
  commands: [
    {
      id: "command-1",
      sourceTaskId: "exec",
      state: "completed",
      result: { output: "1 test passed", exitCode: 0, truncated: false }
    }
  ]
})
const context = () => contextFor(work)

afterEach(() => {
  f.metadata = {}
  f.configRef = "custom:original"
  f.model = "original"
  f.readPage.mockReset()
  releaseLocalThreadRunLease(task.threadId, "bot", task.id)
  vi.clearAllMocks()
})

describe("Bot work result runtime", () => {

  it.each(["option", "options", "long", "options-long", "legacy", "mismatch", "ignored"])("retains only submitted option descriptions within the existing budget (%s)", kind => {
    const options = [
      { label: "方式 A", description: kind.includes("long") ? "CSV无表头".repeat(40) : "输出 CSV，不含标题行" },
      { label: "方式 B", description: "附上失败记录" },
      { label: "方式 C", description: "UNSELECTED_PRIVATE_DETAIL" }
    ]
    const answer = kind.startsWith("options")
      ? { type: "options", questionId: "format", options: options.slice(0, 2).map((o, optionIndex) => ({ ...o, optionIndex })) }
      : { type: "option", questionId: "format", optionIndex: 0, ...options[0], additionalText: "使用 UTF-8",
          ...(kind === "legacy" ? { description: undefined } : kind === "mismatch" ? { description: "UNMATCHED_DETAIL" } : {}) }
    const process = projectWorkResultProcess({ messages: [
      { id: "request", role: "user", content: "Original task", created_at: new Date(1) },
      { id: "ask", role: "assistant", content: "", created_at: new Date(2), tool_calls: [{ id: "question", name: "request_user_input",
        args: { questions: [{ id: "format", question: "交付格式？", options }] } }] },
      { id: "answer", role: "tool", tool_call_id: "question", name: "request_user_input", created_at: new Date(3),
        content: JSON.stringify({ status: kind === "ignored" ? "ignored" : "submitted", requestId: "request-question", answers: { format: answer } }) },
      { id: "final", role: "assistant", content: "Finished", created_at: new Date(4) }
    ], hasMore: false, beforeOrdinal: null, beforeMessageId: null, total: 4 }, {
      taskId: "execution", requestId: "request", finalMessageId: "final", supplementRequestIds: [], earlierExecutions: false
    })
    const interaction = process.steps[0].tools![0].interaction!
    if (kind === "ignored") {
      expect(interaction.answers).toEqual([])
      return
    }
    const projected = interaction.answers[0].answer
    if (kind === "legacy" || kind === "mismatch") {
      expect(projected).toBe("方式 A · 使用 UTF-8")
      return
    }
    expect(projected).toContain(options[0].description.slice(0, 100))
    expect(projected.length).toBeLessThanOrEqual(240)
    expect(JSON.stringify(process)).not.toContain("UNSELECTED_PRIVATE_DETAIL")
    if (kind === "options") expect(projected).toContain("附上失败记录")
    if (kind.startsWith("options")) expect(projected).toContain("方式 A、方式 B")
    if (kind === "option") expect(projected).toContain("使用 UTF-8")
    expect(process.coverage).toBe(kind.includes("long") ? "partial" : "complete")
  })

  it.each([
    ["node verify.mjs", "node verify.mjs"], ["node --test tests/events.test.mjs", "node --test tests/events.test.mjs"],
    ["npm run test:unit --silent", "npm run test:unit"], ["npm test; npm run build", "Compound shell command"],
    ["curl --user fixture:synthetic-secret", "curl"], ["node verify.mjs --secret example", "node"],
    ["node ../../scripts/verify.mjs", "node ../../scripts/verify.mjs"],
    ["node ../../../private-neighbor/verify.mjs", "node"], ["node -rprivate-migration.js", "node"]
  ])("uses a private command label without inventing arguments (%s)", (command, expected) => {
    expect(projectForegroundCommand({ command, directory: "packages/server", exitCode: 0,
      output: "test output", truncated: false })).toEqual({ command: expected,
      ...(command === expected ? { exactCommand: true } : {}),
      directory: "packages/server", exitCode: 0, output: "test output", excerpt: false })
  })

  it.each([
    { result: "\n[Command failed with exit code 1]", exitCode: 1, coverage: "complete" },
    { result: "\n[Command succeeded with exit code 0]", exitCode: 0, coverage: "complete" },
    { result: "\n[Command failed with exit code 2]\n[Output was truncated due to size limits]", exitCode: 2,
      coverage: "complete", truncated: true },
    { result: "\n[Command succeeded with exit code 0]\ncommand still running", coverage: "partial" },
    { result: "\n[Command succeeded with exit code 0]", coverage: "partial", truncatedPage: true },
    { result: "\n[Command succeeded with exit code 0]", coverage: "partial", mismatchedTool: true },
    { result: "\n[Command succeeded with exit code 0]", coverage: "partial", repeated: true },
    { result: "\n[Command failed with exit code 1]", coverage: "partial", rejected: true },
    { result: "\n[Command succeeded with exit code 0]", coverage: "complete", background: true }
  ])("keeps only the matching foreground command receipt ($result, $coverage)", test => {
    const command = "node --test acceptance.test.mjs"
    const messages: Message[] = [
      { id: "request", role: "user", content: "Original task", created_at: new Date(1) },
      { id: "command", role: "assistant", content: "", created_at: new Date(2), tool_calls: [{
        id: "execute-call", name: "execute", args: { command, run_in_background: test.background }
      }] },
      { id: "receipt", role: "tool", tool_call_id: "execute-call", name: test.mismatchedTool ? "read_file" : "execute",
        content: test.rejected ? `Command rejected by user.${test.result}` : `Hidden stdout${test.result}`,
        created_at: new Date(3) },
      { id: "final", role: "assistant", content: "Finished", created_at: new Date(4) }
    ]
    if (test.repeated) messages.splice(3, 0, { ...messages[2], id: "repeated-receipt" })
    const process = projectWorkResultProcess({ messages, hasMore: false, beforeOrdinal: null, beforeMessageId: null,
      total: messages.length, truncatedMessageIds: test.truncatedPage ? ["receipt"] : [] }, {
      taskId: "execution", requestId: "request", finalMessageId: "final", supplementRequestIds: [], earlierExecutions: false,
      foregroundCommands: test.exitCode === undefined ? undefined : [{ callId: "execute-call", command: "node --test",
        exitCode: test.exitCode, output: "Observed test assertion", excerpt: Boolean(test.truncated) }]
    })
    expect(process.coverage).toBe(test.coverage)
    const tool = process.steps[0].tools![0]
    if (test.exitCode === undefined) {
      expect(tool.commandResult).toBeUndefined()
    } else {
      expect(tool).toMatchObject({
        status: test.exitCode === 0 ? "returned" : "error",
        commandResult: { command: "node --test", exitCode: test.exitCode }
      })
    }
    expect(JSON.stringify(process)).not.toMatch(/Hidden stdout|Observed test assertion|Command rejected by user/)
  })

  it("bounds carried choices with the current process, excluding unsubmitted and earlier tool evidence", () => {
    const previous: BotWorkResultProcess = { coverage: "partial", steps: [
      { text: "OLD PROGRESS", tools: [{ name: "read_file", status: "returned", file: "old.txt" }] },
      ...["ignored", "auto_resolved", "submitted"].map(status => ({ tools: [{
        name: "request_user_input", status: "returned" as const,
        interaction: { status, answers: [{ question: "Format?", answer: status === "submitted" ? "Brief" : "INVALID" }] }
      }] }))
    ] }
    const carried = includeWorkResultAnswers(undefined, [previous])!
    expect(carried).toMatchObject({ coverage: "partial", steps: [{ tools: [{ interaction: {
      status: "submitted", answers: [{ question: "Format?", answer: "Brief" }]
    } }] }] })
    expect(carried.steps).toHaveLength(1)
    expect(JSON.stringify(carried)).not.toMatch(/OLD PROGRESS|old.txt|INVALID/)
    const current: BotWorkResultProcess = { coverage: "partial", steps: [
      ...Array.from({ length: 10 }, () => ({ text: "x".repeat(600) })),
      { tools: [{ name: "request_user_input", status: "returned", interaction: {
        status: "submitted", answers: [{ question: "Format?", answer: "Latest choice" }]
      } }] }
    ] }
    const bounded = includeWorkResultAnswers(current, [previous])!
    expect(bounded.steps.reduce((size, step) => size + JSON.stringify(step).length + 1, 0)).toBeLessThanOrEqual(4000)
    expect(bounded.steps.at(-1)).toEqual(current.steps.at(-1))
    expect(includeWorkResultAnswers(current, [{ coverage: "unavailable", steps: [] }])).toBe(current)
  })

  it.each(["ready", "reported"])("publishes %s once without treating an unverified report as an error", async kind => {
    const pub = {
      id: "stable-result",
      workId: work.id,
      workThreadId: work.threadId,
      incarnation: incarnation(),
      kind,
      summary: "Verified",
      finalMessageId: "original-final",
      attachments: [{ finalMessageId: "original-attachment", file: { name: "report.md" } }]
    }
    const acknowledge = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const host = {
      workResultPublication: () => pub,
      getWork: () => work,
      acknowledgeWorkResultPublication: acknowledge
    } as unknown as LocalBotHost
    const signal = new AbortController().signal,
      prepare = vi.fn()
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.write.mockReturnValueOnce(1)
    await publishWorkResult(host, bot, task, signal, prepare)
    const row = f.write.mock.calls[0][1][0]
    expect(row.content).toContain("#bot-history/work/original-final/")
    expect(row.content).toContain("[report.md](#bot-history/work/original-attachment/")
    f.read.mockReturnValueOnce([row])
    await publishWorkResult(host, bot, task, signal, prepare)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.mirror.mock.calls.map(([, event]) => event.type)).toEqual(["turn-messages", "done"])
    expect(f.attention).toHaveBeenCalledTimes(1)
    expect(f.notify).toHaveBeenCalledTimes(1)
    expect(f.pet).toHaveBeenCalledTimes(kind === "ready" ? 1 : 0)
    expect(f.attention).toHaveBeenCalledWith(expect.objectContaining({ kind: "task-complete" }))
    if (kind === "reported") expect(f.notify).toHaveBeenCalledWith("Bot · 任务结果已回传", "Verified")
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it("retries an uncertain transcript write or acknowledgement without replaying the message or attention", async () => {
    const publication = {
      id: "stable-result", workId: work.id, workThreadId: work.threadId, incarnation: incarnation(),
      kind: "interrupted", summary: "已有成果待核验。", attachments: [
        { assistantMessageId: "formal-anchor", file: { name: "report.zip" } }
      ]
    }
    const acknowledge = vi.fn().mockImplementationOnce(() => { throw new Error("temporarily busy") })
      .mockReturnValueOnce(true)
    const host = { workResultPublication: () => publication, getWork: () => work,
      acknowledgeWorkResultPublication: acknowledge } as unknown as LocalBotHost
    const signal = new AbortController().signal
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    const publish = () => publishWorkResult(host, bot, task, signal, vi.fn())
    f.write.mockReturnValueOnce(0).mockReturnValueOnce(1)
    await expect(publish()).rejects.toBeInstanceOf(RetryableBotWorkPublicationError)
    expect(acknowledge).not.toHaveBeenCalled()
    await expect(publish()).rejects.toBeInstanceOf(RetryableBotWorkPublicationError)
    expect(f.attention).not.toHaveBeenCalled()
    const row = f.write.mock.calls[1][1][0]
    expect(row.content).toContain("[report.zip](#bot-history/work/formal-anchor/")
    expect(row.content).not.toContain("?attachment=")
    f.read.mockReturnValueOnce([row])
    await publish()
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(acknowledge).toHaveBeenCalledTimes(2)
    expect(f.attention).toHaveBeenCalledOnce()
    expect(f.notify).toHaveBeenCalledOnce()
  })

  it("retries a transient main-thread preparation failure before publishing the result", async () => {
    const publication = { id: task.requestId, workId: work.id, workThreadId: work.threadId,
      incarnation: incarnation(), kind: "ready", summary: "Verified", attachments: [] }
    const acknowledge = vi.fn(() => true)
    const host = { workResultPublication: () => publication, getWork: () => work,
      acknowledgeWorkResultPublication: acknowledge } as unknown as LocalBotHost
    const prepare = vi.fn().mockImplementationOnce(() => { throw new Error("Storage is temporarily unavailable") })
    const signal = new AbortController().signal
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    await expect(publishWorkResult(host, bot, task, signal, prepare)).rejects.toBeInstanceOf(RetryableBotWorkPublicationError)
    expect(f.write).not.toHaveBeenCalled()
    f.write.mockReturnValueOnce(1)
    await publishWorkResult(host, bot, task, signal, prepare)
    expect(f.write).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledOnce()
  })

  it("links each new publication attachment to its exact batch index, retaining legacy fallbacks", async () => {
    const publication = {
      id: "stable-result", workId: work.id, workThreadId: work.threadId, incarnation: incarnation(),
      kind: "ready", summary: "Verified", attachmentLinkVersion: 1,
      attachments: [
        { assistantMessageId: "batch", callId: "call/?中文)(", fileIndex: 0, file: { name: "a.md" } },
        { assistantMessageId: "batch", callId: "call/?中文)(", fileIndex: 1, file: { name: "b.md" } },
        { finalMessageId: "legacy-final", file: { name: "legacy.md" } }
      ]
    }
    const host = { workResultPublication: () => publication, getWork: () => work,
      acknowledgeWorkResultPublication: () => true } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.write.mockReturnValueOnce(1)
    await publishWorkResult(host, bot, task, new AbortController().signal, vi.fn())
    const content = f.write.mock.calls[0][1][0].content
    for (const fileIndex of [0, 1]) {
      const source = { workId: work.id, messageId: "batch", incarnation: incarnation(), callId: "call/?中文)(", fileIndex }
      const href = botWorkAttachmentHref(source)
      expect(content).toContain(href)
      expect(href).not.toMatch(/[()]/)
      expect(parseBotWorkAttachmentHref(href)).toEqual(source)
    }
    expect(content).toContain("[legacy.md](#bot-history/work/legacy-final/")
    expect(content.match(/\?attachment=/g)).toHaveLength(2)
  })

  it.each(["ready", "blocked", "interrupted"])(
    "links the %s publication's remaining files to their original batch without a final result message", async kind => {
      const publication = {
        id: "stable-result", workId: work.id, workThreadId: work.threadId, incarnation: incarnation(),
        kind, summary: "See the original work", attachments: [
          { assistantMessageId: "first-batch", file: { name: "report.zip" } }
        ], moreAttachments: { count: 2, messageId: "remaining-batch" }
      }
      const host = { workResultPublication: () => publication, getWork: () => work,
        acknowledgeWorkResultPublication: () => true } as unknown as LocalBotHost
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      f.write.mockReturnValueOnce(1)
      await publishWorkResult(host, bot, task, new AbortController().signal, vi.fn())
      const row = f.write.mock.calls[0][1][0]
      expect(row.content).toContain("[report.zip](#bot-history/work/first-batch/")
      expect(row.content).toContain("[原任务还有 2 个文件可查看，点击查看](#bot-history/work/remaining-batch/")
      expect(row.content).not.toContain("查看原任务结果")
    }
  )

  it("leaves an actual transcript identity conflict terminal", async () => {
    const acknowledge = vi.fn()
    const host = {
      workResultPublication: () => ({ id: "stable-result", workId: work.id, workThreadId: work.threadId,
        incarnation: incarnation(), kind: "ready", summary: "Verified", attachments: [] }),
      getWork: () => work,
      acknowledgeWorkResultPublication: acknowledge
    } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.read.mockReturnValueOnce([{ id: "stable-result", role: "assistant", content: "Different content" }])
    await expect(publishWorkResult(host, bot, task, new AbortController().signal, vi.fn()))
      .rejects.toMatchObject({ code: "CONFLICT" })
    expect(f.write).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })
})


it.each([false, true])("replaces echoed attachment rows once across ACK retry (previously written=%s)", async previouslyWritten => {
  const summary = "<think>PRIVATE_REASONING</think>Report ready\n\n- [report.md](" + botWorkAttachmentHref({ workId: work.id,
    messageId: "invented", incarnation: "invented", callId: "invented", fileIndex: 0 }) + ")\n\n" +
    "[查看原任务结果](" + botWorkHistoryHref({ workId: work.id, messageId: "invented", incarnation: "invented" }) + ")\n" +
    "- [report.md](" + botWorkHistoryHref({ workId: work.id, messageId: "final", incarnation: "invented" }) + ")"
  const publication = { id: "stable-result", responseMessageId: "normal-final", workId: work.id,
    workThreadId: work.threadId, incarnation: incarnation(), kind: "reported", summary, finalMessageId: "final",
    attachments: [{ assistantMessageId: "file-message", file: { name: "report.md" } }] }
  const acknowledge = vi.fn().mockImplementationOnce(() => { throw new Error("busy") })
    .mockReturnValueOnce(true).mockReturnValueOnce(false)
  let serviceEnded = false
  const getPublication = vi.fn((_id: string, refresh = false) =>
    refresh && serviceEnded ? { ...publication, responseText: publication.summary,
      summary: "Service is no longer available" } : publication)
  const host = { workResultPublication: getPublication, getWork: () => work,
    acknowledgeWorkResultPublication: acknowledge } as unknown as LocalBotHost
  let row = { id: "normal-final", role: "assistant", content: `  ${summary}\n`, created_at: new Date(1), content_priority: 3 }
  if (previouslyWritten) row.content = summary + "\n\n- [report.md](" +
    botWorkHistoryHref({ workId: work.id, messageId: "file-message", incarnation: incarnation() }) + ")\n\n" +
    "[查看原任务结果](" + botWorkHistoryHref({ workId: work.id, messageId: "final", incarnation: incarnation() }) + ")"
  f.read.mockImplementation((_thread, ids) => ids?.includes(row.id) ? [row] : [])
  f.write.mockImplementation((_thread, rows) => { row = rows[0]; return 1 })
  claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
  const publish = () => publishWorkResult(host, bot, task, new AbortController().signal, vi.fn())
  await expect(publish()).rejects.toBeInstanceOf(RetryableBotWorkPublicationError)
  serviceEnded = true
  getPublication.mockClear()
  await publish()
  await publish()
  expect(getPublication.mock.calls.every(call => call[1] !== true)).toBe(true)
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.write.mock.calls[0][1][0]).toMatchObject({ content_mode: "snapshot", content_priority: 3 })
  expect(row.id).toBe("normal-final")
  expect(row.created_at).toEqual(new Date(1))
  expect(row.content.match(/\[report.md\]/g)).toHaveLength(1)
  expect(row.content).not.toContain("invented")
  expect(f.mirror.mock.calls[0][1].messages[0].id).toBe("normal-final")
  expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.notify).toHaveBeenCalledWith("Bot · 任务结果已回传", "Report ready")
  expect(f.invoke).not.toHaveBeenCalled()
  f.write.mockReset(); f.read.mockReset()
})

it.each(["missing", "changed", "wrong-role"])("refuses a %s normal reply rather than inserting a replacement", async state => {
  const acknowledge = vi.fn()
  const host = { workResultPublication: () => ({ id: "stable-result", responseMessageId: "normal-final",
    workId: work.id, workThreadId: work.threadId, incarnation: incarnation(), kind: "reported",
    summary: "Report ready", attachments: [] }), getWork: () => work,
    acknowledgeWorkResultPublication: acknowledge } as unknown as LocalBotHost
  f.read.mockReturnValue(state === "missing" ? [] : [{ id: "normal-final",
    role: state === "wrong-role" ? "user" : "assistant", content: state === "changed" ? "Edited" : "Report ready" }])
  claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
  await expect(publishWorkResult(host, bot, task, new AbortController().signal, vi.fn())).rejects.toThrow("原正常回复已变化")
  expect(f.write).not.toHaveBeenCalled()
  expect(acknowledge).not.toHaveBeenCalled()
})


it("allows optional evidence reads without any private model invocation", async () => {
  const host = { workResultReview: () => ({ ...context(), services: { items: [{ id: "old-ready", ready: true }] } }) } as unknown as LocalBotHost
  claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
  const access = createWorkResultEvidenceAccess(host, bot, task, new AbortController().signal)
  expect([...access.serviceIds]).toEqual([])
  const catalogue = access.reader.list()
  const command = catalogue.items.find(item => item.kind === "text")!
  expect(command).toBeDefined()
  const read = await access.reader.read(command.id, { signal: new AbortController().signal })
  expect(read).toMatchObject({ status: "ok", text: expect.stringContaining("1 test passed") })
  expect(f.invoke).not.toHaveBeenCalled()
})


it("deduplicates delivered filenames pointing at the current final message, preserving other evidence", () => {
  const href = botWorkHistoryHref({ workId: work.id, messageId: "final", incarnation: "model-supplied" })
  const earlier = botWorkHistoryHref({ workId: work.id, messageId: "earlier", incarnation: "original" })
  const foreign = botWorkHistoryHref({ workId: "other", messageId: "final", incarnation: "original" })
  const publication = { finalMessageId: "final", attachments: [{ sourceTaskId: "task", callId: "files", fileIndex: 0,
    file: { name: "report.md", filePath: "/report.md", size: 1 } }] }
  const retained = `[测试记录](${href})\n- [report.md](${earlier})\n- [report.md](${foreign})\n参考 [report.md](${href})\n    [report.md](${href})`
  expect(normalWorkResultSummary(`- [report.md](${href})\n${retained}`, work.id, publication)).toBe(retained)
  expect(normalWorkResultSummary(`[report.md](${href})`, work.id, { ...publication, attachments: [] }))
    .toBe(`[report.md](${href})`)
})

it("removes echoed escaped attachment labels without removing other citations", () => {
  const href = botWorkAttachmentHref({ workId: work.id, messageId: "old", incarnation: "old", callId: "files", fileIndex: 0 })
  const foreign = botWorkAttachmentHref({ workId: "other", messageId: "old", incarnation: "old", callId: "files", fileIndex: 0 })
  const citation = `[测试记录](${botWorkHistoryHref({ workId: work.id, messageId: "test", incarnation: "original" })})`
  expect(normalWorkResultSummary(`完成\n- [报告\\[最终\\].md](${href})\n${citation}\n[其他成果](${foreign})`, work.id))
    .toBe(`完成\n${citation}\n[其他成果](${foreign})`)
})


it.each(["```", "~~~~"])("preserves attachment syntax in %s fenced and indented examples", fence => {
  const href = botWorkAttachmentHref({ workId: work.id, messageId: "m", incarnation: "i", callId: "c", fileIndex: 0 })
  const link = `[example.md](${href})`
  const text = `链接格式示例：\n${fence}markdown\n${link}\n${fence}\n\n    ${link}\n\t${link}`
  expect(normalWorkResultSummary(text, work.id)).toBe(text)
  expect(normalWorkResultSummary(`${text}\n- ${link}`, work.id)).toBe(text)
})

it.each(["1.", "2)", "123456789."])("deduplicates %s formal attachment rows without stripping numbered citations", marker => {
  const href = botWorkAttachmentHref({ workId: work.id, messageId: "old", incarnation: "old", callId: "files", fileIndex: 0 })
  const foreign = botWorkAttachmentHref({ workId: "other", messageId: "old", incarnation: "old", callId: "files", fileIndex: 0 })
  const citation = `${marker} [测试记录](${botWorkHistoryHref({ workId: work.id, messageId: "test", incarnation: "original" })})`
  const result = `${marker} [查看原任务结果](${botWorkHistoryHref({ workId: work.id, messageId: "old", incarnation: "old" })})`
  const retained = `${citation}\n${marker} [其他成果](${foreign})\n\n    ${marker} [代码示例](${href})`
  expect(normalWorkResultSummary(`${marker} [report.md](${href})\n${result}\n${retained}`, work.id)).toBe(retained)
})
