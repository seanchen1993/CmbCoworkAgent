import { expect, it } from "vitest"
import { queryModRuntimeToolAccess } from "./runtime-tool-access"

it("enforces an exact tool allowlist for native, registered and canonical MCP SDK targets", () => {
  const allowedToolNames = new Set(["read_file", "mcp__server__read"])
  expect(queryModRuntimeToolAccess({ allowedToolNames }, "host:read_file").decision).toBe("allow")
  expect(queryModRuntimeToolAccess({ allowedToolNames }, "host:write_file").decision).toBe("deny")
  expect(queryModRuntimeToolAccess({ allowedToolNames }, "function:mcp__new__write").decision).toBe(
    "deny"
  )
  expect(
    queryModRuntimeToolAccess(
      { allowedToolNames, permissionToolAliases: ["mcp__server__read"] },
      "mcp:opaque"
    ).decision
  ).toBe("allow")
  expect(
    queryModRuntimeToolAccess(
      { allowedToolNames, blockedToolNames: new Set(["read_file"]) },
      "host:read_file"
    ).decision
  ).toBe("deny")
  expect(
    queryModRuntimeToolAccess({ allowedToolNames: new Set() }, "host:read_file").decision
  ).toBe("deny")
})

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
