import { expect, it } from "vitest"
import { queryModRuntimeToolAccess } from "./runtime-tool-access"

it("checks native, registered, scoped and canonical names against host runtime restrictions", () => {
  const blockedToolNames = new Set(["execute", "mcp__plugin__edit", "mcp__server__send"])
  for (const [target, permissionToolName, permissionToolAliases] of [
    ["host:execute", undefined, []],
    ["function:mcp__plugin__edit", undefined, []],
    ["mcp:capability", "mcp__send", ["mcp__server__send"]]
  ] as const)
    expect(
      queryModRuntimeToolAccess(
        { blockedToolNames, permissionToolName, permissionToolAliases },
        target
      )
    ).toEqual({ decision: "deny", reason: "MODS_RUNTIME_TOOL_DENIED" })
  expect(queryModRuntimeToolAccess({ blockedToolNames }, "host:read_file")).toEqual({
    decision: "allow"
  })
  expect(queryModRuntimeToolAccess({}, "host:execute")).toEqual({ decision: "allow" })
})
