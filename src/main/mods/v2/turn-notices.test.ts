import { expect, it } from "vitest"
import { FunctionTurnNotices } from "./turn-notices"

it("appends only new nonblank presentation and keeps bounded independent snapshots", () => {
  const notices = new FunctionTurnNotices()
  expect(notices.append("turn", "answer", "answer")).toBe(false)
  expect(notices.append("turn", "answer", " \n ")).toBe(false)
  for (let index = 0; index < 70; index++)
    expect(notices.append(String(index), "answer", `extra ${index}`, `message-${index}`)).toBe(true)
  const snapshot = notices.snapshot()
  expect(snapshot).toHaveLength(64)
  expect(snapshot[0].text).toBe("extra 6")
  expect(snapshot[0].anchorMessageId).toBe("message-6")
  snapshot[0].text = "changed"
  expect(notices.snapshot()[0].text).toBe("extra 6")
})
