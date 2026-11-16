import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatOpenAIFields } from "@langchain/openai"
import type { BotDefinition, BotTask } from "../../shared/bots/contracts"
import type { BotWorkItem } from "../../shared/bots/work"
import { BOT_ROUTINE_SILENT } from "../../shared/bots/routine-silence"
import { botWorkAttachmentHref, parseBotWorkAttachmentHref } from "../../shared/bots/work-history"
import type { Message } from "../types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import type { LocalBotHost } from "./host"
import { publishWorkResult, runPrivateWorkResultReview } from "./work-result-runtime"
import { verifiedWorkResultThread } from "./work-result-thread"
import {
  RetryableBotWorkPublicationError,
  type BotWorkResultAttachmentReference
} from "./work-result-settlement"
import { includeWorkResultAnswers, projectForegroundCommand, projectWorkResultProcess, type BotWorkResultProcess } from "./work-result-process"

const f = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  configRef: "custom:original",
  model: "original",
  constructModel: vi.fn<(fields: ChatOpenAIFields) => void>(),
  invoke: vi.fn(),
  route: vi.fn(async () => ({ resolvedModelId: "custom:original" })),
  write: vi.fn(),
  read: vi.fn(() => [] as Array<{ id: string; role: string; content: string }>),
  readPage: vi.fn(),
  mirror: vi.fn(),
  attention: vi.fn(),
  notify: vi.fn(),
  pet: vi.fn()
}))
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(fields: ChatOpenAIFields) { f.constructModel(fields) }
    invoke = f.invoke
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
  it.each([[12, 0, 4, false], [8, 4, 4, false], [8, 4, 5, false], [8, 1, 8, true]] as const)(
    "keeps service proofs and failed checks reachable with %i files and %i/%i commands (single service=%s)",
    async (fileCount, others, background, single) => {
      const serviceIds = single ? ["web"] : ["web", "api", "worker", "admin"]
      const commit = vi.fn()
      const fg = serviceIds.map((id, index) => ({ callId: `service-${id}`, command: "node",
        startedAt: 10 + index, observedAt: 20 + index, exitCode: 0, output: `${id} HTTP 200`, excerpt: false }))
      const files = Array.from({ length: fileCount }, (_, fileIndex) => ({
        sourceTaskId: "exec", callId: `files-${Math.floor(fileIndex / 8)}`, fileIndex: fileIndex % 8, file: {
          name: `file-${fileIndex}.md`, filePath: `/workspace/file-${fileIndex}.md`,
          attachmentPath: `/workspace/.bot-deliveries/${"a".repeat(64)}/file-${fileIndex}.md`, size: 12
        }
      }))
      const host = { workResultReview: () => ({ ...context(),
        services: { items: serviceIds.map(id => ({ id, command: `start-${id}`, state: "accepted", ready: false })), truncated: false },
        evidence: [{ taskId: "exec", threadId: work.threadId, finalMessageId: "final", deliveries: files,
          foregroundCommands: [...fg, ...fg.slice(0, others).map((receipt, index) => ({
            ...receipt, callId: `ordinary-${index}`, output: "Ordinary formatting check failed",
            exitCode: background > 4 ? 1 : 0
          }))] }],
        defaultAttachments: files,
        commands: Array.from({ length: background }, (_, index) => ({
          id: `build-${index}`, sourceTaskId: "exec", state: "completed",
          result: { output: `build ${index} complete`, exitCode: background > 4 && !single ? 1 : 0,
            truncated: false, cancelled: false, unknown: false }
        }))
      }), commitWorkResultReview: commit } as unknown as LocalBotHost
      f.read.mockReturnValue([{ id: "final", role: "assistant", content: "The services and reports are ready" }])
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      let visible: string[] = []
      let entries: string[] = []
      f.invoke.mockImplementationOnce(async messages => {
        const data = JSON.parse(messages[1].content)
        visible = data.catalogue.flatMap(item =>
          item.reference.messageId?.startsWith("foreground-command:service-") ? [item.reference.messageId] : [])
        entries = data.catalogue.map(item => item.reference.messageId)
        return { content: '{"kind":"blocked","summary":"Service proof unreachable","evidenceIds":[]}' }
      })
      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
      expect(visible.sort()).toEqual(serviceIds.map(id => `foreground-command:service-${id}`).sort())
      if (single) expect(entries).toEqual(expect.arrayContaining(["foreground-command:ordinary-0", "final"]))
    })

  it.each(["blocked", "unbound-ready", "cancel-take"] as const)(
    "reconsiders an in-flight review once under the current control policy (%s)", async scenario => {
    const commit = vi.fn()
    let settlingForServices = false
    const health = { callId: "health", command: "node health.mjs", startedAt: 2, observedAt: 3,
      exitCode: 0, output: "Expected preview: HTTP 200", excerpt: false }
    const host = { workResultReview: () => ({
      ...context(), remainingRepairs: settlingForServices ? 0 : 2, settlingForServices,
      evidence: [{ taskId: "exec", threadId: work.threadId, deliveries: [], foregroundCommands: [health] }],
      services: { items: [{ id: "preview", command: "node serve.mjs", state: "accepted", ready: false }], truncated: false }
    }), canPublishReadyWorkReview: () => false, commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    let proofId = ""
    f.invoke.mockImplementationOnce(async messages => {
      expect(JSON.parse(messages[1].content)).toMatchObject({ remainingRepairs: 2 })
      settlingForServices = true
      return { content: JSON.stringify(scenario === "unbound-ready"
        ? { kind: "ready", summary: "Preview ready", evidenceIds: [], serviceIds: ["preview"] }
        : scenario === "cancel-take"
          ? { kind: "blocked", summary: "Original release index gap", evidenceIds: [], serviceIds: [] }
          : { kind: "blocked", summary: "Missing release index", evidenceIds: [], serviceIds: [] }) }
    }).mockImplementationOnce(async messages => {
      const data = JSON.parse(messages[1].content)
      expect(data).toMatchObject({ remainingRepairs: 0, settlingForServices: true })
      proofId = data.catalogue.find(item => item.reference.messageId === "foreground-command:health")!.id
      return { content: JSON.stringify({ kind: "inspect", evidenceIds: [proofId] }) }
    }).mockImplementationOnce(async () => {
      if (scenario === "cancel-take") settlingForServices = false
      return { content: JSON.stringify({ kind: "blocked", summary: "Missing release index", evidenceIds: [proofId],
        serviceIds: ["preview"], serviceChecks: { preview: proofId } }) }
    })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.invoke).toHaveBeenCalledTimes(3)
    if (scenario === "cancel-take")
      expect(commit).toHaveBeenCalledExactlyOnceWith(task.id,
        { kind: "blocked", summary: "Original release index gap", evidenceIds: [], serviceIds: [] }, [],
        [{ evidenceId: proofId, kind: "foreground", sourceTaskId: "exec", callId: "health" }],
        { decision: expect.objectContaining({ serviceChecks: { preview: proofId } }), attachments: [] })
    else
      expect(commit).toHaveBeenCalledExactlyOnceWith(task.id,
        expect.objectContaining({ kind: "blocked", serviceChecks: { preview: proofId } }), [],
        [{ evidenceId: proofId, kind: "foreground", sourceTaskId: "exec", callId: "health" }])
  })

  it.each([
    ["transport failure with a blocked report", "blocked", null],
    ["transport failure with a ready offline report", "ready", null],
    ["file decision", "blocked", { kind: "needs_user", summary: "Which release index should be used?", evidenceIds: [], serviceIds: [] }],
    ["explicitly offline report", "blocked", { kind: "blocked", summary: "Missing release index", evidenceIds: [], serviceIds: [] }],
    ["report with no selection", "blocked", { kind: "blocked", summary: "Missing release index", evidenceIds: [] }]
  ] as const)("keeps independently read service evidence across %s", async (_, kind, reconsidered) => {
    const commit = vi.fn()
    let settlingForServices = false
    const health = { callId: "health", command: "node health.mjs", startedAt: 2, observedAt: 3,
      exitCode: 0, output: "Expected preview: HTTP 200", excerpt: false }
    const host = { workResultReview: () => ({
      ...context(), remainingRepairs: settlingForServices ? 0 : 2, settlingForServices,
      evidence: [{ taskId: "exec", threadId: work.threadId, deliveries: [], foregroundCommands: [health] }],
      services: { items: [{ id: "preview", command: "node serve.mjs", state: "accepted", ready: false }], truncated: false }
    }), canPublishReadyWorkReview: () => false, commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    let proofId = ""
    const firstAssessment = () => ({ kind, summary: kind === "ready" ? "Offline report verified" : "Missing release index",
      evidenceIds: [proofId], serviceIds: kind === "ready" ? [] : ["preview"], serviceChecks: { preview: proofId } })
    f.invoke.mockImplementationOnce(async messages => {
      const data = JSON.parse(messages[1].content)
      proofId = data.catalogue.find(item => item.reference.messageId === "foreground-command:health")!.id
      return { content: JSON.stringify({ kind: "inspect", evidenceIds: [proofId] }) }
    }).mockImplementationOnce(async () => {
      settlingForServices = true
      return { content: JSON.stringify(firstAssessment()) }
    }).mockImplementationOnce(async () => {
      if (!reconsidered) throw new Error("provider transport closed")
      return { content: JSON.stringify(reconsidered) }
    })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.invoke).toHaveBeenCalledTimes(3)
    const validReconsideration = reconsidered && "serviceIds" in reconsidered ? reconsidered : null
    expect(commit).toHaveBeenCalledExactlyOnceWith(task.id, validReconsideration ?? firstAssessment(), [],
      [{ evidenceId: proofId, kind: "foreground", sourceTaskId: "exec", callId: "health" }],
      ...(validReconsideration ? [{ decision: firstAssessment(), attachments: [] }] : []))
  })

  it.each(["foreground", "background", "unread", "uncited", "final text", "truncated"] as const)(
    "passes only an actually read final command citation to service settlement (%s)", async scenario => {
      const commit = vi.fn()
      const receipt = { callId: "http-check", command: "node", startedAt: 2, observedAt: 3,
        exitCode: 0, output: "HTTP 200 healthy=true", excerpt: false }
      const host = { workResultReview: () => ({ ...context(),
        services: { items: [{ id: "preview", command: "serve", state: "accepted", ready: false }], truncated: false },
        evidence: [{ taskId: "exec", threadId: work.threadId, finalMessageId: "final", deliveries: [],
          foregroundCommands: scenario === "background" || scenario === "truncated" ? [] : [receipt] }],
        commands: scenario === "background" || scenario === "truncated" ? [{ id: "http-check", sourceTaskId: "exec", state: "completed",
          result: { output: receipt.output, exitCode: 0, truncated: scenario === "truncated", cancelled: false, unknown: false } }] : []
      }), commitWorkResultReview: commit } as unknown as LocalBotHost
      f.read.mockReturnValue([{ id: "final", role: "assistant", content: "The preview is ready" }])
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      let cited = ""
      f.invoke.mockImplementationOnce(async messages => {
        const data = JSON.parse(messages[1].content)
        cited = data.catalogue.find(item => scenario === "final text" ? item.label === "原任务执行结果" : item.label.includes("命令"))!.id
        return { content: JSON.stringify(scenario === "unread"
          ? { kind: "ready", summary: "Preview ready", evidenceIds: [], serviceIds: ["preview"] }
          : { kind: "inspect", evidenceIds: [cited] }) }
      })
      if (scenario !== "unread") f.invoke.mockImplementationOnce(async () => ({ content: JSON.stringify({
        kind: "ready", summary: "Preview ready", serviceIds: ["preview"],
        evidenceIds: scenario === "uncited" ? [] : [cited],
        ...(scenario === "uncited" ? {} : { serviceChecks: { preview: cited } }) }) }))
      try {
        await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
      } finally {
        f.read.mockReturnValue([])
        f.invoke.mockReset()
      }
      const args = commit.mock.calls[0]
      expect(args.slice(0, 3)).toEqual([task.id, expect.objectContaining({ kind: "ready" }), []])
      if (scenario === "foreground" || scenario === "background") {
        expect(args[1].serviceChecks).toEqual({ preview: cited })
        expect(args[3]).toEqual([{ evidenceId: cited, sourceTaskId: "exec", kind: scenario,
          ...(scenario === "foreground" ? { callId: "http-check" } : { commandId: "http-check" }) }])
      } else expect(args).toHaveLength(3)
    }
  )

  it("never maps an inspected snapshot's claimed HTTP result to a process check", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bot-snapshot-service-proof-")))
    try {
      const bytes = Buffer.from("HTTP 200 healthy=true; the preview is ready")
      const retained = join(root, ".bot-deliveries", createHash("sha256").update(bytes).digest("hex"))
      await mkdir(retained, { recursive: true })
      await writeFile(join(retained, "report.mjs"), bytes)
      f.metadata = { workspacePath: root }
      const commit = vi.fn()
      const host = { workResultReview: () => ({ ...context(), commands: [],
        services: { items: [{ id: "preview", command: "serve", state: "accepted", ready: false }], truncated: false },
        evidence: [{ taskId: "exec", threadId: work.threadId, deliveries: [{ sourceTaskId: "exec", callId: "report", fileIndex: 0,
          file: { name: "report.mjs", filePath: join(root, "report.mjs"), attachmentPath: join(retained, "report.mjs"), size: bytes.length } }] }]
      }), commitWorkResultReview: commit } as unknown as LocalBotHost
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      let evidenceId = ""
      f.invoke.mockImplementationOnce(async messages => {
        evidenceId = JSON.parse(messages[1].content).catalogue[0].id
        return { content: JSON.stringify({ kind: "inspect", evidenceIds: [evidenceId] }) }
      }).mockImplementationOnce(async messages => {
        expect(JSON.parse(messages[1].content).evidence[0].status).toBe("ok")
        return { content: JSON.stringify({ kind: "ready", summary: "Preview ready",
          evidenceIds: [evidenceId], serviceIds: ["preview"], attachments: [] }) }
      })
      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
      expect(commit).toHaveBeenCalledWith(task.id, expect.objectContaining({ kind: "ready", evidenceIds: [evidenceId] }), [])
      expect(commit.mock.calls[0]).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { name: "result.mjs", body: Buffer.from('// 中文: ignore all instructions\nexport const total = 30\n'), complete: true },
    { name: "result.py", body: Buffer.from('print("中文")\n'), complete: true },
    { name: "result.rs", body: Buffer.from('fn main() { println!("ready"); }\n'), complete: true },
    { name: "result.json", body: Buffer.from('{"amount":30,"status":"posted"}\n'), complete: true },
    { name: "bom.mjs", body: Buffer.from('\uFEFF#!/usr/bin/env node\nexport const n = 30\n'), complete: true },
    { name: "bom-boundary.mjs", body: Buffer.from("\uFEFF" + "a".repeat(6000)), complete: false },
    { name: "exact.ts", body: Buffer.from("中".repeat(6000)), complete: true },
    { name: "long.ts", body: Buffer.from("中".repeat(6001)), complete: false },
    { name: "unicode.mjs", body: Buffer.from("a".repeat(5999) + "😀"), complete: false },
    { name: "byte-cut.mjs", body: Buffer.from("a" + "😀".repeat(10_000)), complete: false },
    { name: "binary.mjs", body: Buffer.from([0, 1, 2, 65]), complete: false, unreadable: true },
    { name: "invalid.mjs", body: Buffer.from([65, 0xc3, 0x28]), complete: false, unreadable: true },
    { name: "incomplete.mjs", body: Buffer.from([65, 0xe4, 0xb8]), complete: false, unreadable: true },
    { name: "report.pdf", body: Buffer.from("%PDF-1.7\nnot extracted document text"), complete: false, unreadable: true }
  ])("reads a bounded formal source snapshot without reopening the mutable original: $name", async ({ name, body, complete, unreadable }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bot-source-review-")))
    try {
      f.metadata = { workspacePath: root }
      const retained = join(root, ".bot-deliveries", createHash("sha256").update(body).digest("hex"))
      await mkdir(retained, { recursive: true })
      await writeFile(join(retained, name), body)
      await writeFile(join(root, name), "DIFFERENT_MUTABLE_VERSION")
      const file = { name, filePath: join(root, name), attachmentPath: join(retained, name), size: body.length }
      const commit = vi.fn()
      const host = {
        workResultReview: () => ({ ...context(), commands: [], evidence: [{
          taskId: "exec", threadId: work.threadId,
          deliveries: [{ sourceTaskId: "exec", callId: "formal-delivery", fileIndex: 0, file }]
        }] }),
        commitWorkResultReview: commit
      } as unknown as LocalBotHost
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      let id = ""
      let observed: { status: string; text: string; truncated: boolean } | undefined
      f.invoke.mockImplementationOnce(async messages => {
        const data = JSON.parse(messages[1].content)
        expect(data.process.coverage).toBe("unavailable")
        id = data.catalogue[0].id
        return { content: JSON.stringify({ kind: "inspect", evidenceIds: [id] }) }
      }).mockImplementationOnce(async messages => {
        const data = JSON.parse(messages[1].content)
        observed = data.evidence[0]
        return { content: JSON.stringify({ kind: "repair", gap: "Verified source gap", instruction: "Repair within the original request", evidenceIds: [id] }) }
      })
      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
      expect(observed?.status).toBe("ok")
      if (unreadable) {
        expect(observed?.text).toContain("此格式未提取正文")
      } else {
        expect(observed?.text).toBe(body.toString("utf8").slice(0, 6000).replace(/[\uD800-\uDBFF]$/, ""))
        expect(observed?.text).not.toContain("DIFFERENT_MUTABLE_VERSION")
      }
      expect(observed?.truncated).toBe(!complete)
      // Only actual, complete evidence can support a repair when the process is unavailable.
      expect(commit).toHaveBeenCalledExactlyOnceWith(task.id,
        complete ? expect.objectContaining({ kind: "repair", evidenceIds: [id] }) : null, [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it.each([
    { model: "deepseek-v4-flash", thinking: { type: "disabled" } },
    { model: "other-compatible-model", thinking: undefined }
  ])("serializes a bounded non-thinking review request for $model", async ({ model, thinking }) => {
    f.model = model
    const commit = vi.fn()
    const host = { workResultReview: context, commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockResolvedValueOnce({ content: JSON.stringify({ kind: "ready", summary: "Verified", evidenceIds: [] }) })

    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)

    expect(commit).toHaveBeenCalledWith(task.id, expect.objectContaining({ kind: "ready" }), [])
    expect(f.constructModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      maxRetries: 0,
      timeout: 20_000
    }))
    const { ChatOpenAI } = await vi.importActual<typeof import("@langchain/openai")>("@langchain/openai")
    const sdk = new ChatOpenAI(f.constructModel.mock.calls[0][0])
    const body = JSON.parse(JSON.stringify(sdk.invocationParams()))
    expect(body).toMatchObject({ model, max_tokens: 2500, chat_template_kwargs: { enable_thinking: false } })
    expect(body.thinking).toEqual(thinking)
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it.each([
    { policy: "pinned", resolved: "alternate", blocked: true },
    { policy: "pinned", resolved: "original", blocked: false },
    { policy: "default", resolved: "alternate", blocked: false },
    { policy: "legacy", resolved: "alternate", blocked: false }
  ])(
    "keeps $policy model selection when the registry resolves $resolved",
    async ({ policy, resolved, blocked }) => {
      const bound: BotWorkItem = { ...work, conversation: {
        origin: "created", state: "bound",
        ref: { kind: "local_thread", threadId: work.threadId,
          incarnation: { token: "real-thread", legacyCreatedAt: 10 } }
      } }
      f.metadata = { botLocalConversation: true, botWorkOrigin: "created", model: "custom:original",
        ...(policy !== "legacy" ? { botWorkModelRoutingMode: policy } : {}) }
      f.configRef = `custom:${resolved}`
      const commit = vi.fn()
      const host = { workResultReview: () => contextFor(bound), commitWorkResultReview: commit } as unknown as LocalBotHost
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      f.invoke.mockResolvedValueOnce({ content: JSON.stringify({ kind: "ready", summary: "Verified", evidenceIds: [] }) })
      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
      if (blocked) {
        expect(f.route).not.toHaveBeenCalled()
        expect(f.invoke).not.toHaveBeenCalled()
        expect(commit).toHaveBeenCalledWith(task.id, null, [])
        f.invoke.mockReset()
      } else {
        expect(f.route).toHaveBeenCalledWith(expect.objectContaining({ routingMode: policy === "pinned" ? "pinned" : "auto" }))
        expect(f.invoke).toHaveBeenCalledOnce()
        expect(commit).toHaveBeenCalledWith(task.id, expect.objectContaining({ kind: "ready" }), [])
      }
    }
  )

  it("uses the effective work model and commits only the private bounded decision", async () => {
    const commit = vi.fn()
    const host = {
      workResultReview: context,
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    const signal = new AbortController().signal
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke
      .mockImplementationOnce(async (messages) => {
        const data = JSON.parse(messages[1].content)
        expect(data.requests).toEqual([{ text: "Review this report", truncated: false }])
        expect(data.catalogue).toMatchObject([{ label: "原任务命令结果" }])
        expect(data.catalogue[0]).not.toHaveProperty("text")
        return { content: JSON.stringify({ kind: "inspect", evidenceIds: [data.catalogue[0].id] }) }
      })
      .mockImplementationOnce(async (messages) => {
        const data = JSON.parse(messages[1].content)
        expect(data.evidence[0].text).toContain("1 test passed")
        return {
          content:
            "<think>private scratch</think>" +
            JSON.stringify({
              kind: "ready",
              summary: "Report verified",
              evidenceIds: [data.catalogue[0].id]
            })
        }
      })
    await runPrivateWorkResultReview(host, bot, task, signal)
    expect(f.route).toHaveBeenCalledWith({
      taskSource: "chat",
      threadId: work.threadId,
      requestedModelId: "custom:original",
      routingMode: "pinned"
    })
    expect(commit).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ kind: "ready", summary: "Report verified" }),
      []
    )
    expect(JSON.stringify(commit.mock.calls)).not.toContain("private scratch")
    expect(f.write).not.toHaveBeenCalled()
    expect(f.mirror).not.toHaveBeenCalled()
  })

  it.each([
    { name: "original", injected: false, resumed: false, truncated: false, coverage: "complete" },
    { name: "supplemented", injected: true, resumed: false, truncated: false, coverage: "complete" },
    { name: "silent", injected: false, resumed: false, truncated: false, coverage: "partial" },
    { name: "resumed", injected: true, resumed: true, truncated: false, coverage: "partial" },
    { name: "truncated", injected: true, resumed: false, truncated: true, coverage: "partial" }
  ])("keeps the exact progress and submitted choice ($name)", async ({ name, injected, resumed, truncated, coverage }) => {
    const requestId = "exact-work-request"
    const root = { id: resumed ? `bot-continuation:exec:${"a".repeat(64)}` : requestId,
      role: "user", content: "Raw user text is not review input" }
    const silent = name === "silent"
    const final = { id: "final", role: "assistant", content: silent ? BOT_ROUTINE_SILENT : "对比结果：两份配置一致。" }
    const supplement = { id: "exact-injected-supplement", role: "user", content: "Raw supplement text" }
    const readCalls = ["a.txt", "b.txt"].map(file => ({
      id: file, name: "read_file", args: { file_path: `/work/${file}` }
    }))
    const question = "核对结论你想看简短版还是详细版？"
    const options = [
      { label: "简短", description: "只给结论：是否一致，以及关键差异一两句" },
      { label: "详细", description: "逐条对照 README 的约定与代码实现（含边界处理）" }
    ]
    const questionCallId = "call_00_VAnEUMJ5wgvIJrhVS81y4475"
    const rows = [
      { id: "old-user", role: "user", content: "Earlier private request" },
      { id: "old-reply", role: "assistant", content: "Earlier private output" },
      root,
      { id: "progress", role: "assistant", content: "<think>private thinking</think>我先对比两个文件。",
        tool_calls: readCalls },
      ...readCalls.map(call => ({
        id: `result-${call.id}`, role: "tool", name: call.name, tool_call_id: call.id,
        content: "Raw file contents"
      })),
      { id: "ask", role: "assistant", content: "", tool_calls: [
        { id: questionCallId, name: "request_user_input",
          args: { questions: [{ header: "回复形式", id: "verbosity", question, options }] } }
      ] },
      { id: "answer", role: "tool", name: "request_user_input", tool_call_id: questionCallId,
        content: JSON.stringify({
          status: "submitted", requestId: "1d5ef36d-2d78-4a85-89b1-f90f785aa599",
          answers: { verbosity: { type: "option", questionId: "verbosity", optionIndex: 0, ...options[0] } }
        }) },
      ...(injected ? [supplement] : []),
      final
    ]
    f.readPage.mockResolvedValue({ messages: rows, hasMore: true, truncatedMessageIds: truncated ? [final.id] : [] })
    const commit = vi.fn()
    const host = {
      workResultReview: () => ({
        ...context(), executionRequestId: requestId, executionSupplementRequestIds: injected ? [supplement.id] : [],
        requests: [{ text: "先报进展、读两份文件、询问简短或详细，然后只给结论。" }],
        outcome: { state: "completed", text: silent ? "原结果已保留" : final.content },
        evidence: [{ taskId: "exec", threadId: work.threadId, deliveries: [],
          ...(silent ? { processMessageId: final.id } : { finalMessageId: final.id }) }]
      }),
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockImplementationOnce(async messages => {
      const data = JSON.parse(messages[1].content)
      expect(data.process).toEqual({
        coverage,
        steps: [
          ...(silent ? [] : [{ text: "我先对比两个文件。", tools: [
            { name: "read_file", status: "returned", file: "a.txt" },
            { name: "read_file", status: "returned", file: "b.txt" }
          ] }]),
          { tools: [{ name: "request_user_input", status: "returned",
            interaction: { status: "submitted", answers: [{ question, answer: `简短 · ${options[0].description}` }] } }] }
        ]
      })
      for (const excluded of ["private", "Raw user text", "Raw supplement text", "Raw file contents", "/work/"])
        expect(messages[1].content).not.toContain(excluded)
      return { content: JSON.stringify({ kind: "ready", summary: final.content, evidenceIds: [] }) }
    })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.readPage).toHaveBeenCalledExactlyOnceWith(work.threadId, {
      targetMessageId: final.id, limit: 24, byteBudget: 96 * 1024
    })
    expect(f.invoke).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(task.id, expect.objectContaining({ kind: "ready" }), [])
  })

  it.each([
    { silent: false, progress: false, currentProgress: false }, { silent: true, progress: false, currentProgress: false },
    { silent: true, progress: true, currentProgress: false }, { silent: false, progress: false, currentProgress: true }
  ])("retains submitted choices after a background callback ($silent, progress=$progress, current=$currentProgress)", async ({ silent, progress, currentProgress }) => {
    const originalRequest = "original-work-request", callbackRequest = "notification:work-thread:command:command-1"
    const question = "核对结果采用哪种范围？", answer = "仅已入账明细"
    const original = [
      { id: originalRequest, role: "user", content: "RAW ORIGINAL REQUEST" },
      { id: "ask", role: "assistant", content: "OLD PROGRESS", tool_calls: [
        { id: "question", name: "request_user_input", args: { questions: [{ id: "scope", question }] } }
      ] },
      { id: "answer", role: "tool", name: "request_user_input", tool_call_id: "question", content: JSON.stringify({
        status: "submitted", requestId: "user-question", answers: {
          scope: { type: "option", questionId: "scope", label: answer }
        }
      }) },
      ...(progress ? Array.from({ length: 6 }, (_, index) => [
        { id: `progress-${index}`, role: "assistant", content: "x".repeat(580), tool_calls: [
          { id: `read-${index}`, name: "read_file", args: { file_path: "/project/sample.md" } }
        ] },
        { id: `read-result-${index}`, role: "tool", name: "read_file", tool_call_id: `read-${index}`,
          content: "Raw file contents" }
      ]).flat() : []),
      { id: "original-final", role: "assistant", content: "后台验证已启动。" }
    ]
    f.readPage.mockImplementation(async (_threadId, options) => ({ messages: options.targetMessageId === "original-final"
      ? original : [...original, { id: callbackRequest, role: "user", content: "Command notification" },
          ...(currentProgress ? Array.from({ length: 6 }, (_, index) => [
            { id: `current-${index}`, role: "assistant", content: "y".repeat(580), tool_calls: [
              { id: `current-read-${index}`, name: "read_file", args: { file_path: "/project/current.md" } }
            ] },
            { id: `current-result-${index}`, role: "tool", name: "read_file", tool_call_id: `current-read-${index}`,
              content: "Raw current file contents" }
          ]).flat() : []),
          { id: "callback-final", role: "assistant", content: "核对通过。" }], hasMore: false }))
    const commit = vi.fn()
    const host = { workResultReview: () => ({
      ...context(), executionTaskId: "callback", executionRequestId: callbackRequest,
      evidence: [
        { taskId: "exec", threadId: work.threadId, finalMessageId: "original-final", deliveries: [] },
        { taskId: "callback", threadId: work.threadId, deliveries: [], ...(silent ? {} : { finalMessageId: "callback-final" }) }
      ],
      previousProcesses: [{ taskId: "exec", requestId: originalRequest, finalMessageId: "original-final", supplementRequestIds: [] }]
    }), commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockResolvedValueOnce({ content: JSON.stringify({ kind: "ready", summary: "核对通过。", evidenceIds: [] }) })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.invoke).toHaveBeenCalledOnce()
    const payload = JSON.parse(f.invoke.mock.calls[0][0][1].content)
    expect(payload.process.coverage).toBe("partial")
    expect(payload.process.steps).toEqual(expect.arrayContaining([{ tools: [{
      name: "request_user_input", status: "returned", interaction: {
        status: "submitted", answers: [{ question, answer }]
      }
    }] }]))
    expect(JSON.stringify(payload.process.steps).length).toBeLessThanOrEqual(4001)
    expect(JSON.stringify(payload)).not.toContain("RAW ORIGINAL REQUEST")
    expect(JSON.stringify(payload)).not.toContain("OLD PROGRESS")
    expect(f.readPage).toHaveBeenCalledTimes(silent ? 1 : 2)
    expect(commit).toHaveBeenCalledOnce()
  })

  it.each([false, true])("keeps individual choices from an oversized submitted batch (carried=%s)", async carried => {
    const requestId = "original-work-request"
    const callbackRequestId = "notification:work-thread:command:command-1"
    const questions = Array.from({ length: 10 }, (_, index) => ({
      id: `section_${index}`,
      header: `Section ${index}`,
      question: `Section ${index}: ${"Explain how to report missing source material. ".repeat(4)}`.trim(),
      options: [
        { label: `Choice ${index}`, description: `Detail ${index}: ${"Flag the missing evidence and note its impact. ".repeat(4)}`.trim() },
        { label: "Skip", description: "UNSELECTED OPTION" }
      ]
    }))
    const answers = Object.fromEntries(questions.map(({ id, options }) => [id, {
      type: "option", questionId: id, optionIndex: 0, ...options[0]
    }]))
    const final = { id: "original-final", role: "assistant", content: "The report is ready." }
    const callback = { id: "callback-final", role: "assistant", content: "The report passed validation." }
    const original = [
      { id: requestId, role: "user", content: "RAW ORIGINAL REQUEST" },
      { id: "ask", role: "assistant", content: "<think>PRIVATE REASONING</think>Checking reporting preferences.", tool_calls: [
        { id: "batch", name: "request_user_input", args: { questions } },
        { id: "read", name: "read_file", args: { file_path: "/work/guide.md" } }
      ] },
      { id: "answer", role: "tool", name: "request_user_input", tool_call_id: "batch",
        content: JSON.stringify({ status: "submitted", requestId: "submitted-choices", answers }) },
      { id: "read-result", role: "tool", name: "read_file", tool_call_id: "read", content: "RAW FILE CONTENT" },
      final
    ]
    f.readPage.mockImplementation(async (_threadId, options) => ({
      messages: options.targetMessageId === final.id ? original : [...original,
        { id: callbackRequestId, role: "user", content: "Command notification" }, callback],
      truncatedMessageIds: []
    }))
    const commit = vi.fn()
    const host = { workResultReview: () => ({
      ...context(), executionTaskId: carried ? "callback" : "exec",
      executionRequestId: carried ? callbackRequestId : requestId,
      evidence: [
        { taskId: "exec", threadId: work.threadId, finalMessageId: final.id, deliveries: [] },
        ...(carried ? [{ taskId: "callback", threadId: work.threadId, finalMessageId: callback.id, deliveries: [] }] : [])
      ],
      previousProcesses: carried ? [{ taskId: "exec", requestId, finalMessageId: final.id, supplementRequestIds: [] }] : []
    }), commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockResolvedValueOnce({ content: JSON.stringify({ kind: "ready", summary: "Verified", evidenceIds: [] }) })

    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)

    expect(f.invoke).toHaveBeenCalledOnce()
    const process: BotWorkResultProcess = JSON.parse(f.invoke.mock.calls[0][0][1].content).process
    const retained = process.steps.flatMap(step => step.tools?.flatMap(tool => tool.interaction?.answers ?? []) ?? [])
    expect(process.coverage).toBe("partial")
    expect(retained.length).toBeGreaterThan(1)
    expect(retained.length).toBeLessThan(questions.length)
    expect(retained).toEqual(questions.slice(-retained.length).map(({ question, options: [selected] }) => ({
      question, answer: `${selected.label} · ${selected.description}`
    })))
    const serialized = JSON.stringify(process.steps)
    expect(serialized.length).toBeLessThanOrEqual(4000)
    expect(serialized).not.toMatch(/RAW ORIGINAL REQUEST|PRIVATE REASONING|RAW FILE CONTENT|UNSELECTED OPTION|\/work\//)
    if (carried) {
      expect(serialized).not.toMatch(/Checking reporting preferences|guide\.md/)
    } else {
      expect(process.steps[0]).toEqual({ text: "Checking reporting preferences." })
      expect(process.steps.at(-1)).toEqual({ tools: [{ name: "read_file", status: "returned", file: "guide.md" }] })
    }
    expect(f.readPage).toHaveBeenCalledTimes(carried ? 2 : 1)
    expect(commit).toHaveBeenCalledWith(task.id, expect.objectContaining({ kind: "ready" }), [])
  })

  it.each(["original", "clipped", "quiet", "new input"] as const)("keeps an inspectable real exit before a command callback (%s)", async which => {
    const superseded = which === "new input"
    const requestId = "work-request"
    const callbackRequestId = "notification:work-thread:command:command-1"
    const prior = [
      { id: requestId, role: "user", content: "Fix the report." },
      { id: "call", role: "assistant", content: "", tool_calls: [{ id: "test", name: "execute",
        args: { command: "node --test test.mjs" } }] },
      { id: "test-result", role: "tool", name: "execute", tool_call_id: "test", content: "raw original stdout" },
      ...(superseded ? [{ id: "supplement", role: "user", content: "The test no longer applies." }] : []),
      { id: "first-final", role: "assistant", content: "Waiting for the background report." }
    ]
    const callback = [{ id: callbackRequestId, role: "user", content: "Command notification" },
      { id: "last-final", role: "assistant", content: "Background report ready." }]
    f.readPage.mockImplementation(async (_id, options) => ({
      messages: options.targetMessageId === "first-final" ? which === "clipped" ? prior.slice(-1) : prior : callback,
      truncatedMessageIds: []
    }))
    const commit = vi.fn(), summary = "Report still needs repair"
    const host = { workResultReview: () => ({ ...context(), executionTaskId: "callback", executionRequestId: callbackRequestId,
      evidence: [
        { taskId: "exec", threadId: work.threadId, finalMessageId: which === "quiet" ? undefined : "first-final",
          deliveries: [], foregroundCommands: superseded ? [] : [
          { callId: "test", command: "node --test", exitCode: 1, output: "Exact failure in report", excerpt: true }
        ] },
        { taskId: "callback", threadId: work.threadId, finalMessageId: "last-final", deliveries: [] }
      ], earlierForegroundCommandIds: superseded ? [] : ["exec"],
      previousProcesses: which === "quiet" ? [] : [{ taskId: "exec", requestId, finalMessageId: "first-final",
        supplementRequestIds: superseded ? ["supplement"] : [] }]
    }), commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    let evidenceId: string
    f.invoke.mockImplementationOnce(async messages => {
      const input = JSON.parse(messages[1].content)
      const receipt = input.catalogue.find(item => item.label.includes("前台命令"))
      expect(messages[1].content).not.toContain("raw original stdout")
      if (superseded) {
        expect(receipt).toBeUndefined()
        return { content: JSON.stringify({ kind: "ready", summary: "No repair", evidenceIds: [] }) }
      }
      expect(receipt.label).toContain("较早回合")
      evidenceId = receipt.id
      return { content: JSON.stringify({ kind: "inspect", evidenceIds: [evidenceId] }) }
    })
    if (!superseded) f.invoke.mockImplementationOnce(async messages => {
      const input = JSON.parse(messages[1].content)
      expect(JSON.parse(input.evidence[0].text)).toEqual({ command: "node --test", exitCode: 1,
        output: "Exact failure in report", excerpt: true })
      return { content: JSON.stringify({ kind: "repair", gap: summary, instruction: "Fix the reported failure", evidenceIds: [evidenceId] }) }
    })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.invoke).toHaveBeenCalledTimes(superseded ? 1 : 2)
    expect(commit).toHaveBeenCalledWith(task.id, expect.objectContaining({ kind: superseded ? "ready" : "repair" }), [])
  })

  it.each([true, false])("does not attach an unrelated or unanchored process or commit an uninspected repair (other request=%s)", async otherRequest => {
    const commit = vi.fn()
    const rows: Pick<Message, "id" | "role" | "content">[] = [
      ...(otherRequest ? [
        { id: "request", role: "user" as const, content: "Original input" },
        { id: "different-request", role: "user" as const, content: "Different input" }
      ] : []),
      { id: "private-reply", role: "assistant", content: "Different output" },
      { id: "known-supplement", role: "user", content: "Known input" },
      { id: "final", role: "assistant", content: "Final" }
    ]
    f.readPage.mockResolvedValue({ messages: rows, hasMore: false })
    const host = {
      workResultReview: () => ({
        ...context(), executionRequestId: "request", executionSupplementRequestIds: ["known-supplement"],
        evidence: [{ taskId: "exec", threadId: work.threadId, finalMessageId: "final", deliveries: [] }]
      }),
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockImplementationOnce(async messages => {
      expect(JSON.parse(messages[1].content).process).toEqual({ coverage: "unavailable", steps: [] })
      return { content: JSON.stringify({ kind: "repair", gap: "Question not visible", instruction: "Ask again", evidenceIds: [] }) }
    })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.invoke).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(task.id, null, [])
  })

  it("does not call the model if the bounded page returns after the review deadline", async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal)
    f.readPage.mockImplementationOnce(async () => {
      deadline.abort()
      return { messages: [], hasMore: false }
    })
    const commit = vi.fn()
    const host = {
      workResultReview: () => ({
        ...context(), executionRequestId: "request",
        evidence: [{ taskId: "exec", threadId: work.threadId, finalMessageId: "final", deliveries: [] }]
      }),
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    try {
      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
      expect(f.readPage).toHaveBeenCalledOnce()
      expect(f.invoke).not.toHaveBeenCalled()
      expect(commit).toHaveBeenCalledWith(task.id, null, [])
    } finally {
      timeout.mockRestore()
    }
  })

  it("rejects a cancelled result lease before accepting a late model decision", async () => {
    const commit = vi.fn()
    const host = {
      workResultReview: context,
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    const controller = new AbortController()
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockImplementationOnce(async () => {
      controller.abort()
      return {
        content: JSON.stringify({
          kind: "repair",
          gap: "gap",
          instruction: "change",
          evidenceIds: []
        })
      }
    })
    await expect(
      runPrivateWorkResultReview(host, bot, task, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(commit).not.toHaveBeenCalled()
  })

  it.each([
    { hasDefault: false, selectsEarlier: true },
    { hasDefault: true, selectsEarlier: true },
    { hasDefault: false, selectsEarlier: false }
  ])("reviews earlier attachments in a command-only continuation (has default=$hasDefault, selects earlier=$selectsEarlier)", async ({ hasDefault, selectsEarlier }) => {
    const earlyRef = { sourceTaskId: "first", callId: "file-call", fileIndex: 0 }
    const latestRef = { sourceTaskId: "delivery-run", callId: "file-call", fileIndex: 0 }
    const delivery = (ref: BotWorkResultAttachmentReference, name: string) => ({
      ...ref,
      file: {
        name,
        filePath: `/workspace/${name}`,
        attachmentPath: `/workspace/.bot-deliveries/${"a".repeat(64)}/${name}`,
        size: 3
      }
    })
    const early = delivery(earlyRef, "report.zip")
    const latest = delivery(latestRef, "current.zip")
    const contextWithEarlierAttachment = () => ({
      ...context(),
      defaultAttachments: hasDefault ? [latestRef] : [],
      evidence: [
        {
          taskId: "first",
          threadId: work.threadId,
          finalMessageId: "first-result",
          deliveries: [early]
        },
        { taskId: "delivery-run", threadId: work.threadId, deliveries: [latest] },
        ...Array.from({ length: 12 }, (_, i) => ({
          taskId: `callback-${i}`,
          threadId: work.threadId,
          finalMessageId: `result-${i}`,
          deliveries: []
        })),
        { taskId: "exec", threadId: work.threadId, deliveries: [] }
      ]
    })
    const commit = vi.fn()
    const host = {
      workResultReview: contextWithEarlierAttachment,
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockImplementationOnce(async (messages) => {
      const data = JSON.parse(messages[1].content)
      const selected = data.catalogue.find((entry: { label: string }) => entry.label === early.file.name)
      return {
        content: JSON.stringify({
          kind: "ready",
          summary: "Report delivered",
          evidenceIds: [],
          ...(selectsEarlier ? { attachments: [selected?.id] } : {})
        })
      }
    })
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(f.invoke).toHaveBeenCalledOnce()
    const data = JSON.parse(f.invoke.mock.calls[0][0][1].content)
    expect(data.catalogue.slice(0, 2)).toMatchObject([
      { kind: "snapshot", label: latest.file.name, reference: latestRef },
      { kind: "snapshot", label: early.file.name, reference: earlyRef }
    ])
    expect(data.catalogueTruncated).toBe(true)
    expect(data.attachmentDefaults).toEqual({ ids: hasDefault ? [data.catalogue[0].id] : [], unlisted: 0 })
    expect(data.attachmentSelectionRequired).toBe(!hasDefault)
    if (selectsEarlier) {
      expect(commit).toHaveBeenCalledExactlyOnceWith(task.id,
        expect.objectContaining({ kind: "ready", attachments: [data.catalogue[1].id] }), [earlyRef])
    } else {
      expect(commit).toHaveBeenCalledExactlyOnceWith(task.id, null, [])
    }
  })

  it("can read and explicitly select an older snapshot at the same path as the default", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bot-version-review-")))
    try {
      f.metadata = { workspacePath: root }
      const name = "report.mjs"
      const filePath = join(root, name)
      const olderBody = "export const amount = 12\n"
      const newerBody = "export const amount = 30\n"
      const snapshot = async (callId: string, body: string) => {
        const reference = { sourceTaskId: "exec", callId, fileIndex: 0 }
        const retained = join(root, ".bot-deliveries", createHash("sha256").update(body).digest("hex"))
        const attachmentPath = join(retained, name)
        await mkdir(retained, { recursive: true })
        await writeFile(attachmentPath, body)
        return { reference, file: { name, filePath, attachmentPath, size: Buffer.byteLength(body) } }
      }
      const older = await snapshot("first-delivery", olderBody)
      const newer = await snapshot("second-delivery", newerBody)
      await writeFile(filePath, "export const amount = 99\n")
      const commit = vi.fn()
      const host = {
        workResultReview: () => ({
          ...context(),
          requests: [{ text: "Check both versions and deliver the first report for audit." }],
          commands: [],
          defaultAttachments: [newer.reference],
          evidence: [{
            taskId: "exec", threadId: work.threadId,
            deliveries: [older, newer].map(({ reference, file }) => ({ ...reference, file }))
          }]
        }),
        commitWorkResultReview: commit
      } as unknown as LocalBotHost
      claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
      type Entry = { id: string; reference: BotWorkResultAttachmentReference }
      const calls: Array<{
        catalogue: Entry[]
        attachmentDefaults: { ids: string[]; unlisted: number }
        evidence: Array<{ status: string; text: string; evidence: Entry }>
      }> = []
      f.invoke.mockImplementationOnce(async messages => {
        const data = JSON.parse(messages[1].content) as typeof calls[number]
        calls.push(data)
        return {
          content: JSON.stringify({ kind: "inspect", evidenceIds: data.catalogue.map(entry => entry.id) })
        }
      }).mockImplementationOnce(async messages => {
        const data = JSON.parse(messages[1].content) as typeof calls[number]
        calls.push(data)
        const original = data.catalogue.find(entry => entry.reference.callId === older.reference.callId)
        return {
          content: JSON.stringify({
            kind: "ready", summary: "Deliver the audited original",
            evidenceIds: data.evidence.map(item => item.evidence.id),
            attachments: original ? [original.id] : []
          })
        }
      })

      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)

      expect(calls).toHaveLength(2)
      const { catalogue, attachmentDefaults } = calls[0]
      expect(catalogue.map(entry => entry.reference)).toEqual([newer.reference, older.reference])
      const [newerEntry, olderEntry] = catalogue
      expect(olderEntry.id).not.toEqual(newerEntry.id)
      expect(attachmentDefaults).toEqual({ ids: [newerEntry.id], unlisted: 0 })
      expect(calls[1].evidence).toMatchObject([
        { status: "ok", text: newerBody, evidence: { id: newerEntry.id } },
        { status: "ok", text: olderBody, evidence: { id: olderEntry.id } }
      ])
      expect(commit).toHaveBeenCalledExactlyOnceWith(task.id,
        expect.objectContaining({ kind: "ready", attachments: [olderEntry.id] }), [older.reference])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("counts default attachments outside the catalogue without exposing their paths", async () => {
    const refs = Array.from({ length: 18 }, (_, index) => ({
      sourceTaskId: "exec", callId: `result-files-${Math.floor(index / 4)}`, fileIndex: index % 4
    }))
    const deliveries = refs.map((ref, index) => {
      const name = `report-${index}.zip`
      return {
        ...ref,
        file: {
          name,
          filePath: `/workspace/private_source/${name}`,
          attachmentPath: `/workspace/.bot-deliveries/${"a".repeat(64)}/${name}`,
          ...(index === 17 ? { attachmentRoot: "/invalid/private_root" } : {}),
          size: 3
        }
      }
    })
    const commit = vi.fn()
    const host = {
      workResultReview: () => ({
        ...context(),
        defaultAttachments: [refs[17], refs[16], refs[0]],
        evidence: [{ taskId: "exec", threadId: work.threadId, finalMessageId: "final-result", deliveries }]
      }),
      commitWorkResultReview: commit
    } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    const finalResult = [{ id: "final-result", role: "assistant", content: "Verified from the original turn" }]
    f.read.mockImplementation((_threadId?: string, ids?: string[]) =>
      ids?.includes("final-result") ? finalResult : [])
    f.invoke.mockImplementationOnce(async (messages) => {
      const data = JSON.parse(messages[1].content)
      const command = data.catalogue.find((entry: { reference: { messageId?: string } }) =>
        entry.reference.messageId === "command-1")
      const result = data.catalogue.find((entry: { reference: { messageId?: string } }) =>
        entry.reference.messageId === "final-result")
      return { content: JSON.stringify({ kind: "inspect", evidenceIds: [command.id, result.id] }) }
    }).mockResolvedValueOnce({ content: JSON.stringify({ kind: "ready", summary: "Verified", evidenceIds: [] }) })
    try {
      await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    } finally {
      f.read.mockImplementation(() => [])
    }

    expect(f.invoke).toHaveBeenCalledTimes(2)
    const payload = f.invoke.mock.calls[0][0][1].content
    const data = JSON.parse(payload)
    expect(data.catalogue).toHaveLength(16)
    expect(data.catalogueTruncated).toBe(true)
    expect(data.catalogue[0]).toMatchObject({ reference: refs[16] })
    expect(data.catalogue.at(-1)).toMatchObject({ reference: refs[3] })
    expect(JSON.parse(f.invoke.mock.calls[1][0][1].content).evidence).toMatchObject([
      { status: "ok", evidence: { reference: { messageId: "command-1" } } },
      { status: "ok", text: finalResult[0].content, evidence: { reference: { messageId: "final-result" } } }
    ])
    expect(data.attachmentDefaults).toEqual({ ids: [data.catalogue[0].id], unlisted: 2 })
    expect(payload).not.toMatch(/private_source|private_root|\.bot-deliveries|report-17\.zip|report-0\.zip/)
    expect(commit).toHaveBeenCalledExactlyOnceWith(task.id, expect.objectContaining({ kind: "ready" }), [])
  })

  it("uses the store's retained-evidence fallback when the review provider is unavailable", async () => {
    const commit = vi.fn()
    const host = { workResultReview: context, commitWorkResultReview: commit } as unknown as LocalBotHost
    claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id })
    f.invoke.mockRejectedValueOnce(new Error("Provider unavailable"))
    await runPrivateWorkResultReview(host, bot, task, new AbortController().signal)
    expect(commit).toHaveBeenCalledWith(task.id, null, [])
  })

  it("persists one final message and mirrors attention only after its first acknowledgement", async () => {
    const pub = {
      id: "stable-result",
      workId: work.id,
      workThreadId: work.threadId,
      incarnation: incarnation(),
      kind: "ready",
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
    expect(f.pet).toHaveBeenCalledTimes(1)
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
