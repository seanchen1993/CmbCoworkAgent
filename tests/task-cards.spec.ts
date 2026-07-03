import {
  normalizeTaskCardsPayload,
  preferredTextMatchesTaskKey
} from "../src/shared/task-card-types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function testNormalizeSuccess(): void {
  const result = normalizeTaskCardsPayload(
    {
      returnCode: "SUC0000",
      errorMsg: null,
      body: {
        total: 2,
        pageSize: 1000,
        pageNum: 1,
        list: [
          {
            taskKey: "M10000749-9",
            taskName: "功能-关联特性",
            boardName: "当前迭代板",
            taskGroupName: "泳道 A",
            columnFullName: "投产-投产-doing",
            priority: "MEDIUM",
            dueDate: "2024-04-04",
            progressRatio: 100,
            archived: false,
            tags: ["feature", ""]
          },
          {
            taskName: "缺少编号的卡片"
          }
        ]
      }
    },
    { pageSize: 1000, pageNum: 1 }
  )

  assert(result.success, "success payload should normalize")
  assert(result.cards.length === 1, `expected 1 valid card, got ${result.cards.length}`)
  assert(result.cards[0].taskKey === "M10000749-9", "taskKey should be preserved")
  assert(result.cards[0].taskName === "功能-关联特性", "taskName should be preserved")
  assert(result.cards[0].tags?.length === 1, "empty tags should be filtered")
}

function testNormalizeFailureCode(): void {
  const result = normalizeTaskCardsPayload(
    {
      returnCode: "ERR0001",
      errorMsg: "token expired",
      body: null
    },
    { pageSize: 50, pageNum: 2 }
  )

  assert(!result.success, "failure returnCode should fail")
  assert(result.error === "token expired", `unexpected error: ${result.error}`)
  assert(result.pageSize === 50 && result.pageNum === 2, "fallback paging should be preserved")
}

function testNormalizeMissingBody(): void {
  const result = normalizeTaskCardsPayload({ returnCode: "SUC0000" }, { pageSize: 20, pageNum: 1 })

  assert(!result.success, "missing body should fail")
  assert(result.error?.includes("body"), `expected body error, got ${result.error}`)
}

function testNormalizeMalformedPayload(): void {
  const result = normalizeTaskCardsPayload(null, { pageSize: 10, pageNum: 1 })

  assert(!result.success, "malformed payload should fail")
  assert(result.cards.length === 0, "malformed payload should not return cards")
}

function testPreferredTextMatchesTaskKey(): void {
  assert(
    preferredTextMatchesTaskKey("feature/M10000749-9-fix-login", "M10000749-9"),
    "branch token should match full task key"
  )
  assert(
    preferredTextMatchesTaskKey("bugfix_Z990880_login", "Z990880"),
    "underscore separator should match full task key"
  )
  assert(
    !preferredTextMatchesTaskKey("codex/auto-task-card-picker", "task"),
    "short common words should not auto-match"
  )
  assert(
    !preferredTextMatchesTaskKey("feature/ABC1234-login", "ABC123"),
    "partial alphanumeric token should not auto-match"
  )
}

function main(): void {
  testNormalizeSuccess()
  testNormalizeFailureCode()
  testNormalizeMissingBody()
  testNormalizeMalformedPayload()
  testPreferredTextMatchesTaskKey()
  console.log("PASS task-cards")
}

main()
