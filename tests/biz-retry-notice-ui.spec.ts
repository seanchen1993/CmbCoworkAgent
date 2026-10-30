import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const notice = source("src/renderer/src/components/harness-board/BizRetryNotice.tsx")
const harnessBoard = source("src/renderer/src/components/harness-board/HarnessBoardView.tsx")
const chat = source("src/renderer/src/components/chat/ChatContainer.tsx")

assert.match(notice, /onViewThread=\{\(\) => onViewThread\(pending\.sourceThreadId\)\}/)
assert.match(notice, /\{onViewThread && \([\s\S]*onClick=\{onViewThread\}[\s\S]*查看会话/)
assert.match(notice, /toast\.success\(result\.message\)/)
assert.doesNotMatch(notice, /\btoast\(result\.message\)/)
assert.match(notice, /aria-label="输入自定义消息后继续当前会话"/)
assert.match(notice, /aria-expanded=\{messageOpen\}/)
assert.match(notice, /data-\[state=open\]:bg-button\/80/)
assert.match(notice, /<MessageSquarePlus className="size-3\.5" \/>/)
assert.doesNotMatch(notice, /<span>消息<\/span>/)
assert.match(harnessBoard, /<BizRetryNotice[\s\S]*onViewThread=\{handleHookSessionSelect\}/)
assert.doesNotMatch(
  chat.slice(chat.indexOf("<BizRetryDecisionCard"), chat.indexOf("<BizRetryDecisionCard") + 500),
  /onViewThread/,
  "会话详情中的决策卡不应显示查看会话入口"
)

console.log("biz retry notice UI tests passed")
