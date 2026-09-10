import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { HOOK_AGENT_OWNER_METADATA_KEY, runWithHookAgentId } from "../hooks/execution-context"
import { patchRuntimeReadFileTool, resolveReadFileTraceContext } from "./read-file-tool"
import type { TraceContext } from "./trace/types"

const childTraceContext: TraceContext = {
  traceId: "child-trace-1",
  threadId: "thread-1__task_owner-1",
  rootNodeId: "trace:child-trace-1",
  observabilitySchemaVersion: 1,
  traceKind: "subagent",
  executionMode: "normal",
  rootTraceId: "root-trace-1",
  rootThreadId: "root-thread-1",
  parentTraceId: "parent-trace-1",
  parentThreadId: "thread-1",
  linkType: "parent_child",
  subagentKind: "task",
  subagentRunId: "owner-1"
}

describe("resolveReadFileTraceContext", () => {
  it("resolves task-owned read_file calls to their child trace", () => {
    const resolver = vi.fn((ownerId: string) =>
      ownerId === "owner-1" ? childTraceContext : undefined
    )

    expect(
      resolveReadFileTraceContext(
        { configurable: { [HOOK_AGENT_OWNER_METADATA_KEY]: "owner-1" } },
        resolver
      )
    ).toBe(childTraceContext)
    expect(resolver).toHaveBeenCalledWith("owner-1")
  })

  it("supports middleware-style nested runtime configuration", () => {
    const resolver = vi.fn(() => childTraceContext)

    expect(
      resolveReadFileTraceContext(
        {
          runtime: {
            configurable: { [HOOK_AGENT_OWNER_METADATA_KEY]: "owner-1" }
          }
        },
        resolver
      )
    ).toBe(childTraceContext)
  })

  it("uses the tool-call async context when the raw tool config omits the owner", () => {
    const resolver = vi.fn(() => childTraceContext)

    expect(runWithHookAgentId("owner-1", () => resolveReadFileTraceContext({}, resolver))).toBe(
      childTraceContext
    )
    expect(resolver).toHaveBeenCalledWith("owner-1")
  })

  it("leaves main, coordinator and workflow reads on their fixed runtime trace", () => {
    const resolver = vi.fn(() => childTraceContext)

    expect(resolveReadFileTraceContext({ configurable: {} }, resolver)).toBeUndefined()
    expect(resolveReadFileTraceContext(undefined, resolver)).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe("patchRuntimeReadFileTool", () => {
  it("passes the resolved task-subagent trace through the real read_file tool", async () => {
    const read = vi.fn(async () => "1\tconstraint content")
    const middleware = {
      tools: [
        {
          name: "read_file",
          schema: z.object({ file_path: z.string() })
        }
      ]
    }
    patchRuntimeReadFileTool({
      middleware,
      filesystemBackend: { read },
      resolveTraceContextForAgent: (ownerId) =>
        ownerId === "owner-1" ? childTraceContext : undefined
    })

    const readFile = middleware.tools[0] as (typeof middleware.tools)[0] & {
      invoke(input: unknown, config?: unknown): Promise<unknown>
    }
    await readFile.invoke(
      { file_path: "/plugin/sys/project.md", limit: 1 },
      { configurable: { [HOOK_AGENT_OWNER_METADATA_KEY]: "owner-1" } }
    )

    expect(read).toHaveBeenCalledWith(
      "/plugin/sys/project.md",
      0,
      1,
      expect.objectContaining({
        includeLookahead: true,
        traceContext: childTraceContext
      })
    )
  })
})
