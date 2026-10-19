import { expect, it } from "vitest"
import { assertProjectPackageExtensions } from "./project-package-extensions"

const check = (server: unknown) =>
  assertProjectPackageExtensions({ mcpServers: ".mcp.json" }, (path) =>
    path === ".mcp.json" ? JSON.stringify({ mcpServers: { local: server } }) : undefined
  )

it.each([
  { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/peer.mjs"], env: { MODE: "local" } },
  { command: "node", type: "stdio", args: [] },
  { url: "https://example.invalid/mcp", type: "http", injectUserHeaders: false },
  { url: "http://127.0.0.1:1234/mcp", transport: "streamable-http" },
  { url: "https://example.invalid/sse", transport: "sse", headers: { Accept: "text/event-stream" } }
])("admits only a complete MCP declaration consumed by the original transports: %j", (server) => {
  expect(() => check(server)).not.toThrow()
})

it.each([
  {},
  { command: "" },
  { url: "" },
  { command: "node", url: "https://example.invalid" },
  { command: "node", args: [1] },
  { command: "node", args: Array(129).fill("arg") },
  { command: "node", env: { MODE: 1 } },
  { url: "https://example.invalid", headers: [] },
  { url: "https://example.invalid", injectUserHeaders: "false" }
])("rejects malformed or unbounded original MCP inputs: %j", (server) => {
  expect(() => check(server)).toThrow("PROJECT_MCP_CONFIG_INVALID")
})

it.each([
  { url: "file:///outside" },
  { url: "wss://example.invalid" },
  { url: "https://example.invalid", transport: "websocket" },
  { command: "node", transport: "sse" },
  { command: "node", type: "http" },
  { url: "https://example.invalid", type: "custom" }
])("rejects unsupported MCP semantics instead of silently ignoring them: %j", (server) => {
  expect(() => check(server)).toThrow("PROJECT_MCP_TRANSPORT_UNSUPPORTED")
})

const checkHooks = (text: string, explicit = false) =>
  assertProjectPackageExtensions(explicit ? { hooks: "hooks/hooks.json" } : {}, (path) =>
    path === "hooks/hooks.json" ? text : undefined
  )

it.each([
  [],
  [{ id: "gate", event: "Stop", type: "command", command: "python check.py" }],
  [{ event: "PreToolUse", type: "prompt", prompt: "Check the actual tool input" }],
  { hooks: { Stop: [{ hooks: [{ type: "command", command: "python check.py" }] }] } },
  { Stop: [{ hooks: [{ type: "command", command: "python check.py" }] }] }
].map(hooks => ({ hooks })))("admits the original flat and CC Hook formats through implicit and explicit paths: %j", ({ hooks }) => {
  expect(() => checkHooks(JSON.stringify(hooks))).not.toThrow()
  expect(() => checkHooks(JSON.stringify(hooks), true)).not.toThrow()
})

it.each([null, false, 1, "hooks"])("rejects non-container Hook JSON: %j", (hooks) => {
  expect(() => checkHooks(JSON.stringify(hooks))).toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
})

it("preserves malformed JSON and explicit missing or escaping Hook resource failures", () => {
  expect(() => checkHooks("[{")).toThrow(SyntaxError)
  expect(() => assertProjectPackageExtensions({ hooks: "missing.json" }, () => undefined))
    .toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
  for (const hooks of ["../hooks.json", "/outside/hooks.json", "C:/outside/hooks.json"])
    expect(() => assertProjectPackageExtensions({ hooks }, () => "[]"))
      .toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
})

it.each([
  { modules: [] },
  { modules: "./register.ts" },
  { modules: [null] },
  { modules: ["../outside.ts"] },
  { modules: ["../../outside.ts"] },
  { modules: ["/outside.ts"] },
  { modules: ["./missing.ts"] }
])("keeps native Hook module structure and resource closure checks: %j", (hooks) => {
  expect(() => checkHooks(JSON.stringify(hooks))).toThrow()
})

it("does not extend flat-array compatibility to native Mods or MCP manifests", () => {
  expect(() => assertProjectPackageExtensions({ mods: "mods.json" }, (path) =>
    path === "mods.json" ? "[]" : undefined))
    .toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
  expect(() => assertProjectPackageExtensions({ mcpServers: ".mcp.json" }, (path) =>
    path === ".mcp.json" ? "[]" : undefined))
    .toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
})
