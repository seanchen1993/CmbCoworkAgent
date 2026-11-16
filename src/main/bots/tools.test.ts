import { describe, expect, it, vi } from "vitest"
import {
  mkdtemp,
  mkdir,
  open,
  stat,
  writeFile,
  readFile,
  realpath,
  rename,
  readdir,
  symlink,
  rm
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { projectBotExecution } from "../../renderer/src/lib/bot-execution-visibility"
import { botScheduleReceipt } from "../../renderer/src/lib/bot-schedule-view"
import type { BotDefinition, BotSchedule, BotTask } from "../../shared/bots/contracts"
import type { LocalBotHost } from "./host"

vi.mock("../storage", () => ({ isMemoryEnabled: () => false }))
import {
  createBotScheduleTools,
  createBotBrowserTools,
  createBotDeliveryTools,
  createBotReturnFileTools,
  createBotReactionTools,
  createBotProfileTools,
  createBotCollaborationTools
} from "./tools"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import { copyBotFile, hashBotFile, snapshotBotDeliveryFile } from "./file-copy"
import { BotBrowserActionError, BotBrowserService } from "./browser"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { convertToOpenAITool } from "@langchain/core/utils/function_calling"
import { filterTaskSubagentTools } from "../agent/runtime-tool-catalog"
import {
  createTurnCompletionGateMiddleware,
  clearTurnCompletionGateState
} from "../agent/turn-completion-integrity"

it("persists only the parent Bot's current user reaction and returns its real receipt", async () => {
  const update = { revision: 4, item: { messageId: "actual-user", canReact: true, reactions: [] } }
  const write = vi.fn(() => update)
  const host = { setBotMessageReaction: write } as unknown as LocalBotHost
  const [react] = createBotReactionTools("live-task", () => host, new AbortController().signal)
  expect(filterTaskSubagentTools([react])).toEqual([])
  const call = {
    type: "tool_call" as const,
    id: "reaction-call",
    name: react.name,
    args: { emoji: "👍", present: true }
  }
  const child = await react.invoke(call, {
    configurable: { cmb_subagent_owner_tool_call_id: "child" }
  })
  expect(child.status).toBe("error")
  expect(write).not.toHaveBeenCalled()
  await expect(react.invoke({ ...call, args: { ...call.args, actor: "user" } })).rejects.toThrow()
  expect(write).not.toHaveBeenCalled()
  const result = await react.invoke(call)
  expect(write).toHaveBeenCalledExactlyOnceWith("live-task", "👍", true)
  expect(result.content).toBe("Your 👍 reaction is present on the current user message.")
  expect((await react.invoke(call)).content).toBe(result.content)
  const removed = await react.invoke({
    ...call,
    id: "remove",
    args: { emoji: "❤", present: false }
  })
  expect(removed.content).toBe("Your ❤️ reaction is absent on the current user message.")
  expect(write).toHaveBeenLastCalledWith("live-task", "❤", false)
  write.mockImplementationOnce(() => {
    throw new Error("source is no longer current")
  })
  expect((await react.invoke({ ...call, id: "rejected" })).status).toBe("error")
})

it("retains the ordinary empty-final and unfinished-todo checks after a real reaction", async () => {
  const [react] = createBotReactionTools(
    "task",
    () =>
      ({
        setBotMessageReaction: () => ({
          revision: 1,
          item: { messageId: "user", canReact: true, reactions: [] }
        })
      }) as unknown as LocalBotHost,
    new AbortController().signal
  )
  const receipt = await react.invoke({
    type: "tool_call",
    id: "react",
    name: react.name,
    args: { emoji: "👍", present: true }
  })
  const gate = createTurnCompletionGateMiddleware({ ownerRunToken: "reaction-protection" })
  const after = gate.afterModel
  const hook = typeof after === "function" ? after : after?.hook
  expect(hook).toBeTypeOf("function")
  const prior = [
    new HumanMessage({ id: "user", content: "Calculate23+41 and react" }),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "react", name: react.name, args: { emoji: "👍", present: true } }]
    }),
    receipt
  ]
  try {
    const empty = await Reflect.apply(hook!, undefined, [
      {
        messages: [
          ...prior,
          new AIMessage({ content: "", response_metadata: { finish_reason: "stop" } })
        ]
      },
      { configurable: { thread_id: "reaction-protection" } }
    ])
    expect(empty).toMatchObject({ jumpTo: "model" })
    const pending = await Reflect.apply(hook!, undefined, [
      {
        messages: [
          ...prior,
          new AIMessage({ content: "64", response_metadata: { finish_reason: "stop" } })
        ],
        todos: [{ content: "Required work", status: "in_progress" }]
      },
      { configurable: { thread_id: "reaction-protection" } }
    ])
    expect(pending).toMatchObject({ jumpTo: "model" })
  } finally {
    clearTurnCompletionGateState("reaction-protection", "reaction-protection")
  }
})

it("keeps persistent Bot identity and coordination with the parent, including direct child calls", async () => {
  const updateOwnProfile = vi.fn(() => ({ name: "Changed", changes: {} }))
  const createTeammate = vi.fn(() => ({ id: "new-bot", name: "Created" }))
  const updateTeammate = vi.fn(() => ({ id: "peer", name: "Changed", changes: {} }))
  const delegate = vi.fn(() => ({ id: "new-task", state: "queued" }))
  const saveSchedule = vi.fn(() => ({ id: "new-routine" }))
  const host = {
    updateOwnProfile,
    createTeammate,
    updateTeammate,
    delegate,
    saveSchedule,
    peers: () => [{ id: "peer", name: "Peer" }],
    snapshot: () => ({ schedules: [] })
  } as unknown as LocalBotHost
  const signal = new AbortController().signal
  const all = [
    ...createBotProfileTools("parent-task", () => host, signal),
    ...createBotCollaborationTools("parent-task", () => host, signal),
    ...createBotScheduleTools(
      { id: "parent-bot" } as BotDefinition,
      { id: "parent-task", origin: { kind: "user" } } as BotTask,
      () => host,
      signal
    )
  ]
  const args: Record<string, Record<string, unknown>> = {
    bot_update_profile: { name: "Changed" },
    bot_create_teammate: { requestKey: "new-bot", name: "Created", instructions: "Review" },
    bot_update_teammate: { botId: "peer", name: "Changed" },
    bot_delegate: { botId: "peer", message: "Review", requestKey: "review", outputFiles: [] },
    bot_schedule: {
      action: "save",
      name: "Routine",
      message: "Check",
      frequency: "interval",
      intervalMinutes: 60
    }
  }
  for (const entry of all.filter((entry) => entry.name !== "bot_list_peers")) {
    const result = await entry.invoke(
      { type: "tool_call", id: entry.name, name: entry.name, args: args[entry.name] },
      { configurable: { cmb_subagent_owner_tool_call_id: "temporary-task" } }
    )
    expect(result.status, entry.name).toBe("error")
    expect(result.content, entry.name).toContain("parent Bot")
  }
  for (const effect of [updateOwnProfile, createTeammate, updateTeammate, delegate, saveSchedule])
    expect(effect).not.toHaveBeenCalled()
  expect(filterTaskSubagentTools(all).map((entry) => entry.name)).toEqual(["bot_list_peers"])
})

it("keeps temporary subagent file results private until the parent delivers them", async () => {
  const publish = vi.fn()
  const [deliver] = createBotDeliveryTools("/unused", new AbortController().signal, publish)
  const result = await deliver.invoke(
    { type: "tool_call", id: "child-files", name: deliver.name, args: { files: ["result.md"] } },
    { configurable: { cmb_subagent_owner_tool_call_id: "task-call" } }
  )
  expect(result.status).toBe("error")
  expect(JSON.parse(result.content).error).toContain("parent")
  expect(publish).not.toHaveBeenCalled()
})

it.each([false, true])(
  "keeps collaboration tools while describing only the actual delivery channel (group=%s)",
  (group) => {
    const tools = createBotCollaborationTools(
      "task",
      () => ({}) as LocalBotHost,
      new AbortController().signal,
      group
    )
    expect(tools.map((tool) => tool.name)).toEqual(["bot_list_peers", "bot_delegate"])
    const description = tools[1].description
    if (group) {
      expect(description).toContain("caller and recipient use the SAME current group workspace")
      expect(description).toContain("Do not copy files into private Bot workspaces")
      expect(description).toContain("request and returned text are not automatically public")
      expect(description).toContain("ask the recipient to use bot_return_files")
      expect(description).toContain("bot_deliver_files publishes attachments to the group")
      expect(description).toContain("original user explicitly assigns public delivery")
      expect(description).toContain("bot_send_message")
      expect(description).not.toContain("Private Bots have different working directories")
    } else {
      expect(description).not.toContain("bot_send_message")
      expect(description).not.toContain("bot_return_files")
      expect(description).toContain("Private Bots have different working directories")
      expect(description).toContain("verified absolute paths for authorized input files")
      expect(description).toContain("does not copy input files")
      expect(description).toContain("not a same-name substitute")
    }
    expect(tools[1].schema).toHaveProperty(
      "shape.outputFiles.description",
      expect.stringContaining(
        group
          ? "relative to the current shared group workspace"
          : "relative to the recipient's workspace"
      )
    )
  }
)

it("keeps teammate creation unavailable to command continuations", () => {
  const host = {} as LocalBotHost
  const names = createBotProfileTools("notice", () => host, new AbortController().signal, true).map(
    (entry) => entry.name
  )
  expect(names).toEqual(["bot_update_profile", "bot_update_teammate"])
})

it("preserves the exact teammate identity and failed update receipt without sending work", async () => {
  const controller = new AbortController()
  const updateTeammate = vi.fn(() => ({
    id: "peer-id",
    name: "Reviewer",
    instructions: "Review",
    changes: { name: false, instructions: false }
  }))
  const host = { updateTeammate } as unknown as LocalBotHost
  const update = createBotProfileTools("direct-task", () => host, controller.signal).find(
    (entry) => entry.name === "bot_update_teammate"
  )!
  const call = {
    type: "tool_call" as const,
    id: "update-peer-call",
    name: update.name,
    args: { botId: "peer-id", name: "Reviewer" }
  }
  const result = await update.invoke(call)
  expect(JSON.parse(result.content)).toEqual({
    id: "peer-id",
    name: "Reviewer",
    instructions: "Review",
    changes: { name: false, instructions: false }
  })
  expect(updateTeammate).toHaveBeenCalledWith("direct-task", "peer-id", { name: "Reviewer" })
  updateTeammate.mockImplementation(() => {
    throw new Error("Target is busy")
  })
  const failed = await update.invoke(call)
  expect(failed.status).toBe("error")
  expect(failed.tool_call_id).toBe(call.id)
  expect(JSON.parse(failed.content).error).toBe("Target is busy")
  controller.abort(new Error("cancelled"))
  await expect(update.invoke(call)).rejects.toThrow("cancelled")
  expect(updateTeammate).toHaveBeenCalledTimes(2)
})

it("forwards the host's actual own-profile changes without inferring them from requested fields", async () => {
  const updateOwnProfile = vi.fn(() => ({
    name: "Original",
    instructions: "Keep role",
    changes: { name: false, instructions: true }
  }))
  const host = { updateOwnProfile } as unknown as LocalBotHost
  const update = createBotProfileTools(
    "direct-task",
    () => host,
    new AbortController().signal
  ).find((entry) => entry.name === "bot_update_profile")!
  const result = await update.invoke({
    type: "tool_call",
    id: "profile-call",
    name: update.name,
    args: { name: "Original", instructions: "Keep role" }
  })
  expect(JSON.parse(result.content)).toEqual({
    name: "Original",
    instructions: "Keep role",
    changes: { name: false, instructions: true }
  })
  expect(updateOwnProfile).toHaveBeenCalledWith("direct-task", {
    name: "Original",
    instructions: "Keep role"
  })
})

it("preserves an own-profile rejection as a failed receipt and propagates cancellation", async () => {
  const controller = new AbortController()
  const updateOwnProfile = vi.fn(() => {
    throw new Error("修改 Bot 身份需要当前用户直接交办")
  })
  const update = createBotProfileTools(
    "stale-task",
    () => ({ updateOwnProfile }) as unknown as LocalBotHost,
    controller.signal
  ).find((entry) => entry.name === "bot_update_profile")!
  const call = {
    type: "tool_call" as const,
    id: "rejected-profile-call",
    name: update.name,
    args: { name: "Rejected name" }
  }
  const result = await update.invoke(call)
  expect(result).toBeInstanceOf(ToolMessage)
  expect(result).toMatchObject({
    status: "error",
    name: update.name,
    tool_call_id: call.id
  })
  expect(JSON.parse(result.content)).toMatchObject({
    ok: false,
    error: "修改 Bot 身份需要当前用户直接交办"
  })
  expect(updateOwnProfile).toHaveBeenCalledWith("stale-task", { name: "Rejected name" })
  controller.abort(new Error("cancelled"))
  await expect(update.invoke(call)).rejects.toThrow("cancelled")
  expect(updateOwnProfile).toHaveBeenCalledTimes(1)
})

it("keeps real profile validation and task ownership failures from changing persisted identity", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const { NativeSqliteAdapter } = await import("../db/native-sqlite-adapter")
  const { BotStore } = await import("./store")
  const { LocalBotHost: Host } = await import("./host")
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db, () => 1000)
  const host = new Host(store, { acquire: () => null, onAvailable: () => () => {} })
  try {
    const bot = store.create({
      name: "Original",
      instructions: "Keep role",
      color: "#ea2845",
      modelRef: null
    })
    const task = store.enqueue({ botId: bot.id, requestId: "profile-boundary", message: "Rename" })
    store.transition(task.id, "running")
    const update = createBotProfileTools(task.id, () => host, new AbortController().signal).find(
      (entry) => entry.name === "bot_update_profile"
    )!
    const invoke = (name: string) =>
      update.invoke({
        type: "tool_call",
        id: "profile-boundary-call",
        name: update.name,
        args: { name }
      })
    const invalid = await invoke("Invalid\0name")
    expect(invalid).toBeInstanceOf(ToolMessage)
    expect(invalid.status).toBe("error")
    expect(JSON.parse(invalid.content).error).toContain("名称格式或长度无效")
    expect(store.getBot(bot.id)).toEqual(bot)
    const unchanged = await invoke(bot.name)
    expect(unchanged.status).toBe("success")
    expect(JSON.parse(unchanged.content).changes).toEqual({ name: false, instructions: false })
    store.settle(task.id, "completed", null)
    const late = await invoke("Too late")
    expect(late.status).toBe("error")
    expect(JSON.parse(late.content).error).toContain("当前用户直接交办")
    expect(store.getBot(bot.id)).toEqual(bot)
  } finally {
    await host.stop()
    db.close()
  }
})

it("uses host-controlled persistent creation, preserves failed receipts and respects cancellation", async () => {
  const controller = new AbortController()
  const createTeammate = vi.fn(() => ({ id: "created", name: "Reviewer", instructions: "Review" }))
  const host = { createTeammate } as unknown as LocalBotHost
  const create = createBotProfileTools("direct-task", () => host, controller.signal).find(
    (entry) => entry.name === "bot_create_teammate"
  )!
  const call = {
    type: "tool_call" as const,
    id: "create-call",
    name: create.name,
    args: { requestKey: "reviewer", name: "Reviewer", instructions: "Review" }
  }
  const result = await create.invoke(call)
  expect(JSON.parse(result.content)).toEqual({
    id: "created",
    name: "Reviewer",
    instructions: "Review"
  })
  expect(createTeammate).toHaveBeenCalledWith("direct-task", "reviewer", {
    name: "Reviewer",
    instructions: "Review"
  })
  createTeammate.mockImplementation(() => {
    throw new Error("当前用户未授权")
  })
  const failed = await create.invoke(call)
  expect(failed.status).toBe("error")
  expect(failed.tool_call_id).toBe("create-call")
  expect(JSON.parse(failed.content).error).toContain("未授权")
  await expect(create.invoke({ ...call.args, requestKey: "invalid key" })).rejects.toThrow()
  controller.abort(new Error("cancelled"))
  await expect(create.invoke(call)).rejects.toThrow("cancelled")
  expect(createTeammate).toHaveBeenCalledTimes(2)
})

it("resolves peer names only within the current task roster and preserves host validation/errors", async () => {
  const controller = new AbortController()
  const peers = vi.fn(() => [{ id: "member-a", name: "校对助手" }])
  const delegate = vi.fn(() => ({ id: "dispatch-1", state: "queued" }))
  const host = { peers, delegate } as unknown as LocalBotHost
  const send = createBotCollaborationTools("group-task", () => host, controller.signal)[1]
  const call = (botId: string) =>
    send.invoke({
      type: "tool_call",
      id: "call-delegate",
      name: send.name,
      args: { botId, message: "Check synthetic data", requestKey: "same-request", outputFiles: [] }
    })
  for (const target of ["校对助手", "member-a"]) {
    const result = await call(target)
    expect(JSON.parse(result.content)).toMatchObject({ taskId: "dispatch-1", botId: "member-a" })
    expect(peers).toHaveBeenLastCalledWith("group-task")
    expect(delegate).toHaveBeenLastCalledWith(
      "group-task",
      "member-a",
      "Check synthetic data",
      "same-request",
      []
    )
  }
  peers.mockReturnValue([
    { id: "member-a", name: "校对助手" },
    { id: "member-b", name: "校对助手" }
  ])
  for (const target of ["校对助手", "outside-member"]) {
    const failed = await call(target)
    expect(failed.status).toBe("error")
    expect(failed.tool_call_id).toBe("call-delegate")
    expect(JSON.parse(failed.content).recovery).toContain("bot_list_peers")
  }
  expect(delegate).toHaveBeenCalledTimes(2)
  delegate.mockImplementation(() => {
    throw new Error("member was removed")
  })
  expect((await call("member-a")).status).toBe("error")
  controller.abort(new Error("cancelled"))
  await expect(call("member-a")).rejects.toThrow("cancelled")
  expect(delegate).toHaveBeenCalledTimes(3)
})

it("delivers verified current-workspace files and rejects missing, private, linked and cancelled inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-delivery-test-"))
  const workspace = join(root, "group-workspace"),
    other = join(root, "private")
  const controller = new AbortController()
  try {
    await mkdir(workspace)
    await mkdir(other)
    const file = join(workspace, "核验 报告.md"),
      privateFile = join(other, "private.md")
    await writeFile(file, "合成成果：50.75")
    await writeFile(privateFile, "must not be delivered")
    await symlink(privateFile, join(workspace, "escape.md"))
    const publish = vi.fn()
    const [deliver] = createBotDeliveryTools(workspace, controller.signal, publish)
    const call = (files: string[]) =>
      deliver.invoke({ type: "tool_call", id: "delivery-1", name: deliver.name, args: { files } })
    const result = await call(["核验 报告.md", file])
    const files = parseBotFileDelivery(result.content)
    expect(files).toEqual([
      {
        filePath: expect.stringContaining("核验 报告.md"),
        name: "核验 报告.md",
        attachmentPath: expect.stringContaining(".bot-deliveries/"),
        size: Buffer.byteLength("合成成果：50.75")
      }
    ])
    expect(publish).toHaveBeenCalledWith(files, "delivery-1", undefined, [{ requestedPath: "核验 报告.md", filePath: files![0].filePath }, { requestedPath: file, filePath: files![0].filePath }], undefined)
    for (const invalid of ["missing.md", "../private/private.md", privateFile, "escape.md", "."]) {
      const failed = await call(["核验 报告.md", invalid])
      expect(failed.status).toBe("error")
      expect(failed.tool_call_id).toBe("delivery-1")
      expect(parseBotFileDelivery(failed.content)).toBeNull()
      expect(failed.content).not.toContain("must not be delivered")
    }
    expect(publish).toHaveBeenCalledTimes(1)
    publish.mockImplementationOnce(() => {
      throw new Error("Group removed")
    })
    const notPublished = await call(["核验 报告.md"])
    expect(notPublished.status).toBe("error")
    expect(parseBotFileDelivery(notPublished.content)).toBeNull()
    await expect(deliver.invoke({ files: Array(9).fill("核验 报告.md") })).rejects.toThrow()
    controller.abort(new Error("cancelled"))
    await expect(call(["核验 报告.md"])).rejects.toThrow("cancelled")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("freezes each public delivery and keeps identical call retries stable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bot-revision-"))
  try {
    const source = join(workspace, "report.md"),
      publish = vi.fn()
    const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal, publish)
    const call = (id: string) =>
      deliver.invoke({ type: "tool_call", id, name: deliver.name, args: { files: ["report.md"] } })
    await writeFile(source, "VERSION1")
    const first = parseBotFileDelivery((await call("first")).content)!
    expect(parseBotFileDelivery((await call("first")).content)).toEqual(first)
    await writeFile(source, "VERSION2")
    const second = parseBotFileDelivery((await call("second")).content)!
    expect(first[0].filePath).toBe(second[0].filePath)
    expect(first[0].size).toBe(second[0].size)
    expect(first[0].attachmentPath).not.toBe(second[0].attachmentPath)
    expect(await readFile(first[0].attachmentPath!, "utf8")).toBe("VERSION1")
    expect(await readFile(second[0].attachmentPath!, "utf8")).toBe("VERSION2")
    expect(await readFile(source, "utf8")).toBe("VERSION2")
    expect(publish).toHaveBeenNthCalledWith(1, first, "first", undefined, [{ requestedPath: "report.md", filePath: first[0].filePath }], undefined)
    expect(publish).toHaveBeenNthCalledWith(2, first, "first", undefined, [{ requestedPath: "report.md", filePath: first[0].filePath }], undefined)
    expect(publish).toHaveBeenNthCalledWith(3, second, "second", undefined, [{ requestedPath: "report.md", filePath: second[0].filePath }], undefined)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it("projects the host's current publication scope without changing formal file receipts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bot-delivery-scope-"))
  try {
    await writeFile(join(workspace, "report.md"), "RETAINED RESULT")
    const scope = {
      deliveryScope: { kind: "task" as const, threadId: "original-task", onwardPublication: "pending_review" as const },
      deliveryNote: "Retained in this task; onward publication is pending."
    }
    let held = false
    const capture = vi.fn(() => held ? scope : undefined)
    const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal, capture)
    const normal = JSON.parse(String(await deliver.invoke({ files: ["report.md"] })))
    expect(normal).not.toHaveProperty("deliveryScope")
    expect(normal).not.toHaveProperty("deliveryNote")
    // Ownership can be armed after tools were constructed, before actual delivery.
    held = true
    const pending = JSON.parse(String(await deliver.invoke({ files: ["report.md"] })))
    expect(pending).toMatchObject(scope)
    expect(pending.kind).toBe("bot-file-delivery")
    expect(parseBotFileDelivery(JSON.stringify(pending))).toEqual(parseBotFileDelivery(JSON.stringify(normal)))
    expect(await readFile(pending.files[0].attachmentPath, "utf8")).toBe("RETAINED RESULT")
    await expect(deliver.invoke({ files: ["report.md"], deliveryScope: scope.deliveryScope })).rejects.toThrow()
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it("deduplicates file aliases before copying or hashing their contents", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "bot-file-once-")))
  const snapshots = vi.spyOn(await import("./file-copy"), "snapshotBotDeliveryFile")
  try {
    const path = join(workspace, "report.md")
    await writeFile(path, "ONE RESULT")
    await symlink("report.md", join(workspace, "alias.md"))
    const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal)
    const files = parseBotFileDelivery(String(await deliver.invoke({ files: ["report.md", path, "alias.md"] })))!
    expect(files).toHaveLength(1)
    expect(snapshots).toHaveBeenCalledOnce()
  } finally {
    snapshots.mockRestore()
    await rm(workspace, { recursive: true, force: true })
  }
})

it.each(["changed", "removed"])(
  "imports the exact public peer attachment when its original was %s",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "bot-peer-snapshot-"))
    try {
      const mine = join(root, "mine"),
        peer = join(root, "peer")
      await mkdir(mine)
      await mkdir(peer)
      const original = join(peer, "report.md"),
        signal = new AbortController().signal
      await writeFile(original, "SENT_V1")
      const sent = await snapshotBotDeliveryFile(peer, original, signal)
      if (change === "changed") await writeFile(original, "EDIT_V2")
      else await rm(original)
      const [deliver] = createBotDeliveryTools(mine, signal, undefined, {
        workspacePath: peer,
        files: [{ filePath: original, name: "report.md", ...sent }]
      })
      const result = await deliver.invoke({
        type: "tool_call",
        id: "copy-peer",
        name: deliver.name,
        args: { files: [original] }
      })
      const copied = parseBotFileDelivery(result.content)!
      expect(copied).toHaveLength(1)
      expect(await readFile(copied[0].filePath, "utf8")).toBe("SENT_V1")
      expect(await readFile(copied[0].attachmentPath!, "utf8")).toBe("SENT_V1")
      expect(await readFile(sent.attachmentPath, "utf8")).toBe("SENT_V1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(["public", "internal"] as const)(
  "delivers a large verified %s peer result without relaxing external imports",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "bot-large-peer-"))
    try {
      const mine = join(root, "mine"), peer = join(root, "peer")
      await mkdir(mine)
      await mkdir(peer)
      const original = join(peer, "result.bin"), size = 100 * 1024 * 1024 + 1
      const handle = await open(original, "w")
      try {
        await handle.truncate(size)
        await handle.write(Buffer.from("START"), 0, 5, 0)
        await handle.write(Buffer.from("END"), 0, 3, size - 3)
      } finally {
        await handle.close()
      }
      const controller = new AbortController(), signal = controller.signal
      const verified: BotDeliveredFile[] = []
      const capture = (files: BotDeliveredFile[]) => { verified.push(...files) }
      const [sender] = mode === "public"
        ? createBotDeliveryTools(peer, signal, capture)
        : createBotReturnFileTools(peer, signal, capture)
      const sent = await sender.invoke({ type: "tool_call", id: "sender", name: sender.name, args: { files: [original] } })
      expect(sent.status).toBe("success")
      expect(verified).toHaveLength(1)
      const publish = vi.fn()
      const [receiver] = createBotDeliveryTools(mine, signal, publish, { workspacePath: peer, files: verified })
      const result = await receiver.invoke({ type: "tool_call", id: "receiver", name: receiver.name, args: { files: [original] } })
      expect(result.status).toBe("success")
      const files = parseBotFileDelivery(result.content)!
      expect(files).toHaveLength(1)
      expect((await stat(files[0].attachmentPath!)).size).toBe(size)
      expect(await hashBotFile(mine, files[0].attachmentPath!, signal)).toBe(await hashBotFile(peer, original, signal))
      expect(publish).toHaveBeenCalledExactlyOnceWith(files, "receiver", undefined, [], [{ reference: verified[0], filePath: files[0].filePath }])
      // The larger delivery allowance does not grant arbitrary peer paths or uploads.
      const unlisted = join(peer, "private.txt")
      await writeFile(unlisted, "private")
      const denied = await receiver.invoke({ type: "tool_call", id: "unlisted", name: receiver.name, args: { files: [unlisted] } })
      expect(denied.status).toBe("error")
      expect(publish).toHaveBeenCalledTimes(1)
      await expect(copyBotFile(peer, original, join(mine, "upload.bin"), signal)).rejects.toThrow("100 MiB")
      await expect(stat(join(mine, "upload.bin"))).rejects.toThrow()
      controller.abort(new Error("cancelled"))
      await expect(receiver.invoke({ type: "tool_call", id: "cancelled", name: receiver.name, args: { files: [original] } })).rejects.toThrow("cancelled")
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  { shared: false, removed: false }, { shared: true, removed: false },
  { shared: false, removed: true }, { shared: true, removed: true }
])("retains a private result before the caller resumes (shared: $shared, removed: $removed)", async ({ shared, removed }) => {
  const root = await mkdtemp(join(tmpdir(), "bot-private-handoff-"))
  const capture = vi.fn(), publish = vi.fn()
  try {
    const sender = join(root, "sender"), receiver = shared ? sender : join(root, "receiver")
    await mkdir(sender)
    if (!shared) await mkdir(receiver)
    const source = join(sender, "report.md"), signal = new AbortController().signal
    await writeFile(source, "RESULT_V1")
    const [returned] = createBotReturnFileTools(sender, signal, capture)
    const result = await returned.invoke({ type: "tool_call", id: "return-result",
      name: returned.name, args: { files: ["report.md"] } })
    const receipt = JSON.parse(String(result.content))
    expect(receipt.kind).toBe("bot-file-return")
    expect(receipt.files[0].attachmentPath).toBeTruthy()
    expect(capture).toHaveBeenCalledExactlyOnceWith(receipt.files, [{ requestedPath: "report.md", filePath: receipt.files[0].filePath }], undefined)
    expect(parseBotFileDelivery(result.content)).toBeNull()
    // The next job can overwrite the same filename before the queued caller runs.
    if (removed) await rm(source)
    else await writeFile(source, "RESULT_V2")
    const [delivery] = createBotDeliveryTools(receiver, signal, publish,
      { workspacePath: sender, files: receipt.files })
    const delivered = await delivery.invoke({ type: "tool_call", id: "deliver-result",
      name: delivery.name, args: { files: [source] } })
    const files = parseBotFileDelivery(delivered.content)!
    expect(await readFile(files[0].attachmentPath!, "utf8")).toBe("RESULT_V1")
    if (shared) {
      expect(files).toEqual(receipt.files)
      expect(await readdir(sender)).not.toContain("shared")
    }
    if (removed) await expect(readFile(source)).rejects.toThrow("ENOENT")
    else expect(await readFile(source, "utf8")).toBe("RESULT_V2")
    expect(publish).toHaveBeenCalledExactlyOnceWith(files, "deliver-result", undefined, [], [{ reference: receipt.files[0], filePath: files[0].filePath }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])("forwards a case-renamed result, including an older snapshot spelling (shared=%s)", async (shared) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-peer-case-")))
  try {
    const sender = join(root, "sender"), receiver = shared ? sender : join(root, "receiver")
    await mkdir(sender)
    if (!shared) await mkdir(receiver)
    const source = join(sender, "report.md"), renamed = join(sender, "Report.md")
    const signal = new AbortController().signal
    await writeFile(source, "SENT VERSION")
    const [returned] = createBotReturnFileTools(sender, signal, vi.fn())
    await returned.invoke({ files: ["report.md"] })
    await rename(source, renamed)
    const receipt = JSON.parse(String(await returned.invoke({ files: ["Report.md"] })))
    expect(receipt.files[0].attachmentPath).toBe(await realpath(receipt.files[0].attachmentPath))
    // A previous version could persist the attempted spelling instead. Exercise
    // recovery on filesystems where both spellings name this same existing file.
    const oldSpelling = join(dirname(receipt.files[0].attachmentPath), "REPORT.md")
    if (await stat(oldSpelling).catch(() => null)) receipt.files[0].attachmentPath = oldSpelling
    await writeFile(renamed, "NEXT VERSION")
    const [delivery] = createBotDeliveryTools(receiver, signal, undefined,
      { workspacePath: sender, files: receipt.files })
    const files = parseBotFileDelivery(String(await delivery.invoke({ files: [receipt.files[0].filePath] })))!
    expect(files).toHaveLength(1)
    expect(await readFile(files[0].attachmentPath!, "utf8")).toBe("SENT VERSION")
    expect(files[0].name).toBe("Report.md")
    expect(files[0].filePath.endsWith("/Report.md")).toBe(true)
    expect(await readFile(renamed, "utf8")).toBe("NEXT VERSION")
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])("reads a legacy receipt after a directory spelling change but rejects a redirected directory (shared=%s)", async (shared) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-peer-directory-")))
  try {
    const sender = join(root, "sender"), receiver = shared ? sender : join(root, "receiver")
    await mkdir(join(sender, "results"), { recursive: true })
    if (!shared) await mkdir(receiver)
    const source = join(sender, "results/report.md")
    await writeFile(source, "LEGACY RESULT")
    const files = [{ filePath: source, name: "report.md", size: 13 }]
    await rename(join(sender, "results"), join(sender, "Results"))
    // Case-sensitive filesystems do not preserve the old reference on rename.
    if (!await stat(source).catch(() => null)) return
    const signal = new AbortController().signal
    const [delivery] = createBotDeliveryTools(receiver, signal, undefined, { workspacePath: sender, files })
    const returned = parseBotFileDelivery(String(await delivery.invoke({ files: [source] })))!
    expect(await readFile(returned[0].attachmentPath!, "utf8")).toBe("LEGACY RESULT")
    await rename(join(sender, "Results"), join(sender, "elsewhere"))
    await symlink("elsewhere", join(sender, "results"))
    const [redirected] = createBotDeliveryTools(receiver, signal, undefined, { workspacePath: sender, files })
    const rejected = JSON.parse(String(await redirected.invoke({ files: [source] })))
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain("已指向其他文件")
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([
  { aliasKind: "file", privately: false }, { aliasKind: "directory", privately: false },
  { aliasKind: "file", privately: true }, { aliasKind: "directory", privately: true }
])("keeps an unlisted local $aliasKind alias distinct from a peer's retained version (private=$privately)", async ({ aliasKind, privately }) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "bot-peer-alias-")))
  try {
    const signal = new AbortController().signal, source = join(workspace, "results/Report.md")
    await mkdir(dirname(source))
    await writeFile(source, "OLD")
    const relativeAlias = aliasKind === "file" ? "report-alias.md" : "alias/Report.md"
    await symlink(aliasKind === "file" ? source : dirname(source),
      join(workspace, aliasKind === "file" ? relativeAlias : "alias"))
    const [returned] = createBotReturnFileTools(workspace, signal, vi.fn())
    const receipt = JSON.parse(String(await returned.invoke({ files: ["results/Report.md"] })))
    await writeFile(source, "NEW")
    const captured = vi.fn(), peer = { workspacePath: workspace, files: receipt.files }
    const [delivery] = privately
      ? createBotReturnFileTools(workspace, signal, captured, peer)
      : createBotDeliveryTools(workspace, signal,
        (files, _callId, _content, paths, peers) => captured(files, paths, peers), peer, true)
    const invoke = (filePath: string) => delivery.invoke({ files: [filePath],
      ...(!privately ? { content: "Reviewed version" } : {}) })
    // The exact host receipt deliberately retains the producer's old bytes.
    const retained = JSON.parse(String(await invoke(source)))
    expect(retained.files).toEqual(receipt.files)
    expect(await readFile(retained.files[0].attachmentPath, "utf8")).toBe("OLD")
    // A different local path selects the recipient's revision, with the same
    // semantics for an absolute path, a relative path and a private return.
    for (const path of [join(workspace, relativeAlias), relativeAlias]) {
      const current = JSON.parse(String(await invoke(path)))
      expect(await readFile(current.files[0].attachmentPath, "utf8")).toBe("NEW")
      expect(captured).toHaveBeenLastCalledWith(current.files,
        [{ requestedPath: path, filePath: source }], undefined)
    }
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

it.each(["file", "directory"])("does not import an unlisted %s alias from a peer's private workspace", async (aliasKind) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-peer-private-alias-")))
  try {
    const sender = join(root, "sender"), receiver = join(root, "receiver")
    const source = join(sender, "results/report.md"), signal = new AbortController().signal
    await mkdir(dirname(source), { recursive: true })
    await mkdir(receiver)
    await writeFile(source, "PRIVATE VERSION")
    const alias = join(sender, aliasKind === "file" ? "latest.md" : "alias/report.md")
    await symlink(aliasKind === "file" ? source : dirname(source),
      aliasKind === "file" ? alias : dirname(alias))
    const [returned] = createBotReturnFileTools(sender, signal, vi.fn())
    const receipt = JSON.parse(String(await returned.invoke({ files: ["results/report.md"] })))
    const publish = vi.fn()
    const [delivery] = createBotDeliveryTools(receiver, signal, publish,
      { workspacePath: sender, files: receipt.files })
    const rejected = JSON.parse(String(await delivery.invoke({ files: [alias] })))
    expect(rejected.ok).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(await readdir(receiver)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("delivers exact peer receipt pairs in a desktop work without accepting mixed or explicit historical references", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-peer-receipt-pairs-")))
  try {
    const workspace = join(root, "work"), peer = join(root, "peer")
    await mkdir(workspace)
    await mkdir(peer)
    const report = join(peer, "report.md"), chart = join(peer, "chart.png")
    const body = "![Chart](chart.png)", pixels = "retained image bytes"
    await writeFile(report, body)
    await writeFile(chart, pixels)
    const signal = new AbortController().signal
    const capture = vi.fn<(files: BotDeliveredFile[]) => void>()
    const [returnFiles] = createBotReturnFileTools(peer, signal, capture)
    await returnFiles.invoke({ files: ["report.md", "chart.png"] })
    const files = capture.mock.calls[0][0]
    const handoff = { workspacePath: peer, files }
    const [reportReceipt, chartReceipt] = files.map(({ filePath, attachmentPath }) => ({ filePath, attachmentPath }))
    await writeFile(report, "mutable replacement")
    await writeFile(chart, "different image bytes")

    const publish = vi.fn()
    const history = vi.fn(async () => undefined)
    const [deliver] = createBotDeliveryTools(workspace, signal, publish, handoff, false,
      undefined, "work", undefined, "receipt-thread", history)
    const call = (selected: readonly unknown[]) => deliver.invoke({
      type: "tool_call", id: "delivery", name: deliver.name, args: { files: selected }
    })
    const invalid = [
      { ...reportReceipt, attachmentPath: chartReceipt.attachmentPath },
      { ...reportReceipt, filePath: join(peer, "unlisted.md") },
      { ...reportReceipt, source: { threadId: "other-thread", assistantMessageId: "assistant",
        callId: "other-delivery", fileIndex: 0 } }
    ]
    for (const selection of invalid) {
      const rejected = await call([chartReceipt, selection])
      expect(rejected.status).toBe("error")
      expect(rejected.content).toContain("没有匹配的正式回执")
    }
    expect(publish).not.toHaveBeenCalled()
    expect(await readdir(workspace)).toEqual([])

    const sent = await call([reportReceipt, chartReceipt])
    expect(sent.status).not.toBe("error")
    const delivered = parseBotFileDelivery(sent.content)!
    expect(delivered.map(file => file.name)).toEqual(["report.md", "chart.png"])
    expect(delivered.map(file => file.filePath)).toEqual([report, chart])
    expect(delivered.every(file => file.attachmentPath?.startsWith(join(workspace, ".bot-deliveries") + sep))).toBe(true)
    expect(await readdir(workspace)).toEqual([".bot-deliveries"])
    await expect(readFile(delivered[0].attachmentPath!, "utf8")).resolves.toBe(body)
    await expect(readFile(delivered[1].attachmentPath!, "utf8")).resolves.toBe(pixels)
    expect(publish).toHaveBeenCalledOnce()

    const [stringOnly] = createBotDeliveryTools(workspace, signal, undefined, handoff)
    await expect(stringOnly.invoke({ files: [reportReceipt] })).rejects.toThrow()
    const byPath = parseBotFileDelivery(await stringOnly.invoke({ files: [reportReceipt.filePath] }))!
    expect(byPath[0].filePath).toContain(join(workspace, "shared") + sep)
    await expect(readFile(byPath[0].attachmentPath!, "utf8")).resolves.toBe(body)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps a peer import identity across tool rebuilds without overwriting the recipient's edits", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-peer-resume-")))
  try {
    const source = join(root, "source"), target = join(root, "target")
    await mkdir(source)
    await mkdir(target)
    const original = join(source, "report.md"), signal = new AbortController().signal
    await writeFile(original, "RETURNED VERSION")
    const capture = vi.fn()
    const [sender] = createBotReturnFileTools(source, signal, capture)
    await sender.invoke({ files: ["report.md"] })
    const peer = { workspacePath: source, files: capture.mock.calls[0][0] }
    const returned: BotDeliveredFile[][] = []
    const [first] = createBotReturnFileTools(target, signal, files => { returned.push(files) }, peer)
    await first.invoke({ files: [original] })
    const kept = returned[0][0]
    await writeFile(kept.filePath, "RECIPIENT'S EDIT")
    await writeFile(original, "PRODUCER'S NEXT TASK")
    // A checkpoint restart reconstructs both tools from the durable peer receipt.
    const resumedPeer = JSON.parse(JSON.stringify(peer))
    const [resumed] = createBotReturnFileTools(target, signal, files => { returned.push(files) }, resumedPeer)
    await resumed.invoke({ files: [original] })
    const [deliver] = createBotDeliveryTools(target, signal, files => { returned.push(files) }, resumedPeer)
    await deliver.invoke({ files: [original] })
    expect(returned).toEqual([[kept], [kept], [kept]])
    expect(await readFile(kept.filePath, "utf8")).toBe("RECIPIENT'S EDIT")
    expect(await readFile(kept.attachmentPath!, "utf8")).toBe("RETURNED VERSION")
    expect(await readdir(join(target, "shared"))).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("does not return a verified file if retaining its bytes fails", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bot-return-failed-")), capture = vi.fn()
  try {
    await writeFile(join(workspace, "report.md"), "RESULT")
    await writeFile(join(workspace, ".bot-deliveries"), "Not a directory")
    const [returned] = createBotReturnFileTools(workspace, new AbortController().signal, capture)
    const result = await returned.invoke({ type: "tool_call", id: "return-failed",
      name: returned.name, args: { files: ["report.md"] } })
    expect(result.status).toBe("error")
    expect(capture).not.toHaveBeenCalled()
    expect(await readFile(join(workspace, "report.md"), "utf8")).toBe("RESULT")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it.each([false, true])("preserves distinct logical files that share retained bytes (shared=%s)", async (shared) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-logical-files-")))
  try {
    const source = join(root, "source"), target = shared ? source : join(root, "target")
    await mkdir(join(source, "a"), { recursive: true })
    await mkdir(join(source, "b"))
    if (!shared) await mkdir(target)
    for (const name of ["a/manifest.json", "b/manifest.json"]) await writeFile(join(source, name), "{}")
    const signal = new AbortController().signal
    const [returned] = createBotReturnFileTools(source, signal, vi.fn())
    const receipt = JSON.parse(String(await returned.invoke({ files: ["a/manifest.json", "b/manifest.json"] })))
    expect(receipt.files[0].attachmentPath).toBe(receipt.files[1].attachmentPath)
    const [delivery] = createBotDeliveryTools(target, signal, undefined, { workspacePath: source, files: receipt.files })
    const ambiguous = JSON.parse(String(await delivery.invoke({
      files: receipt.files.map((file: BotDeliveredFile) => file.attachmentPath!)
    })))
    expect(ambiguous).toMatchObject({ ok: false, error: expect.stringContaining("绝对 filePath") })
    const files = parseBotFileDelivery(String(await delivery.invoke({ files: receipt.files.map((file: BotDeliveredFile) => file.filePath) })))!
    expect(files).toHaveLength(2)
    expect(new Set(files.map(file => file.filePath)).size).toBe(2)
    for (const file of files) expect(await readFile(file.attachmentPath!, "utf8")).toBe("{}")
    if (shared) expect(files).toEqual(receipt.files)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(["different size", "same size", "redirect"])("rejects a changed retained peer source during import: %s", async (change) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-retained-integrity-")))
  const publish = vi.fn()
  try {
    const source = join(root, "source"), target = join(root, "target")
    await mkdir(source); await mkdir(target)
    await writeFile(join(source, "report.md"), "ORIGINAL")
    const signal = new AbortController().signal
    const [returned] = createBotReturnFileTools(source, signal, vi.fn())
    const receipt = JSON.parse(String(await returned.invoke({ files: ["report.md"] })))
    const snapshot = receipt.files[0].attachmentPath
    if (change === "redirect") {
      await writeFile(join(source, "other.md"), "ORIGINAL")
      await rm(snapshot)
      await symlink(join(source, "other.md"), snapshot)
    } else await writeFile(snapshot, change === "same size" ? "REPLACED" : "DIFFERENT CONTENT")
    const [delivery] = createBotDeliveryTools(target, signal, publish, { workspacePath: source, files: receipt.files })
    const result = JSON.parse(String(await delivery.invoke({ files: [receipt.files[0].filePath] })))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("已保存的成果") })
    expect(publish).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(["edit", "remove", "unrelated-error", "publish-error", "missing-snapshot"])("reuses or repairs the retained import without discarding other successful selections: %s", async (change) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-repeat-version-")))
  try {
    const source = join(root, "source"), target = join(root, "target")
    await mkdir(source); await mkdir(target)
    await writeFile(join(source, "report.md"), "ORIGINAL")
    const signal = new AbortController().signal
    const [returned] = createBotReturnFileTools(source, signal, vi.fn())
    const receipt = JSON.parse(String(await returned.invoke({ files: ["report.md"] })))
    const publish = vi.fn()
    const [delivery] = createBotDeliveryTools(target, signal, publish, { workspacePath: source, files: receipt.files })
    const input = { files: [receipt.files[0].filePath] }
    const first = parseBotFileDelivery(String(await delivery.invoke(input)))!
    if (change === "edit") await writeFile(first[0].filePath, "REVISION")
    else if (change === "remove") await rm(first[0].filePath)
    else {
      if (change === "publish-error") publish.mockImplementationOnce(() => { throw new Error("Receipt save failed") })
      if (change === "missing-snapshot") await rm(first[0].attachmentPath!)
      const failed = JSON.parse(String(await delivery.invoke(change === "unrelated-error" ? { files: ["missing.md"] } : input)))
      expect(failed.ok).toBe(false)
    }
    const repeated = parseBotFileDelivery(String(await delivery.invoke(input)))!
    expect(repeated).toEqual(first)
    expect(await readFile(repeated[0].attachmentPath!, "utf8")).toBe("ORIGINAL")
    expect(await readdir(join(target, "shared"))).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("deduplicates one logical version and rejects conflicting versions before publication", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "bot-mixed-version-"))), publish = vi.fn()
  try {
    const signal = new AbortController().signal
    await writeFile(join(workspace, "report.md"), "ORIGINAL")
    const [returned] = createBotReturnFileTools(workspace, signal, vi.fn())
    const receipt = JSON.parse(String(await returned.invoke({ files: ["report.md"] })))
    const [delivery] = createBotDeliveryTools(workspace, signal, publish, { workspacePath: workspace, files: receipt.files })
    const input = { files: ["report.md", receipt.files[0].filePath] }
    expect(parseBotFileDelivery(String(await delivery.invoke(input)))).toEqual(receipt.files)
    expect(publish).toHaveBeenCalledOnce()
    await writeFile(join(workspace, "report.md"), "REVISION")
    expect(JSON.parse(String(await delivery.invoke(input)))).toMatchObject({ ok: false, error: expect.stringContaining("不同版本") })
    expect(publish).toHaveBeenCalledOnce()
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

it.each([false, true])("rereads a legacy peer source instead of reusing an editable import (edited=%s)", async (edited) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-legacy-reselect-")))
  try {
    const source = join(root, "source"), target = join(root, "target")
    await mkdir(source); await mkdir(target)
    const original = join(source, "report.md")
    await writeFile(original, "ORIGINAL")
    const [returned] = createBotReturnFileTools(target, new AbortController().signal, vi.fn(),
      { workspacePath: source, files: [{ filePath: original, name: "report.md", size: 8 }] })
    const first = JSON.parse(String(await returned.invoke({ files: [original] }))).files[0]
    if (edited) await writeFile(first.filePath, "LOCAL-EDIT")
    await writeFile(original, "LATEST!")
    const second = JSON.parse(String(await returned.invoke({ files: [original] }))).files[0]
    expect(await readFile(second.attachmentPath, "utf8")).toBe("LATEST!")
    expect(await readFile(first.filePath, "utf8")).toBe(edited ? "LOCAL-EDIT" : "ORIGINAL")
    expect(await readFile(first.attachmentPath, "utf8")).toBe("ORIGINAL")
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("rejects a legacy peer path that was redirected to a different file", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-legacy-identity-")))
  try {
    const source = join(root, "source"), target = join(root, "target")
    await mkdir(source); await mkdir(target)
    const path = join(source, "report.md")
    await writeFile(join(source, "private.md"), "NOT RETURNED")
    await symlink("private.md", path)
    const publish = vi.fn(), [delivery] = createBotDeliveryTools(target, new AbortController().signal, publish,
      { workspacePath: source, files: [{ filePath: path, name: "report.md", size: 12 }] })
    expect(JSON.parse(String(await delivery.invoke({ files: [path] })))).toMatchObject({ ok: false })
    expect(publish).not.toHaveBeenCalled()
    expect(await readdir(target)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("keeps internal file return distinct from an explicit public group delivery", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bot-file-return-"))
  const controller = new AbortController(),
    capture = vi.fn(),
    publish = vi.fn()
  try {
    await writeFile(join(workspace, "draft.md"), "Private review draft")
    const [returned] = createBotReturnFileTools(workspace, controller.signal, capture)
    const [delivered] = createBotDeliveryTools(
      workspace,
      controller.signal,
      publish,
      undefined,
      true
    )
    const call = (selected: typeof returned, args: Record<string, unknown>, child = false) =>
      selected.invoke(
        { type: "tool_call", id: "file-scope", name: selected.name, args },
        child ? { configurable: { cmb_subagent_owner_tool_call_id: "temporary-task" } } : undefined
      )
    const result = await call(returned, { files: ["draft.md"] })
    expect(returned.name).toBe("bot_return_files")
    expect(result.name).toBe("bot_return_files")
    const receipt = JSON.parse(String(result.content))
    expect(receipt).toMatchObject({ kind: "bot-file-return", files: [{ name: "draft.md" }] })
    expect(parseBotFileDelivery(result.content)).toBeNull()
    expect(capture).toHaveBeenCalledExactlyOnceWith(receipt.files, [{ requestedPath: "draft.md", filePath: receipt.files[0].filePath }], undefined)
    expect(publish).not.toHaveBeenCalled()
    // Old internal calls had only files. They must not silently become public on resume.
    await expect(call(delivered, { files: ["draft.md"] })).rejects.toThrow()
    await expect(
      call(returned, { files: ["draft.md"], content: "Publish the draft" })
    ).rejects.toThrow()
    const child = await call(returned, { files: ["draft.md"] }, true)
    expect(child).toMatchObject({ name: "bot_return_files", status: "error" })
    expect((await call(returned, { files: ["draft.md", "missing.md"] })).status).toBe("error")
    expect((await call(returned, { files: ["../outside.md"] })).status).toBe("error")
    expect(capture).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
    const publicResult = await call(delivered, { files: ["draft.md"], content: "Reviewed result" })
    const publicFiles = parseBotFileDelivery(publicResult.content)!
    expect(publicFiles).toMatchObject(receipt.files)
    expect(publicFiles[0].attachmentPath).toContain(".bot-deliveries/")
    expect(receipt.files[0].attachmentPath).toBe(publicFiles[0].attachmentPath)
    expect(publish).toHaveBeenCalledExactlyOnceWith(publicFiles, "file-scope", "Reviewed result", [{ requestedPath: "draft.md", filePath: publicFiles[0].filePath }], undefined)
    controller.abort(new Error("cancelled"))
    await expect(call(returned, { files: ["draft.md"] })).rejects.toThrow("cancelled")
    expect(capture).toHaveBeenCalledTimes(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it("exposes an explicit group content choice in the model schema while preserving private schemas", () => {
  for (const publicGroup of [true, false, undefined]) {
    const [deliver] = createBotDeliveryTools(
      "/unused",
      new AbortController().signal,
      undefined,
      undefined,
      publicGroup
    )
    const parameters = convertToOpenAITool(deliver).function.parameters as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(parameters.type).toBe("object")
    expect(parameters.required).toEqual(publicGroup ? ["files", "content"] : ["files"])
    expect(Object.keys(parameters.properties)).toEqual(
      publicGroup ? ["files", "content"] : ["files"]
    )
    expect(parameters.properties.files).toMatchObject({ type: "array", minItems: 1, maxItems: 8 })
    if (publicGroup) {
      expect(parameters.properties.content).toMatchObject({ type: "string", maxLength: 60_000 })
      expect(parameters.properties.content).not.toHaveProperty("minLength")
      expect(deliver.description).not.toContain("optional content")
      expect(deliver.description).toContain("empty string for a file-only delivery")
    }
  }
})

it("publishes a group summary or empty content only after every attachment is verified", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bot-group-content-"))
  const controller = new AbortController(),
    publish = vi.fn()
  try {
    await writeFile(join(workspace, "report.md"), "合计74.13")
    const [deliver] = createBotDeliveryTools(workspace, controller.signal, publish, undefined, true)
    const call = (files: string[], content?: string) =>
      deliver.invoke({
        type: "tool_call",
        id: "group-content",
        name: deliver.name,
        args: content === undefined ? { files } : { files, content }
      })
    const result = await call(["report.md"], "合计74.13，差额+0.03。")
    const files = parseBotFileDelivery(result.content)!
    expect(files).toHaveLength(1)
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      files,
      "group-content",
      "合计74.13，差额+0.03。",
      [{ requestedPath: "report.md", filePath: files[0].filePath }],
      undefined
    )
    expect((await call(["report.md", "missing.md"], "Do not publish partial text")).status).toBe(
      "error"
    )
    const child = await deliver.invoke(
      {
        type: "tool_call",
        id: "child",
        name: deliver.name,
        args: { files: ["report.md"], content: "Do not publish child text" }
      },
      { configurable: { cmb_subagent_owner_tool_call_id: "temporary-task" } }
    )
    expect(child.status).toBe("error")
    expect(publish).toHaveBeenCalledTimes(1)
    await expect(call(["report.md"], "x".repeat(60_001))).rejects.toThrow()
    for (const content of [null, 74.13, false, [], {}, undefined]) {
      await expect(
        deliver.invoke({
          type: "tool_call",
          id: "invalid-content",
          name: deliver.name,
          args: { files: ["report.md"], content }
        })
      ).rejects.toThrow()
    }
    expect(publish).toHaveBeenCalledTimes(1)
    await expect(call(["report.md"])).rejects.toThrow()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(parseBotFileDelivery((await call(["report.md"], "")).content)).toEqual(files)
    expect(publish).toHaveBeenLastCalledWith(files, "group-content", "", [{ requestedPath: "report.md", filePath: files[0].filePath }], undefined)
    controller.abort(new Error("cancelled"))
    await expect(call(["report.md"], "Do not publish after cancellation")).rejects.toThrow(
      "cancelled"
    )
    expect(publish).toHaveBeenCalledTimes(2)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it.each([undefined, false])(
  "keeps private and internal file tools on their files-only schema (publicGroup=%s)",
  async (publicGroup) => {
    const workspace = await mkdtemp(join(tmpdir(), "bot-private-content-"))
    try {
      await writeFile(join(workspace, "report.md"), "Private file")
      const publish = vi.fn()
      const [deliver] = createBotDeliveryTools(
        workspace,
        new AbortController().signal,
        publish,
        undefined,
        publicGroup
      )
      const schema = deliver.schema as { shape: Record<string, unknown> }
      expect(Object.keys(schema.shape)).toEqual(["files"])
      expect(deliver.description).not.toContain("optional content")
      for (const extra of [
        { groupId: "1a252c54-7b11-4f60-a4a8-b99b4f606602" },
        { content: "Must not become a public summary" }
      ]) {
        await expect(
          deliver.invoke({
            type: "tool_call",
            id: "private-invalid-file",
            name: deliver.name,
            args: { files: ["report.md"], ...extra }
          })
        ).rejects.toThrow()
        expect(publish).not.toHaveBeenCalled()
        expect(await readdir(workspace)).toEqual(["report.md"])
      }
      const result = await deliver.invoke({
        type: "tool_call",
        id: "private-file",
        name: deliver.name,
        args: { files: ["report.md"] }
      })
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        parseBotFileDelivery(result.content),
        "private-file", undefined, [{ requestedPath: "report.md", filePath: parseBotFileDelivery(result.content)![0].filePath }], undefined
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
)

it("imports only host-verified files from this exact peer handoff, preserving originals and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-peer-delivery-"))
  const workspace = join(root, "mine"),
    source = join(root, "peer")
  const controller = new AbortController(),
    publish = vi.fn()
  try {
    await mkdir(workspace)
    await mkdir(source)
    const report = join(source, "核验 报告.md"),
      privateFile = join(source, "private.md")
    const original = Buffer.from("\uFEFF原件\r\n金额：74.13\r\n", "utf8")
    await writeFile(report, original)
    await writeFile(privateFile, "not authorized")
    const actual = await realpath(report)
    const [deliver] = createBotDeliveryTools(workspace, controller.signal, publish, {
      workspacePath: source,
      files: [{ filePath: actual, name: "核验 报告.md", size: original.length }]
    })
    const call = (files: string[]) =>
      deliver.invoke({
        type: "tool_call",
        id: "peer-delivery",
        name: deliver.name,
        args: { files }
      })
    await expect(
      deliver.invoke({
        type: "tool_call",
        id: "peer-wrong-destination",
        name: deliver.name,
        args: { files: [report], groupId: "1a252c54-7b11-4f60-a4a8-b99b4f606602" }
      })
    ).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
    expect(await readdir(workspace)).toEqual([])
    // Reject the whole selection before importing the eligible first item.
    expect((await call([report, privateFile])).status).toBe("error")
    expect(await readdir(workspace)).toEqual([])
    const first = parseBotFileDelivery((await call([report, report])).content)!
    expect(first).toHaveLength(1)
    expect(first[0].filePath).toContain(`${await realpath(workspace)}/shared/`)
    expect(first[0].name).toBe("核验 报告.md")
    expect(await readFile(first[0].filePath)).toEqual(original)
    expect(await readFile(report)).toEqual(original)
    expect(parseBotFileDelivery((await call([report])).content)).toEqual(first)
    expect(publish).toHaveBeenCalledTimes(2)
    await rm(report)
    await symlink(privateFile, report)
    expect((await call([report])).status).toBe("error")
    expect(publish).toHaveBeenCalledTimes(2)
    controller.abort(new Error("cancelled"))
    await expect(call([first[0].filePath])).rejects.toThrow("cancelled")
    expect(await readFile(privateFile, "utf8")).toBe("not authorized")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("exposes human browser help as a dedicated scope-bound tool with original error and cancellation semantics", async () => {
  const controller = new AbortController(),
    waiting = vi.fn()
  const act = vi.fn().mockResolvedValue("fresh page evidence")
  const fileLock = vi.fn(async (operation: () => Promise<string>) => operation())
  const help = createBotBrowserTools(
    { id: "private" } as BotDefinition,
    { act } as unknown as BotBrowserService,
    controller.signal,
    waiting,
    "group-g--member",
    fileLock
  ).find((entry) => entry.name === "bot_request_browser_help")!
  const call = {
    type: "tool_call" as const,
    id: "help-1",
    name: help.name,
    args: { pageId: "observed", instruction: "完成页面确认" }
  }
  const result = await help.invoke(call)
  expect(result.content).toBe("fresh page evidence")
  expect(act).toHaveBeenCalledWith(
    "group-g--member",
    { action: "request_help", ...call.args },
    controller.signal,
    waiting,
    fileLock
  )
  act.mockRejectedValue(new Error("页面不属于此 Bot"))
  const failed = await help.invoke(call)
  expect(failed.status).toBe("error")
  expect(failed.name).toBe(help.name)
  expect(failed.tool_call_id).toBe(call.id)
  await expect(help.invoke({ instruction: "缺少目标" })).rejects.toThrow()
  controller.abort(new Error("cancelled"))
  await expect(help.invoke(call)).rejects.toThrow("cancelled")
})

it.each([{ ref: "page:e1" }, { role: "textbox", name: "Name" }])(
  "rejects a fill without text before touching the browser: %j",
  async (target) => {
    const launch = vi.fn()
    const service = new BotBrowserService(launch)
    const [browser] = createBotBrowserTools(
      { id: "private" } as BotDefinition,
      service,
      new AbortController().signal,
      vi.fn()
    )
    // A real model sent `value`; the schema strips that unknown argument.
    const result = await browser.invoke({
      type: "tool_call",
      id: "missing-text",
      name: "bot_browser",
      args: { action: "fill", ...target, value: "keep this text" }
    })
    expect(result.status).toBe("error")
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      error: expect.stringContaining("fill 必须提供 text")
    })
    expect(launch).not.toHaveBeenCalled()
  }
)

it("passes an explicit browser new-tab request through the original conversation scope", async () => {
  const act = vi.fn().mockResolvedValue("new owned page evidence")
  const controller = new AbortController(),
    waiting = vi.fn()
  const [browser] = createBotBrowserTools(
    { id: "private" } as BotDefinition,
    { act } as unknown as BotBrowserService,
    controller.signal,
    waiting,
    "group-g--member"
  )
  const args = { action: "navigate", newTab: true, url: "https://example.test/preview" }
  expect(await browser.invoke(args)).toBe("new owned page evidence")
  expect(act).toHaveBeenCalledWith("group-g--member", args, controller.signal, waiting, undefined)
})

it("returns the owned target for authorized cleanup while keeping a failed action an error", async () => {
  const cause = new Error("page.goto: Timeout 20000ms exceeded")
  const act = vi
    .fn()
    .mockRejectedValue(new BotBrowserActionError(cause, "owned-page", "about:blank"))
  const [browser] = createBotBrowserTools(
    { id: "private" } as BotDefinition,
    { act } as unknown as BotBrowserService,
    new AbortController().signal,
    vi.fn()
  )
  const result = await browser.invoke({
    type: "tool_call",
    id: "failed-navigation",
    name: "bot_browser",
    args: { action: "navigate", url: "https://example.test/slow" }
  })
  expect(result).toBeInstanceOf(ToolMessage)
  expect(result.status).toBe("error")
  expect(JSON.parse(result.content)).toMatchObject({
    ok: false,
    error: cause.message,
    pageId: "owned-page",
    url: "about:blank"
  })
  expect(JSON.parse(result.content).recovery).toContain("For authorized cleanup")
})

it("preserves browser failure status through the standard Runtime tool-result format", async () => {
  const act = vi.fn().mockRejectedValue(new Error("请省略 pageId 后重新观察"))
  const [browser] = createBotBrowserTools(
    { id: "private" } as BotDefinition,
    { act } as unknown as BotBrowserService,
    new AbortController().signal,
    vi.fn(),
    "group-g"
  )
  const result = await browser.invoke({
    type: "tool_call",
    id: "call-1",
    name: "bot_browser",
    args: { action: "observe", pageId: "stale" }
  })
  expect(result).toBeInstanceOf(ToolMessage)
  expect(result.status).toBe("error")
  expect(result.tool_call_id).toBe("call-1")
  expect(JSON.parse(result.content).ok).toBe(false)
  expect(act).toHaveBeenCalledWith(
    "group-g",
    expect.anything(),
    expect.any(AbortSignal),
    expect.any(Function),
    undefined
  )
})

it("keeps ambiguous-target recovery refs in an error result so the model can retry precisely", async () => {
  const evidence = JSON.stringify({
    ok: false,
    pageId: "owned-page",
    error: "页面目标不唯一；操作未执行",
    content: '- button "查看详情" [ref=page:e1]\n- button "查看详情" [ref=page:e2]'
  })
  const [browser] = createBotBrowserTools(
    { id: "private" } as BotDefinition,
    { act: vi.fn().mockResolvedValue(evidence) } as unknown as BotBrowserService,
    new AbortController().signal,
    vi.fn()
  )
  const result = await browser.invoke({
    type: "tool_call",
    id: "ambiguous-click",
    name: "bot_browser",
    args: { action: "click", role: "button", name: "查看详情" }
  })
  expect(result.status).toBe("error")
  expect(result.content).toBe(evidence)
})

function fixture(
  origin: BotTask["origin"] = { kind: "user" },
  schedules: BotSchedule[] = [],
  source: Partial<Pick<BotTask, "threadId" | "workId" | "mockSource">> = {}
) {
  const controller = new AbortController()
  const save = vi.fn((botId, input, existing) => ({ botId, ...input, ...existing }))
  const saveFollowUp = vi.fn((botId, input, followUp) => ({ botId, ...input, followUp }))
  const saveWorkSchedule = vi.fn((botId, input, workId) => ({ botId, ...input, workId }))
  const host = {
    snapshot: () => ({ schedules }),
    saveSchedule: save,
    saveDesktopScheduleFollowUp: saveFollowUp,
    saveDesktopWorkScheduleFromTool: saveWorkSchedule,
    removeSchedule: vi.fn()
  } as unknown as LocalBotHost
  const [schedule] = createBotScheduleTools(
    { id: "a", threadId: "main-thread" } as BotDefinition,
    { id: "source-task", threadId: "main-thread", origin, ...source } as BotTask,
    () => host,
    controller.signal
  )
  return { schedule, save, saveFollowUp, saveWorkSchedule, controller }
}

describe("Bot schedule tool contract", () => {
  it("distinguishes observation, execution and fixed text in the model-visible contract", () => {
    const { schedule } = fixture()
    const contract = convertToOpenAITool(schedule).function
    expect(contract.description).toContain("choose exactly one mode")
    expect(contract.description).toContain('frequency=once, runAt, and workMonitor={workId, mode:"report"}')
    expect(contract.description).toContain("Confirm an observation only when the save receipt contains workMonitor")
    expect(contract.description).toContain("To execute authorized work later, set top-level workId")
    expect(contract.description).toContain("This only repeats that text and never checks task status or executes its instructions")
    expect(contract.description).not.toContain("Routines need standalone authorized instructions")
    expect(contract.parameters).toMatchObject({ properties: {
      message: { description: expect.stringContaining("For work observations omit this field") },
      kind: { const: "fixed_reminder", description: expect.stringContaining("without checking task status") },
      workId: { description: expect.stringContaining("Execution destination") },
      workMonitor: {
        description: expect.stringContaining('mode="report"'),
        required: ["workId", "mode"],
        properties: { mode: { enum: ["report", "change", "new_result", "until_work_completed"] } }
      }
    } })
  })

  it("keeps the real removal receipt visible with execution details folded", async () => {
    const { schedule } = fixture({ kind: "user" }, [
      {
        id: "routine",
        botId: "a",
        version: 1,
        name: "Review",
        message: "Review",
        frequency: "once",
        runAt: "2030-01-01T00:00:00Z",
        enabled: false,
        nextRunAt: null,
        timezone: "UTC"
      }
    ])
    const call = { id: "remove", name: "bot_schedule", args: { action: "remove", id: "routine" } }
    const receipt = await schedule.invoke({ type: "tool_call", ...call })
    expect(receipt).toBeInstanceOf(ToolMessage)
    const returned = { content: receipt.content, is_error: receipt.status === "error" }
    expect(botScheduleReceipt(call, returned)).toEqual({ action: "remove", id: "routine" })
    expect(botScheduleReceipt(call, { ...returned, content: `${receipt.content}。` })).toBeNull()
    const created_at = new Date()
    const view = projectBotExecution([
      { id: "call-message", role: "assistant", content: "", tool_calls: [call], created_at },
      { id: "receipt-message", role: "tool", tool_call_id: call.id, ...returned, created_at }
    ], false, new Set())
    expect(view.hiddenMessages.size).toBe(0)
    expect(view.foldedTools.size).toBe(0)
  })

  it("uses the exact execution destination separately from a read-only work observation", async () => {
    const { schedule, save, saveFollowUp, saveWorkSchedule } = fixture()
    const args = { action: "save", name: "Continue", message: "Update the report",
      frequency: "daily", runAtTime: "09:00", workId: "report", requestKey: "run-report" }
    const call = { type: "tool_call" as const, name: "bot_schedule", id: "continue", args }
    const mixed = await schedule.invoke({ ...call, args: { ...args, workMonitor: { workId: "report", mode: "change" } } })
    expect(mixed.status).toBe("error")
    expect(saveWorkSchedule).not.toHaveBeenCalled()
    await schedule.invoke(call)
    expect(saveWorkSchedule).toHaveBeenCalledExactlyOnceWith("a",
      expect.objectContaining({ message: args.message }), "report",
      { taskId: "source-task", callId: "continue", key: "run-report" })
    expect(saveFollowUp).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await schedule.invoke({ ...call, id: "observe", args: {
      action: "save", name: "Observe", frequency: "daily", runAtTime: "09:00",
      workMonitor: { workId: "report", mode: "change" }, requestKey: "observe-report"
    } })
    expect(saveFollowUp).toHaveBeenCalledExactlyOnceWith("a",
      expect.objectContaining({ message: "查看原任务的已记录进展" }), { workId: "report", mode: "change" },
      { taskId: "source-task", callId: "observe", key: "observe-report" }, undefined)
  })

  it("uses the fixed reminder path only for an explicit kind", async () => {
    const { schedule, save, saveFollowUp } = fixture()
    const contract = convertToOpenAITool(schedule).function
    expect(contract.description).toContain("For one-time reminders set kind=fixed_reminder")
    expect(contract.parameters).toHaveProperty("properties.priorOperation")
    const args = { action: "save", name: "Call", message: "Remind me to call",
      frequency: "once", runAt: "2099-01-01T10:00:00Z" }
    await schedule.invoke({ type: "tool_call", name: "bot_schedule", id: "legacy", args })
    expect(save).toHaveBeenCalledOnce()
    expect(saveFollowUp).not.toHaveBeenCalled()
    await schedule.invoke({ type: "tool_call", name: "bot_schedule", id: "fixed",
      args: { ...args, kind: "fixed_reminder", requestKey: "remind-once" } })
    expect(saveFollowUp).toHaveBeenCalledExactlyOnceWith("a",
      expect.objectContaining({ frequency: "once", message: args.message }),
      { kind: "fixed_reminder" }, { taskId: "source-task", callId: "fixed", key: "remind-once" }, undefined)
  })

  it.each([
    { kind: "group", groupId: "g", messageId: "message" },
    { kind: "schedule", scheduleId: "routine" }
  ] as const)("keeps execution-only descriptions for $kind turns", origin => {
    const { schedule } = fixture(origin)
    const contract = convertToOpenAITool(schedule).function
    expect(contract.description).toContain("Routines need standalone authorized instructions")
    expect(contract.description).not.toMatch(/fixed_reminder|workMonitor|workId|requestKey|recover/)
    expect(contract.parameters).toMatchObject({ properties: {
      message: { description: "Standalone instructions for the future run, including required inputs, acceptance conditions and delivery/silence policy. Omit only when keeping an existing routine's instructions unchanged." }
    } })
  })

  it.each([
    {
      surface: "desktop task",
      origin: { kind: "user" },
      source: { threadId: "work-thread", workId: "work" }
    },
    {
      surface: "personal IM in the shared main thread",
      origin: { kind: "mock", bindingId: "binding", eventId: "event" },
      source: { mockSource: {
        transport: "im", personal: true, bindingId: "binding", grantVersion: 1,
        conversationId: "dm", audienceKey: "desktop", eventId: "event", messageId: "message", senderId: "owner"
      } }
    }
  ] as const)("keeps the original once routine and rejects desktop-only fields in $surface", async ({ origin, source }) => {
    const { schedule, save, saveFollowUp, saveWorkSchedule } = fixture(origin, [], source)
    const contract = convertToOpenAITool(schedule).function
    expect(contract.description).toContain("set frequency=once and runAt")
    const desktopInputs = {
      kind: "fixed_reminder",
      workId: "report",
      expiresAt: "2099-01-01T11:00:00Z",
      workMonitor: { workId: "report", mode: "change" },
      requestKey: "once",
      priorOperation: { sourceRequestId: "request" }
    }
    const call = { type: "tool_call" as const, name: "bot_schedule", id: "once",
      args: { action: "save", name: "Report", message: "Remind me to check the report",
        frequency: "once", runAt: "2099-01-01T10:00:00Z" } }
    for (const [field, value] of Object.entries(desktopInputs)) {
      expect(contract.parameters).not.toHaveProperty(`properties.${field}`)
      await expect(schedule.invoke({ ...call, args: { ...call.args, [field]: value } })).rejects.toThrow()
    }
    expect(contract.description).not.toMatch(/fixed_reminder|workMonitor|workId|requestKey|recover/)
    expect(save).not.toHaveBeenCalled()
    expect(saveFollowUp).not.toHaveBeenCalled()
    expect(saveWorkSchedule).not.toHaveBeenCalled()

    expect((await schedule.invoke(call)).status).not.toBe("error")
    expect(save).toHaveBeenCalledExactlyOnceWith("a",
      expect.objectContaining({ frequency: "once", message: call.args.message }), undefined,
      ...("mockSource" in source ? ["source-task"] : []))
  })

  it("returns error ToolMessages for real calls while preserving cancellation and validation", async () => {
    const { schedule, save, controller } = fixture()
    const call = {
      type: "tool_call" as const,
      id: "schedule-call",
      name: "bot_schedule",
      args: { action: "save", id: "missing-routine" }
    }
    const missing = await schedule.invoke(call)
    expect(missing).toBeInstanceOf(ToolMessage)
    expect(missing.status).toBe("error")
    expect(missing.tool_call_id).toBe(call.id)
    expect(missing.content).toContain("此 Bot 中不存在该例行任务，未保存")
    expect(missing.content).toContain("新建时省略 id")
    expect(save).not.toHaveBeenCalled()

    const invalid = await schedule.invoke({
      ...call,
      args: {
        action: "save",
        name: "Invalid",
        message: "Reply",
        frequency: "once",
        runAt: "2030-01-02T09:30:00"
      }
    })
    expect(invalid.status).toBe("error")
    expect(invalid.content).toContain("时区")
    expect(save).not.toHaveBeenCalled()

    const nested = fixture({ kind: "schedule", scheduleId: "routine" })
    const denied = await nested.schedule.invoke(call)
    expect(denied.status).toBe("error")
    expect(denied.content).toContain("用户直接交办")
    expect(nested.save).not.toHaveBeenCalled()

    controller.abort(new Error("cancelled"))
    await expect(schedule.invoke({ ...call, args: { action: "list" } })).rejects.toThrow(
      "cancelled"
    )
    expect(save).not.toHaveBeenCalled()
  })

  it("accepts a model's once request without an explicit enabled flag", async () => {
    const { schedule, save } = fixture()
    await schedule.invoke({
      action: "save",
      name: "Synthetic check",
      message: "Reply once",
      frequency: "once",
      runAt: "2030-01-02T09:30:00+08:00"
    })
    expect(save).toHaveBeenCalledWith(
      "a",
      {
        name: "Synthetic check",
        message: "Reply once",
        frequency: "once",
        enabled: true,
        runAt: "2030-01-02T01:30:00.000Z"
      },
      undefined
    )
  })

  it("keeps omitted settings when editing and requires explicit re-enablement", async () => {
    const prior = {
      id: "routine",
      botId: "a",
      name: "Old",
      message: "Reply once",
      frequency: "daily",
      runAtTime: "09:00",
      enabled: false,
      version: 2
    } as BotSchedule
    const { schedule, save } = fixture({ kind: "user" }, [prior])
    await schedule.invoke({ action: "save", id: prior.id, name: "Renamed" })
    expect(save).toHaveBeenLastCalledWith(
      "a",
      expect.objectContaining({
        name: "Renamed",
        message: "Reply once",
        frequency: "daily",
        runAtTime: "09:00",
        enabled: false
      }),
      { id: "routine", version: 2 }
    )
    await schedule.invoke({ action: "save", id: prior.id, enabled: true })
    expect(save).toHaveBeenLastCalledWith("a", expect.objectContaining({ enabled: true }), {
      id: "routine",
      version: 2
    })
  })

  it("rejects invalid times and prevents scheduled messages from creating new routines", async () => {
    const { schedule, save } = fixture()
    await expect(
      schedule.invoke({
        action: "save",
        name: "Invalid",
        message: "Reply",
        frequency: "once",
        runAt: "2030-01-02T09:30:00"
      })
    ).rejects.toThrow("时区")
    expect(save).not.toHaveBeenCalled()
    const nested = fixture({ kind: "schedule", scheduleId: "routine" })
    await expect(nested.schedule.invoke({ action: "save" })).rejects.toThrow("用户直接交办")
    expect(nested.save).not.toHaveBeenCalled()
    expect(await nested.schedule.invoke({ action: "list" })).toBe("[]")
  })
})
