/**
 * Unit tests for coordinator worker filesystem access policy.
 *
 * Run:
 *   npx -y tsx tests/coordinator-worker-access.spec.ts
 */

import { mkdir, mkdtemp, rm, symlink } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { tool } from "langchain"
import { z } from "zod"
import {
  applyCoordinatorWorkerFilesystemAccess,
  filterCoordinatorWorkerFinalTools
} from "../src/main/agent/coordinator-worker-access.ts"
import { usesCaseInsensitiveCoordinatorPathMatching } from "../src/main/agent/coordinator-worker-paths.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface FakeTool {
  name: string
  description: string
  schema: z.ZodTypeAny
  invoke: (input: unknown, config?: unknown) => Promise<unknown> | unknown
}

function fakeTool(name: string, onInvoke?: FakeTool["invoke"]): FakeTool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({
      file_path: z.string().optional(),
      filePath: z.string().optional(),
      path: z.string().optional()
    }),
    invoke: onInvoke ?? (async () => `${name}:ok`)
  }
}

function toolNames(tools: Array<{ name?: string }>): string[] {
  return tools.map((tool) => tool.name ?? "(unnamed)").sort()
}

function assertHasTool(tools: Array<{ name?: string }>, name: string, label: string): void {
  assert(toolNames(tools).includes(name), `${label}: expected ${name} to be present`)
}

function assertNoTool(tools: Array<{ name?: string }>, name: string, label: string): void {
  assert(!toolNames(tools).includes(name), `${label}: expected ${name} to be absent`)
}

async function invokeTool(tool: unknown, input: unknown, config?: unknown): Promise<string> {
  const result = await (tool as { invoke: (args: unknown, config?: unknown) => Promise<unknown> }).invoke(
    input,
    config
  )
  return typeof result === "string" ? result : JSON.stringify(result)
}

async function callTool(toolLike: unknown, input: unknown): Promise<string> {
  const result = await (toolLike as { call: (args: unknown) => Promise<unknown> }).call(input)
  return typeof result === "string" ? result : JSON.stringify(result)
}

function allFilesystemTools(): FakeTool[] {
  return [
    fakeTool("read_file"),
    fakeTool("write_file"),
    fakeTool("edit_file"),
    fakeTool("execute"),
    fakeTool("task_output"),
    fakeTool("code_exec"),
    fakeTool("prepare_save_code_exec_tool"),
    fakeTool("save_code_exec_tool"),
    fakeTool("invoke_deferred_tool"),
    fakeTool("grep")
  ]
}

async function testReadOnlyWorkerToolSurface(): Promise<void> {
  const tools = applyCoordinatorWorkerFilesystemAccess(allFilesystemTools(), {
    workload: "read_only",
    workspacePath: "/tmp/workspace",
    ownedFiles: []
  })

  for (const name of [
    "write_file",
    "edit_file",
    "execute",
    "task_output",
    "code_exec",
    "prepare_save_code_exec_tool",
    "save_code_exec_tool",
    "invoke_deferred_tool"
  ]) {
    assertNoTool(tools, name, "read_only worker")
  }
  assertHasTool(tools, "read_file", "read_only worker")
  assertHasTool(tools, "grep", "read_only worker")
}

async function testVerifyWorkerToolSurface(): Promise<void> {
  const tools = applyCoordinatorWorkerFilesystemAccess(allFilesystemTools(), {
    workload: "verify",
    workspacePath: "/tmp/workspace",
    ownedFiles: []
  })

  assertNoTool(tools, "write_file", "verify worker")
  assertNoTool(tools, "edit_file", "verify worker")
  assertNoTool(tools, "code_exec", "verify worker")
  assertNoTool(tools, "invoke_deferred_tool", "verify worker")
  assertHasTool(tools, "execute", "verify worker")
  assertHasTool(tools, "task_output", "verify worker")
  assertHasTool(tools, "read_file", "verify worker")
}

async function testScopedWriteWorkerToolSurfaceAndGuard(): Promise<void> {
  await withTempDir("coordinator-worker-access-scope", async (workspace) => {
    await mkdir(join(workspace, "docs"), { recursive: true })

    const seen: Array<{ input: unknown; config: unknown }> = []
    const writeToolSource = Object.assign(
      fakeTool("write_file", async (input, config) => {
        seen.push({ input, config })
        return "write:ok"
      }),
      {
        metadata: { source: "deepagents-filesystem" },
        responseFormat: "content"
      }
    )
    const tools = applyCoordinatorWorkerFilesystemAccess(
      [
        writeToolSource,
        fakeTool("edit_file"),
        fakeTool("execute"),
        fakeTool("task_output"),
        fakeTool("read_file")
      ],
      {
        workload: "write",
        workspacePath: workspace,
        ownedFiles: ["src/allowed.ts", "docs"]
      }
    )

    assertNoTool(tools, "execute", "scoped write worker")
    assertNoTool(tools, "task_output", "scoped write worker")
    assertHasTool(tools, "write_file", "scoped write worker")
    assertHasTool(tools, "edit_file", "scoped write worker")
    assertHasTool(tools, "read_file", "scoped write worker")

    const writeTool = tools.find((tool) => tool.name === "write_file")
    assert(writeTool, "scoped write worker should keep a guarded write_file tool")
    assert(
      (writeTool as typeof writeToolSource).metadata?.source === "deepagents-filesystem" &&
        (writeTool as typeof writeToolSource).responseFormat === "content",
      "scoped write wrapper should preserve non-standard tool metadata"
    )

    const config = { configurable: { thread_id: "worker-thread" } }
    const allowed = await invokeTool(writeTool, { file_path: "src/allowed.ts" }, config)
    assert(allowed === "write:ok", "scoped write worker should allow owned file writes")
    assert(seen.length === 1, "scoped write worker should call original write tool for owned files")
    assert(
      (seen[0]?.config as { configurable?: { thread_id?: string } } | undefined)?.configurable
        ?.thread_id === "worker-thread",
      "scoped write wrapper should preserve LangChain runtime config"
    )

    const nestedAllowed = await invokeTool(writeTool, { file_path: "docs/guide.md" }, config)
    assert(nestedAllowed === "write:ok", "scoped write worker should allow files under owned dirs")

    const denied = await invokeTool(writeTool, { file_path: "src/other.ts" }, config)
    assert(
      denied.includes("limited to this worker's owned_files"),
      "scoped write worker should reject non-owned file writes"
    )

    if (usesCaseInsensitiveCoordinatorPathMatching()) {
      const caseVariantAllowed = await invokeTool(writeTool, { file_path: "SRC/ALLOWED.TS" }, config)
      assert(
        caseVariantAllowed === "write:ok",
        "scoped write worker should allow owned file case variants on case-insensitive filesystems"
      )
    }
  })
}

async function testScopedWriteWorkerRejectsSymlinkEscape(): Promise<void> {
  await withTempDir("coordinator-worker-access", async (workspace) => {
    const outsideDir = await mkdtemp(join(tmpdir(), "coordinator-worker-access-outside-"))
    try {
      await mkdir(join(workspace, "src"), { recursive: true })
      await symlink(outsideDir, join(workspace, "src", "link"), "dir")

      const tools = applyCoordinatorWorkerFilesystemAccess(
        [fakeTool("write_file")],
        {
          workload: "write",
          workspacePath: workspace,
          ownedFiles: ["src"]
        }
      )

      const writeTool = tools.find((tool) => tool.name === "write_file")
      assert(writeTool, "symlink escape test should keep write_file")

      const denied = await invokeTool(writeTool, { file_path: "src/link/pwn.ts" })
      assert(
        denied.includes("limited to this worker's owned_files"),
        "scoped write worker should reject writes that escape owned_files through symlinked directories"
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
}

async function testScopedSingleFileOwnershipDoesNotGrantDescendants(): Promise<void> {
  const tools = applyCoordinatorWorkerFilesystemAccess(
    [fakeTool("write_file")],
    {
      workload: "write",
      workspacePath: "/tmp/workspace",
      ownedFiles: ["src/new-file.ts"]
    }
  )

  const writeTool = tools.find((tool) => tool.name === "write_file")
  assert(writeTool, "single-file owned writer should keep write_file")

  const exact = await invokeTool(writeTool, { file_path: "src/new-file.ts" })
  assert(exact === "write_file:ok", "single-file owned writer should allow the exact file path")

  const denied = await invokeTool(writeTool, { file_path: "src/new-file.ts/child.ts" })
  assert(
    denied.includes("limited to this worker's owned_files"),
    "single-file owned writer should not treat the file path as a directory prefix"
  )
}

async function testScopedExtensionlessSingleFileOwnershipDoesNotGrantDescendants(): Promise<void> {
  const tools = applyCoordinatorWorkerFilesystemAccess(
    [fakeTool("write_file")],
    {
      workload: "write",
      workspacePath: "/tmp/workspace",
      ownedFiles: ["README"]
    }
  )

  const writeTool = tools.find((tool) => tool.name === "write_file")
  assert(writeTool, "extensionless single-file owned writer should keep write_file")

  const exact = await invokeTool(writeTool, { file_path: "README" })
  assert(exact === "write_file:ok", "extensionless single-file owned writer should allow the exact file path")

  const denied = await invokeTool(writeTool, { file_path: "README/child.txt" })
  assert(
    denied.includes("limited to this worker's owned_files"),
    "extensionless single-file owned writer should not treat the file path as a directory prefix"
  )
}

async function testScopedMissingDirectoryOwnershipAllowsDescendantsWithTrailingSlash(): Promise<void> {
  const tools = applyCoordinatorWorkerFilesystemAccess(
    [fakeTool("write_file")],
    {
      workload: "write",
      workspacePath: "/tmp/workspace",
      ownedFiles: ["newdir/"]
    }
  )

  const writeTool = tools.find((tool) => tool.name === "write_file")
  assert(writeTool, "missing-directory owned writer should keep write_file")

  const allowed = await invokeTool(writeTool, { file_path: "newdir/file.ts" })
  assert(
    allowed === "write_file:ok",
    "trailing-slash owned_files entry should grant descendant writes for a directory that does not exist yet"
  )
}

async function testScopedWriteGuardWrapsRealStructuredToolCallPath(): Promise<void> {
  await withTempDir("coordinator-worker-access-real-tool", async (workspace) => {
    const underlyingCalls: string[] = []
    const structuredWriteTool = tool(
      async ({ file_path }: { file_path: string }) => {
        underlyingCalls.push(file_path)
        return { status: "ok", file_path }
      },
      {
        name: "write_file",
        description: "write file",
        schema: z.object({
          file_path: z.string()
        })
      }
    )

    const tools = applyCoordinatorWorkerFilesystemAccess([structuredWriteTool], {
      workload: "write",
      workspacePath: workspace,
      ownedFiles: ["src/allowed.ts"]
    })

    const guardedWriteTool = tools.find((tool) => (tool as { name?: string }).name === "write_file")
    assert(guardedWriteTool, "real structured tool guard should keep write_file")

    const denied = await callTool(guardedWriteTool, { file_path: "src/outside.ts" })
    assert(
      denied.includes("limited to this worker's owned_files"),
      "guarded real structured tool should reject out-of-scope writes through call()"
    )
    assert(
      underlyingCalls.length === 0,
      "guarded real structured tool should not reach the underlying implementation when access is denied"
    )

    const allowed = await callTool(guardedWriteTool, { file_path: "src/allowed.ts" })
    assert(
      allowed.includes("\"status\":\"ok\"") && allowed.includes("\"file_path\":\"src/allowed.ts\""),
      "guarded real structured tool should allow owned file writes through call()"
    )
    assert(
      underlyingCalls.length === 1 && underlyingCalls[0] === "src/allowed.ts",
      "guarded real structured tool should forward allowed writes to the underlying implementation"
    )
  })
}

async function testWholeWorkspaceWriteWorkerKeepsTools(): Promise<void> {
  const tools = applyCoordinatorWorkerFilesystemAccess(allFilesystemTools(), {
    workload: "write",
    workspacePath: "/tmp/workspace",
    ownedFiles: []
  })

  assertHasTool(tools, "write_file", "whole-workspace write worker")
  assertHasTool(tools, "edit_file", "whole-workspace write worker")
  assertHasTool(tools, "execute", "whole-workspace write worker")
  assertHasTool(tools, "task_output", "whole-workspace write worker")
}

async function testConstrainedWorkerFinalToolSurface(): Promise<void> {
  const finalTools = [
    fakeTool("search_tool"),
    fakeTool("inspect_tool"),
    fakeTool("invoke_deferred_tool"),
    fakeTool("code_exec"),
    fakeTool("read_file"),
    fakeTool("execute")
  ]

  const readOnlyTools = filterCoordinatorWorkerFinalTools(finalTools, {
    workload: "read_only",
    workspacePath: "/tmp/workspace",
    ownedFiles: []
  })
  assertNoTool(readOnlyTools, "search_tool", "read_only final tools")
  assertNoTool(readOnlyTools, "inspect_tool", "read_only final tools")
  assertNoTool(readOnlyTools, "invoke_deferred_tool", "read_only final tools")
  assertNoTool(readOnlyTools, "code_exec", "read_only final tools")
  assertNoTool(readOnlyTools, "execute", "read_only final tools")
  assertHasTool(readOnlyTools, "read_file", "read_only final tools")

  const verifyTools = filterCoordinatorWorkerFinalTools(finalTools, {
    workload: "verify",
    workspacePath: "/tmp/workspace",
    ownedFiles: []
  })
  assertNoTool(verifyTools, "search_tool", "verify final tools")
  assertNoTool(verifyTools, "inspect_tool", "verify final tools")
  assertNoTool(verifyTools, "invoke_deferred_tool", "verify final tools")
  assertNoTool(verifyTools, "code_exec", "verify final tools")
  assertHasTool(verifyTools, "execute", "verify final tools")
  assertHasTool(verifyTools, "read_file", "verify final tools")

  const scopedWriteTools = filterCoordinatorWorkerFinalTools(finalTools, {
    workload: "write",
    workspacePath: "/tmp/workspace",
    ownedFiles: ["src/app.ts"]
  })
  assertNoTool(scopedWriteTools, "search_tool", "scoped write final tools")
  assertNoTool(scopedWriteTools, "inspect_tool", "scoped write final tools")
  assertNoTool(scopedWriteTools, "invoke_deferred_tool", "scoped write final tools")
  assertNoTool(scopedWriteTools, "code_exec", "scoped write final tools")
  assertNoTool(scopedWriteTools, "execute", "scoped write final tools")
  assertHasTool(scopedWriteTools, "read_file", "scoped write final tools")

  const unrestrictedWriteTools = filterCoordinatorWorkerFinalTools(finalTools, {
    workload: "write",
    workspacePath: "/tmp/workspace",
    ownedFiles: []
  })
  assertHasTool(unrestrictedWriteTools, "search_tool", "whole-workspace write final tools")
  assertHasTool(unrestrictedWriteTools, "code_exec", "whole-workspace write final tools")
}

async function run(): Promise<void> {
  await testReadOnlyWorkerToolSurface()
  console.log("PASS read_only worker tool surface")
  await testVerifyWorkerToolSurface()
  console.log("PASS verify worker tool surface")
  await testScopedWriteWorkerToolSurfaceAndGuard()
  console.log("PASS scoped write worker tool guard")
  await testScopedWriteWorkerRejectsSymlinkEscape()
  console.log("PASS scoped write worker rejects symlink escape")
  await testScopedSingleFileOwnershipDoesNotGrantDescendants()
  console.log("PASS scoped single-file ownership exact match")
  await testScopedExtensionlessSingleFileOwnershipDoesNotGrantDescendants()
  console.log("PASS scoped extensionless single-file ownership exact match")
  await testScopedMissingDirectoryOwnershipAllowsDescendantsWithTrailingSlash()
  console.log("PASS scoped trailing-slash missing directory ownership")
  await testScopedWriteGuardWrapsRealStructuredToolCallPath()
  console.log("PASS scoped write guard real structured tool call path")
  await testWholeWorkspaceWriteWorkerKeepsTools()
  console.log("PASS whole-workspace write worker tool surface")
  await testConstrainedWorkerFinalToolSurface()
  console.log("PASS constrained worker final tool surface")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
