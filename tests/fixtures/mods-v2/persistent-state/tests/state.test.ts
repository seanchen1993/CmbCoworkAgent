import { expect, test, tier } from "claude-code/testing"

tier("user")
test("store JSON values, unset, ordering, interception and invalid data", async ($, on) => {
  const values = new Map()
  on("store.get", (_, e) => ({ value: values.get(e.key) }))
  on("store.set", (_, e) => {
    values.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on("store.delete", (_, e) => {
    values.delete(e.key)
    return { value: undefined }
  })
  on("store.keys", () => ({ value: [...values.keys()] }))
  const answer = await $.command.run({ command: "state-probe", args: "" })
  expect(JSON.parse(answer.text)).toEqual({
    missing: true,
    nullValue: null,
    label: "HELLO",
    data: { when: "2020-01-01T00:00:00.000Z" },
    before: ["null", "label", "data"],
    after: ["null", "data"],
    refused: true,
    cycleRefused: true
  })
})
