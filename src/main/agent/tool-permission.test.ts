import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { ApprovalStore } from "./approval-store"
import { ToolOrchestrator } from "./tool-orchestrator"
import { modCallContext } from "../mods/context"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-permission-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  }
})
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "mods-permission-"))
  roots.push(root)
  mkdirSync(join(root, "workspace"))
  return { root, workspace: join(root, "workspace") }
}

it("cold permission probes do not prewarm, run hooks, execute commands or touch file contents", async () => {
  const root = workspace()
  const prewarm = vi.spyOn(LocalSandbox, "prewarmForWorkspace").mockImplementation(() => {})
  const read = vi.spyOn(LocalSandbox.prototype, "read")
  const write = vi.spyOn(LocalSandbox.prototype, "write")
  const execute = vi.spyOn(LocalSandbox.prototype, "execute")
  const hooks = vi.fn(() => [])
  const query = LocalSandbox.createPermissionProbe({
    rootDir: root.workspace,
    windowsSandbox: "none",
    hooks
  })
  expect(await query("read_file", { file_path: "a.txt" })).toEqual({ decision: "allow" })
  expect(await query("write_file", { file_path: "a.txt", content: "never written" })).toEqual({
    decision: "allow"
  })
  expect(await query("execute", { command: "echo test", cwd: root.root })).toEqual({
    decision: "deny",
    reason: "COMMAND_CWD_DENIED"
  })
  for (const call of [prewarm, read, write, execute, hooks]) expect(call).not.toHaveBeenCalled()
})

it("uses real readonly and isolated-worktree file predicates", async () => {
  const root = workspace()
  vi.spyOn(
    LocalSandbox as unknown as { getElevationState(): Promise<boolean> },
    "getElevationState"
  ).mockResolvedValue(false)
  const readonly = LocalSandbox.createPermissionProbe({
    rootDir: root.workspace,
    windowsSandbox: "readonly"
  })
  expect(await readonly("write_file", { file_path: "a.txt", content: "never written" })).toEqual({
    decision: "deny",
    reason: "SANDBOX_FILE_WRITE_DENIED"
  })
  const isolated = LocalSandbox.createPermissionProbe({
    rootDir: root.workspace,
    windowsSandbox: "none",
    worktreeIsolation: {
      workspaceRoot: root.workspace,
      worktreeRoot: root.workspace
    } as import("./workflow/types").WorkflowWorktreeIsolationBoundary
  })
  expect(
    (await isolated("edit_file", { file_path: join(root.root, "outside.txt") })).decision
  ).toBe("deny")
  expect((await isolated("read_file", { file_path: ".git" })).decision).toBe("deny")
})

it("file approval queries reflect modes and cached rules without asking or consuming them", async () => {
  const store = new ApprovalStore()
  const execute = vi.fn()
  const approve = vi.fn()
  const orchestrator = new ToolOrchestrator(store, execute, approve)
  expect(orchestrator.queryFileOp("write_file", "file.txt", "/project").decision).toBe("ask")
  store.put(store.makeKey("write_file:file.txt", "/project", "file"), "approved_session")
  expect(orchestrator.queryFileOp("write_file", "file.txt", "/project").decision).toBe("allow")
  expect(await orchestrator.approveFileOp("write_file", "file.txt", "/project")).toBe(true)
  expect(orchestrator.queryFileOp("write_file", "file.txt", "/project").decision).toBe("allow")
  expect(approve).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it("command policy queries preserve forbidden and task-card decisions even in YOLO", () => {
  const execute = vi.fn()
  const approve = vi.fn()
  const orchestrator = new ToolOrchestrator(new ApprovalStore(), execute, approve, () => true)
  expect(
    orchestrator.queryExecute("git commit -m test -- file.txt", "/project", "none", "posix")
  ).toEqual({ decision: "ask", reason: "GIT_TASK_CARD_REQUIRED" })
  expect(
    orchestrator.queryExecute("git commit --amend -m test", "/project", "none", "posix").decision
  ).toBe("deny")
  expect(orchestrator.queryExecute("echo test", "/project", "none", "posix").decision).toBe("allow")
  expect(execute).not.toHaveBeenCalled()
  expect(approve).not.toHaveBeenCalled()
})

it("carries a protected permission-hook reason into the existing file approval dialog", async () => {
  const approve = vi.fn(async () => ({ type: "approve" as const, tool_call_id: "approval" }))
  const orchestrator = new ToolOrchestrator(new ApprovalStore(), vi.fn(), approve)
  const identity = {
    workspace: "/project",
    threadId: "thread",
    turnId: "turn",
    agentId: "main",
    callId: "call",
    origin: "model" as const,
    grantEpoch: 0
  }
  await modCallContext.run(
    {
      identity,
      toolId: "host:write_file",
      routeClaimed: true,
      protectedOutput: true,
      readOnly: false,
      permissionReason: "Review the generated file"
    },
    () => orchestrator.approveFileOp("write_file", "a.txt", "/project")
  )
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "Review the generated file\n文件写入操作需要审批"
    })
  )
})
