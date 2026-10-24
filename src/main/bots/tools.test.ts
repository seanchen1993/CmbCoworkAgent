import { describe, expect, it, vi } from "vitest"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  readdir,
  symlink,
  rm
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotDefinition, BotSchedule, BotTask } from "../../shared/bots/contracts"
import type { LocalBotHost } from "./host"

vi.mock("../storage", () => ({ isMemoryEnabled: () => false }))
import {
  createBotScheduleTools,
  createBotBrowserTools,
  createBotDeliveryTools,
  createBotReactionTools,
  createBotProfileTools,
  createBotCollaborationTools
} from "./tools"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import { BotBrowserActionError, type BotBrowserService } from "./browser"
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
      expect(description).toContain("request and returned text are not automatically public")
      expect(description).toContain("bot_send_message")
      expect(description).not.toContain("Private Bots have different working directories")
    } else {
      expect(description).not.toContain("bot_send_message")
      expect(description).toContain("Private Bots have different working directories")
      expect(description).toContain("verified absolute paths for authorized input files")
      expect(description).toContain("does not copy input files")
      expect(description).toContain("not a same-name substitute")
    }
    expect(tools[1].schema).toHaveProperty(
      "shape.outputFiles.description",
      expect.stringContaining("relative to the recipient's workspace")
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
        size: Buffer.byteLength("合成成果：50.75")
      }
    ])
    expect(publish).toHaveBeenCalledWith(files, "delivery-1")
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
      "合计74.13，差额+0.03。"
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
    expect(publish).toHaveBeenLastCalledWith(files, "group-content", "")
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
        "private-file"
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

function fixture(origin: BotTask["origin"] = { kind: "user" }, schedules: BotSchedule[] = []) {
  const controller = new AbortController()
  const save = vi.fn((botId, input, existing) => ({ botId, ...input, ...existing }))
  const host = {
    snapshot: () => ({ schedules }),
    saveSchedule: save,
    removeSchedule: vi.fn()
  } as unknown as LocalBotHost
  const [schedule] = createBotScheduleTools(
    { id: "a" } as BotDefinition,
    { origin } as BotTask,
    () => host,
    controller.signal
  )
  return { schedule, save, controller }
}

describe("Bot schedule tool contract", () => {
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
