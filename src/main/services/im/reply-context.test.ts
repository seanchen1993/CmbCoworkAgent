import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import {
  buildImReplyContinuationHint,
  imProjectModeReplyPrefix,
  imThreadReplyPrefix
} from "./reply-context"
import { segmentImMarkdownText, segmentImReplyText } from "./reply-segmentation"

describe("instructions for a push from another session", () => {
  it.each([segmentImReplyText, segmentImMarkdownText])(
    "separates system instructions from the Agent answer in %s",
    (segment) => {
      const hint = buildImReplyContinuationHint({
        switched: true,
        kind: "thread",
        sessionCode: "ABCDEFGH"
      })!
      const prefix = imThreadReplyPrefix("测试", true, hint)
      const [message] = segment("你好！有什么可以帮你的吗？", { prefix })
      expect(message).toContain("系统提示：")
      expect(message).toMatch(
        /切换成功后再发送你的问题[\s\S]*──────────\s+以下是该会话的回复：\s+你好！/
      )
      expect(message.indexOf("系统提示：")).toBeLessThan(message.indexOf("──────────"))
    }
  )

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
    expect(prefix.indexOf(hint)).toBeLessThan(prefix.indexOf("以下是该会话的回复："))
    expect(prefix).toContain("（非当前绑定会话）")
  })

  it("keeps project metadata and switch instructions compact while rendering the answer", () => {
    const hint = buildImReplyContinuationHint({
      switched: true,
      kind: "feature",
      sessionCode: "ABCDEFGH"
    })!
    const prefix = imProjectModeReplyPrefix({
      projectName: "支付",
      featureName: "对账",
      nodeName: "Dev-代码实现",
      nodeStatus: "进行中",
      switched: true,
      continuationHint: hint
    })
    const answer = "# 一级标题\n\n**加粗文字**\n\n- 列表项\n\n```ts\nconst value = 1\n```"
    const [message] = segmentImMarkdownText(answer, { prefix })
    expect(message).toContain("项目：【支付】  \n特性：【对账】")
    expect(message).toContain("系统提示：  \n直接回复")
    expect(message).toContain("──────────  \n以下是该会话的回复：\n\n# 一级标题")
    expect(message.endsWith(answer)).toBe(true)
    const html = renderToStaticMarkup(createElement(Markdown, null, message))
    expect(html).toContain("项目：【支付】<br/>\n特性：【对账】")
    expect(html).toContain("<p>系统提示：<br/>")
    expect(html).toContain("<h1>一级标题</h1>")
    expect(html).toContain("<strong>加粗文字</strong>")
    expect(html).toContain("<li>列表项</li>")
    expect(html).toContain('<code class="language-ts">const value = 1')
  })

  it("adds no switch-back instructions to the bound session or pending gates", () => {
    expect(
      buildImReplyContinuationHint({ switched: false, kind: "thread", threadTitle: "接口" })
    ).toBeUndefined()
    expect(imThreadReplyPrefix("接口", true)).toBe("【会话：接口】（非当前绑定会话）")
    expect(imThreadReplyPrefix("接口", false, "额外指引")).toBe("【会话：接口】")
  })
})
