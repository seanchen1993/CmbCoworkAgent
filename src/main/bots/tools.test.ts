import { describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotDefinition, BotSchedule, BotTask } from "../../shared/bots/contracts"
import type { LocalBotHost } from "./host"

vi.mock("../storage", () => ({ isMemoryEnabled: () => false }))
import {
  createBotScheduleTools,
  createBotBrowserTools,
  createBotDeliveryTools,
  createBotProfileTools,
  createBotCollaborationTools
} from "./tools"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import type { BotBrowserService } from "./browser"
import { ToolMessage } from "@langchain/core/messages"

it("preserves the exact teammate identity and failed update receipt without sending work", async () => {
  const controller = new AbortController()
  const updateTeammate = vi.fn(() => ({ id: "peer-id", name: "Reviewer", instructions: "Review" }))
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
    instructions: "Review"
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
      args: { botId, message: "Check synthetic data", requestKey: "same-request" }
    })
  for (const target of ["校对助手", "member-a"]) {
    const result = await call(target)
    expect(JSON.parse(result.content)).toMatchObject({ taskId: "dispatch-1", botId: "member-a" })
    expect(peers).toHaveBeenLastCalledWith("group-task")
    expect(delegate).toHaveBeenLastCalledWith(
      "group-task",
      "member-a",
      "Check synthetic data",
      "same-request"
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

it("exposes human browser help as a dedicated scope-bound tool with original error and cancellation semantics", async () => {
  const controller = new AbortController(),
    waiting = vi.fn()
  const act = vi.fn().mockResolvedValue("fresh page evidence")
  const help = createBotBrowserTools(
    { id: "private" } as BotDefinition,
    { act } as unknown as BotBrowserService,
    controller.signal,
    waiting,
    "group-g--member"
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
    waiting
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
    expect.any(Function)
  )
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
    expect(missing.content).toBe("此 Bot 中不存在该例行任务")
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
