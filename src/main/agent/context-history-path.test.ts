import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import {
  canonicalizeWorkspacePathSync,
  deleteProjectThreadDataDirectory,
  getConversationHistoryDirectory,
  getProjectThreadDataDirectory,
  getProjectThreadDataDirectorySync,
  sanitizeHistoryPathComponent
} from "./context-history-path"

describe("conversation history paths", () => {
  it("uses the user-level CmbCowork project and thread directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-history-"))
    const workspace = join(root, "IdeaProjects", "firstDemo")
    const userHome = join(root, "home")
    await mkdir(workspace, { recursive: true })

    const canonicalWorkspace = await realpath(workspace)
    await expect(getConversationHistoryDirectory(workspace, "thread-123", userHome)).resolves.toBe(
      join(
        userHome,
        ".cmbcoworkagent",
        "projects",
        sanitizeHistoryPathComponent(canonicalWorkspace),
        "thread-123",
        "conversation_history"
      )
    )
  })

  it("uses Claude Code-compatible readable project slugs", () => {
    expect(sanitizeHistoryPathComponent("/Users/chenqiang/IdeaProjects/firstDemo")).toBe(
      "-Users-chenqiang-IdeaProjects-firstDemo"
    )
  })

  it("keeps synchronous workflow storage paths aligned with the async thread directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-path-sync-"))
    const workspace = join(root, "workspace")
    const userHome = join(root, "home")
    await mkdir(workspace, { recursive: true })

    try {
      expect(canonicalizeWorkspacePathSync(workspace)).toBe(await realpath(workspace))
      await expect(getProjectThreadDataDirectory(workspace, "thread-sync", userHome)).resolves.toBe(
        getProjectThreadDataDirectorySync(
          workspace,
          "thread-sync",
          join(userHome, ".cmbcoworkagent")
        )
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps all default thread paths under CMB_COWORK_AGENT_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-path-override-"))
    const workspace = join(root, "workspace")
    const appDataRoot = join(root, "portable-data")
    const previous = process.env.CMB_COWORK_AGENT_HOME
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = appDataRoot

    try {
      const expected = getProjectThreadDataDirectorySync(workspace, "thread-portable")
      await expect(getProjectThreadDataDirectory(workspace, "thread-portable")).resolves.toBe(
        expected
      )
      await expect(getConversationHistoryDirectory(workspace, "thread-portable")).resolves.toBe(
        join(expected, "conversation_history")
      )

      await mkdir(join(expected, "large_tool_results"), { recursive: true })
      await deleteProjectThreadDataDirectory(workspace, "thread-portable")
      await expect(access(expected)).rejects.toThrow()
    } finally {
      if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
      else process.env.CMB_COWORK_AGENT_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bounds unusually long project and thread path components", () => {
    const result = sanitizeHistoryPathComponent(`/workspace/${"nested/".repeat(80)}project`)
    expect(result.length).toBeLessThanOrEqual(255)
    expect(result).toMatch(/^[-a-zA-Z0-9]+$/)
    expect(result).toBe(sanitizeHistoryPathComponent(`/workspace/${"nested/".repeat(80)}project`))
  })

  it("deletes only the selected thread's app-managed history and large results", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-delete-"))
    const workspace = join(root, "workspace")
    const userHome = join(root, "home")
    await mkdir(workspace, { recursive: true })

    try {
      const targetDirectory = await getProjectThreadDataDirectory(
        workspace,
        "thread-target",
        userHome
      )
      const siblingDirectory = await getProjectThreadDataDirectory(
        workspace,
        "thread-sibling",
        userHome
      )
      await mkdir(join(targetDirectory, "conversation_history"), { recursive: true })
      await mkdir(join(targetDirectory, "large_tool_results"), { recursive: true })
      await mkdir(siblingDirectory, { recursive: true })
      await writeFile(join(targetDirectory, "conversation_history", "session.md"), "history")
      await writeFile(join(targetDirectory, "large_tool_results", "call-1"), "payload")
      await writeFile(join(siblingDirectory, "keep.txt"), "sibling")

      await deleteProjectThreadDataDirectory(workspace, "thread-target", userHome)

      await expect(access(targetDirectory)).rejects.toThrow()
      await expect(access(join(siblingDirectory, "keep.txt"))).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses an empty thread id instead of resolving the project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-empty-id-"))
    try {
      await expect(getProjectThreadDataDirectory(root, "", join(root, "home"))).rejects.toThrow(
        "Thread ID is required"
      )
      expect(() =>
        getProjectThreadDataDirectorySync(root, "", join(root, "home", ".cmbcoworkagent"))
      ).toThrow("Thread ID is required")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
