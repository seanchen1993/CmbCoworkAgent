import { describe, expect, it } from "vitest"
import {
  BUILTIN_NAVIGATION_COMMANDS,
  builtinCommandConflicts,
  builtinTargetFromItem,
  parseBuiltinNavigation
} from "./builtin-commands"
import { buildSlashPopoverMode } from "./useSlashCommands"

describe("local builtin commands", () => {
  it("discovers all six navigation targets without plugin runtime", () => {
    const menu = buildSlashPopoverMode({ input: "/", skills: [], skillSelected: false })
    expect(menu.kind).toBe("slash")
    if (menu.kind !== "slash") throw Error("missing menu")
    for (const command of BUILTIN_NAVIGATION_COMMANDS) {
      expect(menu.commands).toContainEqual(command)
      expect(parseBuiltinNavigation(command.command)).toBe(builtinTargetFromItem(command))
    }
  })
  it("never treats arguments, a sentence or old commands as local navigation", () => {
    for (const text of [
      "/diff src",
      "/diff\nexplain",
      "/different",
      "/goal",
      "/browser",
      "review /diff"
    ])
      expect(parseBuiltinNavigation(text)).toBeNull()
    expect(parseBuiltinNavigation(" /DIFF ")).toBe("diff")
  })
  it("does not let plugin IDs impersonate a menu navigation target", () => {
    expect(builtinTargetFromItem({ ...BUILTIN_NAVIGATION_COMMANDS[0], kind: undefined })).toBeNull()
    expect(builtinTargetFromItem({ ...BUILTIN_NAVIGATION_COMMANDS[0], id: "mod:diff" })).toBeNull()
  })
  it("requires explicit selection for plugin and skill name collisions", () => {
    expect(builtinCommandConflicts("/diff", [{ command: "/diff" }], [])).toBe(true)
    expect(builtinCommandConflicts("/diff", [], [{ name: "DIFF" }])).toBe(true)
    expect(builtinCommandConflicts("/diff", [{ command: "/different" }], [])).toBe(false)
  })
})
