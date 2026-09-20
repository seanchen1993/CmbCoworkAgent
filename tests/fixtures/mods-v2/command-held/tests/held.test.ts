import { expect, test, tier } from "claude-code/testing"

tier("user")
test("a command cannot wait on another command through its held turn", async ($) => {
  const answer = await $.command.run({ command: "held-probe" })
  expect(JSON.parse(answer.text)).toEqual({ direct: true, indirect: true, calls: 0 })
})
