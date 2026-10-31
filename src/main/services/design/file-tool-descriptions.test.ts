import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { createMiddleware } from "langchain"
import { afterEach, describe, expect, it } from "vitest"
import { createDeepAgent } from "../../agent/runtime"
import { LocalSandbox } from "../../agent/local-sandbox"
import { SHELL_FIRST_TOOL_DESCRIPTIONS } from "../../agent/tool-strategy"
import { DESIGN_FILE_TOOL_DESCRIPTIONS } from "./file-tool-descriptions"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function captureToolDescriptions(
  toolStrategy: "standard" | "shell-first",
  mainFilesystemToolDescriptions?: Record<string, string>
) {
  const root = await mkdtemp(join(tmpdir(), "design-file-tools-"))
  roots.push(root)
  const descriptions: Record<string, string> = {}
  const capture = createMiddleware({
    name: "captureDesignFileTools",
    wrapModelCall: async (request) => {
      for (const tool of request.tools) {
        if ("name" in tool && typeof tool.name === "string")
          descriptions[tool.name] = typeof tool.description === "string" ? tool.description : ""
      }
      return new AIMessage("已完成")
    }
  })
  const agent = createDeepAgent({
    model: new FakeListChatModel({ responses: ["已完成"] }),
    backend: new LocalSandbox({ rootDir: root, windowsSandbox: "none" }),
    middleware: [capture],
    mainFilesystemToolDescriptions,
    toolStrategy,
    mainTodosEnabled: false,
    mainSubagentsEnabled: false,
    includeGeneralPurposeSubagent: false
  })
  await agent.invoke({ messages: [new HumanMessage("生成页面")] }, { recursionLimit: 6 })
  return descriptions
}

describe("Design file tools in the assembled runtime", () => {
  it.each(["standard", "shell-first"] as const)(
    "preserves Design descriptions through the read_file wrapper in %s mode",
    async (strategy) => {
      const descriptions = await captureToolDescriptions(strategy, DESIGN_FILE_TOOL_DESCRIPTIONS)
      for (const [name, description] of Object.entries(DESIGN_FILE_TOOL_DESCRIPTIONS))
        expect(descriptions[name], name).toBe(description)
      if (strategy === "shell-first")
        expect(descriptions.execute).toBe(SHELL_FIRST_TOOL_DESCRIPTIONS.execute)
    }
  )

  it.each(["standard", "shell-first"] as const)(
    "keeps ordinary agents' file-tool guidance unchanged in %s mode",
    async (strategy) => {
      const descriptions = await captureToolDescriptions(strategy)
      expect(descriptions.edit_file).toContain("You must read the file before editing")
      expect(descriptions.read_file).toContain("ALWAYS make sure a file has been read")
      expect(descriptions.read_file).toContain("2000 lines")
      if (strategy === "shell-first") expect(descriptions.ls).toBe(SHELL_FIRST_TOOL_DESCRIPTIONS.ls)
    }
  )
})
