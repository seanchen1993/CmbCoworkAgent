import { expect, test, tier } from "claude-code/testing"
tier("user")

test("session operations have empty inputs, plugin origin and projected repository output", async ($, on) => {
  on("session.repo", (_, e, next) => {
    expect(e).toEqual({})
    expect(next.origin.plugin).toBe("session-read")
    return {
      value: {
        root: "/root",
        remote: "git@example.invalid:team/repo.git",
        internal: false,
        name: null
      }
    }
  })
  on("session.authorize", (_, e) => {
    expect(e).toEqual({})
    return { value: null }
  })
  expect(JSON.parse((await $.command.run({ command: "session-probe" })).text)).toEqual({
    repo: {
      root: "view:/root",
      remote: "git@example.invalid:team/repo.git",
      internal: false,
      name: null
    },
    auth: null
  })
})

test("missing repository and first-party authorization preserve null values", async ($, on) => {
  on("session.repo", () => ({ value: null }))
  on("session.authorize", () => ({ value: null }))
  expect(JSON.parse((await $.command.run({ command: "session-probe" })).text)).toEqual({
    repo: null,
    auth: null
  })
})

test("denied repository metadata rejects the SDK operation", async ($, on) => {
  on("session.repo", () => ({ deny: "metadata denied" }))
  expect((await $.command.run({ command: "session-probe" })).text).toContain("caught:")
})
