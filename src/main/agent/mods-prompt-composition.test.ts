import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"
import { composeModPrompt, type FunctionPromptDispatch } from "./mods-prompt-composition"
import { synchronizePromptContext } from "../../shared/mods/v2/prompt-context"
import type { ModObject } from "../../shared/mods/types"
const facts = {
  model: "model",
  promptModel: "model",
  tools: [],
  surfaces: ["desktop"],
  outputStyle: null,
  traits: []
}
const signal = () => new AbortController().signal

it("applies native instruction control before sections without touching user history", async () => {
  const user = new HumanMessage("TASK")
  const messages = [new SystemMessage("BASE\n\nRULE"), user]
  const sources = [
    { id: "cmb:base", scope: "session" as const, text: "BASE" },
    { id: "cmb:agents", scope: "session" as const, text: "\n\nRULE",
      context: { name: "claudeMd", instructionFiles:
        [{ path: "/p/AGENTS.md", kind: "project" as const, content: "RULE" }] } }
  ]
  const seen: ModObject[] = []
  const dispatch: FunctionPromptDispatch = async (event, input, active, core) => {
    if (event === "prompt.context") return synchronizePromptContext({ blocks: [] }, input)
    if (event === "prompt.section") seen.push(input)
    return core(input, active)
  }
  const result = await composeModPrompt(messages, facts, signal(), dispatch, () => {}, sources)
  expect(result.messages.map(message => message.content)).toEqual(["BASE", "TASK"])
  expect(result.messages[1]).toBe(user)
  expect(messages[0].content).toBe("BASE\n\nRULE")
  expect(seen.find(input => input.name === "cmb:agents")?.text).toBeNull()
})

it("context pass-through preserves original object, bytes and cache metadata", async () => {
  const system = new SystemMessage({ content: [{ type: "text", text: "RULE",
    cache_control: { type: "ephemeral" } }] })
  const messages = [system, new HumanMessage("user")]
  const result = await composeModPrompt(messages, facts, signal(), pass, () => {}, [
    { id: "cmb:agents", text: "RULE", scope: "session", context: { name: "claudeMd",
      instructionFiles: [{ path: "/p/AGENTS.md", kind: "project", content: "RULE" }] } }
  ])
  expect(result.messages).toBe(messages)
})

it("allows custom context blocks and keeps opaque Harness provenance unknown", async () => {
  const dispatch: FunctionPromptDispatch = async (event, input, active, core) => {
    if (event === "prompt.context") {
      expect(Object.hasOwn(input, "instructionFiles")).toBe(false)
      return { blocks: [{ name: "reviewChecklist", text: "REVIEW" },
        { name: "claudeMd", text: "HARNESS_EDITED" }] }
    }
    return core(input, active)
  }
  const result = await composeModPrompt([new SystemMessage("HARNESS"), new HumanMessage("user")],
    facts, signal(), dispatch, () => {}, [{ id: "cmb:agents", text: "HARNESS", scope: "session",
      context: { name: "claudeMd" } }])
  expect(result.text).toBe("REVIEW\n\nHARNESS_EDITED")
})
const pass: FunctionPromptDispatch = (_event, input, signal, core) => core(input, signal)

it("preserves every original message object and structured content when no Hook changes it", async () => {
  const system = new SystemMessage({
    content: [
      { type: "text", text: "body" },
      { type: "image_url", image_url: "host-owned" }
    ]
  })
  const messages = [system, new HumanMessage("user")]
  const result = await composeModPrompt(messages, facts, signal(), pass, () => {})
  expect(result.messages).toBe(messages)
  expect(result.messages[0]).toBe(system)
})

it("honors section removal and compose replacement at the final message boundary", async () => {
  const user = new HumanMessage("keep-user")
  const events: string[] = []
  const dispatch: FunctionPromptDispatch = async (
    event,
    input,
    signal,
    core
  ): Promise<ModObject> => {
    events.push(event)
    if (event === "prompt.section") return { text: input.name === "cmb:system:0" ? null : "new" }
    const result = await core(input, signal)
    return {
      sections: [
        { id: "plugin:head", text: "policy", scope: "shared" },
        ...(result.sections as ModObject[])
      ]
    }
  }
  const result = await composeModPrompt(
    [new SystemMessage("remove"), user, new SystemMessage("replace")],
    facts,
    signal(),
    dispatch,
    () => {}
  )
  expect(result.messages.map((m) => m.content)).toEqual(["policy\n\nnew", "keep-user"])
  expect(result.messages[1]).toBe(user)
  expect(events).toEqual(["prompt.compose", "prompt.section", "prompt.section"])
})

it("a direct empty sections answer removes all system text and never calls core", async () => {
  const user = new HumanMessage("user")
  const dispatch = vi.fn(async () => ({ sections: [] }))
  const result = await composeModPrompt(
    [new SystemMessage("system"), user],
    facts,
    signal(),
    dispatch,
    () => {}
  )
  expect(result.messages).toEqual([user])
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(result.text).toBe("")
})

it("does not silently drop a non-text system block during text replacement", async () => {
  const system = new SystemMessage({
    content: [
      { type: "text", text: "body" },
      { type: "image_url", image_url: "host-owned" }
    ]
  })
  await expect(
    composeModPrompt(
      [system],
      facts,
      signal(),
      async () => ({ sections: [] }),
      () => {}
    )
  ).rejects.toThrow("MODS_PROMPT_NON_TEXT_REPLACEMENT_UNSUPPORTED")
})

it("a captured empty-system core still checks its original authority before returning", async () => {
  let expired = false
  let captured: Parameters<FunctionPromptDispatch>[3] | undefined
  const dispatch: FunctionPromptDispatch = async (_event, _input, _signal, core) => {
    captured = core
    return { sections: [] }
  }
  await composeModPrompt([new HumanMessage("user")], facts, signal(), dispatch, () => {
    if (expired) throw Error("expired")
  })
  expired = true
  await expect(captured!(facts, signal())).rejects.toThrow("expired")
})

it("expands named empty slots and preserves the original bytes when they remain empty", async () => {
  const messages = [new SystemMessage({ content: [
    { type: "text", text: "alpha", cache_control: { type: "ephemeral" } },
    { type: "text", text: "\n\nbeta" }
  ] }), new HumanMessage("user")]
  const seen: ModObject[] = []
  const sources = [
    { id: "cmb:agent", text: "alpha", scope: "session" as const },
    { id: "cmb:agents", text: "\n\nbeta", scope: "session" as const },
    { id: "cmb:extra-context", text: null, scope: "session" as const }
  ]
  const dispatch: FunctionPromptDispatch = async (event, input, active, core) => {
    if (event === "prompt.section") seen.push(input)
    return core(input, active)
  }
  const result = await composeModPrompt(messages, facts, signal(), dispatch, () => {}, sources)
  expect(seen.map((input) => input.name)).toEqual(sources.map((source) => source.id))
  expect(seen.at(-1)?.text).toBeNull()
  expect(result.messages).toBe(messages)
  expect(result.text).toBe("alpha\n\nbeta")
})

it("renders changed named sections with the upstream blank-line separator", async () => {
  const user = new HumanMessage("user")
  const sources = [
    { id: "cmb:agent", text: "alpha", scope: "session" as const },
    { id: "cmb:agents", text: "\n\nbeta", scope: "session" as const },
    { id: "cmb:extra-context", text: null, scope: "session" as const }
  ]
  const dispatch: FunctionPromptDispatch = async (event, input, active, core) =>
    event === "prompt.section" && input.name === "cmb:agents" ? { text: null } :
    event === "prompt.section" && input.name === "cmb:extra-context" ? { text: "\n\nnew" } :
    core(input, active)
  const result = await composeModPrompt([new SystemMessage("alpha\n\nbeta"), user], facts,
    signal(), dispatch, () => {}, sources)
  expect(result.messages.map((message) => message.content)).toEqual(["alpha\n\n\n\nnew", "user"])
  expect(result.messages[1]).toBe(user)
})

it("keeps native blocks when a Hook returns semantically unchanged sections with new key order", async () => {
  const system = new SystemMessage({ content: [
    { type: "text", text: "alpha", cache_control: { type: "ephemeral" } },
    { type: "text", text: "\n\nbeta" }
  ] })
  const messages = [system, new HumanMessage("user")]
  const dispatch: FunctionPromptDispatch = async (event, input, active, core) => {
    const result = await core(input, active)
    if (event !== "prompt.compose") return result
    return { sections: (result.sections as ModObject[]).map(section =>
      ({ scope: section.scope, text: section.text, id: section.id })) }
  }
  const result = await composeModPrompt(messages, facts, signal(), dispatch, () => {}, [
    { id: "cmb:agent", text: "alpha", scope: "session" },
    { id: "cmb:agents", text: "\n\nbeta", scope: "session" }
  ])
  expect(result.messages).toBe(messages)
  expect(result.messages[0]).toBe(system)
  expect(result.text).toBe("alpha\n\nbeta")
})
