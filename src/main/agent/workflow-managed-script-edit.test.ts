import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StableWritableFileHandle } from "../services/stable-file-handle"
import { LocalSandbox } from "./local-sandbox"

const temporaryRoots: string[] = []

type LocalSandboxStatics = {
  getElevationState: () => Promise<boolean>
}

type LocalSandboxInternals = {
  writeStableFileHandleEncoded: (
    capability: StableWritableFileHandle,
    content: string,
    encoding: string
  ) => Promise<void>
}

async function expectAliasesToShareOneFileLock(
  sandbox: LocalSandbox,
  firstPath: string,
  secondPath: string,
  canonicalPath: string
): Promise<void> {
  const internals = sandbox as unknown as LocalSandboxInternals
  const originalWriteStableFileHandleEncoded =
    internals.writeStableFileHandleEncoded.bind(sandbox)
  let activeWrites = 0
  let maxConcurrentWrites = 0
  internals.writeStableFileHandleEncoded = async (capability, content, encoding) => {
    activeWrites += 1
    maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
    try {
      await new Promise((resolve) => setTimeout(resolve, 25))
      await originalWriteStableFileHandleEncoded(capability, content, encoding)
    } finally {
      activeWrites -= 1
    }
  }

  const results = await Promise.all([
    sandbox.edit(firstPath, "first = 1", "first = 2"),
    sandbox.edit(secondPath, "second = 1", "second = 2")
  ])
  expect(results).toEqual([
    expect.objectContaining({ occurrences: 1 }),
    expect.objectContaining({ occurrences: 1 })
  ])
  expect(maxConcurrentWrites).toBe(1)
  await expect(readFile(canonicalPath, "utf8")).resolves.toBe(
    "export const first = 2\nexport const second = 2\n"
  )
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("managed workflow script edits", () => {
  it("allows only a host-issued thread script through readonly and worktree guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workflow-script-edit-"))
    temporaryRoots.push(root)
    const workspace = join(root, "worktree", "workspace")
    const worktreeRoot = join(root, "worktree")
    const managedDir = join(root, "app-data", "thread-1", "workflows")
    const scriptPath = join(managedDir, "wf_abcdef.workflow.js")
    const siblingPath = join(root, "app-data", "thread-2", "workflows", "wf_abcdef.workflow.js")
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(managedDir, { recursive: true })])
    await mkdir(join(root, "app-data", "thread-2", "workflows"), { recursive: true })
    await writeFile(scriptPath, "export const value = 1\n")
    await writeFile(siblingPath, "export const value = 1\n")

    const statics = LocalSandbox as unknown as LocalSandboxStatics
    const originalGetElevationState = statics.getElevationState
    statics.getElevationState = async () => true
    try {
      const mutations = vi.fn()
      const sandbox = new LocalSandbox({
        rootDir: workspace,
        env: { ...process.env, LOCALAPPDATA: join(root, "local-app-data") } as Record<
          string,
          string
        >,
        windowsSandbox: "readonly",
        workflowScriptsDir: managedDir,
        worktreeIsolation: {
          workspaceRoot: workspace,
          worktreeRoot,
          commonDir: join(root, "common.git"),
          branch: "cmbcowork/wf/test"
        },
        onFileMutation: mutations
      })

      await expect(sandbox.edit(scriptPath, "value = 1", "value = 2")).resolves.toMatchObject({
        occurrences: 1
      })
      await expect(readFile(scriptPath, "utf8")).resolves.toContain("value = 2")
      expect(mutations).not.toHaveBeenCalled()

      await expect(sandbox.edit(siblingPath, "value = 1", "value = 2")).resolves.toEqual({
        error: expect.stringContaining("outside the isolated workspace")
      })
      await expect(readFile(siblingPath, "utf8")).resolves.toContain("value = 1")
    } finally {
      statics.getElevationState = originalGetElevationState
    }
  })

  it("does not authorize sidecars or files that were not issued by the host", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workflow-script-boundary-"))
    temporaryRoots.push(root)
    const workspace = join(root, "workspace")
    const managedDir = join(root, "app-data", "workflows")
    const sidecarPath = join(managedDir, "wf_abcdef.json")
    const missingScriptPath = join(managedDir, "wf_ghijkl.workflow.js")
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(managedDir, { recursive: true })])
    await writeFile(sidecarPath, "{}")

    const statics = LocalSandbox as unknown as LocalSandboxStatics
    const originalGetElevationState = statics.getElevationState
    statics.getElevationState = async () => true
    try {
      const sandbox = new LocalSandbox({
        rootDir: workspace,
        env: { ...process.env, LOCALAPPDATA: join(root, "local-app-data") } as Record<
          string,
          string
        >,
        windowsSandbox: "readonly",
        workflowScriptsDir: managedDir
      })

      await expect(sandbox.edit(sidecarPath, "{}", '{"changed":true}')).resolves.toEqual({
        error: expect.stringContaining("仅允许编辑工作目录内")
      })
      await expect(sandbox.write(missingScriptPath, "export const value = 1\n")).resolves.toEqual({
        error: expect.stringContaining("仅允许写入工作目录内")
      })
    } finally {
      statics.getElevationState = originalGetElevationState
    }
  })

  it("rejects a managed script that is already hard-linked to another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workflow-script-hardlink-"))
    temporaryRoots.push(root)
    const workspace = join(root, "workspace")
    const managedDir = join(root, "app-data", "workflows")
    const scriptPath = join(managedDir, "wf_abcdef.workflow.js")
    const victimPath = join(root, "victim.js")
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(managedDir, { recursive: true })])
    await writeFile(victimPath, "export const value = 'victim'\n")
    await link(victimPath, scriptPath)

    const sandbox = new LocalSandbox({
      rootDir: workspace,
      env: { ...process.env, LOCALAPPDATA: join(root, "local-app-data") } as Record<
        string,
        string
      >,
      workflowScriptsDir: managedDir
    })

    await expect(sandbox.edit(scriptPath, "'victim'", "'changed'")).resolves.toEqual({
      error: expect.stringContaining("hard links")
    })
    await expect(readFile(victimPath, "utf8")).resolves.toBe(
      "export const value = 'victim'\n"
    )
  })

  it.each([
    { attack: "inode replacement", useHardLink: false },
    { attack: "hard-link replacement", useHardLink: true }
  ])("fails closed after a read-time $attack", async ({ useHardLink }) => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workflow-script-swap-"))
    temporaryRoots.push(root)
    const workspace = join(root, "workspace")
    const managedDir = join(root, "app-data", "workflows")
    const scriptPath = join(managedDir, "wf_abcdef.workflow.js")
    const displacedPath = join(root, "displaced.workflow.js")
    const victimPath = join(root, "victim.js")
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(managedDir, { recursive: true })])
    await writeFile(scriptPath, "export const value = 'original'\n")
    await writeFile(victimPath, "export const value = 'victim'\n")

    const sandbox = new LocalSandbox({
      rootDir: workspace,
      env: { ...process.env, LOCALAPPDATA: join(root, "local-app-data") } as Record<
        string,
        string
      >,
      workflowScriptsDir: managedDir
    })
    const internals = sandbox as unknown as LocalSandboxInternals
    const originalWriteStableFileHandleEncoded =
      internals.writeStableFileHandleEncoded.bind(sandbox)
    let replaced = false
    internals.writeStableFileHandleEncoded = async (capability, content, encoding) => {
      if (!replaced) {
        replaced = true
        await rename(scriptPath, displacedPath)
        if (useHardLink) {
          await link(victimPath, scriptPath)
        } else {
          await writeFile(scriptPath, "export const value = 'replacement'\n")
        }
      }
      await originalWriteStableFileHandleEncoded(capability, content, encoding)
    }

    await expect(sandbox.edit(scriptPath, "'original'", "'changed'")).resolves.toEqual({
      error: expect.stringContaining("File changed")
    })
    await expect(readFile(displacedPath, "utf8")).resolves.toBe(
      "export const value = 'original'\n"
    )
    await expect(readFile(victimPath, "utf8")).resolves.toBe(
      "export const value = 'victim'\n"
    )
    await expect(readFile(scriptPath, "utf8")).resolves.toBe(
      useHardLink
        ? "export const value = 'victim'\n"
        : "export const value = 'replacement'\n"
    )
  })

  it.runIf(process.platform === "win32")(
    "serializes Windows case aliases of the same managed script",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cmb-workflow-script-case-alias-"))
      temporaryRoots.push(root)
      const worktreeRoot = join(root, "worktree")
      const workspace = join(worktreeRoot, "workspace")
      const managedDir = join(root, "app-data", "thread-1", "workflows")
      const scriptPath = join(managedDir, "wf_abcdef.workflow.js")
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(managedDir, { recursive: true })
      ])
      await writeFile(
        scriptPath,
        "export const first = 1\nexport const second = 1\n"
      )

      const sandbox = new LocalSandbox({
        rootDir: workspace,
        env: { ...process.env, LOCALAPPDATA: join(root, "local-app-data") } as Record<
          string,
          string
        >,
        workflowScriptsDir: managedDir,
        worktreeIsolation: {
          workspaceRoot: workspace,
          worktreeRoot,
          commonDir: join(root, "common.git"),
          branch: "cmbcowork/wf/test"
        }
      })

      await expectAliasesToShareOneFileLock(
        sandbox,
        scriptPath,
        scriptPath.toUpperCase(),
        scriptPath
      )
    }
  )

  it("serializes real and symlink-root aliases when directory links are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workflow-script-root-alias-"))
    temporaryRoots.push(root)
    const worktreeRoot = join(root, "worktree")
    const workspace = join(worktreeRoot, "workspace")
    const realManagedDir = join(root, "app-data", "thread-1", "workflows-real")
    const managedDirAlias = join(root, "app-data", "thread-1", "workflows")
    const scriptPath = join(realManagedDir, "wf_abcdef.workflow.js")
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(realManagedDir, { recursive: true })
    ])
    try {
      await symlink(
        realManagedDir,
        managedDirAlias,
        process.platform === "win32" ? "junction" : "dir"
      )
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return
      }
      throw error
    }
    await writeFile(
      scriptPath,
      "export const first = 1\nexport const second = 1\n"
    )

    const sandbox = new LocalSandbox({
      rootDir: workspace,
      env: { ...process.env, LOCALAPPDATA: join(root, "local-app-data") } as Record<
        string,
        string
      >,
      workflowScriptsDir: managedDirAlias,
      worktreeIsolation: {
        workspaceRoot: workspace,
        worktreeRoot,
        commonDir: join(root, "common.git"),
        branch: "cmbcowork/wf/test"
      }
    })

    await expectAliasesToShareOneFileLock(
      sandbox,
      join(managedDirAlias, "wf_abcdef.workflow.js"),
      scriptPath,
      scriptPath
    )
  })
})
