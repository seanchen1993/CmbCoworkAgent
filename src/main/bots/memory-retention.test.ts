import { expect, it } from "vitest"
import { restrictsAutomaticMemory } from "./memory-retention"

it.each([
  "请先读取项目偏好，不要新增记忆。",
  "不要新增重复记忆。",
  "请勿保存这轮对话。",
  "别记住这个临时数字。",
  "Do not add any new memories.",
  "Don't remember this conversation.",
  "DON’T SAVE THIS CHAT.",
  "Never store these values in long-term memory.",
  "No need to memorize this."
])("excludes automatic retention for a human opt-out: %s", (text) => {
  expect(restrictsAutomaticMemory(text)).toBe(true)
})

it.each([
  "请记住项目偏好。",
  "不要访问网页，也不要修改文件。",
  "Don't save the file.",
  "Please remember that the project uses TypeScript.",
  "Use the saved memory to draft a summary."
])("does not confuse ordinary tasks or file restrictions with a memory opt-out: %s", (text) => {
  expect(restrictsAutomaticMemory(text)).toBe(false)
})
