import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BotApprovalContent } from "../../src/renderer/src/components/bots/BotApprovalContent"

vi.mock("../../src/renderer/src/components/bots/BotPeerImages", () => ({
  BotPeerImages: () => null
}))

const groupPost = {
  destination: {
    id: "group:review",
    name: "项目审查 <script>",
    revision: 2,
    members: [
      { id: "maker", name: "制作 & 交付", revision: 1 },
      { id: "reviewer", name: "独立审查", revision: 3 }
    ],
    threadRootId: "discussion:one"
  },
  message: "请核对原文件。\n<img src=x onerror=alert(1)>",
  files: [
    {
      sourceId: "result:private-one",
      sourceConversationId: "private:one",
      sha256: "a".repeat(64),
      name: "复核报告 <script>.md",
      mime: "text/markdown",
      size: 1200
    }
  ]
}

it("shows the exact group audience, public message and selected original files without loading private data", () => {
  const html = renderToStaticMarkup(<BotApprovalContent prompt={JSON.stringify({ groupPost })} />)
  expect(html).toContain("发送到群聊")
  expect(html).toContain("项目审查 &lt;script&gt;")
  expect(html).toContain("制作 &amp; 交付、独立审查")
  expect(html).toContain("复核报告 &lt;script&gt;.md")
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  expect(html).toContain("将在群内公开")
  expect(html).toContain("发送到原任务的分支讨论")
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("<img")
  expect(html).not.toContain("private:one")
})

it("does not present an invalid destination as an approved audience snapshot", () => {
  const invalid = { ...groupPost, destination: { ...groupPost.destination, revision: 0 } }
  const html = renderToStaticMarkup(
    <BotApprovalContent prompt={JSON.stringify({ groupPost: invalid })} />
  )
  expect(html).not.toContain("发送到群聊")
  expect(html).not.toContain("将在群内公开")
})

it("describes text-only publication without implying files or a thread that were not approved", () => {
  const action = {
    ...groupPost,
    destination: { ...groupPost.destination, threadRootId: undefined },
    files: []
  }
  const html = renderToStaticMarkup(
    <BotApprovalContent prompt={JSON.stringify({ groupPost: action })} />
  )
  expect(html).toContain("发送到群聊")
  expect(html).toContain("将在群内公开")
  expect(html).not.toContain("将交接的文件")
  expect(html).not.toContain("发送到原任务的分支讨论")
})
