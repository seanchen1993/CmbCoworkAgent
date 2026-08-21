/**
 * Unit tests for builtin browser chat integration helpers.
 *
 * Run:
 *   npx tsx tests/builtin-browser-chat-integration.spec.ts
 */

import {
  formatBuiltinBrowserTranscriptMessage,
  formatBuiltinBrowserTransportMessage,
  getBuiltinBrowserTitleSource,
  resolveBuiltinBrowserVisibleUserText,
  shouldRemoveBuiltinBrowserChipWithBackspace,
  stripBuiltinBrowserPrompt
} from "../src/renderer/src/features/builtin-browser/chat-integration.ts"
import {
  formatBuiltinBrowserPrompt,
  setBuiltinBrowserScreenshotEnabled
} from "../src/renderer/src/features/builtin-browser/builtin-browser.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function testBrowserTransportAndTranscriptFormatting(): void {
  setBuiltinBrowserScreenshotEnabled(false)
  assertEqual(
    formatBuiltinBrowserTransportMessage("打开 example.com", true),
    formatBuiltinBrowserPrompt("打开 example.com"),
    "browser transport formatting should add the browser prompt prefix"
  )
  assertEqual(
    formatBuiltinBrowserTranscriptMessage("打开 example.com", false),
    "打开 example.com",
    "non-browser transcript formatting should keep text unchanged"
  )
}

function testBrowserOnlyTitleFallback(): void {
  assertEqual(
    resolveBuiltinBrowserVisibleUserText({
      browserSelected: true,
      fallbackUserText: "请分析以下文件内容。",
      rawMessage: ""
    }),
    "",
    "browser-only sends should keep visible text empty"
  )
  assertEqual(
    getBuiltinBrowserTitleSource(true),
    "使用内置浏览器",
    "browser title fallback should use the browser label"
  )
}

function testStripBrowserPrompt(): void {
  assertEqual(
    stripBuiltinBrowserPrompt(formatBuiltinBrowserPrompt("检查登录页")),
    "检查登录页",
    "display and copy paths should strip the browser prompt prefix"
  )
}

function testBackspaceChipRemovalGuard(): void {
  assertEqual(
    shouldRemoveBuiltinBrowserChipWithBackspace({
      browserSelected: true,
      inputLength: 0,
      isComposing: false,
      key: "Backspace"
    }),
    true,
    "plain empty-input Backspace should remove the browser chip"
  )
  assertEqual(
    shouldRemoveBuiltinBrowserChipWithBackspace({
      browserSelected: true,
      inputLength: 1,
      isComposing: false,
      key: "Backspace"
    }),
    false,
    "Backspace should not remove the browser chip while text remains"
  )
}

function run(): void {
  testBrowserTransportAndTranscriptFormatting()
  console.log("PASS browser transport and transcript formatting")
  testBrowserOnlyTitleFallback()
  console.log("PASS browser-only title fallback")
  testStripBrowserPrompt()
  console.log("PASS browser prompt stripping")
  testBackspaceChipRemovalGuard()
  console.log("PASS browser chip Backspace guard")
}

run()
