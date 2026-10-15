import { describe, expect, it } from "vitest"
import { botProfileEvent } from "./bot-profile-event"

const tool = { id: "profile", name: "bot_update_profile", args: { name: "Requested" } }
const content = JSON.stringify({ name: "Actual", instructions: "" })
describe("Bot profile event", () => {
  it("uses the successful returned identity and supports restored text blocks", () => {
    expect(botProfileEvent(tool, { content })).toBe("已重命名为 Actual")
    expect(botProfileEvent(tool, { content: [{ type: "text", text: content }] })).toBe(
      "已重命名为 Actual"
    )
    expect(botProfileEvent({ ...tool, args: { instructions: "" } }, { content })).toBe("职责已更新")
  })
  it("keeps failures, cancelled calls and malformed results in the normal tool view", () => {
    expect(botProfileEvent(tool, { content, is_error: true })).toBeNull()
    for (const invalid of ["cancelled", "{}", '{"ok":false,"name":"Actual","instructions":""}'])
      expect(botProfileEvent(tool, { content: invalid })).toBeNull()
    expect(botProfileEvent({ ...tool, name: "other" }, { content })).toBeNull()
  })
})
