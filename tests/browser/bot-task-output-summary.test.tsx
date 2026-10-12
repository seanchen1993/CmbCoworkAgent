import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BotConversationTasks } from "../../src/renderer/src/components/bots/BotConversationTasks"
import type { BotRun } from "../../src/shared/bot-types"
// Avatar image subscriptions are unrelated to the real task/output renderer.
vi.mock("../../src/renderer/src/components/bots/BotAvatar", () => ({
  BotAvatar: () => null
}))
// Keep the production Markdown renderer; only its unrelated ordinary ThreadProvider file resolver is omitted.
vi.mock("../../src/renderer/src/components/chat/markdown-file-preview-components", () => ({
  useMarkdownFilePreviewComponents: ({ baseComponents }: { baseComponents: unknown }) =>
    baseComponents
}))
const run: BotRun = {
  id: "run",
  botId: "owner",
  conversationId: "conversation",
  messageId: "message",
  parentRunId: null,
  rootRunId: "run",
  depth: 0,
  lane: "user",
  source: "user",
  status: "needs_review",
  revision: 2,
  fence: 1,
  leaseOwner: null,
  leaseUntil: null,
  checkpoint: null,
  result: null,
  error: null,
  createdAt: 1,
  updatedAt: 2,
  waitingForBot: null,
  projection: "summary",
  hasOutput: true,
  outputLength: 40_000,
  outputCursor: 3
}
it("renders scoped lazy output beyond page one together with review/history and a visible continuation", () => {
  const html = renderToStaticMarkup(
    <BotConversationTasks
      scope={{ conversationId: "conversation", dataEpoch: "initial" }}
      runs={[run]}
      bots={[{ id: "owner", name: "Owner" }]}
      conversationKind="direct"
      canViewHistory
      outputs={{ run: { text: "首段\n\n后续页原文", hasMore: true } }}
      onLoadOutput={() => {}}
      onHistory={() => {}}
      onReview={() => {}}
      onCancel={async () => {}}
    />
  )
  expect(html).toContain("后续页原文")
  expect(html).toContain("加载后续输出")
  expect(html).toContain("核对并恢复")
  expect(html).toContain("任务记录")
})
it("uses legacy snapshot output and never shows another run's cached body", () => {
  const html = renderToStaticMarkup(
    <BotConversationTasks
      scope={{ conversationId: "conversation" }}
      runs={[
        {
          ...run,
          projection: undefined,
          hasOutput: undefined,
          output: "Legacy body"
        }
      ]}
      outputs={{ unrelated: { text: "Private other task", hasMore: false } }}
      bots={[]}
      conversationKind="direct"
      canViewHistory={false}
      onHistory={() => {}}
      onReview={() => {}}
      onCancel={async () => {}}
    />
  )
  expect(html).toContain("Legacy body")
  expect(html).not.toContain("Private other task")
})
