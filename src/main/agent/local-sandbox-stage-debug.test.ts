import { afterEach, describe, expect, it, vi } from "vitest"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  writeFileSync,
  existsSync
} from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalSandbox } from "./local-sandbox"
import type { PluginMetadata } from "../types"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import type { ToolOrchestrator } from "./tool-orchestrator"
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-stage-debug-"))
  roots.push(root)
  const workspace = join(root, "branch"),
    snapshotRoot = join(root, "package")
  mkdirSync(workspace)
  mkdirSync(snapshotRoot)
  writeFileSync(join(workspace, "input.txt"), "old stage input")
  writeFileSync(join(snapshotRoot, "SKILL.md"), "retained skill")
  const token = issueRuntimePluginSourceToken({
    mode: "host",
    threadId: "thread",
    incarnationKey: "incarnation",
    projectId: "branch",
    operationId: "operation",
    workspace,
    packageDigest: "a".repeat(64),
    stageId: "review",
    stageDebug: { workspace, baselineId: "baseline" },
    plugin: { id: "plugin", path: snapshotRoot } as PluginMetadata
  })
  const sandbox = withRuntimePluginSource(
    token,
    () => new LocalSandbox({ rootDir: workspace, env: {}, hooks: [] })
  )
  return {
    root,
    workspace,
    snapshotRoot,
    sandbox,
    run: <T>(work: () => T) => withRuntimePluginSource(token, work)
  }
}
describe("native stage-debug file backend", () => {
  it("creates and edits branch outputs while retaining read-only Skill source", async () => {
    const f = fixture()
    const sourceRead = await f.run(() => f.sandbox.read(join(f.snapshotRoot, "SKILL.md")))
    expect(sourceRead, sourceRead).toContain("retained skill")
    expect(await f.run(() => f.sandbox.write("output.txt", "created"))).not.toHaveProperty("error")
    expect(await f.run(() => f.sandbox.read("input.txt"))).toContain("old stage input")
    expect(await f.run(() => f.sandbox.edit("input.txt", "old", "new"))).not.toHaveProperty("error")
    expect(readFileSync(join(f.workspace, "input.txt"), "utf8")).toBe("new stage input")
    await expect(
      f.run(() =>
        f.sandbox.runPreToolUseHookForTool("write_file", {
          filePath: join(f.snapshotRoot, "SKILL.md"),
          content: "unsafe"
        })
      )
    ).rejects.toThrow()
    expect(readFileSync(join(f.snapshotRoot, "SKILL.md"), "utf8")).toBe("retained skill")
  })
  it("rechecks real paths after native approval instead of writing through a substituted junction", async () => {
    const f = fixture(),
      inside = join(f.workspace, "sub"),
      outside = join(f.root, "outside")
    mkdirSync(inside)
    mkdirSync(outside)
    f.sandbox.setOrchestrator({
      approveFileOp: async () => {
        rmSync(inside, { recursive: true })
        symlinkSync(outside, inside, process.platform === "win32" ? "junction" : "dir")
        return true
      }
    } as unknown as ToolOrchestrator)
    await expect(f.run(() => f.sandbox.write("sub/escape.txt", "unsafe"))).rejects.toThrow(
      "PROJECT_STAGE_DEBUG_LINK_UNSUPPORTED"
    )
    expect(existsSync(join(outside, "escape.txt"))).toBe(false)
  })
  it("does not write content through a newly opened inode removed from the authorized namespace", async () => {
    const f = fixture()
    const target = join(f.workspace, "output.txt"),
      detached = join(f.workspace, "detached.txt")
    const open = fs.open.bind(fs)
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const opened = await open(...args)
      if (String(args[0]) === target && args[1] === "wx") {
        renameSync(target, detached)
        writeFileSync(target, "replacement must stay unchanged")
      }
      return opened
    })
    await expect(
      f.run(() => f.sandbox.write(target, "must not reach detached inode"))
    ).rejects.toThrow("PROJECT_STAGE_DEBUG_PATH_CHANGED")
    expect(readFileSync(detached, "utf8")).toBe("")
    expect(readFileSync(target, "utf8")).toBe("replacement must stay unchanged")
  })
})
