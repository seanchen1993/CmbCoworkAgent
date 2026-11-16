import { describe, expect, it } from "vitest"
import {
  createDesignModelActivity,
  extractDesignPublicText,
  DesignLiveOutputTracker
} from "../../../shared/design-live-output"
import { createDesignModel } from "./model"
import { DesignQuestionStream } from "./question-stream"

function questionModel(deltas: Record<string, unknown>[]) {
  const body =
    [...deltas, {}]
      .map(
        (delta, index) =>
          `data: ${JSON.stringify({
            id: "design-questions",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason: index === deltas.length ? "stop" : null }]
          })}\n\n`
      )
      .join("") + "data: [DONE]\n\n"
  return createDesignModel(
    { model: "test-model", apiKey: "local-test", baseUrl: "http://mock.invalid/v1" },
    async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
  )
}

describe("Design direct model reasoning", () => {
  it.each([
    { reasoning_content: "先梳理需求" },
    { reasoning_details: [{ type: "reasoning.text", text: "先梳理需求" }] }
  ])(
    "preserves provider reasoning before question JSON reaches the parser: %j",
    async (reasoning) => {
      const question = { id: "scope", type: "text", label: "需要哪些功能？" }
      const model = questionModel([
        { role: "assistant", content: "", ...reasoning },
        { content: '<question-form id="discovery">{"questions":[' },
        { content: JSON.stringify(question) },
        { content: "]}</question-form>" }
      ])
      const output = new DesignLiveOutputTracker()
      const questions = new DesignQuestionStream()
      const phases: string[] = []
      for await (const chunk of await model.stream("创建页面")) {
        output.activity(createDesignModelActivity(chunk, "questions"))
        const token = extractDesignPublicText(chunk.content)
        if (token) {
          output.text(token, false)
          questions.push(token)
        }
        phases.push(output.snapshot().phase)
        if (questions.questions.length === 0) expect(output.reasoning).toBe("先梳理需求")
      }
      expect(phases[0]).toBe("thinking")
      expect(output.reasoning).toBe("先梳理需求")
      expect(output.snapshot()).toMatchObject({ text: "", chars: 0, phase: "model" })
      expect(questions.questions).toEqual([question])
    }
  )

  it("keeps responses without reasoning usable and does not invent thinking content", async () => {
    const model = questionModel([{ role: "assistant", content: "[]" }])
    const output = new DesignLiveOutputTracker()
    for await (const chunk of await model.stream("创建页面")) {
      output.activity(createDesignModelActivity(chunk, "questions"))
      output.text(extractDesignPublicText(chunk.content), false)
    }
    expect(output.reasoning).toBe("")
    expect(output.snapshot().responseReceivedAt).toBeDefined()
    expect(output.snapshot()).toMatchObject({ phase: "model", text: "", chars: 0 })
  })
})
