import { describe, expect, it } from "vitest"
import { botProfileEvent } from "./bot-profile-event"

const tool = { id: "profile", name: "bot_update_profile", args: { name: "Requested" } }
const content = JSON.stringify({ name: "Actual", instructions: "" })
describe("Bot profile event", () => {
  it("distinguishes unchanged fields from actual successful changes", () => {
    const receipt = (name: boolean, instructions: boolean) =>
      JSON.stringify({ name: "Actual", instructions: "Review", changes: { name, instructions } })
    const both = { ...tool, args: { name: "Actual", instructions: "Review" } }
    expect(botProfileEvent(both, { content: receipt(false, false) })).toBe("资料未变更")
    expect(
      botProfileEvent(both, { content: [{ type: "text", text: receipt(false, false) }] })
    ).toBe("资料未变更")
    expect(botProfileEvent(both, { content: receipt(true, false) })).toBe("已重命名为 Actual")
    expect(botProfileEvent(both, { content: receipt(false, true) })).toBe("职责已更新")
    expect(botProfileEvent(both, { content: receipt(true, true) })).toBe(
      "已重命名为 Actual，职责已更新"
    )
    expect(botProfileEvent(both, { content: receipt(false, false), is_error: true })).toBeNull()
  })
  it("does not turn malformed change metadata into a successful profile event", () => {
    for (const changes of [null, [], {}, { name: false }, { name: "false", instructions: false }])
      expect(
        botProfileEvent(tool, {
          content: JSON.stringify({ name: "Actual", instructions: "", changes })
        })
      ).toBeNull()
  })
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
  it("shows creation only from a successful receipt containing the stable identity", () => {
    const create = { ...tool, name: "bot_create_teammate" }
    expect(botProfileEvent(create, { content })).toBeNull()
    const created = JSON.stringify({ id: "created-actual", name: "Actual", instructions: "Review" })
    expect(botProfileEvent(create, { content: created })).toBe("已创建 Actual")
    expect(botProfileEvent(create, { content: created, is_error: true })).toBeNull()
  })
  it("names the actual updated teammate and rejects mismatched or failed receipts", () => {
    const update = {
      ...tool,
      name: "bot_update_teammate",
      args: { botId: "peer-id", name: "Requested" }
    }
    const updated = JSON.stringify({ id: "peer-id", name: "Actual", instructions: "Review" })
    expect(botProfileEvent(update, { content: updated })).toBe("已更新 Actual 的资料")
    expect(
      botProfileEvent(update, {
        content: JSON.stringify({
          id: "peer-id",
          name: "Actual",
          instructions: "Review",
          changes: { name: false, instructions: false }
        })
      })
    ).toBe("Actual 的资料未变更")
    expect(botProfileEvent(update, { content: updated, is_error: true })).toBeNull()
    expect(
      botProfileEvent({ ...update, args: { ...update.args, botId: "other" } }, { content: updated })
    ).toBeNull()
  })
})
