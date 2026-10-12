import { expect, it } from "vitest"
import {
  detectToolFailure,
  hasFailureFired,
  markFailureFired,
  withToolFailureScope
} from "./tool-failure"

it("isolates duplicate provider IDs across concurrent Bot executions and nested tasks", async () => {
  let release!: () => void
  const marked = new Promise<void>((done) => {
    release = done
  })
  let finish!: () => void
  const otherChecked = new Promise<void>((done) => {
    finish = done
  })
  await Promise.all([
    withToolFailureScope(async () => {
      markFailureFired("shared-provider-call")
      release()
      await otherChecked
      expect(hasFailureFired("shared-provider-call")).toBe(true)
      await withToolFailureScope(async () => {
        expect(hasFailureFired("shared-provider-call")).toBe(false)
        markFailureFired("shared-provider-call")
      })
      expect(hasFailureFired("shared-provider-call")).toBe(true)
    }),
    withToolFailureScope(async () => {
      await marked
      try {
        expect(hasFailureFired("shared-provider-call")).toBe(false)
        markFailureFired("shared-provider-call")
        expect(hasFailureFired("shared-provider-call")).toBe(true)
      } finally {
        finish()
      }
    })
  ])
  expect(hasFailureFired("shared-provider-call")).toBe(false)
  await withToolFailureScope(async () =>
    expect(hasFailureFired("shared-provider-call")).toBe(false)
  )
})

it.each([
  { isError: true, text: "provider rejected the operation" },
  { isError: true, data: "provider rejected the operation" },
  { isError: true, truncated: true, preview: { text: "bounded preview" }, artifactId: "result" }
])("recognizes MCP failure envelopes in object and serialized form: %j", (result) => {
  for (const value of [result, JSON.stringify(result)])
    expect(detectToolFailure("append_note", value)).toMatchObject({
      kind: "explicit-error",
      isInterrupt: false
    })
})

it.each([
  { isError: false, data: "The document mentions an error" },
  { isError: "true", data: "A data field is not a protocol flag" },
  { isError: false, data: { isError: true, error: "quoted example" } },
  'The example was {"isError":true}'
])("does not infer MCP failure from result content: %j", (value) => {
  expect(detectToolFailure("read_resource", value)).toBeNull()
})
