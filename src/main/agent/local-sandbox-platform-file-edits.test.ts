import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { registerPlatformFileEditSink } from "../mods/v2/platform-native-file-edits"
import type { NativeHostFileEdit } from "../mods/v2/platform-capabilities-types"
import type { ToolOrchestrator } from "./tool-orchestrator"

const directories: string[] = []
let stop = () => {}
afterEach(() => {
  stop()
  stop = () => {}
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "platform-real-file-edit-"))
  directories.push(workspace)
  const edits: NativeHostFileEdit[] = []
  stop = registerPlatformFileEditSink({
    capture: (root, threadId) => ({
      workspace: root,
      threadId,
      incarnation: "native-a",
      assertCurrent: () => {}
    }),
    publish: (edit) => {
      expect(readFileSync(edit.path, "utf8")).toMatch(/actual native/)
      edits.push(edit)
    }
  })
  const sandbox = new LocalSandbox({ rootDir: workspace, runId: "thread" })
  return { workspace, sandbox, edits }
}

it("publishes only after successful real native write/edit, and never from a failed overwrite", async () => {
  const f = fixture(),
    path = join(f.workspace, "proof.txt")
  expect((await f.sandbox.write(path, "actual native file")).error).toBeUndefined()
  expect(f.edits).toHaveLength(1)
  expect((await f.sandbox.write(path, "must not overwrite")).error).toBeDefined()
  expect(f.edits).toHaveLength(1)
  expect((await f.sandbox.edit(path, "native file", "native edited file")).error).toBeUndefined()
  expect(f.edits.map((edit) => edit.operation)).toEqual(["write_file", "edit_file"])
  expect(new Set(f.edits.map((edit) => edit.requestId)).size).toBe(2)
})

it("a denied native file action produces neither a file nor a change notification", async () => {
  const f = fixture(),
    approveFileOp = vi.fn(async () => false)
  f.sandbox.setOrchestrator({ approveFileOp } as unknown as ToolOrchestrator)
  expect(
    (await f.sandbox.write(join(f.workspace, "denied.txt"), "actual native denied")).error
  ).toContain("拒绝")
  expect(approveFileOp).toHaveBeenCalledOnce()
  expect(f.edits).toEqual([])
})
