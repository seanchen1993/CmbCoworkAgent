import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { ToolMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerAgentRunImplementation,
  startAgentRun,
  type AgentRunDelivery,
  type AgentRunExecutionContext
} from "../agent/agent-run-service"
import {
  botTaskAcceptsUserInput,
  botGroupBrowserScope,
  botTaskGroupId,
  type BotDefinition,
  type BotTask
} from "../../shared/bots/contracts"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import { isBotGroupPass } from "../../shared/bots/group-discussion"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { isBotRoutineSilent } from "../../shared/bots/routine-silence"
import { hasBotWorkflowCapability } from "../../shared/bots/workflow-capability"
import { botWorkResultLabel } from "../../shared/bots/work-result"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../../shared/internal-notification-turn"
import { MAIN_TURN_ONLY_TOOL_METADATA_KEY } from "../agent/runtime-tool-catalog"
import { canDeferBotTask } from "../bots/continuation"
import { snapshotBotDeliveryFile } from "../bots/file-copy"
import { createBotGroupDeliveryCheck, createBotGroupMessageTool } from "../bots/group-delivery"
import type { BotRunPort, LocalBotHost } from "../bots/host"
import { botTextOnlyRemotePolicy } from "../bots/mock-runtime-policy"
import { resolveBotWorkspaceFile } from "../bots/workspace-file"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { notifyIfBackground } from "../services/notify"
import { openStableFileHandle } from "../services/stable-file-handle"

const desktop = vi.hoisted(() => ({
  focused: false,
  supported: true,
  calls: [] as Array<{ title: string; body: string }>
}))
vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => (desktop.focused ? { isFocused: () => true } : null)
  },
  Notification: class {
    static isSupported() {
      return desktop.supported
    }
    constructor(private options: { title: string; body: string }) {}
    show() {
      desktop.calls.push(this.options)
    }
  }
}))

function source(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(resolve(process.cwd(), relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
}
function nodes<T extends ts.Node>(file: ts.SourceFile, select: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node) => {
    if (select(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
function transpile(code: string): string {
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText
}
function functions(file: ts.SourceFile, names: string[]): string {
  return names
    .map((name) => {
      const declarations = nodes(file, ts.isFunctionDeclaration).filter(
        (node) => node.name?.text === name
      )
      expect(declarations).toHaveLength(1)
      return declarations[0].getText(file).replace(/^export\s+/, "")
    })
    .join("\n")
}

const native = source("src/main/ipc/agent.ts")
const adapter = source("src/main/bots/runtime-adapter.ts")
function nativeGuard(name: string, title?: string): string {
  const guard = (call: ts.CallExpression): ts.Node => {
    let node: ts.Node = call
    while (node.parent && !ts.isIfStatement(node)) node = node.parent
    return ts.isIfStatement(node) ? node : call.parent
  }
  const calls = nodes(native, ts.isCallExpression).filter(
    (call) =>
      ts.isIdentifier(call.expression) &&
      call.expression.text === name &&
      (name !== "emitAppAttention" ||
        /invokeFinalOutcome|shouldRaiseCompletionAttention/.test(guard(call).getText(native))) &&
      (!title || (ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === title))
  )
  expect(calls).toHaveLength(1)
  return guard(calls[0]).getText(native)
}
const attentionDecision = nodes(native, ts.isVariableDeclaration).find(
  (node) => node.name.getText(native) === "shouldRaiseCompletionAttention"
)
const internalTurn = nodes(native, ts.isVariableDeclaration).find(
  (node) => node.name.getText(native) === "isBotInternalTurnInvoke"
)!
const workflowInvoke = nodes(native, ts.isVariableDeclaration).find(
  (node) => node.name.getText(native) === "isWorkflowNotificationInvoke"
)!
const isWorkflowNotificationTurnMessage = runInNewContext(
  transpile(
    `(${functions(source("src/main/agent/workflow/notification.ts"), ["isWorkflowNotificationTurnMessage"])})`
  ),
  { WORKFLOW_NOTIFICATION_TURN_PROMPT }
) as (message: string) => boolean
const nativeCompletion = transpile(
  [
    attentionDecision ? `const ${attentionDecision.getText(native)};` : "",
    nativeGuard("emitAppAttention"),
    nativeGuard("showPetCompletedTaskNotice"),
    nativeGuard("notifyIfBackground", "✅ 任务完成")
  ].join("\n")
)
const nativeFailure = transpile(nativeGuard("notifyIfBackground", "❌ 任务失败"))

// Execute the actual adapter factory, while replacing only infrastructure outside
// this policy boundary (thread preparation, leases, model, renderer and tool catalog).
const adapterFactory = transpile(
  `(function() { ${functions(adapter, ["createLocalBotRunPort", "memoryUserText"])}; return createLocalBotRunPort; })()`
)
const fileTools = source("src/main/bots/tools.ts")
const createDeliveryTools = runInNewContext(
  transpile(`(function() {
  ${functions(fileTools, ["assertParentBot", "verifyBotDeliveryFiles", "createBotDeliveryTools", "createBotFileTools"])}
  return createBotDeliveryTools;
})()`),
  {
    tool,
    z,
    ToolMessage,
    basename,
    isAbsolute,
    getHookAgentIdFromRequest,
    MAIN_TURN_ONLY_TOOL_METADATA_KEY,
    resolveBotWorkspaceFile,
    openStableFileHandle,
    snapshotBotDeliveryFile
  }
) as typeof import("../bots/tools").createBotDeliveryTools

let workspace: string
beforeEach(() => {
  desktop.focused = false
  desktop.supported = true
  desktop.calls.length = 0
  workspace = mkdtempSync(join(tmpdir(), "bot-completion-attention-"))
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

type CompletionOptions = {
  source?: AgentRunExecutionContext["source"]
  state?: "completed" | "failed" | "outcome_unknown"
  origin?: BotTask["origin"]
  workId?: string
  result?: string
  message?: string
  publicText?: string
  deliverFile?: boolean
  internal?: boolean
  veto?: () => boolean
}

/** Real adapter context -> real AgentRunService -> exact native completion guards.
 * Model execution and native UI rendering are deliberately outside this fixture. */
async function complete({
  source: runSource,
  state = "completed",
  origin = { kind: "user" },
  workId,
  result = "Verified result",
  message = "Synthetic request",
  publicText,
  deliverFile,
  internal = false,
  veto
}: CompletionOptions = {}) {
  const attention = vi.fn()
  const pet = vi.fn()
  const finish = vi.fn()
  const send = vi.fn()
  const publishedText = vi.fn(() => ({ groupId: "synthetic-group", messageId: "sent-message" }))
  const publishedFiles = vi.fn()
  const seen: AgentRunExecutionContext[] = []
  const bot: BotDefinition = {
    id: "synthetic-bot",
    threadId: "synthetic-thread",
    hostId: "local",
    name: "Synthetic Bot",
    color: "#123456",
    instructions: "Review",
    modelRef: "synthetic-model",
    archived: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const task: BotTask = {
    id: "synthetic-task",
    botId: bot.id,
    threadId: bot.threadId,
    requestId: "synthetic-request",
    message,
    origin,
    ...(workId ? { workId } : {}),
    state: "running",
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
  registerAgentRunImplementation(async (request, delivery, context) => {
    seen.push(context)
    // These are real tools obtained from the adapter's actual additionalTools wiring.
    // A pass receipt must not fire sent(); a successful public post must fire it.
    if (publicText !== undefined) {
      const entry = context.additionalTools?.find(
        (candidate) => candidate.name === "bot_send_message"
      )
      expect(entry).toBeDefined()
      const receipt = await entry!.invoke({
        type: "tool_call",
        id: "send-call",
        name: "bot_send_message",
        args: { content: publicText }
      })
      expect(ToolMessage.isInstance(receipt) && receipt.status === "error").toBe(false)
    }
    if (deliverFile) {
      writeFileSync(join(workspace, "report.csv"), "item,value\nchecks,1\n")
      const entry = context.additionalTools?.find(
        (candidate) => candidate.name === "bot_deliver_files"
      )
      expect(entry).toBeDefined()
      const receipt = await entry!.invoke({
        type: "tool_call",
        id: "file-call",
        name: "bot_deliver_files",
        args: { files: ["report.csv"], ...(botTaskGroupId(task) ? { content: "" } : {}) }
      })
      expect(ToolMessage.isInstance(receipt)).toBe(true)
      expect(parseBotFileDelivery(String((receipt as ToolMessage).content))).toHaveLength(1)
    }
    await context.onFinalAssistant?.({ messageId: "synthetic-final", finalText: result })
    context.onRunTerminated?.({
      outcome: state === "completed" ? "success" : state === "failed" ? "error" : "unknown",
      code: "synthetic-terminal",
      ...(state !== "completed" ? { message: result } : {})
    })
    const environment = {
      runExecutionContext: context,
      invokeFinalOutcome:
        state === "completed" ? "success" : state === "failed" ? "error" : "unknown",
      lastFinalText: result,
      postRunAssistantText: "",
      errMsg: result,
      threadId: request.threadId,
      turnState: { turnId: "synthetic-turn" },
      thread: { title: "Synthetic" },
      message: request.message,
      getCompletedTaskTitle: () => "Synthetic",
      emitAppAttention: attention,
      showPetCompletedTaskNotice: pet,
      notifyIfBackground,
      isBotCheckpointResumeInvoke: false,
      continueBotTaskCheckpointId: context.continueBotTaskCheckpointId,
      initialInvokeMetadata: { botId: bot.id, botHostId: "local" }
    }
    let isInternal =
      internal || runInNewContext(internalTurn.initializer!.getText(native), environment)
    if (context.workflowInternalNotification) {
      const recognized = runInNewContext(workflowInvoke.initializer!.getText(native), {
        ...environment,
        messageControlsEnabled: true,
        initialInvokeAgentMode: "normal",
        workflowNotificationClaim: context.botWorkflowNotification,
        isWorkflowNotificationTurnMessage,
        hasBotWorkflowCapability
      })
      expect(recognized).toBe(true)
      // Begin after native accepted the pending workflow claim and built its
      // summary, where agent.ts sets isInternalNotificationTurn = true.
      // Manager claim/build/ack and physical tray attention are outside this fixture.
      isInternal = true
    }
    runInNewContext(nativeCompletion + (state === "failed" ? nativeFailure : ""), {
      ...environment,
      isInternalNotificationTurn: isInternal
    })
    delivery.send("synthetic-stream", { type: state === "completed" ? "done" : "error" })
  })
  const delivery = {
    window: {} as AgentRunDelivery["window"],
    send,
    isAvailable: () => true,
    finish
  }
  let settled:
    | Awaited<ReturnType<NonNullable<ReturnType<BotRunPort["acquire"]>>["execute"]>>
    | undefined
  if (runSource === "bot") {
    const host = {
      getBot: () => bot,
      getWork: () => ({ threadId: "synthetic-work-thread" }),
      commandLifecycle: () => ({ accepted: vi.fn(), settled: vi.fn() }),
      taskCheckpoint: () => undefined,
      profileContinuationRequest: () => null,
      onSteeringReady: vi.fn(),
      stoppedTaskContext: () => [],
      publishGroupMessage: publishedText,
      publishGroupFiles: publishedFiles,
      peers: () => []
    } as unknown as LocalBotHost
    const emptyTools = () => []
    const factory = runInNewContext(adapterFactory, {
      startAgentRun,
      notifyIfBackground,
      botWorkResultLabel,
      isBotRoutineSilent,
      isBotGroupPass,
      splitBotInlineReasoning,
      botTaskGroupId,
      botGroupBrowserScope,
      botTaskAcceptsUserInput,
      canDeferBotTask,
      parseBotFileDelivery,
      botTextOnlyRemotePolicy,
      coordinatorWorkerManager: { hasAutoRunnableNotifications: () => true },
      localBotWorkspaces: {},
      claimLocalThreadRunLease: () => ({ acquired: true }),
      prepareBotThread: () => workspace,
      localWorkFileQueue: () => bot.id,
      subscribePendingUserInput: () => () => {},
      AsyncLocalStorageProviderSingleton: {
        getInstance: () => ({ run: (_value: unknown, execute: () => unknown) => execute() })
      },
      announceManagedTurnUserMessage: vi.fn(),
      createManagedTransportAgentRunDelivery: () => delivery,
      botModelId: () => bot.modelRef,
      getThreadCore: () => ({
        metadata: JSON.stringify({ botId: bot.id, botHostId: "local" })
      }),
      getAgentModeFromMetadata: () => "normal",
      hasBotWorkflowCapability,
      createBotMcpScope: () => ({}),
      getGlobalMcpCapabilityService: () => ({}),
      isMemoryEnabled: () => false,
      buildBotPrompt: () => "Synthetic prompt",
      buildBotStoppedTaskPrompt: () => "",
      mentionedBotContext: () => "",
      createBotGroupDeliveryCheck,
      createBotGroupMessageTool,
      createBotDeliveryTools: createDeliveryTools,
      createBotWorkTools: emptyTools,
      createBotReactionTools: emptyTools,
      createBotProfileTools: emptyTools,
      createBotMemoryTools: emptyTools,
      createBotBrowserTools: emptyTools,
      createBotCollaborationTools: emptyTools,
      createBotScheduleTools: emptyTools
    }) as (...args: unknown[]) => BotRunPort
    const port = factory(
      { editVersion: () => 1, forPrompt: () => [] },
      () => host,
      {},
      { enqueue: vi.fn() }
    )
    const acquired = port.acquire(bot, task)
    expect(acquired).not.toBeNull()
    settled = await acquired!.execute(new AbortController().signal, vi.fn())
    expect(settled.state).toBe(state)
    if (
      settled.state !== "completed" &&
      settled.state !== "failed" &&
      settled.state !== "outcome_unknown"
    )
      throw new Error(`Unexpected fixture settlement: ${settled.state}`)
    port.onSettled?.(task, settled.state, settled.result, settled.files)
  } else {
    const context =
      runSource || veto
        ? {
            source: runSource ?? "desktop",
            ...(veto ? { shouldRaiseCompletionAttention: veto } : {})
          }
        : undefined
    const handle = await startAgentRun(
      { threadId: task.threadId, message: task.message },
      delivery,
      context
    )
    await handle.completion
  }
  expect(seen).toHaveLength(1)
  expect(seen[0].source).toBe(runSource ?? "desktop")
  expect(finish).toHaveBeenCalledExactlyOnceWith(task.threadId)
  expect(send).toHaveBeenCalledTimes(1)
  return {
    notifications: [...desktop.calls],
    attention,
    pet,
    settled,
    context: seen[0],
    publishedText,
    publishedFiles
  }
}
function expectAttention(completion: Awaited<ReturnType<typeof complete>>, count: number) {
  expect({
    tray: completion.attention.mock.calls.length,
    pet: completion.pet.mock.calls.length
  }).toEqual({ tray: count, pet: count })
}

const schedule: BotTask["origin"] = { kind: "schedule", scheduleId: "synthetic-routine" }
const discussion: BotTask["origin"] = {
  kind: "discussion",
  groupId: "synthetic-group",
  messageId: "synthetic-message",
  round: 1
}
const command: BotTask["origin"] = {
  kind: "notification",
  notificationKind: "command",
  key: "synthetic-command",
  commandSucceeded: true
}
const workflow: BotTask["origin"] = {
  kind: "notification",
  notificationKind: "workflow",
  key: "wf-synthetic",
  runStartedAt: "2026-10-26T00:00:00.000Z"
}

describe("Bot notification ownership at the native run boundary", () => {
  it("keeps a successful quiet routine silent at all completion attention exits", async () => {
    const completion = await complete({
      source: "bot",
      origin: schedule,
      result: "BOT_ROUTINE_SILENT"
    })
    expect(completion.notifications).toEqual([])
    expectAttention(completion, 0)
    expect(completion.settled?.result).toBe("BOT_ROUTINE_SILENT")
  })
  it.each(["completed", "failed"] as const)("notifies a normal Bot %s once", async (state) => {
    const completion = await complete({ source: "bot", state })
    expect(completion.notifications).toEqual([
      {
        title: `Synthetic Bot · ${state === "completed" ? "工作已完成" : "需要你查看"}`,
        body: "返回 Bots 工作区查看结果。"
      }
    ])
    expectAttention(completion, state === "completed" ? 1 : 0)
  })
  it.each(["Verified command result", "BOT_ROUTINE_SILENT\nNew command result"])(
    "notifies a private command's new result once: %s",
    async (result) => {
      const completion = await complete({ source: "bot", origin: command, result })
      expect(completion.notifications).toEqual([
        { title: "Synthetic Bot · 工作已完成", body: "返回 Bots 工作区查看结果。" }
      ])
      expect(completion.settled).toMatchObject({ state: "completed", result })
      expectAttention(completion, 0)
    }
  )
  it("keeps a verified successful command with only the strict no-change marker silent", async () => {
    const completion = await complete({
      source: "bot",
      origin: command,
      result: "BOT_ROUTINE_SILENT"
    })
    expect(completion.notifications).toEqual([])
    expectAttention(completion, 0)
  })
  it("notifies a real private command file despite its strict no-change final", async () => {
    const completion = await complete({
      source: "bot",
      origin: command,
      result: "BOT_ROUTINE_SILENT",
      deliverFile: true
    })
    expect(completion.notifications).toHaveLength(1)
    expect(completion.settled?.files).toHaveLength(1)
    expect(readFileSync(completion.settled!.files![0].attachmentPath!, "utf8")).toBe(
      "item,value\nchecks,1\n"
    )
    expectAttention(completion, 0)
  })
  it.each([false, undefined])(
    "does not suppress an unsuccessful or unverified command (%s) with a silence marker",
    async (commandSucceeded) => {
      const completion = await complete({
        source: "bot",
        origin: { ...command, commandSucceeded },
        result: "BOT_ROUTINE_SILENT"
      })
      expect(completion.notifications).toEqual([
        { title: "Synthetic Bot · 需要你查看", body: "返回 Bots 工作区查看结果。" }
      ])
      expect(completion.settled?.state).toBe("completed")
      expectAttention(completion, 0)
    }
  )
  it("notifies a nonzero command result without changing the reporting turn's state", async () => {
    const completion = await complete({
      source: "bot",
      origin: { ...command, commandSucceeded: false },
      result: "Command failed with exit code 1"
    })
    expect(completion.notifications).toEqual([
      { title: "Synthetic Bot · 需要你查看", body: "返回 Bots 工作区查看结果。" }
    ])
    expect(completion.settled).toMatchObject({
      state: "completed",
      result: "Command failed with exit code 1"
    })
    expectAttention(completion, 0)
  })
  it.each(["failed", "outcome_unknown"] as const)(
    "notifies a private command whose reporting turn is %s despite a silence marker",
    async (state) => {
      const completion = await complete({
        source: "bot",
        origin: command,
        state,
        result: "BOT_ROUTINE_SILENT"
      })
      expect(completion.notifications).toEqual([
        { title: "Synthetic Bot · 需要你查看", body: "返回 Bots 工作区查看结果。" }
      ])
      expect(completion.settled?.state).toBe(state)
      expectAttention(completion, 0)
    }
  )
  it.each([command, workflow])(
    "leaves an independent work $notificationKind receipt's single notification to work_result",
    async (origin) => {
      const execution = await complete({
        source: "bot",
        origin,
        message:
          origin.notificationKind === "workflow" ? WORKFLOW_NOTIFICATION_TURN_PROMPT : undefined,
        workId: "synthetic-work"
      })
      expect(execution.notifications).toEqual([])
      expectAttention(execution, 0)
      const report = await complete({
        source: "bot",
        origin: {
          kind: "work_result",
          workId: "synthetic-work",
          workTitle: "Synthetic work",
          workThreadId: "synthetic-work-thread",
          executionTaskId: "synthetic-execution",
          executionState: "failed"
        }
      })
      expect(report.notifications).toEqual([
        { title: "Synthetic Bot · 任务执行失败", body: "返回 Bots 工作区查看结果。" }
      ])
    }
  )
  it.each([command, workflow])(
    "keeps a group $notificationKind receipt's public text and file under the existing group policy",
    async (origin) => {
      const completion = await complete({
        source: "bot",
        origin: { ...origin, groupId: "synthetic-group" },
        message:
          origin.notificationKind === "workflow" ? WORKFLOW_NOTIFICATION_TURN_PROMPT : undefined,
        publicText: "Verified public command result",
        deliverFile: true
      })
      expect(completion.publishedText).toHaveBeenCalledExactlyOnceWith(
        "synthetic-task",
        "send-call",
        "Verified public command result"
      )
      expect(completion.publishedFiles).toHaveBeenCalledTimes(1)
      expect(completion.notifications).toEqual([])
      expectAttention(completion, 0)
    }
  )
  it.each(["completed", "failed", "outcome_unknown"] as const)(
    "restores one OS notification for a valid private workflow receipt with reporting state %s",
    async (state) => {
      const completion = await complete({
        source: "bot",
        origin: workflow,
        message: WORKFLOW_NOTIFICATION_TURN_PROMPT,
        state,
        result: state === "completed" ? "Verified workflow result" : "Workflow reporting failed"
      })
      expect(completion.context).toMatchObject({
        source: "bot",
        workflowEnabled: true,
        workflowInternalNotification: true,
        botWorkflowNotification: { runId: workflow.key, startedAt: workflow.runStartedAt }
      })
      expect(completion.notifications).toEqual([
        {
          title: `Synthetic Bot · ${state === "completed" ? "后台任务有新结果" : "需要你查看"}`,
          body: "返回 Bots 工作区查看结果。"
        }
      ])
      expect(completion.settled?.state).toBe(state)
      expectAttention(completion, 0)
    }
  )
  it("does not give a workflow result the command-only silence policy", async () => {
    const completion = await complete({
      source: "bot",
      origin: workflow,
      message: WORKFLOW_NOTIFICATION_TURN_PROMPT,
      result: "BOT_ROUTINE_SILENT"
    })
    expect(completion.notifications).toHaveLength(1)
    expectAttention(completion, 0)
  })
  it("does not expand desktop notification ownership to coordinator receipts", async () => {
    const completion = await complete({
      source: "bot",
      origin: { kind: "notification", notificationKind: "coordinator", key: "synthetic-receipt" }
    })
    expect(completion.notifications).toEqual([])
  })
  it("keeps an optional pass tool receipt and its private final silent", async () => {
    const completion = await complete({
      source: "bot",
      origin: discussion,
      publicText: "(pass)",
      result: "(pass)"
    })
    expect(completion.publishedText).not.toHaveBeenCalled()
    expect(completion.notifications).toEqual([])
    expectAttention(completion, 0)
    expect(completion.settled).toMatchObject({
      state: "completed",
      result: "(pass)",
      explicitGroupMessages: true
    })
  })
  it("retains attention for an actual public contribution followed by a private pass", async () => {
    const completion = await complete({
      source: "bot",
      origin: discussion,
      publicText: "Verified public result",
      result: "(pass)"
    })
    expect(completion.publishedText).toHaveBeenCalledExactlyOnceWith(
      "synthetic-task",
      "send-call",
      "Verified public result"
    )
    expect(completion.notifications).toEqual([])
    expectAttention(completion, 1)
    expect(completion.settled?.result).toBe("(pass)")
  })
  it.each([schedule, discussion])(
    "retains attention for a real file delivery with a quiet final from $kind",
    async (origin) => {
      const completion = await complete({
        source: "bot",
        origin,
        result: origin.kind === "schedule" ? "BOT_ROUTINE_SILENT" : "(pass)",
        deliverFile: true
      })
      expectAttention(completion, 1)
      if (origin.kind === "schedule") {
        expect(completion.notifications).toHaveLength(1)
        expect(completion.settled?.files).toHaveLength(1)
        expect(readFileSync(completion.settled!.files![0].attachmentPath!, "utf8")).toBe(
          "item,value\nchecks,1\n"
        )
      } else expect(completion.publishedFiles).toHaveBeenCalledTimes(1)
    }
  )
  it("does not treat a direct user's literal silence marker as a quiet routine", async () => {
    const completion = await complete({
      source: "bot",
      message: "BOT_ROUTINE_SILENT",
      result: "BOT_ROUTINE_SILENT"
    })
    expect(completion.notifications).toHaveLength(1)
    expectAttention(completion, 1)
  })
  it("keeps an optional private result without a pass marker conservative", async () => {
    const completion = await complete({ source: "bot", origin: discussion })
    expect(completion.publishedText).not.toHaveBeenCalled()
    expectAttention(completion, 1)
  })
  it.each([undefined, "desktop", "im", "scheduler", "heartbeat"] as const)(
    "preserves native completion and failure notifications for source %s",
    async (runSource) => {
      const completed = await complete({ source: runSource })
      expect(completed.notifications).toEqual([{ title: "✅ 任务完成", body: "Verified result" }])
      expectAttention(completed, 1)
      desktop.calls.length = 0
      const failed = await complete({
        source: runSource,
        state: "failed",
        result: "Provider failed"
      })
      expect(failed.notifications).toEqual([{ title: "❌ 任务失败", body: "Provider failed" }])
      expectAttention(failed, 0)
    }
  )
  it("ignores a completion veto on non-Bot sources", async () => {
    const veto = vi.fn(() => false)
    expectAttention(await complete({ source: "desktop", veto }), 1)
    expect(veto).not.toHaveBeenCalled()
  })
  it("preserves the internal-turn guard for native and host-owned Bot notifications", async () => {
    expectAttention(await complete({ internal: true }), 0)
    expectAttention(
      await complete({
        source: "bot",
        origin: { kind: "notification", notificationKind: "command", key: "synthetic-command" }
      }),
      0
    )
  })
  it.each(["focused", "unsupported"] as const)(
    "keeps the existing %s system notification rule",
    async (rule) => {
      desktop.focused = rule === "focused"
      desktop.supported = rule !== "unsupported"
      expect((await complete({ source: "bot" })).notifications).toEqual([])
      expect((await complete()).notifications).toEqual([])
    }
  )
})
