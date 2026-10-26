import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it, vi } from "vitest"
import type { HookConfig } from "../hooks/types"

vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("../hooks/log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { hookMatchesRunCriteria } from "../hooks/runner"

const declaration = JSON.parse(
  readFileSync(resolve("resources/native-compositions/autobiz/hooks/hooks.json"), "utf8")
) as {
  PreToolUse: Array<{
    matcher: string
    hooks: Array<{
      type: "command"
      command: string
      timeout: number
      persistAfterInterrupt: boolean
    }>
  }>
}
const group = declaration.PreToolUse[0]
const hook: HookConfig = {
  ...group.hooks[0],
  id: "plugin:autobiz/PreToolUse:0:0",
  event: "PreToolUse",
  matcher: group.matcher,
  enabled: true,
  createdAt: "",
  updatedAt: ""
}
const matches = (toolName: string, matcher = hook.matcher) =>
  hookMatchesRunCriteria({ ...hook, matcher }, "PreToolUse", {
    sessionId: "autobiz-matcher-regression",
    workspacePath: resolve("."),
    toolName,
    toolArgs: {}
  })

it("reproduces the original substring bug through the production Hook matcher", () => {
  expect(matches("write_todos", "write_file|edit_file|apply_patch|Write|Edit")).toBe(true)
  expect(matches("write_todos")).toBe(false)
})

it.each(["write_file", "edit_file", "apply_patch", "Write", "Edit", "WRITE_FILE", "EDIT"])(
  "retains exact file-write names and compatibility aliases: %s",
  (toolName) => expect(matches(toolName)).toBe(true)
)

it.each([
  "write_todos",
  "request_user_input",
  "read_file",
  "rewrite_file",
  "edit_settings",
  "preview_write_file",
  "write_file_preview",
  "MultiEdit"
])("does not launch the scanner for unrelated or unsupported tool names: %s", (toolName) => {
  expect(matches(toolName)).toBe(false)
})

it("retains the same synchronous scanner and patch fail-closed admission", () => {
  expect(group.hooks).toEqual([
    {
      type: "command",
      command: "python -I -B -X utf8 hooks/check-secrets.py",
      timeout: 15,
      persistAfterInterrupt: true
    }
  ])
  expect(matches("apply_patch")).toBe(true)
  // The existing autobiz-native-safety.test.ts executes the unchanged scanner against
  // unsupported patch inputs and plaintext secrets; matching must not bypass that guard.
})
