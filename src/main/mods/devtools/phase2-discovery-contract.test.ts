import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEVELOPMENT_REAL_CAPABILITIES } from "../v2/development-session"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import { SESSION_CAPABILITIES } from "../v2/session"
import { checkFunctionAuthorTypes } from "./authoring-check"
import { developmentCatalogPage } from "./development-catalog"

const methods = [
  "ui.place",
  "ui.view",
  "mcp.list",
  "mcp.connect",
  "mcp.call",
  "mcp.status",
  "mcp.disconnect",
  "agent.list",
  "agent.status",
  "agent.messages",
  "agent.stop"
] as const
const roots: string[] = []

async function authorCheck(source: string) {
  const root = await mkdtemp(join(tmpdir(), "mods-phase2-author-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "phase2" }))
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./main.ts"] }))
  await writeFile(join(root, "hooks/main.ts"), source)
  return checkFunctionAuthorTypes(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("phase two creator discovery contract", () => {
  it.each(methods)("discovers the actual authorized SDK signature for %s", (method) => {
    expect(FUNCTION_SDK_METHODS).toContain(method)
    expect(SESSION_CAPABILITIES).toContain(method)
    expect(DEVELOPMENT_REAL_CAPABILITIES).toContain(method)
    const page = developmentCatalogPage("sdk", 0, method)
    expect(page).toMatchObject({
      matched: true,
      declarationAvailable: true,
      grantsAuthority: false,
      sdkMethods: [method]
    })
    expect("content" in page && typeof page.content === "string" && page.content.length > 0).toBe(
      true
    )
    expect(JSON.stringify({ ok: true, result: page }).length).toBeLessThan(8000)
  })

  it("keeps overview discovery within the normal creator tool-result budget", () => {
    expect(JSON.stringify({ ok: true, result: developmentCatalogPage() }).length).toBeLessThan(8000)
  })

  it("typechecks the actual MCP guidance supplied by targeted discovery", async () => {
    const page = developmentCatalogPage("sdk", 0, "mcp.connect")
    if (!("usageExample" in page) || typeof page.usageExample !== "string")
      throw Error("Missing MCP author example")
    const result = await authorCheck(`import type {Register} from "devclaw-mods"
export const register:Register=on=>{on("command.run",async $=>{
  ${page.usageExample}
  return {}
})}`)
    expect(result.diagnostics).toEqual([])
  })

  it("typechecks composition of the three public capabilities without ambient privileges", async () => {
    const result = await authorCheck(`import type { Register } from "devclaw-mods"
export const register: Register = on => {
  on("command.run", async $ => {
    await $.ui.place({id:"results"})
    await $.mcp.list()
    const connection = await $.mcp.connect("exact-host-source")
    if (connection.isConnected) {
      await $.mcp.call(connection.server,"host-tool",{})
      await $.mcp.status({server:connection.server})
      await $.mcp.disconnect({server:connection.server})
    }
    await $.agent.list()
    await $.agent.status({agentId:"owned-child"})
    await $.agent.messages({agentId:"owned-child",limit:10})
    await $.agent.stop({agentId:"owned-child"})
    return {}
  })
  on("ui.render",{component:"Placed"},($,event)=>{
    const {Button}=$.ui.resolve(event)
    return Button({key:"parent",label:"返回主聊天",onPress:async()=>{
      await $.ui.view({agentId:"main"})
    }})
  })
}`)
    expect(result.diagnostics).toEqual([])
  })

  it.each([
    '$.ui.place({id:"results",html:"<script>"})',
    '$.mcp.connect({server:"raw-config"})',
    '$.agent.messages({threadId:"some-other-thread"})',
    '$.ui.view({agentId:"main",userInitiated:true})'
  ])("does not invent ambient authority in the author contract: %s", async (expression) => {
    const result = await authorCheck(`import type {Register} from "devclaw-mods"
export const register:Register=on=>{on("command.run",async $=>{
  await ${expression};return {}
})}`)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})
