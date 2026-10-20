import { afterEach, describe, expect, it, vi } from "vitest"
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertStageDebugToolCall,
  createStageDebugFileMiddleware,
  STAGE_DEBUG_TOOL_NAMES
} from "./stage-debug-policy"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-debug-policy-"))
  roots.push(root)
  const workspace = join(root, "isolated"),
    snapshotRoot = join(root, "package")
  mkdirSync(workspace)
  mkdirSync(snapshotRoot)
  writeFileSync(join(workspace, "input.txt"), "stage input")
  writeFileSync(join(snapshotRoot, "SKILL.md"), "trusted retained skill")
  return { root, policy: { workspace, snapshotRoot, baselineId: "native-baseline" } }
}

describe("stage debug application file-tool confinement", () => {
  it("allows branch file work and retained package reads without source writes", () => {
    const { policy } = fixture()
    expect(() =>
      assertStageDebugToolCall(policy, "read_file", { file_path: "input.txt" })
    ).not.toThrow()
    expect(() =>
      assertStageDebugToolCall(policy, "write_file", {
        file_path: "new/output.txt",
        content: "result"
      })
    ).not.toThrow()
    expect(() =>
      assertStageDebugToolCall(policy, "edit_file", {
        filePath: join(policy.workspace, "input.txt")
      })
    ).not.toThrow()
    expect(() =>
      assertStageDebugToolCall(policy, "read_file", {
        file_path: join(policy.snapshotRoot, "SKILL.md")
      })
    ).not.toThrow()
    expect(() =>
      assertStageDebugToolCall(policy, "write_file", {
        file_path: join(policy.snapshotRoot, "SKILL.md")
      })
    ).toThrow(/PATH_OUTSIDE|SOURCE_READ_ONLY/)
  })

  it.each(["ls", "glob", "grep"])(
    "refuses %s until directory traversal has an actual IO boundary",
    (tool) => {
      const { policy } = fixture()
      expect(() =>
        assertStageDebugToolCall(policy, tool, { path: policy.workspace, pattern: "**/*" })
      ).toThrow("PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED")
    }
  )

  it("rejects all execution, extension, network and delegation tool names", () => {
    const { policy } = fixture()
    for (const tool of [
      "execute",
      "shell",
      "apply_patch",
      "http",
      "task",
      "workflow",
      "mcp__read",
      "mod_function",
      "project_checkpoint",
      "request_user_input"
    ])
      expect(() => assertStageDebugToolCall(policy, tool, {})).toThrow(
        "PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED"
      )
  })

  it("rejects traversal, foreign absolute roots, ADS, Windows devices and path aliases", () => {
    const { root, policy } = fixture()
    for (const file_path of [
      "../outside.txt",
      "sub/../input.txt",
      join(root, "outside.txt"),
      "C:/foreign/file",
      "file:stream",
      "NUL.txt",
      "sub./input.txt",
      "file\0.txt",
      "\\\\server\\share\\file"
    ])
      expect(() => assertStageDebugToolCall(policy, "read_file", { file_path })).toThrow()
    expect(() =>
      assertStageDebugToolCall(policy, "read_file", {
        file_path: "input.txt",
        filePath: join(root, "outside.txt")
      })
    ).toThrow("PROJECT_STAGE_DEBUG_ARGUMENTS_INVALID")
  })

  it("rejects hardlinked files for all permitted file tools", () => {
    const { root, policy } = fixture()
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "outside")
    linkSync(outside, join(policy.workspace, "linked.txt"))
    for (const tool of ["read_file", "write_file", "edit_file"])
      expect(() => assertStageDebugToolCall(policy, tool, { file_path: "linked.txt" })).toThrow(
        "PROJECT_STAGE_DEBUG_LINK_UNSUPPORTED"
      )
  })

  it("rejects junctions, including a replacement between admission and final arguments", () => {
    const { root, policy } = fixture()
    const outside = join(root, "outside"),
      linked = join(policy.workspace, "sub")
    mkdirSync(outside)
    mkdirSync(linked)
    assertStageDebugToolCall(policy, "write_file", { filePath: "sub/result.txt" })
    rmSync(linked, { recursive: true })
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir")
    expect(() =>
      assertStageDebugToolCall(policy, "write_file", { filePath: "sub/result.txt" })
    ).toThrow("PROJECT_STAGE_DEBUG_LINK_UNSUPPORTED")
    expect(() =>
      assertStageDebugToolCall(policy, "read_file", { file_path: "sub/input.txt" })
    ).toThrow("PROJECT_STAGE_DEBUG_LINK_UNSUPPORTED")
  })

  it("both hides unsupported model tools and rejects recovered calls without running handlers", async () => {
    const { policy } = fixture()
    const environment = vi.fn()
    const middleware = createStageDebugFileMiddleware(policy, environment)
    const model = vi.fn(async (request) => request)
    const projected = (await middleware.wrapModelCall!(
      {
        tools: [
          ...STAGE_DEBUG_TOOL_NAMES,
          "ls",
          "glob",
          "grep",
          "execute",
          "task",
          "workflow",
          "custom_function"
        ].map((name) => ({ name }))
      } as never,
      model as never
    )) as unknown as { tools: { name: string }[] }
    expect(projected.tools.map((tool) => tool.name)).toEqual(STAGE_DEBUG_TOOL_NAMES)
    const handler = vi.fn(async () => "executed")
    const denied = await middleware.wrapToolCall!(
      { toolCall: { id: "call", name: "execute", args: { command: "echo unsafe" } } } as never,
      handler as never
    )
    expect(handler).not.toHaveBeenCalled()
    expect((denied as { content: unknown }).content).toBe("PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED")
    for (const name of ["ls", "glob", "grep"]) {
      const deniedDirectory = await middleware.wrapToolCall!(
        {
          toolCall: { id: name, name, args: { path: policy.workspace, pattern: "**/*" } }
        } as never,
        handler as never
      )
      expect((deniedDirectory as { content: unknown }).content).toBe(
        "PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED"
      )
    }
    expect(handler).not.toHaveBeenCalled()
    environment.mockImplementation(() => {
      throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    })
    await expect(async () =>
      middleware.wrapModelCall!({ tools: [] } as never, model as never)
    ).rejects.toThrow("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    const blocked = await middleware.wrapToolCall!(
      { toolCall: { id: "read", name: "read_file", args: { file_path: "input.txt" } } } as never,
      handler as never
    )
    expect((blocked as { content: unknown }).content).toBe("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    expect(handler).not.toHaveBeenCalled()
  })
})
