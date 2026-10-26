import { AsyncLocalStorage } from "node:async_hooks"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { ToolMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"
import { parseRetainedAgentProfile, stripBlockedToolDocs } from "./agent-registry"
import { registryAgentBlockedTools } from "./coordinator-worker-access"
import { isReadOnlyShellCommand } from "./exec-policy"
import { readOnlyExecuteBlockMessage } from "./read-only-shell-message"
import { createModAgentRoleLimits } from "./mods-agent-role-limits"

/** Run the production guard body with real policy helpers without Electron startup. */
function productionGuard(profile: ReturnType<typeof parseRetainedAgentProfile>) {
  const source = ts.createSourceFile(
    "runtime.ts",
    readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["createAgentToolGuardMiddleware", "extractExecuteCommand"].includes(node.name?.text ?? "")
  )
  expect(functions).toHaveLength(2)
  const javascript = ts.transpileModule(
    functions.map((node) => node.getText(source).replace(/^export /, "")).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText
  const dependencies = {
    createMiddleware: (value: unknown) => value,
    ToolMessage,
    registryAgentBlockedTools,
    stripBlockedToolDocs,
    isReadOnlyShellCommand,
    readOnlyExecuteBlockMessage,
    readOnlyShellExecutionContext: new AsyncLocalStorage<boolean>()
  }
  return new Function(
    "deps",
    `const {${Object.keys(dependencies).join(",")}}=deps;
    ${javascript};return createAgentToolGuardMiddleware`
  )(dependencies)(profile.disallowedTools, profile.shellAccess, "powershell")
}

it("retained write-only profiles hard-reject execute, task and browser while permitting scoped file writes", async () => {
  const profile = parseRetainedAgentProfile(
    "implement.md",
    `---
name: implementation-files
description: Edit files through native file tools
tools: Read, Write, Edit, Glob, Grep
---
Implement the requested change.`
  )
  expect(profile.shellAccess).toBe("none")
  const guard = productionGuard(profile),
    executed = vi.fn(async () => "performed")
  const allowed = createModAgentRoleLimits({
    allowedToolNames: profile.toolAllowlist
  }) as unknown as typeof guard
  for (const name of [
    "execute",
    "task",
    "browser",
    "workflow",
    "mcp_external_run",
    "mod_function_run"
  ]) {
    const result = await allowed.wrapToolCall(
      { toolCall: { name, id: "denied", args: { command: "npm test" } } },
      (request: unknown) => guard.wrapToolCall(request, executed)
    )
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
  }
  expect(executed).not.toHaveBeenCalled()
  expect(
    await guard.wrapToolCall({ toolCall: { name: "write_file", id: "file", args: {} } }, executed)
  ).toBe("performed")
})

it("retained reviewers cannot write files or run test/build commands through the real runtime guard", async () => {
  const profile = parseRetainedAgentProfile(
    "review.md",
    `---
name: resource-review
description: Read and review
workload: read_only
---
Review the candidate.`
  )
  const guard = productionGuard(profile),
    executed = vi.fn(async () => "performed")
  for (const [name, args] of [
    ["write_file", {}],
    ["edit_file", {}],
    ["execute", { command: "npm test" }],
    ["execute", { command: "Set-Content changed.txt x" }]
  ] as const) {
    expect(
      (await guard.wrapToolCall({ toolCall: { name, id: "denied", args } }, executed)).status
    ).toBe("error")
  }
  expect(executed).not.toHaveBeenCalled()
  await guard.wrapToolCall({ toolCall: { name: "read_file", id: "read", args: {} } }, executed)
  expect(executed).toHaveBeenCalledOnce()
})
