import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { FilesystemBackend } from "deepagents"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"

const temporaryRoots: string[] = []

async function createSandboxFixture(): Promise<{
  workspace: string
  managedDir: string
  sandbox: LocalSandbox
  resolvePath: (key: string) => string
  approvals: ReturnType<typeof vi.fn>
  mutations: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), "cmb-large-results-"))
  temporaryRoots.push(root)
  const workspace = join(root, "workspace")
  const managedDir = join(
    root,
    "home",
    ".cmbcoworkagent",
    "projects",
    "project",
    "thread",
    "large_tool_results"
  )
  await mkdir(workspace, { recursive: true })
  const approvals = vi.fn(async () => false)
  const mutations = vi.fn()
  const sandbox = new LocalSandbox({
    rootDir: workspace,
    largeToolResultsDir: managedDir,
    onFileMutation: mutations
  })
  sandbox.setOrchestrator({ approveFileOp: approvals } as never)
  const resolvePath = Reflect.get(sandbox, "_resolvePath") as (key: string) => string
  return { workspace, managedDir, sandbox, resolvePath, approvals, mutations }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("large tool result storage", () => {
  it("maps new logical spill files to the app-managed thread directory", async () => {
    const { managedDir, sandbox, resolvePath } = await createSandboxFixture()
    const target = join(managedDir, "call-new")

    expect(resolvePath("/large_tool_results/call-new")).toBe(target)
    const result = await FilesystemBackend.prototype.write.call(
      sandbox,
      "/large_tool_results/call-new",
      "managed payload"
    )
    expect(result.error).toBeUndefined()
    await expect(readFile(target, "utf8")).resolves.toBe("managed payload")
  })

  it("falls back to a legacy workspace spill file until a managed copy exists", async () => {
    const { workspace, managedDir, resolvePath } = await createSandboxFixture()
    const legacyFile = join(workspace, ".cmbdevclaw", "large_tool_results", "call-old")
    const managedFile = join(managedDir, "call-old")
    await mkdir(join(workspace, ".cmbdevclaw", "large_tool_results"), { recursive: true })
    await writeFile(legacyFile, "legacy")

    expect(resolvePath("/large_tool_results/call-old")).toBe(legacyFile)

    await mkdir(managedDir, { recursive: true })
    await writeFile(managedFile, "managed")
    expect(resolvePath("/large_tool_results/call-old")).toBe(managedFile)
  })

  it("fails closed when an automatic spill reuses a legacy tool-call id", async () => {
    const { workspace, managedDir, sandbox, resolvePath, approvals, mutations } =
      await createSandboxFixture()
    const logicalPath = "/large_tool_results/call-reused"
    const legacyFile = join(workspace, ".cmbdevclaw", "large_tool_results", "call-reused")
    const managedFile = join(managedDir, "call-reused")
    await mkdir(join(workspace, ".cmbdevclaw", "large_tool_results"), { recursive: true })
    await writeFile(legacyFile, "legacy payload")

    const result = await sandbox.write(logicalPath, "new payload")

    expect(result.error).toEqual(expect.any(String))
    await expect(readFile(legacyFile, "utf8")).resolves.toBe("legacy payload")
    await expect(readFile(managedFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(resolvePath(logicalPath)).toBe(legacyFile)
    expect(approvals).not.toHaveBeenCalled()
    expect(mutations).not.toHaveBeenCalled()
  })

  it("rejects traversal-like logical paths instead of resolving outside managed storage", async () => {
    const { resolvePath } = await createSandboxFixture()

    expect(() => resolvePath("/large_tool_results/../../outside")).toThrow(
      "Invalid large tool result path outside managed storage"
    )
    expect(() => resolvePath("/large_tool_results/..")).toThrow(
      "Invalid large tool result path outside managed storage"
    )
  })
})
