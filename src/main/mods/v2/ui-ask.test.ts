import { expect, it } from "vitest"
import { functionAskInput, functionAskAnswer } from "./ui-ask"

it("maps labels and defaults to the native question schema", () => {
  const input = functionAskInput(["Continue?", ["Careful", "Fast"]])
  expect(input.tool).toBe("request_user_input")
  expect(input.questions).toEqual([
    {
      id: "mod_question",
      header: "Question",
      question: "Continue?",
      options: [
        { label: "Careful", description: "Careful" },
        { label: "Fast", description: "Fast" }
      ]
    }
  ])
  expect(functionAskInput(["Continue?"]).questions[0].options.map((x) => x.label)).toEqual([
    "Yes",
    "No"
  ])
  expect(
    functionAskInput(["Continue?", { header: "Approach", options: ["Careful"] }]).questions[0]
  ).toMatchObject({ header: "Approach", options: [{ label: "Careful" }, { label: "Yes" }] })
})
it("rejects unsupported multi-select and invalid arguments instead of discarding fields", () => {
  for (const args of [
    [],
    [""],
    ["x".repeat(501)],
    ["Q?", { header: "x".repeat(13) }],
    ["Q?", { options: ["a", "b"], multiSelect: true }],
    ["Q?", { timeout: 1 }],
    ["Q?", { header: null }],
    ["Q?", ["a", "b", "c", "d", "e"]],
    ["Q?", ["a", null]],
    ["Q?", ["a", "a"]]
  ])
    expect(() => functionAskInput(args)).toThrow()
})
it("returns only submitted native answers and rejects dismissal/error/automatic choices", () => {
  const answer = (value: unknown) => ({ result: JSON.stringify(value) })
  expect(
    functionAskAnswer(
      answer({
        status: "submitted",
        answers: { mod_question: { type: "option", label: "Careful" } }
      })
    )
  ).toBe("Careful")
  expect(
    functionAskAnswer(
      answer({ status: "submitted", answers: { mod_question: { type: "other", text: "Custom" } } })
    )
  ).toBe("Custom")
  for (const status of ["ignored", "rejected", "cancelled", "auto_resolved"])
    expect(() => functionAskAnswer(answer({ status, answers: {} }))).toThrow(
      "MODS_UI_ASK_DISMISSED"
    )
  for (const value of [
    { deny: "no" },
    { result: "bad json" },
    { result: "{}" },
    answer({ status: "submitted", answers: {} })
  ])
    expect(() => functionAskAnswer(value)).toThrow()
})
