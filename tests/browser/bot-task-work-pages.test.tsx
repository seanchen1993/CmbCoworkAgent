import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BotConversationTasks } from "../../src/renderer/src/components/bots/BotConversationTasks"
import { emptyBotWorkCounts } from "../../src/shared/bot-work-pages"
import type { BotRun } from "../../src/shared/bot-types"
vi.mock("../../src/renderer/src/components/bots/BotAvatar", () => ({ BotAvatar: () => null }))
vi.mock("../../src/renderer/src/components/chat/markdown-file-preview-components", () => ({
  useMarkdownFilePreviewComponents: ({ baseComponents }: { baseComponents: unknown }) =>
    baseComponents
}))
const run: BotRun = {
  id: "run",
  botId: "bot",
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
  outputLength: 40000,
  outputCursor: 3
}
it("renders complete server task counts beside inline summaries without inferring absence from page one", () => {
  const html = renderToStaticMarkup(
    <BotConversationTasks
      scope={{ conversationId: "conversation", dataEpoch: "initial" }}
      runs={[run]}
      workCounts={{ ...emptyBotWorkCounts(), total: 47, needsReview: 9, queued: 38 }}
      serverPage={{ items: [], loading: false, pageIndex: 0, canPrevious: false, canNext: false }}
      bots={[{ id: "bot", name: "Owner" }]}
      conversationKind="direct"
      canViewHistory
      outputs={{
        run: { text: "Visible resident body", hasMore: false },
        foreign: { text: "Private foreign body", hasMore: false }
      }}
      onHistory={() => {}}
      onReview={() => {}}
      onCancel={async () => {}}
    />
  )
  expect(html).toContain("全部任务 · 47")
  expect(html).toContain("9 个待处理")
  expect(html).toContain("38 个排队中")
  expect(html).toContain("核对并恢复")
  expect(html).toContain("任务记录")
  expect(html).toContain("Visible resident body")
  expect(html).not.toContain("Private foreign body")
})
it("preserves the old complete-snapshot path when modern work counts are absent", () => {
  const html = renderToStaticMarkup(
    <BotConversationTasks
      scope={{ conversationId: "conversation" }}
      runs={[run, { ...run, id: "private", conversationId: "other", output: "private" }]}
      bots={[]}
      conversationKind="direct"
      canViewHistory={false}
      onHistory={() => {}}
      onReview={() => {}}
      onCancel={async () => {}}
    />
  )
  expect(html).toContain("核对并恢复")
  expect(html).not.toContain('data-inline-task-id="private"')
})
