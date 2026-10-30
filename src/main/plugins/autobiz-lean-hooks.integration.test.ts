import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"

const observed = vi.hoisted(() => ({ commands: [] as Array<{ cwd: string; executable: string }> }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getHookLoggingConfig: () => ({ enabled: false, diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("../hooks/log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../hooks/owned-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("../hooks/owned-command")>()
  return {
    ...original,
    startOwnedHookCommand: (input: Parameters<typeof original.startOwnedHookCommand>[0]) => {
      // Observe only process metadata; the original owner launches and settles real Python.
      observed.commands.push({ cwd: input.cwd, executable: input.executable })
      return original.startOwnedHookCommand(input)
    }
  }
})
import { parsePluginHooks } from "../storage"
import { runHooks, resetHookOnceStateForTests } from "../hooks/runner"
import { persistHookResultRecord } from "../hooks/log-record"
import { partitionRequiredBusinessHooks } from "../hooks/required-business-checks"
import { readRuntimeRequiredHooks } from "./runtime-required-hooks"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "./runtime-source-scope"

const source = resolve("resources/native-compositions/autobiz-lean/project")
const retainedFiles = [
  "hooks/hooks.json",
  "hooks/check-secrets.py",
  "hooks/secret_rules.py",
  "devclaw.capabilities.json"
]
let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autobiz lean hooks "))
  observed.commands = []
  vi.clearAllMocks()
})
afterEach(() => {
  resetHookOnceStateForTests()
  vi.restoreAllMocks()
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + "/") && !target.startsWith(resolve(tmpdir()) + "\\"))
    throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
  rmSync(target, { recursive: true, force: true })
})

function fixture() {
  const pluginPath = join(root, "retained plugin with spaces")
  const workspace = join(root, "different workspace")
  cpSync(source, pluginPath, { recursive: true })
  mkdirSync(join(workspace, "hooks"), { recursive: true })
  // A wrong workspace cwd would silently allow a forbidden write; the real package must win.
  writeFileSync(join(workspace, "hooks/check-secrets.py"), "raise SystemExit(0)\n")
  const plugin: PluginMetadata = {
    id: "lean-retained",
    name: "autobiz-lean",
    version: "1.0.0",
    path: pluginPath,
    enabled: true,
    author: "",
    description: "",
    hookCount: 1,
    skillCount: 0,
    mcpServerCount: 0,
    createdAt: "",
    updatedAt: ""
  }
  const bytes = retainedFiles.map((path) => readFileSync(join(source, path)))
  const digest = createHash("sha256").update(Buffer.concat(bytes)).digest("hex")
  const hooks = parsePluginHooks(plugin)
  const requiredHooks = readRuntimeRequiredHooks(plugin, { entry: "skills/native-code/SKILL.md" })
  expect(requiredHooks).toEqual(["plugin:lean-retained/PreToolUse:0:0"])
  expect(hooks).toHaveLength(1)
  expect(hooks[0]).toMatchObject({
    command: "python -I -B -X utf8 hooks/check-secrets.py",
    persistAfterInterrupt: true,
    hookSourceRoot: pluginPath,
    hookSourceType: "plugin"
  })
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      threadId: "lean-hook-integration",
      incarnationKey: "test-incarnation",
      projectId: "test-project",
      operationId: "test-operation",
      workspace,
      packageDigest: digest,
      stageId: "code",
      plugin,
      requiredHooks
    },
    () => {
      retainedFiles.forEach((path, index) => {
        if (!readFileSync(join(pluginPath, path)).equals(bytes[index]))
          throw Error("PACKAGE_CHANGED")
      })
    }
  )
  return {
    pluginPath,
    workspace,
    run: (toolName: string, toolArgs: Record<string, unknown>) =>
      withRuntimePluginSource(token, async () => {
        expect(partitionRequiredBusinessHooks(hooks)).toEqual({ required: hooks, ordinary: [] })
        return runHooks(hooks, "PreToolUse", {
          sessionId: "lean-hook-integration",
          workspacePath: workspace,
          toolName,
          toolArgs
        })
      })
  }
}

// The event and admitted source token are fixtures. Hook parsing, required-hook resolution,
// runner matching, stdin serialization, process ownership, Python and scanner bytes are real.
describe("AutoBiz lean retained PreToolUse guard through the original runner", () => {
  it("allows benign YAML and approved references from a fixed plugin cwd containing spaces", async () => {
    const f = fixture()
    const result = await f.run("write_file", {
      file_path: join(f.workspace, "application.yaml"),
      content: "service: orders\nport: 8080\npassword: ${APP_PASSWORD}\nsecret: ENC(approved)\n"
    })
    expect(result).toMatchObject({ exitCode: 0, blocked: false, stdout: "", stderr: "" })
    expect(observed.commands).toHaveLength(1)
    expect(observed.commands[0].cwd).toBe(f.pluginPath)
    expect(result?.stdinPayload).toBeUndefined()
  })

  it.each([
    ["write_file", "content", "file_path", "application.yaml"],
    ["edit_file", "newString", "filePath", "application.yml"],
    ["Edit", "new_string", "path", "application.properties"]
  ])(
    "blocks real %s plaintext without echoing candidate values",
    async (tool, contentKey, pathKey, path) => {
      const f = fixture(),
        candidate = "fixture-sensitive-value-do-not-publish-7b48"
      const logs = vi.spyOn(console, "log").mockImplementation(() => {})
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {})
      const result = await f.run(tool, {
        [pathKey]: join(f.workspace, path),
        [contentKey]: `password: ${candidate}\n`
      })
      expect(result).toMatchObject({ blocked: true, decision: "block" })
      expect(result?.reason).toContain("REQUIRED_BUSINESS_CHECK_FAILED")
      expect(result?.reason).toContain("AUTOBIZ_SECRET_WRITE_GUARD_BLOCKED")
      expect(observed.commands).toHaveLength(1)
      expect(observed.commands[0].cwd).toBe(f.pluginPath)
      expect(
        JSON.stringify([
          result,
          logs.mock.calls,
          warnings.mock.calls,
          vi.mocked(persistHookResultRecord).mock.calls
        ])
      ).not.toContain(candidate)
      expect(result?.stdinPayload).toBeUndefined()
    }
  )

  it.each([
    ["write_file", { content: "service: orders" }],
    ["write_file", { file_path: "application.yaml", content: 12 }],
    ["edit_file", { file_path: "application.yaml", oldString: "port: 80" }],
    ["apply_patch", { patch: "*** Begin Patch\n*** End Patch" }]
  ] as const)("fails closed for malformed %s tool input %j", async (tool, input) => {
    const result = await fixture().run(tool, input)
    expect(result).toMatchObject({ blocked: true, decision: "block" })
    expect(result?.reason).toContain("AUTOBIZ_SECRET_WRITE_GUARD_BLOCKED")
    expect(observed.commands).toHaveLength(1)
  })

  it("does not execute the write guard for a nonmatching read-only tool", async () => {
    const result = await fixture().run("read_file", {
      file_path: "application.yaml",
      content: "password: fixture-not-a-write"
    })
    expect(result).toBeNull()
    expect(observed.commands).toEqual([])
    expect(persistHookResultRecord).not.toHaveBeenCalled()
  })
})
