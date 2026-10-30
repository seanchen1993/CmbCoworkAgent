import { test, expect, tier } from "claude-code/testing"
tier("user")
const input = (command) => ({ command, args: "", origin: { kind: "composer" } })
test("a command hook cannot redirect the reserved command", async ($, on) => {
  let seen = ""
  on("command.run", ($, e) => {
    seen = e.command
    return { text: e.command }
  })
  expect((await $.command.run(input("cmb-pinned"))).text).toBe("cmb-pinned")
  expect(seen).toBe("cmb-pinned")
})
test("omitting the command rejects the rewrite and skips the hook", async ($, on) => {
  on("command.run", ($, e) => ({ text: `${e.command}:${e.args}` }))
  expect((await $.command.run(input("cmb-pinned-omitted"))).text).toBe("cmb-pinned-omitted:")
})
test("ordered input and output composition", async ($, on) => {
  on("command.run", { command: "cmb-order" }, ($, e) => ({ text: e.args }))
  expect((await $.command.run(input("cmb-order"))).text).toBe("A(B(AB))")
})
test("two next calls execute downstream twice", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-double" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-double"))).text).toBe("1,2")
  expect(count).toBe(2)
})
test("throw before next fails open", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-throw-before" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-throw-before"))).text).toBe("1")
  expect(count).toBe(1)
})
test("throw after next retains downstream without replay", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-throw-after" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-throw-after"))).text).toBe("1")
  expect(count).toBe(1)
})
test("registered catch can refuse without invoking downstream", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-catch" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-catch"))).text).toBe("REFUSED_BY_CATCH")
  expect(count).toBe(0)
})
test("short circuit skips downstream", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-short" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-short"))).text).toBe("SHORT")
  expect(count).toBe(0)
})
test("trace and host origin are exposed", async ($, on) => {
  on("command.run", { command: "cmb-trace" }, () => ({ text: "ok" }))
  const result = JSON.parse((await $.command.run(input("cmb-trace"))).text)
  expect(result.text).toBe("ok")
  expect(result.entries).toBeGreaterThan(0)
  expect(result.origin.plugin).toBe("engine")
  expect(result.aborted).toBe(false)
})
test("downstream failure propagates without replay", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-downstream-error" }, () => {
    count++
    throw new Error("downstream-probe")
  })
  await expect($.command.run(input("cmb-downstream-error"))).rejects.toThrow()
  expect(count).toBe(1)
})
test("catch replays an already completed next", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-catch-replay" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-catch-replay"))).text).toBe("true:throw:1:1")
  expect(count).toBe(1)
})
test("catch before next runs downstream only once", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-catch-once" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-catch-once"))).text).toBe("false:throw:1:1")
  expect(count).toBe(1)
})
test("undefined after next keeps its result", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-undefined-after" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-undefined-after"))).text).toBe("1")
  expect(count).toBe(1)
})
test("undefined before next falls through", async ($, on) => {
  let count = 0
  on("command.run", { command: "cmb-undefined-before" }, () => ({ text: String(++count) }))
  expect((await $.command.run(input("cmb-undefined-before"))).text).toBe("1")
  expect(count).toBe(1)
})
test("event patterns and next.is agree", async ($) => {
  expect((await $.command.run(input("cmb-pattern"))).text).toBe("command.run:true:true")
})
