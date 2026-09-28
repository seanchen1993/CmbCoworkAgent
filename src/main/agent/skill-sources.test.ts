import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createMiddleware } from "langchain"
import { afterEach, describe, expect, it } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { createDeepAgent } from "./runtime"

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("skills in a resumed thread", () => {
  it.each(["deleted", "disabled"])(
    "removes a %s skill from the next model prompt",
    async (change) => {
      const root = mkdtempSync(join(tmpdir(), "cmb-skill-refresh-"))
      temporaryDirs.push(root)
      const source = join(root, "skills")
      const skillDir = join(source, "obsolete-skill")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: obsolete-skill\ndescription: An obsolete skill\n---\n"
      )
      const backend = new LocalSandbox({ rootDir: root, windowsSandbox: "none" })
      const checkpointer = new MemorySaver()
      const prompts: string[] = []
      const capturePrompt = createMiddleware({
        name: "captureSkillPrompt",
        wrapModelCall: (request, handler) => {
          const content = request.systemMessage.content
          prompts.push(
            typeof content === "string"
              ? content
              : content.map((part) => ("text" in part ? String(part.text) : "")).join("\n")
          )
          return handler(request)
        }
      })
      const invoke = async (message: string): Promise<void> => {
        const agent = createDeepAgent({
          model: new FakeListChatModel({ responses: ["done"] }),
          backend,
          checkpointer,
          skills: [source],
          middleware: [capturePrompt],
          mainFilesystemEnabled: false,
          mainTodosEnabled: false,
          mainSubagentsEnabled: false,
          includeGeneralPurposeSubagent: false
        })
        await agent.invoke(
          { messages: [new HumanMessage(message)] },
          { configurable: { thread_id: "same-thread" } }
        )
      }

      await invoke("first")
      expect(prompts.at(-1)).toContain("**obsolete-skill**")
      if (change === "deleted") rmSync(skillDir, { recursive: true })
      else backend.setHiddenSkillDirs([skillDir])
      await invoke("second")
      expect(prompts.at(-1)).not.toContain("**obsolete-skill**")
    }
  )
})
