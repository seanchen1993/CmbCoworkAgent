import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox, agentFileWriteContext } from "./local-sandbox"

const temporaryRoots: string[] = []

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-internal-artifact-"))
  temporaryRoots.push(root)
  const workspace = join(root, "workspace")
  const historyDir = join(root, "state", "conversation_history")
  const largeResultsDir = join(root, "state", "large_tool_results")
  const approvals = vi.fn(async () => false)
  const mutations = vi.fn()
  const sandbox = new LocalSandbox({
    rootDir: workspace,
    largeToolResultsDir: largeResultsDir,
    internalArtifactRoots: [historyDir, largeResultsDir],
    onFileMutation: mutations
  })
  sandbox.setOrchestrator({ approveFileOp: approvals } as never)
  return { root, historyDir, largeResultsDir, approvals, mutations, sandbox }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("internal artifact storage", () => {
  it("writes compaction history without user approval, hooks, or mutation tracking", async () => {
    const { historyDir, approvals, mutations, sandbox } = await createFixture()
    const historyPath = join(historyDir, "session-1.md")

    await expect(sandbox.internalArtifactExists(historyPath)).resolves.toBe(false)
    await expect(sandbox.appendInternalArtifact(historyPath, "first\n")).resolves.toEqual({})
    await expect(sandbox.internalArtifactExists(historyPath)).resolves.toBe(true)
    await expect(sandbox.appendInternalArtifact(historyPath, "second\n")).resolves.toEqual({})

    await expect(readFile(historyPath, "utf8")).resolves.toBe("first\nsecond\n")
    expect(approvals).not.toHaveBeenCalled()
    expect(mutations).not.toHaveBeenCalled()
  })

  it("uses the internal channel for DeepAgents automatic large-result spills", async () => {
    const { largeResultsDir, approvals, mutations, sandbox } = await createFixture()

    await expect(sandbox.write("/large_tool_results/call-1", "large payload")).resolves.toEqual({})

    await expect(readFile(join(largeResultsDir, "call-1"), "utf8")).resolves.toBe("large payload")
    expect(approvals).not.toHaveBeenCalled()
    expect(mutations).not.toHaveBeenCalled()
  })

  it("does not overwrite an existing automatic large-result spill", async () => {
    const { largeResultsDir, approvals, mutations, sandbox } = await createFixture()
    const logicalPath = "/large_tool_results/call-1"
    const managedPath = join(largeResultsDir, "call-1")

    await expect(sandbox.write(logicalPath, "original payload")).resolves.toEqual({})
    await expect(sandbox.write(logicalPath, "replacement payload")).resolves.toEqual({
      error: expect.stringContaining("already exists")
    })

    await expect(readFile(managedPath, "utf8")).resolves.toBe("original payload")
    expect(approvals).not.toHaveBeenCalled()
    expect(mutations).not.toHaveBeenCalled()
  })

  it("keeps a model-requested write_file on the normal approval path", async () => {
    const { largeResultsDir, approvals, sandbox } = await createFixture()

    await expect(
      agentFileWriteContext.run(true, () =>
        sandbox.write("/large_tool_results/user-file", "payload")
      )
    ).resolves.toEqual({ error: "文件写入被用户拒绝。" })

    expect(approvals).toHaveBeenCalledWith(
      "write_file",
      "/large_tool_results/user-file",
      expect.any(String)
    )
    await expect(readFile(join(largeResultsDir, "user-file"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    })
  })

  it("rejects paths outside the configured internal roots", async () => {
    const { root, approvals, sandbox } = await createFixture()

    await expect(
      sandbox.writeInternalArtifact(join(root, "outside.md"), "payload")
    ).resolves.toEqual({ error: expect.stringContaining("Invalid internal artifact path") })
    expect(approvals).not.toHaveBeenCalled()
  })
})
