import { expect, it } from "vitest"
import { SESSION_CAPABILITIES } from "./session"

it("advertises distinct model fork and classify operations at the session boundary", () => {
  expect(SESSION_CAPABILITIES).toEqual(expect.arrayContaining(["model.complete", "model.fork", "model.classify"]))
})
