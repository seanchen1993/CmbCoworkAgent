import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { createMiddleware } from "langchain"
import { afterEach, describe, expect, it } from "vitest"
import { createDeepAgent } from "../../agent/runtime"
import { LocalSandbox } from "../../agent/local-sandbox"
import { createDesignRepairProgress, DESIGN_REPAIR_STALL_CALLS } from "./repair-progress"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
type Call = { name: string; args: Record<string, unknown> }

async function fixture(script: (target: string, other: string) => Call[]) {
  const root = await mkdtemp(join(tmpdir(), "design-repair-progress-"))
  roots.push(root)
  const target = join(root, "repair.html"),
    other = join(root, "old.html")
  await writeFile(target, "maxQuick = 10\n")
  await writeFile(other, "DO_NOT_READ_OR_EDIT")
  const progress = createDesignRepairProgress(target, root)
  const calls = script(target, other)
  const prompts: string[] = []
  let index = 0
  let writes = 0
  const scripted = createMiddleware({
    name: "scriptedRepairModel",
    wrapModelCall: async (request) => {
      prompts.push(JSON.stringify(request.systemMessage.content))
      const call = calls[index++]
      return call
        ? new AIMessage({ content: "", tool_calls: [{ ...call, id: `repair-call-${index}` }] })
        : new AIMessage("修复已提交，等待宿主复检")
    }
  })
  const agent = createDeepAgent({
    model: new FakeListChatModel({ responses: ["unused"] }),
    backend: new LocalSandbox({
      rootDir: root,
      windowsSandbox: "none",
      onFileMutation: () => {
        writes++
        progress.noteWrite()
      }
    }),
    middleware: [progress.middleware, scripted],
    mainTodosEnabled: false,
    mainSubagentsEnabled: false,
    includeGeneralPurposeSubagent: false
  })
  return {
    target,
    other,
    prompts,
    writes: () => writes,
    run: () => agent.invoke({ messages: [new HumanMessage("按报告修复")] }, { recursionLimit: 160 })
  }
}

describe("Design repair progress in the real agent graph", () => {
  it("nudges and stops varying searches without letting ToolNode swallow the stop", async () => {
    const f = await fixture((target) =>
      Array.from({ length: DESIGN_REPAIR_STALL_CALLS + 2 }, (_, i) => ({
        name: "grep",
        args: { path: target, pattern: `different-query-${i}` }
      }))
    )
    await expect(f.run()).rejects.toThrow("已停止重复搜索")
    expect(f.prompts.some((prompt) => prompt.includes("请停止搜索并直接 edit_file"))).toBe(true)
    expect(f.writes()).toBe(0)
    expect(await readFile(f.target, "utf8")).toBe("maxQuick = 10\n")
    expect(f.prompts).toHaveLength(DESIGN_REPAIR_STALL_CALLS + 1)
  })

  it("resets the warning only after an actual successful target edit", async () => {
    const f = await fixture((target) => [
      ...Array.from({ length: 4 }, (_, i) => ({
        name: "read_file",
        args: { file_path: target, offset: i, limit: 1 }
      })),
      {
        name: "edit_file",
        args: { file_path: target, old_string: "maxQuick = 10", new_string: "maxQuick = 8" }
      },
      ...Array.from({ length: 3 }, (_, i) => ({
        name: "grep",
        args: { path: target, pattern: `query-${i}` }
      }))
    ])
    await f.run()
    expect(f.writes()).toBe(1)
    expect(await readFile(f.target, "utf8")).toBe("maxQuick = 8\n")
    expect(f.prompts[4]).toContain("请停止搜索并直接 edit_file")
    expect(
      f.prompts.slice(5).every((prompt) => !prompt.includes("请停止搜索并直接 edit_file"))
    ).toBe(true)
  })

  it("allows a direct fix at the read limit instead of stopping the useful edit", async () => {
    const f = await fixture((target) => [
      { name: "read_file", args: { file_path: target, offset: 0, limit: 1 } },
      ...Array.from({ length: DESIGN_REPAIR_STALL_CALLS - 1 }, (_, i) => ({
        name: "grep",
        args: { path: target, pattern: `located-${i}` }
      })),
      { name: "edit_file", args: { file_path: target, old_string: "10", new_string: "8" } }
    ])
    await f.run()
    expect(f.writes()).toBe(1)
    expect(await readFile(f.target, "utf8")).toBe("maxQuick = 8\n")
  })

  it("bounds unsuccessful edit attempts as well as read-only loops", async () => {
    const f = await fixture((target) => [
      { name: "read_file", args: { file_path: target } },
      ...Array.from({ length: 40 }, (_, i) => ({
        name: "edit_file",
        args: { file_path: target, old_string: `unknown-anchor-${i}`, new_string: "8" }
      }))
    ])
    await expect(f.run()).rejects.toThrow("已停止无进展的修复")
    expect(f.writes()).toBe(0)
    expect(await readFile(f.target, "utf8")).toBe("maxQuick = 10\n")
  })

  it("blocks old draft reads, workspace searches, other edits and fake no-op progress", async () => {
    const f = await fixture((target, other) => [
      { name: "read_file", args: { file_path: other } },
      { name: "grep", args: { path: ".", pattern: "DO_NOT_READ" } },
      {
        name: "edit_file",
        args: { file_path: other, old_string: "DO_NOT_READ_OR_EDIT", new_string: "changed" }
      },
      { name: "edit_file", args: { file_path: target, old_string: "10", new_string: "10" } }
    ])
    const result = await f.run()
    const tools = result.messages.filter((m) => m.getType() === "tool")
    expect(tools).toHaveLength(4)
    expect(tools.every((m) => "status" in m && m.status === "error")).toBe(true)
    expect(String(tools[0].content)).not.toContain("DO_NOT_READ_OR_EDIT")
    expect(await readFile(f.other, "utf8")).toBe("DO_NOT_READ_OR_EDIT")
    expect(f.writes()).toBe(0)
    expect(f.prompts.at(-1)).toContain("请停止搜索并直接 edit_file")
  })
})
