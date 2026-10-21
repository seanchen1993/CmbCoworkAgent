import { describe, expect, it } from "vitest"
import {
  buildImReplyContinuationHint,
  imProjectModeReplyPrefix,
  imThreadReplyPrefix
} from "./reply-context"

describe("instructions for a push from another session", () => {
  it("prefers an exact session code over names and project selection", () => {
    const hint = buildImReplyContinuationHint({
      switched: true,
      kind: "thread",
      threadTitle: "重名",
      requiresSelection: true,
      sessionCode: "ABCDEFGH"
    })!
    expect(hint).toContain("/切换 @ABCDEFGH")
    expect(hint).not.toContain("/切换 重名")
    expect(hint).not.toContain("发送 /会话")
  })
  it("gives a copyable switch command and tells users to wait for confirmation", () => {
    const hint = buildImReplyContinuationHint({
      switched: true,
      kind: "thread",
      threadTitle: "  接口\n排障  "
    })!
    expect(hint).toContain("直接回复会发到当前绑定的会话")
    expect(hint).toContain("先单独发送：/切换 接口 排障")
    expect(hint).toContain("切换成功后再发送你的问题")
    expect(hint).toContain("/当前")
    expect(hint).not.toContain("/绑定")
  })

  it("uses the default-chat command for inbox pushes", () => {
    expect(buildImReplyContinuationHint({ switched: true, kind: "inbox" })).toContain(
      "先单独发送：/默认"
    )
  })

  it.each([
    { kind: "thread" as const, threadTitle: "项目内部标题", requiresSelection: true },
    { kind: "feature" as const },
    { kind: "thread" as const, threadTitle: "长".repeat(121) },
    { kind: "thread" as const, threadTitle: "" }
  ])("uses a fresh session picker for titles that should not be copied: %j", (input) => {
    const hint = buildImReplyContinuationHint({ switched: true, ...input })!
    expect(hint).toContain("发送 /会话，选择对应会话")
    expect(hint).not.toContain("/切换 ")
    expect(hint).not.toContain("/绑定")
  })

  it("keeps routing instructions outside the project's model output", () => {
    const hint = buildImReplyContinuationHint({ switched: true, kind: "feature" })!
    const prefix = imProjectModeReplyPrefix({
      projectName: "支付",
      featureName: "对账",
      switched: true,
      continuationHint: hint
    })
    expect(prefix.indexOf(hint)).toBeLessThan(prefix.indexOf("模型返回："))
    expect(prefix).toContain("（非当前绑定会话）")
  })

  it("adds no switch-back instructions to the bound session or pending gates", () => {
    expect(
      buildImReplyContinuationHint({ switched: false, kind: "thread", threadTitle: "接口" })
    ).toBeUndefined()
    expect(imThreadReplyPrefix("接口", true)).toBe("【会话：接口】（非当前绑定会话）")
    expect(imThreadReplyPrefix("接口", false, "额外指引")).toBe("【会话：接口】")
  })
})
