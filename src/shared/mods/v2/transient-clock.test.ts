import { expect, it } from "vitest"
import { TransientClock } from "./transient-clock"

it("only spends monotonically observed visible time, repeated ACK never resets duration", () => {
  let now = 0
  const clock = new TransientClock(() => now)
  clock.add("one", 200)
  now = 10000
  expect(clock.next()).toBeUndefined()
  expect(clock.expired()).toEqual([])
  clock.show(new Set(["one"]))
  now += 50
  clock.show(new Set(["one"]))
  expect(clock.next()).toBe(150)
  now += 20
  clock.show(new Set())
  now += 10000
  clock.show(new Set(["one"]))
  expect(clock.next()).toBe(130)
  now += 130
  expect(clock.expired()).toEqual(["one"])
  clock.remove("one")
  expect(clock.next()).toBeUndefined()
})

it("new duration and clear forget any prior active deadline", () => {
  const clock = new TransientClock(() => 0)
  clock.add("one", 10)
  clock.show(new Set(["one"]))
  clock.add("one", 200)
  expect(clock.next()).toBeUndefined()
  clock.clear()
  clock.show(new Set(["one"]))
  expect(clock.expired()).toEqual([])
})
